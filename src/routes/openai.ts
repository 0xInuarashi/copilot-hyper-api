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
import { judge, autoRouteHeaders, textOf, type JudgeResult } from "../auto/judge.js";
import { logger } from "../logger.js";

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
  return messages.some((m: any) => m.role === "assistant" || m.role === "tool") ? "agent" : "user";
}

function detectInitiatorResponses(input: any): Initiator {
  if (typeof input === "string" || !Array.isArray(input) || !input.length) return "user";
  const agentTypes = ["function_call_output", "tool_call_output", "computer_call_output"];
  return input.some((i: any) => i.role === "assistant" || agentTypes.includes(i.type)) ? "agent" : "user";
}

function countTurns(messages: any[]): number {
  if (!messages?.length) return 0;
  return messages.filter((m: any) => m.role === "assistant" || m.role === "tool").length;
}

// POST /v1/chat/completions
openai.post("/v1/chat/completions", async (c) => {
  try {
    const body = await c.req.json();

    // Auto-route: classify request and pick model
    let ah: Record<string, string> = {};
    let useOpenRouter = false;
    if (body.model === "auto") {
      const msgs = (body.messages ?? []).map((m: any) => ({ role: m.role ?? "user", content: textOf(m.content) }));
      const jr = await judge(msgs);
      body.model = jr.routed;
      useOpenRouter = jr.provider === "openrouter";
      ah = autoRouteHeaders(jr);
      logger.info({ event: "auto_route", route: "/v1/chat/completions", ...ah });
    }

    // Validate model (skip for OpenRouter — not in Copilot's model list)
    if (!useOpenRouter) {
      const models = await getModels();
      try {
        resolveModel(models, body.model);
      } catch (err) {
        if (err instanceof ModelNotFoundError) {
          return c.json(
            { error: { message: err.message, type: "invalid_request_error", code: "model_not_found" } },
            404,
          );
        }
        throw err;
      }
    }

    const chatReq = translateChatRequest(body);
    const initiator = detectInitiatorChat(body.messages);
    const { interactionId, agentTaskId } = deriveSessionIds(body.messages);
    const turns = countTurns(body.messages);
    logger.info({ event: "interaction", route: "/v1/chat/completions", initiator, turns, model: body.model });

    const doFetch = useOpenRouter
      ? openrouterFetch
      : (path: string, init: RequestInit) => copilotFetch(path, init, true, initiator, interactionId, agentTaskId);
    const doStream = useOpenRouter
      ? streamOpenRouter
      : (path: string, b: unknown, signal?: AbortSignal) => streamCopilot(path, b, signal, initiator, interactionId, agentTaskId);

    if (chatReq.stream) {
      // Streaming response
      const encoder = new TextEncoder();
      const readableStream = new ReadableStream({
        async start(controller) {
          try {
            for await (const event of doStream("/chat/completions", chatReq, c.req.raw.signal)) {
              if (event.data === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                break;
              }
              controller.enqueue(encoder.encode(`data: ${event.data}\n\n`));
            }
          } catch (err) {
            // Stream error
          } finally {
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
    const upstream = await res.json();
    for (const [k, v] of Object.entries(ah)) c.header(k, v);
    return c.json(translateChatResponse(upstream));
  } catch (err: any) {
    if (err instanceof InvalidChatRequestError) {
      return c.json({ error: { message: err.message, type: "invalid_request_error", code: "invalid_request" } }, 400);
    }
    if (err instanceof UpstreamError) {
      const mapped = mapUpstreamError(err);
      return c.json(mapped.body, mapped.status);
    }
    return c.json({ error: { message: err.message ?? "Internal error", type: "server_error", code: "internal_error" } }, 500);
  }
});

// POST /v1/responses
openai.post("/v1/responses", async (c) => {
  try {
    const body = await c.req.json();

    // Auto-route: classify request and pick model
    let ah: Record<string, string> = {};
    let useOpenRouter = false;
    if (body.model === "auto") {
      const msgs: Array<{role: string, content: string}> = [];
      if (body.instructions) msgs.push({ role: "system", content: body.instructions });
      if (typeof body.input === "string") {
        msgs.push({ role: "user", content: body.input });
      } else if (Array.isArray(body.input)) {
        for (const item of body.input) {
          msgs.push({ role: item.role ?? "user", content: textOf(item.content ?? item.text ?? item) });
        }
      }
      const jr = await judge(msgs);
      body.model = jr.routed;
      useOpenRouter = jr.provider === "openrouter";
      ah = autoRouteHeaders(jr);
      logger.info({ event: "auto_route", route: "/v1/responses", ...ah });
    }

    // Validate model (skip for OpenRouter)
    if (!useOpenRouter) {
      const models = await getModels();
      try {
        resolveModel(models, body.model);
      } catch (err) {
        if (err instanceof ModelNotFoundError) {
          return c.json(
            { error: { message: err.message, type: "invalid_request_error", code: "model_not_found" } },
            404,
          );
        }
        throw err;
      }
    }

    const { chatBody, model } = translateResponsesRequest(body);
    const initiator = detectInitiatorResponses(body.input);
    const chatMessages = Array.isArray(body.input) ? body.input : [];
    const { interactionId, agentTaskId } = deriveSessionIds(chatMessages);
    const turns = chatMessages.filter((i: any) => i.role === "assistant" || ["function_call_output", "tool_call_output", "computer_call_output"].includes(i.type)).length;
    logger.info({ event: "interaction", route: "/v1/responses", initiator, turns, model: body.model });

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
    const upstream = await res.json();
    for (const [k, v] of Object.entries(ah)) c.header(k, v);
    return c.json(translateResponsesBuffered(upstream, model));
  } catch (err: any) {
    if (err instanceof InvalidResponsesRequestError) {
      return c.json({ error: { message: err.message, type: "invalid_request_error", code: "invalid_request" } }, 400);
    }
    if (err instanceof UpstreamError) {
      const mapped = mapUpstreamError(err);
      return c.json(mapped.body, mapped.status);
    }
    return c.json({ error: { message: err.message ?? "Internal error", type: "server_error", code: "internal_error" } }, 500);
  }
});

export default openai;
