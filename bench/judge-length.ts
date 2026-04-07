#!/usr/bin/env bun
/**
 * Benchmark for length classification + combined routing.
 * Tests whether gpt-4o can reliably distinguish short vs long expected output,
 * and whether the final routing decision (free/sonnet/opus) is correct.
 *
 * Usage: bun run bench/judge-length.ts
 */

import { loadConfig } from "../src/config.js";

loadConfig({
  ...process.env,
  PROXY_API_KEY: process.env.PROXY_API_KEY ?? "sk-proxy-e2e-test-key",
  GITHUB_OAUTH_TOKEN: process.env.GITHUB_OAUTH_TOKEN ?? "",
  PORT: process.env.PORT ?? "19234",
} as any);

import { judge, routeModel, type Complexity, type ExpectedLength } from "../src/auto/judge.js";

interface TestCase {
  name: string;
  messages: Array<{ role: string; content: string }>;
  expectedComplexity: Complexity;
  expectedLength: ExpectedLength;
  expectedRoute: string; // the model it SHOULD route to
}

function route(c: Complexity, l: ExpectedLength): string { return routeModel(c, l); }

const cases: TestCase[] = [
  // ─── LOW + SHORT → free ──────────────────────────────────────────────
  {
    name: "simple math",
    messages: [{ role: "user", content: "What is 2 + 2?" }],
    expectedComplexity: "low", expectedLength: "short",
    expectedRoute: route("low", "short"),
  },
  {
    name: "greeting",
    messages: [{ role: "user", content: "Hello! How are you?" }],
    expectedComplexity: "low", expectedLength: "short",
    expectedRoute: route("low", "short"),
  },
  {
    name: "one-liner code",
    messages: [{ role: "user", content: "Write a Python one-liner to reverse a string." }],
    expectedComplexity: "low", expectedLength: "short",
    expectedRoute: route("low", "short"),
  },
  {
    name: "acronym",
    messages: [{ role: "user", content: "What does REST stand for?" }],
    expectedComplexity: "low", expectedLength: "short",
    expectedRoute: route("low", "short"),
  },
  {
    name: "fix CORS error",
    messages: [{ role: "user", content: "My Express API returns a CORS error when called from localhost:3000. How do I fix it?" }],
    expectedComplexity: "low", expectedLength: "short",
    expectedRoute: route("low", "short"),
  },
  {
    name: "debug React error",
    messages: [{ role: "user", content: "I'm getting 'Cannot read properties of undefined (reading map)' on line 42 of my React component. The state is fetched from an API. How do I fix this?" }],
    expectedComplexity: "low", expectedLength: "short",
    expectedRoute: route("low", "short"),
  },

  // ─── LOW + LONG → free (still free! length doesn't matter for low) ──
  {
    name: "explain OAuth",
    messages: [{ role: "user", content: "Explain how OAuth 2.0 authorization code flow works, step by step." }],
    expectedComplexity: "low", expectedLength: "long",
    expectedRoute: route("low", "long"),
  },
  {
    name: "priority queue class",
    messages: [{ role: "user", content: "Write a TypeScript class for a priority queue with insert, extractMin, and peek methods. Use a min-heap internally." }],
    expectedComplexity: "low", expectedLength: "long",
    expectedRoute: route("low", "long"),
  },
  {
    name: "Redis vs Memcached",
    messages: [{ role: "user", content: "Compare Redis vs Memcached for session caching. When should I use each?" }],
    expectedComplexity: "low", expectedLength: "long",
    expectedRoute: route("low", "long"),
  },
  {
    name: "explain closures + examples",
    messages: [{ role: "user", content: "Explain JavaScript closures with 3 practical examples." }],
    expectedComplexity: "low", expectedLength: "long",
    expectedRoute: route("low", "long"),
  },
  {
    name: "git rebase vs merge",
    messages: [{ role: "user", content: "Explain the Git rebase workflow vs merge workflow. When should I use each? Give examples." }],
    expectedComplexity: "low", expectedLength: "long",
    expectedRoute: route("low", "long"),
  },

  // ─── HARD + SHORT → sonnet ──────────────────────────────────────────
  {
    name: "refactor strategy",
    messages: [
      { role: "system", content: "You are a senior engineer." },
      { role: "user", content: "Our auth middleware uses callbacks and we need to migrate to async/await. There are 12 route handlers that depend on it. What's the safest migration strategy? Don't write the code, just the plan." },
    ],
    expectedComplexity: "hard", expectedLength: "short",
    expectedRoute: route("hard", "short"),
  },
  {
    name: "CI/CD architecture decision",
    messages: [{ role: "user", content: "We have a monorepo with 5 packages. Should we use Turborepo, Nx, or Bazel for CI? We deploy to AWS ECS. Give me your recommendation with tradeoffs, not the implementation." }],
    expectedComplexity: "hard", expectedLength: "short",
    expectedRoute: route("hard", "short"),
  },
  {
    name: "database schema review",
    messages: [{ role: "user", content: "Review this schema decision: we're putting user preferences as a JSONB column in the users table instead of a separate table. We have 2M users and preferences are read on every request. Is this the right call? What are the tradeoffs?" }],
    expectedComplexity: "hard", expectedLength: "short",
    expectedRoute: route("hard", "short"),
  },

  // ─── HARD + LONG → sonnet ───────────────────────────────────────────
  {
    name: "REST API + tests",
    messages: [{ role: "user", content: "Build a complete REST API for a todo app with Express: CRUD endpoints, input validation with Zod, error handling middleware, and integration tests with supertest. All files." }],
    expectedComplexity: "hard", expectedLength: "long",
    expectedRoute: route("hard", "long"),
  },
  {
    name: "CLI tool full impl",
    messages: [{ role: "user", content: "Build a CLI tool in TypeScript that watches a directory for file changes, debounces events, and syncs changed files to a remote server via SSH. Include argument parsing, config file support, and graceful shutdown." }],
    expectedComplexity: "hard", expectedLength: "long",
    expectedRoute: route("hard", "long"),
  },
  {
    name: "auth system",
    messages: [{ role: "user", content: "Implement JWT authentication for an Express app: login/register endpoints, middleware for protected routes, refresh token rotation, password hashing, and rate limiting. Include the database schema and all route files." }],
    expectedComplexity: "hard", expectedLength: "long",
    expectedRoute: route("hard", "long"),
  },
  {
    name: "WebSocket chat",
    messages: [{ role: "user", content: "Build a real-time chat system with WebSockets: server with rooms, authentication, message history from a database, typing indicators, and a React client component with reconnection logic." }],
    expectedComplexity: "hard", expectedLength: "long",
    expectedRoute: route("hard", "long"),
  },

  // ─── EXTREME + SHORT → sonnet (not opus!) ───────────────────────────
  {
    name: "rate limiter algorithm",
    messages: [{ role: "user", content: "Design a distributed rate limiting algorithm that works across multiple data centers with eventual consistency. Give me the core algorithm and the consistency model, not the full implementation." }],
    expectedComplexity: "extreme", expectedLength: "short",
    expectedRoute: route("extreme", "short"),
  },
  {
    name: "CRDT vs OT decision",
    messages: [{ role: "user", content: "We're building a collaborative editor. Compare CRDTs vs OT for our use case: 50 concurrent editors, rich text, offline support needed. Give me your architecture recommendation with reasoning, not the implementation." }],
    expectedComplexity: "extreme", expectedLength: "short",
    expectedRoute: route("extreme", "short"),
  },
  {
    name: "microservices boundary",
    messages: [
      { role: "system", content: "You are reviewing a 50k LOC Express monolith." },
      { role: "user", content: "Identify the bounded contexts and propose service boundaries for breaking this into microservices. Just the boundaries and communication patterns, not the migration plan or code." },
    ],
    expectedComplexity: "extreme", expectedLength: "short",
    expectedRoute: route("extreme", "short"),
  },
  {
    name: "consensus tradeoffs",
    messages: [{ role: "user", content: "We need to choose a consensus algorithm for our distributed KV store. Compare Raft vs Paxos for our case: 5 nodes, strong consistency required, ~10k writes/sec. Which one and why?" }],
    expectedComplexity: "extreme", expectedLength: "short",
    expectedRoute: route("extreme", "short"),
  },

  // ─── EXTREME + LONG → opus (the ONLY path to opus) ─────────────────
  {
    name: "distributed rate limiter FULL",
    messages: [{ role: "user", content: "Design a distributed rate limiter service that works across multiple data centers. Cover the architecture, data structures, consistency model, failure modes, and provide code for the core algorithm. Include the API layer, storage backends (Redis cluster + local fallback), and monitoring." }],
    expectedComplexity: "extreme", expectedLength: "long",
    expectedRoute: route("extreme", "long"),
  },
  {
    name: "collaborative editor FULL",
    messages: [{ role: "user", content: "Design a real-time collaborative document editor like Google Docs. Cover the CRDT vs OT choice, WebSocket architecture, conflict resolution, persistence layer, and auth. Include TypeScript code for the core sync engine." }],
    expectedComplexity: "extreme", expectedLength: "long",
    expectedRoute: route("extreme", "long"),
  },
  {
    name: "monolith migration FULL",
    messages: [
      { role: "system", content: "You are a senior software architect reviewing a large Node.js monolith." },
      { role: "user", content: "Review our 50,000 LOC Express monolith and create a migration plan to break it into microservices. Identify bounded contexts, define service boundaries, plan the data migration strategy, design the inter-service communication, and outline the phased rollout with rollback procedures." },
    ],
    expectedComplexity: "extreme", expectedLength: "long",
    expectedRoute: route("extreme", "long"),
  },
  {
    name: "security audit FULL",
    messages: [{ role: "user", content: "Perform a comprehensive security audit of a typical REST API built with Express.js. Cover authentication/authorization flaws, injection vulnerabilities, rate limiting, CORS misconfigurations, dependency vulnerabilities, and provide a remediation plan with code examples for each issue." }],
    expectedComplexity: "extreme", expectedLength: "long",
    expectedRoute: route("extreme", "long"),
  },
  {
    name: "SaaS database FULL",
    messages: [{ role: "user", content: "Design a complete database schema and query layer for a multi-tenant SaaS platform with row-level security, audit logging, soft deletes, full-text search, and real-time subscriptions. Include migrations, indexes, and the TypeScript ORM layer." }],
    expectedComplexity: "extreme", expectedLength: "long",
    expectedRoute: route("extreme", "long"),
  },
  {
    name: "ML pipeline FULL",
    messages: [{ role: "user", content: "Design and implement an end-to-end ML pipeline for fraud detection: data preprocessing, feature engineering, model training with cross-validation, hyperparameter tuning, model serving API, A/B testing framework, and monitoring/alerting. Include Python code for each component." }],
    expectedComplexity: "extreme", expectedLength: "long",
    expectedRoute: route("extreme", "long"),
  },
];

