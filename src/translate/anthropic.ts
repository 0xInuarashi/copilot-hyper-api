import { nanoid } from "nanoid";
import type { ChatMessage, ContentPart, ToolCall } from "./openai-chat.js";
import { formatSSE } from "./sse.js";

export class InvalidAnthropicRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAnthropicRequestError";
  }
}

export function translateAnthropicRequest(body: any): {
  chatBody: any;
  model: string;
} {
  if (body.max_tokens === undefined) {
    throw new InvalidAnthropicRequestError("max_tokens is required");
  }

  const messages: ChatMessage[] = [];

  // system → system message
  if (body.system) {
    if (typeof body.system === "string") {
      messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      const text = body.system
        .map((block: any) => (typeof block === "string" ? block : block.text ?? ""))
        .join("\n\n");
      messages.push({ role: "system", content: text });
    }
  }

  // messages → chat messages
  if (body.messages) {
    for (const msg of body.messages) {
      messages.push(...translateAnthropicMessage(msg));
    }
  }

  const chatBody: any = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    stream: body.stream ?? false,
    n: 1,
  };

  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;
  if (body.stop_sequences) chatBody.stop = body.stop_sequences;

  // tools
  if (body.tools) {
    chatBody.tools = body.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema ?? {},
      },
    }));
  }

  // tool_choice
  if (body.tool_choice) {
    if (body.tool_choice === "auto") {
      chatBody.tool_choice = "auto";
    } else if (body.tool_choice === "any") {
      chatBody.tool_choice = "required";
    } else if (body.tool_choice?.type === "tool") {
      chatBody.tool_choice = {
        type: "function",
        function: { name: body.tool_choice.name },
      };
    } else if (typeof body.tool_choice === "object" && body.tool_choice.type === "auto") {
      chatBody.tool_choice = "auto";
    } else if (typeof body.tool_choice === "object" && body.tool_choice.type === "any") {
      chatBody.tool_choice = "required";
    }
  }

  return { chatBody, model: body.model };
}

function translateAnthropicMessage(msg: any): ChatMessage[] {
  const role = msg.role;

  if (typeof msg.content === "string") {
    return [{ role, content: msg.content }];
  }

  if (!Array.isArray(msg.content)) {
    return [{ role, content: msg.content ?? "" }];
  }

  const result: ChatMessage[] = [];
  const contentParts: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResults: ChatMessage[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      contentParts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const mediaType = block.source?.media_type ?? "image/png";
      const data = block.source?.data ?? "";
      contentParts.push({
        type: "image_url",
        image_url: { url: `data:${mediaType};base64,${data}` },
      });
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
        },
      });
    } else if (block.type === "tool_result") {
      let content = "";
      if (typeof block.content === "string") {
        content = block.content;
      } else if (Array.isArray(block.content)) {
        content = block.content
          .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
          .join("\n");
      }
      toolResults.push({
        role: "tool",
        content,
        tool_call_id: block.tool_use_id,
      });
    }
  }

  if (role === "assistant") {
    if (contentParts.length > 0 || toolCalls.length > 0) {
      const msg: ChatMessage = {
        role: "assistant",
        content: contentParts.length === 1 && contentParts[0]!.type === "text"
          ? contentParts[0]!.text!
          : contentParts.length > 0
            ? contentParts
            : null,
      };
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }
      result.push(msg);
    }
  } else if (role === "user") {
    if (toolResults.length > 0) {
      result.push(...toolResults);
    }
    if (contentParts.length > 0) {
      result.push({ role: "user", content: contentParts.length === 1 && contentParts[0]!.type === "text" ? contentParts[0]!.text! : contentParts });
    }
    if (result.length === 0 && toolResults.length === 0) {
      result.push({ role: "user", content: "" });
    }
  }

  return result;
}

function mapFinishReason(reason: string | null): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}

export function translateAnthropicResponseBuffered(chatResponse: any, model: string): any {
  const choice = chatResponse.choices?.[0];
  const message = choice?.message;
  const msgId = `msg_${nanoid()}`;

  const content: any[] = [];

  if (message?.content) {
    content.push({ type: "text", text: message.content });
  }

  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: safeParseJSON(tc.function.arguments),
      });
    }
  }

  return {
    id: msgId,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: chatResponse.usage?.prompt_tokens ?? 0,
      output_tokens: chatResponse.usage?.completion_tokens ?? 0,
    },
  };
}

