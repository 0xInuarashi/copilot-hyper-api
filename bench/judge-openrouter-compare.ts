#!/usr/bin/env bun
/**
 * Benchmark OpenRouter models as judges.
 * Same 199 cases × 5 runs methodology as judge-full-compare.ts,
 * but uses OpenRouter API instead of Copilot.
 *
 * Usage: OPENROUTER_API_KEY=sk-or-... bun run bench/judge-openrouter-compare.ts
 */

import { loadConfig } from "../src/config.js";

loadConfig({
  ...process.env,
  PROXY_API_KEY: process.env.PROXY_API_KEY ?? "sk-proxy-e2e-test-key",
  GITHUB_OAUTH_TOKEN: process.env.GITHUB_OAUTH_TOKEN ?? "",
  PORT: process.env.PORT ?? "19234",
} as any);

import { routeModel, type Complexity, type ExpectedLength } from "../src/auto/judge.js";
import { cases, type TestCase } from "./cases-200.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is required");
  process.exit(1);
}

const MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openai/gpt-oss-120b:free",
  "openai/gpt-oss-20b:free",
  "minimax/minimax-m2.5:free",
  "z-ai/glm-4.5-air:free",
];

const RUNS = 1;
const BATCH_SIZE = 2; // Low concurrency — free tier rate limits are tight

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

// ── OpenRouter judge call ──────────────────────────────────────────────────

