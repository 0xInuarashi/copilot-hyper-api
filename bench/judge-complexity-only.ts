#!/usr/bin/env bun
/**
 * Complexity-only benchmark: 199 cases × 5 models × 5 runs, parallelized.
 * No length dimension — just low/hard/extreme → free/sonnet/opus.
 * Direct comparison against the complexity+length benchmark.
 *
 * Usage: bun run bench/judge-complexity-only.ts
 */

import { loadConfig } from "../src/config.js";

loadConfig({
  ...process.env,
  PROXY_API_KEY: process.env.PROXY_API_KEY ?? "sk-proxy-e2e-test-key",
  GITHUB_OAUTH_TOKEN: process.env.GITHUB_OAUTH_TOKEN ?? "",
  PORT: process.env.PORT ?? "19234",
} as any);

import { copilotFetch } from "../src/upstream/client.js";
import { cases as allCases } from "./cases-200.js";

type ComplexityTier = "low" | "hard" | "extreme";

const MODELS = ["gpt-5-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini", "oswe-vscode-prime"];
const RUNS = 5;
const BATCH_SIZE = 8;

// ── Complexity-only routing (no length) ─────────────────────────────────────

function routeByComplexity(c: ComplexityTier): string {
  if (c === "low") return "gpt-5-mini";
  if (c === "hard") return "claude-sonnet-4.6";
  return "claude-opus-4.6";
}

// ── Complexity-only system prompt (no length classification) ────────────────

const SYSTEM_PROMPT = `You are a request complexity classifier. Given a user prompt, classify it into exactly one of three tiers:

- **low**: Most everyday requests. Factual questions, translations, math, lookups, greetings, writing a function, explaining a concept, debugging an error, comparisons, writing a class, SQL queries, regex, config help, short code generation, summaries. Anything a competent developer could answer quickly or that produces a focused, bounded output. This is the DEFAULT tier — most requests belong here.
- **hard**: Tasks requiring sustained multi-step reasoning across multiple domains, or generating substantial interconnected code (multiple files/modules that must work together). Examples: designing a service with multiple components, implementing a full feature with tests and error handling, multi-file refactors, writing a complete CLI tool, building an API with multiple endpoints. The key differentiator: the answer has MULTIPLE INTERDEPENDENT PARTS that must be consistent with each other.
- **extreme**: Architect-level tasks demanding deep expertise. Full system designs (distributed systems, entire application architectures), comprehensive security/performance audits, research-grade analysis comparing multiple complex systems with code, building compilers/interpreters, designing database schemas with migrations + ORM + RLS + audit trails, end-to-end ML pipelines. These are tasks where even a senior engineer would need significant time to produce a quality answer.

The threshold is HIGH. When in doubt, classify as **low**. Only escalate when the task genuinely demands deep multi-part reasoning (hard) or architect-level comprehensive output (extreme).

Respond with ONLY a JSON object, no markdown fences:
{"complexity": "low"|"hard"|"extreme", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`;

// ── Judge (complexity only) ─────────────────────────────────────────────────

async function judgeComplexity(
  messages: Array<{ role: string; content: string }>,
  model: string,
): Promise<{ complexity: ComplexityTier; routed: string; latencyMs: number }> {
  const userContent = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
  const systemContent = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const prompt = systemContent ? `[System context]: ${systemContent}\n\n[User request]: ${userContent}` : userContent;

  const start = performance.now();

  const res = await copilotFetch("/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Classify this request:\n\n${prompt}` },
      ],
      max_tokens: 150,
      temperature: 0,
      n: 1,
    }),
  });

  const latencyMs = Math.round(performance.now() - start);
  const data = (await res.json()) as any;
  const raw = data.choices?.[0]?.message?.content ?? "";

  let complexity: ComplexityTier = "low";
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed.complexity === "low" || parsed.complexity === "hard" || parsed.complexity === "extreme") {
      complexity = parsed.complexity;
    }
  } catch {
    const lower = raw.toLowerCase();
    if (lower.includes('"extreme"') || lower.includes("extreme")) complexity = "extreme";
    else if (lower.includes('"hard"') || lower.includes("hard")) complexity = "hard";
  }

  return { complexity, routed: routeByComplexity(complexity), latencyMs };
}

// ── Test case mapping ───────────────────────────────────────────────────────

