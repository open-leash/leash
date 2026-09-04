export type ActivityIslandEvent = {
  event_name?: string;
  tool_name?: string;
  prompt?: string;
  summary?: string;
  created_at?: string;
};

export type ActivityIslandSourceSession = {
  id: string;
  session_id?: string;
  title?: string;
  summary?: string;
  project_path?: string;
  started_at?: string;
  last_activity_at?: string;
  duration_seconds?: number;
  event_count?: number;
  events?: ActivityIslandEvent[];
};

export type ActivityIslandSourceAgent = {
  kind: string;
  display_name: string;
  hostname?: string;
  event_name?: string;
  tool_name?: string;
  project_path?: string;
  activity_at?: string;
  short_summary?: string;
  sessions?: ActivityIslandSourceSession[];
};

export type ActiveAgentSession = {
  id: string;
  sessionId: string;
  sourceSessionIds: string[];
  agentKind: string;
  agentName: string;
  projectPath?: string;
  project: string;
  title: string;
  summary: string;
  latestAction: string;
  lastActivityAt: string;
  durationSeconds: number;
  eventCount: number;
  events: ActivityIslandEvent[];
  visualState: "processing" | "running" | "waiting" | "completed";
  monitoringPausedUntil?: string;
};

export type CompletedAgentSession = {
  completedAt: number;
  response?: string;
};

export type AgentAttentionTarget = {
  agentKind?: string;
  projectPath?: string;
  sessionId?: string;
};

export type ImmediateAgentActivity = {
  agentKind: string;
  agentName: string;
  eventName: string;
  sessionId: string;
  projectPath?: string;
  prompt?: string;
  toolName?: string;
  occurredAt: string;
};

export type IslandVisibility = "always" | "activity" | "notifications" | "off";

export function shouldPresentActivityIsland(input: {
  visibility: IslandVisibility;
  hasPending: boolean;
  hasVisibleActivity: boolean;
  manualReveal?: boolean;
}) {
  if (input.visibility === "off") return false;
  if (input.hasPending || input.manualReveal) return true;
  if (input.visibility === "notifications") return false;
  return input.visibility === "always" || input.hasVisibleActivity;
}

export function activityIslandPresentationSummary(input: {
  sessionCount: number;
  activeSessionCount: number;
  pluginUpdateCount: number;
  pendingCount?: number;
  pendingAgentName?: string;
}) {
  const pendingCount = Math.max(0, input.pendingCount ?? 0);
  if (pendingCount > 0) {
    return {
      title: `${pendingCount} approval${pendingCount === 1 ? "" : "s"} waiting`,
      project: `${input.pendingAgentName || "Agent"} needs your attention`,
    };
  }
  if (input.sessionCount === 0 && input.pluginUpdateCount === 0) {
    return { title: "Leash", project: "Watching your agents" };
  }
  if (input.sessionCount === 0) {
    return {
      title: `${input.pluginUpdateCount} plugin update${input.pluginUpdateCount === 1 ? "" : "s"}`,
      project: "Plugin activity",
    };
  }
  if (input.activeSessionCount === 0) {
    return {
      title: input.sessionCount === 1
        ? "Agent finished"
        : `${input.sessionCount} recent sessions`,
      project: `${input.sessionCount} recent session${input.sessionCount === 1 ? "" : "s"}`,
    };
  }
  const completedSessionCount = input.sessionCount - input.activeSessionCount;
  return {
    title: completedSessionCount > 0
      ? `${input.activeSessionCount} working · ${completedSessionCount} done`
      : input.sessionCount === 1
        ? "Agent working"
        : `${input.sessionCount} agents working`,
    project: completedSessionCount > 0
      ? `${input.activeSessionCount} active · ${completedSessionCount} recent`
      : `${input.sessionCount} active session${input.sessionCount === 1 ? "" : "s"}`,
  };
}

export function islandDisplayTargets(
  displayIds: number[],
  activeDisplayId: number,
  hasPassiveIsland: boolean,
) {
  return displayIds.map((displayId) => ({
    displayId,
    presentation: displayId === activeDisplayId
      ? "active" as const
      : hasPassiveIsland
        ? "passive" as const
        : "hidden" as const,
  }));
}

const TERMINAL_EVENTS = new Set(["sessionend", "stop", "completed", "agentstop"]);

