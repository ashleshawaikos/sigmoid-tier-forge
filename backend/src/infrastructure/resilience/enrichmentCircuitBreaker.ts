export interface CircuitBreakerPermit {
  generation: number;
  probe: boolean;
}

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export class EnrichmentCircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private consecutiveFailures = 0;
  private generation = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    private readonly options: {
      failureThreshold?: number;
      resetTimeoutMs?: number;
      now?: () => number;
    } = {},
  ) {}

  getState(): CircuitBreakerState {
    if (
      this.state === 'open' &&
      this.now() - this.openedAt >= (this.options.resetTimeoutMs ?? 30_000)
    ) {
      return 'half-open';
    }
    return this.state;
  }

  acquirePermit(): CircuitBreakerPermit | undefined {
    if (this.state === 'closed') {
      return { generation: this.generation, probe: false };
    }

    if (this.state === 'open') {
      if (
        this.now() - this.openedAt <
        (this.options.resetTimeoutMs ?? 30_000)
      ) {
        return undefined;
      }
      this.state = 'half-open';
    }

    if (this.probeInFlight) return undefined;
    this.probeInFlight = true;
    return { generation: this.generation, probe: true };
  }

  recordSuccess(permit: CircuitBreakerPermit): void {
    if (permit.generation !== this.generation) return;
    if (permit.probe) {
      this.close();
      return;
    }
    if (this.state === 'closed') this.consecutiveFailures = 0;
  }

  recordFailure(permit: CircuitBreakerPermit): boolean {
    if (permit.generation !== this.generation) return false;
    if (permit.probe) {
      this.open();
      return true;
    }
    if (this.state !== 'closed') return false;

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= (this.options.failureThreshold ?? 5)) {
      this.open();
      return true;
    }
    return false;
  }

  recordIgnoredFailure(permit: CircuitBreakerPermit): void {
    if (permit.generation !== this.generation || !permit.probe) return;
    this.close();
  }

  private close(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
    this.generation += 1;
  }

  private open(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.probeInFlight = false;
    this.generation += 1;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
