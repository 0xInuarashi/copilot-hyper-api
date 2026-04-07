export class CopilotAuthError extends Error {
  constructor(message: string, public statusCode: number = 401) {
    super(message);
    this.name = "CopilotAuthError";
  }
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
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    method: "GET",
    headers: {
      Authorization: `token ${oauthToken}`,
      Accept: "application/json",
      "User-Agent": "GithubCopilot/1.0",
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

export async function getSessionToken(
  oauthToken: string,
  safetyWindowSeconds: number = 120,
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

  const refreshPromise = fetchSessionToken(oauthToken).then((session) => {
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
