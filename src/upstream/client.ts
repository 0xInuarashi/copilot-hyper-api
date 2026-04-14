import { getConfig } from "../config.js";
import { logger, isDebug, isRaw, sanitizeHeaders } from "../logger.js";
import { getSessionToken, invalidateSessionToken, getTokenCircuitBreakerState } from "../auth/session-token.js";
import { getCopilotHeaders, type Initiator } from "./headers.js";
import { parseSSE, type SSEEvent } from "../translate/sse.js";
import { Semaphore, SemaphoreTimeoutError } from "./semaphore.js";
export { SemaphoreTimeoutError };
import { orderHeaders, orderBodyFields } from "./fingerprint.js";
import { tlsFetch, isTlsClientAvailable, getTlsProfile } from "./tls-client.js";

// ─── Retry & stream guard constants ──────────────────────────────────────────

const STREAM_FETCH_MAX_RETRIES = 2;
const STREAM_FETCH_INITIAL_DELAY_MS = 500;
const STREAM_MAX_DURATION_MS = 180_000;   // 3 minutes absolute timeout
const STREAM_MAX_CHUNKS = 50_000;
const DEGENERATE_WINDOW = 200;            // check every N deltas
const DEGENERATE_WHITESPACE_RATIO = 0.95; // abort if >95% whitespace

// Lazy-initialized semaphore (created on first use so config is available)
let _semaphore: Semaphore | null = null;
function getSemaphore(): Semaphore {
  if (!_semaphore) {
    const config = getConfig();
    _semaphore = new Semaphore(config.MAX_CONCURRENT_REQUESTS, config.SEMAPHORE_TIMEOUT_MS);
  }
  return _semaphore;
}

/**
 * Telemetry accumulator — created per-request, passed to stats emission.
 * Route handlers create this and pass it through to copilotFetch/streamCopilot.
 */
export interface TelemetryAccumulator {
  tokenFetchMs: number | null;
  upstreamFetchMs: number | null;
  retryCount: number;
  semaphoreWaitMs: number;
}

export function createTelemetryAccumulator(): TelemetryAccumulator {
  return { tokenFetchMs: null, upstreamFetchMs: null, retryCount: 0, semaphoreWaitMs: 0 };
}

/** Build the stealth telemetry snapshot for stats emission. */
export function buildStealthTelemetry(acc: TelemetryAccumulator | undefined) {
  if (!acc) return null;
  const config = getConfig();
  return {
    tls_fingerprint_used: config.ENABLE_TLS_FINGERPRINT && isTlsClientAvailable(),
    tls_profile: getTlsProfile(),
    header_ordering_applied: config.ENABLE_HEADER_ORDERING,
    body_ordering_applied: config.ENABLE_BODY_ORDERING,
    token_fetch_ms: acc.tokenFetchMs,
    upstream_fetch_ms: acc.upstreamFetchMs,
    retry_count: acc.retryCount,
    circuit_breaker_state: getTokenCircuitBreakerState() as "closed" | "open" | "half-open",
    semaphore_wait_ms: acc.semaphoreWaitMs,
  };
}

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

async function getTokenAndBase(acc?: TelemetryAccumulator): Promise<{ token: string; apiBase: string }> {
  const config = getConfig();
  const t0 = Date.now();
  const session = await getSessionToken(
    config.GITHUB_OAUTH_TOKEN,
    config.SESSION_TOKEN_SAFETY_WINDOW_SECONDS,
    config.CIRCUIT_BREAKER_THRESHOLD,
    config.CIRCUIT_BREAKER_COOLDOWN_MS,
    config.TOKEN_REFRESH_MAX_RETRIES,
    config.TOKEN_REFRESH_TIMEOUT_MS,
  );
  if (acc) acc.tokenFetchMs = Date.now() - t0;
  return { token: session.token, apiBase: session.apiBase };
}

