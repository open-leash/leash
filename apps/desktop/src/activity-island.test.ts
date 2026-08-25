import assert from "node:assert/strict";
import test from "node:test";
import type { PluginIslandContribution } from "@openleash/shared";
import {
  activeAgentSessions,
  activityIslandPresentationSummary,
  activityIslandKey,
  ambientIslandContributions,
  applyCompletedAgentSessions,
  mergeRecoveredAgentSessions,
  recoverSuspendedAgentSessions,
  contributionsForSession,
  islandDisplayTargets,
  latestTokenSaverSavings,
  mergeImmediateAgentActivity,
  prioritizeAgentSessions,
  shouldPresentActivityIsland,
} from "./activity-island";
import { canonicalPluginSlug, responsiblePluginSlug } from "./plugin-slug";

test("plugin presentation always uses canonical slugs", () => {
  assert.equal(canonicalPluginSlug("Blast Radius"), "blast-radius");
  assert.equal(canonicalPluginSlug("openleash.blast-radius"), "blast-radius");
  assert.equal(canonicalPluginSlug("openleash.prompt-compression"), "token-saver");
  assert.equal(canonicalPluginSlug("token-compression"), "token-saver");
  assert.equal(canonicalPluginSlug("openleash.core"), "openleash-core");
});

test("approval attribution prefers a closed DLP failure over a fail-open token-saver error", () => {
  assert.equal(responsiblePluginSlug("openleash.prompt-compression", {
    openleashPluginRuns: [
      { pluginId: "openleash.prompt-compression", status: "failed" },
      { pluginId: "openleash.dlp", status: "failed" },
    ],
  }), "data-leakage-prevention");
});

test("only shows Token Saver after it publishes a real savings metric", () => {
  const base = {
    pluginId: "openleash.prompt-compression",
    key: "token-savings",
    updatedAt: "2026-08-03T10:00:00.000Z",
  };

  assert.equal(latestTokenSaverSavings([]), undefined);
  assert.equal(latestTokenSaverSavings([
    { ...base, value: "Unavailable" },
  ]), undefined);
  assert.deepEqual(latestTokenSaverSavings([
    { ...base, value: "9% saved" },
    { ...base, value: "14% saved", updatedAt: "2026-08-03T10:01:00.000Z" },
  ]), {
    ...base,
    value: "14% saved",
    updatedAt: "2026-08-03T10:01:00.000Z",
  });
});

test("supports always-on, activity-only, notification-only, and disabled Island visibility", () => {
  assert.equal(shouldPresentActivityIsland({
    visibility: "always",
    hasPending: false,
    hasVisibleActivity: false,
  }), true);
  assert.equal(shouldPresentActivityIsland({
    visibility: "activity",
    hasPending: false,
    hasVisibleActivity: true,
  }), true);
  assert.equal(shouldPresentActivityIsland({
    visibility: "activity",
    hasPending: false,
    hasVisibleActivity: false,
  }), false);
  assert.equal(shouldPresentActivityIsland({
    visibility: "notifications",
    hasPending: false,
    hasVisibleActivity: true,
  }), false);
  assert.equal(shouldPresentActivityIsland({
    visibility: "notifications",
    hasPending: true,
    hasVisibleActivity: false,
  }), true);
  assert.equal(shouldPresentActivityIsland({
    visibility: "notifications",
    hasPending: false,
    hasVisibleActivity: false,
    manualReveal: true,
  }), true);
  assert.equal(shouldPresentActivityIsland({
    visibility: "off",
    hasPending: true,
    hasVisibleActivity: true,
    manualReveal: true,
  }), false);
});

test("passive token savings do not masquerade as a plugin update", () => {
  assert.deepEqual(activityIslandPresentationSummary({
    sessionCount: 0,
    activeSessionCount: 0,
    pluginUpdateCount: 0,
  }), {
    title: "Leash",
    project: "Watching your agents",
  });
  assert.deepEqual(activityIslandPresentationSummary({
    sessionCount: 0,
    activeSessionCount: 0,
    pluginUpdateCount: 1,
  }), {
    title: "1 plugin update",
    project: "Plugin activity",
  });
});

test("shows compact Islands on every display but activates only the pointer display", () => {
  assert.deepEqual(islandDisplayTargets([10, 20, 30], 20, true), [
    { displayId: 10, presentation: "passive" },
    { displayId: 20, presentation: "active" },
    { displayId: 30, presentation: "passive" },
  ]);
  assert.deepEqual(islandDisplayTargets([10, 20, 30], 20, false), [
    { displayId: 10, presentation: "hidden" },
    { displayId: 20, presentation: "active" },
    { displayId: 30, presentation: "hidden" },
  ]);
});