interface MappedCase {
  name: string;
  bucket: string;
  messages: Array<{ role: string; content: string }>;
  expectedC: ComplexityTier;
  expectedRoute: string;
}

// Map the 2D cases to complexity-only expectations
const cases: MappedCase[] = allCases.map((tc) => ({
  name: tc.name,
  bucket: tc.bucket,
  messages: tc.messages,
  expectedC: tc.expectedC as ComplexityTier,
  expectedRoute: routeByComplexity(tc.expectedC as ComplexityTier),
}));

// ── Runner ──────────────────────────────────────────────────────────────────

interface SingleResult {
  model: string;
  caseName: string;
  bucket: string;
  expectedC: ComplexityTier;
  gotC: ComplexityTier;
  routeOk: boolean;
  complexityOk: boolean;
  gotRoute: string;
  latencyMs: number;
}

async function runCaseAllModels(tc: MappedCase): Promise<SingleResult[]> {
  return Promise.all(
    MODELS.map(async (model): Promise<SingleResult> => {
      try {
        const r = await judgeComplexity(tc.messages, model);
        return {
          model, caseName: tc.name, bucket: tc.bucket,
          expectedC: tc.expectedC, gotC: r.complexity,
          routeOk: r.routed === tc.expectedRoute,
          complexityOk: r.complexity === tc.expectedC,
          gotRoute: r.routed, latencyMs: r.latencyMs,
        };
      } catch {
        return {
          model, caseName: tc.name, bucket: tc.bucket,
          expectedC: tc.expectedC, gotC: "low",
          routeOk: false, complexityOk: false,
          gotRoute: "gpt-5-mini", latencyMs: 0,
        };
      }
    }),
  );
}

async function runBatch(caseList: MappedCase[]): Promise<SingleResult[]> {
  const all: SingleResult[] = [];
  for (let i = 0; i < caseList.length; i += BATCH_SIZE) {
    const batch = caseList.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(runCaseAllModels));
    for (const results of batchResults) all.push(...results);
    const done = Math.min(i + BATCH_SIZE, caseList.length);
    process.stdout.write(`\r  ${done}/${caseList.length} (${((done / caseList.length) * 100).toFixed(0)}%)`);
  }
  process.stdout.write("\n");
  return all;
}

// ── Stats ───────────────────────────────────────────────────────────────────

interface ModelStats {
  routeAcc: number;
  complexityAcc: number;
  avgLatency: number;
  perTier: Record<ComplexityTier, number>;
  opusWaste: number;
  paidWhenFree: number;
  freeWhenPaid: number;
}

