import { describe, it, expect } from "bun:test";

const BASE_URL = "http://localhost:19234";
const OPENAI_KEY = process.env.PROXY_API_KEY || "sk-test";

describe("/anthropic/v1/messages endpoint", () => {
  it("should reject unknown model", async () => {
    const res = await fetch(`${BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": OPENAI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "unknown-model", messages: [{ role: "user", content: "hi" }], max_tokens: 10 })
    });
    expect(res.status).toBe(404);
  });

  it("should accept gpt-4.1", async () => {
    const res = await fetch(`${BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": OPENAI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }], max_tokens: 10 })
    });
    expect([200, 502, 429]).toContain(res.status);
  });

  it("should accept gpt-5-mini", async () => {
    const res = await fetch(`${BASE_URL}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": OPENAI_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }], max_tokens: 10 })
    });
    expect([200, 502, 429]).toContain(res.status);
  });
});
