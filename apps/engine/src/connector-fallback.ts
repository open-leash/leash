import crypto from "node:crypto";
import {
  LEASH_CONTROL_CENTER_CONTRACT_VERSION,
  fallbackForFeatureOutcome,
  resolveFallback,
  type AgentEventCapabilities,
  type DecisionVerb,
  type EvaluationResponse,
  type LeashEnforcementRecord,
} from "@openleash/shared";

export const CONNECTOR_FALLBACK_FLAG = "OPENLEASH_CONNECTOR_FALLBACKS_ENABLED";

export function resolveConnectorDecision(input: {
  response: EvaluationResponse;
  capabilities: AgentEventCapabilities;
  connectorId: string;
  startedAt?: number;
  featureId?: string;
  replacementRequested?: boolean;
  capabilitySnapshotId?: string;
}): EvaluationResponse {
  const requested = requestedVerb(input);
  const outcome = requested === "deny" ? "block" : requested === "ask" ? "approval" : requested === "replace" ? "changed" : "observe";
  const fallback = fallbackForFeatureOutcome(input.featureId ?? "openleash.rules-enforcer", outcome);
  const enforced = resolveFallback(fallback, supportedVerbs(input.capabilities));
  const record: LeashEnforcementRecord = {
    contract_version: LEASH_CONTROL_CENTER_CONTRACT_VERSION,
    requested,
    enforced,
    degraded: enforced !== requested,
    connector_id: input.connectorId,
    capability_snapshot_id: input.capabilitySnapshotId ?? capabilitySnapshot(input.connectorId, input.capabilities),
    latency_ms: Math.max(0, Date.now() - (input.startedAt ?? Date.now())),
  };
  return {
    ...input.response,
    decision: enforced === "deny" ? "deny" : enforced === "ask" ? "ask" : "allow",
    fallback,
    requested_decision: requested,
    enforced_decision: enforced,
    enforcement_record: record,
    requires_approval: requested === "ask",
  };
}

function requestedVerb(input: { response: EvaluationResponse; replacementRequested?: boolean }): DecisionVerb {
  if (input.replacementRequested) return "replace";
  if (input.response.decision === "deny" || input.response.decision === "ask") return input.response.decision;
  return "record";
}

function supportedVerbs(capabilities: AgentEventCapabilities): ReadonlySet<DecisionVerb> {
  const verbs = new Set<DecisionVerb>(["record"]);
  if (capabilities.block) { verbs.add("deny"); verbs.add("ask"); }
  if (capabilities.rewritePrompt) verbs.add("replace");
  return verbs;
}

function capabilitySnapshot(connectorId: string, capabilities: AgentEventCapabilities) {
  return crypto.createHash("sha256").update(`${connectorId}:${JSON.stringify(capabilities)}`).digest("hex");
}
