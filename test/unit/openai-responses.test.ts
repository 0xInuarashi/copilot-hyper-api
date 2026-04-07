import { describe, test, expect } from "bun:test";
import {
  translateResponsesRequest,
  translateResponsesBuffered,
  ResponsesStreamMachine,
  InvalidResponsesRequestError,
} from "../../src/translate/openai-responses.js";

describe("translateResponsesRequest", () => {
  test("bare string input → single user message", () => {
    const { chatBody } = translateResponsesRequest({
      model: "gpt-4o",
      input: "Hello",
    });
    expect(chatBody.messages).toHaveLength(1);
    expect(chatBody.messages[0].role).toBe("user");
    expect(chatBody.messages[0].content).toBe("Hello");
  });

  test("instructions → leading system message", () => {
    const { chatBody } = translateResponsesRequest({
      model: "gpt-4o",
      input: "Hello",
      instructions: "You are a helpful assistant",
    });
    expect(chatBody.messages[0].role).toBe("system");
    expect(chatBody.messages[0].content).toBe("You are a helpful assistant");
    expect(chatBody.messages[1].role).toBe("user");
  });

  test("multimodal input_text + input_image → content parts", () => {
    const { chatBody } = translateResponsesRequest({
      model: "gpt-4o",
      input: [
        { type: "input_text", text: "What's this?" },
        { type: "input_image", image_url: { url: "data:image/png;base64,abc" } },
      ],
    });
    expect(chatBody.messages[0].role).toBe("user");
    expect(chatBody.messages[0].content).toHaveLength(2);
    expect(chatBody.messages[0].content[0].type).toBe("text");
    expect(chatBody.messages[0].content[1].type).toBe("image_url");
  });

  test("array of messages with role", () => {
    const { chatBody } = translateResponsesRequest({
      model: "gpt-4o",
      input: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "How are you?" },
      ],
    });
    expect(chatBody.messages).toHaveLength(3);
    expect(chatBody.messages[0].role).toBe("user");
    expect(chatBody.messages[2].role).toBe("user");
  });

  test("previous_response_id → throws InvalidResponsesRequestError", () => {
    expect(() =>
      translateResponsesRequest({
        model: "gpt-4o",
        input: "Hello",
        previous_response_id: "resp_abc",
      }),
    ).toThrow(InvalidResponsesRequestError);
    expect(() =>
      translateResponsesRequest({
        model: "gpt-4o",
        input: "Hello",
        previous_response_id: "resp_abc",
      }),
    ).toThrow("previous_response_id is not supported");
  });

  test("max_output_tokens → max_tokens", () => {
    const { chatBody } = translateResponsesRequest({
      model: "gpt-4o",
      input: "Hello",
      max_output_tokens: 1000,
    });
    expect(chatBody.max_tokens).toBe(1000);
    expect(chatBody).not.toHaveProperty("max_output_tokens");
  });

  test("passes through tools and tool_choice", () => {
    const { chatBody } = translateResponsesRequest({
      model: "gpt-4o",
      input: "Hello",
      tools: [{ type: "function", function: { name: "test" } }],
      tool_choice: "auto",
    });
    expect(chatBody.tools).toHaveLength(1);
    expect(chatBody.tool_choice).toBe("auto");
  });

  test("passes temperature and top_p", () => {
    const { chatBody } = translateResponsesRequest({
      model: "gpt-4o",
      input: "Hello",
      temperature: 0.5,
      top_p: 0.9,
    });
    expect(chatBody.temperature).toBe(0.5);
    expect(chatBody.top_p).toBe(0.9);
  });
});

