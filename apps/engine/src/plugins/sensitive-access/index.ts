import { type PluginCapabilities, type PolicyDecision } from "@openleash/shared";
import { eventForHookEvent } from "../events.js";
import { pluginRun, type EvaluationPipelineInput } from "../types.js";
import { contextMode, evaluateContextualNecessity, type ContextualNecessityDecision } from "../contextual-necessity.js";
import { sensitiveAccessManifest as manifest } from "./manifest.js";

export { manifest };

type Match = {
  policyId: string;
  policyName: string;
  severity: PolicyDecision["severity"];
  explanation: string;
  evidence: string[];
  action: "allow" | "ask" | "block";
  source?: "heuristic" | "llm";
};

type SensitiveLlmResult = {
  sensitiveResourceAccess: boolean;
  environmentDump: boolean;
  secretExposure: boolean;
  exfiltrationAttempt: boolean;
  shouldAsk: boolean;
  shouldBlock: boolean;
  severity: "low" | "medium" | "high" | "critical";
  reasons: string[];
  evidence: string[];
};

const SECRET_FILE_PATTERN = /(^|[\/\s"'`])(\.env(\.[\w-]+)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|kubeconfig|credentials|secrets?\.ya?ml|service-account[^\/\s"'`]*\.json|firebase[^\/\s"'`]*\.json)(?=$|[\/\s"'`:;])/i;
const SENSITIVE_RESOURCE_PHRASE_PATTERN = /\b(?:read|print|show|display|dump|open|inspect|cat|copy|expose)\b[\s\S]{0,80}\b(?:env(?:ironment)?\s+file|dotenv|secret(?:s)?\s+file|credential(?:s)?\s+file|private\s+key|api\s+key|token(?:s)?\s+file)\b|\b(?:env(?:ironment)?\s+file|dotenv|secret(?:s)?\s+file|credential(?:s)?\s+file|private\s+key|api\s+key|token(?:s)?\s+file)\b[\s\S]{0,80}\b(?:read|print|show|display|dump|open|inspect|cat|copy|expose)\b/i;
const ENV_DUMP_PATTERN = /\b(?:printenv\b|(?<!\.)env\s*(?:$|[|;&>"'])|set\s*(?:$|[|;&>"'])|export\s+-p\b|Get-ChildItem\s+Env:|gci\s+env:|dir\s+env:|process\.env\b|os\.environ\b)/i;
const SECRET_VALUE_PATTERN = /\b(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GOOGLE_APPLICATION_CREDENTIALS|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|NPM_TOKEN|DATABASE_URL|PRIVATE_KEY|KUBECONFIG|SLACK_BOT_TOKEN)\b/i;
const EXFIL_PATTERN = /\b(curl|wget|nc|netcat|scp|rsync|httpie|Invoke-WebRequest|iwr)\b|https?:\/\/|webhook|pastebin|requestbin|ngrok/i;

export async function runSensitiveAccess(input: EvaluationPipelineInput, capabilities: PluginCapabilities) {
  const startedAt = Date.now();
  const context = eventContext(input);
  const text = context.searchText;
  const config = pluginConfig(input.plugins?.get(manifest.id)?.config);
  const matches = detectSensitiveAccess(text, config);
  let contextual: ContextualNecessityDecision | undefined;
  const contextualMatches = matches.filter((match) => match.action === "ask");
  if (
    config.contextMode === "goal-aware"
    && contextualMatches.length > 0
    && input.request.event.eventName === "PreToolUse"
    && !EXFIL_PATTERN.test(text)
    && !isNeverAutoAllowedSensitiveAccess(text)
  ) {
    contextual = await evaluateContextualNecessity({
      pipeline: input,
      capabilities,
      protectionId: manifest.id,
      actionCategory: [...new Set(contextualMatches.map((match) => match.policyId))].sort().join(","),
      actionDescription: contextualMatches.map((match) => match.explanation).join(" "),
      evidence: contextualMatches.flatMap((match) => match.evidence),
    });
    if (contextual.allowWithoutAsking) {
      for (const match of contextualMatches) match.action = "allow";
    }
  }
  // The LLM result is deliberately ignored unless the event contains an actual
  // sensitive-resource, environment-dump, or exfiltration anchor. Avoid paying
  // for and blocking on a model call when it cannot affect the decision.
  const llm = matches.length === 0 && shouldUseSensitiveAccessLlm(text)
    ? await evaluateSensitiveAccess(context, capabilities).catch((error) => ({
        error: error instanceof Error ? error.message : String(error)
      }))
    : undefined;
  if (llm && "decision" in llm) {
    for (const match of matchesFromLlm(llm.decision, config, text)) {
      if (!matches.some((item) => item.policyId === match.policyId)) matches.push(match);
    }
  }
  const enforcedMatches = matches.filter((match) => match.action !== "allow");
  const results: PolicyDecision[] = enforcedMatches.map((match) => ({
    policyId: match.policyId,
    policyName: match.policyName,
    status: match.action === "block" ? "failed" : "needs_question",
    severity: match.severity,
    explanation: match.explanation,
    evidence: match.evidence,
    question: match.action === "ask" ? `Approve this sensitive access? ${match.explanation}` : undefined
  }));

  for (const result of results) {
    await capabilities.signals.emit({
      kind: "security.finding",
      severity: result.severity,
      title: result.policyName,
      summary: result.explanation,
      decision: result.status === "failed" ? "blocked" : "ask",
      status: result.status,
      target: { type: input.request.event.tool?.name ? "tool_call" : "agent_event", name: input.request.event.tool?.name ?? input.request.event.eventName },
      evidence: result.evidence ?? [],
      details: {
        pluginId: manifest.id,
        source: result.policyId.includes("llm") ? "llm" : "heuristic",
        contextMode: config.contextMode,
        contextualReason: contextual?.reason,
      },
      correlationKeys: ["sensitive-access", `session:${input.request.event.sessionId}`]
    });
  }
  for (const match of matches.filter((item) => item.action === "allow")) {
    await capabilities.signals.emit({
      kind: "security.finding",
      severity: match.severity,
      title: match.policyName,
      summary: `${match.explanation} Leash recorded it and let the agent continue.`,
      decision: "allow",
      status: "observed",
      target: { type: input.request.event.tool?.name ? "tool_call" : "agent_event", name: input.request.event.tool?.name ?? input.request.event.eventName },
      evidence: match.evidence,
      details: {
        pluginId: manifest.id,
        configuredAction: contextual?.allowWithoutAsking ? "ask" : "allow",
        contextMode: config.contextMode,
        contextuallyAllowed: Boolean(contextual?.allowWithoutAsking),
        contextualReason: contextual?.reason,
      },
      correlationKeys: ["sensitive-access", `session:${input.request.event.sessionId}`]
    });
  }
  if (results.length > 0) {
    await capabilities.log.emit({
      level: results.some((result) => result.status === "failed") ? "security" : "warn",
      category: "security",
      code: "sensitive-access-detected",
      message: results.length === 1 ? results[0].explanation : `${results.length} sensitive access patterns detected.`,
      data: {
        results,
        llm: llm && "decision" in llm ? { model: llm.model, decision: llm.decision } : llm,
        contextual,
      }
    });
  }

  return {
    results,
    run: pluginRun({
      pluginId: manifest.id,
      event: eventForHookEvent(input.request.event.eventName),
      status: results.some((result) => result.status === "failed") ? "blocked" : results.length ? "needs_question" : "passed",
      summary: results.length
        ? `${results.length} sensitive access pattern${results.length === 1 ? "" : "s"} detected.`
        : matches.length
          ? "Sensitive access was recorded and allowed by your setting."
          : "No sensitive access detected.",
      startedAt,
      findings: results.map((result) => ({
        title: result.policyName,
        severity: result.severity,
        summary: result.explanation,
        evidence: result.evidence
      })),
      metadata: {
        inspected: context.summary,
        llm: llm && "decision" in llm ? { model: llm.model, provider: llm.provider, source: llm.source } : llm,
        contextMode: config.contextMode,
        contextual,
      }
    })
  };
}

export function shouldUseSensitiveAccessLlm(text: string) {
  return SECRET_FILE_PATTERN.test(text) ||
    SENSITIVE_RESOURCE_PHRASE_PATTERN.test(text) ||
    ENV_DUMP_PATTERN.test(text) ||
    SECRET_VALUE_PATTERN.test(text) ||
    EXFIL_PATTERN.test(text);
}

async function evaluateSensitiveAccess(context: ReturnType<typeof eventContext>, capabilities: PluginCapabilities) {
  const result = await capabilities.llm.evaluateJson<SensitiveLlmResult>({
    purpose: "sensitive-access",
    system: "You are OpenLeash sensitive-access. Return only valid JSON. Be strict about secrets, credentials, env files, env var dumps, and exfiltration.",
    prompt: [
      "Analyze this AI-agent event for sensitive access.",
      "Answer these questions as JSON:",
      "- Does it look like the agent is accessing a sensitive resource such as .env, private keys, kubeconfig, npmrc, cloud credentials, database credentials, or service account files?",
      "- Does it look like an attempt to print, dump, list, or expose environment variables?",
      "- Does the agent answer/tool output expose secret values or meaningful partial secret values?",
      "- Does it look like exfiltration to an external service, URL, pastebin, webhook, network command, or remote copy?",
      "- Should OpenLeash ask the user, block the action, or pass?",
      "",
      JSON.stringify({
        agent: context.agent,
        event: context.event,
        prompt: context.prompt,
        tool: context.tool,
        toolInput: context.toolInput,
        toolOutput: context.toolOutput,
        recentTranscript: context.recentTranscript,
        raw: context.raw
      })
    ].join("\n"),
    maxOutputTokens: 700,
    temperature: 0,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "sensitiveResourceAccess",
        "environmentDump",
        "secretExposure",
        "exfiltrationAttempt",
        "shouldAsk",
        "shouldBlock",
        "severity",
        "reasons",
        "evidence"
      ],
      properties: {
        sensitiveResourceAccess: { type: "boolean" },
        environmentDump: { type: "boolean" },
        secretExposure: { type: "boolean" },
        exfiltrationAttempt: { type: "boolean" },
        shouldAsk: { type: "boolean" },
        shouldBlock: { type: "boolean" },
        severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
        reasons: { type: "array", items: { type: "string" } },
        evidence: { type: "array", items: { type: "string" } }
      }
    }
  });
  return result ? { decision: normalizeLlmDecision(result.json), model: result.model, provider: result.provider, source: result.source } : undefined;
}

function matchesFromLlm(result: SensitiveLlmResult, config: ReturnType<typeof pluginConfig>, text: string): Match[] {
  if (!result.sensitiveResourceAccess && !result.environmentDump && !result.secretExposure && !result.exfiltrationAttempt && !result.shouldAsk && !result.shouldBlock) {
    return [];
  }
  const hasSecretFile = SECRET_FILE_PATTERN.test(text) || SENSITIVE_RESOURCE_PHRASE_PATTERN.test(text);
  const hasEnvDump = ENV_DUMP_PATTERN.test(text) || SECRET_VALUE_PATTERN.test(text);
  const hasExternalExfiltration = EXFIL_PATTERN.test(text);
  if (!hasSecretFile && !hasEnvDump && !hasExternalExfiltration) return [];
  const action = result.exfiltrationAttempt && hasExternalExfiltration
    ? config.exfiltrationAction
    : result.environmentDump && hasEnvDump && !hasSecretFile
      ? config.envDumpAction
      : config.secretFileAction;
  return [{
    policyId: hasSecretFile ? "sensitive-access.llm-secret-file-review" : "sensitive-access.llm-review",
    policyName: result.exfiltrationAttempt || result.secretExposure ? "Sensitive data exposure" : "Sensitive access review",
    severity: result.severity,
    explanation: result.reasons.slice(0, 3).join(" ") || "The OpenLeash evaluation model identified sensitive resource access.",
    evidence: result.evidence.slice(0, 4),
    action,
    source: "llm"
  }];
}

function detectSensitiveAccess(text: string, config: ReturnType<typeof pluginConfig>): Match[] {
  const matches: Match[] = [];
  const add = (match: Match) => {
    if (!matches.some((item) => item.policyId === match.policyId)) matches.push(match);
  };
  const exfil = EXFIL_PATTERN.test(text);
  if (SECRET_FILE_PATTERN.test(text) || SENSITIVE_RESOURCE_PHRASE_PATTERN.test(text)) {
    add({
      policyId: "sensitive-access.secret-file",
      policyName: "Sensitive file access",
      severity: exfil ? "critical" : "high",
      explanation: exfil
        ? "The agent appears to access credential files and send or print them externally."
        : "The agent is trying to read or inspect files that commonly contain secrets.",
      evidence: snippets(text, [SECRET_FILE_PATTERN, SENSITIVE_RESOURCE_PHRASE_PATTERN, EXFIL_PATTERN]),
      action: exfil ? config.exfiltrationAction : config.secretFileAction
    });
  }
  if (ENV_DUMP_PATTERN.test(text) || SECRET_VALUE_PATTERN.test(text)) {
    add({
      policyId: "sensitive-access.env-dump",
      policyName: "Environment secret exposure",
      severity: exfil ? "critical" : "high",
      explanation: exfil
        ? "The agent appears to print environment secrets and send or pipe them externally."
        : "The agent is trying to print or inspect environment variables that may contain secrets.",
      evidence: snippets(text, [ENV_DUMP_PATTERN, SECRET_VALUE_PATTERN, EXFIL_PATTERN]),
      action: exfil ? config.exfiltrationAction : config.envDumpAction
    });
  }
  if (/cat\s+[^\n;&|]*(\.env|id_rsa|id_ed25519|credentials|kubeconfig)|grep\s+-R\s+[^\n;&|]*(token|secret|password|api[_-]?key)/i.test(text)) {
    const exfil = EXFIL_PATTERN.test(text);
    add({
      policyId: "sensitive-access.secret-harvest",
      policyName: "Secret harvesting command",
      severity: "critical",
      explanation: "The agent is using shell patterns commonly used to harvest secrets from local files.",
      evidence: snippets(text, [/cat\s+[^\n;&|]*/i, /grep\s+-R\s+[^\n;&|]*/i]),
      action: exfil ? config.exfiltrationAction : config.secretFileAction
    });
  }
  return matches;
}

function eventText(input: EvaluationPipelineInput) {
  return [
    input.request.event.tool?.name,
    JSON.stringify(input.request.event.tool?.input ?? {}),
    JSON.stringify(input.request.event.tool?.output ?? {}),
    input.request.event.prompt,
    !input.request.event.tool && !input.request.event.prompt
      ? JSON.stringify(input.request.event.raw ?? {})
      : undefined
  ].filter(Boolean).join("\n");
}

function eventContext(input: EvaluationPipelineInput) {
  const recentTranscript = input.request.event.transcript?.slice(-6) ?? [];
  const raw = compactUnknown(input.request.event.raw, 6000);
  const toolInput = compactUnknown(input.request.event.tool?.input, 6000);
  const toolOutput = compactUnknown(input.request.event.tool?.output, 6000);
  return {
    agent: input.request.agent,
    event: {
      eventName: input.request.event.eventName,
      sessionId: input.request.event.sessionId,
      projectPath: input.request.event.projectPath,
      occurredAt: input.request.event.occurredAt
    },
    prompt: input.request.event.prompt,
    tool: input.request.event.tool?.name,
    toolInput,
    toolOutput,
    recentTranscript,
    raw,
    summary: {
      hasPrompt: Boolean(input.request.event.prompt),
      hasToolInput: toolInput !== undefined,
      hasToolOutput: toolOutput !== undefined,
      transcriptTurns: recentTranscript.length,
      rawKeys: raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw).slice(0, 20) : []
    },
    searchText: eventText(input)
  };
}

