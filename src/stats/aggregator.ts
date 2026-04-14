import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { StatsRecord, AggregatedStats, TokenStats, EndpointStats, ModelStats } from "./types.js";

export function loadRecords(dir: string, from?: string, to?: string): StatsRecord[] {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.startsWith("stats-") && f.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }

  if (from) files = files.filter((f) => f >= `stats-${from}.jsonl`);
  if (to) files = files.filter((f) => f <= `stats-${to}.jsonl`);

  const records: StatsRecord[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          // skip malformed
        }
      }
    } catch {
      // skip unreadable file
    }
  }
  return records;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function sumTokens(records: StatsRecord[]): TokenStats {
  let prompt = 0, completion = 0, total = 0;
  for (const r of records) {
    prompt += r.prompt_tokens;
    completion += r.completion_tokens;
    total += r.total_tokens;
  }
  return { prompt, completion, total };
}

function avgLatency(records: StatsRecord[]): number {
  if (records.length === 0) return 0;
  return Math.round(records.reduce((s, r) => s + r.duration_ms, 0) / records.length);
}

export function aggregate(records: StatsRecord[]): AggregatedStats {
  const n = records.length;
  if (n === 0) return emptyStats();

  const dates = records.map((r) => r.timestamp.slice(0, 10)).sort();
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;

  const errors = records.filter((r) => r.error !== null);
  const successful = records.filter((r) => r.error === null);

  // Tokens
  const allTokens = sumTokens(records);
  const promptTokens = records.map((r) => r.prompt_tokens);
  const completionTokens = records.map((r) => r.completion_tokens);
  const totalTokens = records.map((r) => r.total_tokens);

  // Latency
  const latencies = records.map((r) => r.duration_ms).sort((a, b) => a - b);

  // By endpoint
  const byEndpoint: Record<string, EndpointStats> = {};
  for (const r of records) {
    if (!byEndpoint[r.endpoint]) {
      byEndpoint[r.endpoint] = { requests: 0, tokens: { prompt: 0, completion: 0, total: 0 }, avg_latency_ms: 0 };
    }
    const e = byEndpoint[r.endpoint]!;
    e.requests++;
    e.tokens.prompt += r.prompt_tokens;
    e.tokens.completion += r.completion_tokens;
    e.tokens.total += r.total_tokens;
  }
  for (const ep of Object.keys(byEndpoint)) {
    const recs = records.filter((r) => r.endpoint === ep);
    byEndpoint[ep]!.avg_latency_ms = avgLatency(recs);
  }

  // By model
  const byModel: Record<string, ModelStats> = {};
  for (const r of records) {
    const m = r.resolved_model;
    if (!byModel[m]) {
      byModel[m] = { requests: 0, tokens: { prompt: 0, completion: 0, total: 0 }, avg_latency_ms: 0, error_count: 0, streaming_count: 0, buffered_count: 0 };
    }
    const s = byModel[m]!;
    s.requests++;
    s.tokens.prompt += r.prompt_tokens;
    s.tokens.completion += r.completion_tokens;
    s.tokens.total += r.total_tokens;
    if (r.error) s.error_count++;
    if (r.streaming) s.streaming_count++;
    else s.buffered_count++;
  }
  for (const m of Object.keys(byModel)) {
    const recs = records.filter((r) => r.resolved_model === m);
    byModel[m]!.avg_latency_ms = avgLatency(recs);
  }

  // By provider
  const byProvider: Record<string, EndpointStats> = {};
  for (const r of records) {
    if (!byProvider[r.provider]) {
      byProvider[r.provider] = { requests: 0, tokens: { prompt: 0, completion: 0, total: 0 }, avg_latency_ms: 0 };
    }
    const p = byProvider[r.provider]!;
    p.requests++;
    p.tokens.prompt += r.prompt_tokens;
    p.tokens.completion += r.completion_tokens;
    p.tokens.total += r.total_tokens;
  }
  for (const prov of Object.keys(byProvider)) {
    const recs = records.filter((r) => r.provider === prov);
    byProvider[prov]!.avg_latency_ms = avgLatency(recs);
  }

  // By initiator
  const userRecs = records.filter((r) => r.initiator === "user");
  const agentRecs = records.filter((r) => r.initiator === "agent");

  // Streaming
  const streamed = records.filter((r) => r.streaming).length;
  const buffered = n - streamed;

  // Auto-route
  const autoRecs = records.filter((r) => r.auto_route !== null);
  const cachedRecs = autoRecs.filter((r) => r.auto_route!.cached);
  const judgeLatencies = autoRecs.filter((r) => !r.auto_route!.cached).map((r) => r.auto_route!.judge_latency_ms).sort((a, b) => a - b);
  const confidences = autoRecs.map((r) => r.auto_route!.confidence);

  const byComplexity: Record<string, number> = {};
  const byLength: Record<string, number> = {};
  const cxl: Record<string, number> = {};
  const confHist: Record<string, number> = { "0.0-0.2": 0, "0.2-0.4": 0, "0.4-0.6": 0, "0.6-0.8": 0, "0.8-1.0": 0 };

  for (const r of autoRecs) {
    const ar = r.auto_route!;
    byComplexity[ar.complexity] = (byComplexity[ar.complexity] ?? 0) + 1;
    byLength[ar.expected_length] = (byLength[ar.expected_length] ?? 0) + 1;
    const key = `${ar.complexity}+${ar.expected_length}`;
    cxl[key] = (cxl[key] ?? 0) + 1;

    const c = ar.confidence;
    if (c < 0.2) confHist["0.0-0.2"]!++;
    else if (c < 0.4) confHist["0.2-0.4"]!++;
    else if (c < 0.6) confHist["0.4-0.6"]!++;
    else if (c < 0.8) confHist["0.6-0.8"]!++;
    else confHist["0.8-1.0"]!++;
  }

  // By model tier
  const byTier: Record<string, { requests: number; tokens: TokenStats }> = {};
  for (const r of records) {
    if (!byTier[r.model_tier]) byTier[r.model_tier] = { requests: 0, tokens: { prompt: 0, completion: 0, total: 0 } };
    byTier[r.model_tier]!.requests++;
    byTier[r.model_tier]!.tokens.prompt += r.prompt_tokens;
    byTier[r.model_tier]!.tokens.completion += r.completion_tokens;
    byTier[r.model_tier]!.tokens.total += r.total_tokens;
  }

  // Errors
  const errByType: Record<string, number> = {};
  const errByCode: Record<string, number> = {};
  for (const r of errors) {
    const t = r.error!.type;
    errByType[t] = (errByType[t] ?? 0) + 1;
    const c = String(r.error!.status_code);
    errByCode[c] = (errByCode[c] ?? 0) + 1;
  }

  // Tools
  const withTools = records.filter((r) => r.tool_calls_count > 0);
  const totalToolCalls = records.reduce((s, r) => s + r.tool_calls_count, 0);

  // Stealth
  const stealthRecs = records.filter((r) => r.stealth !== null);
  const tlsFpCount = stealthRecs.filter((r) => r.stealth!.tls_fingerprint_used).length;
  const headerOrderCount = stealthRecs.filter((r) => r.stealth!.header_ordering_applied).length;
  const bodyOrderCount = stealthRecs.filter((r) => r.stealth!.body_ordering_applied).length;
  const tokenFetches = stealthRecs.filter((r) => r.stealth!.token_fetch_ms != null).map((r) => r.stealth!.token_fetch_ms!);
  const upstreamFetches = stealthRecs.filter((r) => r.stealth!.upstream_fetch_ms != null).map((r) => r.stealth!.upstream_fetch_ms!);
  const semaphoreWaits = stealthRecs.map((r) => r.stealth!.semaphore_wait_ms);
  const totalRetries = stealthRecs.reduce((s, r) => s + r.stealth!.retry_count, 0);
  const cbOpenCount = stealthRecs.filter((r) => r.stealth!.circuit_breaker_state === "open").length;

  // Daily
  const dailyMap = new Map<string, { requests: number; tokens: TokenStats; errors: number; totalLatency: number }>();
  for (const r of records) {
    const d = r.timestamp.slice(0, 10);
    if (!dailyMap.has(d)) dailyMap.set(d, { requests: 0, tokens: { prompt: 0, completion: 0, total: 0 }, errors: 0, totalLatency: 0 });
    const day = dailyMap.get(d)!;
    day.requests++;
    day.tokens.prompt += r.prompt_tokens;
    day.tokens.completion += r.completion_tokens;
    day.tokens.total += r.total_tokens;
    if (r.error) day.errors++;
    day.totalLatency += r.duration_ms;
  }
  const daily = [...dailyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => ({
    date,
    requests: d.requests,
    tokens: d.tokens,
    errors: d.errors,
    avg_latency_ms: Math.round(d.totalLatency / d.requests),
  }));

  // Hourly (all data, grouped by YYYY-MM-DDTHH)
  const hourlyMap = new Map<string, { requests: number; tokens_total: number }>();
  for (const r of records) {
    const h = r.timestamp.slice(0, 13);
    if (!hourlyMap.has(h)) hourlyMap.set(h, { requests: 0, tokens_total: 0 });
    const hr = hourlyMap.get(h)!;
    hr.requests++;
    hr.tokens_total += r.total_tokens;
  }
  const hourly = [...hourlyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hour, h]) => ({
    hour,
    requests: h.requests,
    tokens_total: h.tokens_total,
  }));

  return {
    period: { from, to },
    total_requests: n,
    total_errors: errors.length,
    error_rate: n > 0 ? Number(((errors.length / n) * 100).toFixed(2)) : 0,

    tokens: {
      total_prompt: allTokens.prompt,
      total_completion: allTokens.completion,
      total: allTokens.total,
      avg_prompt_per_request: n > 0 ? Math.round(allTokens.prompt / n) : 0,
      avg_completion_per_request: n > 0 ? Math.round(allTokens.completion / n) : 0,
      avg_total_per_request: n > 0 ? Math.round(allTokens.total / n) : 0,
      max_prompt: promptTokens.length > 0 ? Math.max(...promptTokens) : 0,
      max_completion: completionTokens.length > 0 ? Math.max(...completionTokens) : 0,
      max_total: totalTokens.length > 0 ? Math.max(...totalTokens) : 0,
    },

    latency: {
      avg_ms: avgLatency(records),
      p50_ms: percentile(latencies, 50),
      p90_ms: percentile(latencies, 90),
      p95_ms: percentile(latencies, 95),
      p99_ms: percentile(latencies, 99),
      min_ms: latencies[0] ?? 0,
      max_ms: latencies[latencies.length - 1] ?? 0,
    },

    by_endpoint: byEndpoint,
    by_model: byModel,
    by_provider: byProvider,

    by_initiator: {
      user: { requests: userRecs.length, tokens: sumTokens(userRecs) },
      agent: { requests: agentRecs.length, tokens: sumTokens(agentRecs) },
    },

    streaming: {
      streamed,
      buffered,
      stream_ratio: n > 0 ? Number(((streamed / n) * 100).toFixed(1)) : 0,
    },

    auto_route: {
      total_auto_requests: autoRecs.length,
      cached_hits: cachedRecs.length,
      cache_hit_rate: autoRecs.length > 0 ? Number(((cachedRecs.length / autoRecs.length) * 100).toFixed(1)) : 0,
      by_complexity: byComplexity,
      by_expected_length: byLength,
      avg_judge_latency_ms: judgeLatencies.length > 0 ? Math.round(judgeLatencies.reduce((a, b) => a + b, 0) / judgeLatencies.length) : 0,
      p50_judge_latency_ms: percentile(judgeLatencies, 50),
      p95_judge_latency_ms: percentile(judgeLatencies, 95),
      avg_confidence: confidences.length > 0 ? Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(3)) : 0,
      confidence_histogram: confHist,
      complexity_x_length: cxl,
    },

    by_model_tier: byTier,

    errors: {
      by_type: errByType,
      by_status_code: errByCode,
    },

    tool_usage: {
      requests_with_tools: withTools.length,
      total_tool_calls: totalToolCalls,
      avg_tools_per_request: withTools.length > 0 ? Number((totalToolCalls / withTools.length).toFixed(1)) : 0,
    },

    stealth: {
      requests_with_tls_fingerprint: tlsFpCount,
      requests_with_header_ordering: headerOrderCount,
      requests_with_body_ordering: bodyOrderCount,
      avg_token_fetch_ms: tokenFetches.length > 0 ? Math.round(tokenFetches.reduce((a, b) => a + b, 0) / tokenFetches.length) : 0,
      avg_upstream_fetch_ms: upstreamFetches.length > 0 ? Math.round(upstreamFetches.reduce((a, b) => a + b, 0) / upstreamFetches.length) : 0,
      avg_semaphore_wait_ms: semaphoreWaits.length > 0 ? Math.round(semaphoreWaits.reduce((a, b) => a + b, 0) / semaphoreWaits.length) : 0,
      total_retries: totalRetries,
      circuit_breaker_open_count: cbOpenCount,
    },

    daily,
    hourly,
  };
}

