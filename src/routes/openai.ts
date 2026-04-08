import { Hono } from "hono";
import { stream } from "hono/streaming";
import { translateChatRequest, translateChatResponse, InvalidChatRequestError } from "../translate/openai-chat.js";
import {
  translateResponsesRequest,
  translateResponsesBuffered,
  ResponsesStreamMachine,
  InvalidResponsesRequestError,
} from "../translate/openai-responses.js";
import { copilotFetch, streamCopilot, UpstreamError } from "../upstream/client.js";
import { openrouterFetch, streamOpenRouter } from "../upstream/openrouter.js";
import { type Initiator, deriveSessionIds } from "../upstream/headers.js";
import { getModels, resolveModel, ModelNotFoundError } from "../upstream/models.js";
import { formatSSE } from "../translate/sse.js";
import { judge, autoRouteHeaders, textOf, getCachedRoute, setCachedRoute, parsePrefixRoute, stripPrefixFromMessages, type JudgeResult } from "../auto/judge.js";
import { logger } from "../logger.js";
import { emitStats, type StatsContext } from "../stats/record.js";

const openai = new Hono();

function mapUpstreamError(err: UpstreamError) {
  if (err.statusCode === 402 || err.statusCode === 429) {
    return { status: 429 as const, body: { error: { message: "Insufficient quota", type: "insufficient_quota", code: "insufficient_quota" } } };
  }
  if (err.statusCode >= 500) {
    return { status: 502 as const, body: { error: { message: "Upstream error", type: "upstream_error", code: "upstream_error" } } };
  }
  return { status: err.statusCode as any, body: { error: { message: err.message, type: "upstream_error", code: "upstream_error" } } };
}

function detectInitiatorChat(messages: any[]): Initiator {
  if (!messages?.length) return "user";
  // Check the tail: if the last message is a tool response, this is an agent continuation.
  // If it's a plain user message, it's a new user turn (even with prior assistant messages in history).
  const last = messages[messages.length - 1];
  if (last?.role === "tool") return "agent";
  if (last?.role === "assistant") return "agent";
  return "user";
}

function detectInitiatorResponses(input: any): Initiator {
  if (typeof input === "string" || !Array.isArray(input) || !input.length) return "user";
  const agentTypes = ["function_call_output", "tool_call_output", "computer_call_output"];
  const last = input[input.length - 1];
  if (last?.role === "assistant") return "agent";
  if (agentTypes.includes(last?.type)) return "agent";
  return "user";
}

function countTurns(messages: any[]): number {
  if (!messages?.length) return 0;
  return messages.filter((m: any) => m.role === "assistant" || m.role === "tool").length;
}

