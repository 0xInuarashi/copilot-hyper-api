/**
 * FIFO concurrency semaphore.
 * Limits how many upstream requests can be in-flight at the same time.
 */

export class Semaphore {
  private running = 0;
  private readonly queue: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> | null }> = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly timeoutMs: number,
  ) {}

  /** Returns the current number of waiters in the queue. */
  get pending(): number {
    return this.queue.length;
  }

  /** Returns the current number of in-flight slots. */
  get active(): number {
    return this.running;
  }

  /** Acquire a slot. Resolves when one is available or rejects on timeout. */
  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new SemaphoreTimeoutError(`Semaphore timeout after ${this.timeoutMs}ms (${this.running} active, ${this.queue.length} queued)`));
      }, this.timeoutMs);

      this.queue.push({ resolve, timer });
    });
  }

  /** Release a slot, unblocking the next waiter in the FIFO queue. */
  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
      // running stays the same — slot transfers to the next waiter
    } else {
      this.running = Math.max(0, this.running - 1);
    }
  }

  /** Acquire, run fn, release. Returns wait time in ms. */
  async run<T>(fn: () => Promise<T>): Promise<{ result: T; waitMs: number }> {
    const waitStart = Date.now();
    await this.acquire();
    const waitMs = Date.now() - waitStart;
    try {
      const result = await fn();
      return { result, waitMs };
    } finally {
      this.release();
    }
  }
}

export class SemaphoreTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemaphoreTimeoutError";
  }
}
