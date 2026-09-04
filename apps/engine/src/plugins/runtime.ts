import { createPluginCapabilities } from "./capabilities.js";
import { runBlastRadius } from "./blast-radius/index.js";
import { runDlp } from "./dlp/index.js";
import { runCodeScanner } from "./code-scanner/index.js";
import { runMcpScanner } from "./mcp-scanner/index.js";
import { runPromptCompression } from "./prompt-compression/index.js";
import {
  pluginSupportsAgent,
  pluginsForEvent,
  orderPlugins,
} from "./registry.js";
import { eventForHookEvent } from "./events.js";
import { runSecurityEvaluator } from "./security-evaluator/index.js";
import { runSensitiveAccess } from "./sensitive-access/index.js";
import {
  type EvaluationPipelineInput,
  type EvaluationPipelineResult,
  type PromptPipelineInput,
  type PromptPipelineResult,
} from "./types.js";
import type {
  OpenLeashPluginManifest,
  PipelineEvent,
  PluginRunRecord,
  PluginSettingState,
} from "@openleash/shared";

export async function runPromptPipeline(
  input: PromptPipelineInput,
): Promise<PromptPipelineResult> {
  let current = input.request.event.prompt ?? "";
  const runs: PromptPipelineResult["runs"] = [];
  const models = new Set<string>();
  let compression: PromptPipelineResult["compression"];
  let dlp: PromptPipelineResult["dlp"];

  for (const plugin of enabledPluginsForEvent(
    "prompt.beforeSubmit",
    input.plugins,
    input.request.agent.kind,
  ).filter((plugin) => plugin.effects.includes("transform"))) {
    if (featureAlreadyApplied(input.request, plugin.id)) continue;
    const monitorOnly = pluginProtectionMode(input.plugins, plugin.id) === "monitor";
    const capabilities = createPluginCapabilities({
      tenantModelKey: input.tenantModelKey,
      organizationId: input.organizationId,
      pluginId: plugin.id,
      request: input.request,
      conversationEventId: input.conversationEventId,
      userId: input.userId,
      computerId: input.computerId,
      runtimeId: input.runtimeId,
      permissions: plugin.permissions,
    });
    try {
      if (plugin.id === "openleash.prompt-compression") {
        const promptBeforePlugin = current;
        const step = await runPromptCompression({
          prompt: current,
          config: input.config.compression,
          capabilities,
          startedAt: Date.now(),
          supportsPromptReplacement: sourceAllowsPromptReplacement(input.request),
        });
        current = step.prompt;
        if (monitorOnly) current = promptBeforePlugin;
        runs.push(step.run);
        if (step.result?.model) models.add(step.result.model);
        if (step.result?.compression) compression = step.result.compression;
        continue;
      }

      if (plugin.id === "openleash.dlp") {
        const promptBeforePlugin = current;
        const step = await runDlp({
          prompt: current,
          config: input.config.dlp,
          capabilities,
          startedAt: Date.now(),
          recentTranscript: input.request.event.transcript,
        });
        current = step.prompt;
        if (monitorOnly) current = promptBeforePlugin;
        runs.push(step.run);
        if (step.result?.model) models.add(step.result.model);
        if (step.result?.dlp) dlp = step.result.dlp;
        if (step.result?.blocked && !monitorOnly) {
          return {
            finalPrompt: current,
            blocked: true,
            summary: step.result.summary,
            model: [...models].join(", ") || "none",
            compression,
            dlp,
            runs,
          };
        }
        if (step.result?.requiresApproval && !monitorOnly) {
          return {
            finalPrompt: current,
            blocked: false,
            requiresApproval: true,
            summary: step.result.summary,
            model: [...models].join(", ") || "none",
            compression,
            dlp,
            runs,
          };
        }
      }
    } catch (error) {
      const failure = pluginFailureRun(plugin, "prompt.beforeSubmit", error);
      runs.push(failure);
      if ((plugin.execution?.failureMode ?? "closed") === "closed" && !monitorOnly) {
        return {
          finalPrompt: current,
          blocked: false,
          requiresApproval: true,
          summary: pluginFailureApprovalExplanation(plugin, error),
          model: [...models].join(", ") || "none",
          compression,
          dlp,
          runs,
        };
      }
    }
  }

  return {
    finalPrompt: current,
    blocked: false,
    summary: promptPipelineSummary(
      input.request.event.prompt ?? "",
      current,
      compression,
      dlp,
    ),
    model: [...models].join(", ") || "none",
    compression,
    dlp,
    runs,
  };
}

