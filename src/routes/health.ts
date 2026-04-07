import { Hono } from "hono";

const health = new Hono();

health.get("/healthz", (c) => {
  return c.json({ status: "ok" });
});

health.get("/readyz", async (c) => {
  try {
    const { getConfig } = await import("../config.js");
    const { getSessionToken } = await import("../auth/session-token.js");
    const config = getConfig();
    await getSessionToken(config.GITHUB_OAUTH_TOKEN, config.SESSION_TOKEN_SAFETY_WINDOW_SECONDS);
    return c.json({ status: "ready" });
  } catch (err: any) {
    return c.json({ status: "not_ready", error: err.message }, 503);
  }
});

export default health;
