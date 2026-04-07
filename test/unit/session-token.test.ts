import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { getSessionToken, invalidateSessionToken, clearSessionTokenCache } from "../../src/auth/session-token.js";

// We'll test the session token logic by mocking fetch
const originalFetch = globalThis.fetch;

describe("session-token", () => {
  beforeEach(() => {
    clearSessionTokenCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearSessionTokenCache();
  });

  test("fetches and caches session token", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async (url: string) => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          token: "session-token-123",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: "https://api.githubcopilot.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    const result = await getSessionToken("gho_test_token", 120);
    expect(result.token).toBe("session-token-123");
    expect(result.apiBase).toBe("https://api.githubcopilot.com");
    expect(fetchCount).toBe(1);

    // Second call should use cache
    const result2 = await getSessionToken("gho_test_token", 120);
    expect(result2.token).toBe("session-token-123");
    expect(fetchCount).toBe(1);
  });

  test("refreshes when within safety window", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          token: `session-token-${fetchCount}`,
          expires_at: fetchCount === 1
            ? Math.floor(Date.now() / 1000) + 10 // expires soon
            : Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: "https://api.githubcopilot.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    // First fetch - expires in 10s, safety window is 120s, so next call should refresh
    await getSessionToken("gho_test_token", 120);
    expect(fetchCount).toBe(1);

    // Should trigger refresh because 10s < 120s safety window
    const result2 = await getSessionToken("gho_test_token", 120);
    expect(fetchCount).toBe(2);
    expect(result2.token).toBe("session-token-2");
  });

  test("single-flight: concurrent calls share one fetch", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      // Add a small delay to ensure concurrency
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(
        JSON.stringify({
          token: "shared-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: "https://api.githubcopilot.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    // Fire 50 concurrent calls
    const promises = Array.from({ length: 50 }, () => getSessionToken("gho_concurrent_token", 120));
    const results = await Promise.all(promises);

    // All should return the same token
    for (const r of results) {
      expect(r.token).toBe("shared-token");
    }
    // Only 1 fetch should have been made
    expect(fetchCount).toBe(1);
  });

  test("force-invalidate triggers refresh on next call", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          token: `token-${fetchCount}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: "https://api.githubcopilot.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as any;

    await getSessionToken("gho_invalidate_test", 120);
    expect(fetchCount).toBe(1);

    invalidateSessionToken("gho_invalidate_test");

    const result = await getSessionToken("gho_invalidate_test", 120);
    expect(fetchCount).toBe(2);
    expect(result.token).toBe("token-2");
  });

  test("upstream 401 → throws CopilotAuthError", async () => {
    globalThis.fetch = (async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as any;

    try {
      await getSessionToken("gho_bad_token", 120);
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.name).toBe("CopilotAuthError");
      expect(err.statusCode).toBe(401);
    }
  });
});
