import type { EvaluationRequest, EvaluationResponse, OpenLeashEvent } from "./index.js";

/** Additive Control Center contract release. Breaking changes require a new identifier. */
export const LEASH_CONTROL_CENTER_CONTRACT_VERSION = "2026-09-13.v1" as const;
export const LEASH_CAPABILITY_VERIFICATION_MAX_AGE_DAYS = 30;

export type DecisionVerb = "allow" | "ask" | "deny" | "replace" | "record";
export type ConnectorClass = "interactive" | "batch";
export type ConnectorSurface = "local" | "cloud-run" | "hosted-admin";

export interface LeashCapabilityFlags {
  see_prompt: boolean;
  see_response: boolean;
  see_tool_request: boolean;
  see_tool_result: boolean;
  see_local_context: boolean;
  block_pre_inference: boolean;
  block_pre_tool: boolean;
  replace_prompt: boolean;
  replace_tool_input: boolean;
  replace_response: boolean;
  human_approval: boolean;
  model_routing: boolean;
  cost_data: boolean;
  sees_cloud_activity: boolean;
  enforces_in_cloud_sessions: boolean;
}

export type LeashCapabilityName = keyof LeashCapabilityFlags;

export interface LeashCapabilityVerification {
  capability: LeashCapabilityName;
  surface: ConnectorSurface;
  status: "verified" | "failed" | "unverified";
  /** Runner-generated only. Product code must never manufacture this timestamp. */
  verified_at?: string;
  verified_against: string;
  report_id?: string;
}

interface LeashCapabilityBase {
  contract_version: typeof LEASH_CONTROL_CENTER_CONTRACT_VERSION;
  connector_id: string;
  connector_class: ConnectorClass;
  install_friction: 0 | 1 | 2 | 3;
  max_decision: DecisionVerb;
  can: LeashCapabilityFlags;
  verification?: LeashCapabilityVerification[];
  /** Compatibility summary sourced from the same conformance report. */
  verified_at?: string;
  verified_against?: string;
}

export interface LeashInteractiveCapability extends LeashCapabilityBase {
  connector_class: "interactive";
  latency_budget_ms: number;
  job_timeout_ms?: never;
}

export interface LeashBatchCapability extends LeashCapabilityBase {
  connector_class: "batch";
  job_timeout_ms: number;
  latency_budget_ms?: never;
}

export type LeashCapability = LeashInteractiveCapability | LeashBatchCapability;

export interface LeashDecisionExtension {
  /** Feature/outcome-specific order. Never derive this from a global verb ranking. */
  fallback: DecisionVerb[];
  requires_approval: boolean;
  confidence?: number;
  evaluator_path: string[];
  policy_version: number;
}

export type LeashDecision = EvaluationResponse & Partial<LeashDecisionExtension> & {
  requested_decision?: DecisionVerb;
  replacement?: unknown;
};

export type LeashEnforcementFailureMode = "timeout" | "unreachable" | "malformed";

export interface LeashEnforcementRecord {
  contract_version: typeof LEASH_CONTROL_CENTER_CONTRACT_VERSION;
  requested: DecisionVerb;
  enforced: DecisionVerb;
  degraded: boolean;
  connector_id: string;
  capability_snapshot_id: string;
  latency_ms: number;
  failure_mode?: LeashEnforcementFailureMode | null;
}

export type LeashFeatureOutcome = "block" | "approval" | "mask" | "changed" | "observe";

/** Feature-owned intent. Connectors must not infer this from a global strength order. */
export function fallbackForFeatureOutcome(featureId: string, outcome: LeashFeatureOutcome): DecisionVerb[] {
  if (featureId === "openleash.prompt-compression") return outcome === "changed" ? ["replace", "record"] : ["record"];
  if (featureId === "openleash.dlp" && outcome === "mask") return ["replace", "deny", "ask", "record"];
  if (["openleash.code-scanner", "openleash.mcp-scanner"].includes(featureId)) return ["record"];
  if (featureId === "openleash.skill-scanner") return outcome === "approval" ? ["ask", "record"] : ["record"];
  if (outcome === "block") return ["deny", "ask", "record"];
  if (outcome === "approval") return ["ask", "deny", "record"];
  return ["record"];
}

export function resolveFallback(fallback: readonly DecisionVerb[], supported: ReadonlySet<DecisionVerb>): DecisionVerb {
  return fallback.find((verb) => supported.has(verb)) ?? "record";
}

/** Sanitized, bounded policy input admitted deliberately at a connector boundary. */
export interface LeashTransportEvidence {
  command?: string;
  resourcePaths?: string[];
  destinationHosts?: string[];
  operation?: string;
  excerpts?: string[];
}

export interface ConnectorRequestMeta {
  connector_id: string;
  surface: ConnectorSurface;
  received_at: string;
  correlation_id?: string;
  idempotency_key?: string;
}

export interface LeashConnector<Raw = unknown, VendorResponse = unknown> {
  capability(): LeashCapability;
  ingest(raw: Raw, meta: ConnectorRequestMeta): Promise<OpenLeashEvent[]>;
  render(decision: LeashDecision, event: OpenLeashEvent): Promise<VendorResponse>;
  resolve(decision: LeashDecision): DecisionVerb;
  selfTest(): Promise<LeashConformanceReport>;
}

export interface LeashConformanceReport {
  report_id: string;
  contract_version: typeof LEASH_CONTROL_CENTER_CONTRACT_VERSION;
  connector_id: string;
  connector_version: string;
  implementation_commit: string;
  vendor_version: string;
  surface: ConnectorSurface;
  generated_at: string;
  verification: LeashCapabilityVerification[];
  latency?: { p50_ms: number; p95_ms: number; p99_ms: number };
  job_duration_ms?: number;
}

export type ControlCenterEvaluationRequest = EvaluationRequest & {
  event: OpenLeashEvent & { transportEvidence?: LeashTransportEvidence };
};

export function isCapabilityVerificationCurrent(
  verification: LeashCapabilityVerification,
  now = new Date(),
): boolean {
  if (verification.status !== "verified" || !verification.verified_at) return false;
  const verifiedAt = new Date(verification.verified_at);
  if (Number.isNaN(verifiedAt.getTime())) return false;
  const age = now.getTime() - verifiedAt.getTime();
  return age >= 0 && age <= LEASH_CAPABILITY_VERIFICATION_MAX_AGE_DAYS * 86_400_000;
}