describe("translateResponsesBuffered", () => {
  test("builds correct response structure", () => {
    const chatResponse = {
      id: "chatcmpl-abc",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const result = translateResponsesBuffered(chatResponse, "gpt-4o");
    expect(result.id).toMatch(/^resp_/);
    expect(result.object).toBe("response");
    expect(result.status).toBe("completed");
    expect(result.output).toHaveLength(1);
    expect(result.output[0].type).toBe("message");
    expect(result.output[0].role).toBe("assistant");
    expect(result.output[0].content[0].type).toBe("output_text");
    expect(result.output[0].content[0].text).toBe("Hello!");
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
  });

  test("handles tool calls in response", () => {
    const chatResponse = {
      choices: [{
        index: 0,
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
      usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 },
    };

    const result = translateResponsesBuffered(chatResponse, "gpt-4o");
    expect(result.output).toHaveLength(1);
    expect(result.output[0].type).toBe("function_call");
    expect(result.output[0].name).toBe("get_weather");
    expect(result.output[0].arguments).toBe("{\"city\":\"SF\"}");
  });
});

describe("ResponsesStreamMachine", () => {
  test("emits correct text-only event sequence", () => {
    const machine = new ResponsesStreamMachine("gpt-4o");

    // First chunk
    const events1 = machine.processChunk({
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    });
    expect(events1.length).toBeGreaterThanOrEqual(2);
    expect(events1[0]).toContain("response.created");
    expect(events1[1]).toContain("response.in_progress");

    // Text delta
    const events2 = machine.processChunk({
      choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
    });
    expect(events2.some((e) => e.includes("response.output_item.added"))).toBe(true);
    expect(events2.some((e) => e.includes("response.content_part.added"))).toBe(true);
    expect(events2.some((e) => e.includes("response.output_text.delta"))).toBe(true);

    // More deltas
    const events3 = machine.processChunk({
      choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
    });
    expect(events3.some((e) => e.includes("response.output_text.delta"))).toBe(true);

    // Finish
    const events4 = machine.processChunk({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(events4.some((e) => e.includes("response.output_text.done"))).toBe(true);
    expect(events4.some((e) => e.includes("response.content_part.done"))).toBe(true);
    expect(events4.some((e) => e.includes("response.output_item.done"))).toBe(true);
    expect(events4.some((e) => e.includes("response.completed"))).toBe(true);
  });

  test("sequence_number is strictly increasing and gap-free", () => {
    const machine = new ResponsesStreamMachine("gpt-4o");
    const allFrames: string[] = [];

    allFrames.push(...machine.processChunk({
      choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }],
    }));
    allFrames.push(...machine.processChunk({
      choices: [{ index: 0, delta: { content: "!" }, finish_reason: null }],
    }));
    allFrames.push(...machine.processChunk({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }));

    const seqNums: number[] = [];
    for (const frame of allFrames) {
      const match = frame.match(/"sequence_number":(\d+)/);
      if (match) {
        seqNums.push(parseInt(match[1]!));
      }
    }

    // Should be monotonically increasing starting at 0
    for (let i = 0; i < seqNums.length; i++) {
      expect(seqNums[i]).toBe(i);
    }
  });

  test("tool call path emits correct events", () => {
    const machine = new ResponsesStreamMachine("gpt-4o");

    // First chunk with tool call start
    machine.processChunk({
      choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
    });

    const events2 = machine.processChunk({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "" },
          }],
        },
        finish_reason: null,
      }],
    });
    expect(events2.some((e) => e.includes("response.output_item.added"))).toBe(true);
    expect(events2.some((e) => e.includes("function_call"))).toBe(true);

    // Arguments delta
    const events3 = machine.processChunk({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: "{\"city\":" } }] },
        finish_reason: null,
      }],
    });
    expect(events3.some((e) => e.includes("response.function_call_arguments.delta"))).toBe(true);

    // More arguments
    machine.processChunk({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: "\"SF\"}" } }] },
        finish_reason: null,
      }],
    });

    // Finish
    const events5 = machine.processChunk({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    });
    expect(events5.some((e) => e.includes("response.function_call_arguments.done"))).toBe(true);
    expect(events5.some((e) => e.includes("response.output_item.done"))).toBe(true);
    expect(events5.some((e) => e.includes("response.completed"))).toBe(true);
  });
});
