#!/usr/bin/env bun
/**
 * Multi-model comparison for the judgement engine.
 * Runs the same test cases across multiple free Copilot models.
 *
 * Usage: bun run bench/judge-compare.ts
 */

import { loadConfig } from "../src/config.js";

loadConfig({
  ...process.env,
  PROXY_API_KEY: process.env.PROXY_API_KEY ?? "sk-proxy-e2e-test-key",
  GITHUB_OAUTH_TOKEN: process.env.GITHUB_OAUTH_TOKEN ?? "",
  PORT: process.env.PORT ?? "19234",
} as any);

import { judge, type Complexity } from "../src/auto/judge.js";

const MODELS = ["gpt-5-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini"];

interface TestCase {
  name: string;
  messages: Array<{ role: string; content: string }>;
  expected: Complexity;
  tier: string; // grouping label
}

const cases: TestCase[] = [
  // ─── LOW (sample of 8) ───────────────────────────────────────────────
  { tier: "LOW", name: "simple math",        messages: [{ role: "user", content: "What is 2 + 2?" }], expected: "low" },
  { tier: "LOW", name: "greeting",           messages: [{ role: "user", content: "Hello! How are you?" }], expected: "low" },
  { tier: "LOW", name: "one-liner code",     messages: [{ role: "user", content: "Write a Python one-liner to reverse a string." }], expected: "low" },
  { tier: "LOW", name: "explain OAuth",      messages: [{ role: "user", content: "Explain how OAuth 2.0 authorization code flow works, step by step." }], expected: "low" },
  { tier: "LOW", name: "write debounce fn",  messages: [{ role: "user", content: "Write a TypeScript function that debounces any callback with a configurable delay. Include types." }], expected: "low" },
  { tier: "LOW", name: "priority queue",     messages: [{ role: "user", content: "Write a TypeScript class for a priority queue with insert, extractMin, and peek methods. Use a min-heap internally." }], expected: "low" },
  { tier: "LOW", name: "Redis vs Memcached", messages: [{ role: "user", content: "Compare Redis vs Memcached for session caching. When should I use each?" }], expected: "low" },
  { tier: "LOW", name: "Docker compose",     messages: [{ role: "user", content: "Write a docker-compose.yml for a Node.js app with PostgreSQL and Redis." }], expected: "low" },

  // ─── HARD (sample of 6) ──────────────────────────────────────────────
  { tier: "HARD", name: "REST API + tests",     messages: [{ role: "user", content: "Build a complete REST API for a todo app with Express: CRUD endpoints, input validation with Zod, error handling middleware, and integration tests with supertest. All files." }], expected: "hard" },
  { tier: "HARD", name: "CLI tool",             messages: [{ role: "user", content: "Build a CLI tool in TypeScript that watches a directory for file changes, debounces events, and syncs changed files to a remote server via SSH. Include argument parsing, config file support, and graceful shutdown." }], expected: "hard" },
  { tier: "HARD", name: "auth system",          messages: [{ role: "user", content: "Implement JWT authentication for an Express app: login/register endpoints, middleware for protected routes, refresh token rotation, password hashing, and rate limiting. Include the database schema and all route files." }], expected: "hard" },
  { tier: "HARD", name: "WebSocket chat",       messages: [{ role: "user", content: "Build a real-time chat system with WebSockets: server with rooms, authentication, message history from a database, typing indicators, and a React client component with reconnection logic." }], expected: "hard" },
  { tier: "HARD", name: "plugin system",        messages: [{ role: "user", content: "Design and implement a plugin system for a Node.js application: plugin interface, lifecycle hooks (init, start, stop), dependency resolution between plugins, config validation per plugin, and a plugin loader that discovers plugins from a directory." }], expected: "hard" },
  { tier: "HARD", name: "React data table",     messages: [{ role: "user", content: "Build a complete data table component in React with server-side pagination, column sorting, filtering, row selection, and CSV export. Include the component, custom hooks, types, and a mock API handler." }], expected: "hard" },

  // ─── EXTREME (all 8 — the problem area) ──────────────────────────────
  { tier: "EXTR", name: "distributed rate limiter", messages: [{ role: "user", content: "Design a distributed rate limiter service that works across multiple data centers. Cover the architecture, data structures, consistency model, failure modes, and provide code for the core algorithm. Include the API layer, storage backends (Redis cluster + local fallback), and monitoring." }], expected: "extreme" },
  { tier: "EXTR", name: "collaborative editor",     messages: [{ role: "user", content: "Design a real-time collaborative document editor like Google Docs. Cover the CRDT vs OT choice, WebSocket architecture, conflict resolution, persistence layer, and auth. Include TypeScript code for the core sync engine." }], expected: "extreme" },
  { tier: "EXTR", name: "monolith → microservices",  messages: [
    { role: "system", content: "You are a senior software architect reviewing a large Node.js monolith." },
    { role: "user", content: "Review our 50,000 LOC Express monolith and create a migration plan to break it into microservices. Identify bounded contexts, define service boundaries, plan the data migration strategy, design the inter-service communication, and outline the phased rollout with rollback procedures." },
  ], expected: "extreme" },
  { tier: "EXTR", name: "consensus algorithms",      messages: [{ role: "user", content: "Write a comprehensive analysis of consensus algorithms: compare Raft, Paxos, PBFT, and HotStuff. Cover their theoretical foundations, performance characteristics, fault tolerance guarantees, and real-world implementations. Include pseudocode for each." }], expected: "extreme" },
  { tier: "EXTR", name: "security audit",            messages: [{ role: "user", content: "Perform a comprehensive security audit of a typical REST API built with Express.js. Cover authentication/authorization flaws, injection vulnerabilities, rate limiting, CORS misconfigurations, dependency vulnerabilities, and provide a remediation plan with code examples for each issue." }], expected: "extreme" },
  { tier: "EXTR", name: "compiler/interpreter",      messages: [{ role: "user", content: "Implement a complete lexer and parser for a simple programming language with variables, functions, if/else, while loops, and arithmetic expressions. Use TypeScript, build a proper AST, and include error recovery. Then implement a tree-walking interpreter for the AST." }], expected: "extreme" },
  { tier: "EXTR", name: "SaaS database + ORM",       messages: [{ role: "user", content: "Design a complete database schema and query layer for a multi-tenant SaaS platform with row-level security, audit logging, soft deletes, full-text search, and real-time subscriptions. Include migrations, indexes, and the TypeScript ORM layer." }], expected: "extreme" },
  { tier: "EXTR", name: "ML pipeline E2E",           messages: [{ role: "user", content: "Design and implement an end-to-end ML pipeline for fraud detection: data preprocessing, feature engineering, model training with cross-validation, hyperparameter tuning, model serving API, A/B testing framework, and monitoring/alerting. Include Python code for each component." }], expected: "extreme" },
];

