#!/usr/bin/env bun
/**
 * Full benchmark: 200 cases × 5 models × 5 runs, parallelized.
 * Models run in parallel per case, cases in batches of 8.
 *
 * Usage: bun run bench/judge-full-compare.ts
 */

import { loadConfig } from "../src/config.js";

loadConfig({
  ...process.env,
  PROXY_API_KEY: process.env.PROXY_API_KEY ?? "sk-proxy-e2e-test-key",
  GITHUB_OAUTH_TOKEN: process.env.GITHUB_OAUTH_TOKEN ?? "",
  PORT: process.env.PORT ?? "19234",
} as any);

import { judge, routeModel, type Complexity, type ExpectedLength } from "../src/auto/judge.js";
import { cases, type TestCase } from "./cases-200.js";

const MODELS = ["gpt-5-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini", "oswe-vscode-prime"];
const RUNS = 5;
const BATCH_SIZE = 8; // cases in parallel (× 5 models each = 40 concurrent requests)

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

// ── Run one case across all models in parallel ──────────────────────────────

async function runCaseAllModels(tc: TestCase): Promise<SingleResult[]> {
  const results = await Promise.all(
    MODELS.map(async (model): Promise<SingleResult> => {
      try {
        const r = await judge(tc.messages, model);
        return {
          model,
          caseName: tc.name,
          bucket: tc.bucket,
          routeOk: r.routed === tc.expectedRoute,
          complexityOk: r.complexity === tc.expectedC,
          lengthOk: r.expectedLength === tc.expectedL,
          gotRoute: r.routed,
          latencyMs: r.latencyMs,
        };
      } catch {
        return {
          model,
          caseName: tc.name,
          bucket: tc.bucket,
          routeOk: false,
          complexityOk: false,
          lengthOk: false,
          gotRoute: "error",
          latencyMs: 0,
        };
      }
    }),
  );
  return results;
}

// ── Batch runner ────────────────────────────────────────────────────────────

