/**
 * Bandwidth load test for free-tier Copilot models.
 *
 * For each model, ramps concurrency until errors appear, then reports
 * the stable request rate, latency percentiles, and token throughput.
 */

const BASE = "http://localhost:8080";
const API_KEY = "sk-proxy-e2e-test-key";
const PROMPT = "What is 2+2? Answer in one word.";
const MAX_TOKENS = 32;

// Models likely free on Copilot (no premium quota consumption)
const FREE_MODELS = [
  "oswe-vscode-prime",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4",
  "gpt-3.5-turbo",
  "goldeneye-free-auto",
];

interface RequestResult {
  model: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  outputTokens: number;
  error?: string;
}

async function singleRequest(model: string): Promise<RequestResult> {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
    });
    const latencyMs = performance.now() - start;
    const body = await res.json() as any;

    if (!res.ok) {
      return {
        model,
        ok: false,
        status: res.status,
        latencyMs,
        outputTokens: 0,
        error: body?.error?.message ?? `HTTP ${res.status}`,
      };
    }

    return {
      model,
      ok: true,
      status: res.status,
      latencyMs,
      outputTokens: body?.usage?.completion_tokens ?? 0,
    };
  } catch (e: any) {
    return {
      model,
      ok: false,
      status: 0,
      latencyMs: performance.now() - start,
      outputTokens: 0,
      error: e.message,
    };
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

interface ModelReport {
  model: string;
  available: boolean;
  error?: string;
  concurrencyTested: number;
  stableRpm: number;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  errorRate: string;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  latencyAvg: number;
  avgOutputTokens: number;
  tokensPerMinute: number;
}

async function probeModel(model: string): Promise<RequestResult> {
  console.log(`  Probing ${model}...`);
  return singleRequest(model);
}

async function benchModel(model: string, durationSec: number, concurrency: number): Promise<RequestResult[]> {
  const results: RequestResult[] = [];
  const deadline = Date.now() + durationSec * 1000;

  async function worker() {
    while (Date.now() < deadline) {
      const r = await singleRequest(model);
      results.push(r);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

async function testModel(model: string): Promise<ModelReport> {
  // Phase 1: probe
  const probe = await probeModel(model);
  if (!probe.ok) {
    return {
      model,
      available: false,
      error: probe.error ?? `HTTP ${probe.status}`,
      concurrencyTested: 0,
      stableRpm: 0,
      totalRequests: 0,
      successCount: 0,
      errorCount: 0,
      errorRate: "N/A",
      latencyP50: 0,
      latencyP95: 0,
      latencyP99: 0,
      latencyAvg: 0,
      avgOutputTokens: 0,
      tokensPerMinute: 0,
    };
  }

  console.log(`  ${model} alive (${probe.latencyMs.toFixed(0)}ms). Starting bandwidth test...`);

  // Phase 2: ramp concurrency 1 → 2 → 4 → 8, 15s per level
  const levels = [1, 2, 4, 8];
  let bestLevel = 1;
  let bestRpm = 0;
  let bestResults: RequestResult[] = [];
  const testDuration = 15; // seconds per level

  for (const c of levels) {
    console.log(`    c=${c} for ${testDuration}s...`);
    const results = await benchModel(model, testDuration, c);
    const successes = results.filter((r) => r.ok);
    const errors = results.filter((r) => !r.ok);
    const errorRate = results.length > 0 ? errors.length / results.length : 0;
    const rpm = (successes.length / testDuration) * 60;

    console.log(
      `    → ${successes.length} ok, ${errors.length} err (${(errorRate * 100).toFixed(1)}%), ` +
        `${rpm.toFixed(1)} rpm`
    );

    // If error rate > 20%, stop ramping — previous level is stable
    if (errorRate > 0.2) {
      console.log(`    → Error rate too high, stopping ramp.`);
      break;
    }

    if (rpm > bestRpm) {
      bestRpm = rpm;
      bestLevel = c;
      bestResults = results;
    }
  }

  // Compute stats from best level
  const okResults = bestResults.filter((r) => r.ok);
  const latencies = okResults.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalTokens = okResults.reduce((sum, r) => sum + r.outputTokens, 0);
  const avgTokens = okResults.length > 0 ? totalTokens / okResults.length : 0;
  const errCount = bestResults.length - okResults.length;

  return {
    model,
    available: true,
    concurrencyTested: bestLevel,
    stableRpm: bestRpm,
    totalRequests: bestResults.length,
    successCount: okResults.length,
    errorCount: errCount,
    errorRate: bestResults.length > 0 ? `${((errCount / bestResults.length) * 100).toFixed(1)}%` : "N/A",
    latencyP50: latencies.length > 0 ? percentile(latencies, 50) : 0,
    latencyP95: latencies.length > 0 ? percentile(latencies, 95) : 0,
    latencyP99: latencies.length > 0 ? percentile(latencies, 99) : 0,
    latencyAvg: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    avgOutputTokens: avgTokens,
    tokensPerMinute: (totalTokens / 15) * 60, // tokens/min at best concurrency
  };
}

async function main() {
  console.log("=== Copilot Free Model Bandwidth Test ===");
  console.log(`Prompt: "${PROMPT}"`);
  console.log(`Max tokens: ${MAX_TOKENS}`);
  console.log(`Models: ${FREE_MODELS.length}`);
  console.log(`Test: ramp concurrency 1→2→4→8, 15s per level\n`);

  const reports: ModelReport[] = [];

  for (const model of FREE_MODELS) {
    console.log(`\n[${model}]`);
    const report = await testModel(model);
    reports.push(report);
  }

  // Print report
  console.log("\n\n========================================");
  console.log("         BANDWIDTH TEST RESULTS");
  console.log("========================================\n");

  // Summary table
  const available = reports.filter((r) => r.available);
  const unavailable = reports.filter((r) => !r.available);

  if (unavailable.length > 0) {
    console.log("UNAVAILABLE MODELS:");
    for (const r of unavailable) {
      console.log(`  ✗ ${r.model}: ${r.error}`);
    }
    console.log();
  }

  if (available.length > 0) {
    console.log("MODEL                      | CONCURRENCY | STABLE RPM | AVG LATENCY |  P50   |  P95   |  P99   | ERR RATE | TOK/MIN");
    console.log("---------------------------|-------------|------------|-------------|--------|--------|--------|----------|--------");
    for (const r of available.sort((a, b) => b.stableRpm - a.stableRpm)) {
      console.log(
        `${r.model.padEnd(27)}| ${String(r.concurrencyTested).padStart(11)} | ${r.stableRpm.toFixed(1).padStart(10)} | ${r.latencyAvg.toFixed(0).padStart(8)}ms | ${r.latencyP50.toFixed(0).padStart(5)}ms | ${r.latencyP95.toFixed(0).padStart(5)}ms | ${r.latencyP99.toFixed(0).padStart(5)}ms | ${r.errorRate.padStart(8)} | ${r.tokensPerMinute.toFixed(0).padStart(6)}`
      );
    }
  }

  // JSON dump for programmatic use
  const outPath = "./bench/bandwidth-results.json";
  await Bun.write(outPath, JSON.stringify(reports, null, 2));
  console.log(`\nRaw results saved to ${outPath}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
