import { type PluginCapabilities, type PolicyDecision } from "@openleash/shared";
import { eventForHookEvent } from "../events.js";
import { pluginRun, type EvaluationPipelineInput } from "../types.js";
import { contextMode, evaluateContextualNecessity, type ContextualNecessityDecision } from "../contextual-necessity.js";
import { blastRadiusManifest as manifest } from "./manifest.js";

export { manifest };

type Match = {
  policyId: string;
  policyName: string;
  severity: PolicyDecision["severity"];
  explanation: string;
  evidence: string[];
  action: "allow" | "ask" | "block";
};

export async function runBlastRadius(input: EvaluationPipelineInput, capabilities: PluginCapabilities) {
  const startedAt = Date.now();
  const text = eventText(input);
  const config = pluginConfig(input.plugins?.get(manifest.id)?.config);
  const matches = detectBlastRadius(text, config);
  let contextual: ContextualNecessityDecision | undefined;
  const contextualMatches = matches.filter((match) => match.action === "ask");
  if (
    config.contextMode === "goal-aware"
    && contextualMatches.length > 0
    && input.request.event.eventName === "PreToolUse"
    && !isInherentlyBroadDestruction(text)
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
  const enforcedMatches = matches.filter((match) => match.action !== "allow");
  const results: PolicyDecision[] = enforcedMatches.map((match) => ({
    policyId: match.policyId,
    policyName: match.policyName,
    status: match.action === "block" ? "failed" : "needs_question",
    severity: match.severity,
    explanation: match.explanation,
    evidence: match.evidence,
    question: match.action === "ask" ? `Approve this potentially high-blast-radius action? ${match.explanation}` : undefined
  }));

  for (const result of results) {
    await capabilities.signals.emit({
      kind: "security.finding",
      severity: result.severity,
      title: result.policyName,
      summary: result.explanation,
      decision: result.status === "failed" ? "blocked" : "ask",
      status: result.status,
      target: { type: "tool_call", name: input.request.event.tool?.name ?? input.request.event.eventName },
      evidence: result.evidence ?? [],
      details: {
        pluginId: manifest.id,
        contextMode: config.contextMode,
        contextualReason: contextual?.reason,
      },
      correlationKeys: ["blast-radius", `tool:${input.request.event.tool?.name ?? "unknown"}`]
    });
  }
  if (matches.length > 0) {
    const primaryMatch = matches[0];
    if (primaryMatch.action === "allow") {
      await capabilities.signals.emit({
        kind: "security.finding",
        severity: primaryMatch.severity,
        title: primaryMatch.policyName,
        summary: `${primaryMatch.explanation} Leash recorded it and let the agent continue.`,
        decision: "allow",
        status: "observed",
        target: { type: "tool_call", name: input.request.event.tool?.name ?? input.request.event.eventName },
        evidence: primaryMatch.evidence,
        details: {
          pluginId: manifest.id,
          configuredAction: contextual?.allowWithoutAsking ? "ask" : "allow",
          contextMode: config.contextMode,
          contextuallyAllowed: Boolean(contextual?.allowWithoutAsking),
          contextualReason: contextual?.reason,
        },
        correlationKeys: ["blast-radius", `tool:${input.request.event.tool?.name ?? "unknown"}`]
      });
    }
  }
  if (results.length > 0) {
    const primary = results[0];
    await capabilities.island.annotateSession({
      key: "destructive-risk",
      label: primary.policyName,
      detail: primary.explanation,
      value: primary.severity,
      tone: primary.severity === "critical" ? "danger" : "warning",
      ttlSeconds: 180,
      action: { id: "open-session", label: "Open session", type: "open-session" },
    });
    await capabilities.log.emit({
      level: results.some((result) => result.status === "failed") ? "security" : "warn",
      category: "security",
      code: "blast-radius-detected",
      message: results.length === 1 ? results[0].explanation : `${results.length} high-blast-radius patterns detected.`,
      data: { results }
    });
  }
  else await capabilities.island.clear({ key: "destructive-risk" });

  return {
    results,
    run: pluginRun({
      pluginId: manifest.id,
      event: eventForHookEvent(input.request.event.eventName),
      status: results.some((result) => result.status === "failed") ? "blocked" : results.length ? "needs_question" : "passed",
      summary: results.length
        ? `${results.length} high-blast-radius pattern${results.length === 1 ? "" : "s"} detected.`
        : matches.length
          ? "A destructive pattern was recorded and allowed by your setting."
          : "No destructive tool use detected.",
      startedAt,
      findings: results.map((result) => ({
        title: result.policyName,
        severity: result.severity,
        summary: result.explanation,
        evidence: result.evidence
      })),
      metadata: {
        contextMode: config.contextMode,
        contextual,
      },
    })
  };
}

function detectBlastRadius(text: string, config: ReturnType<typeof pluginConfig>): Match[] {
  const matches: Match[] = [];
  const add = (match: Match) => {
    if (!matches.some((item) => item.policyId === match.policyId)) matches.push(match);
  };
  if (/\brm\s+-[a-z]*r[a-z]*\b|\brm\s+.*\s(\/|\*|~|\$HOME)\b|\bfind\b.+(?:^|\s)-delete\b|\bshutil\.rmtree\s*\(|\b(?:fs\.)?(?:rmSync|rm)\s*\([^)]*recursive\s*:\s*true|\bFileUtils\.rm_rf\b|\bRemove-Item\b[^\n;&|]*(?:^|\s)-Recurse\b|\btruncate\s+(?:-[^\s]+\s+)*0\s+[^\n;&|]+|\bdd\b[^\n;&|]*\bif=\/dev\/zero\b[^\n;&|]*\bof=\S+/im.test(text)) {
    add({
      policyId: "blast-radius.filesystem-destructive",
      policyName: "Destructive filesystem operation",
      severity: "critical",
      explanation: "The agent is trying to delete files recursively or with broad wildcards.",
      evidence: snippets(text, [/rm\s+[^\n;&|]+/i, /find\s+[^\n;&|]+-delete[^\n;&|]*/i, /(?:shutil\.rmtree|(?:fs\.)?(?:rmSync|rm)|FileUtils\.rm_rf|Remove-Item|truncate|dd)\b[^\n;&|]*/i]),
      action: config.broadFilesystemAction
    });
  }
  if (/\b(?:completely|entirely|fully|permanently)?\s*(?:delete|remove|erase|wipe|purge)\b[\s\S]{0,80}\b(?:all|every)\b[\s\S]{0,40}\b(?:files?|folders?|directories?|contents?)\b|\b(?:delete|remove|erase|wipe|purge)\b[\s\S]{0,80}\b(?:files?|folders?|directories?|contents?)\b[\s\S]{0,40}\b(?:completely|entirely|fully|permanently|all)\b/i.test(text)) {
    add({
      policyId: "blast-radius.filesystem-destructive",
      policyName: "Destructive filesystem operation",
      severity: "critical",
      explanation: "The agent is being asked to delete all files or contents from a folder.",
      evidence: snippets(text, [/(?:delete|remove|erase|wipe|purge)[^\n]{0,160}(?:files?|folders?|directories?|contents?)/i]),
      action: config.broadFilesystemAction
    });
  }
  if (/\b(drop|truncate)\s+(database|schema|table)\b|\b(?:drops?|truncates?|deletes?|removes?|wipes?)\b[\s\S]{0,50}\b(?:all|every)\b[\s\S]{0,30}\b(?:databases?|schemas?|tables?)\b|\b(?:all|every)\b[\s\S]{0,30}\b(?:databases?|schemas?|tables?)\b[\s\S]{0,50}\b(?:drops?|truncates?|deletes?|removes?|wipes?)\b|\b(?:delete|remove|wipe)\s+(?:my\s+)?tables?\b[\s\S]{0,60}\b(?:sqlite|database)\b|\bdelete\s+from\s+[\w".]+\s*(;|$)|\bupdate\s+[\w".]+\s+set\b(?![\s\S]{0,120}\bwhere\b)/i.test(text)) {
    add({
      policyId: "blast-radius.database-mutation",
      policyName: "Broad database mutation",
      severity: "high",
      explanation: "The agent is trying to run a destructive or broad database mutation.",
      evidence: snippets(text, [/(drop|truncate)\s+(database|schema|table)[^\n;&]*/i, /(?:drops?|truncates?|deletes?|removes?|wipes?)[^\n]{0,80}(?:all|every)[^\n]{0,50}(?:databases?|schemas?|tables?)/i, /delete\s+from\s+[^\n;&]*/i, /update\s+[\w".]+\s+set[^\n;&]*/i]),
      action: config.databaseMutationAction
    });
  }
  if (/\bkubectl\s+delete\b|\bterraform\s+destroy\b|\baws\s+[^;&\n]*(delete|terminate|detach|revoke)\b|\bgcloud\s+[^;&\n]*\bdelete\b|\baz\s+[^;&\n]*\bdelete\b/i.test(text)) {
    add({
      policyId: "blast-radius.infrastructure-destructive",
      policyName: "Destructive infrastructure operation",
      severity: "critical",
      explanation: "The agent is trying to delete, destroy, or terminate infrastructure resources.",
      evidence: snippets(text, [/kubectl\s+delete[^\n;&]*/i, /terraform\s+destroy[^\n;&]*/i, /(aws|gcloud|az)\s+[^\n;&]*(delete|terminate|detach|revoke)[^\n;&]*/i]),
      action: config.destructiveAction
    });
  }
  if (/\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+(?=[^\n;&]*-[a-z]*f)[^\n;&]+|\bgit\s+(?:checkout\s+--|restore)\s+\.(?=$|[\s"';&|])|\bchmod\s+-R\s+777\b|\bchown\s+-R\b/i.test(text)) {
    add({
      policyId: "blast-radius.workspace-destructive",
      policyName: "Destructive workspace operation",
      severity: "high",
      explanation: "The agent is trying to rewrite, purge, or broadly weaken workspace state.",
      evidence: snippets(text, [/git\s+reset\s+--hard[^\n;&]*/i, /git\s+clean\s+[^\n;&]*/i, /git\s+(?:checkout\s+--|restore)\s+\.[^\n;&]*/i, /(chmod|chown)\s+-R[^\n;&]*/i]),
      action: config.destructiveAction
    });
  }
  return matches;
}

function eventText(input: EvaluationPipelineInput) {
  const toolInput = input.request.event.tool?.input;
  const command = toolInput && typeof toolInput === "object" && typeof (toolInput as Record<string, unknown>).command === "string"
    ? String((toolInput as Record<string, unknown>).command)
    : undefined;
  const serializedToolInput = command === undefined
    ? JSON.stringify(toolInput ?? {})
    : isDisplayOnlyShellCommand(command) ? "" : command;
  return [
    input.request.event.tool?.name,
    serializedToolInput,
    discussionSafePrompt(input.request.event.prompt),
    command === undefined && !input.request.event.prompt ? JSON.stringify(input.request.event.raw ?? {}) : undefined
  ].filter(Boolean).join("\n");
}

function discussionSafePrompt(prompt: string | undefined) {
  if (!prompt) return prompt;
  const discussesOnly = /\b(?:explain|describe|document|documentation|example|why|what does|without (?:running|executing)|do not (?:run|execute))\b/i.test(prompt);
  const alsoRequestsExecution = /\b(?:then|and)\s+(?:run|execute|delete|remove|wipe|drop)|\b(?:please|now)\s+(?:run|execute|delete|remove|wipe|drop)\b/i.test(prompt);
  if (!discussesOnly || alsoRequestsExecution) return prompt;
  return prompt.replace(/`[^`]+`/g, "[documented command]");
}

function isDisplayOnlyShellCommand(command: string) {
  const trimmed = command.trim();
  if (!/^(?:echo|printf|grep|rg)\b/i.test(trimmed)) return false;
  // A command that starts by printing text may still execute a destructive
  // second command. Only suppress matching when it is one simple shell command.
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      if (quote !== "'" && (
        (character === "$" && trimmed[index + 1] === "(")
        || character === "`"
        || ((character === "<" || character === ">") && trimmed[index + 1] === "(")
      )) return false;
      continue;
    }
    if (
      (character === "$" && trimmed[index + 1] === "(")
      || character === "`"
      || ((character === "<" || character === ">") && trimmed[index + 1] === "(")
    ) return false;
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === ";" || character === "\n" || character === "|" || character === "&") return false;
  }
  return true;
}

function pluginConfig(config: Record<string, unknown> | undefined) {
  const action = (value: unknown, fallback: "allow" | "ask" | "block") => value === "allow" || value === "ask" || value === "block" ? value : fallback;
  return {
    contextMode: contextMode(config?.contextMode),
    destructiveAction: action(config?.destructiveAction, "ask"),
    databaseMutationAction: action(config?.databaseMutationAction, "ask"),
    broadFilesystemAction: action(config?.broadFilesystemAction, "ask")
  };
}

function isInherentlyBroadDestruction(text: string) {
  return /\brm\s+-[a-z]*r[a-z]*\s+(?:-[^\s]+\s+)*(?:\/(?=$|[\s"';&|])|~(?=$|[\s"';&|])|\$HOME\b|\*)|\bterraform\s+destroy\b(?![^\n;&]*\s-target(?:=|\s))|\b(?:drop|truncate)\s+(?:database|schema)\b|\b(?:delete|remove|erase|wipe|purge|drop|truncate)\b[^\n]{0,100}\b(?:all|every)\b/i.test(text);
}

function snippets(text: string, patterns: RegExp[]) {
  return patterns.flatMap((pattern) => {
    const match = text.match(pattern);
    return match?.[0] ? [match[0].slice(0, 240)] : [];
  }).slice(0, 4);
}
