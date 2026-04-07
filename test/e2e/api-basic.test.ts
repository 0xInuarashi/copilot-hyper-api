import { describe, it, expect } from "bun:test";

const BASE_URL = "http://localhost:19234";

describe("/healthz endpoint", () => {
  it("should return status ok", async () => {
    const res = await fetch(`${BASE_URL}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
  });
});

describe("/readyz endpoint", () => {
  it("should return status ready or not_ready", async () => {
    const res = await fetch(`${BASE_URL}/readyz`);
    expect([200, 503]).toContain(res.status);
    const body = await res.json() as { status: string };
    expect(["ready", "not_ready"]).toContain(body.status);
  });
});

describe("/v1/models endpoint", () => {
  it("should require auth and return 401", async () => {
    const res = await fetch(`${BASE_URL}/v1/models`);
    expect(res.status).toBe(401);
  });
});

describe("/anthropic/v1/models endpoint", () => {
  it("should require auth and return 401", async () => {
    const res = await fetch(`${BASE_URL}/anthropic/v1/models`);
    expect(res.status).toBe(401);
  });
});
