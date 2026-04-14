export interface StatsRecord {
  id: string;
  timestamp: string;
  duration_ms: number;

  // Endpoint
  endpoint: string;
  api_format: "openai-chat" | "openai-responses" | "anthropic";

  // Model
  requested_model: string;
  resolved_model: string;
  model_tier: "free" | "paid" | "premium" | "unknown";

  // Provider
  provider: "copilot" | "openrouter";

  // Streaming
  streaming: boolean;

  // Session
  initiator: "user" | "agent";
  interaction_id: string;
  turns: number;

  // Tokens
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;

  // Response
  status_code: number;
  finish_reason: string | null;
  tool_calls_count: number;

  // Auto-route (null when model was not "auto")
  auto_route: {
    complexity: "low" | "hard" | "extreme";
    expected_length: "short" | "long";
    confidence: number;
    reasoning: string;
    judge_model: string;
    judge_latency_ms: number;
    cached: boolean;
  } | null;

  // Stealth / hardening telemetry (null when features disabled)
  stealth: {
    tls_fingerprint_used: boolean;
    tls_profile: string | null;          // e.g. "chrome_131" — which browser profile is active
    header_ordering_applied: boolean;
    body_ordering_applied: boolean;
    token_fetch_ms: number | null;       // time to acquire session token (including circuit breaker wait)
    upstream_fetch_ms: number | null;     // time for the upstream HTTP call itself
    retry_count: number;
    circuit_breaker_state: "closed" | "open" | "half-open";
    semaphore_wait_ms: number;
  } | null;

  // Error (null on success)
  error: {
    type: string;
    status_code: number;
    message: string;
  } | null;
}

export interface TokenStats {
  prompt: number;
  completion: number;
  total: number;
}

export interface EndpointStats {
  requests: number;
  tokens: TokenStats;
  avg_latency_ms: number;
}

export interface ModelStats {
  requests: number;
  tokens: TokenStats;
  avg_latency_ms: number;
  error_count: number;
  streaming_count: number;
  buffered_count: number;
}

export interface AggregatedStats {
  period: { from: string; to: string };
  total_requests: number;
  total_errors: number;
  error_rate: number;

  tokens: {
    total_prompt: number;
    total_completion: number;
    total: number;
    avg_prompt_per_request: number;
    avg_completion_per_request: number;
    avg_total_per_request: number;
    max_prompt: number;
    max_completion: number;
    max_total: number;
  };

  latency: {
    avg_ms: number;
    p50_ms: number;
    p90_ms: number;
    p95_ms: number;
    p99_ms: number;
    min_ms: number;
    max_ms: number;
  };

  by_endpoint: Record<string, EndpointStats>;
  by_model: Record<string, ModelStats>;

  by_provider: Record<string, EndpointStats>;

  by_initiator: {
    user: { requests: number; tokens: TokenStats };
    agent: { requests: number; tokens: TokenStats };
  };

  streaming: {
    streamed: number;
    buffered: number;
    stream_ratio: number;
  };

  auto_route: {
    total_auto_requests: number;
    cached_hits: number;
    cache_hit_rate: number;
    by_complexity: Record<string, number>;
    by_expected_length: Record<string, number>;
    avg_judge_latency_ms: number;
    p50_judge_latency_ms: number;
    p95_judge_latency_ms: number;
    avg_confidence: number;
    confidence_histogram: Record<string, number>;
    complexity_x_length: Record<string, number>;
  };

  by_model_tier: Record<string, { requests: number; tokens: TokenStats }>;

  errors: {
    by_type: Record<string, number>;
    by_status_code: Record<string, number>;
  };

  tool_usage: {
    requests_with_tools: number;
    total_tool_calls: number;
    avg_tools_per_request: number;
  };

  stealth: {
    requests_with_tls_fingerprint: number;
    requests_with_header_ordering: number;
    requests_with_body_ordering: number;
    avg_token_fetch_ms: number;
    avg_upstream_fetch_ms: number;
    avg_semaphore_wait_ms: number;
    total_retries: number;
    circuit_breaker_open_count: number;
  };

  daily: Array<{
    date: string;
    requests: number;
    tokens: TokenStats;
    errors: number;
    avg_latency_ms: number;
  }>;

  hourly: Array<{
    hour: string;
    requests: number;
    tokens_total: number;
  }>;
}