function computeStats(results: SingleResult[], model: string): ModelStats {
  const r = results.filter((x) => x.model === model);
  const total = r.length;

  const perTier: Record<ComplexityTier, number> = { low: 0, hard: 0, extreme: 0 };
  for (const tier of ["low", "hard", "extreme"] as ComplexityTier[]) {
    const bucket = r.filter((x) => x.expectedC === tier);
    perTier[tier] = bucket.length > 0 ? bucket.filter((x) => x.complexityOk).length / bucket.length : 0;
  }

  return {
    routeAcc: r.filter((x) => x.routeOk).length / total,
    complexityAcc: r.filter((x) => x.complexityOk).length / total,
    avgLatency: Math.round(r.reduce((s, x) => s + x.latencyMs, 0) / total),
    perTier,
    opusWaste: r.filter((x) => !x.routeOk && x.gotRoute === "claude-opus-4.6" && x.expectedC !== "extreme").length,
    paidWhenFree: r.filter((x) => !x.routeOk && x.gotRoute !== "gpt-5-mini" && x.expectedC === "low").length,
    freeWhenPaid: r.filter((x) => !x.routeOk && x.gotRoute === "gpt-5-mini" && x.expectedC !== "low").length,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const totalCalls = cases.length * MODELS.length * RUNS;

  // Count distribution
  const lowCount = cases.filter((c) => c.expectedC === "low").length;
  const hardCount = cases.filter((c) => c.expectedC === "hard").length;
  const extremeCount = cases.filter((c) => c.expectedC === "extreme").length;

  console.log("╔═══════════════════════════════════════════════════════════════════════════╗");
  console.log("║  COMPLEXITY-ONLY BENCHMARK: 199 cases × 5 models × 5 runs               ║");
  console.log(`║  ${totalCalls} classifications | low→free, hard→sonnet, extreme→opus`.padEnd(76) + "║");
  console.log("╚═══════════════════════════════════════════════════════════════════════════╝\n");
  console.log(`Distribution: low=${lowCount} hard=${hardCount} extreme=${extremeCount} total=${cases.length}\n`);

  const allRunStats: Map<string, ModelStats[]> = new Map();
  for (const m of MODELS) allRunStats.set(m, []);

  const startTime = Date.now();

  for (let run = 0; run < RUNS; run++) {
    console.log(`── Run ${run + 1}/${RUNS} ──`);
    const results = await runBatch(cases);
    for (const model of MODELS) {
      allRunStats.get(model)!.push(computeStats(results, model));
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\nCompleted in ${elapsed}s (${totalCalls} calls)\n`);

  // ── Averaged results ──────────────────────────────────────────────────
  function avg(arr: number[]): number { return arr.reduce((a, b) => a + b, 0) / arr.length; }
  function stddev(arr: number[]): number {
    const m = avg(arr);
    return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
  }
  function pctPm(arr: number[]): string {
    return `${(avg(arr) * 100).toFixed(1)}%±${(stddev(arr) * 100).toFixed(1)}`;
  }

  const col = 18;
  const sep = "═".repeat(22 + MODELS.length * col);

  console.log(sep);
  console.log("AVERAGED RESULTS — COMPLEXITY ONLY (5 runs)");
  console.log(sep);

  console.log("\n" + "".padEnd(22) + MODELS.map((m) => m.padStart(col)).join(""));

  // Route accuracy
  process.stdout.write("ROUTE accuracy".padEnd(22));
  for (const m of MODELS) {
    process.stdout.write(pctPm(allRunStats.get(m)!.map((s) => s.routeAcc)).padStart(col));
  }
  console.log();

  // Complexity accuracy
  process.stdout.write("Complexity acc".padEnd(22));
  for (const m of MODELS) {
    process.stdout.write(pctPm(allRunStats.get(m)!.map((s) => s.complexityAcc)).padStart(col));
  }
  console.log();

  // Per-tier
  console.log();
  for (const tier of ["low", "hard", "extreme"] as ComplexityTier[]) {
    const routeLabel = tier === "low" ? "→free" : tier === "hard" ? "→sonnet" : "→opus";
    process.stdout.write(`  ${(tier + routeLabel).padEnd(20)}`);
    for (const m of MODELS) {
      process.stdout.write(pctPm(allRunStats.get(m)!.map((s) => s.perTier[tier])).padStart(col));
    }
    console.log();
  }

  // Latency
  console.log();
  process.stdout.write("Avg latency (ms)".padEnd(22));
  for (const m of MODELS) {
    process.stdout.write(`${Math.round(avg(allRunStats.get(m)!.map((s) => s.avgLatency)))}`.padStart(col));
  }
  console.log();

  // Cost errors
  process.stdout.write("Opus waste (avg)".padEnd(22));
  for (const m of MODELS) {
    process.stdout.write(avg(allRunStats.get(m)!.map((s) => s.opusWaste)).toFixed(1).padStart(col));
  }
  console.log();

  process.stdout.write("Paid when free (avg)".padEnd(22));
  for (const m of MODELS) {
    process.stdout.write(avg(allRunStats.get(m)!.map((s) => s.paidWhenFree)).toFixed(1).padStart(col));
  }
  console.log();

  process.stdout.write("Free when paid (avg)".padEnd(22));
  for (const m of MODELS) {
    process.stdout.write(avg(allRunStats.get(m)!.map((s) => s.freeWhenPaid)).toFixed(1).padStart(col));
  }
  console.log();

  // ── Winner ────────────────────────────────────────────────────────────
  console.log("\n" + sep);

  let bestModel = "";
  let bestRouteAvg = -1;
  let bestLat = Infinity;

  for (const m of MODELS) {
    const ra = avg(allRunStats.get(m)!.map((s) => s.routeAcc));
    const la = avg(allRunStats.get(m)!.map((s) => s.avgLatency));
    if (ra > bestRouteAvg || (ra === bestRouteAvg && la < bestLat)) {
      bestModel = m;
      bestRouteAvg = ra;
      bestLat = la;
    }
  }

  console.log(`BEST ROUTER: ${bestModel} (${(bestRouteAvg * 100).toFixed(1)}% avg route accuracy, ${Math.round(bestLat)}ms)`);
  console.log(sep);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
