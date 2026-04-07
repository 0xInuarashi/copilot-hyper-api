import { describe, test, expect } from "bun:test";
import { translateResponsesBuffered, ResponsesStreamMachine } from "../../src/translate/openai-responses.js";
import { translateAnthropicResponseBuffered, AnthropicStreamMachine } from "../../src/translate/anthropic.js";
import { parseSSE } from "../../src/translate/sse.js";
import { readFileSync } from "fs";
import { join } from "path";

const fixturesDir = join(import.meta.dir, "../fixtures/copilot");

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf-8"));
}

function loadSSEFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf-8");
}

function makeStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("Contract: OpenAI Responses from Chat Completions", () => {
  test("simple chat → Responses format", () => {
    const fixture = loadFixture("chat.simple.json");
    const result = translateResponsesBuffered(fixture, "gpt-4o-2024-05-13");

    expect(result.object).toBe("response");
    expect(result.status).toBe("completed");
    expect(result.model).toBe("gpt-4o-2024-05-13");
    expect(result.output).toHaveLength(1);
    expect(result.output[0].type).toBe("message");
    expect(result.output[0].content[0].type).toBe("output_text");
    expect(result.output[0].content[0].text).toBe("Hello! How can I help you today?");
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(8);
  });

  test("tool calls chat → Responses format", () => {
    const fixture = loadFixture("chat.tools.json");
    const result = translateResponsesBuffered(fixture, "gpt-4o-2024-05-13");

    expect(result.output).toHaveLength(1);
    expect(result.output[0].type).toBe("function_call");
    expect(result.output[0].name).toBe("get_weather");
    expect(result.output[0].arguments).toContain("San Francisco");
  });

  test("streaming chat → Responses events with correct sequence", async () => {
    const sseText = loadSSEFixture("chat.stream.simple.sse");
    const stream = makeStream(sseText);
    const machine = new ResponsesStreamMachine("gpt-4o-2024-05-13");

    const allFrames: string[] = [];
    for await (const event of parseSSE(stream)) {
      if (event.data === "[DONE]") break;
      try {
        const parsed = JSON.parse(event.data);
        allFrames.push(...machine.processChunk(parsed));
      } catch {}
    }

    // Verify event sequence
    expect(allFrames.some((f) => f.includes("response.created"))).toBe(true);
    expect(allFrames.some((f) => f.includes("response.in_progress"))).toBe(true);
    expect(allFrames.some((f) => f.includes("response.output_item.added"))).toBe(true);
    expect(allFrames.some((f) => f.includes("response.content_part.added"))).toBe(true);
    expect(allFrames.some((f) => f.includes("response.output_text.delta"))).toBe(true);
    expect(allFrames.some((f) => f.includes("response.output_text.done"))).toBe(true);
    expect(allFrames.some((f) => f.includes("response.content_part.done"))).toBe(true);
    expect(allFrames.some((f) => f.includes("response.output_item.done"))).toBe(true);
    expect(allFrames.some((f) => f.includes("response.completed"))).toBe(true);

    // Verify sequence numbers are monotonic
    const seqNums: number[] = [];
    for (const frame of allFrames) {
      const match = frame.match(/"sequence_number":(\d+)/);
      if (match) seqNums.push(parseInt(match[1]!));
    }
    for (let i = 1; i < seqNums.length; i++) {
      expect(seqNums[i]).toBeGreaterThan(seqNums[i - 1]!);
    }

    // Every *.delta should have a matching *.done
    const hasTextDelta = allFrames.some((f) => f.includes("response.output_text.delta"));
    const hasTextDone = allFrames.some((f) => f.includes("response.output_text.done"));
    expect(hasTextDelta).toBe(hasTextDone);
  });

  test("tool call streaming → function_call events", async () => {
    const sseText = loadSSEFixture("chat.stream.tools.sse");
    const stream = makeStream(sseText);
    const machine = new ResponsesStreamMachine("gpt-4o-2024-05-13");

    const allFrames: string[] = [];
    for await (const event of parseSSE(stream)) {
      if (event.data === "[DONE]") break;
      try {
        const parsed = JSON.parse(event.data);
        allFrames.push(...machine.processChunk(parsed));
      } catch {}
    }

    expect(allFrames.some((f) => f.includes("function_call"))).toBe(true);
    expect(allFrames.some((f) => f.includes("response.function_call_arguments.delta"))).toBe(true);
    expect(allFrames.some((f) => f.includes("response.function_call_arguments.done"))).toBe(true);
    expect(allFrames.some((f) => f.includes("response.completed"))).toBe(true);
  });
});

