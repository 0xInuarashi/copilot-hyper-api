import { loadConfig, getConfig } from "../config.js";
import { loadRecords, aggregate } from "../stats/aggregator.js";
import type { AggregatedStats, TokenStats } from "../stats/types.js";

loadConfig();
const config = getConfig();

if (!config.STATS_ENABLED) {
  console.error("Stats not enabled. Set STATS_ENABLED=true in .env");
  process.exit(1);
}

// Parse CLI args
const args = process.argv.slice(2);
let from: string | undefined;
let to: string | undefined;
let jsonMode = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--from" && args[i + 1]) from = args[++i];
  else if (args[i] === "--to" && args[i + 1]) to = args[++i];
  else if (args[i] === "--today") {
    from = to = new Date().toISOString().slice(0, 10);
  } else if (args[i] === "--json") jsonMode = true;
}

const records = loadRecords(config.STATS_DIR, from, to);
const stats = aggregate(records);

if (jsonMode) {
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
}

// Formatters
const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (n: number) => `${n.toFixed(1)}%`;
const pad = (s: string, w: number) => s.padEnd(w);
const padR = (s: string, w: number) => s.padStart(w);

function hr(char = "-", width = 60) {
  return char.repeat(width);
}

function section(title: string) {
  console.log(`\n  ${title}`);
  console.log(`  ${hr("─", title.length + 4)}`);
}

function kv(key: string, value: string, indent = 4) {
  console.log(`${" ".repeat(indent)}${pad(key, 24)} ${value}`);
}

function table(headers: string[], rows: string[][], colWidths: number[]) {
  const sep = "  +" + colWidths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const fmtRow = (cells: string[]) =>
    "  |" + cells.map((c, i) => ` ${i === 0 ? pad(c, colWidths[i]!) : padR(c, colWidths[i]!)} `).join("|") + "|";

  console.log(sep);
  console.log(fmtRow(headers));
  console.log(sep);
  for (const row of rows) console.log(fmtRow(row));
  console.log(sep);
}

function tokenStr(t: TokenStats) {
  return `${fmt(t.prompt)}p / ${fmt(t.completion)}c / ${fmt(t.total)}t`;
}

// Render
console.log();
console.log("  Copilot Hyper API Stats");
if (stats.period.from) {
  const days = stats.daily.length;
  console.log(`  Period: ${stats.period.from} .. ${stats.period.to} (${days} day${days !== 1 ? "s" : ""})`);
} else {
  console.log("  No data found.");
  process.exit(0);
}

// Overview
section("OVERVIEW");
kv("Total Requests", fmt(stats.total_requests));
kv("Total Errors", `${fmt(stats.total_errors)} (${pct(stats.error_rate)})`);
kv("Total Tokens", fmt(stats.tokens.total));
kv("Avg Latency", `${fmt(stats.latency.avg_ms)} ms`);
kv("P50 / P95 / P99", `${fmt(stats.latency.p50_ms)} / ${fmt(stats.latency.p95_ms)} / ${fmt(stats.latency.p99_ms)} ms`);
kv("Min / Max Latency", `${fmt(stats.latency.min_ms)} / ${fmt(stats.latency.max_ms)} ms`);

// Tokens
section("TOKENS");
kv("Prompt", `${fmt(stats.tokens.total_prompt)} (avg ${fmt(stats.tokens.avg_prompt_per_request)}/req, max ${fmt(stats.tokens.max_prompt)})`);
kv("Completion", `${fmt(stats.tokens.total_completion)} (avg ${fmt(stats.tokens.avg_completion_per_request)}/req, max ${fmt(stats.tokens.max_completion)})`);
kv("Total", `${fmt(stats.tokens.total)} (avg ${fmt(stats.tokens.avg_total_per_request)}/req)`);

// By Model
section("BY MODEL");
const modelRows = Object.entries(stats.by_model)
  .sort(([, a], [, b]) => b.requests - a.requests)
  .map(([model, s]) => [
    model,
    fmt(s.requests),
    fmt(s.tokens.total),
    fmt(s.avg_latency_ms),
    fmt(s.error_count),
    `${fmt(s.streaming_count)}/${fmt(s.buffered_count)}`,
  ]);
table(
  ["Model", "Reqs", "Tokens", "Avg ms", "Errs", "S/B"],
  modelRows,
  [24, 7, 10, 8, 5, 8],
);

// By Provider
section("BY PROVIDER");
for (const [prov, s] of Object.entries(stats.by_provider)) {
  const ratio = stats.total_requests > 0 ? pct((s.requests / stats.total_requests) * 100) : "0%";
  kv(prov, `${fmt(s.requests)} reqs (${ratio}), ${fmt(s.tokens.total)} tokens, avg ${fmt(s.avg_latency_ms)} ms`);
}

