import { z } from "zod";

const configSchema = z.object({
  PROXY_API_KEY: z.string().min(1, "PROXY_API_KEY is required"),
  GITHUB_OAUTH_TOKEN: z.string().min(1, "GITHUB_OAUTH_TOKEN is required"),
  COPILOT_CLIENT_ID: z.string().default("Iv1.b507a08c87ecfe98"),
  COPILOT_EDITOR_VERSION: z.string().default("vscode/1.110.0"),
  COPILOT_PLUGIN_VERSION: z.string().default("copilot-chat/0.38.0"),
  COPILOT_USER_AGENT: z.string().default("GitHubCopilotChat/0.38.0"),
  COPILOT_INTEGRATION_ID: z.string().default("vscode-chat"),

  // Token refresh retry
  TOKEN_REFRESH_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  TOKEN_REFRESH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(["raw", "debug", "info", "warn", "error"]).default("info"),
  MODEL_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(900),
  SESSION_TOKEN_SAFETY_WINDOW_SECONDS: z.coerce.number().int().min(0).default(120),
  ALLOWED_ORIGINS: z.string().default(""),
  OPENROUTER_ENABLED: z.preprocess((v) => v === "true" || v === "1" || v === true, z.boolean().default(false)),
  OPENROUTER_API_KEY: z.string().default(""),
  OPENROUTER_MODEL: z.string().default(""),
  STATS_ENABLED: z.preprocess((v) => v === "true" || v === "1" || v === true, z.boolean().default(false)),
  STATS_DIR: z.string().default("./data/stats"),

  // Version sync
  VERSION_SYNC_ENABLED: z.preprocess((v) => v === undefined || v === "" || v === "true" || v === "1" || v === true, z.boolean().default(true)),
  VERSION_SYNC_INTERVAL_MS: z.coerce.number().int().min(60_000).default(86_400_000), // 24h

  // Stealth / fingerprint hardening
  ENABLE_TLS_FINGERPRINT: z.preprocess((v) => v === "true" || v === "1" || v === true, z.boolean().default(false)),
  ENABLE_HEADER_ORDERING: z.preprocess((v) => v === "true" || v === "1" || v === true, z.boolean().default(true)),
  ENABLE_BODY_ORDERING: z.preprocess((v) => v === "true" || v === "1" || v === true, z.boolean().default(true)),

  // Circuit breaker for token refresh
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().min(1).default(5),
  CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().int().min(1000).default(1_800_000), // 30 min

  // Concurrency semaphore
  MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).default(10),
  SEMAPHORE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
});

export type Config = z.infer<typeof configSchema>;

let _config: Config | null = null;

export function loadConfig(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const errors = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${errors}`);
  }
  _config = result.data;
  return _config;
}

export function getConfig(): Config {
  if (!_config) {
    throw new Error("Config not loaded. Call loadConfig() first.");
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
