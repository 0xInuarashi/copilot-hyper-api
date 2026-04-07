export interface SSEEvent {
  event?: string;
  data: string;
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      let currentEvent: string | undefined;
      let dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith(":")) {
          continue; // comment
        }

        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        } else if (line === "") {
          if (dataLines.length > 0) {
            const data = dataLines.join("\n");
            if (data === "[DONE]") {
              yield { event: currentEvent, data: "[DONE]" };
            } else {
              yield { event: currentEvent, data };
            }
            dataLines = [];
            currentEvent = undefined;
          }
        }
      }
    }

    // flush remaining
    if (buffer.trim()) {
      const lines = buffer.split(/\r?\n/);
      let currentEvent: string | undefined;
      let dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        } else if (line === "") {
          if (dataLines.length > 0) {
            yield { event: currentEvent, data: dataLines.join("\n") };
            dataLines = [];
            currentEvent = undefined;
          }
        }
      }
      if (dataLines.length > 0) {
        yield { event: currentEvent, data: dataLines.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function formatSSE(event: string | undefined, data: string): string {
  let frame = "";
  if (event) {
    frame += `event: ${event}\n`;
  }
  const lines = data.split("\n");
  for (const line of lines) {
    frame += `data: ${line}\n`;
  }
  frame += "\n";
  return frame;
}

export function writeSSE(controller: ReadableStreamDefaultController, event: string | undefined, data: string): void {
  const frame = formatSSE(event, data);
  controller.enqueue(new TextEncoder().encode(frame));
}