// POST /v1/chat/completions
openai.post("/v1/chat/completions", async (c) => {
  const startTime = Date.now();
  const requestId = c.res.headers.get("x-request-id") ?? "";
  const requestedModel = { value: "" };

  const sctx: StatsContext = {
    requestId, startTime, endpoint: "/v1/chat/completions", apiFormat: "openai-chat",
    requestedModel: "", resolvedModel: "", provider: "copilot",
    streaming: false, initiator: "user", interactionId: "", turns: 0, autoRoute: null,
  };

  try {
    const body = await c.req.json();
    requestedModel.value = body.model ?? "";
    sctx.requestedModel = requestedModel.value;

    const initiator = detectInitiatorChat(body.messages);
    const { interactionId, agentTaskId } = deriveSessionIds(body.messages, initiator);
    sctx.initiator = initiator;
    sctx.interactionId = interactionId;

    // Auto-route: judge on user turns, reuse cached model on agent turns
    let ah: Record<string, string> = {};
    let useOpenRouter = false;
    if (body.model === "auto") {
      // Prefix override: #opus, #sonnet, etc. bypass the judge entirely
      const msgs = (body.messages ?? []).map((m: any) => ({ role: m.role ?? "user", content: textOf(m.content) }));
      const prefixHit = initiator === "user" ? parsePrefixRoute(msgs) : undefined;
      if (prefixHit) {
        body.model = prefixHit.model;
        useOpenRouter = prefixHit.provider === "openrouter";
        stripPrefixFromMessages(body.messages, prefixHit.prefix);
        ah = { "x-auto-routed": "true", "x-auto-model": prefixHit.model, "x-auto-provider": prefixHit.provider, "x-auto-prefix": prefixHit.prefix };
        sctx.autoRoute = { complexity: "low" as any, expected_length: "short" as any, confidence: 1, reasoning: `prefix override: ${prefixHit.prefix}`, judge_model: "", judge_latency_ms: 0, cached: false };
        logger.info({ event: "auto_route_prefix", route: "/v1/chat/completions", prefix: prefixHit.prefix, model: prefixHit.model });
      } else {
        const cached = initiator === "agent" ? getCachedRoute(interactionId) : undefined;
        if (cached) {
          body.model = cached.model;
          useOpenRouter = cached.provider === "openrouter";
          ah = { ...cached.ah, "x-auto-cached": "true" };
          sctx.autoRoute = { complexity: cached.ah["x-auto-complexity"] as any ?? "low", expected_length: cached.ah["x-auto-length"] as any ?? "short", confidence: parseFloat(cached.ah["x-auto-confidence"] ?? "0"), reasoning: "", judge_model: "", judge_latency_ms: 0, cached: true };
          logger.info({ event: "auto_route_cached", route: "/v1/chat/completions", model: cached.model });
        } else {
          const jr = await judge(msgs);
          body.model = jr.routed;
          useOpenRouter = jr.provider === "openrouter";
          ah = autoRouteHeaders(jr);
          setCachedRoute(interactionId, jr);
          sctx.autoRoute = { complexity: jr.complexity, expected_length: jr.expectedLength, confidence: jr.confidence, reasoning: jr.reasoning, judge_model: jr.model, judge_latency_ms: jr.latencyMs, cached: false };
          logger.info({ event: "auto_route", route: "/v1/chat/completions", ...ah });
        }
      }
    }

    sctx.resolvedModel = body.model;
    sctx.provider = useOpenRouter ? "openrouter" : "copilot";

    // Validate model (skip for OpenRouter — not in Copilot's model list)
    if (!useOpenRouter) {
      const models = await getModels();
      try {
        resolveModel(models, body.model);
      } catch (err) {
        if (err instanceof ModelNotFoundError) {
          emitStats(sctx, { statusCode: 404, error: { type: "model_not_found", status_code: 404, message: err.message } });
          return c.json(
            { error: { message: err.message, type: "invalid_request_error", code: "model_not_found" } },
            404,
          );
        }
        throw err;
      }
    }

    const chatReq = translateChatRequest(body);
    const turns = countTurns(body.messages);
    sctx.turns = turns;
    sctx.streaming = !!chatReq.stream;
    logger.info({ event: "interaction", route: "/v1/chat/completions", initiator, turns, model: body.model, interactionId, agentTaskId });

    const doFetch = useOpenRouter
      ? openrouterFetch
      : (path: string, init: RequestInit) => copilotFetch(path, init, true, initiator, interactionId, agentTaskId);
    const doStream = useOpenRouter
      ? streamOpenRouter
      : (path: string, b: unknown, signal?: AbortSignal) => streamCopilot(path, b, signal, initiator, interactionId, agentTaskId);

    if (chatReq.stream) {
      // Streaming response
      const encoder = new TextEncoder();
      let lastUsage: any = null;
      let lastFinishReason: string | null = null;
      let toolCallCount = 0;

      const readableStream = new ReadableStream({
        async start(controller) {
          try {
            for await (const event of doStream("/chat/completions", chatReq, c.req.raw.signal)) {
              if (event.data === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                break;
              }
              try {
                const parsed = JSON.parse(event.data);
                if (parsed.usage) lastUsage = parsed.usage;
                const choice = parsed.choices?.[0];
                if (choice?.finish_reason) lastFinishReason = choice.finish_reason;
                if (choice?.delta?.tool_calls) {
                  for (const tc of choice.delta.tool_calls) {
                    if (tc.id) toolCallCount++;
                  }
                }
              } catch {}
              controller.enqueue(encoder.encode(`data: ${event.data}\n\n`));
            }
          } catch (err) {
            // Stream error
          } finally {
            emitStats(sctx, { statusCode: 200, usage: lastUsage ? { prompt_tokens: lastUsage.prompt_tokens ?? 0, completion_tokens: lastUsage.completion_tokens ?? 0, total_tokens: lastUsage.total_tokens ?? 0 } : undefined, finishReason: lastFinishReason, toolCallsCount: toolCallCount });
            controller.close();
          }
        },
      });

      return new Response(readableStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...ah,
        },
      });
    }

    // Non-streaming
    const res = await doFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify(chatReq),
    });
    const upstream: any = await res.json();
    const choice = upstream.choices?.[0];
    emitStats(sctx, {
      statusCode: 200,
      usage: upstream.usage ? { prompt_tokens: upstream.usage.prompt_tokens ?? 0, completion_tokens: upstream.usage.completion_tokens ?? 0, total_tokens: upstream.usage.total_tokens ?? 0 } : undefined,
      finishReason: choice?.finish_reason ?? null,
      toolCallsCount: choice?.message?.tool_calls?.length ?? 0,
    });
    for (const [k, v] of Object.entries(ah)) c.header(k, v);
    return c.json(translateChatResponse(upstream));
  } catch (err: any) {
    if (err instanceof InvalidChatRequestError) {
      emitStats(sctx, { statusCode: 400, error: { type: "invalid_request", status_code: 400, message: err.message } });
      return c.json({ error: { message: err.message, type: "invalid_request_error", code: "invalid_request" } }, 400);
    }
    if (err instanceof UpstreamError) {
      const mapped = mapUpstreamError(err);
      emitStats(sctx, { statusCode: mapped.status, error: { type: "upstream_error", status_code: mapped.status, message: err.message } });
      return c.json(mapped.body, mapped.status);
    }
    emitStats(sctx, { statusCode: 500, error: { type: "internal_error", status_code: 500, message: err.message ?? "Internal error" } });
    return c.json({ error: { message: err.message ?? "Internal error", type: "server_error", code: "internal_error" } }, 500);
  }
});

