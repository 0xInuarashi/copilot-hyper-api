import { describe, test, expect } from "bun:test";
import {
  translateAnthropicRequest,
  translateAnthropicResponseBuffered,
  AnthropicStreamMachine,
  InvalidAnthropicRequestError,
} from "../../src/translate/anthropic.js";

describe("translateAnthropicRequest", () => {
  test("system string → system message", () => {
    const { chatBody } = translateAnthropicRequest({
      model: "claude-3.5-sonnet",
      max_tokens: 1024,
      system: "You are a helpful assistant",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(chatBody.messages[0].role).toBe("system");
    expect(chatBody.messages[0].content).toBe("You are a helpful assistant");
    expect(chatBody.messages[1].role).toBe("user");
  });

  test("system block array → collapsed system message", () => {
    const { chatBody } = translateAnthropicRequest({
      model: "claude-3.5-sonnet",
      max_tokens: 1024,
      system: [{ type: "text", text: "Rule 1" }, { type: "text", text: "Rule 2" }],
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(chatBody.messages[0].role).toBe("system");
    expect(chatBody.messages[0].content).toBe("Rule 1\n\nRule 2");
  });

  test("image block with base64 → image_url data URL", () => {
    const { chatBody } = translateAnthropicRequest({
      model: "claude-3.5-sonnet",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What's this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
        ],
      }],
    });
    const userMsg = chatBody.messages[0];
    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content[0].type).toBe("text");
    expect(userMsg.content[1].type).toBe("image_url");
    expect(userMsg.content[1].image_url.url).toBe("data:image/png;base64,abc123");
  });

  test("tool_use in assistant history → tool_calls", () => {
    const { chatBody } = translateAnthropicRequest({
      model: "claude-3.5-sonnet",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_weather",
              input: { city: "SF" },
            },
          ],
        },
      ],
    });
    const assistantMsg = chatBody.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls[0].id).toBe("toolu_1");
    expect(assistantMsg.tool_calls[0].function.name).toBe("get_weather");
  });

  test("tool_result block → role: tool message", () => {
    const { chatBody } = translateAnthropicRequest({
      model: "claude-3.5-sonnet",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "72°F, sunny" },
          ],
        },
      ],
    });
    const toolMsg = chatBody.messages[0];
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toBe("72°F, sunny");
    expect(toolMsg.tool_call_id).toBe("toolu_1");
  });

  test("tool_choice variants all mapped", () => {
    // auto
    const { chatBody: b1 } = translateAnthropicRequest({
      model: "claude-3.5-sonnet", max_tokens: 1024,
      messages: [{ role: "user", content: "Hi" }],
      tool_choice: "auto",
    });
    expect(b1.tool_choice).toBe("auto");

    // any → required
    const { chatBody: b2 } = translateAnthropicRequest({
      model: "claude-3.5-sonnet", max_tokens: 1024,
      messages: [{ role: "user", content: "Hi" }],
      tool_choice: "any",
    });
    expect(b2.tool_choice).toBe("required");

    // specific tool
    const { chatBody: b3 } = translateAnthropicRequest({
      model: "claude-3.5-sonnet", max_tokens: 1024,
      messages: [{ role: "user", content: "Hi" }],
      tool_choice: { type: "tool", name: "get_weather" },
    });
    expect(b3.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
  });

  test("missing max_tokens → throws", () => {
    expect(() =>
      translateAnthropicRequest({
        model: "claude-3.5-sonnet",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ).toThrow(InvalidAnthropicRequestError);
    expect(() =>
      translateAnthropicRequest({
        model: "claude-3.5-sonnet",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ).toThrow("max_tokens is required");
  });

  test("tools mapped to OpenAI format", () => {
    const { chatBody } = translateAnthropicRequest({
      model: "claude-3.5-sonnet",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hi" }],
      tools: [{
        name: "get_weather",
        description: "Get weather for a city",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      }],
    });
    expect(chatBody.tools[0].type).toBe("function");
    expect(chatBody.tools[0].function.name).toBe("get_weather");
    expect(chatBody.tools[0].function.description).toBe("Get weather for a city");
    expect(chatBody.tools[0].function.parameters).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
    });
  });

  test("stop_sequences → stop", () => {
    const { chatBody } = translateAnthropicRequest({
      model: "claude-3.5-sonnet",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hi" }],
      stop_sequences: ["END", "STOP"],
    });
    expect(chatBody.stop).toEqual(["END", "STOP"]);
  });
});

describe("translateAnthropicResponseBuffered", () => {
  test("maps finish_reason correctly", () => {
    const testCases = [
      { finish_reason: "stop", expected: "end_turn" },
      { finish_reason: "length", expected: "max_tokens" },
      { finish_reason: "tool_calls", expected: "tool_use" },
      { finish_reason: "content_filter", expected: "end_turn" },
    ];

    for (const tc of testCases) {
      const result = translateAnthropicResponseBuffered({
        choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: tc.finish_reason }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }, "claude-3.5-sonnet");
      expect(result.stop_reason).toBe(tc.expected);
    }
  });

  test("maps usage correctly", () => {
    const result = translateAnthropicResponseBuffered({
      choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 42, completion_tokens: 17 },
    }, "claude-3.5-sonnet");
    expect(result.usage.input_tokens).toBe(42);
    expect(result.usage.output_tokens).toBe(17);
  });

  test("handles tool calls in response", () => {
    const result = translateAnthropicResponseBuffered({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "{\"city\":\"SF\"}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 50, completion_tokens: 25 },
    }, "claude-3.5-sonnet");

    const toolBlock = result.content.find((b: any) => b.type === "tool_use");
    expect(toolBlock).toBeDefined();
    expect(toolBlock.name).toBe("get_weather");
    expect(toolBlock.input).toEqual({ city: "SF" });
  });

  test("response structure matches Anthropic format", () => {
    const result = translateAnthropicResponseBuffered({
      choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }, "claude-3.5-sonnet");

    expect(result.id).toMatch(/^msg_/);
    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    expect(result.model).toBe("claude-3.5-sonnet");
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("Hello!");
    expect(result.stop_reason).toBe("end_turn");
    expect(result.stop_sequence).toBeNull();
  });
});

