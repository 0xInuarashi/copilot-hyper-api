#!/usr/bin/env bun
/**
 * Multi-model comparison for complexity + length routing.
 * Tests: gpt-5-mini, gpt-4.1, gpt-4o, gpt-4o-mini, oswe-vscode-prime (raptor mini)
 *
 * Usage: bun run bench/judge-length-compare.ts
 */

import { loadConfig } from "../src/config.js";

loadConfig({
  ...process.env,
  PROXY_API_KEY: process.env.PROXY_API_KEY ?? "sk-proxy-e2e-test-key",
  GITHUB_OAUTH_TOKEN: process.env.GITHUB_OAUTH_TOKEN ?? "",
  PORT: process.env.PORT ?? "19234",
} as any);

import { judge, routeModel, type Complexity, type ExpectedLength } from "../src/auto/judge.js";

const MODELS = ["gpt-5-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini", "oswe-vscode-prime"];

interface TestCase {
  name: string;
  bucket: string;
  messages: Array<{ role: string; content: string }>;
  expectedC: Complexity;
  expectedL: ExpectedLength;
  expectedRoute: string;
}

function r(c: Complexity, l: ExpectedLength) { return routeModel(c, l); }

const cases: TestCase[] = [
  // ─── LOW + SHORT → free ──────────────────────────────────────────────
  { bucket: "low+S", name: "simple math",      messages: [{ role: "user", content: "What is 2 + 2?" }], expectedC: "low", expectedL: "short", expectedRoute: r("low","short") },
  { bucket: "low+S", name: "greeting",         messages: [{ role: "user", content: "Hello! How are you?" }], expectedC: "low", expectedL: "short", expectedRoute: r("low","short") },
  { bucket: "low+S", name: "one-liner code",   messages: [{ role: "user", content: "Write a Python one-liner to reverse a string." }], expectedC: "low", expectedL: "short", expectedRoute: r("low","short") },
  { bucket: "low+S", name: "acronym",          messages: [{ role: "user", content: "What does REST stand for?" }], expectedC: "low", expectedL: "short", expectedRoute: r("low","short") },
  { bucket: "low+S", name: "fix CORS",         messages: [{ role: "user", content: "My Express API returns a CORS error when called from localhost:3000. How do I fix it?" }], expectedC: "low", expectedL: "short", expectedRoute: r("low","short") },
  { bucket: "low+S", name: "debug React",      messages: [{ role: "user", content: "I'm getting 'Cannot read properties of undefined (reading map)' on line 42 of my React component. The state is fetched from an API. How do I fix this?" }], expectedC: "low", expectedL: "short", expectedRoute: r("low","short") },

  // ─── LOW + LONG → free ──────────────────────────────────────────────
  { bucket: "low+L", name: "explain OAuth",    messages: [{ role: "user", content: "Explain how OAuth 2.0 authorization code flow works, step by step." }], expectedC: "low", expectedL: "long", expectedRoute: r("low","long") },
  { bucket: "low+L", name: "priority queue",   messages: [{ role: "user", content: "Write a TypeScript class for a priority queue with insert, extractMin, and peek methods. Use a min-heap internally." }], expectedC: "low", expectedL: "long", expectedRoute: r("low","long") },
  { bucket: "low+L", name: "Redis vs Memcached", messages: [{ role: "user", content: "Compare Redis vs Memcached for session caching. When should I use each?" }], expectedC: "low", expectedL: "long", expectedRoute: r("low","long") },
  { bucket: "low+L", name: "closures + examples", messages: [{ role: "user", content: "Explain JavaScript closures with 3 practical examples." }], expectedC: "low", expectedL: "long", expectedRoute: r("low","long") },
  { bucket: "low+L", name: "git rebase vs merge", messages: [{ role: "user", content: "Explain the Git rebase workflow vs merge workflow. When should I use each? Give examples." }], expectedC: "low", expectedL: "long", expectedRoute: r("low","long") },

  // ─── HARD + SHORT → free ─────────────────────────────────────────────
  { bucket: "hard+S", name: "refactor strategy", messages: [
    { role: "system", content: "You are a senior engineer." },
    { role: "user", content: "Our auth middleware uses callbacks and we need to migrate to async/await. There are 12 route handlers that depend on it. What's the safest migration strategy? Don't write the code, just the plan." },
  ], expectedC: "hard", expectedL: "short", expectedRoute: r("hard","short") },
  { bucket: "hard+S", name: "CI/CD decision", messages: [{ role: "user", content: "We have a monorepo with 5 packages. Should we use Turborepo, Nx, or Bazel for CI? We deploy to AWS ECS. Give me your recommendation with tradeoffs, not the implementation." }], expectedC: "hard", expectedL: "short", expectedRoute: r("hard","short") },
  { bucket: "hard+S", name: "schema review", messages: [{ role: "user", content: "Review this schema decision: we're putting user preferences as a JSONB column in the users table instead of a separate table. We have 2M users and preferences are read on every request. Is this the right call? What are the tradeoffs?" }], expectedC: "hard", expectedL: "short", expectedRoute: r("hard","short") },

  // ─── HARD + LONG → sonnet ────────────────────────────────────────────
  { bucket: "hard+L", name: "REST API + tests", messages: [{ role: "user", content: "Build a complete REST API for a todo app with Express: CRUD endpoints, input validation with Zod, error handling middleware, and integration tests with supertest. All files." }], expectedC: "hard", expectedL: "long", expectedRoute: r("hard","long") },
  { bucket: "hard+L", name: "CLI tool",         messages: [{ role: "user", content: "Build a CLI tool in TypeScript that watches a directory for file changes, debounces events, and syncs changed files to a remote server via SSH. Include argument parsing, config file support, and graceful shutdown." }], expectedC: "hard", expectedL: "long", expectedRoute: r("hard","long") },
  { bucket: "hard+L", name: "auth system",      messages: [{ role: "user", content: "Implement JWT authentication for an Express app: login/register endpoints, middleware for protected routes, refresh token rotation, password hashing, and rate limiting. Include the database schema and all route files." }], expectedC: "hard", expectedL: "long", expectedRoute: r("hard","long") },
  { bucket: "hard+L", name: "WebSocket chat",   messages: [{ role: "user", content: "Build a real-time chat system with WebSockets: server with rooms, authentication, message history from a database, typing indicators, and a React client component with reconnection logic." }], expectedC: "hard", expectedL: "long", expectedRoute: r("hard","long") },

  // ─── EXTREME + SHORT → sonnet ────────────────────────────────────────
  { bucket: "extr+S", name: "rate limiter algo", messages: [{ role: "user", content: "Design a distributed rate limiting algorithm that works across multiple data centers with eventual consistency. Give me the core algorithm and the consistency model, not the full implementation." }], expectedC: "extreme", expectedL: "short", expectedRoute: r("extreme","short") },
  { bucket: "extr+S", name: "CRDT vs OT",       messages: [{ role: "user", content: "We're building a collaborative editor. Compare CRDTs vs OT for our use case: 50 concurrent editors, rich text, offline support needed. Give me your architecture recommendation with reasoning, not the implementation." }], expectedC: "extreme", expectedL: "short", expectedRoute: r("extreme","short") },
  { bucket: "extr+S", name: "service boundaries", messages: [
    { role: "system", content: "You are reviewing a 50k LOC Express monolith." },
    { role: "user", content: "Identify the bounded contexts and propose service boundaries for breaking this into microservices. Just the boundaries and communication patterns, not the migration plan or code." },
  ], expectedC: "extreme", expectedL: "short", expectedRoute: r("extreme","short") },
  { bucket: "extr+S", name: "consensus pick",   messages: [{ role: "user", content: "We need to choose a consensus algorithm for our distributed KV store. Compare Raft vs Paxos for our case: 5 nodes, strong consistency required, ~10k writes/sec. Which one and why?" }], expectedC: "extreme", expectedL: "short", expectedRoute: r("extreme","short") },

  // ─── EXTREME + LONG → opus ───────────────────────────────────────────
  { bucket: "extr+L", name: "rate limiter FULL",  messages: [{ role: "user", content: "Design a distributed rate limiter service that works across multiple data centers. Cover the architecture, data structures, consistency model, failure modes, and provide code for the core algorithm. Include the API layer, storage backends (Redis cluster + local fallback), and monitoring." }], expectedC: "extreme", expectedL: "long", expectedRoute: r("extreme","long") },
  { bucket: "extr+L", name: "collab editor FULL", messages: [{ role: "user", content: "Design a real-time collaborative document editor like Google Docs. Cover the CRDT vs OT choice, WebSocket architecture, conflict resolution, persistence layer, and auth. Include TypeScript code for the core sync engine." }], expectedC: "extreme", expectedL: "long", expectedRoute: r("extreme","long") },
  { bucket: "extr+L", name: "monolith migrate",   messages: [
    { role: "system", content: "You are a senior software architect reviewing a large Node.js monolith." },
    { role: "user", content: "Review our 50,000 LOC Express monolith and create a migration plan to break it into microservices. Identify bounded contexts, define service boundaries, plan the data migration strategy, design the inter-service communication, and outline the phased rollout with rollback procedures." },
  ], expectedC: "extreme", expectedL: "long", expectedRoute: r("extreme","long") },
  { bucket: "extr+L", name: "security audit FULL", messages: [{ role: "user", content: "Perform a comprehensive security audit of a typical REST API built with Express.js. Cover authentication/authorization flaws, injection vulnerabilities, rate limiting, CORS misconfigurations, dependency vulnerabilities, and provide a remediation plan with code examples for each issue." }], expectedC: "extreme", expectedL: "long", expectedRoute: r("extreme","long") },
  { bucket: "extr+L", name: "SaaS DB FULL",       messages: [{ role: "user", content: "Design a complete database schema and query layer for a multi-tenant SaaS platform with row-level security, audit logging, soft deletes, full-text search, and real-time subscriptions. Include migrations, indexes, and the TypeScript ORM layer." }], expectedC: "extreme", expectedL: "long", expectedRoute: r("extreme","long") },
  { bucket: "extr+L", name: "ML pipeline FULL",   messages: [{ role: "user", content: "Design and implement an end-to-end ML pipeline for fraud detection: data preprocessing, feature engineering, model training with cross-validation, hyperparameter tuning, model serving API, A/B testing framework, and monitoring/alerting. Include Python code for each component." }], expectedC: "extreme", expectedL: "long", expectedRoute: r("extreme","long") },
];

