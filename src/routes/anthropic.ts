import { Hono } from "hono";
import {
  translateAnthropicRequest,
  translateAnthropicResponseBuffered,
  AnthropicStreamMachine,
  InvalidAnthropicRequestError,
} from "../translate/anthropic.js";
import { copilotFetch, streamCopilot, UpstreamError } from "../upstream/client.js";
import { openrouterFetch, streamOpenRouter } from "../upstream/openrouter.js";
import { type Initiator, deriveSessionIds } from "../upstream/headers.js";
import { getModels, resolveModel, ModelNotFoundError } from "../upstream/models.js";
import { judge, autoRouteHeaders, textOf, getCachedRoute, setCachedRoute, parsePrefixRoute, stripPrefixFromMessages, type JudgeResult } from "../auto/judge.js";
import { logger } from "../logger.js";
import { emitStats, type StatsContext } from "../stats/record.js";

const anthropic = new Hono();

function mapUpstreamErrorAnthropic(err: UpstreamError) {
  if (err.statusCode === 402 || err.statusCode === 429) {
    return {
      status: 429 as const,
      body: { type: "error", error: { type: "rate_limit_error", message: "Rate limit exceeded" } },
    };
  }
  if (err.statusCode >= 500) {
    return {
      status: 529 as const,
      body: { type: "error", error: { type: "overloaded_error", message: "Upstream overloaded" } },
    };
  }
  return {
    status: err.statusCode as any,
    body: { type: "error", error: { type: "api_error", message: err.message } },
  };
}

function detectInitiatorAnthropic(messages: any[]): Initiator {
  if (!messages?.length) return "user";
  // Check the last message: if it carries tool_results, this is an agent continuation.
  // If it's a plain user text message, it's a new user turn (even with prior assistant messages in history).
  const last = messages[messages.length - 1];
  if (last?.role === "user" && Array.isArray(last.content)) {
    if (last.content.some((b: any) => b.type === "tool_result")) return "agent";
  }
  // If the last message is an assistant message (shouldn't normally happen, but defensive)
  if (last?.role === "assistant") return "agent";
  return "user";
}

function countTurnsAnthropic(messages: any[]): number {
  if (!messages?.length) return 0;
  return messages.filter((m: any) => m.role === "assistant").length;
}