async function judgeOpenRouter(
  messages: Array<{ role: string; content: string }>,
  model: string,
): Promise<{ complexity: Complexity; expectedLength: ExpectedLength; routed: string; latencyMs: number }> {
  const userContent = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
  const systemContent = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const prompt = systemContent ? `[System context]: ${systemContent}\n\n[User request]: ${userContent}` : userContent;

  const start = performance.now();

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Classify this request:\n\n${prompt}` },
      ],
      max_tokens: 200,
      temperature: 0,
    }),
  });

  const latencyMs = Math.round(performance.now() - start);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  const raw = data.choices?.[0]?.message?.content ?? "";

  let complexity: Complexity = "low";
  let expectedLength: ExpectedLength = "short";

  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed.complexity === "low" || parsed.complexity === "hard" || parsed.complexity === "extreme") {
      complexity = parsed.complexity;
    }
    if (parsed.expectedLength === "short" || parsed.expectedLength === "long") {
      expectedLength = parsed.expectedLength;
    }
  } catch {
    const lower = raw.toLowerCase();
    if (lower.includes("extreme")) complexity = "extreme";
    else if (lower.includes("hard")) complexity = "hard";
    if (lower.includes('"long"') || lower.includes("long")) expectedLength = "long";
  }

  const route = routeModel(complexity, expectedLength);
  return { complexity, expectedLength, routed: route.model, latencyMs };
}

// ── Runner ─────────────────────────────────────────────────────────────────

interface SingleResult {
  model: string;
  caseName: string;
  bucket: string;
  routeOk: boolean;
  complexityOk: boolean;
  lengthOk: boolean;
  gotRoute: string;
  latencyMs: number;
}

async function judgeWithRetry(
  tc: TestCase,
  model: string,
  maxRetries = 3,
): Promise<SingleResult> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const r = await judgeOpenRouter(tc.messages, model);
      const expectedRoute = routeModel(tc.expectedC as Complexity, tc.expectedL as ExpectedLength);
      return {
        model, caseName: tc.name, bucket: tc.bucket,
        routeOk: r.routed === expectedRoute.model,
        complexityOk: r.complexity === tc.expectedC,
        lengthOk: r.expectedLength === tc.expectedL,
        gotRoute: r.routed, latencyMs: r.latencyMs,
      };
    } catch (err: any) {
      if (attempt < maxRetries && (err.message?.includes("429") || err.message?.includes("502") || err.message?.includes("503"))) {
        await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
        continue;
      }
      return {
        model, caseName: tc.name, bucket: tc.bucket,
        routeOk: false, complexityOk: false, lengthOk: false,
        gotRoute: "error", latencyMs: 0,
      };
    }
  }
  return { model, caseName: tc.name, bucket: tc.bucket, routeOk: false, complexityOk: false, lengthOk: false, gotRoute: "error", latencyMs: 0 };
}

// Run models SEQUENTIALLY per case to avoid rate limits on free tier
async function runCaseAllModels(tc: TestCase): Promise<SingleResult[]> {
  const results: SingleResult[] = [];
  for (const model of MODELS) {
    results.push(await judgeWithRetry(tc, model));
  }
  return results;
}

async function runBatch(caseList: TestCase[]): Promise<SingleResult[]> {
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

// ── Stats ──────────────────────────────────────────────────────────────────

interface ModelStats {
  routeAcc: number;
  complexityAcc: number;
  lengthAcc: number;
  avgLatency: number;
  bucketRouteAcc: Record<string, number>;
  opusWaste: number;
  paidWhenFree: number;
  freeWhenPaid: number;
}

function computeStats(results: SingleResult[], model: string): ModelStats {
  const r = results.filter((x) => x.model === model);
  const total = r.length;

  const bucketLabels = ["low+S", "low+L", "hard+S", "hard+L", "extr+S", "extr+L"];
  const bucketRouteAcc: Record<string, number> = {};
  for (const b of bucketLabels) {
    const bucket = r.filter((x) => x.bucket === b);
    if (bucket.length === 0) continue;
    bucketRouteAcc[b] = bucket.filter((x) => x.routeOk).length / bucket.length;
  }

  return {
    routeAcc: r.filter((x) => x.routeOk).length / total,
    complexityAcc: r.filter((x) => x.complexityOk).length / total,
    lengthAcc: r.filter((x) => x.lengthOk).length / total,
    avgLatency: Math.round(r.reduce((s, x) => s + x.latencyMs, 0) / total),
    bucketRouteAcc,
    opusWaste: r.filter((x) => !x.routeOk && x.gotRoute === "claude-opus-4.6" && !x.bucket.includes("extr+L")).length,
    paidWhenFree: r.filter((x) => !x.routeOk && x.gotRoute !== "oswe-vscode-prime" && (x.bucket === "low+S" || x.bucket === "low+L" || x.bucket === "hard+S")).length,
    freeWhenPaid: r.filter((x) => !x.routeOk && x.gotRoute === "oswe-vscode-prime" && x.bucket !== "low+S" && x.bucket !== "low+L" && x.bucket !== "hard+S").length,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const totalCalls = cases.length * MODELS.length * RUNS;
  console.log("╔═══════════════════════════════════════════════════════════════════════════╗");
  console.log(`║  OPENROUTER JUDGE BENCHMARK: ${cases.length} cases × ${MODELS.length} models × ${RUNS} run(s)`.padEnd(76) + "║");
  console.log(`║  ${totalCalls} classifications via OpenRouter`.padEnd(76) + "║");
  console.log("╚═══════════════════════════════════════════════════════════════════════════╝\n");

  const bucketLabels = ["low+S", "low+L", "hard+S", "hard+L", "extr+S", "extr+L"];
  process.stdout.write("Distribution: ");
  for (const b of bucketLabels) {
    process.stdout.write(`${b}=${cases.filter((c) => c.bucket === b).length} `);
  }
  console.log(`total=${cases.length}\n`);

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

  // ── Averaged results ──────────────────────────────────────────────
  function avg(arr: number[]): number { return arr.reduce((a, b) => a + b, 0) / arr.length; }
  function stddev(arr: number[]): number {
    const m = avg(arr);
    return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
  }
  function pctPm(arr: number[]): string {
    return `${(avg(arr) * 100).toFixed(1)}%±${(stddev(arr) * 100).toFixed(1)}`;
  }

  const col = 40;
  const sep = "═".repeat(22 + MODELS.length * col);

  console.log(sep);
  console.log("AVERAGED RESULTS — OPENROUTER JUDGES (5 runs)");
  console.log(sep);

  console.log("\n" + "".padEnd(22) + MODELS.map((m) => m.padStart(col)).join(""));

  process.stdout.write("ROUTE accuracy".padEnd(22));
  for (const m of MODELS) {
    process.stdout.write(pctPm(allRunStats.get(m)!.map((s) => s.routeAcc)).padStart(col));
  }
  console.log();

  process.stdout.write("Complexity acc".padEnd(22));
  for (const m of MODELS) {
    process.stdout.write(pctPm(allRunStats.get(m)!.map((s) => s.complexityAcc)).padStart(col));
  }
  console.log();

  process.stdout.write("Length acc".padEnd(22));
  for (const m of MODELS) {
    process.stdout.write(pctPm(allRunStats.get(m)!.map((s) => s.lengthAcc)).padStart(col));
  }
  console.log();

  console.log();
  for (const b of bucketLabels) {
    const routeLabel = b === "low+S" || b === "low+L" || b === "hard+S" ? "→free" : b === "hard+L" || b === "extr+S" ? "→sonnet" : "→opus";
    process.stdout.write(`  ${(b + routeLabel).padEnd(20)}`);
    for (const m of MODELS) {
      process.stdout.write(pctPm(allRunStats.get(m)!.map((s) => s.bucketRouteAcc[b] ?? 0)).padStart(col));
    }
    console.log();
  }

  console.log();
  process.stdout.write("Avg latency (ms)".padEnd(22));
  for (const m of MODELS) {
    process.stdout.write(`${Math.round(avg(allRunStats.get(m)!.map((s) => s.avgLatency)))}`.padStart(col));
  }
  console.log();

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