export function mergeImmediateAgentActivity(
  previous: ActivityIslandSourceAgent | undefined,
  activity: ImmediateAgentActivity,
): ActivityIslandSourceAgent {
  const previousSession = previous?.sessions?.[0];
  const prompt = activity.eventName.toLowerCase() === "userpromptsubmit"
    ? userFacingText(activity.prompt)
    : undefined;
  const event: ActivityIslandEvent = {
    event_name: activity.eventName,
    tool_name: activity.toolName,
    prompt,
    created_at: activity.occurredAt,
  };
  const events = uniqueEvents([event, ...(previousSession?.events ?? [])]).slice(0, 5);
  const id = `immediate:${activity.agentKind}:${activity.sessionId}:${activity.projectPath ?? "workspace"}`;
  return {
    kind: activity.agentKind,
    display_name: activity.agentName,
    hostname: "local",
    event_name: activity.eventName,
    tool_name: activity.toolName,
    project_path: activity.projectPath,
    activity_at: activity.occurredAt,
    short_summary: prompt || previousSession?.title || "Agent working",
    sessions: [{
      id,
      session_id: activity.sessionId,
      title: prompt || previousSession?.title || "Agent working",
      summary: "Agent is working",
      project_path: activity.projectPath ?? previousSession?.project_path,
      started_at: previousSession?.started_at ?? activity.occurredAt,
      last_activity_at: activity.occurredAt,
      event_count: Math.max(1, Number(previousSession?.event_count ?? 0) + 1),
      events,
    }],
  };
}

export function activeAgentSessions(
  agents: ActivityIslandSourceAgent[],
  now = Date.now(),
  activeWithinMs = 2 * 60_000,
  completedWithinMs = 10 * 60_000,
): ActiveAgentSession[] {
  const sessions = agents.flatMap((agent) => {
    const sessions = agent.sessions?.length ? agent.sessions : [syntheticSession(agent)];
    return sessions.flatMap((session, index) => {
      const lastActivityAt = session.last_activity_at ?? agent.activity_at;
      if (!lastActivityAt) return [];
      const sourceEvents = session.events ?? [];
      if (sourceEvents.length === 0 && isBackgroundControlPrompt(agent.kind, session.title)) return [];
      const visibleEvents = sourceEvents.filter((event) =>
        !isBackgroundControlPrompt(agent.kind, event.prompt || session.title) &&
        !isClaudeStatusPrompt(agent, {
          ...event,
          prompt: event.prompt || session.title,
        })
      );
      if (sourceEvents.length > 0 && visibleEvents.length === 0) return [];
      const latestEvent = visibleEvents[0];
      const latestPrompt = visibleEvents.find((event) => userFacingText(event.prompt));
      const eventName = latestEvent?.event_name ?? (index === 0 ? agent.event_name : undefined);
      if (!latestEvent && isClaudeStatusPrompt(agent, { event_name: eventName, prompt: session.title ?? agent.short_summary })) return [];
      const completed = Boolean(eventName && TERMINAL_EVENTS.has(eventName.toLowerCase()));
      if (!isRecent(lastActivityAt, now, completed ? completedWithinMs : activeWithinMs)) return [];
      const projectPath = session.project_path ?? agent.project_path;
      return [{
        id: session.id,
        sessionId: session.session_id ?? session.id,
        sourceSessionIds: [session.session_id ?? session.id],
        agentKind: agent.kind,
        agentName: agent.display_name,
        projectPath,
        project: projectName(projectPath),
        title: userFacingText(latestPrompt?.prompt) || userFacingText(session.title) || userFacingText(agent.short_summary) || "Agent working",
        summary: friendlySummary(session.summary) || userFacingText(agent.short_summary) || "Agent is working",
        latestAction: completed ? "Finished latest turn" : latestAction(latestEvent, agent),
        lastActivityAt,
        durationSeconds: Math.max(0, Number(session.duration_seconds ?? 0)),
        eventCount: Math.max(1, Number(session.event_count ?? session.events?.length ?? 1)),
        events: visibleEvents.map(sanitizeEvent).slice(0, 5),
        visualState: completed ? "completed" as const : activeVisualState(latestEvent, agent),
      }];
    });
  }).sort((left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt));
  return dedupeSessions(sessions);
}

export function prioritizeAgentSessions(
  sessions: ActiveAgentSession[],
  attention?: AgentAttentionTarget,
) {
  return sessions
    .map((session) => attentionMatchesSession(attention, session)
      ? { ...session, visualState: "waiting" as const }
      : session)
    .sort((left, right) => {
      const stateDifference = visualStatePriority(right.visualState) - visualStatePriority(left.visualState);
      if (stateDifference) return stateDifference;
      return Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
    });
}

