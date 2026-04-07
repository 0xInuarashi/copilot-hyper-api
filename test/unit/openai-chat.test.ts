import { describe, test, expect } from "bun:test";
import {
  translateChatRequest,
  translateChatResponse,
  InvalidChatRequestError,
} from "../../src/translate/openai-chat.js";

describe("translateChatRequest", () => {
  test("passes through valid request with required fields", () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.7,
    };
    const result = translateChatRequest(body);
    expect(result.model).toBe("gpt-4o");
    expect(result.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(result.temperature).toBe(0.7);
    expect(result.n).toBe(1);
  });

  test("strips unsupported fields", () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      user: "user-123",
      store: true,
      metadata: { foo: "bar" },
      logprobs: true,
      top_logprobs: 5,
      logit_bias: { "123": 1 },
      seed: 42,
      service_tier: "default",
    };
    const result = translateChatRequest(body);
    expect(result).not.toHaveProperty("user");
    expect(result).not.toHaveProperty("store");
    expect(result).not.toHaveProperty("metadata");
    expect(result).not.toHaveProperty("logprobs");
    expect(result).not.toHaveProperty("top_logprobs");
    expect(result).not.toHaveProperty("logit_bias");
    expect(result).not.toHaveProperty("seed");
    expect(result).not.toHaveProperty("service_tier");
  });

  test("force-injects n=1", () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    };
    const result = translateChatRequest(body);
    expect(result.n).toBe(1);
  });

  test("rejects n > 1", () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      n: 3,
    };
    expect(() => translateChatRequest(body)).toThrow(InvalidChatRequestError);
    expect(() => translateChatRequest(body)).toThrow("n > 1 is not supported");
  });

  test("throws on missing messages", () => {
    expect(() => translateChatRequest({ model: "gpt-4o" })).toThrow(InvalidChatRequestError);
    expect(() => translateChatRequest({ model: "gpt-4o" })).toThrow("messages is required");
  });

  test("throws on non-array messages", () => {
    expect(() => translateChatRequest({ model: "gpt-4o", messages: "hello" })).toThrow(InvalidChatRequestError);
  });

  test("preserves tools and tool_choice", () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ type: "function", function: { name: "test", parameters: {} } }],
      tool_choice: "auto",
    };
    const result = translateChatRequest(body);
    expect(result.tools).toEqual(body.tools);
    expect(result.tool_choice).toBe("auto");
  });

  test("preserves response_format", () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      response_format: { type: "json_object" },
    };
    const result = translateChatRequest(body);
    expect(result.response_format).toEqual({ type: "json_object" });
  });

  test("handles empty messages array", () => {
    const body = {
      model: "gpt-4o",
      messages: [],
    };
    const result = translateChatRequest(body);
    expect(result.messages).toEqual([]);
  });

  test("handles messages with null content", () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "assistant", content: null, tool_calls: [] }],
    };
    const result = translateChatRequest(body);
    expect(result.messages[0]!.content).toBeNull();
  });

  test("preserves system message positioning", () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
      ],
    };
    const result = translateChatRequest(body);
    expect(result.messages[0]!.role).toBe("system");
    expect(result.messages[1]!.role).toBe("user");
  });
});

describe("translateChatResponse", () => {
  test("translates simple response", () => {
    const fixture = {
      id: "chatcmpl-abc123",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4o-2024-05-13",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const result = translateChatResponse(fixture);
    expect(result.id).toBe("chatcmpl-abc123");
    expect(result.object).toBe("chat.completion");
    expect(result.choices[0]!.message.content).toBe("Hello!");
    expect(result.choices[0]!.message.role).toBe("assistant");
    expect(result.choices[0]!.finish_reason).toBe("stop");
    expect(result.usage!.prompt_tokens).toBe(10);
    expect(result.usage!.completion_tokens).toBe(5);
    expect(result.usage!.total_tokens).toBe(15);
  });

  test("preserves tool calls in response", () => {
    const fixture = {
      id: "chatcmpl-tools",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "{}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
    };

    const result = translateChatResponse(fixture);
    expect(result.choices[0]!.message.content).toBeNull();
    expect(result.choices[0]!.message.tool_calls).toHaveLength(1);
    expect(result.choices[0]!.message.tool_calls![0]!.function.name).toBe("get_weather");
    expect(result.choices[0]!.finish_reason).toBe("tool_calls");
  });

  test("handles missing usage", () => {
    const fixture = {
      id: "chatcmpl-no-usage",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
    };
    const result = translateChatResponse(fixture);
    expect(result.usage).toBeUndefined();
  });

  test("handles empty choices", () => {
    const fixture = { id: "chatcmpl-empty", choices: [] };
    const result = translateChatResponse(fixture);
    expect(result.choices).toEqual([]);
  });
});
