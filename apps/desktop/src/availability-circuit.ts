export type AvailabilityCircuitState = "closed" | "open" | "half-open";

export type AvailabilityCircuitSnapshot = {
  state: AvailabilityCircuitState;
  degraded: boolean;
  consecutiveFailures: number;
  openedAt?: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  reason?: string;
};

export function isAvailabilityHttpStatus(status: number) {
  // A rate limit is an explicit service/cost boundary, not proof that the
  // policy service is unavailable. Bypassing HTTP 429 would make throttling an
  // enforcement escape hatch.
  return status === 408 || status === 425 || status >= 500;
}

export class AvailabilityCircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt?: number;
  private lastFailureAt?: number;
  private lastSuccessAt?: number;
  private reason?: string;
  private halfOpenProbeInFlight = false;

  constructor(
    private readonly options: {
      failureThreshold?: number;
      openDurationMs?: number;
      now?: () => number;
    } = {},
  ) {}

  canAttempt() {
    const now = this.now();
    if (this.openedAt === undefined) return true;
    if (now - this.openedAt < this.openDurationMs) return false;
    if (this.halfOpenProbeInFlight) return false;
    this.halfOpenProbeInFlight = true;
    return true;
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
    this.lastSuccessAt = this.now();
    this.reason = undefined;
    this.halfOpenProbeInFlight = false;
  }

  recordAvailabilityFailure(reason: string) {
    this.consecutiveFailures += 1;
    this.lastFailureAt = this.now();
    this.reason = reason;
    this.halfOpenProbeInFlight = false;
    if (this.consecutiveFailures >= this.failureThreshold)
      this.openedAt ??= this.lastFailureAt;
  }

  recordNonAvailabilityFailure() {
    // Authentication, entitlement, contract, and malformed-response failures
    // must never open a fail-open circuit.
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
    this.reason = undefined;
    this.halfOpenProbeInFlight = false;
  }

  snapshot(): AvailabilityCircuitSnapshot {
    const now = this.now();
    const state: AvailabilityCircuitState = this.openedAt === undefined
      ? "closed"
      : now - this.openedAt >= this.openDurationMs
        ? "half-open"
        : "open";
    return {
      state,
      degraded: state !== "closed" || this.consecutiveFailures > 0,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      reason: this.reason,
    };
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private get failureThreshold() {
    return Math.max(1, this.options.failureThreshold ?? 2);
  }

  private get openDurationMs() {
    return Math.max(1_000, this.options.openDurationMs ?? 30_000);
  }
}
