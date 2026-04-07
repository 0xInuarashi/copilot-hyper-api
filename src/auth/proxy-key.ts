import { type Context, type Next } from "hono";
import { getConfig } from "../config.js";

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);

  if (aBuf.length !== bBuf.length) {
    // Compare against a same-length buffer to spend constant time
    const dummy = new Uint8Array(aBuf.length);
    let result = 1; // always false
    for (let i = 0; i < aBuf.length; i++) {
      result |= aBuf[i]! ^ dummy[i]!;
    }
    return false;
  }

  // Byte-by-byte constant-time comparison
  let result = 0;
  for (let i = 0; i < aBuf.length; i++) {
    result |= aBuf[i]! ^ bBuf[i]!;
  }
  return result === 0;
}

export type ErrorFormat = "openai" | "anthropic";

function formatError(format: ErrorFormat, status: number, message: string) {
  if (format === "anthropic") {
    return {
      type: "error",
      error: {
        type: status === 401 ? "authentication_error" : "invalid_request_error",
        message,
      },
    };
  }
  return {
    error: {
      message,
      type: status === 401 ? "invalid_api_key" : "invalid_request_error",
      code: status === 401 ? "invalid_api_key" : "invalid_request",
    },
  };
}

export function proxyKeyMiddleware(errorFormat: ErrorFormat = "openai") {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization") ?? c.req.header("x-api-key") ?? "";
    let token = "";

    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    } else if (c.req.header("x-api-key")) {
      token = authHeader;
    }

    if (!token) {
      return c.json(formatError(errorFormat, 401, "Missing API key. Provide Authorization: Bearer <key> header."), 401);
    }

    const config = getConfig();
    if (!timingSafeEqual(token, config.PROXY_API_KEY)) {
      return c.json(formatError(errorFormat, 401, "Invalid API key."), 401);
    }

    await next();
  };
}
