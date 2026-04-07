import { describe, test, expect } from "bun:test";
import { parseSSE, formatSSE } from "../../src/translate/sse.js";

function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function makeChunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("parseSSE", () => {
  test("parses simple data events", async () => {
    const stream = makeStream("data: hello\n\ndata: world\n\n");
    const events = [];
    for await (const event of parseSSE(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0]!.data).toBe("hello");
    expect(events[1]!.data).toBe("world");
  });

  test("parses events with event field", async () => {
    const stream = makeStream("event: message\ndata: hello\n\n");
    const events = [];
    for await (const event of parseSSE(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe("message");
    expect(events[0]!.data).toBe("hello");
  });

  test("handles multi-line data", async () => {
    const stream = makeStream("data: line1\ndata: line2\n\n");
    const events = [];
    for await (const event of parseSSE(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("line1\nline2");
  });

  test("handles comments (: lines)", async () => {
    const stream = makeStream(": this is a comment\ndata: hello\n\n");
    const events = [];
    for await (const event of parseSSE(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("hello");
  });

  test("handles [DONE]", async () => {
    const stream = makeStream("data: {\"id\":\"1\"}\n\ndata: [DONE]\n\n");
    const events = [];
    for await (const event of parseSSE(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[1]!.data).toBe("[DONE]");
  });

  test("handles CRLF line endings", async () => {
    const stream = makeStream("data: hello\r\n\r\ndata: world\r\n\r\n");
    const events = [];
    for await (const event of parseSSE(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0]!.data).toBe("hello");
    expect(events[1]!.data).toBe("world");
  });

  test("handles data split across chunks", async () => {
    const stream = makeChunkedStream(["dat", "a: hel", "lo\n\ndata: wo", "rld\n\n"]);
    const events = [];
    for await (const event of parseSSE(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0]!.data).toBe("hello");
    expect(events[1]!.data).toBe("world");
  });

  test("handles unicode data", async () => {
    const stream = makeStream("data: 你好世界 🌍\n\n");
    const events = [];
    for await (const event of parseSSE(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe("你好世界 🌍");
  });
});

describe("formatSSE", () => {
  test("formats event with event name", () => {
    const result = formatSSE("message", "hello");
    expect(result).toBe("event: message\ndata: hello\n\n");
  });

  test("formats event without event name", () => {
    const result = formatSSE(undefined, "hello");
    expect(result).toBe("data: hello\n\n");
  });

  test("formats multi-line data", () => {
    const result = formatSSE(undefined, "line1\nline2");
    expect(result).toBe("data: line1\ndata: line2\n\n");
  });

  test("produces spec-compliant frames ending in \\n\\n", () => {
    const result = formatSSE("test", "data");
    expect(result.endsWith("\n\n")).toBe(true);
  });
});
