import { nanoid } from "nanoid";
import type { ChatMessage, ContentPart } from "./openai-chat.js";
import { formatSSE } from "./sse.js";

export class InvalidResponsesRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidResponsesRequestError";
  }
}

export function translateResponsesRequest(body: any): {
  chatBody: any;
  model: string;
} {
  if (body.previous_response_id) {
    throw new InvalidResponsesRequestError(
      "previous_response_id is not supported (no server-side state). Send the full conversation in `input`.",
    );
  }

  const messages: ChatMessage[] = [];

  // instructions → system message
  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }

  // input → messages
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    // Could be an array of content parts or array of messages
    if (input.length > 0 && input[0].role) {
      // Array of messages
      for (const msg of input) {
        messages.push(translateResponsesMessage(msg));
      }
    } else {
      // Array of content parts
      const parts = input.map(translateResponsesContentPart);
      messages.push({ role: "user", content: parts });
    }
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }

  const chatBody: any = {
    model: body.model,
    messages,
    stream: body.stream ?? false,
    n: 1,
  };

  if (body.max_output_tokens !== undefined) {
    chatBody.max_tokens = body.max_output_tokens;
  }
  if (body.temperature !== undefined) {
    chatBody.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    chatBody.top_p = body.top_p;
  }
  if (body.stop !== undefined) {
    chatBody.stop = body.stop;
  }
  if (body.tools) {
    chatBody.tools = body.tools;
  }
  if (body.tool_choice) {
    chatBody.tool_choice = body.tool_choice;
  }

  return { chatBody, model: body.model };
}

function translateResponsesMessage(msg: any): ChatMessage {
  if (msg.type === "message" || msg.role) {
    const role = msg.role ?? "user";
    if (typeof msg.content === "string") {
      return { role, content: msg.content };
    }
    if (Array.isArray(msg.content)) {
      const parts = msg.content.map(translateResponsesContentPart);
      return { role, content: parts };
    }
    return { role, content: msg.content ?? "" };
  }
  return { role: "user", content: JSON.stringify(msg) };
}

function translateResponsesContentPart(part: any): ContentPart {
  if (part.type === "input_text" || part.type === "text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "input_image") {
    const url = part.image_url?.url ?? `data:${part.media_type ?? "image/png"};base64,${part.data}`;
    return { type: "image_url", image_url: { url, detail: part.detail } };
  }
  if (part.type === "image_url") {
    return part;
  }
  return { type: "text", text: part.text ?? JSON.stringify(part) };
}

