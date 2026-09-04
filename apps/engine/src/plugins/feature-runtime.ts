import type {
  ConversationTurn,
  EvaluationRequest,
  PluginCatalogItem,
  PluginPromptPipelineConfig,
  PluginSettingState,
} from "@openleash/shared";
import type { TenantModelKey } from "../model-keys.js";
import { runBlastRadius } from "./blast-radius/index.js";
import { runCodeScanner } from "./code-scanner/index.js";
import { runDlp } from "./dlp/index.js";
import { runMcpScanner } from "./mcp-scanner/index.js";
import { runPromptCompression } from "./prompt-compression/index.js";
import { firstPartyPluginManifests } from "./registry.js";
import { runSecurityEvaluator } from "./security-evaluator/index.js";
import { runSensitiveAccess } from "./sensitive-access/index.js";
import { runSkillScanner } from "./skill-scanner/index.js";
import { runPromptPipeline } from "./runtime.js";

/**
 * Closed registry of code reviewed and shipped with Leash. Keeping the concrete
 * handler references here makes a missing implementation a startup/test error
 * and prevents manifests from dynamically loading arbitrary code.
 */
export const BUILTIN_FEATURE_HANDLERS = {
  "openleash.prompt-compression": runPromptCompression,
  "openleash.dlp": runDlp,
  "openleash.sensitive-access": runSensitiveAccess,
  "openleash.blast-radius": runBlastRadius,
  "openleash.rules-enforcer": runSecurityEvaluator,
  "openleash.mcp-scanner": runMcpScanner,
  "openleash.code-scanner": runCodeScanner,
  "openleash.skill-scanner": runSkillScanner,
} as const;

export type BuiltinFeatureId = keyof typeof BUILTIN_FEATURE_HANDLERS;

export function verifyBuiltinFeatureRegistry(plugins: PluginCatalogItem[]) {
  return plugins.map((feature) => {
    const execution = feature.execution;
    const registered = feature.id in BUILTIN_FEATURE_HANDLERS;
    const builtin =
      feature.runtime === "builtin" &&
      execution?.type === "in-process" &&
      feature.entrypoint === "client-api";
    const enabled = feature.settings.enabled && feature.settings.runtimeAvailable !== false;
    return {
      pluginId: feature.id,
      featureId: feature.id,
      healthy: enabled && builtin && registered,
      protocolVerified: enabled && builtin && registered,
      checks: ["registry", "handler"],
      ...(!enabled
        ? { error: feature.settings.runtimeError || "Feature is not enabled and available." }
        : !builtin
          ? { error: "Feature is not configured for the in-process client-api runtime." }
          : !registered
            ? { error: "No reviewed in-process handler is registered for this Feature." }
            : {}),
    };
  });
}

export async function transformProviderRequestWithFeatures(input: {
  requestBody: Record<string, unknown>;
  provider: string;
  agentKind: string;
  sessionId: string;
  projectPath?: string;
  organizationId: string;
  userId: string;
  agentId?: string;
  config: PluginPromptPipelineConfig;
  plugins: Map<string, PluginSettingState>;
  tenantModelKey?: TenantModelKey;
  transcript?: ConversationTurn[];
}) {
  const prompt = latestProviderPrompt(input.requestBody);
  if (!prompt) {
    return { requestBody: structuredClone(input.requestBody), appliedPluginIds: [], runs: [] };
  }
  const request: EvaluationRequest = {
    computer: { hostname: "local-proxy", platform: process.platform },
    agent: {
      kind: input.agentKind as EvaluationRequest["agent"]["kind"],
      displayName: input.agentKind,
      instanceId: input.agentId,
    },
    event: {
      eventName: "UserPromptSubmit",
      agentKind: input.agentKind as EvaluationRequest["event"]["agentKind"],
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      prompt,
      transcript: input.transcript,
      occurredAt: new Date().toISOString(),
      raw: {
        provider: input.provider,
        openleashEventEnvelope: {
          source: "local_proxy",
          provider: input.provider,
          capabilities: { rewritePrompt: true },
        },
      },
    },
  };
  const result = await runPromptPipeline({
    request,
    config: input.config,
    organizationId: input.organizationId,
    userId: input.userId,
    runtimeId: input.agentId,
    tenantModelKey: input.tenantModelKey,
    plugins: input.plugins,
  });
  const requestBody = structuredClone(input.requestBody);
  if (!result.blocked && result.finalPrompt !== prompt) {
    replaceLatestProviderPrompt(requestBody, result.finalPrompt);
  }
  return {
    requestBody,
    appliedPluginIds: result.runs
      .filter((run) => run.status !== "failed" && run.status !== "skipped")
      .map((run) => run.pluginId),
    runs: result.runs,
  };
}

export function assertBuiltinFeatureRegistry() {
  const missing = firstPartyPluginManifests
    .filter((feature) => feature.runtime === "builtin")
    .filter((feature) => !(feature.id in BUILTIN_FEATURE_HANDLERS));
  if (missing.length) {
    throw new Error(`Missing built-in Feature handlers: ${missing.map((item) => item.id).join(", ")}`);
  }
}

export function latestProviderPrompt(body: Record<string, unknown>): string | undefined {
  if (typeof body.input === "string") return body.input;
  if (Array.isArray(body.input)) {
    const message = [...body.input].reverse().find((item) =>
      isRecord(item) &&
      String(item.type ?? "message") === "message" &&
      String(item.role ?? "user") === "user",
    );
    return isRecord(message) ? contentText(message.content) : undefined;
  }
  if (!Array.isArray(body.messages)) return undefined;
  const message = [...body.messages].reverse().find((item) =>
    isRecord(item) && item.role === "user",
  );
  return isRecord(message) ? contentText(message.content) : undefined;
}

export function replaceLatestProviderPrompt(body: Record<string, unknown>, replacement: string) {
  if (typeof body.input === "string") {
    body.input = replacement;
    return;
  }
  const collection = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages)
      ? body.messages
      : undefined;
  if (!collection) return;
  const message = [...collection].reverse().find((item) =>
    isRecord(item) &&
    String(item.type ?? "message") === "message" &&
    String(item.role ?? "user") === "user",
  );
  if (!isRecord(message)) return;
  if (typeof message.content === "string") {
    message.content = replacement;
    return;
  }
  if (!Array.isArray(message.content)) return;
  const block = [...message.content].reverse().find((item) =>
    isRecord(item) && (typeof item.text === "string" || typeof item.input_text === "string"),
  );
  if (!isRecord(block)) return;
  if (typeof block.input_text === "string") block.input_text = replacement;
  else block.text = replacement;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((item) => {
      if (!isRecord(item)) return [];
      const value = item.text ?? item.input_text;
      return typeof value === "string" ? [value] : [];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