export function activityIslandKey(sessions: ActiveAgentSession[]) {
  return `activity:${sessions.map((session) => session.id).sort().join("|")}`;
}

export function applyCompletedAgentSessions(
  sessions: ActiveAgentSession[],
  completedBySessionId: ReadonlyMap<string, CompletedAgentSession>,
) {
  return sessions.map((session) => {
    const completion = session.sourceSessionIds
      .map((sessionId) => completedBySessionId.get(sessionId))
      .filter((item): item is CompletedAgentSession => Boolean(item))
      .sort((left, right) => right.completedAt - left.completedAt)[0];
    if (!completion || Date.parse(session.lastActivityAt) > completion.completedAt) return session;
    const response = userFacingText(completion.response);
    return {
      ...session,
      visualState: "completed" as const,
      latestAction: response || "Finished latest turn",
      summary: response || session.summary,
    };
  });
}

export function recoverSuspendedAgentSessions(
  suspended: ActiveAgentSession[],
  current: ActiveAgentSession[],
  resumedAt = Date.now(),
) {
  const recoveredAt = new Date(resumedAt).toISOString();
  return suspended
    .filter((session) => session.visualState !== "completed")
    .filter((session) => !current.some((candidate) => sameAgentSession(candidate, session)))
    .map((session) => ({
      ...session,
      lastActivityAt: recoveredAt,
    }));
}

export function mergeRecoveredAgentSessions(
  current: ActiveAgentSession[],
  recovered: ActiveAgentSession[],
) {
  return [
    ...current,
    ...recovered.filter((session) =>
      !current.some((candidate) => sameAgentSession(candidate, session))
    ),
  ];
}

export function contributionsForSession(
  contributions: PluginIslandContribution[],
  sessionIds: string | string[],
) {
  const ids = new Set(Array.isArray(sessionIds) ? sessionIds : [sessionIds]);
  return contributions.filter((contribution) =>
    (contribution.sessionId ? ids.has(contribution.sessionId) : false) ||
    contribution.relatedSessionIds?.some((sessionId) => ids.has(sessionId))
  );
}

export function ambientIslandContributions(
  contributions: PluginIslandContribution[],
  activeSessionIds: string[] = [],
) {
  const active = new Set(activeSessionIds);
  return contributions.filter((contribution) => {
    if (!contribution.sessionId && !(contribution.relatedSessionIds?.length)) return true;
    if (contribution.sessionId && active.has(contribution.sessionId)) return false;
    if (contribution.relatedSessionIds?.some((sessionId) => active.has(sessionId))) return false;
    return true;
  });
}

type TokenSaverContributionLike = {
  pluginId: string;
  key: string;
  value?: unknown;
  updatedAt: string;
};

