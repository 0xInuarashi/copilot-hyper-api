import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { app } from "../../src/index.js";
import { loadConfig, resetConfig } from "../../src/config.js";
import { clearSessionTokenCache } from "../../src/auth/session-token.js";
import { clearModelCache } from "../../src/upstream/models.js";

// Test configuration
const TEST_API_KEY = "sk-test-proxy-key-12345";
const TEST_OAUTH_TOKEN = "gho_test_oauth_token";

// Simulated Copilot responses
const MOCK_SESSION_TOKEN_RESPONSE = {
  token: "tid=mock-session-token",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  endpoints: { api: "http://mock-copilot.test" },
};

const MOCK_MODELS_RESPONSE = {
  data: [
    {
      id: "gpt-4o-2024-05-13",
      object: "model",
      capabilities: { limits: { max_prompt_tokens: 128000, max_output_tokens: 4096 }, supports: { tool_calls: true, vision: true } },
      family: "gpt-4o",
    },
    {
      id: "claude-3.5-sonnet",
      object: "model",
      capabilities: { limits: { max_prompt_tokens: 200000, max_output_tokens: 8192 }, supports: { tool_calls: true, vision: true } },
      family: "claude",
    },
  ],
};

const MOCK_CHAT_RESPONSE = {
  id: "chatcmpl-mock123",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o-2024-05-13",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello from mock!" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19 },
};

const MOCK_TOOL_CALL_RESPONSE = {
  id: "chatcmpl-mock-tools",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o-2024-05-13",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_mock1",
        type: "function",
        function: { name: "get_weather", arguments: "{\"location\":\"San Francisco\"}" },
      }],
    },
    finish_reason: "tool_calls",
  }],
  usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
};