// ── Runner ──────────────────────────────────────────────────────────────────

interface Result {
  name: string;
  expectedC: Complexity;
  expectedL: ExpectedLength;
  expectedRoute: string;
  gotC: Complexity;
  gotL: ExpectedLength;
  gotRoute: string;
  complexityOk: boolean;
  lengthOk: boolean;
  routeOk: boolean;
  confidence: number;
  reasoning: string;
  latencyMs: number;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  LENGTH + ROUTING BENCHMARK (gpt-4o judge)                 ║");
  console.log("║  low→free | hard→sonnet | extreme+short→sonnet | ext+long→opus║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`Running ${cases.length} test cases...\n`);

  const results: Result[] = [];

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]!;
    const prefix = `[${String(i + 1).padStart(2)}/${cases.length}]`;
    process.stdout.write(`${prefix} ${tc.name.padEnd(30)} `);

    try {
      const r = await judge(tc.messages);
      const complexityOk = r.complexity === tc.expectedComplexity;
      const lengthOk = r.expectedLength === tc.expectedLength;
      const routeOk = r.routed === tc.expectedRoute;

      const cIcon = complexityOk ? "✓" : "✗";
      const lIcon = lengthOk ? "✓" : "✗";
      const rIcon = routeOk ? "✓" : "✗";
      const routeLabel = r.routed.replace("claude-", "").replace("4.6", "");

      console.log(
        `${cIcon}${r.complexity.padEnd(7)} ${lIcon}${r.expectedLength.padEnd(5)} → ${rIcon} ${routeLabel.padEnd(12)} ${r.latencyMs}ms`,
      );

      if (!routeOk) {
        const expLabel = tc.expectedRoute.replace("claude-", "").replace("4.6", "");
        console.log(`       expected: ${tc.expectedComplexity}+${tc.expectedLength}→${expLabel} | ${r.reasoning}`);
      }

      results.push({
        name: tc.name,
        expectedC: tc.expectedComplexity,
        expectedL: tc.expectedLength,
        expectedRoute: tc.expectedRoute,
        gotC: r.complexity,
        gotL: r.expectedLength,
        gotRoute: r.routed,
        complexityOk,
        lengthOk,
        routeOk,
        confidence: r.confidence,
        reasoning: r.reasoning,
        latencyMs: r.latencyMs,
      });
    } catch (err: any) {
      console.log(`ERR: ${err.message.slice(0, 60)}`);
      results.push({
        name: tc.name, expectedC: tc.expectedComplexity, expectedL: tc.expectedLength,
        expectedRoute: tc.expectedRoute, gotC: "low", gotL: "short", gotRoute: "gpt-5-mini",
        complexityOk: false, lengthOk: false, routeOk: false, confidence: 0,
        reasoning: `Error: ${err.message}`, latencyMs: 0,
      });
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const total = results.length;
  const cOk = results.filter((r) => r.complexityOk).length;
  const lOk = results.filter((r) => r.lengthOk).length;
  const rOk = results.filter((r) => r.routeOk).length;
  const avgLat = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / total);