// ── Types ───────────────────────────────────────────────────────────────────

interface SingleResult {
  model: string;
  name: string;
  bucket: string;
  expectedC: Complexity;
  expectedL: ExpectedLength;
  expectedRoute: string;
  gotC: Complexity;
  gotL: ExpectedLength;
  gotRoute: string;
  routeOk: boolean;
  complexityOk: boolean;
  lengthOk: boolean;
  confidence: number;
  reasoning: string;
  latencyMs: number;
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function runModel(model: string): Promise<SingleResult[]> {
  const results: SingleResult[] = [];

  console.log(`\n${"─".repeat(72)}`);
  console.log(`  ${model}`);
  console.log(`${"─".repeat(72)}`);

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]!;
    const prefix = `[${String(i + 1).padStart(2)}/${cases.length}]`;
    process.stdout.write(`${prefix} ${tc.bucket} ${tc.name.padEnd(22)} `);

    try {
      const res = await judge(tc.messages, model);
      const routeOk = res.routed === tc.expectedRoute;
      const cOk = res.complexity === tc.expectedC;
      const lOk = res.expectedLength === tc.expectedL;

      const cI = cOk ? "✓" : "✗";
      const lI = lOk ? "✓" : "✗";
      const rI = routeOk ? "✓" : "✗";
      const rl = res.routed.replace("claude-","").replace("4.6","").replace("gpt-5-mini","free");

      console.log(`${cI}${res.complexity.padEnd(7)} ${lI}${res.expectedLength.padEnd(5)} ${rI}→${rl.padEnd(8)} ${res.latencyMs}ms`);

      results.push({
        model, name: tc.name, bucket: tc.bucket,
        expectedC: tc.expectedC, expectedL: tc.expectedL, expectedRoute: tc.expectedRoute,
        gotC: res.complexity, gotL: res.expectedLength, gotRoute: res.routed,
        routeOk, complexityOk: cOk, lengthOk: lOk,
        confidence: res.confidence, reasoning: res.reasoning, latencyMs: res.latencyMs,
      });
    } catch (err: any) {
      console.log(`ERR ${err.message.slice(0, 50)}`);
      results.push({
        model, name: tc.name, bucket: tc.bucket,
        expectedC: tc.expectedC, expectedL: tc.expectedL, expectedRoute: tc.expectedRoute,
        gotC: "low", gotL: "short", gotRoute: "gpt-5-mini",
        routeOk: false, complexityOk: false, lengthOk: false,
        confidence: 0, reasoning: `Error: ${err.message}`, latencyMs: 0,
      });
    }
  }

  return results;
}