export function translateResponsesBuffered(chatResponse: any, model: string): any {
  const responseId = `resp_${nanoid()}`;
  const choice = chatResponse.choices?.[0];
  const message = choice?.message;

  const output: any[] = [];

  if (message) {
    const content: any[] = [];

    if (message.content) {
      content.push({
        type: "output_text",
        text: message.content,
        annotations: [],
      });
    }

    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        output.push({
          type: "function_call",
          id: tc.id,
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
          status: "completed",
        });
      }
    }

    if (content.length > 0) {
      output.unshift({
        type: "message",
        id: `msg_${nanoid()}`,
        role: "assistant",
        status: "completed",
        content,
      });
    }
  }

  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    output,
    status: "completed",
    usage: chatResponse.usage
      ? {
          input_tokens: chatResponse.usage.prompt_tokens ?? 0,
          output_tokens: chatResponse.usage.completion_tokens ?? 0,
          total_tokens: chatResponse.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

// State machine for streaming Responses events from Chat Completions deltas
export class ResponsesStreamMachine {
  private sequenceNumber = 0;
  private responseId: string;
  private model: string;
  private events: string[] = [];
  private messageId: string;
  private started = false;
  private contentStarted = false;
  private currentToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
  private usage: any = null;

  constructor(model: string) {
    this.responseId = `resp_${nanoid()}`;
    this.messageId = `msg_${nanoid()}`;
    this.model = model;
  }

  private emit(event: string, data: any): string {
    const eventData = { ...data, sequence_number: this.sequenceNumber++ };
    return formatSSE(event, JSON.stringify(eventData));
  }

  processChunk(delta: any): string[] {
    const frames: string[] = [];
    const choice = delta.choices?.[0];

    if (!this.started) {
      this.started = true;
      const responseObj = {
        id: this.responseId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: this.model,
        output: [],
        status: "in_progress",
      };
      frames.push(this.emit("response.created", { response: responseObj }));
      frames.push(this.emit("response.in_progress", { response: responseObj }));
    }

    if (!choice) {
      if (delta.usage) {
        this.usage = delta.usage;
      }
      return frames;
    }

    const d = choice.delta;

    // Handle text content
    if (d?.content) {
      if (!this.contentStarted) {
        this.contentStarted = true;
        frames.push(
          this.emit("response.output_item.added", {
            output_index: 0,
            item: {
              type: "message",
              id: this.messageId,
              role: "assistant",
              status: "in_progress",
              content: [],
            },
          }),
        );
        frames.push(
          this.emit("response.content_part.added", {
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }),
        );
      }

      frames.push(
        this.emit("response.output_text.delta", {
          output_index: 0,
          content_index: 0,
          delta: d.content,
        }),
      );
    }

    // Handle tool calls
    if (d?.tool_calls) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        if (!this.currentToolCalls.has(idx)) {
          this.currentToolCalls.set(idx, {
            id: tc.id ?? `call_${nanoid()}`,
            name: tc.function?.name ?? "",
            arguments: "",
          });

          const outputIndex = this.contentStarted ? idx + 1 : idx;
          frames.push(
            this.emit("response.output_item.added", {
              output_index: outputIndex,
              item: {
                type: "function_call",
                id: tc.id,
                call_id: tc.id,
                name: tc.function?.name ?? "",
                arguments: "",
                status: "in_progress",
              },
            }),
          );
        }

        if (tc.function?.arguments) {
          const existing = this.currentToolCalls.get(idx)!;
          existing.arguments += tc.function.arguments;
          const outputIndex = this.contentStarted ? idx + 1 : idx;
          frames.push(
            this.emit("response.function_call_arguments.delta", {
              output_index: outputIndex,
              delta: tc.function.arguments,
            }),
          );
        }
      }
    }

    // Handle finish
    if (choice.finish_reason) {
      if (delta.usage) {
        this.usage = delta.usage;
      }

      if (this.contentStarted) {
        frames.push(
          this.emit("response.output_text.done", {
            output_index: 0,
            content_index: 0,
            text: "",
          }),
        );
        frames.push(
          this.emit("response.content_part.done", {
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          }),
        );
        frames.push(
          this.emit("response.output_item.done", {
            output_index: 0,
            item: {
              type: "message",
              id: this.messageId,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "", annotations: [] }],
            },
          }),
        );
      }

      // Close tool calls
      for (const [idx, tc] of this.currentToolCalls) {
        const outputIndex = this.contentStarted ? idx + 1 : idx;
        frames.push(
          this.emit("response.function_call_arguments.done", {
            output_index: outputIndex,
            arguments: tc.arguments,
          }),
        );
        frames.push(
          this.emit("response.output_item.done", {
            output_index: outputIndex,
            item: {
              type: "function_call",
              id: tc.id,
              call_id: tc.id,
              name: tc.name,
              arguments: tc.arguments,
              status: "completed",
            },
          }),
        );
      }

      const responseObj = {
        id: this.responseId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: this.model,
        output: [],
        status: "completed",
        usage: this.usage
          ? {
              input_tokens: this.usage.prompt_tokens ?? 0,
              output_tokens: this.usage.completion_tokens ?? 0,
              total_tokens: this.usage.total_tokens ?? 0,
            }
          : undefined,
      };
      frames.push(this.emit("response.completed", { response: responseObj }));
    }

    return frames;
  }

  getResponseId(): string {
    return this.responseId;
  }

  getUsage(): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
    return {
      prompt_tokens: this.usage?.prompt_tokens ?? 0,
      completion_tokens: this.usage?.completion_tokens ?? 0,
      total_tokens: this.usage?.total_tokens ?? 0,
    };
  }

  getFinishReason(): string | null {
    return null; // Responses API doesn't expose finish_reason per-item
  }

  getToolCallsCount(): number {
    return this.currentToolCalls.size;
  }
}
