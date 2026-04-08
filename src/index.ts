import { Hono } from "hono";
import { nanoid } from "nanoid";
import { loadConfig, getConfig } from "./config.js";
import { logger, isDebug, isRaw, sanitizeHeaders } from "./logger.js";
import { proxyKeyMiddleware } from "./auth/proxy-key.js";
import healthRoutes from "./routes/health.js";
import modelRoutes from "./routes/models.js";
import openaiRoutes from "./routes/openai.js";
import anthropicRoutes from "./routes/anthropic.js";
import statsRoutes from "./routes/stats.js";

const app = new Hono();

// Request ID middleware
app.use("*", async (c, next) => {
  const requestId = `req_${nanoid()}`;
  c.header("x-request-id", requestId);
  const start = Date.now();

  // debug/raw: log incoming request details before processing
  try {
    getConfig();
    if (isDebug()) {
      const reqHeaders = Object.fromEntries(c.req.raw.headers.entries());
      const url = new URL(c.req.url);
      const query = Object.fromEntries(url.searchParams.entries());

      const logData: Record<string, unknown> = {
        event: "request",
        request_id: requestId,
        method: c.req.method,
        route: c.req.path,
        query,
        headers: sanitizeHeaders(reqHeaders),
      };

      // read body for POST/PUT/PATCH without consuming the original stream
      if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
        try {
          const cloned = c.req.raw.clone();
          const bodyText = await cloned.text();
          if (isRaw()) {
            logData.body_raw = bodyText;
          } else {
            try {
              logData.body = JSON.parse(bodyText);
            } catch {
              logData.body = bodyText;
            }
          }
        } catch {
          // body unreadable
        }
      }

      logger.debug(logData);
    }
  } catch {
    // config not loaded yet
  }

  await next();

  const duration = Date.now() - start;

  try {
    getConfig();
    // always log at info level
    logger.info({
      request_id: requestId,
      route: c.req.path,
      method: c.req.method,
      status: c.res.status,
      duration_ms: duration,
    });

    if (isDebug()) {
      const resHeaders = Object.fromEntries(c.res.headers.entries());
      logger.debug({
        event: "response",
        request_id: requestId,
        status: c.res.status,
        duration_ms: duration,
        headers: sanitizeHeaders(resHeaders),
      });
    }
  } catch {
    // Config not loaded yet, skip logging
  }
});

// CORS
app.use("*", async (c, next) => {
  const config = getConfig();
  if (config.ALLOWED_ORIGINS) {
    const origins = config.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
    const origin = c.req.header("Origin");
    if (origin && origins.includes(origin)) {
      c.res.headers.set("Access-Control-Allow-Origin", origin);
      c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version");
    }
  }
  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  await next();
});

// Health routes (no auth)
app.route("/", healthRoutes);

// Auth middleware for API routes
app.use("/v1/*", proxyKeyMiddleware("openai"));
app.use("/anthropic/*", proxyKeyMiddleware("anthropic"));
app.use("/stats*", proxyKeyMiddleware("openai"));

// API routes
app.route("/", modelRoutes);
app.route("/", openaiRoutes);
app.route("/", anthropicRoutes);
app.route("/", statsRoutes);

// 404 fallback
app.notFound((c) => {
  return c.json({ error: { message: "Not found", type: "invalid_request_error", code: "not_found" } }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  const path = c.req.path;
  if (path.startsWith("/anthropic") || path.startsWith("/v1/messages")) {
    return c.json({ type: "error", error: { type: "api_error", message: "Internal server error" } }, 500);
  }
  return c.json({ error: { message: "Internal server error", type: "server_error", code: "internal_error" } }, 500);
});

export { app };

// Server start (only when run directly)
if (import.meta.main) {
  const config = loadConfig();
  console.log(`Starting Copilot Hyper API on port ${config.PORT}`);
}

// Bun auto-serves the default export
export default {
  port: (() => {
    try { return loadConfig().PORT; } catch { return 8787; }
  })(),
  fetch: app.fetch,
};