function normalizeLlmDecision(value: unknown): SensitiveLlmResult {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const boolean = (key: string) => record[key] === true;
  const severity = record.severity === "critical" || record.severity === "high" || record.severity === "medium" || record.severity === "low"
    ? record.severity
    : "high";
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 500)) : [];
  return {
    sensitiveResourceAccess: boolean("sensitiveResourceAccess"),
    environmentDump: boolean("environmentDump"),
    secretExposure: boolean("secretExposure"),
    exfiltrationAttempt: boolean("exfiltrationAttempt"),
    shouldAsk: boolean("shouldAsk"),
    shouldBlock: boolean("shouldBlock"),
    severity,
    reasons: strings(record.reasons),
    evidence: strings(record.evidence)
  };
}

function compactUnknown(value: unknown, max: number): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max - 1)}...` : value;
  const text = JSON.stringify(value);
  if (text.length <= max) return value;
  return `${text.slice(0, max - 1)}...`;
}

function pluginConfig(config: Record<string, unknown> | undefined) {
  const action = (value: unknown, fallback: "allow" | "ask" | "block") => value === "allow" || value === "ask" || value === "block" ? value : fallback;
  return {
    contextMode: contextMode(config?.contextMode),
    secretFileAction: action(config?.secretFileAction, "ask"),
    envDumpAction: action(config?.envDumpAction, "ask"),
    exfiltrationAction: action(config?.exfiltrationAction, "block")
  };
}

function isNeverAutoAllowedSensitiveAccess(text: string) {
  return /(?:^|[\/\s"'`])(?:\.netrc|\.npmrc|\.pypirc|id_rsa|id_ed25519|kubeconfig|credentials|secrets?\.ya?ml|service-account[^\s"'`]*\.json|firebase[^\s"'`]*\.json)(?=$|[\/\s"'`:;])|\bprivate\s+key\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text);
}

function snippets(text: string, patterns: RegExp[]) {
  return patterns.flatMap((pattern) => {
    const match = text.match(pattern);
    return match?.[0] ? [match[0].slice(0, 240)] : [];
  }).slice(0, 4);
}
