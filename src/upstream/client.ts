import { getConfig } from "../config.js";
import { logger, isDebug, isRaw, sanitizeHeaders } from "../logger.js";
import { getSessionToken, invalidateSessionToken } from "../auth/session-token.js";
import { getCopilotHeaders, type Initiator } from "./headers.js";
import { parseSSE, type SSEEvent } from "../translate/sse.js";

// ─── Retry & stream guard constants ──────────────────────────────────────────

const STREAM_FETCH_MAX_RETRIES = 2;
const STREAM_FETCH_INITIAL_DELAY_MS = 500;
const STREAM_MAX_DURATION_MS = 180_000;   // 3 minutes absolute timeout
const STREAM_MAX_CHUNKS = 50_000;
const DEGENERATE_WINDOW = 200;            // check every N deltas
const DEGENERATE_WHITESPACE_RATIO = 0.95; // abort if >95% whitespace

function isRetryableFetchError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    err.name === "AbortError" ||
    msg.includes("connection was closed") ||
    msg.includes("socket connection was closed") ||
    msg.includes("connection reset") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed")
  );
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public upstreamBody?: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

async function getTokenAndBase(): Promise<{ token: string; apiBase: string }> {
  const config = getConfig();
  const session = await getSessionToken(
    config.GITHUB_OAUTH_TOKEN,
    config.SESSION_TOKEN_SAFETY_WINDOW_SECONDS,
  );
  return { token: session.token, apiBase: session.apiBase };
}

export async function copilotFetch(
  path: string,
  init: RequestInit = {},
  retryOn401 = true,
  initiator: Initiator = "user",
  interactionId?: string,
  agentTaskId?: string,
): Promise<Response> {
  const { token, apiBase } = await getTokenAndBase();
  const headers = getCopilotHeaders(token, initiator, interactionId, agentTaskId);

  const url = `${apiBase}${path}`;
  const mergedHeaders = {
    ...headers,
    ...(init.headers as Record<string, string> ?? {}),
  };

  if (isDebug()) {
    const logData: Record<string, unknown> = {
      event: "upstream_request",
      url,
      method: init.method ?? "GET",
      headers: sanitizeHeaders(mergedHeaders),
    };
    if (isRaw() && init.body) {
      logData.body_raw = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    }
    logger.debug(logData);
  }

  const res = await fetch(url, {
    ...init,
    headers: mergedHeaders,
  });

  if (isDebug()) {
    const resHeaders = Object.fromEntries(res.headers.entries());
    logger.debug({
      event: "upstream_response",
      url,
      status: res.status,
      headers: sanitizeHeaders(resHeaders),
    });
  }

  if (res.status === 401 && retryOn401) {
    const config = getConfig();
    logger.debug({ event: "session_token_invalidate", reason: "upstream 401" });
    invalidateSessionToken(config.GITHUB_OAUTH_TOKEN);
    return copilotFetch(path, init, false, initiator, interactionId, agentTaskId);
  }

  if (!res.ok && res.status !== 401) {
    const body = await res.text().catch(() => "");
    if (isRaw()) {
      logger.raw({ event: "upstream_error_body", status: res.status, body });
    }
    if (res.status === 402 || res.status === 429) {
      throw new UpstreamError(`Copilot quota exceeded: ${res.status}`, res.status, body);
    }
    if (res.status >= 500) {
      throw new UpstreamError(`Copilot upstream error: ${res.status}`, res.status, body);
    }
    throw new UpstreamError(`Copilot error: ${res.status}`, res.status, body);
  }

  return res;
}

