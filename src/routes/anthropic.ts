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
import { judge, autoRouteHeaders, textOf, type JudgeResult } from "../auto/judge.js";
import { logger } from "../logger.js";

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
  return messages.some((m: any) => {
    if (m.role === "assistant") return true;
    if (m.role === "user" && Array.isArray(m.content)) {
      return m.content.some((b: any) => b.type === "tool_result");
    }
    return false;
  }) ? "agent" : "user";
}

function countTurnsAnthropic(messages: any[]): number {
  if (!messages?.length) return 0;
  return messages.filter((m: any) => m.role === "assistant").length;
}

async function handleMessages(c: any) {
  try {
    const body = await c.req.json();

    // Auto-route: classify request and pick model
    let ah: Record<string, string> = {};
    let useOpenRouter = false;
    if (body.model === "auto") {
      const msgs: Array<{role: string, content: string}> = [];
      if (body.system) {
        const sys = typeof body.system === "string" ? body.system :
          Array.isArray(body.system) ? body.system.map((b: any) => typeof b === "string" ? b : b.text ?? "").join("\n\n") : "";
        if (sys) msgs.push({ role: "system", content: sys });
      }
      for (const msg of body.messages ?? []) {
        msgs.push({ role: msg.role ?? "user", content: textOf(msg.content) });
      }
      const jr = await judge(msgs);
      body.model = jr.routed;
      useOpenRouter = jr.provider === "openrouter";
      ah = autoRouteHeaders(jr);
      logger.info({ event: "auto_route", route: "/v1/messages", ...ah });
    }

    // Validate model (skip for OpenRouter)
    if (!useOpenRouter) {
      const models = await getModels();
      try {
        resolveModel(models, body.model);
      } catch (err) {
        if (err instanceof ModelNotFoundError) {
          return c.json(
            { type: "error", error: { type: "not_found_error", message: err.message } },
            404,
          );
        }
        throw err;
      }
    }

    const { chatBody, model } = translateAnthropicRequest(body);
    const initiator = detectInitiatorAnthropic(body.messages);
    const { interactionId, agentTaskId } = deriveSessionIds(body.messages);
    const turns = countTurnsAnthropic(body.messages);
    logger.info({ event: "interaction", route: "/v1/messages", initiator, turns, model: body.model });

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
    return c.json(translateAnthropicResponseBuffered(upstream, model));
  } catch (err: any) {
    if (err instanceof InvalidAnthropicRequestError) {
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: err.message } },
        400,
      );
    }
    if (err instanceof UpstreamError) {
      const mapped = mapUpstreamErrorAnthropic(err);
      return c.json(mapped.body, mapped.status);
    }
    return c.json(
      { type: "error", error: { type: "api_error", message: err.message ?? "Internal error" } },
      500,
    );
  }
}

anthropic.post("/v1/messages", handleMessages);
anthropic.post("/anthropic/v1/messages", handleMessages);

export default anthropic;