  console.log("\n" + "═".repeat(66));
  console.log("RESULTS SUMMARY");
  console.log("═".repeat(66));
  console.log(`Complexity accuracy:  ${cOk}/${total} (${((cOk / total) * 100).toFixed(0)}%)`);
  console.log(`Length accuracy:      ${lOk}/${total} (${((lOk / total) * 100).toFixed(0)}%)`);
  console.log(`ROUTE accuracy:       ${rOk}/${total} (${((rOk / total) * 100).toFixed(0)}%)  ← the one that matters`);
  console.log(`Average latency:      ${avgLat}ms`);

  // Per-bucket
  const buckets = [
    { label: "low+short→free",         c: "low" as Complexity,     l: "short" as ExpectedLength },
    { label: "low+long→free",          c: "low" as Complexity,     l: "long" as ExpectedLength },
    { label: "hard+short→sonnet",      c: "hard" as Complexity,    l: "short" as ExpectedLength },
    { label: "hard+long→sonnet",       c: "hard" as Complexity,    l: "long" as ExpectedLength },
    { label: "extreme+short→sonnet",   c: "extreme" as Complexity, l: "short" as ExpectedLength },
    { label: "extreme+long→opus",      c: "extreme" as Complexity, l: "long" as ExpectedLength },
  ];