test("shows an agent immediately from the first local ingestion event", () => {
  const occurredAt = "2026-07-22T19:00:00.000Z";
  const prompt = mergeImmediateAgentActivity(undefined, {
    agentKind: "claude-code",
    agentName: "Claude Code",
    eventName: "UserPromptSubmit",
    sessionId: "instant-session",
    projectPath: "/code/project",
    prompt: "start the conversation now",
    occurredAt,
  });
  const tool = mergeImmediateAgentActivity(prompt, {
    agentKind: "claude-code",
    agentName: "Claude Code",
    eventName: "PreToolUse",
    sessionId: "instant-session",
    projectPath: "/code/project",
    prompt: "internal assistant text",
    toolName: "Read",
    occurredAt: "2026-07-22T19:00:00.100Z",
  });
  const sessions = activeAgentSessions([tool], Date.parse("2026-07-22T19:00:00.200Z"));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agentName, "Claude Code");
  assert.equal(sessions[0].title, "start the conversation now");
  assert.equal(sessions[0].latestAction, "Reviewing project files");
});

const supportedAgents = [
  "claude-code", "codex", "gemini", "cursor", "opencode", "github-copilot",
  "cline", "continue", "windsurf", "openclaw", "nanoclaw",
];

test("builds active island sessions consistently across supported coding agents", () => {
  const now = Date.parse("2026-07-20T10:00:00.000Z");
  const sessions = activeAgentSessions(supportedAgents.map((kind, index) => ({
    kind,
    display_name: kind,
    hostname: "mac",
    event_name: index % 2 ? "PreToolUse" : "UserPromptSubmit",
    tool_name: index % 2 ? "Edit" : undefined,
    project_path: `/code/project-${index}`,
    activity_at: new Date(now - index * 1_000).toISOString(),
    short_summary: `Task ${index}`,
  })), now);

  assert.equal(sessions.length, supportedAgents.length);
  assert.deepEqual(new Set(sessions.map((session) => session.agentKind)), new Set(supportedAgents));
  assert.equal(sessions[0]?.latestAction, "Reading your request");
  assert.equal(sessions[1]?.latestAction, "Updating a file");
  assert.equal(sessions[0]?.visualState, "processing");
  assert.equal(sessions[1]?.visualState, "running");
});

test("prioritizes attention, then tool activity, then processing", () => {
  const base = {
    sessionId: "session",
    sourceSessionIds: ["session"],
    agentName: "Agent",
    project: "project",
    projectPath: "/code/project",
    title: "Task",
    summary: "Working",
    latestAction: "Working",
    lastActivityAt: "2026-07-20T10:00:00.000Z",
    durationSeconds: 2,
    eventCount: 1,
    events: [],
  };
  const ranked = prioritizeAgentSessions([
    { ...base, id: "processing", agentKind: "gemini", visualState: "processing" },
    { ...base, id: "running", agentKind: "codex", visualState: "running" },
    { ...base, id: "attention", agentKind: "claude-code", visualState: "processing" },
  ], { agentKind: "claude-code", projectPath: "/code/project" });

  assert.deepEqual(ranked.map((session) => [session.id, session.visualState]), [
    ["attention", "waiting"],
    ["running", "running"],
    ["processing", "processing"],
  ]);
});

test("shows the latest user request and explains tools in plain language", () => {
  const now = Date.parse("2026-07-20T10:00:00.000Z");
  const [session] = activeAgentSessions([{
    kind: "claude-code",
    display_name: "Claude Code",
    activity_at: new Date(now - 1_000).toISOString(),
    sessions: [{
      id: "claude",
      title: "quota",
      summary: "11 events · 2 approvals · 1 denied",
      last_activity_at: new Date(now - 1_000).toISOString(),
      events: [
        { event_name: "PreToolUse", tool_name: "Read", created_at: new Date(now - 1_000).toISOString() },
        { event_name: "UserPromptSubmit", prompt: "ok write a nice 2 page story about moses and god", created_at: new Date(now - 2_000).toISOString() },
      ],
    }],
  }], now);

  assert.equal(session?.title, "ok write a nice 2 page story about moses and god");
  assert.equal(session?.latestAction, "Reviewing project files");
  assert.equal(session?.summary, "11 actions · 2 approval requests · 1 blocked");
});