describe("AnthropicStreamMachine", () => {
  test("text-only stream → correct event sequence", () => {
    const machine = new AnthropicStreamMachine("claude-3.5-sonnet");

    // First chunk
    const events1 = machine.processChunk({
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    });
    expect(events1.some((e) => e.includes("message_start"))).toBe(true);

    // Text delta
    const events2 = machine.processChunk({
      choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
    });
    expect(events2.some((e) => e.includes("content_block_start"))).toBe(true);
    expect(events2.some((e) => e.includes("content_block_delta"))).toBe(true);
    expect(events2.some((e) => e.includes("text_delta"))).toBe(true);

    // More text
    const events3 = machine.processChunk({
      choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
    });
    expect(events3.some((e) => e.includes("content_block_delta"))).toBe(true);

    // Finish
    const events4 = machine.processChunk({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(events4.some((e) => e.includes("content_block_stop"))).toBe(true);
    expect(events4.some((e) => e.includes("message_delta"))).toBe(true);
    expect(events4.some((e) => e.includes("message_stop"))).toBe(true);

    // Check message_delta has stop_reason
    const messageDelta = events4.find((e) => e.includes("message_delta"));
    expect(messageDelta).toContain("end_turn");
  });

  test("mixed text + tool_use: correct index assignment", () => {
    const machine = new AnthropicStreamMachine("claude-3.5-sonnet");

    // Setup
    machine.processChunk({
      choices: [{ index: 0, delta: { role: "assistant", content: "Let me check" }, finish_reason: null }],
    });

    // Tool call start
    const events = machine.processChunk({
      choices: [{
        index: 0,
        delta: {
          content: null,
          tool_calls: [{
            index: 0,
            id: "toolu_1",
            type: "function",
            function: { name: "get_weather", arguments: "" },
          }],
        },
        finish_reason: null,
      }],
    });

    // Text block should be index 0, tool block should be index 1
    const toolStart = events.find((e) => e.includes("content_block_start") && e.includes("tool_use"));
    expect(toolStart).toBeDefined();
    expect(toolStart).toContain('"index":1');
  });

  test("input_json_delta forwarding for partial tool-call JSON", () => {
    const machine = new AnthropicStreamMachine("claude-3.5-sonnet");

    machine.processChunk({
      choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
    });

    // Tool call
    machine.processChunk({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0, id: "toolu_1", type: "function",
            function: { name: "get_weather", arguments: "" },
          }],
        },
        finish_reason: null,
      }],
    });

    // Partial arguments
    const events = machine.processChunk({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: "{\"city\":" } }] },
        finish_reason: null,
      }],
    });
    expect(events.some((e) => e.includes("input_json_delta"))).toBe(true);
    expect(events.some((e) => e.includes("city"))).toBe(true);
  });

  test("final message_delta carries correct stop_reason and usage", () => {
    const machine = new AnthropicStreamMachine("claude-3.5-sonnet");

    machine.processChunk({
      choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }],
    });

    const events = machine.processChunk({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });

    const messageDelta = events.find((e) => e.includes("message_delta"));
    expect(messageDelta).toBeDefined();
    const data = JSON.parse(messageDelta!.split("data: ")[1]!.split("\n")[0]!);
    expect(data.delta.stop_reason).toBe("end_turn");
    expect(data.usage.output_tokens).toBe(2);
  });
});