  console.log("\nPer-bucket routing accuracy:");
  for (const b of buckets) {
    const bucket = results.filter((r) => r.expectedC === b.c && r.expectedL === b.l);
    if (bucket.length === 0) continue;
    const ok = bucket.filter((r) => r.routeOk).length;
    const pct = ((ok / bucket.length) * 100).toFixed(0);
    console.log(`  ${b.label.padEnd(26)} ${ok}/${bucket.length} (${pct}%)`);
  }

  // Cost analysis
  console.log("\nCost impact of misroutes:");
  const opusWaste = results.filter((r) => !r.routeOk && r.gotRoute === "claude-opus-4.6" && r.expectedRoute !== "claude-opus-4.6");
  const opusMissed = results.filter((r) => !r.routeOk && r.gotRoute !== "claude-opus-4.6" && r.expectedRoute === "claude-opus-4.6");
  const paidWaste = results.filter((r) => !r.routeOk && r.gotRoute !== "gpt-5-mini" && r.expectedRoute === "gpt-5-mini");

  console.log(`  Sent to opus unnecessarily:  ${opusWaste.length}`);
  for (const r of opusWaste) console.log(`    ${r.name}: should be ${r.expectedRoute}`);
  console.log(`  Should be opus but wasn't:   ${opusMissed.length}`);
  for (const r of opusMissed) console.log(`    ${r.name}: got ${r.gotRoute}`);
  console.log(`  Paid when should be free:    ${paidWaste.length}`);
  for (const r of paidWaste) console.log(`    ${r.name}: got ${r.gotRoute}`);

  // All misroutes
  const misroutes = results.filter((r) => !r.routeOk);
  if (misroutes.length > 0) {
    console.log(`\nAll misroutes (${misroutes.length}):`);
    for (const r of misroutes) {
      const exp = r.expectedRoute.replace("claude-", "").replace("4.6", "");
      const got = r.gotRoute.replace("claude-", "").replace("4.6", "");
      console.log(`  ${r.name}: ${r.expectedC}+${r.expectedL}→${exp} BUT got ${r.gotC}+${r.gotL}→${got}`);
      console.log(`    ${r.reasoning}`);
    }
  }

  console.log("\n" + "═".repeat(66));
  process.exit(rOk / total >= 0.8 ? 0 : 1);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