export function latestTokenSaverSavings<T extends TokenSaverContributionLike>(
  contributions: T[],
) {
  return contributions
    .filter((contribution) =>
      contribution.pluginId === "openleash.prompt-compression" &&
      contribution.key === "token-savings" &&
      typeof contribution.value === "string" &&
      /^\d+(?:\.\d+)?% saved$/i.test(contribution.value.trim())
    )
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

function dedupeSessions(sessions: ActiveAgentSession[]) {
  const deduped: ActiveAgentSession[] = [];
  for (const session of sessions) {
    const duplicate = deduped.find((candidate) =>
      sameAgentSession(candidate, session) ||
      (
        candidate.agentKind === session.agentKind &&
        (candidate.project === session.project || candidate.project === "Workspace" || session.project === "Workspace") &&
        (
          comparableTitle(candidate.title) === comparableTitle(session.title) ||
          (candidate.project === "Workspace") !== (session.project === "Workspace") ||
          candidate.title === "Agent working" ||
          session.title === "Agent working"
        ) &&
        Math.abs(Date.parse(candidate.lastActivityAt) - Date.parse(session.lastActivityAt)) <= 2 * 60_000
      )
    );
    if (!duplicate) {
      deduped.push(session);
      continue;
    }
    duplicate.sourceSessionIds = [...new Set([...duplicate.sourceSessionIds, ...session.sourceSessionIds])];
    if (duplicate.project === "Workspace" && session.project !== "Workspace") duplicate.project = session.project;
    duplicate.events = uniqueEvents([...duplicate.events, ...session.events]).slice(0, 5);
    duplicate.eventCount = Math.max(duplicate.eventCount, session.eventCount, duplicate.events.length);
    duplicate.durationSeconds = Math.max(duplicate.durationSeconds, session.durationSeconds);
  }
  return deduped;
}

function comparableTitle(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sameAgentSession(left: ActiveAgentSession, right: ActiveAgentSession) {
  if (left.agentKind !== right.agentKind) return false;
  if (left.id === right.id || left.sessionId === right.sessionId) return true;
  const leftIds = new Set([left.sessionId, ...left.sourceSessionIds]);
  return [right.sessionId, ...right.sourceSessionIds].some((id) => leftIds.has(id));
}

function uniqueEvents(events: ActivityIslandEvent[]) {
  const seen = new Set<string>();
  return events
    .sort((left, right) => Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? ""))
    .filter((event) => {
      const key = [event.event_name, event.tool_name, cleanText(event.prompt), event.created_at].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function syntheticSession(agent: ActivityIslandSourceAgent): ActivityIslandSourceSession {
  return {
    id: `${agent.kind}:${agent.hostname ?? "local"}:${agent.project_path ?? "session"}`,
    title: agent.short_summary,
    summary: agent.short_summary,
    project_path: agent.project_path,
    last_activity_at: agent.activity_at,
    event_count: 1,
  };
}

function activeVisualState(event: ActivityIslandEvent | undefined, agent: ActivityIslandSourceAgent): ActiveAgentSession["visualState"] {
  const eventName = cleanText(event?.event_name ?? agent.event_name).toLowerCase();
  return cleanText(event?.tool_name ?? agent.tool_name) || /(?:pre|post)?tooluse|tool_call|command/.test(eventName)
    ? "running"
    : "processing";
}

function attentionMatchesSession(attention: AgentAttentionTarget | undefined, session: ActiveAgentSession) {
  if (!attention?.agentKind || attention.agentKind !== session.agentKind) return false;
  if (attention.sessionId && session.sourceSessionIds.includes(attention.sessionId)) return true;
  const attentionPath = normalizedPath(attention.projectPath);
  const sessionPath = normalizedPath(session.projectPath);
  return !attentionPath || !sessionPath || attentionPath === sessionPath;
}

function visualStatePriority(state: ActiveAgentSession["visualState"]) {
  if (state === "waiting") return 3;
  if (state === "running") return 2;
  if (state === "processing") return 1;
  return 0;
}

function normalizedPath(value?: string) {
  return String(value ?? "").replace(/[\\/]+$/, "").toLowerCase();
}

function isRecent(value: string, now: number, activeWithinMs: number) {
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now + 5_000 && now - at <= activeWithinMs;
}

function projectName(value?: string) {
  const normalized = String(value ?? "").replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).filter(Boolean).pop() || "Workspace";
}

function latestAction(event: ActivityIslandEvent | undefined, agent: ActivityIslandSourceAgent) {
  const tool = cleanText(event?.tool_name ?? agent.tool_name);
  if (tool) return friendlyToolAction(tool);
  const eventName = cleanText(event?.event_name ?? agent.event_name);
  if (eventName === "UserPromptSubmit") return "Reading your request";
  if (eventName === "SubagentStart") return "Started a subagent";
  if (eventName === "SubagentStop") return "Subagent finished";
  return eventName ? humanize(eventName) : "Working";
}

function friendlyToolAction(tool: string) {
  const normalized = tool.toLowerCase().replace(/[_-]+/g, " ");
  if (/^(read|cat|view|open)$/.test(normalized)) return "Reviewing project files";
  if (/^(write|edit|multiedit|apply patch)$/.test(normalized)) return "Updating a file";
  if (/^(bash|shell|terminal|command)$/.test(normalized)) return "Running a command";
  if (/^(grep|glob|search|find)$/.test(normalized)) return "Searching the project";
  if (/^(task|agent|subagent)$/.test(normalized)) return "Delegating work";
  return "Working with a project tool";
}

function friendlySummary(value: unknown) {
  return userFacingText(value)
    .replace(/\b(\d+) events?\b/gi, "$1 actions")
    .replace(/\b(\d+) approvals?\b/gi, "$1 approval requests")
    .replace(/\b(\d+) denied\b/gi, "$1 blocked");
}

function sanitizeEvent(event: ActivityIslandEvent): ActivityIslandEvent {
  const prompt = userFacingText(event.prompt);
  return { ...event, prompt: prompt || undefined };
}

function userFacingText(value: unknown) {
  if (typeof value !== "string") return "";
  const session = value.match(/<session(?:\s[^>]*)?>([\s\S]*?)<\/session>/i)?.[1];
  const candidate = (session ?? value).trim();
  if (isInternalControlText(candidate)) return "";
  return cleanText(candidate);
}

function isInternalControlText(value: string) {
  return /^(?:\[(?:suggestion|system|developer|assistant|tool)\s*(?:mode|message)?\s*:|<(?:system|system-reminder|developer|assistant|tool|command-name|command-message|local-command-(?:caveat|stdout|stderr)|ide_[a-z0-9_-]+)\b)/i.test(value) ||
    /^the user (?:has )?stepped away\b[\s\S]*\b(?:recap|summari[sz]e)\b/i.test(value) ||
    /^the user (?:is|will be) (?:coming back|returning)\b[\s\S]*\b(?:recap|summari[sz]e)\b/i.test(value) ||
    /^this session is being continued from a previous conversation\b/i.test(value) ||
    /^suggest what the user might naturally type next\b/i.test(value) ||
    /^you have \d+ weighted tokens left\b/i.test(value);
}

export function isBackgroundControlPrompt(agentKind: unknown, value: unknown) {
  if (typeof value !== "string") return false;
  const normalized = decodeTextEntities(value).replace(/\s+/g, " ").toLowerCase();
  if (agentKind === "codex") {
    const taskTitle =
      normalized.includes("you will be presented with a user prompt") &&
      normalized.includes("provide a short title for a task that will be created from that prompt") &&
      normalized.includes("generate a concise ui title") &&
      normalized.includes("fill the structured title field with plain text");
    const projectSuggestions =
      normalized.includes("generate 0 to 3 hyperpersonalized suggestions for what this user can do with codex") &&
      normalized.includes("in this local project") &&
      normalized.includes("get an understanding of the user's intent and goals");
    const ambientSuggestionReview =
      normalized.includes("you are an expert at upholding safety and compliance standards for codex ambient suggestions") &&
      normalized.includes("# ambient suggestion candidates") &&
      normalized.includes("suggestions to exclude") &&
      normalized.includes("you must not output any other text");
    return taskTitle || projectSuggestions || ambientSuggestionReview;
  }
  return agentKind === "claude-code" &&
    normalized.includes("<session>") &&
    normalized.includes("</session>") &&
    normalized.includes("write the title in the predominant language of the session") &&
    normalized.includes("ignore the language of the examples above");
}

export function isBackgroundControlPending(item: {
  agent_kind?: unknown;
  question?: unknown;
  summary?: unknown;
  quote?: unknown;
  payload?: unknown;
}) {
  const candidates = [item.question, item.summary, item.quote];
  if (item.payload !== undefined) {
    try { candidates.push(JSON.stringify(item.payload)); } catch { /* non-serializable payload */ }
  }
  return candidates.some((value) => isBackgroundControlPrompt(item.agent_kind, value));
}

function isClaudeStatusPrompt(agent: ActivityIslandSourceAgent, event: ActivityIslandEvent) {
  if (agent.kind !== "claude-code" || cleanText(event.event_name) !== "UserPromptSubmit") return false;
  return /^\/?quota$/i.test(cleanText(event.prompt));
}

function humanize(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function cleanText(value: unknown) {
  if (typeof value !== "string") return "";
  const session = value.match(/<session(?:\s[^>]*)?>([\s\S]*?)<\/session>/i)?.[1];
  const cleaned = decodeTextEntities((session ?? value)
    .replace(/<\/?[a-z][^>]*>/gi, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
  return collapseRepeatedText(cleaned).slice(0, 180);
}

function decodeTextEntities(value: string) {
  return value
    .replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (match, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : match;
    })
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (match, name: string) => ({
      nbsp: " ",
      amp: "&",
      lt: "<",
      gt: ">",
      quot: "\"",
      apos: "'",
    })[name.toLowerCase()] ?? match);
}

function collapseRepeatedText(value: string) {
  if (value.length < 16 || value.length % 2 !== 0) return value;
  const midpoint = value.length / 2;
  const first = value.slice(0, midpoint);
  return first === value.slice(midpoint) ? first.trim() : value;
}
import type { PluginIslandContribution } from "@openleash/shared";