function featureAlreadyApplied(
  request: PromptPipelineInput["request"],
  pluginId: string,
) {
  const raw =
    request.event.raw && typeof request.event.raw === "object"
      ? (request.event.raw as Record<string, unknown>)
      : undefined;
  if (
    Array.isArray(raw?.containerPluginApplied) &&
    raw.containerPluginApplied.includes(pluginId)
  ) {
    return true;
  }
  // Existing proxies use these compatibility fields. A Feature that already
  // inspected a request owns that event even when it returned `unchanged`.
  return Array.isArray(raw?.containerPluginRuns) &&
    raw.containerPluginRuns.some((run) => {
      if (!run || typeof run !== "object") return false;
      const record = run as { pluginId?: unknown; status?: unknown };
      return record.pluginId === pluginId && record.status !== "failed";
    });
}

function sourceAllowsPromptReplacement(
  request: PromptPipelineInput["request"],
) {
  const raw =
    request.event.raw && typeof request.event.raw === "object"
      ? (request.event.raw as Record<string, unknown>)
      : undefined;
  const envelope =
    raw?.openleashEventEnvelope &&
    typeof raw.openleashEventEnvelope === "object"
      ? (raw.openleashEventEnvelope as {
          capabilities?: { rewritePrompt?: unknown };
        })
      : undefined;
  if (envelope) return envelope.capabilities?.rewritePrompt === true;
  // Legacy direct callers retain their protocol behavior until migrated to the envelope.
  return !["claude", "claude-code", "nanoclaw"].includes(
    String(request.agent.kind).toLowerCase(),
  );
}

export async function runEvaluationPipeline(
  input: EvaluationPipelineInput,
): Promise<EvaluationPipelineResult> {
  const event = eventForHookEvent(input.request.event.eventName);
  const steps = await Promise.all(
    enabledPluginsForEvent(event, input.plugins, input.request.agent.kind)
      // Prompt transformers own their prompt.beforeSubmit execution in
      // runPromptPipeline. Running them again here duplicates container work,
      // metrics, and notifications. Evaluation plugins remain owned here.
      .filter(
        (plugin) =>
          event !== "prompt.beforeSubmit" ||
          !plugin.effects.includes("transform"),
      )
      .map(
      async (plugin) => {
        if (featureAlreadyApplied(input.request, plugin.id)) {
          return { pluginId: plugin.id, results: [], runs: [], model: "none" };
        }
        const capabilities = createPluginCapabilities({
          tenantModelKey: input.tenantModelKey,
          organizationId: input.organizationId,
          pluginId: plugin.id,
          request: input.request,
          conversationEventId: input.conversationEventId,
          userId: input.userId,
          computerId: input.computerId,
          runtimeId: input.runtimeId,
          permissions: plugin.permissions,
        });
        try {
          if (plugin.id === "openleash.sensitive-access") {
            const result = await runSensitiveAccess(input, capabilities);
            return { pluginId: plugin.id, results: result.results, runs: [result.run], model: "none" };
          }
          if (plugin.id === "openleash.code-scanner") {
            const run = await runCodeScanner(
              input.request,
              event,
              capabilities,
              input.plugins?.get(plugin.id)?.config,
            );
            return { pluginId: plugin.id, results: [], runs: [run], model: String(run.metadata?.evaluatedBy ?? "none") };
          }
          if (plugin.id === "openleash.blast-radius") {
            const result = await runBlastRadius(input, capabilities);
            return { pluginId: plugin.id, results: result.results, runs: [result.run], model: "none" };
          }
          if (plugin.id === "openleash.rules-enforcer") {
            const result = await runSecurityEvaluator(input, capabilities);
            return { pluginId: plugin.id, results: result.results, runs: [result.run], model: result.model };
          }
          if (plugin.id === "openleash.mcp-scanner") {
            const result = await runMcpScanner(input, capabilities);
            return { pluginId: plugin.id, results: [], runs: [result.run], model: "none", mcpCall: result.call };
          }
          return { pluginId: plugin.id, results: [], runs: [], model: "none" };
        } catch (error) {
          const failure = pluginFailureRun(plugin, event, error);
          if ((plugin.execution?.failureMode ?? "closed") === "closed") {
            return {
              results: [{
                policyId: `${plugin.id}.runtime-failure`,
                policyName: `${pluginSlug(plugin)} runtime`,
                status: "needs_question" as const,
                severity: "high" as const,
                explanation: pluginFailureApprovalExplanation(plugin, error),
                evidence: [],
                question: `${pluginSlug(plugin)} could not complete its safety check. Allow this action once?`,
              }],
              pluginId: plugin.id,
              runs: [failure],
              model: "none",
            };
          }
          return {
            pluginId: plugin.id,
            results: [],
            runs: [failure],
            model: "none",
          };
        }
      },
    ),
  );

  return {
    results: steps.flatMap((step) =>
      pluginProtectionMode(input.plugins, step.pluginId) === "monitor"
        ? step.results.map((result) => ({
            ...result,
            status: "passed" as const,
            explanation: `Monitor only: ${result.explanation}`,
            question: undefined,
          }))
        : step.results
    ),
    model:
      steps.map((step) => step.model).find((model) => model !== "none") ??
      "none",
    runs: steps.flatMap((step) => step.runs),
    mcpCall: steps.find((step) => step.mcpCall)?.mcpCall,
  };
}