describe("Contract: Anthropic Messages from Chat Completions", () => {
  test("simple chat → Anthropic format", () => {
    const fixture = loadFixture("chat.simple.json");
    const result = translateAnthropicResponseBuffered(fixture, "claude-3.5-sonnet");

    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    expect(result.model).toBe("claude-3.5-sonnet");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("Hello! How can I help you today?");
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(8);
  });

  test("tool calls chat → Anthropic tool_use format", () => {
    const fixture = loadFixture("chat.tools.json");
    const result = translateAnthropicResponseBuffered(fixture, "claude-3.5-sonnet");

    expect(result.stop_reason).toBe("tool_use");
    const toolBlock = result.content.find((b: any) => b.type === "tool_use");
    expect(toolBlock).toBeDefined();
    expect(toolBlock.name).toBe("get_weather");
    expect(toolBlock.input.location).toBe("San Francisco");
  });

  test("streaming chat → Anthropic events with correct sequence", async () => {
    const sseText = loadSSEFixture("chat.stream.simple.sse");
    const stream = makeStream(sseText);
    const machine = new AnthropicStreamMachine("claude-3.5-sonnet");

    const allFrames: string[] = [];
    for await (const event of parseSSE(stream)) {
      if (event.data === "[DONE]") break;
      try {
        const parsed = JSON.parse(event.data);
        allFrames.push(...machine.processChunk(parsed));
      } catch {}
    }

    // Verify correct event sequence
    const eventTypes = allFrames.map((f) => {
      const match = f.match(/event: (\S+)/);
      return match ? match[1] : null;
    }).filter(Boolean);

    expect(eventTypes[0]).toBe("message_start");
    expect(eventTypes).toContain("content_block_start");
    expect(eventTypes).toContain("content_block_delta");
    expect(eventTypes).toContain("content_block_stop");
    expect(eventTypes).toContain("message_delta");
    expect(eventTypes[eventTypes.length - 1]).toBe("message_stop");
  });

  test("Anthropic stream: event types are in allowed set", async () => {
    const sseText = loadSSEFixture("chat.stream.simple.sse");
    const stream = makeStream(sseText);
    const machine = new AnthropicStreamMachine("claude-3.5-sonnet");

    const allFrames: string[] = [];
    for await (const event of parseSSE(stream)) {
      if (event.data === "[DONE]") break;
      try {
        allFrames.push(...machine.processChunk(JSON.parse(event.data)));
      } catch {}
    }

    const allowedEvents = new Set([
      "message_start", "content_block_start", "content_block_delta",
      "content_block_stop", "message_delta", "message_stop", "ping",
    ]);

    for (const frame of allFrames) {
      const match = frame.match(/event: (\S+)/);
      if (match) {
        expect(allowedEvents.has(match[1]!)).toBe(true);
      }
    }
  });

  test("Anthropic stream: message_start has usage.input_tokens", async () => {
    const sseText = loadSSEFixture("chat.stream.simple.sse");
    const stream = makeStream(sseText);
    const machine = new AnthropicStreamMachine("claude-3.5-sonnet");

    const allFrames: string[] = [];
    for await (const event of parseSSE(stream)) {
      if (event.data === "[DONE]") break;
      try {
        allFrames.push(...machine.processChunk(JSON.parse(event.data)));
      } catch {}
    }

    const messageStart = allFrames.find((f) => f.includes("message_start"));
    expect(messageStart).toBeDefined();
    const data = JSON.parse(messageStart!.split("data: ")[1]!.split("\n")[0]!);
    expect(data.message.usage).toBeDefined();
    expect(typeof data.message.usage.input_tokens).toBe("number");
  });

  test("mixed text + tool stream: monotonic content-block indices", async () => {
    const sseText = loadSSEFixture("chat.stream.multi.sse");
    const stream = makeStream(sseText);
    const machine = new AnthropicStreamMachine("claude-3.5-sonnet");

    const allFrames: string[] = [];
    for await (const event of parseSSE(stream)) {
      if (event.data === "[DONE]") break;
      try {
        allFrames.push(...machine.processChunk(JSON.parse(event.data)));
      } catch {}
    }

    const indices: number[] = [];
    for (const frame of allFrames) {
      if (frame.includes("content_block_start")) {
        const data = JSON.parse(frame.split("data: ")[1]!.split("\n")[0]!);
        indices.push(data.index);
      }
    }

    // Indices should be monotonically increasing
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
    }
  });
});
