import { Hono } from "hono";
import { getConfig } from "../config.js";
import { loadRecords, aggregate } from "../stats/aggregator.js";

const stats = new Hono();

stats.get("/stats", async (c) => {
  const config = getConfig();
  if (!config.STATS_ENABLED) {
    return c.json({ error: { message: "Stats not enabled. Set STATS_ENABLED=true", type: "invalid_request_error" } }, 400);
  }

  const from = c.req.query("from");
  const to = c.req.query("to");
  const records = loadRecords(config.STATS_DIR, from ?? undefined, to ?? undefined);
  const aggregated = aggregate(records);

  return c.json(aggregated);
});

stats.get("/stats/raw", async (c) => {
  const config = getConfig();
  if (!config.STATS_ENABLED) {
    return c.json({ error: { message: "Stats not enabled. Set STATS_ENABLED=true", type: "invalid_request_error" } }, 400);
  }

  const from = c.req.query("from");
  const to = c.req.query("to");
  const limit = parseInt(c.req.query("limit") ?? "100", 10);
  const records = loadRecords(config.STATS_DIR, from ?? undefined, to ?? undefined);

  // Return most recent records first
  const sliced = records.reverse().slice(0, limit);
  return c.json({ total: records.length, returned: sliced.length, records: sliced });
});

export default stats;