export async function copilotFetch(
  path: string,
  init: RequestInit = {},
  retryOn401 = true,
  initiator: Initiator = "user",
  interactionId?: string,
  agentTaskId?: string,
  telemetry?: TelemetryAccumulator,
): Promise<Response> {
  const config = getConfig();
  const { token, apiBase } = await getTokenAndBase(telemetry);
  const headers = getCopilotHeaders(token, initiator, interactionId, agentTaskId);

  const url = `${apiBase}${path}`;
  let mergedHeaders: Record<string, string> = {
    ...headers,
    ...(init.headers as Record<string, string> ?? {}),
  };

  // Apply header ordering if enabled
  if (config.ENABLE_HEADER_ORDERING) {
    mergedHeaders = orderHeaders(mergedHeaders);
  }

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

  // Wrap the actual fetch in the semaphore
  const doFetch = async () => {
    const fetchFn = config.ENABLE_TLS_FINGERPRINT ? tlsFetch : fetch;
    const t0 = Date.now();
    const res = await fetchFn(url, { ...init, headers: mergedHeaders });
    if (telemetry) telemetry.upstreamFetchMs = Date.now() - t0;
    return res;
  };

  const { result: res, waitMs } = await getSemaphore().run(doFetch);
  if (telemetry) telemetry.semaphoreWaitMs = waitMs;

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
    logger.debug({ event: "session_token_invalidate", reason: "upstream 401" });
    invalidateSessionToken(config.GITHUB_OAUTH_TOKEN);
    if (telemetry) telemetry.retryCount++;
    return copilotFetch(path, init, false, initiator, interactionId, agentTaskId, telemetry);
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
  telemetry?: TelemetryAccumulator,
): AsyncIterable<SSEEvent> {
  const config = getConfig();
  const { token, apiBase } = await getTokenAndBase(telemetry);
  let currentHeaders = getCopilotHeaders(token, initiator, interactionId, agentTaskId);

  // Apply header ordering
  if (config.ENABLE_HEADER_ORDERING) {
    currentHeaders = orderHeaders({ ...currentHeaders, Accept: "text/event-stream" }) as Record<string, string>;
  } else {
    currentHeaders = { ...currentHeaders, Accept: "text/event-stream" };
  }

  const url = `${apiBase}${path}`;

  // Apply body field ordering
  let bodyStr: string;
  if (config.ENABLE_BODY_ORDERING && body && typeof body === "object" && !Array.isArray(body)) {
    bodyStr = orderBodyFields(body as Record<string, unknown>);
  } else {
    bodyStr = JSON.stringify(body);
  }

  if (isDebug()) {
    const logData: Record<string, unknown> = {
      event: "upstream_stream_request",
      url,
      method: "POST",
      headers: sanitizeHeaders(currentHeaders),
    };
    if (isRaw()) {
      logData.body_raw = bodyStr;
    }
    logger.debug(logData);
  }

  // ── Fix 1: Retry fetch with exponential backoff ────────────────────────────
  let res: Response | undefined;
  const fetchFn = config.ENABLE_TLS_FINGERPRINT ? tlsFetch : fetch;
  for (let attempt = 0; attempt <= STREAM_FETCH_MAX_RETRIES; attempt++) {
    try {
      logger.debug({ event: "upstream_stream_fetch_start", url, attempt });

      // Wrap in semaphore
      const { result: fetchRes, waitMs } = await getSemaphore().run(async () => {
        const t0 = Date.now();
        const r = await fetchFn(url, {
          method: "POST",
          headers: currentHeaders,
          body: bodyStr,
          signal,
        });
        if (telemetry) telemetry.upstreamFetchMs = Date.now() - t0;
        return r;
      });
      if (telemetry) telemetry.semaphoreWaitMs = waitMs;

      res = fetchRes;
      logger.debug({ event: "upstream_stream_fetch_done", url, status: res.status, attempt });
      break; // success
    } catch (fetchErr) {
      logger.error({ event: "upstream_stream_fetch_error", url, attempt, error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr) });
      if (telemetry) telemetry.retryCount = attempt + 1;

      if (attempt < STREAM_FETCH_MAX_RETRIES && isRetryableFetchError(fetchErr) && !signal?.aborted) {
        const delay = STREAM_FETCH_INITIAL_DELAY_MS * Math.pow(2, attempt);
        logger.info({ event: "upstream_stream_fetch_retry", url, attempt: attempt + 1, delay_ms: delay });
        await new Promise(r => setTimeout(r, delay));
        // Refresh token in case it expired during the wait
        const fresh = await getTokenAndBase(telemetry);
        let refreshed = getCopilotHeaders(fresh.token, initiator, interactionId, agentTaskId);
        if (config.ENABLE_HEADER_ORDERING) {
          refreshed = orderHeaders({ ...refreshed, Accept: "text/event-stream" }) as Record<string, string>;
        } else {
          refreshed = { ...refreshed, Accept: "text/event-stream" };
        }
        currentHeaders = refreshed;
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
