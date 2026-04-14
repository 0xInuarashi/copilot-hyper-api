import { describe, test, expect } from "bun:test";
import { CircuitBreaker, CircuitBreakerOpenError } from "../../src/auth/circuit-breaker.js";

describe("CircuitBreaker", () => {
  test("starts in closed state", () => {
    const cb = new CircuitBreaker(3, 1000);
    expect(cb.getState()).toBe("closed");
    expect(cb.canAttempt()).toBe(true);
  });

  test("stays closed after fewer failures than threshold", async () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("closed");
    expect(cb.canAttempt()).toBe(true);
  });

  test("opens after reaching threshold", () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    expect(cb.canAttempt()).toBe(false);
  });

  test("resets on success", () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.getState()).toBe("closed");
  });

  test("transitions to half-open after cooldown", async () => {
    const cb = new CircuitBreaker(2, 50); // 50ms cooldown
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.getState()).toBe("half-open");
    expect(cb.canAttempt()).toBe(true);
  });

  test("execute succeeds and resets state", async () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure();
    const result = await cb.execute(async () => 42);
    expect(result).toBe(42);
    expect(cb.getState()).toBe("closed");
  });

  test("execute records failure on throw", async () => {
    const cb = new CircuitBreaker(2, 1000);
    try {
      await cb.execute(async () => { throw new Error("boom"); });
    } catch {}
    try {
      await cb.execute(async () => { throw new Error("boom"); });
    } catch {}
    expect(cb.getState()).toBe("open");
  });

  test("execute rejects when circuit is open", async () => {
    const cb = new CircuitBreaker(1, 10_000);
    cb.recordFailure();
    expect(cb.getState()).toBe("open");

    try {
      await cb.execute(async () => "should not reach");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError);
    }
  });

  test("half-open success transitions back to closed", async () => {
    const cb = new CircuitBreaker(1, 50);
    cb.recordFailure();
    expect(cb.getState()).toBe("open");
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.getState()).toBe("half-open");

    const result = await cb.execute(async () => "recovered");
    expect(result).toBe("recovered");
    expect(cb.getState()).toBe("closed");
  });

  test("half-open failure transitions back to open", async () => {
    const cb = new CircuitBreaker(1, 50);
    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.getState()).toBe("half-open");

    try {
      await cb.execute(async () => { throw new Error("still failing"); });
    } catch {}
    expect(cb.getState()).toBe("open");
  });
});