// POST /v1/responses
openai.post("/v1/responses", async (c) => {
  const startTime = Date.now();
  const requestId = c.res.headers.get("x-request-id") ?? "";

  const sctx: StatsContext = {
    requestId, startTime, endpoint: "/v1/responses", apiFormat: "openai-responses",
    requestedModel: "", resolvedModel: "", provider: "copilot",
    streaming: false, initiator: "user", interactionId: "", turns: 0, autoRoute: null,
  };

  try {
    const body = await c.req.json();
    sctx.requestedModel = body.model ?? "";

    const initiator = detectInitiatorResponses(body.input);
    const chatMessages = Array.isArray(body.input) ? body.input : [];
    const { interactionId, agentTaskId } = deriveSessionIds(chatMessages, initiator);
    sctx.initiator = initiator;
    sctx.interactionId = interactionId;

    // Auto-route: judge on user turns, reuse cached model on agent turns
    let ah: Record<string, string> = {};
    let useOpenRouter = false;
    if (body.model === "auto") {
      // Build flat message list for prefix detection + judge
      const msgs: Array<{role: string, content: string}> = [];
      if (body.instructions) msgs.push({ role: "system", content: body.instructions });
      if (typeof body.input === "string") {
        msgs.push({ role: "user", content: body.input });
      } else if (Array.isArray(body.input)) {
        for (const item of body.input) {
          msgs.push({ role: item.role ?? "user", content: textOf(item.content ?? item.text ?? item) });
        }
      }

      // Prefix override: #opus, #sonnet, etc. bypass the judge entirely
      const prefixHit = initiator === "user" ? parsePrefixRoute(msgs) : undefined;
      if (prefixHit) {
        body.model = prefixHit.model;
        useOpenRouter = prefixHit.provider === "openrouter";
        // Strip prefix from original input
        if (typeof body.input === "string") {
          const trimmed = body.input.trimStart();
          if (trimmed.toLowerCase().startsWith(prefixHit.prefix)) {
            body.input = trimmed.slice(prefixHit.prefix.length).trimStart();
          }
        } else if (Array.isArray(body.input)) {
          stripPrefixFromMessages(body.input, prefixHit.prefix);
        }
        ah = { "x-auto-routed": "true", "x-auto-model": prefixHit.model, "x-auto-provider": prefixHit.provider, "x-auto-prefix": prefixHit.prefix };
        sctx.autoRoute = { complexity: "low" as any, expected_length: "short" as any, confidence: 1, reasoning: `prefix override: ${prefixHit.prefix}`, judge_model: "", judge_latency_ms: 0, cached: false };
        logger.info({ event: "auto_route_prefix", route: "/v1/responses", prefix: prefixHit.prefix, model: prefixHit.model });
      } else {
        const cached = initiator === "agent" ? getCachedRoute(interactionId) : undefined;
        if (cached) {
          body.model = cached.model;
          useOpenRouter = cached.provider === "openrouter";
          ah = { ...cached.ah, "x-auto-cached": "true" };
          sctx.autoRoute = { complexity: cached.ah["x-auto-complexity"] as any ?? "low", expected_length: cached.ah["x-auto-length"] as any ?? "short", confidence: parseFloat(cached.ah["x-auto-confidence"] ?? "0"), reasoning: "", judge_model: "", judge_latency_ms: 0, cached: true };
          logger.info({ event: "auto_route_cached", route: "/v1/responses", model: cached.model });
        } else {
          const jr = await judge(msgs);
          body.model = jr.routed;
          useOpenRouter = jr.provider === "openrouter";
          ah = autoRouteHeaders(jr);
          setCachedRoute(interactionId, jr);
          sctx.autoRoute = { complexity: jr.complexity, expected_length: jr.expectedLength, confidence: jr.confidence, reasoning: jr.reasoning, judge_model: jr.model, judge_latency_ms: jr.latencyMs, cached: false };
          logger.info({ event: "auto_route", route: "/v1/responses", ...ah });
        }
      }
    }

    sctx.resolvedModel = body.model;
    sctx.provider = useOpenRouter ? "openrouter" : "copilot";

    // Validate model (skip for OpenRouter)
    if (!useOpenRouter) {
      const models = await getModels();
      try {
        resolveModel(models, body.model);
      } catch (err) {
        if (err instanceof ModelNotFoundError) {
          emitStats(sctx, { statusCode: 404, error: { type: "model_not_found", status_code: 404, message: err.message } });
          return c.json(
            { error: { message: err.message, type: "invalid_request_error", code: "model_not_found" } },
            404,
          );
        }
        throw err;
      }
    }

    const { chatBody, model } = translateResponsesRequest(body);
    const turns = chatMessages.filter((i: any) => i.role === "assistant" || ["function_call_output", "tool_call_output", "computer_call_output"].includes(i.type)).length;
    sctx.turns = turns;
    sctx.streaming = !!body.stream;
    logger.info({ event: "interaction", route: "/v1/responses", initiator, turns, model: body.model, interactionId, agentTaskId });

    const doFetch = useOpenRouter
      ? openrouterFetch
      : (path: string, init: RequestInit) => copilotFetch(path, init, true, initiator, interactionId, agentTaskId);
    const doStream = useOpenRouter
      ? streamOpenRouter
      : (path: string, b: unknown, signal?: AbortSignal) => streamCopilot(path, b, signal, initiator, interactionId, agentTaskId);

    if (body.stream) {
      chatBody.stream = true;
      const machine = new ResponsesStreamMachine(model);
      const encoder = new TextEncoder();

      const readableStream = new ReadableStream({
        async start(controller) {
          try {
            for await (const event of doStream("/chat/completions", chatBody, c.req.raw.signal)) {
              if (event.data === "[DONE]") break;
              try {
                const parsed = JSON.parse(event.data);
                const frames = machine.processChunk(parsed);
                for (const frame of frames) {
                  controller.enqueue(encoder.encode(frame));
                }
              } catch {
                // skip unparseable
              }
            }
          } catch (err) {
            // Stream error
          } finally {
            const usage = machine.getUsage();
            emitStats(sctx, { statusCode: 200, usage, finishReason: machine.getFinishReason(), toolCallsCount: machine.getToolCallsCount() });
            controller.close();
          }
        },
      });

      return new Response(readableStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...ah,
        },
      });
    }

    // Non-streaming
    const res = await doFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify(chatBody),
    });
    const upstream: any = await res.json();
    const choice = upstream.choices?.[0];
    emitStats(sctx, {
      statusCode: 200,
      usage: upstream.usage ? { prompt_tokens: upstream.usage.prompt_tokens ?? 0, completion_tokens: upstream.usage.completion_tokens ?? 0, total_tokens: upstream.usage.total_tokens ?? 0 } : undefined,
      finishReason: choice?.finish_reason ?? null,
      toolCallsCount: choice?.message?.tool_calls?.length ?? 0,
    });
    for (const [k, v] of Object.entries(ah)) c.header(k, v);
    return c.json(translateResponsesBuffered(upstream, model));
  } catch (err: any) {
    if (err instanceof InvalidResponsesRequestError) {
      emitStats(sctx, { statusCode: 400, error: { type: "invalid_request", status_code: 400, message: err.message } });
      return c.json({ error: { message: err.message, type: "invalid_request_error", code: "invalid_request" } }, 400);
    }
    if (err instanceof UpstreamError) {
      const mapped = mapUpstreamError(err);
      emitStats(sctx, { statusCode: mapped.status, error: { type: "upstream_error", status_code: mapped.status, message: err.message } });
      return c.json(mapped.body, mapped.status);
    }
    emitStats(sctx, { statusCode: 500, error: { type: "internal_error", status_code: 500, message: err.message ?? "Internal error" } });
    return c.json({ error: { message: err.message ?? "Internal error", type: "server_error", code: "internal_error" } }, 500);
  }
});

export default openai;
