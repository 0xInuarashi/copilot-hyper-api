import { copilotFetch } from "../upstream/client.js";
import { getConfig } from "../config.js";

export type Complexity = "low" | "hard" | "extreme";
export type ExpectedLength = "short" | "long";
export type Provider = "copilot" | "openrouter";

export interface JudgeResult {
  complexity: Complexity;
  expectedLength: ExpectedLength;
  confidence: number;
  reasoning: string;
  model: string;
  latencyMs: number;
  routed: string;
  provider: Provider;
}

const JUDGE_MODEL = "gpt-4o";

const SYSTEM_PROMPT = `You are a request complexity and length classifier. Given a user prompt, classify it on TWO dimensions:

**COMPLEXITY** — one of three tiers:
- **low**: Most everyday requests. Factual questions, translations, math, lookups, greetings, writing a function, explaining a concept, debugging an error, comparisons, writing a class, SQL queries, regex, config help, short code generation, summaries. Anything a competent developer could answer quickly or that produces a focused, bounded output. This is the DEFAULT tier — most requests belong here.
- **hard**: Tasks requiring sustained multi-step reasoning across multiple domains, or generating substantial interconnected code (multiple files/modules that must work together). Examples: designing a service with multiple components, implementing a full feature with tests and error handling, multi-file refactors, writing a complete CLI tool, building an API with multiple endpoints. The key differentiator: the answer has MULTIPLE INTERDEPENDENT PARTS that must be consistent with each other.
- **extreme**: Architect-level tasks demanding deep expertise. Full system designs (distributed systems, entire application architectures), comprehensive security/performance audits, research-grade analysis comparing multiple complex systems with code, building compilers/interpreters, designing database schemas with migrations + ORM + RLS + audit trails, end-to-end ML pipelines. These are tasks where even a senior engineer would need significant time to produce a quality answer.

**EXPECTED LENGTH** — how long a quality response would be:
- **short**: The good answer is focused and concise. Under ~800 words or ~100 lines of code. Even complex reasoning can be short if the output is a focused recommendation, a single algorithm, a targeted fix, or a concise analysis.
- **long**: The good answer requires extensive output. Over ~800 words or ~100 lines of code. Multiple sections, many code files, comprehensive coverage, detailed step-by-step with code for each step.

The threshold for complexity is HIGH — when in doubt, classify as **low**.
Length is about the EXPECTED OUTPUT, not the input prompt length.

Respond with ONLY a JSON object, no markdown fences:
{"complexity": "low"|"hard"|"extreme", "expectedLength": "short"|"long", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`;

export async function judge(messages: Array<{ role: string; content: string }>, modelOverride?: string): Promise<JudgeResult> {
  const userContent = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n\n");

  const systemMessages = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const promptToClassify = systemMessages
    ? `[System context]: ${systemMessages}\n\n[User request]: ${userContent}`
    : userContent;

  const start = performance.now();
  const useModel = modelOverride ?? JUDGE_MODEL;

  const res = await copilotFetch("/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: useModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Classify this request:\n\n${promptToClassify}` },
      ],
      max_tokens: 200,
      temperature: 0,
      n: 1,
    }),
  });

  const latencyMs = Math.round(performance.now() - start);
  const data = (await res.json()) as any;
  const raw = data.choices?.[0]?.message?.content ?? "";

  try {
    const parsed = JSON.parse(raw.trim());
    const complexity = validateComplexity(parsed.complexity);
    const expectedLength = validateLength(parsed.expectedLength);
    const route = routeModel(complexity, expectedLength);
    return {
      complexity,
      expectedLength,
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5)),
      reasoning: parsed.reasoning ?? "",
      model: useModel,
      latencyMs,
      routed: route.model,
      provider: route.provider,
    };
  } catch {
    const lower = raw.toLowerCase();
    let complexity: Complexity = "low";
    if (lower.includes('"extreme"') || lower.includes("extreme")) complexity = "extreme";
    else if (lower.includes('"hard"') || lower.includes("hard")) complexity = "hard";
    const expectedLength: ExpectedLength = lower.includes('"long"') ? "long" : "short";
    const route = routeModel(complexity, expectedLength);

    return {
      complexity,
      expectedLength,
      confidence: 0.3,
      reasoning: `Parse fallback from raw: ${raw.slice(0, 100)}`,
      model: useModel,
      latencyMs,
      routed: route.model,
      provider: route.provider,
    };
  }
}

function validateComplexity(val: unknown): Complexity {
  if (val === "low" || val === "hard" || val === "extreme") return val;
  return "low";
}

function validateLength(val: unknown): ExpectedLength {
  if (val === "short" || val === "long") return val;
  return "short";
}