test("does not show Claude quota checks as active agent work", () => {
  const now = Date.parse("2026-07-20T10:00:00.000Z");
  const sessions = activeAgentSessions([{
    kind: "claude-code",
    display_name: "Claude Code",
    activity_at: new Date(now - 1_000).toISOString(),
    sessions: [{
      id: "claude-idle-quota",
      title: "quota",
      last_activity_at: new Date(now - 1_000).toISOString(),
      events: [{
        event_name: "UserPromptSubmit",
        created_at: new Date(now - 1_000).toISOString(),
      }],
    }],
  }], now);

  assert.deepEqual(sessions, []);
});

test("does not show Codex task-title generation as active agent work", () => {
  const now = Date.parse("2026-07-29T06:48:40.000Z");
  const titlePrompt = "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.\nGenerate a concise UI title (up to 36 characters) for this task.\nFill the structured title field with plain text.\n\nUser prompt:\nSummarize run.py";
  const sessions = activeAgentSessions([{
    kind: "codex",
    display_name: "OpenAI Codex",
    activity_at: new Date(now - 1_000).toISOString(),
    sessions: [{
      id: "codex-title-generation",
      title: titlePrompt,
      last_activity_at: new Date(now - 1_000).toISOString(),
      events: [{
        event_name: "UserPromptSubmit",
        prompt: titlePrompt,
        created_at: new Date(now - 1_000).toISOString(),
      }],
    }],
  }], now);

  assert.deepEqual(sessions, []);
});

test("does not show a Codex title-generation session without event details", () => {
  const now = Date.parse("2026-07-29T06:48:40.000Z");
  const titlePrompt = "You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt. Generate a concise UI title. Fill the structured title field with plain text.";
  const sessions = activeAgentSessions([{
    kind: "codex",
    display_name: "OpenAI Codex",
    activity_at: new Date(now - 1_000).toISOString(),
    sessions: [{
      id: "codex-title-generation-without-events",
      title: titlePrompt,
      last_activity_at: new Date(now - 1_000).toISOString(),
    }],
  }], now);

  assert.deepEqual(sessions, []);
});

test("does not show a Codex title-generation session with a blank event prompt", () => {
  const now = Date.parse("2026-08-04T06:24:26.000Z");
  const titlePrompt = "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt. Generate a concise UI title. Fill the structured title field with plain text.";
  const sessions = activeAgentSessions([{
    kind: "codex",
    display_name: "OpenAI Codex",
    activity_at: new Date(now - 1_000).toISOString(),
    sessions: [{
      id: "codex-title-generation-blank-event",
      title: titlePrompt,
      last_activity_at: new Date(now - 1_000).toISOString(),
      events: [{
        event_name: "UserPromptSubmit",
        prompt: "",
        created_at: new Date(now - 1_000).toISOString(),
      }],
    }],
  }], now);

  assert.deepEqual(sessions, []);
});

test("hides Claude control prompts and keeps the latest real user request", () => {
  const now = Date.parse("2026-07-20T10:00:00.000Z");
  const [session] = activeAgentSessions([{
    kind: "claude-code",
    display_name: "Claude Code",
    activity_at: new Date(now - 1_000).toISOString(),
    sessions: [{
      id: "claude-control-prompt",
      title: "[SYSTEM: internal fallback title]",
      last_activity_at: new Date(now - 1_000).toISOString(),
      events: [
        { event_name: "UserPromptSubmit", prompt: "The user stepped away and is coming back. Recap in under 40 words before continuing.", created_at: new Date(now - 500).toISOString() },
        { event_name: "UserPromptSubmit", prompt: "[SUGGESTION MODE: Suggest what the user might naturally type next]", created_at: new Date(now - 1_000).toISOString() },
        { event_name: "UserPromptSubmit", prompt: "write the release notes", created_at: new Date(now - 2_000).toISOString() },
      ],
    }],
  }], now);

  assert.equal(session?.title, "write the release notes");
  assert.equal(session?.events[0]?.prompt, undefined);
  assert.equal(session?.events[1]?.prompt, undefined);
  assert.equal(session?.events[2]?.prompt, "write the release notes");
});

test("uses a neutral title when a Claude session contains only control metadata", () => {
  const now = Date.parse("2026-07-20T10:00:00.000Z");
  const [session] = activeAgentSessions([{
    kind: "claude-code",
    display_name: "Claude Code",
    activity_at: new Date(now - 1_000).toISOString(),
    short_summary: "<system-reminder>Private provider instructions</system-reminder>",
    sessions: [{
      id: "claude-control-only",
      title: "<command-name>/internal</command-name>",
      last_activity_at: new Date(now - 1_000).toISOString(),
      events: [{ event_name: "UserPromptSubmit", prompt: "<system-reminder>Do not show this</system-reminder>" }],
    }],
  }], now);

  assert.equal(session?.title, "Agent working");
  assert.equal(session?.summary, "Agent is working");
});

