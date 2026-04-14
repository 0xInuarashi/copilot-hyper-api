import { CircuitBreaker, CircuitBreakerOpenError } from "./circuit-breaker.js";
import { getResolvedVersions } from "../upstream/version-sync.js";

export { CircuitBreakerOpenError };

export class CopilotAuthError extends Error {
  constructor(message: string, public statusCode: number = 401) {
    super(message);
    this.name = "CopilotAuthError";
  }
}

// Module-level circuit breaker for token fetches.
// Initialized lazily so config values can be passed in at runtime.
let _breaker: CircuitBreaker | null = null;

function getBreaker(threshold?: number, cooldownMs?: number): CircuitBreaker {
  if (!_breaker) {
    _breaker = new CircuitBreaker(threshold ?? 5, cooldownMs ?? 1_800_000);
  }
  return _breaker;
}

export function getTokenCircuitBreakerState(): string {
  return _breaker?.getState() ?? "closed";
}

interface SessionToken {
  token: string;
  expiresAt: number;
  apiBase: string;
}

interface CachedSession {
  session: SessionToken;
  refreshPromise: Promise<SessionToken> | null;
}

const cache = new Map<string, CachedSession>();

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  return hash;
}

async function fetchSessionToken(oauthToken: string): Promise<SessionToken> {
  const v = getResolvedVersions();
  const coreVersion = v.copilotCoreVersion.replace("copilot/", "");
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    method: "GET",
    headers: {
      Authorization: `token ${oauthToken}`,
      Accept: "application/json",
      "User-Agent": `GithubCopilot/${coreVersion}`,
      "Editor-Version": v.editorVersion,
      "Editor-Plugin-Version": v.copilotCoreVersion,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CopilotAuthError(
      `Failed to fetch Copilot session token: ${res.status} ${body}`,
      res.status,
    );
  }

  const data = (await res.json()) as {
    token: string;
    expires_at: number;
    endpoints?: { api?: string };
  };

  return {
    token: data.token,
    expiresAt: data.expires_at,
    apiBase: data.endpoints?.api ?? "https://api.githubcopilot.com",
  };
}

function isRetryableTokenError(err: unknown): boolean {
  if (err instanceof CopilotAuthError) {
    // Don't retry client auth errors (401/403) — those won't resolve on retry
    return err.statusCode >= 500 || err.statusCode === 429;
  }
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout")
  );
}

/**
 * Fetch session token with retry + timeout.
 * Absorbs transient failures so the circuit breaker only trips on persistent issues.
 */
async function fetchSessionTokenWithRetry(
  oauthToken: string,
  maxRetries: number,
  timeoutMs: number,
): Promise<SessionToken> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await fetchSessionToken(oauthToken);
        return result;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isRetryableTokenError(err)) {
        const delay = 1000 * (attempt + 1); // 1s, 2s, 3s
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

export async function getSessionToken(
  oauthToken: string,
  safetyWindowSeconds: number = 120,
  circuitBreakerThreshold?: number,
  circuitBreakerCooldownMs?: number,
  tokenRefreshMaxRetries?: number,
  tokenRefreshTimeoutMs?: number,
): Promise<SessionToken> {
  const key = await hashToken(oauthToken);
  const cached = cache.get(key);

  if (cached) {
    const now = Math.floor(Date.now() / 1000);
    if (now < cached.session.expiresAt - safetyWindowSeconds) {
      return cached.session;
    }
  }

  // Single-flight: reuse existing refresh promise
  const existing = cache.get(key);
  if (existing?.refreshPromise) {
    return existing.refreshPromise;
  }

  const breaker = getBreaker(circuitBreakerThreshold, circuitBreakerCooldownMs);

  const maxRetries = tokenRefreshMaxRetries ?? 3;
  const timeoutMs = tokenRefreshTimeoutMs ?? 30_000;

  const refreshPromise = breaker.execute(() => fetchSessionTokenWithRetry(oauthToken, maxRetries, timeoutMs)).then((session) => {
    cache.set(key, { session, refreshPromise: null });
    return session;
  }).catch((err) => {
    // Clear the promise so next call retries
    const entry = cache.get(key);
    if (entry) {
      entry.refreshPromise = null;
    }
    throw err;
  });

  if (existing) {
    existing.refreshPromise = refreshPromise;
  } else {
    cache.set(key, {
      session: { token: "", expiresAt: 0, apiBase: "" },
      refreshPromise,
    });
  }

  return refreshPromise;
}

export function invalidateSessionToken(oauthToken: string): void {
  // Synchronous hash for invalidation
  const data = new TextEncoder().encode(oauthToken);
  const key = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  cache.delete(key);
}

export function clearSessionTokenCache(): void {
  cache.clear();
}

export { type SessionToken };
