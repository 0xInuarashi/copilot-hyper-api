import { getConfig } from "../config.js";
import { logger, isDebug, isRaw } from "../logger.js";
import { parseSSE, type SSEEvent } from "../translate/sse.js";
import { UpstreamError } from "./client.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

function getHeaders(): Record<string, string> {
  const config = getConfig();
  return {
    Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/copilot-hyper-api",
  };
}

export async function openrouterFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = getHeaders();
  const url = `${OPENROUTER_BASE}${path}`;

  if (isDebug()) {
    logger.debug({ event: "openrouter_request", url, method: init.method ?? "GET" });
  }

  const res = await fetch(url, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) },
  });

  if (isDebug()) {
    logger.debug({ event: "openrouter_response", url, status: res.status });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (isRaw()) {
      logger.raw({ event: "openrouter_error_body", status: res.status, body });
    }
    throw new UpstreamError(`OpenRouter error: ${res.status}`, res.status, body);
  }

  return res;
}

export async function* streamOpenRouter(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncIterable<SSEEvent> {
  const headers = getHeaders();
  const url = `${OPENROUTER_BASE}${path}`;
  const bodyStr = JSON.stringify(body);

  if (isDebug()) {
    logger.debug({ event: "openrouter_stream_request", url });
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, Accept: "text/event-stream" },
    body: bodyStr,
    signal,
  });

  if (isDebug()) {
    logger.debug({ event: "openrouter_stream_response", url, status: res.status });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UpstreamError(`OpenRouter stream error: ${res.status}`, res.status, text);
  }

  if (!res.body) {
    throw new UpstreamError("No response body for stream", 500);
  }

  for await (const event of parseSSE(res.body)) {
    if (isRaw()) {
      logger.raw({ event: "sse_chunk", source: "openrouter", data: event.data });
    }
    yield event;
  }
}