function pluginProtectionMode(
  settings: Map<string, PluginSettingState> | undefined,
  pluginId: string,
) {
  const mode = settings?.get(pluginId)?.config?.protectionMode;
  return mode === "monitor" || mode === "off" ? mode : "active";
}

function pluginSlug(plugin: OpenLeashPluginManifest) {
  return plugin.slug || plugin.id.replace(/^openleash\./, "");
}

function pluginFailureApprovalExplanation(
  plugin: OpenLeashPluginManifest,
  error: unknown,
) {
  const diagnostic = safePluginFailureDiagnostic(error);
  return `${pluginSlug(plugin)} could not complete its safety check: ${diagnostic}. Leash is holding the action for your approval.`;
}

export function safePluginFailureDiagnostic(error: unknown) {
  const diagnostic = (error instanceof Error ? error.message : String(error))
    .replace(/\b(?:sk|key|token|secret)-[A-Za-z0-9_-]{4,}\b/gi, "[redacted credential]")
    .replace(/\b(?:api[_ -]?key|token|secret|password)\s*(?:is|=|:|provided:?)\s*[^\s.,;]+/gi, "[redacted credential]")
    .trim();
  if (/\b401\b|incorrect api key|invalid api key|unauthori[sz]ed|authentication/i.test(diagnostic))
    return "the configured evaluator credentials were rejected";
  if (/timed? out|timeout|abort(?:ed)?/i.test(diagnostic))
    return "the evaluator timed out";
  return diagnostic.length > 180
    ? `${diagnostic.slice(0, 177)}...`
    : diagnostic || "the evaluator returned an unknown error";
}

function pluginFailureRun(
  plugin: OpenLeashPluginManifest,
  event: PipelineEvent,
  error: unknown,
): PluginRunRecord {
  return {
    pluginId: plugin.id,
    event,
    status: "failed",
    summary: error instanceof Error ? error.message : String(error),
  };
}

function enabledPluginsForEvent(
  event: PipelineEvent,
  settings?: Map<string, PluginSettingState>,
  agentKind?: string,
) {
  const plugins = pluginsForEvent(event)
    .filter(
      (plugin) =>
        plugin.executionEnvironment !== "cloud-only" ||
        isOpenLeashCloudRuntime(),
    )
    .filter((plugin) => {
      const state = settings?.get(plugin.id);
      return (settings ? state?.enabled === true : true) &&
        state?.runtimeAvailable !== false &&
        pluginProtectionMode(settings, plugin.id) !== "off";
    })
    .filter((plugin) => pluginSupportsAgent(plugin, agentKind))
    .map((plugin) => {
      const priority = settings?.get(plugin.id)?.orderingPriority;
      if (priority === undefined || priority === null) return plugin;
      return {
        ...plugin,
        ordering: {
          ...(plugin.ordering ?? {}),
          priority,
        },
      } satisfies OpenLeashPluginManifest;
    });
  return orderPlugins(plugins);
}

function isOpenLeashCloudRuntime() {
  return ["cloud", "public-cloud", "openleash-cloud"].includes(
    String(process.env.OPENLEASH_DEPLOYMENT_MODE ?? "").toLowerCase(),
  );
}

function promptPipelineSummary(
  originalPrompt: string,
  finalPrompt: string,
  compression?: PromptPipelineResult["compression"],
  dlp?: PromptPipelineResult["dlp"],
) {
  const parts: string[] = [];
  if (compression?.enabled) {
    const saved = Math.max(0, Math.round((1 - compression.ratio) * 100));
    parts.push(
      saved > 0
        ? `token-saver reduced the prompt by ${saved}%`
        : "token-saver checked the prompt",
    );
  }
  if (dlp?.enabled) {
    if (dlp.masked)
      parts.push(`masked ${dlp.categories.join(", ") || "sensitive data"}`);
    else if (dlp.matched)
      parts.push(`detected ${dlp.categories.join(", ") || "sensitive data"}`);
    else parts.push("data-leakage-prevention checked the prompt");
  }
  if (parts.length === 0) return "No prompt Features were enabled.";
  if (finalPrompt !== originalPrompt)
    return `Leash ${parts.join(" and ")}.`;
  return `Leash ${parts.join(" and ")}. Prompt was unchanged.`;
}
