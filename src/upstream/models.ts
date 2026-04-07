import { getConfig } from "../config.js";
import { copilotFetch } from "./client.js";

export class ModelNotFoundError extends Error {
  suggestions: string[];
  constructor(model: string, suggestions: string[]) {
    super(`Model '${model}' not found. Did you mean: ${suggestions.join(", ")}?`);
    this.name = "ModelNotFoundError";
    this.suggestions = suggestions;
  }
}

export interface NormalizedModel {
  id: string;
  family: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsVision: boolean;
}

interface ModelCache {
  models: NormalizedModel[];
  fetchedAt: number;
  fetchPromise: Promise<NormalizedModel[]> | null;
}

let modelCache: ModelCache = {
  models: [],
  fetchedAt: 0,
  fetchPromise: null,
};

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m]![n]!;
}

function normalizeModel(raw: any): NormalizedModel {
  return {
    id: raw.id ?? raw.name ?? "",
    family: raw.family ?? raw.id?.split("/")[0] ?? "unknown",
    maxInputTokens: raw.capabilities?.limits?.max_prompt_tokens ?? raw.max_input_tokens ?? 128000,
    maxOutputTokens: raw.capabilities?.limits?.max_output_tokens ?? raw.max_output_tokens ?? 4096,
    supportsStreaming: true,
    supportsToolCalls: raw.capabilities?.supports?.tool_calls ?? raw.supports_tool_calls ?? true,
    supportsVision: raw.capabilities?.supports?.vision ?? raw.supports_vision ?? false,
  };
}

async function fetchModels(): Promise<NormalizedModel[]> {
  const res = await copilotFetch("/models", { method: "GET" }, true);
  const data = (await res.json()) as { data?: any[]; models?: any[] };
  const rawModels = data.data ?? data.models ?? [];
  return rawModels.map(normalizeModel);
}

export async function getModels(forceRefresh = false): Promise<NormalizedModel[]> {
  const config = getConfig();
  const now = Date.now();
  const ttlMs = config.MODEL_CACHE_TTL_SECONDS * 1000;

  if (!forceRefresh && modelCache.models.length > 0 && now - modelCache.fetchedAt < ttlMs) {
    return modelCache.models;
  }

  // Single-flight
  if (modelCache.fetchPromise) {
    return modelCache.fetchPromise;
  }

  modelCache.fetchPromise = fetchModels()
    .then((models) => {
      modelCache.models = models;
      modelCache.fetchedAt = Date.now();
      modelCache.fetchPromise = null;
      return models;
    })
    .catch((err) => {
      modelCache.fetchPromise = null;
      throw err;
    });

  return modelCache.fetchPromise;
}

export function resolveModel(models: NormalizedModel[], requestedModel: string): NormalizedModel {
  // Direct match
  const exact = models.find((m) => m.id === requestedModel);
  if (exact) return exact;

  // Common alias resolution
  const aliases: Record<string, string[]> = {
    "gpt-4o": ["gpt-4o"],
    "gpt-4": ["gpt-4"],
    "gpt-3.5-turbo": ["gpt-3.5-turbo"],
    "claude-3-5-sonnet": ["claude-3.5-sonnet"],
    "claude-3-opus": ["claude-3-opus"],
    "claude-3-sonnet": ["claude-3-sonnet"],
    "claude-3-haiku": ["claude-3-haiku"],
  };

  // Try alias-based resolution
  for (const [alias, patterns] of Object.entries(aliases)) {
    if (requestedModel === alias || patterns.some((p) => requestedModel.includes(p))) {
      const match = models.find((m) => patterns.some((p) => m.id.includes(p)));
      if (match) return match;
    }
  }

  // Partial match
  const partial = models.find((m) => m.id.includes(requestedModel) || requestedModel.includes(m.id));
  if (partial) return partial;

  // Levenshtein suggestions
  const suggestions = models
    .map((m) => ({ id: m.id, dist: levenshtein(requestedModel.toLowerCase(), m.id.toLowerCase()) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3)
    .map((s) => s.id);

  throw new ModelNotFoundError(requestedModel, suggestions);
}

const AUTO_MODEL = {
  id: "auto",
  object: "model",
  created: Math.floor(Date.now() / 1000),
  owned_by: "copilot-hyper-api",
};

export function getOpenAIModelList(models: NormalizedModel[]) {
  return {
    object: "list",
    data: [
      AUTO_MODEL,
      ...models.map((m) => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "github-copilot",
      })),
    ],
  };
}

export function getAnthropicModelList(models: NormalizedModel[]) {
  const autoEntry = { id: "auto", display_name: "auto", type: "model", created_at: new Date().toISOString() };
  const data = [
    autoEntry,
    ...models.map((m) => ({
      id: m.id,
      display_name: m.id,
      type: "model",
      created_at: new Date().toISOString(),
    })),
  ];
  return {
    data,
    has_more: false,
    first_id: data[0]?.id,
    last_id: data[data.length - 1]?.id,
  };
}

export function clearModelCache(): void {
  modelCache = { models: [], fetchedAt: 0, fetchPromise: null };
}