function safeParseJSON(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

// State machine for streaming Anthropic events from Chat Completions deltas
export class AnthropicStreamMachine {
  private messageId: string;
  private model: string;
  private started = false;
  private contentBlockIndex = 0;
  private currentBlockStarted = false;
  private currentToolCalls: Map<number, { id: string; name: string; arguments: string; blockIndex: number }> = new Map();
  private hasTextBlock = false;
  private textBlockIndex = -1;
  private usage = { input_tokens: 0, output_tokens: 0 };
  private finishReason: string = "end_turn";

  constructor(model: string) {
    this.messageId = `msg_${nanoid()}`;
    this.model = model;
  }

  processChunk(delta: any): string[] {
    const frames: string[] = [];
    const choice = delta.choices?.[0];

    if (!this.started) {
      this.started = true;
      frames.push(
        formatSSE("message_start", JSON.stringify({
          type: "message_start",
          message: {
            id: this.messageId,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: delta.usage?.prompt_tokens ?? 0, output_tokens: 0 },
          },
        })),
      );
    }

    if (!choice) {
      if (delta.usage) {
        this.usage = {
          input_tokens: delta.usage.prompt_tokens ?? 0,
          output_tokens: delta.usage.completion_tokens ?? 0,
        };
      }
      return frames;
    }

    const d = choice.delta;

    // Handle text content
    if (d?.content) {
      if (!this.hasTextBlock) {
        this.hasTextBlock = true;
        this.textBlockIndex = this.contentBlockIndex++;
        frames.push(
          formatSSE("content_block_start", JSON.stringify({
            type: "content_block_start",
            index: this.textBlockIndex,
            content_block: { type: "text", text: "" },
          })),
        );
      }

      frames.push(
        formatSSE("content_block_delta", JSON.stringify({
          type: "content_block_delta",
          index: this.textBlockIndex,
          delta: { type: "text_delta", text: d.content },
        })),
      );
    }

    // Handle tool calls
    if (d?.tool_calls) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;

        if (!this.currentToolCalls.has(idx)) {
          // Close text block if open and this is the first tool call
          if (this.hasTextBlock && this.currentToolCalls.size === 0 && !this.currentBlockStarted) {
            frames.push(
              formatSSE("content_block_stop", JSON.stringify({
                type: "content_block_stop",
                index: this.textBlockIndex,
              })),
            );
            this.currentBlockStarted = true;
          }

          const blockIndex = this.contentBlockIndex++;
          this.currentToolCalls.set(idx, {
            id: tc.id ?? `toolu_${nanoid()}`,
            name: tc.function?.name ?? "",
            arguments: "",
            blockIndex,
          });

          frames.push(
            formatSSE("content_block_start", JSON.stringify({
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: tc.id ?? `toolu_${nanoid()}`,
                name: tc.function?.name ?? "",
                input: {},
              },
            })),
          );
        }

        if (tc.function?.arguments) {
          const existing = this.currentToolCalls.get(idx)!;
          existing.arguments += tc.function.arguments;

          frames.push(
            formatSSE("content_block_delta", JSON.stringify({
              type: "content_block_delta",
              index: existing.blockIndex,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            })),
          );
        }
      }
    }

    // Handle finish
    if (choice.finish_reason) {
      this.finishReason = mapFinishReason(choice.finish_reason);

      if (delta.usage) {
        this.usage = {
          input_tokens: delta.usage.prompt_tokens ?? 0,
          output_tokens: delta.usage.completion_tokens ?? 0,
        };
      }

      // Close text block if still open
      if (this.hasTextBlock && !this.currentBlockStarted) {
        frames.push(
          formatSSE("content_block_stop", JSON.stringify({
            type: "content_block_stop",
            index: this.textBlockIndex,
          })),
        );
      }

      // Close tool call blocks
      for (const [, tc] of this.currentToolCalls) {
        frames.push(
          formatSSE("content_block_stop", JSON.stringify({
            type: "content_block_stop",
            index: tc.blockIndex,
          })),
        );
      }

      frames.push(
        formatSSE("message_delta", JSON.stringify({
          type: "message_delta",
          delta: {
            stop_reason: this.finishReason,
            stop_sequence: null,
          },
          usage: { output_tokens: this.usage.output_tokens },
        })),
      );

      frames.push(
        formatSSE("message_stop", JSON.stringify({
          type: "message_stop",
        })),
      );
    }

    return frames;
  }

  getMessageId(): string {
    return this.messageId;
  }
}
