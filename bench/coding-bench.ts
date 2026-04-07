#!/usr/bin/env bun
/**
 * Coding benchmark: 20 tasks × 5 free Copilot models.
 * Collects all responses, saves to JSON for manual judging.
 *
 * Usage: bun run bench/coding-bench.ts
 */

import { loadConfig } from "../src/config.js";

loadConfig({
  ...process.env,
  PROXY_API_KEY: process.env.PROXY_API_KEY ?? "sk-proxy-e2e-test-key",
  GITHUB_OAUTH_TOKEN: process.env.GITHUB_OAUTH_TOKEN ?? "",
  PORT: process.env.PORT ?? "19234",
} as any);

import { copilotFetch } from "../src/upstream/client.js";
import { codingCases, type CodingCase } from "./coding-cases.js";
import { writeFileSync } from "fs";

const MODELS = ["gpt-5-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini", "oswe-vscode-prime"];
const CASE_BATCH = 4;

async function chatComplete(model: string, prompt: string): Promise<string> {
  const res = await copilotFetch("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2048,
      temperature: 0,
    }),
  });
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content ?? "";
}

export interface CaseResponse {
  caseName: string;
  difficulty: string;
  prompt: string;
  rubric: string;
  model: string;
  response: string;
  latencyMs: number;
}

async function runCase(tc: CodingCase): Promise<CaseResponse[]> {
  const responses = await Promise.all(
    MODELS.map(async (model) => {
      const start = performance.now();
      const response = await chatComplete(model, tc.prompt);
      return {
        caseName: tc.name,
        difficulty: tc.difficulty,
        prompt: tc.prompt,
        rubric: tc.rubric,
        model,
        response,
        latencyMs: Math.round(performance.now() - start),
      };
    }),
  );
  return responses;
}

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log(`║  CODING BENCH: ${codingCases.length} tasks × ${MODELS.length} models`.padEnd(64) + "║");
  console.log(`║  ${codingCases.length * MODELS.length} code generation calls`.padEnd(64) + "║");
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");

  const dist = { easy: 0, medium: 0, hard: 0 };
  for (const c of codingCases) dist[c.difficulty]++;
  console.log(`Distribution: easy=${dist.easy} medium=${dist.medium} hard=${dist.hard}\n`);

  const allResponses: CaseResponse[] = [];
  const startTime = Date.now();

  for (let i = 0; i < codingCases.length; i += CASE_BATCH) {
    const batch = codingCases.slice(i, i + CASE_BATCH);
    const batchResults = await Promise.all(batch.map(runCase));
    for (const results of batchResults) allResponses.push(...results);

    const done = Math.min(i + CASE_BATCH, codingCases.length);
    process.stdout.write(`\r  ${done}/${codingCases.length} cases done`);
  }
  console.log();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\nCompleted in ${elapsed}s — ${allResponses.length} responses collected\n`);

  // Save to JSON
  const outPath = "bench/coding-responses.json";
  writeFileSync(outPath, JSON.stringify(allResponses, null, 2));
  console.log(`Saved to ${outPath}`);

  // Quick latency summary
  console.log("\nAvg latency per model:");
  for (const m of MODELS) {
    const mr = allResponses.filter((x) => x.model === m);
    const avg = Math.round(mr.reduce((s, x) => s + x.latencyMs, 0) / mr.length);
    console.log(`  ${m.padEnd(25)} ${avg}ms`);
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
