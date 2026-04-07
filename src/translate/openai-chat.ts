export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: any[];
  tool_choice?: any;
  response_format?: any;
  n?: number;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

// Fields to strip from inbound requests that Copilot doesn't support
const UNSUPPORTED_FIELDS = ["user", "store", "metadata", "logprobs", "top_logprobs", "logit_bias", "seed", "service_tier"];

export function translateChatRequest(body: any): ChatCompletionRequest {
  if (!body.messages || !Array.isArray(body.messages)) {
    throw new InvalidChatRequestError("messages is required and must be an array");
  }

  if (body.n !== undefined && body.n > 1) {
    throw new InvalidChatRequestError("n > 1 is not supported by Copilot");
  }

  const cleaned: any = { ...body };

  // Strip unsupported fields
  for (const field of UNSUPPORTED_FIELDS) {
    delete cleaned[field];
  }

  // Force-inject required Copilot fields
  cleaned.n = 1;

  return cleaned as ChatCompletionRequest;
}

export function translateChatResponse(upstream: any): ChatCompletionResponse {
  return {
    id: upstream.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: upstream.created ?? Math.floor(Date.now() / 1000),
    model: upstream.model ?? "",
    choices: (upstream.choices ?? []).map((c: any, i: number) => ({
      index: c.index ?? i,
      message: {
        role: "assistant",
        content: c.message?.content ?? null,
        ...(c.message?.tool_calls ? { tool_calls: c.message.tool_calls } : {}),
      },
      finish_reason: c.finish_reason ?? null,
    })),
    usage: upstream.usage
      ? {
          prompt_tokens: upstream.usage.prompt_tokens ?? 0,
          completion_tokens: upstream.usage.completion_tokens ?? 0,
          total_tokens: upstream.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

export class InvalidChatRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChatRequestError";
  }
}