test("removes transport session tags and merges duplicate hook and proxy views", () => {
  const now = Date.parse("2026-07-20T10:00:00.000Z");
  const sessions = activeAgentSessions([{
    kind: "claude-code",
    display_name: "Claude Code",
    sessions: [
      {
        id: "hook-session",
        session_id: "hook-session",
        project_path: "/code/MyProj",
        last_activity_at: new Date(now - 10_000).toISOString(),
        events: [{ event_name: "PreToolUse", tool_name: "Write", prompt: "write a short story to story.txt" }],
      },
      {
        id: "proxy-session",
        session_id: "proxy-session",
        project_path: undefined,
        last_activity_at: new Date(now - 20_000).toISOString(),
        events: [{ event_name: "UserPromptSubmit", prompt: "<session>write a short story to story.txt</session> Workspace metadata" }],
      },
    ],
  }], now);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.title, "write a short story to story.txt");
  assert.deepEqual(sessions[0]?.sourceSessionIds.sort(), ["hook-session", "proxy-session"]);
});

test("merges one project hook view with its generic proxy activity", () => {
  const now = Date.parse("2026-07-20T10:00:00.000Z");
  const sessions = activeAgentSessions([{
    kind: "claude-code",
    display_name: "Claude Code",
    sessions: [
      {
        id: "hook-session",
        project_path: "/code/MyProj",
        title: "delete my tables in sqlite file here",
        last_activity_at: new Date(now - 5_000).toISOString(),
      },
      {
        id: "proxy-session",
        title: "Agent working",
        last_activity_at: new Date(now - 8_000).toISOString(),
      },
    ],
  }], now);

  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0]?.sourceSessionIds.sort(), ["hook-session", "proxy-session"]);
});

test("keeps recent completed sessions without treating stale sessions as live", () => {
  const now = Date.parse("2026-07-20T10:00:00.000Z");
  const agents = [{
    kind: "claude-code",
    display_name: "Claude Code",
    hostname: "mac",
    sessions: [
      { id: "active", title: "Ship feature", last_activity_at: new Date(now - 10_000).toISOString(), events: [{ event_name: "PreToolUse", tool_name: "Bash" }] },
      { id: "done", title: "Done", last_activity_at: new Date(now - 2_000).toISOString(), events: [{ event_name: "Stop" }] },
      { id: "stale", title: "Old", last_activity_at: new Date(now - 180_000).toISOString(), events: [{ event_name: "PreToolUse" }] },
    ],
  }];
  const first = activeAgentSessions(agents, now);
  const updated = activeAgentSessions([{
    ...agents[0],
    sessions: agents[0].sessions.map((session) =>
      session.id === "active" ? { ...session, event_count: 4 } : session
    ),
  }], now);

  assert.deepEqual(first.map((session) => [session.id, session.visualState]), [
    ["done", "completed"],
    ["active", "running"],
  ]);
  assert.equal(activityIslandKey(first), activityIslandKey(updated));
});

test("keeps a finished turn visible as completed with the assistant response", () => {
  const completedAt = Date.parse("2026-07-20T10:00:00.000Z");
  const session = {
    id: "claude-session",
    sessionId: "claude-session",
    sourceSessionIds: ["claude-session"],
    agentKind: "claude-code",
    agentName: "Claude Code",
    projectPath: "/code/MyProj",
    project: "MyProj",
    title: "copy the environment file",
    summary: "Agent is working",
    latestAction: "Working",
    lastActivityAt: new Date(completedAt - 1_000).toISOString(),
    durationSeconds: 1,
    eventCount: 2,
    events: [],
    visualState: "processing" as const,
  };
  const completions = new Map([["claude-session", {
    completedAt,
    response: "The authentication middleware is ready and all tests pass.",
  }]]);

  assert.deepEqual(applyCompletedAgentSessions([session], completions), [{
    ...session,
    visualState: "completed",
    latestAction: "The authentication middleware is ready and all tests pass.",
    summary: "The authentication middleware is ready and all tests pass.",
  }]);
  assert.deepEqual(
    applyCompletedAgentSessions([{ ...session, lastActivityAt: new Date(completedAt + 1_000).toISOString() }], completions),
    [{ ...session, lastActivityAt: new Date(completedAt + 1_000).toISOString() }],
  );
});

