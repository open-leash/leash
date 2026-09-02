import assert from "node:assert/strict";
import test from "node:test";
import {
  AvailabilityCircuitBreaker,
  isAvailabilityHttpStatus,
} from "./availability-circuit";
import {
  availabilityFailOpen,
  isAvailabilityTransportError,
} from "./cli/config";

test("only retryable availability statuses qualify for fail-open", () => {
  for (const status of [408, 425, 500, 502, 503, 504])
    assert.equal(isAvailabilityHttpStatus(status), true, String(status));
  for (const status of [400, 401, 403, 404, 409, 422, 429])
    assert.equal(isAvailabilityHttpStatus(status), false, String(status));
});

test("availability circuit opens, probes, and recovers", () => {
  let now = 1_000;
  const circuit = new AvailabilityCircuitBreaker({
    failureThreshold: 2,
    openDurationMs: 10_000,
    now: () => now,
  });
  circuit.recordAvailabilityFailure("network");
  assert.equal(circuit.snapshot().state, "closed");
  circuit.recordAvailabilityFailure("HTTP 503");
  assert.equal(circuit.snapshot().state, "open");
  assert.equal(circuit.canAttempt(), false);
  now += 10_000;
  assert.equal(circuit.snapshot().state, "half-open");
  assert.equal(circuit.canAttempt(), true);
  assert.equal(circuit.canAttempt(), false);
  circuit.recordSuccess();
  assert.equal(circuit.snapshot().state, "closed");
  assert.equal(circuit.snapshot().degraded, false);
});

test("auth and contract failures never open the availability circuit", () => {
  const circuit = new AvailabilityCircuitBreaker({ failureThreshold: 1 });
  circuit.recordNonAvailabilityFailure();
  assert.equal(circuit.snapshot().state, "closed");
  assert.equal(circuit.canAttempt(), true);
});

test("only managed Cloud configurations bypass explicit loopback transport outages", () => {
  assert.equal(availabilityFailOpen({ mode: "cloud" }), true);
  for (const mode of ["community", "enterprise", "personal", "private"] as const)
    assert.equal(availabilityFailOpen({ mode }), false, mode);
  for (const name of ["AbortError", "TimeoutError"])
    assert.equal(isAvailabilityTransportError({ name }), true, name);
  for (const code of ["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET"])
    assert.equal(isAvailabilityTransportError({ cause: { code } }), true, code);
  assert.equal(isAvailabilityTransportError(new Error("bad JSON")), false);
});
