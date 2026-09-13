import test from "node:test";
import assert from "node:assert/strict";
import {
  LEASH_CAPABILITY_VERIFICATION_MAX_AGE_DAYS,
  LEASH_CONTROL_CENTER_CONTRACT_VERSION,
  isCapabilityVerificationCurrent,
} from "../dist/index.js";

test("publishes a versioned additive Control Center contract", () => {
  assert.equal(LEASH_CONTROL_CENTER_CONTRACT_VERSION, "2026-09-13.v1");
  assert.equal(LEASH_CAPABILITY_VERIFICATION_MAX_AGE_DAYS, 30);
});

test("only a fresh runner verification may produce a checkmark", () => {
  const now = new Date("2026-09-13T12:00:00.000Z");
  const base = { capability: "see_prompt", surface: "local", verified_against: "Vendor 1.2.3" };
  assert.equal(isCapabilityVerificationCurrent({ ...base, status: "unverified" }, now), false);
  assert.equal(isCapabilityVerificationCurrent({ ...base, status: "failed", verified_at: "2026-09-13T11:00:00.000Z" }, now), false);
  assert.equal(isCapabilityVerificationCurrent({ ...base, status: "verified", verified_at: "invalid" }, now), false);
  assert.equal(isCapabilityVerificationCurrent({ ...base, status: "verified", verified_at: "2026-08-13T11:59:59.000Z" }, now), false);
  assert.equal(isCapabilityVerificationCurrent({ ...base, status: "verified", verified_at: "2026-08-14T12:00:00.000Z" }, now), true);
  assert.equal(isCapabilityVerificationCurrent({ ...base, status: "verified", verified_at: "2026-09-13T13:00:00.000Z" }, now), false);
});

test("verification remains independently keyed by surface", () => {
  const local = { capability: "block_pre_tool", surface: "local", status: "verified", verified_at: "2026-09-13T10:00:00.000Z", verified_against: "Agent 4" };
  const cloud = { ...local, surface: "cloud-run", status: "unverified", verified_at: undefined };
  const now = new Date("2026-09-13T12:00:00.000Z");
  assert.equal(isCapabilityVerificationCurrent(local, now), true);
  assert.equal(isCapabilityVerificationCurrent(cloud, now), false);
});
