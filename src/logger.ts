import { getConfig } from "./config.js";

const LEVELS = { raw: 0, debug: 1, info: 2, warn: 3, error: 4 } as const;
type Level = keyof typeof LEVELS;

function currentLevel(): number {
  try {
    return LEVELS[getConfig().LOG_LEVEL as Level] ?? LEVELS.info;
  } catch {
    return LEVELS.info;
  }
}

function shouldLog(level: Level): boolean {
  return LEVELS[level] >= currentLevel();
}

function emit(level: Level, data: Record<string, unknown>) {
  if (!shouldLog(level)) return;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(JSON.stringify({ level, ts: new Date().toISOString(), ...data }));
}

export const logger = {
  raw:   (data: Record<string, unknown>) => emit("raw", data),
  debug: (data: Record<string, unknown>) => emit("debug", data),
  info:  (data: Record<string, unknown>) => emit("info", data),
  warn:  (data: Record<string, unknown>) => emit("warn", data),
  error: (data: Record<string, unknown>) => emit("error", data),
};

export function isDebug(): boolean { return currentLevel() <= LEVELS.debug; }
export function isRaw(): boolean   { return currentLevel() <= LEVELS.raw; }

/** Redact Bearer token value unless in raw mode */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  if (isRaw()) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === "authorization" || lk === "x-api-key") {
      out[k] = v.startsWith("Bearer ") ? "Bearer ***" : "***";
    } else {
      out[k] = v;
    }
  }
  return out;
}
