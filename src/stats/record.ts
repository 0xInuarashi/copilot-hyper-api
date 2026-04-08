import type { StatsRecord } from "./types.js";
import { recordStats } from "./collector.js";
import { MODEL_TIERS } from "../auto/judge.js";

export interface StatsContext {
  requestId: string;
  startTime: number;
  endpoint: string;
  apiFormat: "openai-chat" | "openai-responses" | "anthropic";
  requestedModel: string;
  resolvedModel: string;
  provider: "copilot" | "openrouter";
  streaming: boolean;
  initiator: "user" | "agent";
  interactionId: string;
  turns: number;
  autoRoute?: {
    complexity: "low" | "hard" | "extreme";
    expected_length: "short" | "long";
    confidence: number;
    reasoning: string;
    judge_model: string;
    judge_latency_ms: number;
    cached: boolean;
  } | null;
}

function inferTier(model: string): "free" | "paid" | "premium" | "unknown" {
  if (model === MODEL_TIERS.free) return "free";
  if (model === MODEL_TIERS.paid) return "paid";
  if (model === MODEL_TIERS.premium) return "premium";
  return "unknown";
}

export function emitStats(
  ctx: StatsContext,
  result: {
    statusCode: number;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    finishReason?: string | null;
    toolCallsCount?: number;
    error?: { type: string; status_code: number; message: string } | null;
  },
): void {
  const record: StatsRecord = {
    id: ctx.requestId,
    timestamp: new Date().toISOString(),
    duration_ms: Math.round(Date.now() - ctx.startTime),
    endpoint: ctx.endpoint,
    api_format: ctx.apiFormat,
    requested_model: ctx.requestedModel,
    resolved_model: ctx.resolvedModel,
    model_tier: inferTier(ctx.resolvedModel),
    provider: ctx.provider,
    streaming: ctx.streaming,
    initiator: ctx.initiator,
    interaction_id: ctx.interactionId,
    turns: ctx.turns,
    prompt_tokens: result.usage?.prompt_tokens ?? 0,
    completion_tokens: result.usage?.completion_tokens ?? 0,
    total_tokens: result.usage?.total_tokens ?? 0,
    status_code: result.statusCode,
    finish_reason: result.finishReason ?? null,
    tool_calls_count: result.toolCallsCount ?? 0,
    auto_route: ctx.autoRoute ?? null,
    error: result.error ?? null,
  };

  recordStats(record);
}