test("recovers the same live conversation after the computer wakes", () => {
  const suspendedAt = Date.parse("2026-07-20T10:00:00.000Z");
  const resumedAt = Date.parse("2026-07-20T10:30:00.000Z");
  const session = {
    id: "runtime:codex-session:/code/OpenLeash",
    sessionId: "codex-session",
    sourceSessionIds: ["codex-session", "proxy-codex-session"],
    agentKind: "codex",
    agentName: "OpenAI Codex",
    projectPath: "/code/OpenLeash",
    project: "Leash",
    title: "Fix island positioning",
    summary: "Agent is working",
    latestAction: "Reviewing project files",
    lastActivityAt: new Date(suspendedAt).toISOString(),
    durationSeconds: 25,
    eventCount: 8,
    events: [],
    visualState: "processing" as const,
  };

  const recovered = recoverSuspendedAgentSessions([session], [], resumedAt);

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.id, session.id);
  assert.equal(recovered[0]?.sessionId, session.sessionId);
  assert.equal(recovered[0]?.lastActivityAt, new Date(resumedAt).toISOString());
  assert.equal(recovered[0]?.visualState, "processing");
});

test("wake recovery neither duplicates a live session nor revives a completed one", () => {
  const base = {
    id: "runtime:codex-session:/code/OpenLeash",
    sessionId: "codex-session",
    sourceSessionIds: ["codex-session"],
    agentKind: "codex",
    agentName: "OpenAI Codex",
    project: "Leash",
    title: "Fix island positioning",
    summary: "Agent is working",
    latestAction: "Updating files",
    lastActivityAt: "2026-07-20T10:00:00.000Z",
    durationSeconds: 25,
    eventCount: 8,
    events: [],
    visualState: "running" as const,
  };
  const current = [{ ...base, id: "remote-view", sourceSessionIds: ["codex-session", "proxy-view"] }];
  const completed = { ...base, id: "done", sessionId: "done", sourceSessionIds: ["done"], visualState: "completed" as const };

  assert.deepEqual(recoverSuspendedAgentSessions([base, completed], current), []);
  assert.deepEqual(mergeRecoveredAgentSessions(current, [base]), current);
});

test("preserves the prompt and marks the live Claude Stop payload completed", () => {
  const now = Date.parse("2026-07-22T17:38:01.000Z");
  const sessions = activeAgentSessions([{
    kind: "claude-code",
    display_name: "Claude Code",
    project_path: "/Users/max/Code/MyProj",
    sessions: [{
      id: "runtime:claude-session:/Users/max/Code/MyProj",
      session_id: "claude-session",
      title: "hey man",
      last_activity_at: "2026-07-22T17:37:58.680Z",
      events: [
        { event_name: "Stop", created_at: "2026-07-22T17:37:58.680Z" },
        { event_name: "UserPromptSubmit", prompt: "hey man", created_at: "2026-07-22T17:37:51.946Z" },
      ],
    }],
  }], now);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.agentName, "Claude Code");
  assert.equal(sessions[0]?.title, "hey man");
  assert.equal(sessions[0]?.visualState, "completed");
  assert.equal(sessions[0]?.latestAction, "Finished latest turn");
});

test("attaches plugin annotations and related global status to the intended session", () => {
  const base = {
    schemaVersion: "2026-07-20.plugin-island.v1" as const,
    pluginId: "community.test-progress",
    updatedAt: "2026-07-20T10:00:00.000Z",
    expiresAt: "2026-07-20T10:02:00.000Z",
    tone: "info" as const,
  };
  const contributions: PluginIslandContribution[] = [
    { ...base, id: "one", key: "risk", kind: "annotation", sessionId: "session-1", label: "Risk", value: "high" },
    { ...base, id: "two", key: "tests", kind: "status", title: "Tests running", relatedSessionIds: ["session-1"] },
    { ...base, id: "three", key: "release", kind: "status", title: "Release ready", relatedSessionIds: [] },
  ];

  assert.deepEqual(contributionsForSession(contributions, "session-1").map((item) => item.id), ["one", "two"]);
  assert.deepEqual(ambientIslandContributions(contributions, ["session-1"]).map((item) => item.id), ["three"]);
  assert.deepEqual(ambientIslandContributions(contributions, ["other-session"]).map((item) => item.id), ["one", "two", "three"]);
});
