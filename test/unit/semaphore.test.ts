import { describe, test, expect } from "bun:test";
import { Semaphore, SemaphoreTimeoutError } from "../../src/upstream/semaphore.js";

describe("Semaphore", () => {
  test("allows up to maxConcurrency", async () => {
    const sem = new Semaphore(2, 5000);
    expect(sem.active).toBe(0);

    await sem.acquire();
    expect(sem.active).toBe(1);

    await sem.acquire();
    expect(sem.active).toBe(2);

    sem.release();
    expect(sem.active).toBe(1);

    sem.release();
    expect(sem.active).toBe(0);
  });

  test("queues when at capacity", async () => {
    const sem = new Semaphore(1, 5000);
    const order: number[] = [];

    await sem.acquire(); // slot taken

    const p = sem.acquire().then(() => {
      order.push(2);
    });
    order.push(1);

    expect(sem.pending).toBe(1);
    sem.release(); // unblocks queued waiter
    await p;
    expect(order).toEqual([1, 2]);
    sem.release();
  });

  test("run returns result and wait time", async () => {
    const sem = new Semaphore(2, 5000);
    const { result, waitMs } = await sem.run(async () => "hello");
    expect(result).toBe("hello");
    expect(waitMs).toBeGreaterThanOrEqual(0);
    expect(waitMs).toBeLessThan(100);
  });

  test("run releases slot on error", async () => {
    const sem = new Semaphore(1, 5000);
    try {
      await sem.run(async () => { throw new Error("fail"); });
    } catch {}
    expect(sem.active).toBe(0);

    // Can still acquire after error
    const { result } = await sem.run(async () => "ok");
    expect(result).toBe("ok");
    sem.release(); // cleanup the slot from run
  });

  test("times out when blocked too long", async () => {
    const sem = new Semaphore(1, 50); // 50ms timeout
    await sem.acquire(); // fill slot

    try {
      await sem.acquire(); // should timeout
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SemaphoreTimeoutError);
    }

    sem.release();
  });

  test("FIFO ordering", async () => {
    const sem = new Semaphore(1, 5000);
    const order: number[] = [];

    await sem.acquire();

    const p1 = sem.acquire().then(() => { order.push(1); sem.release(); });
    const p2 = sem.acquire().then(() => { order.push(2); sem.release(); });
    const p3 = sem.acquire().then(() => { order.push(3); sem.release(); });

    sem.release(); // start the chain
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});
