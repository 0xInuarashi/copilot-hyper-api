import { getConfig } from "../config.js";
import { logger, isDebug, isRaw, sanitizeHeaders } from "../logger.js";
import { getSessionToken, invalidateSessionToken } from "../auth/session-token.js";
import { getCopilotHeaders, type Initiator } from "./headers.js";
import { parseSSE, type SSEEvent } from "../translate/sse.js";

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
  const { token, apiBase } = await getTokenAndBase();
  const headers = getCopilotHeaders(token, initiator, interactionId, agentTaskId);

  const url = `${apiBase}${path}`;
  const bodyStr = JSON.stringify(body);

  if (isDebug()) {
    const logData: Record<string, unknown> = {
      event: "upstream_stream_request",
      url,
      method: "POST",
      headers: sanitizeHeaders({ ...headers, Accept: "text/event-stream" }),
    };
    if (isRaw()) {
      logData.body_raw = bodyStr;
    }
    logger.debug(logData);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      Accept: "text/event-stream",
    },
    body: bodyStr,
    signal,
  });

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

  for await (const event of parseSSE(res.body)) {
    if (isRaw()) {
      logger.raw({ event: "sse_chunk", sse_event: event.event ?? "data", data: event.data });
    }
    yield event;
  }
}
