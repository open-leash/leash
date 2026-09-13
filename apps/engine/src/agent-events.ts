import crypto from "node:crypto";
import type {
  AgentEventCapabilities,
  AgentEventSource,
  EvaluationRequest,
  NormalizedAgentEvent,
} from "@openleash/shared";

export const SOURCE_CAPABILITIES: Record<
  AgentEventSource,
  AgentEventCapabilities
> = {
  api_hook: {
    observe: true,
    block: true,
    rewritePrompt: false,
    rewriteToolInput: false,
    rewriteResponse: false,
  },
  // Request-time proxy events can block and rewrite prompts before forwarding. Model
  // response reporting is a bounded asynchronous tee and is observation-only;
  // advertising response rewriting here would promise an effect the streaming
  // transport intentionally cannot apply after bytes reach the agent.
  local_proxy: {
    observe: true,
    block: true,
    rewritePrompt: true,
    rewriteToolInput: false,
    rewriteResponse: false,
  },
  provider_puller: {
    observe: true,
    block: false,
    rewritePrompt: false,
    rewriteToolInput: false,
    rewriteResponse: false,
  },
};

export const OBSERVATION_ONLY_CAPABILITIES: AgentEventCapabilities = {
  observe: true,
  block: false,
  rewritePrompt: false,
  rewriteToolInput: false,
  rewriteResponse: false,
};

export function normalizeAgentEvent(input: {
  source: AgentEventSource;
  provider: string;
  request: EvaluationRequest;
  idempotencyKey?: string;
  correlationId?: string;
  capabilities?: AgentEventCapabilities;
}): NormalizedAgentEvent {
  const capabilities = input.capabilities ?? SOURCE_CAPABILITIES[input.source];
  return {
    schemaVersion: "2026-07-12.v1",
    source: input.source,
    provider: input.provider,
    capabilities,
    request: input.request,
    correlationId: input.correlationId,
    idempotencyKey:
      input.idempotencyKey?.trim() || eventFingerprint(input.request),
    receivedAt: new Date().toISOString(),
  };
}

/** Stable across hook/proxy copies; excludes source and transport-specific raw metadata. */
export function eventFingerprint(request: EvaluationRequest) {
  const event = request.event;
  const canonical = {
    eventName: event.eventName,
    occurredAtMinute: occurredAtMinute(event.occurredAt),
    prompt: event.prompt ?? null,
    tool: event.tool
      ? {
          name: event.tool.name,
          input: event.tool.input ?? null,
          output: event.tool.output ?? null,
        }
      : null,
  };
  return crypto
    .createHash("sha256")
    .update(stableJson(canonical))
    .digest("hex");
}

function occurredAtMinute(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