async function handleMessages(c: any) {
  const startTime = Date.now();
  const requestId = c.res.headers.get("x-request-id") ?? "";
  const endpoint = c.req.path as string;

  const sctx: StatsContext = {
    requestId, startTime, endpoint, apiFormat: "anthropic",
    requestedModel: "", resolvedModel: "", provider: "copilot",
    streaming: false, initiator: "user", interactionId: "", turns: 0, autoRoute: null,
  };

  try {
    const body = await c.req.json();
    sctx.requestedModel = body.model ?? "";

    const initiator = detectInitiatorAnthropic(body.messages);
    const { interactionId, agentTaskId } = deriveSessionIds(body.messages, initiator);
    sctx.initiator = initiator;
    sctx.interactionId = interactionId;

    // Auto-route: judge on user turns, reuse cached model on agent turns
    let ah: Record<string, string> = {};
    let useOpenRouter = false;
    if (body.model === "auto") {
      // Build flat message list for prefix detection + judge
      const msgs: Array<{role: string, content: string}> = [];
      if (body.system) {
        const sys = typeof body.system === "string" ? body.system :
          Array.isArray(body.system) ? body.system.map((b: any) => typeof b === "string" ? b : b.text ?? "").join("\n\n") : "";
        if (sys) msgs.push({ role: "system", content: sys });
      }
      for (const m of body.messages ?? []) {
        msgs.push({ role: m.role ?? "user", content: textOf(m.content) });
      }

      // Prefix override: #opus, #sonnet, etc. bypass the judge entirely
      const prefixHit = initiator === "user" ? parsePrefixRoute(msgs) : undefined;
      if (prefixHit) {
        body.model = prefixHit.model;
        useOpenRouter = prefixHit.provider === "openrouter";
        stripPrefixFromMessages(body.messages, prefixHit.prefix);
        ah = { "x-auto-routed": "true", "x-auto-model": prefixHit.model, "x-auto-provider": prefixHit.provider, "x-auto-prefix": prefixHit.prefix };
        sctx.autoRoute = { complexity: "low" as any, expected_length: "short" as any, confidence: 1, reasoning: `prefix override: ${prefixHit.prefix}`, judge_model: "", judge_latency_ms: 0, cached: false };
        logger.info({ event: "auto_route_prefix", route: "/v1/messages", prefix: prefixHit.prefix, model: prefixHit.model });
      } else {
        const cached = initiator === "agent" ? getCachedRoute(interactionId) : undefined;
        if (cached) {
          body.model = cached.model;
          useOpenRouter = cached.provider === "openrouter";
          ah = { ...cached.ah, "x-auto-cached": "true" };
          sctx.autoRoute = { complexity: cached.ah["x-auto-complexity"] as any ?? "low", expected_length: cached.ah["x-auto-length"] as any ?? "short", confidence: parseFloat(cached.ah["x-auto-confidence"] ?? "0"), reasoning: "", judge_model: "", judge_latency_ms: 0, cached: true };
          logger.info({ event: "auto_route_cached", route: "/v1/messages", model: cached.model });
        } else {
          const jr = await judge(msgs);
          body.model = jr.routed;
          useOpenRouter = jr.provider === "openrouter";
          ah = autoRouteHeaders(jr);
          setCachedRoute(interactionId, jr);
          sctx.autoRoute = { complexity: jr.complexity, expected_length: jr.expectedLength, confidence: jr.confidence, reasoning: jr.reasoning, judge_model: jr.model, judge_latency_ms: jr.latencyMs, cached: false };
          logger.info({ event: "auto_route", route: "/v1/messages", ...ah });
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
            { type: "error", error: { type: "not_found_error", message: err.message } },
            404,
          );
        }
        throw err;
      }
    }

    const { chatBody, model } = translateAnthropicRequest(body);
    const turns = countTurnsAnthropic(body.messages);
    sctx.turns = turns;
    sctx.streaming = !!body.stream;
    logger.info({ event: "interaction", route: "/v1/messages", initiator, turns, model: body.model, interactionId, agentTaskId });

    const doFetch = useOpenRouter
      ? openrouterFetch
      : (path: string, init: RequestInit) => copilotFetch(path, init, true, initiator, interactionId, agentTaskId);
    const doStream = useOpenRouter
      ? streamOpenRouter
      : (path: string, b: unknown, signal?: AbortSignal) => streamCopilot(path, b, signal, initiator, interactionId, agentTaskId);

    if (body.stream) {
      chatBody.stream = true;
      const machine = new AnthropicStreamMachine(model);
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
    return c.json(translateAnthropicResponseBuffered(upstream, model));
  } catch (err: any) {
    if (err instanceof InvalidAnthropicRequestError) {
      emitStats(sctx, { statusCode: 400, error: { type: "invalid_request", status_code: 400, message: err.message } });
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: err.message } },
        400,
      );
    }
    if (err instanceof UpstreamError) {
      const mapped = mapUpstreamErrorAnthropic(err);
      emitStats(sctx, { statusCode: mapped.status, error: { type: "upstream_error", status_code: mapped.status, message: err.message } });
      return c.json(mapped.body, mapped.status);
    }
    emitStats(sctx, { statusCode: 500, error: { type: "internal_error", status_code: 500, message: err.message ?? "Internal error" } });
    return c.json(
      { type: "error", error: { type: "api_error", message: err.message ?? "Internal error" } },
      500,
    );
  }
}

anthropic.post("/v1/messages", handleMessages);
anthropic.post("/anthropic/v1/messages", handleMessages);

export default anthropic;
