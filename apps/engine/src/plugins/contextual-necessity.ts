import { createHash } from "node:crypto";
import type { PluginCapabilities } from "@openleash/shared";
import type { EvaluationPipelineInput } from "./types.js";

export type ContextMode = "goal-aware" | "strict";

export type ContextualNecessityDecision = {
  allowWithoutAsking: boolean;
  reason: string;
  model?: string;
  provider?: string;
  source?: string;
  cached: boolean;
};

type ContextualNecessityResult = {
  necessaryForUserGoal: boolean;
  minimalScope: boolean;
  exposesSecretValues: boolean;
  sendsDataExternally: boolean;
  confidence: "low" | "medium" | "high";
  recommendation: "allow" | "ask";
  reason: string;
};

type CacheEntry = {
  expiresAt: number;
  promise: Promise<ContextualNecessityDecision>;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;
const necessityCache = new Map<string, CacheEntry>();

export function contextMode(value: unknown): ContextMode {
  return value === "strict" ? "strict" : "goal-aware";
}

/**
 * Performs at most one contextual model call for a protection/action pair.
 * Only clear, high-confidence necessity can turn an `ask` into an observed allow.
 */
export async function evaluateContextualNecessity(input: {
  pipeline: EvaluationPipelineInput;
  capabilities: PluginCapabilities;
  protectionId: string;
  actionCategory: string;
  actionDescription: string;
  evidence?: string[];
}): Promise<ContextualNecessityDecision> {
  pruneCache();
  let context = boundedContext(input.pipeline);
  if (!context.hasExplicitUserGoal) {
    const conversation = await input.capabilities.context.conversation.recent({ limit: 8 }).catch(() => undefined);
    if (conversation?.turns.length) context = boundedContext(input.pipeline, conversation.turns);
  }
  const key = cacheKey({
    organizationId: input.pipeline.organizationId,
    userId: input.pipeline.userId,
    agentKind: input.pipeline.request.agent.kind,
    agentId: input.pipeline.request.agent.instanceId,
    sessionId: input.pipeline.request.event.sessionId,
    projectPath: context.projectScope,
    goal: context.userGoal,
    action: context.action,
  });
  const cached = necessityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    const decision = await cached.promise;
    return { ...decision, cached: true };
  }

  const promise = runEvaluation(input, context).catch((error) => ({
    allowWithoutAsking: false,
    reason: `Context could not be verified: ${safeDiagnostic(error)}`,
    cached: false,
  }));
  necessityCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  const decision = await promise;
  // Keep only safe allows. Ambiguous and failed checks should be tried again on
  // a later event, while concurrent duplicate checks still share this promise.
  if (!decision.allowWithoutAsking || context.projectScope === "unknown") necessityCache.delete(key);
  return decision;
}

async function runEvaluation(
  input: Parameters<typeof evaluateContextualNecessity>[0],
  context: ReturnType<typeof boundedContext>,
): Promise<ContextualNecessityDecision> {
  const result = await input.capabilities.llm.evaluateJson<ContextualNecessityResult>({
    purpose: "contextual-necessity",
    system: [
      "You decide whether a sensitive AI-agent action can continue without interrupting the user.",
      "Return valid JSON only. Be conservative: ambiguity means ask.",
      "Allow only when the action is clearly required by the user's current goal, narrowly scoped to that goal, does not unnecessarily print, log, copy, or reveal secret values, and does not send data to any external destination.",
      "A task-scoped local read of this project's .env or configuration can be necessary and is not exposure by itself. Raw private-key or credential-store reads are never safe to allow automatically.",
      "The user's goal is not blanket permission. Do not infer necessity from the agent's own plan alone.",
    ].join(" "),
    prompt: JSON.stringify({
      protection: input.protectionId,
      actionCategory: input.actionCategory,
      actionDescription: redactSensitiveText(input.actionDescription).slice(0, 1_000),
      evidence: (input.evidence ?? []).map((item) => redactSensitiveText(item).slice(0, 300)).slice(0, 6),
      eventName: input.pipeline.request.event.eventName,
      projectPath: context.projectScope,
      userGoal: context.userGoal,
      recentContext: context.recentContext,
      action: context.action,
    }),
    temperature: 0,
    maxOutputTokens: 450,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "necessaryForUserGoal",
        "minimalScope",
        "exposesSecretValues",
        "sendsDataExternally",
        "confidence",
        "recommendation",
        "reason",
      ],
      properties: {
        necessaryForUserGoal: { type: "boolean" },
        minimalScope: { type: "boolean" },
        exposesSecretValues: { type: "boolean" },
        sendsDataExternally: { type: "boolean" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        recommendation: { type: "string", enum: ["allow", "ask"] },
        reason: { type: "string" },
      },
    },
  });
  const value = normalizeResult(result?.json);
  const allowWithoutAsking = Boolean(result)
    && value.necessaryForUserGoal
    && value.minimalScope
    && !value.exposesSecretValues
    && !value.sendsDataExternally
    && value.confidence === "high"
    && value.recommendation === "allow";
  return {
    allowWithoutAsking,
    reason: value.reason || (allowWithoutAsking
      ? "The action is necessary and narrowly scoped to the user's goal."
      : "The action's necessity or scope was not clear enough to continue automatically."),
    model: result?.model,
    provider: result?.provider,
    source: result?.source,
    cached: false,
  };
}

