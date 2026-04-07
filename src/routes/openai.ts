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

// POST /v1/chat/completions
openai.post("/v1/chat/completions", async (c) => {
  try {
    const body = await c.req.json();

    // Auto-route: classify request and pick model
    let ah: Record<string, string> = {};
    if (body.model === "auto") {
      const msgs = (body.messages ?? []).map((m: any) => ({ role: m.role ?? "user", content: textOf(m.content) }));
      const jr = await judge(msgs);
      body.model = jr.routed;
      ah = autoRouteHeaders(jr);
      logger.info({ event: "auto_route", route: "/v1/chat/completions", ...ah });
    }

    // Validate model
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

    const chatReq = translateChatRequest(body);

    if (chatReq.stream) {
      // Streaming response
      const encoder = new TextEncoder();
      const readableStream = new ReadableStream({
        async start(controller) {
          try {
            for await (const event of streamCopilot("/chat/completions", chatReq, c.req.raw.signal)) {
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
    const res = await copilotFetch("/chat/completions", {
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
      ah = autoRouteHeaders(jr);
      logger.info({ event: "auto_route", route: "/v1/responses", ...ah });
    }

    // Validate model
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

    const { chatBody, model } = translateResponsesRequest(body);

    if (body.stream) {
      chatBody.stream = true;
      const machine = new ResponsesStreamMachine(model);
      const encoder = new TextEncoder();

      const readableStream = new ReadableStream({
        async start(controller) {
          try {
            for await (const event of streamCopilot("/chat/completions", chatBody, c.req.raw.signal)) {
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
    const res = await copilotFetch("/chat/completions", {
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