function tierN(t: Complexity): number { return { low: 0, hard: 1, extreme: 2 }[t]; }

async function main() {
  console.log("╔════════════════════════════════════════════════════════════════════════╗");
  console.log("║  MULTI-MODEL COMPLEXITY + LENGTH ROUTING COMPARISON                   ║");
  console.log("║  low→free | hard+S→free | hard+L→sonnet | extr+S→sonnet | extr+L→opus║");
  console.log("╚════════════════════════════════════════════════════════════════════════╝");
  console.log(`${cases.length} cases × ${MODELS.length} models = ${cases.length * MODELS.length} classifications\n`);

  const all: Map<string, SingleResult[]> = new Map();

  for (const model of MODELS) {
    all.set(model, await runModel(model));
  }

  // ── Comparison table ──────────────────────────────────────────────────
  const col = 16;
  const sep = "═".repeat(20 + MODELS.length * col);

  console.log("\n" + sep);
  console.log("COMPARISON — ROUTE ACCURACY (the metric that matters)");
  console.log(sep);

  console.log("\n" + "".padEnd(20) + MODELS.map((m) => m.padStart(col)).join(""));

  // Route accuracy
  process.stdout.write("ROUTE accuracy".padEnd(20));
  for (const m of MODELS) {
    const r = all.get(m)!;
    const ok = r.filter((x) => x.routeOk).length;
    process.stdout.write(`${ok}/${r.length} (${((ok/r.length)*100).toFixed(0)}%)`.padStart(col));
  }
  console.log();

  // Complexity accuracy
  process.stdout.write("Complexity acc".padEnd(20));
  for (const m of MODELS) {
    const r = all.get(m)!;
    const ok = r.filter((x) => x.complexityOk).length;
    process.stdout.write(`${ok}/${r.length} (${((ok/r.length)*100).toFixed(0)}%)`.padStart(col));
  }
  console.log();

  // Length accuracy
  process.stdout.write("Length acc".padEnd(20));
  for (const m of MODELS) {
    const r = all.get(m)!;
    const ok = r.filter((x) => x.lengthOk).length;
    process.stdout.write(`${ok}/${r.length} (${((ok/r.length)*100).toFixed(0)}%)`.padStart(col));
  }
  console.log();

  // Per-bucket route accuracy
  const buckets = [
    { label: "low+S→free",   c: "low" as Complexity,     l: "short" as ExpectedLength },
    { label: "low+L→free",   c: "low" as Complexity,     l: "long" as ExpectedLength },
    { label: "hard+S→free",  c: "hard" as Complexity,    l: "short" as ExpectedLength },
    { label: "hard+L→sonnet",c: "hard" as Complexity,    l: "long" as ExpectedLength },
    { label: "extr+S→sonnet",c: "extreme" as Complexity, l: "short" as ExpectedLength },
    { label: "extr+L→opus",  c: "extreme" as Complexity, l: "long" as ExpectedLength },
  ];

  console.log();
  for (const b of buckets) {
    process.stdout.write(`  ${b.label.padEnd(18)}`);
    for (const m of MODELS) {
      const bucket = all.get(m)!.filter((x) => x.expectedC === b.c && x.expectedL === b.l);
      if (bucket.length === 0) { process.stdout.write("—".padStart(col)); continue; }
      const ok = bucket.filter((x) => x.routeOk).length;
      process.stdout.write(`${ok}/${bucket.length} (${((ok/bucket.length)*100).toFixed(0)}%)`.padStart(col));
    }
    console.log();
  }

  // Latency
  console.log();
  process.stdout.write("Avg latency (ms)".padEnd(20));
  for (const m of MODELS) {
    const r = all.get(m)!;
    process.stdout.write(`${Math.round(r.reduce((s,x) => s + x.latencyMs, 0) / r.length)}`.padStart(col));
  }
  console.log();

  // Over/under escalation (cost)
  process.stdout.write("Opus waste".padEnd(20));
  for (const m of MODELS) {
    const r = all.get(m)!;
    const w = r.filter((x) => !x.routeOk && x.gotRoute === "claude-opus-4.6" && x.expectedRoute !== "claude-opus-4.6").length;
    process.stdout.write(`${w}`.padStart(col));
  }
  console.log();

  process.stdout.write("Paid when free".padEnd(20));
  for (const m of MODELS) {
    const r = all.get(m)!;
    const w = r.filter((x) => !x.routeOk && x.gotRoute !== "gpt-5-mini" && x.expectedRoute === "gpt-5-mini").length;
    process.stdout.write(`${w}`.padStart(col));
  }
  console.log();

  process.stdout.write("Free when paid".padEnd(20));
  for (const m of MODELS) {
    const r = all.get(m)!;
    const w = r.filter((x) => !x.routeOk && x.gotRoute === "gpt-5-mini" && x.expectedRoute !== "gpt-5-mini").length;
    process.stdout.write(`${w}`.padStart(col));
  }
  console.log();

  // ── Extreme+short detail (problem area) ───────────────────────────────
  const extrShort = cases.filter((c) => c.expectedC === "extreme" && c.expectedL === "short");
  const extrLong = cases.filter((c) => c.expectedC === "extreme" && c.expectedL === "long");

  console.log("\n" + sep);
  console.log("EXTREME TIER DETAIL");
  console.log(sep);

  console.log("\nExtreme+SHORT (should → sonnet):");
  console.log("".padEnd(24) + MODELS.map((m) => m.padStart(col)).join(""));
  for (const tc of extrShort) {
    process.stdout.write(tc.name.padEnd(24));
    for (const m of MODELS) {
      const res = all.get(m)!.find((x) => x.name === tc.name)!;
      const rl = res.gotRoute.replace("claude-","").replace("4.6","").replace("gpt-5-mini","free");
      const icon = res.routeOk ? "✓" : "✗";
      process.stdout.write(`${icon} ${rl}`.padStart(col));
    }
    console.log();
  }

  console.log("\nExtreme+LONG (should → opus):");
  console.log("".padEnd(24) + MODELS.map((m) => m.padStart(col)).join(""));
  for (const tc of extrLong) {
    process.stdout.write(tc.name.padEnd(24));
    for (const m of MODELS) {
      const res = all.get(m)!.find((x) => x.name === tc.name)!;
      const rl = res.gotRoute.replace("claude-","").replace("4.6","").replace("gpt-5-mini","free");
      const icon = res.routeOk ? "✓" : "✗";
      process.stdout.write(`${icon} ${rl}`.padStart(col));
    }
    console.log();
  }

  // ── Winner ────────────────────────────────────────────────────────────
  console.log("\n" + sep);

  let bestModel = "";
  let bestRoute = -1;
  let bestLat = Infinity;

  for (const m of MODELS) {
    const r = all.get(m)!;
    const routeOk = r.filter((x) => x.routeOk).length;
    const avgLat = r.reduce((s,x) => s + x.latencyMs, 0) / r.length;
    if (routeOk > bestRoute || (routeOk === bestRoute && avgLat < bestLat)) {
      bestModel = m;
      bestRoute = routeOk;
      bestLat = avgLat;
    }
  }

  console.log(`BEST ROUTER: ${bestModel} (${bestRoute}/${cases.length} correct routes, ${Math.round(bestLat)}ms avg)`);
  console.log(sep);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
