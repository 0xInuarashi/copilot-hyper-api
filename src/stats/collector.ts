import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { getConfig } from "../config.js";
import type { StatsRecord } from "./types.js";

let dirReady = false;

function ensureDir(dir: string): void {
  if (dirReady) return;
  try {
    mkdirSync(dir, { recursive: true });
    dirReady = true;
  } catch (err: any) {
    if (err.code === "EEXIST") {
      dirReady = true;
    } else {
      console.error(`[stats] Failed to create stats dir: ${err.message}`);
    }
  }
}

function todayFile(dir: string): string {
  const d = new Date().toISOString().slice(0, 10);
  return join(dir, `stats-${d}.jsonl`);
}

export function recordStats(record: StatsRecord): void {
  try {
    const config = getConfig();
    if (!config.STATS_ENABLED) return;

    const dir = config.STATS_DIR;
    ensureDir(dir);

    const line = JSON.stringify(record) + "\n";
    appendFileSync(todayFile(dir), line);
  } catch {
    // Fire-and-forget: never crash the request path
  }
}

/** Check if stats collection is enabled */
export function isStatsEnabled(): boolean {
  try {
    return getConfig().STATS_ENABLED;
  } catch {
    return false;
  }
}