// By Initiator
section("INITIATOR");
kv("user", `${fmt(stats.by_initiator.user.requests)} reqs, ${tokenStr(stats.by_initiator.user.tokens)}`);
kv("agent", `${fmt(stats.by_initiator.agent.requests)} reqs, ${tokenStr(stats.by_initiator.agent.tokens)}`);

// Streaming
section("STREAMING");
kv("Streamed", `${fmt(stats.streaming.streamed)} (${pct(stats.streaming.stream_ratio)})`);
kv("Buffered", fmt(stats.streaming.buffered));

// By Endpoint
section("BY ENDPOINT");
for (const [ep, s] of Object.entries(stats.by_endpoint)) {
  kv(ep, `${fmt(s.requests)} reqs, ${fmt(s.tokens.total)} tokens, avg ${fmt(s.avg_latency_ms)} ms`);
}

// By Model Tier
section("BY MODEL TIER");
for (const [tier, s] of Object.entries(stats.by_model_tier)) {
  const ratio = stats.total_requests > 0 ? pct((s.requests / stats.total_requests) * 100) : "0%";
  kv(tier, `${fmt(s.requests)} reqs (${ratio}), ${tokenStr(s.tokens)}`);
}

// Auto-Route
if (stats.auto_route.total_auto_requests > 0) {
  section("AUTO-ROUTE");
  kv("Total Auto Requests", fmt(stats.auto_route.total_auto_requests));
  kv("Cache Hits", `${fmt(stats.auto_route.cached_hits)} (${pct(stats.auto_route.cache_hit_rate)})`);
  kv("Judge Avg Latency", `${fmt(stats.auto_route.avg_judge_latency_ms)} ms`);
  kv("Judge P50 / P95", `${fmt(stats.auto_route.p50_judge_latency_ms)} / ${fmt(stats.auto_route.p95_judge_latency_ms)} ms`);
  kv("Avg Confidence", stats.auto_route.avg_confidence.toFixed(3));

  console.log();
  console.log("    Complexity:");
  for (const [k, v] of Object.entries(stats.auto_route.by_complexity)) {
    kv(`  ${k}`, fmt(v), 4);
  }
  console.log("    Expected Length:");
  for (const [k, v] of Object.entries(stats.auto_route.by_expected_length)) {
    kv(`  ${k}`, fmt(v), 4);
  }

  console.log("    Matrix:");
  for (const [k, v] of Object.entries(stats.auto_route.complexity_x_length)) {
    kv(`  ${k}`, fmt(v), 4);
  }

  console.log("    Confidence Distribution:");
  for (const [bucket, count] of Object.entries(stats.auto_route.confidence_histogram)) {
    const bar = "#".repeat(Math.min(30, Math.round((count / stats.auto_route.total_auto_requests) * 30)));
    kv(`  ${bucket}`, `${fmt(count)} ${bar}`, 4);
  }
}

// Tool Usage
if (stats.tool_usage.requests_with_tools > 0) {
  section("TOOL USAGE");
  kv("Requests with Tools", fmt(stats.tool_usage.requests_with_tools));
  kv("Total Tool Calls", fmt(stats.tool_usage.total_tool_calls));
  kv("Avg Tools/Request", stats.tool_usage.avg_tools_per_request.toString());
}

// Errors
if (stats.total_errors > 0) {
  section("ERRORS");
  console.log("    By type:");
  for (const [t, n] of Object.entries(stats.errors.by_type)) kv(`  ${t}`, fmt(n), 4);
  console.log("    By status code:");
  for (const [c, n] of Object.entries(stats.errors.by_status_code)) kv(`  ${c}`, fmt(n), 4);
}

// Daily Trend
if (stats.daily.length > 0) {
  section("DAILY TREND");
  const dailyRows = stats.daily.map((d) => [
    d.date,
    fmt(d.requests),
    fmt(d.tokens.total),
    fmt(d.errors),
    fmt(d.avg_latency_ms),
  ]);
  table(
    ["Date", "Reqs", "Tokens", "Errs", "Avg ms"],
    dailyRows,
    [12, 7, 10, 5, 8],
  );
}

// Hourly (last 24 entries)
if (stats.hourly.length > 0) {
  section("HOURLY (recent)");
  const recentHours = stats.hourly.slice(-24);
  const maxReqs = Math.max(...recentHours.map((h) => h.requests), 1);
  for (const h of recentHours) {
    const bar = "█".repeat(Math.round((h.requests / maxReqs) * 30));
    console.log(`    ${h.hour}  ${padR(fmt(h.requests), 5)} reqs  ${bar}`);
  }
}

console.log();