function boundedContext(
  input: EvaluationPipelineInput,
  supplementalTurns: EvaluationPipelineInput["request"]["event"]["transcript"] = [],
) {
  const event = input.request.event;
  const turns = event.transcript?.length ? event.transcript : supplementalTurns;
  const recent = (turns ?? []).slice(-8).map((turn) => ({
    role: turn.role,
    content: redactSensitiveText(turn.content).slice(0, 1_200),
  }));
  const userTurns = recent.filter((turn) => turn.role === "user").slice(-4);
  const prompt = event.prompt ? redactSensitiveText(event.prompt).slice(0, 2_000) : "";
  const userGoal = [
    ...userTurns.map((turn) => turn.content),
    ...(prompt && !userTurns.some((turn) => turn.content === prompt) ? [prompt] : []),
  ].filter(Boolean).join("\n").slice(-4_000);
  return {
    userGoal: userGoal || "No explicit user goal was available.",
    recentContext: recent,
    action: redactSensitiveText(JSON.stringify({
      tool: event.tool?.name,
      input: event.tool?.input,
    })).slice(0, 3_000),
    projectScope: eventProjectScope(input),
    hasExplicitUserGoal: userTurns.length > 0 || Boolean(prompt),
  };
}

function eventProjectScope(input: EvaluationPipelineInput) {
  if (input.request.event.projectPath) return input.request.event.projectPath;
  const raw = input.request.event.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "unknown";
  const record = raw as Record<string, unknown>;
  for (const key of ["cwd", "projectPath", "project_path", "workingDirectory", "working_directory"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim().slice(0, 1_000);
  }
  return "unknown";
}

function normalizeResult(value: unknown): ContextualNecessityResult {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    necessaryForUserGoal: record.necessaryForUserGoal === true,
    minimalScope: record.minimalScope === true,
    exposesSecretValues: record.exposesSecretValues !== false,
    sendsDataExternally: record.sendsDataExternally !== false,
    confidence: record.confidence === "high" || record.confidence === "medium" ? record.confidence : "low",
    recommendation: record.recommendation === "allow" ? "allow" : "ask",
    reason: typeof record.reason === "string" ? record.reason.trim().slice(0, 500) : "",
  };
}

function redactSensitiveText(value: string) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATE_KEY_REDACTED]")
    .replace(/\b(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, "[TOKEN_REDACTED]")
    .replace(/\b(?:ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{12,}\b/g, "[TOKEN_REDACTED]")
    .replace(/\b(password|passwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|token)\s*[:=]\s*['"]?[^'"\s,}]{6,}/gi, "$1=[VALUE_REDACTED]");
}

function cacheKey(value: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pruneCache() {
  const now = Date.now();
  for (const [key, value] of necessityCache) {
    if (value.expiresAt <= now) necessityCache.delete(key);
  }
  while (necessityCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = necessityCache.keys().next().value as string | undefined;
    if (!oldest) break;
    necessityCache.delete(oldest);
  }
}

function safeDiagnostic(error: unknown) {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error))
    .replace(/\b(?:api[_ -]?key|token|secret|password)\s*(?:is|=|:|provided:?)\s*[^\s.,;]+/gi, "[REDACTED_CREDENTIAL]")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return message ? message.slice(0, 160) : "the evaluator returned no decision";
}

export function clearContextualNecessityCacheForTests() {
  necessityCache.clear();
}