// ── Types ───────────────────────────────────────────────────────────────────

interface SingleResult {
  model: string;
  case_name: string;
  expected: Complexity;
  got: Complexity;
  correct: boolean;
  confidence: number;
  reasoning: string;
  latencyMs: number;
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function runModel(model: string): Promise<SingleResult[]> {
  const results: SingleResult[] = [];

  console.log(`\n${"─".repeat(62)}`);
  console.log(`  MODEL: ${model}`);
  console.log(`${"─".repeat(62)}`);

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]!;
    const prefix = `[${String(i + 1).padStart(2)}/${cases.length}]`;
    process.stdout.write(`${prefix} ${tc.tier} ${tc.name.padEnd(28)} `);

    try {
      const result = await judge(tc.messages, model);
      const correct = result.complexity === tc.expected;
      const icon = correct ? "✓" : "✗";
      const suffix = correct ? "" : ` (exp ${tc.expected})`;
      console.log(`${icon} ${result.complexity.padEnd(7)} ${result.confidence.toFixed(2)} ${result.latencyMs}ms${suffix}`);

      results.push({
        model,
        case_name: tc.name,
        expected: tc.expected,
        got: result.complexity,
        correct,
        confidence: result.confidence,
        reasoning: result.reasoning,
        latencyMs: result.latencyMs,
      });
    } catch (err: any) {
      console.log(`ERR ${err.message.slice(0, 60)}`);
      results.push({
        model,
        case_name: tc.name,
        expected: tc.expected,
        got: "low",
        correct: false,
        confidence: 0,
        reasoning: `Error: ${err.message}`,
        latencyMs: 0,
      });
    }
  }

  return results;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║      MULTI-MODEL JUDGEMENT COMPARISON                      ║");
  console.log("║  Testing: " + MODELS.join(", ").padEnd(48) + " ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`${cases.length} cases × ${MODELS.length} models = ${cases.length * MODELS.length} classifications`);

  const allResults: Map<string, SingleResult[]> = new Map();

  for (const model of MODELS) {
    const results = await runModel(model);
    allResults.set(model, results);
  }

  // ── Comparison table ──────────────────────────────────────────────────
  console.log("\n" + "═".repeat(78));
  console.log("COMPARISON SUMMARY");
  console.log("═".repeat(78));

  // Header
  const colW = 14;
  console.log("\n" + "".padEnd(18) + MODELS.map((m) => m.padStart(colW)).join(""));

  // Overall accuracy
  process.stdout.write("Overall accuracy".padEnd(18));
  for (const model of MODELS) {
    const r = allResults.get(model)!;
    const ok = r.filter((x) => x.correct).length;
    const pct = ((ok / r.length) * 100).toFixed(0);
    process.stdout.write(`${ok}/${r.length} (${pct}%)`.padStart(colW));
  }
  console.log();

  // Per-tier accuracy
  for (const tier of ["low", "hard", "extreme"] as Complexity[]) {
    process.stdout.write(`  ${tier}`.padEnd(18));
    for (const model of MODELS) {
      const r = allResults.get(model)!.filter((x) => x.expected === tier);
      if (r.length === 0) { process.stdout.write("N/A".padStart(colW)); continue; }
      const ok = r.filter((x) => x.correct).length;
      const pct = ((ok / r.length) * 100).toFixed(0);
      process.stdout.write(`${ok}/${r.length} (${pct}%)`.padStart(colW));
    }
    console.log();
  }

  // Avg latency
  process.stdout.write("Avg latency (ms)".padEnd(18));
  for (const model of MODELS) {
    const r = allResults.get(model)!;
    const avg = Math.round(r.reduce((s, x) => s + x.latencyMs, 0) / r.length);
    process.stdout.write(`${avg}`.padStart(colW));
  }
  console.log();

  // Avg confidence
  process.stdout.write("Avg confidence".padEnd(18));
  for (const model of MODELS) {
    const r = allResults.get(model)!;
    const avg = (r.reduce((s, x) => s + x.confidence, 0) / r.length).toFixed(2);
    process.stdout.write(`${avg}`.padStart(colW));
  }
  console.log();

  // Over/under escalation
  process.stdout.write("Over-escalated".padEnd(18));
  for (const model of MODELS) {
    const r = allResults.get(model)!;
    const over = r.filter((x) => !x.correct && tierN(x.got) > tierN(x.expected)).length;
    process.stdout.write(`${over}`.padStart(colW));
  }
  console.log();

  process.stdout.write("Under-escalated".padEnd(18));
  for (const model of MODELS) {
    const r = allResults.get(model)!;
    const under = r.filter((x) => !x.correct && tierN(x.got) < tierN(x.expected)).length;
    process.stdout.write(`${under}`.padStart(colW));
  }
  console.log();

  // ── Per-case comparison (extreme tier only — the problem area) ────────
  console.log("\n" + "═".repeat(78));
  console.log("EXTREME TIER DETAIL (the problem area)");
  console.log("═".repeat(78));

  const extremeCases = cases.filter((c) => c.expected === "extreme");

  console.log("\n" + "Case".padEnd(28) + MODELS.map((m) => m.padStart(colW)).join(""));
  console.log("─".repeat(28 + MODELS.length * colW));

  for (const tc of extremeCases) {
    process.stdout.write(tc.name.padEnd(28));
    for (const model of MODELS) {
      const r = allResults.get(model)!.find((x) => x.case_name === tc.name)!;
      const icon = r.correct ? "✓" : "✗";
      const label = `${icon} ${r.got}`;
      process.stdout.write(label.padStart(colW));
    }
    console.log();
  }

  // ── Winner ────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(78));

  let bestModel = "";
  let bestExtreme = -1;
  let bestOverall = -1;

  for (const model of MODELS) {
    const r = allResults.get(model)!;
    const extremeOk = r.filter((x) => x.expected === "extreme" && x.correct).length;
    const overall = r.filter((x) => x.correct).length;

    if (extremeOk > bestExtreme || (extremeOk === bestExtreme && overall > bestOverall)) {
      bestModel = model;
      bestExtreme = extremeOk;
      bestOverall = overall;
    }
  }

  console.log(`BEST EXTREME DETECTION: ${bestModel} (${bestExtreme}/${extremeCases.length} extreme correct, ${bestOverall}/${cases.length} overall)`);
  console.log("═".repeat(78));
}

function tierN(t: Complexity): number {
  return { low: 0, hard: 1, extreme: 2 }[t];
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