export async function* streamCopilot(
  path: string,
  body: unknown,
  signal?: AbortSignal,
  initiator: Initiator = "user",
  interactionId?: string,
  agentTaskId?: string,
): AsyncIterable<SSEEvent> {
  let currentHeaders = getCopilotHeaders(
    (await getTokenAndBase()).token, initiator, interactionId, agentTaskId,
  );
  const apiBase = (await getTokenAndBase()).apiBase;
  const url = `${apiBase}${path}`;
  const bodyStr = JSON.stringify(body);

  if (isDebug()) {
    const logData: Record<string, unknown> = {
      event: "upstream_stream_request",
      url,
      method: "POST",
      headers: sanitizeHeaders({ ...currentHeaders, Accept: "text/event-stream" }),
    };
    if (isRaw()) {
      logData.body_raw = bodyStr;
    }
    logger.debug(logData);
  }

  // ── Fix 1: Retry fetch with exponential backoff ────────────────────────────
  let res: Response | undefined;
  for (let attempt = 0; attempt <= STREAM_FETCH_MAX_RETRIES; attempt++) {
    try {
      logger.debug({ event: "upstream_stream_fetch_start", url, attempt });
      res = await fetch(url, {
        method: "POST",
        headers: { ...currentHeaders, Accept: "text/event-stream" },
        body: bodyStr,
        signal,
      });
      logger.debug({ event: "upstream_stream_fetch_done", url, status: res.status, attempt });
      break; // success
    } catch (fetchErr) {
      logger.error({ event: "upstream_stream_fetch_error", url, attempt, error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr) });

      if (attempt < STREAM_FETCH_MAX_RETRIES && isRetryableFetchError(fetchErr) && !signal?.aborted) {
        const delay = STREAM_FETCH_INITIAL_DELAY_MS * Math.pow(2, attempt);
        logger.info({ event: "upstream_stream_fetch_retry", url, attempt: attempt + 1, delay_ms: delay });
        await new Promise(r => setTimeout(r, delay));
        // Refresh token in case it expired during the wait
        const fresh = await getTokenAndBase();
        currentHeaders = getCopilotHeaders(fresh.token, initiator, interactionId, agentTaskId);
        continue;
      }
      throw fetchErr;
    }
  }
  if (!res) throw new UpstreamError("All stream fetch retries exhausted", 502);

  if (isDebug()) {
    const resHeaders = Object.fromEntries(res.headers.entries());
    logger.debug({
      event: "upstream_stream_response",
      url,
      status: res.status,
      headers: sanitizeHeaders(resHeaders),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (isRaw()) {
      logger.raw({ event: "upstream_stream_error_body", status: res.status, body: text });
    }
    throw new UpstreamError(`Copilot stream error: ${res.status}`, res.status, text);
  }

  if (!res.body) {
    throw new UpstreamError("No response body for stream", 500);
  }

  // ── Fix 2: Stream guards (timeout + degenerate detection) ──────────────────
  let chunkCount = 0;
  const streamStart = Date.now();
  let whitespaceDeltas = 0;
  let totalDeltas = 0;

  try {
    for await (const event of parseSSE(res.body)) {
      chunkCount++;

      // Absolute time limit
      if (Date.now() - streamStart > STREAM_MAX_DURATION_MS) {
        logger.warn({ event: "upstream_stream_timeout", url, chunks: chunkCount, elapsed_ms: Date.now() - streamStart });
        break;
      }

      // Absolute chunk limit
      if (chunkCount > STREAM_MAX_CHUNKS) {
        logger.warn({ event: "upstream_stream_chunk_limit", url, chunks: chunkCount });
        break;
      }

      // Degenerate whitespace detection
      if (event.data && event.data !== "[DONE]") {
        try {
          const parsed = JSON.parse(event.data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta) {
            const text = (delta.content ?? "") +
              (delta.tool_calls?.map((tc: any) => tc.function?.arguments ?? "").join("") ?? "");
            if (text.length > 0) {
              totalDeltas++;
              if (text.trim().length === 0) whitespaceDeltas++;
              if (totalDeltas > DEGENERATE_WINDOW && totalDeltas % DEGENERATE_WINDOW === 0) {
                const ratio = whitespaceDeltas / totalDeltas;
                if (ratio > DEGENERATE_WHITESPACE_RATIO) {
                  logger.warn({ event: "upstream_stream_degenerate", url, chunks: chunkCount, whitespace_ratio: ratio.toFixed(3) });
                  break;
                }
              }
            }
          }
        } catch { /* unparseable — skip detection, still yield */ }
      }

      if (isRaw()) {
        logger.raw({ event: "sse_chunk", sse_event: event.event ?? "data", data: event.data });
      }
      yield event;
    }
    logger.debug({ event: "upstream_stream_complete", url, chunks: chunkCount });
  } catch (streamErr) {
    logger.error({ event: "upstream_stream_read_error", url, chunks: chunkCount, error: streamErr instanceof Error ? streamErr.message : String(streamErr) });
    throw streamErr;
  }
}