async function runBatch(caseList: TestCase[]): Promise<SingleResult[]> {
  const all: SingleResult[] = [];
  for (let i = 0; i < caseList.length; i += BATCH_SIZE) {
    const batch = caseList.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(runCaseAllModels));
    for (const results of batchResults) {
      all.push(...results);
    }
    const done = Math.min(i + BATCH_SIZE, caseList.length);
    const pct = ((done / caseList.length) * 100).toFixed(0);
    process.stdout.write(`\r  ${done}/${caseList.length} cases (${pct}%)`);
  }
  process.stdout.write("\n");
  return all;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

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

  const bucketRouteAcc: Record<string, number> = {};
  const bucketLabels = ["low+S", "low+L", "hard+S", "hard+L", "extr+S", "extr+L"];
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
    paidWhenFree: r.filter((x) => !x.routeOk && x.gotRoute !== "gpt-5-mini" && (x.bucket === "low+S" || x.bucket === "low+L" || x.bucket === "hard+S")).length,
    freeWhenPaid: r.filter((x) => !x.routeOk && x.gotRoute === "gpt-5-mini" && x.bucket !== "low+S" && x.bucket !== "low+L" && x.bucket !== "hard+S").length,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const totalCalls = cases.length * MODELS.length * RUNS;
  console.log("╔═══════════════════════════════════════════════════════════════════════════╗");
  console.log("║  FULL BENCHMARK: 200 cases × 5 models × 5 runs                          ║");
  console.log(`║  ${totalCalls} total classifications, parallelized (batch=${BATCH_SIZE}×${MODELS.length}=${BATCH_SIZE * MODELS.length} concurrent)`.padEnd(76) + "║");
  console.log("╚═══════════════════════════════════════════════════════════════════════════╝\n");

  // Distribution
  const bucketLabels = ["low+S", "low+L", "hard+S", "hard+L", "extr+S", "extr+L"];
  process.stdout.write("Distribution: ");
  for (const b of bucketLabels) {
    const count = cases.filter((c) => c.bucket === b).length;
    process.stdout.write(`${b}=${count} `);
  }
  console.log(`total=${cases.length}\n`);

  const allRunStats: Map<string, ModelStats[]> = new Map();
  for (const m of MODELS) allRunStats.set(m, []);

  const startTime = Date.now();

  for (let run = 0; run < RUNS; run++) {
    console.log(`── Run ${run + 1}/${RUNS} ──`);
    const results = await runBatch(cases);

    for (const model of MODELS) {
      const stats = computeStats(results, model);
      allRunStats.get(model)!.push(stats);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\nCompleted in ${elapsed}s (${totalCalls} calls)\n`);

  // ── Average across runs ─────────────────────────────────────────────
  function avg(arr: number[]): number { return arr.reduce((a, b) => a + b, 0) / arr.length; }
  function stddev(arr: number[]): number {
    const m = avg(arr);
    return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
  }
  function pct(n: number): string { return (n * 100).toFixed(1) + "%"; }
  function pctPm(arr: number[]): string {
    const m = avg(arr);
    const sd = stddev(arr);
    return `${(m * 100).toFixed(1)}%±${(sd * 100).toFixed(1)}`;
  }

  // ── Results table ─────────────────────────────────────────────────────
  const col = 18;
  const sep = "═".repeat(22 + MODELS.length * col);

  console.log(sep);
  console.log("AVERAGED RESULTS (5 runs)");
  console.log(sep);

  console.log("\n" + "".padEnd(22) + MODELS.map((m) => m.padStart(col)).join(""));

  // Route accuracy ± stddev
  process.stdout.write("ROUTE accuracy".padEnd(22));
  for (const m of MODELS) {
    const runs = allRunStats.get(m)!.map((s) => s.routeAcc);
    process.stdout.write(pctPm(runs).padStart(col));
  }
  console.log();

  // Complexity accuracy
  process.stdout.write("Complexity acc".padEnd(22));
  for (const m of MODELS) {
    const runs = allRunStats.get(m)!.map((s) => s.complexityAcc);
    process.stdout.write(pctPm(runs).padStart(col));
  }
  console.log();

  // Length accuracy
  process.stdout.write("Length acc".padEnd(22));
  for (const m of MODELS) {
    const runs = allRunStats.get(m)!.map((s) => s.lengthAcc);
    process.stdout.write(pctPm(runs).padStart(col));
  }
  console.log();

  // Per-bucket route accuracy
  console.log();
  for (const b of bucketLabels) {
    const routeLabel = b === "low+S" || b === "low+L" || b === "hard+S" ? "→free" : b === "hard+L" || b === "extr+S" ? "→sonnet" : "→opus";
    process.stdout.write(`  ${(b + routeLabel).padEnd(20)}`);
    for (const m of MODELS) {
      const runs = allRunStats.get(m)!.map((s) => s.bucketRouteAcc[b] ?? 0);
      process.stdout.write(pctPm(runs).padStart(col));
    }
    console.log();
  }

  // Latency
  console.log();
  process.stdout.write("Avg latency (ms)".padEnd(22));
  for (const m of MODELS) {
    const runs = allRunStats.get(m)!.map((s) => s.avgLatency);
    const a = Math.round(avg(runs));
    process.stdout.write(`${a}`.padStart(col));
  }
  console.log();

  // Cost errors
  process.stdout.write("Opus waste (avg)".padEnd(22));
  for (const m of MODELS) {
    const runs = allRunStats.get(m)!.map((s) => s.opusWaste);
    process.stdout.write(avg(runs).toFixed(1).padStart(col));
  }
  console.log();

  process.stdout.write("Paid when free (avg)".padEnd(22));
  for (const m of MODELS) {
    const runs = allRunStats.get(m)!.map((s) => s.paidWhenFree);
    process.stdout.write(avg(runs).toFixed(1).padStart(col));
  }
  console.log();

  process.stdout.write("Free when paid (avg)".padEnd(22));
  for (const m of MODELS) {
    const runs = allRunStats.get(m)!.map((s) => s.freeWhenPaid);
    process.stdout.write(avg(runs).toFixed(1).padStart(col));
  }
  console.log();

  // ── Winner ────────────────────────────────────────────────────────────
  console.log("\n" + sep);

  let bestModel = "";
  let bestRouteAvg = -1;
  let bestLat = Infinity;

  for (const m of MODELS) {
    const runs = allRunStats.get(m)!.map((s) => s.routeAcc);
    const ra = avg(runs);
    const la = avg(allRunStats.get(m)!.map((s) => s.avgLatency));
    if (ra > bestRouteAvg || (ra === bestRouteAvg && la < bestLat)) {
      bestModel = m;
      bestRouteAvg = ra;
      bestLat = la;
    }
  }

  console.log(`BEST ROUTER: ${bestModel} (${pct(bestRouteAvg)} avg route accuracy, ${Math.round(bestLat)}ms avg latency)`);
  console.log(sep);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
