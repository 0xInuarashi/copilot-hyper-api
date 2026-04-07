#!/usr/bin/env bun
/**
 * Benchmark for the judgement engine.
 * Tiers: low (gpt-5-mini) | hard (claude-sonnet-4.6) | extreme (claude-opus-4.6)
 *
 * Usage: bun run bench/judge-benchmark.ts
 */

import { loadConfig } from "../src/config.js";

loadConfig({
  ...process.env,
  PROXY_API_KEY: process.env.PROXY_API_KEY ?? "sk-proxy-e2e-test-key",
  GITHUB_OAUTH_TOKEN: process.env.GITHUB_OAUTH_TOKEN ?? "",
  PORT: process.env.PORT ?? "19234",
} as any);

import { judge, type Complexity } from "../src/auto/judge.js";

interface TestCase {
  name: string;
  messages: Array<{ role: string; content: string }>;
  expected: Complexity;
}

const cases: TestCase[] = [
  // ─── LOW — the bulk of requests ───────────────────────────────────────
  // trivial
  { name: "simple math",        messages: [{ role: "user", content: "What is 2 + 2?" }], expected: "low" },
  { name: "greeting",           messages: [{ role: "user", content: "Hello! How are you?" }], expected: "low" },
  { name: "translate word",     messages: [{ role: "user", content: "How do you say 'hello' in Japanese?" }], expected: "low" },
  { name: "capital lookup",     messages: [{ role: "user", content: "What is the capital of France?" }], expected: "low" },
  { name: "one-liner code",     messages: [{ role: "user", content: "Write a Python one-liner to reverse a string." }], expected: "low" },
  { name: "boolean question",   messages: [{ role: "user", content: "Is TypeScript a superset of JavaScript?" }], expected: "low" },
  { name: "unit conversion",    messages: [{ role: "user", content: "How many centimeters are in 5 inches?" }], expected: "low" },
  { name: "acronym",            messages: [{ role: "user", content: "What does REST stand for?" }], expected: "low" },

  // previously "medium" — now low
  { name: "explain OAuth",      messages: [{ role: "user", content: "Explain how OAuth 2.0 authorization code flow works, step by step." }], expected: "low" },
  { name: "write debounce fn",  messages: [{ role: "user", content: "Write a TypeScript function that debounces any callback with a configurable delay. Include types." }], expected: "low" },
  { name: "debug React error",  messages: [{ role: "user", content: "I'm getting 'Cannot read properties of undefined (reading map)' on line 42 of my React component. The state is fetched from an API. How do I fix this?" }], expected: "low" },
  { name: "Redis vs Memcached", messages: [{ role: "user", content: "Compare Redis vs Memcached for session caching. When should I use each?" }], expected: "low" },
  { name: "SQL query",          messages: [{ role: "user", content: "Write a SQL query that finds the top 5 customers by total spending in the last 30 days, joining orders and customers tables, with a having clause for minimum 3 orders." }], expected: "low" },
  { name: "regex + explain",    messages: [{ role: "user", content: "Write a regex that validates email addresses and explain each part of the pattern." }], expected: "low" },
  { name: "priority queue",     messages: [{ role: "user", content: "Write a TypeScript class for a priority queue with insert, extractMin, and peek methods. Use a min-heap internally." }], expected: "low" },
  { name: "git rebase vs merge",messages: [{ role: "user", content: "Explain the Git rebase workflow vs merge workflow. When should I use each? Give examples." }], expected: "low" },
  { name: "write unit test",    messages: [{ role: "user", content: "Write a Jest test suite for a function called `parseDate(str: string): Date` that handles ISO 8601, Unix timestamps, and relative dates like '2 days ago'." }], expected: "low" },
  { name: "Docker compose",     messages: [{ role: "user", content: "Write a docker-compose.yml for a Node.js app with PostgreSQL and Redis." }], expected: "low" },
  { name: "explain closures",   messages: [{ role: "user", content: "Explain JavaScript closures with 3 practical examples." }], expected: "low" },
  { name: "fix CORS error",     messages: [{ role: "user", content: "My Express API returns a CORS error when called from localhost:3000. How do I fix it?" }], expected: "low" },

  // ─── HARD — multi-part, interdependent ────────────────────────────────
  {
    name: "REST API + tests",
    messages: [{ role: "user", content: "Build a complete REST API for a todo app with Express: CRUD endpoints, input validation with Zod, error handling middleware, and integration tests with supertest. All files." }],
    expected: "hard",
  },
  {
    name: "CLI tool",
    messages: [{ role: "user", content: "Build a CLI tool in TypeScript that watches a directory for file changes, debounces events, and syncs changed files to a remote server via SSH. Include argument parsing, config file support, and graceful shutdown." }],
    expected: "hard",
  },
  {
    name: "auth system",
    messages: [{ role: "user", content: "Implement JWT authentication for an Express app: login/register endpoints, middleware for protected routes, refresh token rotation, password hashing, and rate limiting. Include the database schema and all route files." }],
    expected: "hard",
  },
  {
    name: "React feature",
    messages: [{ role: "user", content: "Build a complete data table component in React with server-side pagination, column sorting, filtering, row selection, and CSV export. Include the component, custom hooks, types, and a mock API handler." }],
    expected: "hard",
  },
  {
    name: "multi-file refactor",
    messages: [
      { role: "system", content: "You are refactoring a Node.js codebase." },
      { role: "user", content: "Refactor our authentication module from callbacks to async/await, update all 12 route handlers that depend on it, update the middleware chain, and ensure error propagation is correct across all files. Show me each file change." },
    ],
    expected: "hard",
  },
  {
    name: "WebSocket chat",
    messages: [{ role: "user", content: "Build a real-time chat system with WebSockets: server with rooms, authentication, message history from a database, typing indicators, and a React client component with reconnection logic." }],
    expected: "hard",
  },
  {
    name: "GitHub Actions CI/CD",
    messages: [{ role: "user", content: "Design a complete CI/CD pipeline with GitHub Actions for a monorepo: run tests per package only on changes, build Docker images, deploy to staging on PR merge, deploy to production on release tag, with rollback and Slack notifications." }],
    expected: "hard",
  },
  {
    name: "plugin system",
    messages: [{ role: "user", content: "Design and implement a plugin system for a Node.js application: plugin interface, lifecycle hooks (init, start, stop), dependency resolution between plugins, config validation per plugin, and a plugin loader that discovers plugins from a directory." }],
    expected: "hard",
  },

  // ─── EXTREME — architect-level ────────────────────────────────────────
  {
    name: "distributed rate limiter",
    messages: [{ role: "user", content: "Design a distributed rate limiter service that works across multiple data centers. Cover the architecture, data structures, consistency model, failure modes, and provide code for the core algorithm. Include the API layer, storage backends (Redis cluster + local fallback), and monitoring." }],
    expected: "extreme",
  },
  {
    name: "collaborative editor",
    messages: [{ role: "user", content: "Design a real-time collaborative document editor like Google Docs. Cover the CRDT vs OT choice, WebSocket architecture, conflict resolution, persistence layer, and auth. Include TypeScript code for the core sync engine." }],
    expected: "extreme",
  },
  {
    name: "monolith → microservices",
    messages: [
      { role: "system", content: "You are a senior software architect reviewing a large Node.js monolith." },
      { role: "user", content: "Review our 50,000 LOC Express monolith and create a migration plan to break it into microservices. Identify bounded contexts, define service boundaries, plan the data migration strategy, design the inter-service communication, and outline the phased rollout with rollback procedures." },
    ],
    expected: "extreme",
  },
  {
    name: "consensus algorithms",
    messages: [{ role: "user", content: "Write a comprehensive analysis of consensus algorithms: compare Raft, Paxos, PBFT, and HotStuff. Cover their theoretical foundations, performance characteristics, fault tolerance guarantees, and real-world implementations. Include pseudocode for each." }],
    expected: "extreme",
  },
  {
    name: "security audit",
    messages: [{ role: "user", content: "Perform a comprehensive security audit of a typical REST API built with Express.js. Cover authentication/authorization flaws, injection vulnerabilities, rate limiting, CORS misconfigurations, dependency vulnerabilities, and provide a remediation plan with code examples for each issue." }],
    expected: "extreme",
  },
  {
    name: "compiler/interpreter",
    messages: [{ role: "user", content: "Implement a complete lexer and parser for a simple programming language with variables, functions, if/else, while loops, and arithmetic expressions. Use TypeScript, build a proper AST, and include error recovery. Then implement a tree-walking interpreter for the AST." }],
    expected: "extreme",
  },
  {
    name: "SaaS database + ORM",
    messages: [{ role: "user", content: "Design a complete database schema and query layer for a multi-tenant SaaS platform with row-level security, audit logging, soft deletes, full-text search, and real-time subscriptions. Include migrations, indexes, and the TypeScript ORM layer." }],
    expected: "extreme",
  },
  {
    name: "ML pipeline E2E",
    messages: [{ role: "user", content: "Design and implement an end-to-end ML pipeline for fraud detection: data preprocessing, feature engineering, model training with cross-validation, hyperparameter tuning, model serving API, A/B testing framework, and monitoring/alerting. Include Python code for each component." }],
    expected: "extreme",
  },
];

