import { describe, it, expect } from "bun:test";

const BASE_URL = "http://localhost:19234";
const OPENAI_KEY = process.env.PROXY_API_KEY || "sk-test";

describe("/v1/responses endpoint", () => {
  it("should return 400 for previous_response_id", async () => {
    const res = await fetch(`${BASE_URL}/v1/responses`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ previous_response_id: "bad", model: "gpt-4.1" })
    });
    expect(res.status).toBe(400);
  });
});