function emptyStats(): AggregatedStats {
  return {
    period: { from: "", to: "" },
    total_requests: 0,
    total_errors: 0,
    error_rate: 0,
    tokens: { total_prompt: 0, total_completion: 0, total: 0, avg_prompt_per_request: 0, avg_completion_per_request: 0, avg_total_per_request: 0, max_prompt: 0, max_completion: 0, max_total: 0 },
    latency: { avg_ms: 0, p50_ms: 0, p90_ms: 0, p95_ms: 0, p99_ms: 0, min_ms: 0, max_ms: 0 },
    by_endpoint: {},
    by_model: {},
    by_provider: {},
    by_initiator: { user: { requests: 0, tokens: { prompt: 0, completion: 0, total: 0 } }, agent: { requests: 0, tokens: { prompt: 0, completion: 0, total: 0 } } },
    streaming: { streamed: 0, buffered: 0, stream_ratio: 0 },
    auto_route: { total_auto_requests: 0, cached_hits: 0, cache_hit_rate: 0, by_complexity: {}, by_expected_length: {}, avg_judge_latency_ms: 0, p50_judge_latency_ms: 0, p95_judge_latency_ms: 0, avg_confidence: 0, confidence_histogram: {}, complexity_x_length: {} },
    by_model_tier: {},
    errors: { by_type: {}, by_status_code: {} },
    tool_usage: { requests_with_tools: 0, total_tool_calls: 0, avg_tools_per_request: 0 },
    stealth: { requests_with_tls_fingerprint: 0, requests_with_header_ordering: 0, requests_with_body_ordering: 0, avg_token_fetch_ms: 0, avg_upstream_fetch_ms: 0, avg_semaphore_wait_ms: 0, total_retries: 0, circuit_breaker_open_count: 0 },
    daily: [],
    hourly: [],
  };
}
