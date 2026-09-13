import assert from "node:assert/strict";
import test from "node:test";
import { fallbackForFeatureOutcome, resolveFallback, type EvaluationResponse } from "@openleash/shared";
import { resolveConnectorDecision } from "./connector-fallback.js";

const response = (decision: "allow" | "ask" | "deny"): EvaluationResponse => ({ decision, decisionId: "d1", summary: "test", results: [] });
const observing = { observe: true as const, block: false, rewritePrompt: false, rewriteToolInput: false, rewriteResponse: false };

test("fallbacks remain Feature and outcome specific", () => {
  assert.deepEqual(fallbackForFeatureOutcome("openleash.prompt-compression", "changed"), ["replace", "record"]);
  assert.deepEqual(fallbackForFeatureOutcome("openleash.dlp", "mask"), ["replace", "deny", "ask", "record"]);
  assert.deepEqual(fallbackForFeatureOutcome("openleash.code-scanner", "block"), ["record"]);
  assert.deepEqual(fallbackForFeatureOutcome("openleash.blast-radius", "block"), ["deny", "ask", "record"]);
});

test("a connector selects the first supported rung", () => {
  assert.equal(resolveFallback(["replace", "deny", "ask", "record"], new Set(["ask", "record"])), "ask");
});

test("requested deny degrades honestly to record on an observation-only connector", () => {
  const resolved = resolveConnectorDecision({ response: response("deny"), capabilities: observing, connectorId: "puller.test" });
  assert.equal(resolved.decision, "allow");
  assert.equal(resolved.requested_decision, "deny");
  assert.equal(resolved.enforced_decision, "record");
  assert.equal(resolved.enforcement_record?.degraded, true);
  assert.ok(resolved.enforcement_record?.capability_snapshot_id);
});

test("Token Saver never degrades replacement into denial", () => {
  const resolved = resolveConnectorDecision({ response: response("allow"), capabilities: observing, connectorId: "puller.test", featureId: "openleash.prompt-compression", replacementRequested: true });
  assert.deepEqual(resolved.fallback, ["replace", "record"]);
  assert.equal(resolved.enforced_decision, "record");
});