/**
 * Routing logic — maximize free tier usage:
 *   low + any length           → free tier (Raptor Mini or OpenRouter)
 *   hard + short               → free tier (Raptor Mini or OpenRouter)
 *   hard + long                → claude-sonnet-4.6 (paid — multi-part needs quality)
 *   extreme + short            → claude-sonnet-4.6 (paid — deep but focused)
 *   extreme + long             → claude-opus-4.6   (premium — only when truly needed)
 */
export function routeModel(complexity: Complexity, expectedLength: ExpectedLength): { model: string; provider: Provider } {
  const isFree = complexity === "low" || (complexity === "hard" && expectedLength === "short");

  if (isFree) {
    try {
      const config = getConfig();
      if (config.OPENROUTER_ENABLED && config.OPENROUTER_API_KEY && config.OPENROUTER_MODEL) {
        return { model: config.OPENROUTER_MODEL, provider: "openrouter" };
      }
    } catch {
      // Config not loaded yet (e.g. during benchmark case initialization)
    }
    return { model: "oswe-vscode-prime", provider: "copilot" };
  }

  if (complexity === "hard") return { model: "claude-sonnet-4.6", provider: "copilot" };
  // extreme
  if (expectedLength === "short") return { model: "claude-sonnet-4.6", provider: "copilot" };
  return { model: "claude-opus-4.6", provider: "copilot" };
}

/**
 * Prefix overrides for auto-mode. Users can type #opus, #sonnet, etc. at the
 * start of their message to force a specific model without invoking the judge.
 */
const PREFIX_ROUTES: Record<string, { model: string; provider: Provider }> = {
  "#opus":    { model: "claude-opus-4.6",   provider: "copilot" },
  "#sonnet":  { model: "claude-sonnet-4.6", provider: "copilot" },
  "#gpt4o":   { model: "gpt-4o",            provider: "copilot" },
  "#free":    { model: "oswe-vscode-prime",  provider: "copilot" },
};

export interface PrefixRouteResult {
  model: string;
  provider: Provider;
  prefix: string;
}

/**
 * Check the last user message for a #model prefix override.
 * Returns the route + stripped prefix if found, undefined otherwise.
 * The caller is responsible for stripping the prefix from the actual message content.
 */
export function parsePrefixRoute(messages: Array<{ role: string; content: string }>): PrefixRouteResult | undefined {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return undefined;
  const text = lastUser.content.trimStart();
  for (const [prefix, route] of Object.entries(PREFIX_ROUTES)) {
    if (text.toLowerCase().startsWith(prefix) && (text.length === prefix.length || /\s/.test(text[prefix.length]))) {
      return { ...route, prefix };
    }
  }
  return undefined;
}

/** Strip the prefix tag from the last user message content (mutates the array). */
export function stripPrefixFromMessages(messages: any[], prefix: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      const trimmed = m.content.trimStart();
      if (trimmed.toLowerCase().startsWith(prefix)) {
        m.content = trimmed.slice(prefix.length).trimStart();
        return;
      }
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "text" && typeof block.text === "string") {
          const trimmed = block.text.trimStart();
          if (trimmed.toLowerCase().startsWith(prefix)) {
            block.text = trimmed.slice(prefix.length).trimStart();
            return;
          }
        }
      }
    }
    return;
  }
}

export const MODEL_TIERS = {
  free: "oswe-vscode-prime",
  paid: "claude-sonnet-4.6",
  premium: "claude-opus-4.6",
} as const;

/** Flatten any content format (string, content parts array) to plain text */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: any) => p.text ?? "").filter(Boolean).join("\n");
  return String(content ?? "");
}

/** Cache of routed models per conversation (keyed by interactionId). */
const routeCache = new Map<string, { model: string; provider: Provider; ah: Record<string, string> }>();

/** Look up a previously routed model for this conversation. */
export function getCachedRoute(interactionId: string): { model: string; provider: Provider; ah: Record<string, string> } | undefined {
  return routeCache.get(interactionId);
}

/** Store a routed model for this conversation. */
export function setCachedRoute(interactionId: string, jr: JudgeResult): void {
  routeCache.set(interactionId, { model: jr.routed, provider: jr.provider, ah: autoRouteHeaders(jr) });
  // Evict old entries to prevent unbounded growth
  if (routeCache.size > 10000) {
    const oldest = routeCache.keys().next().value!;
    routeCache.delete(oldest);
  }
}

/** Build response headers for auto-routed requests */
export function autoRouteHeaders(jr: JudgeResult): Record<string, string> {
  return {
    "x-auto-routed": "true",
    "x-auto-model": jr.routed,
    "x-auto-provider": jr.provider,
    "x-auto-complexity": jr.complexity,
    "x-auto-length": jr.expectedLength,
    "x-auto-confidence": jr.confidence.toFixed(2),
    "x-auto-latency-ms": jr.latencyMs.toString(),
  };
}
