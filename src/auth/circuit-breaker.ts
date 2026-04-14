type State = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private state: State = "closed";
  private failures = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  getState(): State {
    if (this.state === "open" && Date.now() - this.lastFailureTime >= this.cooldownMs) {
      this.state = "half-open";
    }
    return this.state;
  }

  /** Returns true if the call should be allowed through. */
  canAttempt(): boolean {
    const s = this.getState();
    return s === "closed" || s === "half-open";
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.threshold) {
      this.state = "open";
    }
  }

  /** Execute fn through the circuit breaker. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canAttempt()) {
      throw new CircuitBreakerOpenError(
        `Circuit breaker open (${this.failures} consecutive failures, ` +
        `cooldown ${Math.round((this.cooldownMs - (Date.now() - this.lastFailureTime)) / 1000)}s remaining)`,
      );
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}