// ── Runner ──────────────────────────────────────────────────────────────────

interface Result {
  name: string;
  expected: Complexity;
  got: Complexity;
  correct: boolean;
  confidence: number;
  reasoning: string;
  latencyMs: number;
}

const TIER_LABEL: Record<Complexity, string> = { low: "low ", hard: "hard", extreme: "extr" };

async function runBenchmark() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║       JUDGEMENT ENGINE BENCHMARK v2 (gpt-5-mini)           ║");
  console.log("║  low → gpt-5-mini | hard → sonnet-4.6 | extreme → opus-4.6║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`Running ${cases.length} test cases...\n`);

  const results: Result[] = [];
  const tierCounts: Record<Complexity, number> = { low: 0, hard: 0, extreme: 0 };
  const tierCorrect: Record<Complexity, number> = { low: 0, hard: 0, extreme: 0 };

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]!;
    tierCounts[tc.expected]++;

    const prefix = `[${String(i + 1).padStart(2)}/${cases.length}]`;
    process.stdout.write(`${prefix} ${tc.name.padEnd(25)} `);

    try {
      const result = await judge(tc.messages);
      const correct = result.complexity === tc.expected;
      if (correct) tierCorrect[tc.expected]++;

      const icon = correct ? "✓" : "✗";
      const arrow = correct ? "" : ` (expected ${tc.expected})`;
      console.log(
        `${icon} ${TIER_LABEL[result.complexity]} conf=${result.confidence.toFixed(2)} ${result.latencyMs}ms${arrow}`,
      );

      if (!correct) {
        console.log(`       → ${result.reasoning}`);
      }

      results.push({
        name: tc.name,
        expected: tc.expected,
        got: result.complexity,
        correct,
        confidence: result.confidence,
        reasoning: result.reasoning,
        latencyMs: result.latencyMs,
      });
    } catch (err: any) {
      console.log(`ERROR: ${err.message}`);
      results.push({
        name: tc.name,
        expected: tc.expected,
        got: "low",
        correct: false,
        confidence: 0,
        reasoning: `Error: ${err.message}`,
        latencyMs: 0,
      });
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const accuracy = ((correct / total) * 100).toFixed(1);
  const avgLatency = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / total);
  const avgConfidence = (results.reduce((s, r) => s + r.confidence, 0) / total).toFixed(2);

  console.log("\n" + "═".repeat(62));
  console.log("RESULTS SUMMARY");
  console.log("═".repeat(62));
  console.log(`Overall accuracy:   ${correct}/${total} (${accuracy}%)`);
  console.log(`Average latency:    ${avgLatency}ms`);
  console.log(`Average confidence: ${avgConfidence}`);
  console.log();

  for (const tier of ["low", "hard", "extreme"] as Complexity[]) {
    const count = tierCounts[tier];
    const ok = tierCorrect[tier];
    const pct = count > 0 ? ((ok / count) * 100).toFixed(0) : "N/A";
    console.log(`  ${tier.padEnd(7)} ${ok}/${count} (${pct}%)`);
  }

  // ── Confusion matrix ──────────────────────────────────────────────────
  console.log("\nConfusion matrix (rows=expected, cols=predicted):");
  console.log("          low   hard  extr");
  for (const expected of ["low", "hard", "extreme"] as Complexity[]) {
    const row = results.filter((r) => r.expected === expected);
    const lo = row.filter((r) => r.got === "low").length;
    const ha = row.filter((r) => r.got === "hard").length;
    const ex = row.filter((r) => r.got === "extreme").length;
    console.log(`  ${expected.padEnd(7)}  ${String(lo).padStart(3)}   ${String(ha).padStart(3)}   ${String(ex).padStart(3)}`);
  }

  // ── Cost analysis ─────────────────────────────────────────────────────
  const overEscalated = results.filter((r) => !r.correct && tierOrder(r.got) > tierOrder(r.expected));
  const underEscalated = results.filter((r) => !r.correct && tierOrder(r.got) < tierOrder(r.expected));

  console.log(`\nOver-escalated (wasted cost):  ${overEscalated.length}`);
  for (const f of overEscalated) {
    console.log(`  ${f.name}: ${f.expected}→${f.got} — ${f.reasoning}`);
  }
  console.log(`Under-escalated (quality risk): ${underEscalated.length}`);
  for (const f of underEscalated) {
    console.log(`  ${f.name}: ${f.expected}→${f.got} — ${f.reasoning}`);
  }

  // ── All failures ──────────────────────────────────────────────────────
  const failures = results.filter((r) => !r.correct);
  if (failures.length > 0) {
    console.log(`\nAll misclassifications (${failures.length}):`);
    for (const f of failures) {
      console.log(`  ${f.name}: expected=${f.expected} got=${f.got} conf=${f.confidence.toFixed(2)}`);
      console.log(`    ${f.reasoning}`);
    }
  }

  console.log("\n" + "═".repeat(62));
  process.exit(Number(accuracy) >= 75 ? 0 : 1);
}

function tierOrder(t: Complexity): number {
  return { low: 0, hard: 1, extreme: 2 }[t];
}

runBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