// Simple streaming response
function makeMockStreamResponse(): string {
  const chunks = [
    { id: "chatcmpl-stream", object: "chat.completion.chunk", created: 1700000000, model: "gpt-4o-2024-05-13", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl-stream", object: "chat.completion.chunk", created: 1700000000, model: "gpt-4o-2024-05-13", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
    { id: "chatcmpl-stream", object: "chat.completion.chunk", created: 1700000000, model: "gpt-4o-2024-05-13", choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }] },
    { id: "chatcmpl-stream", object: "chat.completion.chunk", created: 1700000000, model: "gpt-4o-2024-05-13", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ];
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

// Mock fetch to intercept upstream calls
const originalFetch = globalThis.fetch;

function setupMockFetch() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;

    // Session token endpoint
    if (url.includes("copilot_internal/v2/token")) {
      return new Response(JSON.stringify(MOCK_SESSION_TOKEN_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Models endpoint
    if (url.includes("mock-copilot.test/models")) {
      return new Response(JSON.stringify(MOCK_MODELS_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Chat completions endpoint
    if (url.includes("mock-copilot.test/chat/completions")) {
      const body = init?.body ? JSON.parse(init.body as string) : {};

      if (body.stream) {
        return new Response(makeMockStreamResponse(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      // Check if tools are requested
      if (body.tools && body.tools.length > 0) {
        return new Response(JSON.stringify(MOCK_TOOL_CALL_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(MOCK_CHAT_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Fallback
    return new Response("Not found", { status: 404 });
  }) as any;
}

// Helper to make requests to our app
async function appFetch(path: string, init?: RequestInit): Promise<Response> {
  const req = new Request(`http://localhost${path}`, init);
  return app.fetch(req);
}

describe("Integration: Health endpoints", () => {
  beforeAll(() => {
    resetConfig();
    loadConfig({ PROXY_API_KEY: TEST_API_KEY, GITHUB_OAUTH_TOKEN: TEST_OAUTH_TOKEN });
    setupMockFetch();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    clearSessionTokenCache();
    clearModelCache();
    resetConfig();
  });

  test("GET /healthz → 200", async () => {
    const res = await appFetch("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ok");
  });

  test("GET /readyz → checks session token", async () => {
    const res = await appFetch("/readyz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("ready");
  });

  test("no Authorization header → 401 OpenAI-shaped on OpenAI routes", async () => {
    const res = await appFetch("/v1/models");
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("invalid_api_key");
  });

  test("wrong key → 401", async () => {
    const res = await appFetch("/v1/models", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("Invalid");
  });

  test("wrong-length key also returns 401", async () => {
    const res = await appFetch("/v1/models", {
      headers: { Authorization: "Bearer x" },
    });
    expect(res.status).toBe(401);
  });

  test("correct key → passes through", async () => {
    const res = await appFetch("/v1/models", {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  test("Anthropic route → Anthropic-shaped error on no auth", async () => {
    const res = await appFetch("/anthropic/v1/models");
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
  });

  test("x-api-key header works", async () => {
    const res = await appFetch("/v1/models", {
      headers: { "x-api-key": TEST_API_KEY },
    });
    expect(res.status).toBe(200);
  });
});

describe("Integration: Models endpoints", () => {
  beforeAll(() => {
    resetConfig();
    loadConfig({ PROXY_API_KEY: TEST_API_KEY, GITHUB_OAUTH_TOKEN: TEST_OAUTH_TOKEN });
    setupMockFetch();
    clearModelCache();
    clearSessionTokenCache();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    clearSessionTokenCache();
    clearModelCache();
    resetConfig();
  });

  test("GET /v1/models → OpenAI format", async () => {
    const res = await appFetch("/v1/models", {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("list");
    expect(body.data).toBeArray();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].object).toBe("model");
    expect(body.data[0].owned_by).toBe("github-copilot");
  });

  test("GET /anthropic/v1/models → Anthropic format", async () => {
    const res = await appFetch("/anthropic/v1/models", {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toBeArray();
    expect(body.has_more).toBe(false);
  });
});

describe("Integration: /v1/chat/completions", () => {
  beforeEach(() => {
    resetConfig();
    loadConfig({ PROXY_API_KEY: TEST_API_KEY, GITHUB_OAUTH_TOKEN: TEST_OAUTH_TOKEN });
    setupMockFetch();
    clearModelCache();
    clearSessionTokenCache();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    clearSessionTokenCache();
    clearModelCache();
    resetConfig();
  });

  test("non-stream happy path", async () => {
    const res = await appFetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-2024-05-13",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Hello from mock!");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.prompt_tokens).toBe(15);
  });

  test("stream happy path", async () => {
    const res = await appFetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-2024-05-13",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).toContain("[DONE]");
  });

  test("tool calls path", async () => {
    const res = await appFetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-2024-05-13",
        messages: [{ role: "user", content: "What's the weather?" }],
        tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.choices[0].message.tool_calls).toHaveLength(1);
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    expect(body.choices[0].finish_reason).toBe("tool_calls");
  });

  test("unknown model → 404", async () => {
    const res = await appFetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "nonexistent-model-xyz",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error.code).toBe("model_not_found");
  });
});

describe("Integration: /v1/responses", () => {
  beforeEach(() => {
    resetConfig();
    loadConfig({ PROXY_API_KEY: TEST_API_KEY, GITHUB_OAUTH_TOKEN: TEST_OAUTH_TOKEN });
    setupMockFetch();
    clearModelCache();
    clearSessionTokenCache();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    clearSessionTokenCache();
    clearModelCache();
    resetConfig();
  });

  test("non-stream: output_text present, usage correct", async () => {
    const res = await appFetch("/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-2024-05-13",
        input: "Hello",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe("message");
    expect(body.output[0].content[0].type).toBe("output_text");
    expect(body.output[0].content[0].text).toBe("Hello from mock!");
    expect(body.usage.input_tokens).toBe(15);
    expect(body.usage.output_tokens).toBe(4);
  });

  test("stream: events present", async () => {
    const res = await appFetch("/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-2024-05-13",
        input: "Hello",
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("response.created");
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.completed");
  });

  test("previous_response_id → 400", async () => {
    const res = await appFetch("/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-2024-05-13",
        input: "Hello",
        previous_response_id: "resp_abc",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("invalid_request_error");
  });
});

describe("Integration: /v1/messages (Anthropic)", () => {
  beforeEach(() => {
    resetConfig();
    loadConfig({ PROXY_API_KEY: TEST_API_KEY, GITHUB_OAUTH_TOKEN: TEST_OAUTH_TOKEN });
    setupMockFetch();
    clearModelCache();
    clearSessionTokenCache();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    clearSessionTokenCache();
    clearModelCache();
    resetConfig();
  });

  test("non-stream: content[0].text present, stop_reason, usage", async () => {
    const res = await appFetch("/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3.5-sonnet",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0].type).toBe("text");
    expect(body.content[0].text).toBe("Hello from mock!");
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage.input_tokens).toBe(15);
    expect(body.usage.output_tokens).toBe(4);
  });

  test("stream: Anthropic events present", async () => {
    const res = await appFetch("/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3.5-sonnet",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("message_start");
    expect(text).toContain("content_block_start");
    expect(text).toContain("content_block_delta");
    expect(text).toContain("message_stop");
  });

  test("system prompt as string works", async () => {
    const res = await appFetch("/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3.5-sonnet",
        max_tokens: 1024,
        system: "You are helpful",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(res.status).toBe(200);
  });

  test("system prompt as block array works", async () => {
    const res = await appFetch("/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3.5-sonnet",
        max_tokens: 1024,
        system: [{ type: "text", text: "Rule 1" }, { type: "text", text: "Rule 2" }],
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(res.status).toBe(200);
  });

  test("missing max_tokens → 400", async () => {
    const res = await appFetch("/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3.5-sonnet",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("/anthropic/v1/messages alias works", async () => {
    const res = await appFetch("/anthropic/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3.5-sonnet",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe("Integration: Error surface parity", () => {
  beforeEach(() => {
    resetConfig();
    loadConfig({ PROXY_API_KEY: TEST_API_KEY, GITHUB_OAUTH_TOKEN: TEST_OAUTH_TOKEN });
    clearModelCache();
    clearSessionTokenCache();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    clearSessionTokenCache();
    clearModelCache();
    resetConfig();
  });

  test("upstream 500 → OpenAI 502", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes("copilot_internal/v2/token")) {
        return new Response(JSON.stringify(MOCK_SESSION_TOKEN_RESPONSE), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("mock-copilot.test/models")) {
        return new Response(JSON.stringify(MOCK_MODELS_RESPONSE), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Internal Server Error", { status: 500 });
    }) as any;

    const res = await appFetch("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-2024-05-13", messages: [{ role: "user", content: "Hi" }] }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("upstream_error");
  });

  test("upstream 429 → mapped correctly", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes("copilot_internal/v2/token")) {
        return new Response(JSON.stringify(MOCK_SESSION_TOKEN_RESPONSE), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("mock-copilot.test/models")) {
        return new Response(JSON.stringify(MOCK_MODELS_RESPONSE), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Rate limited", { status: 429 });
    }) as any;

    const res = await appFetch("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-2024-05-13", messages: [{ role: "user", content: "Hi" }] }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("insufficient_quota");
  });
});
