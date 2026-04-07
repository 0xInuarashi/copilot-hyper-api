import { z } from "zod";

const configSchema = z.object({
  PROXY_API_KEY: z.string().min(1, "PROXY_API_KEY is required"),
  GITHUB_OAUTH_TOKEN: z.string().min(1, "GITHUB_OAUTH_TOKEN is required"),
  COPILOT_CLIENT_ID: z.string().default("Iv1.b507a08c87ecfe98"),
  COPILOT_EDITOR_VERSION: z.string().default("copilot/1.0.20 (client/github/cli linux v24.11.1) term/unknown"),
  COPILOT_INTEGRATION_ID: z.string().default("copilot-developer-cli"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(["raw", "debug", "info", "warn", "error"]).default("info"),
  MODEL_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(900),
  SESSION_TOKEN_SAFETY_WINDOW_SECONDS: z.coerce.number().int().min(0).default(120),
  ALLOWED_ORIGINS: z.string().default(""),
  OPENROUTER_ENABLED: z.preprocess((v) => v === "true" || v === "1" || v === true, z.boolean().default(false)),
  OPENROUTER_API_KEY: z.string().default(""),
  OPENROUTER_MODEL: z.string().default(""),
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
