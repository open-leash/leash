import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import {
  OPENLEASH_API_CONTRACTS,
  OPENLEASH_API_FUNCTION_HEADER,
  OPENLEASH_API_VERSION_HEADER,
  type OpenLeashApiFunction
} from "./api-contract";
import {
  OPENLEASH_DESKTOP_AUTH_CALLBACK_URI,
  OPENLEASH_DESKTOP_GITHUB_REDIRECT_URI,
  OPENLEASH_DESKTOP_GOOGLE_REDIRECT_URI,
  OPENLEASH_DESKTOP_MICROSOFT_REDIRECT_URI
} from "./public-config";
import { bundledPluginCatalog, type PluginCatalogItem } from "./plugin-catalog";
import {
  handledIntentKeysMatch,
  isReusableHandledIntent,
} from "./intent-dedupe";
import {
  SessionMonitoringPauses,
  type SessionMonitoringPause,
} from "./session-monitoring";
import {
  normalizeExcludedProjectPaths,
  projectPathIsExcluded,
} from "./project-exclusions";
import {
  AvailabilityCircuitBreaker,
  isAvailabilityHttpStatus,
} from "./availability-circuit";
import { isBackgroundControlPrompt } from "./activity-island";

const ACTION_PURPOSE_CONTEXT_MESSAGES = Number(process.env.OPENLEASH_ACTION_PURPOSE_MESSAGES ?? 5);
type ClientMode = "personal" | "cloud" | "custom";

const defaultPromptTransformConfig: PromptTransformConfig = {
  compression: {
    enabled: true,
    level: "standard",
    conciseResponse: false,
    model: process.env.OPENLEASH_PROMPT_TRANSFORM_MODEL ?? "gpt-4.1-nano"
  },
  dlp: {
    enabled: true,
    action: "ask",
    categories: ["pii", "phi", "tokens", "keys", "credentials"],
    model: process.env.OPENLEASH_PROMPT_TRANSFORM_MODEL ?? "gpt-4.1-nano"
  }
};

function initialClientMode(): ClientMode {
  const raw = (process.env.OPENLEASH_CLIENT_MODE || process.env.OPENLEASH_MODE || "").toLowerCase();
  if (raw === "cloud" || raw === "public-cloud") return "cloud";
  if (raw === "custom" || raw === "enterprise" || raw === "self-hosted" || raw === "private-cloud") return "custom";
  return "cloud";
}

function configuredDesktopTokenFromEnvironment() {
  return String(process.env.OPENLEASH_DEV_TOKEN ?? "").trim() || undefined;
}

function configuredDesktopToken(existing?: string) {
  return configuredDesktopTokenFromEnvironment()
    ?? existing
    ?? `ol_personal_${crypto.randomBytes(18).toString("base64url")}`;
}

function localUserDisplayName() {
  const configured = String(process.env.OPENLEASH_LOCAL_USER_NAME ?? "").trim();
  if (configured) return configured;
  const username = String(os.userInfo().username || "").trim();
  if (!username) return "Local user";
  return username
    .split(/[._-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeClientMode(value?: ClientMode | string): ClientMode {
  return value === "custom" ? "custom" : "cloud";
}

export type Policy = {
  id: string;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  locked?: boolean;
  match?: string[];
  pattern?: string;
};

type CompressionLevel = "light" | "standard" | "maximum";
type DlpCategory = "pii" | "phi" | "tokens" | "keys" | "credentials";
type DlpAction = "allow" | "ask" | "block" | "mask";

type PromptTransformConfig = {
  compression: {
    enabled: boolean;
    level: CompressionLevel;
    conciseResponse: boolean;
    model: string;
  };
  dlp: {
    enabled: boolean;
    action: DlpAction;
    categories: DlpCategory[];
    model: string;
  };
};

type PromptTransformResult = {
  finalPrompt: string;
  blocked: boolean;
  requiresApproval?: boolean;
  summary: string;
  model: string;
  compression?: {
    enabled: boolean;
    originalLength: number;
    compressedLength: number;
    ratio: number;
  };
  dlp?: {
    enabled: boolean;
    action: DlpAction;
    matched: boolean;
    categories: DlpCategory[];
    findings: Array<{ category: DlpCategory; quote: string; reason: string }>;
    masked: boolean;
  };
};

type EvaluationRequest = {
  computer: { hostname: string; platform: string; osRelease?: string };
  agent: { kind: string; displayName: string; version?: string; executablePath?: string };
  event: {
    eventName: string;
    agentKind: string;
    sessionId: string;
    projectPath?: string;
    prompt?: string;
    tool?: { name: string; input?: unknown; output?: unknown };
    transcript?: Array<{ role: string; content: string; at?: string }>;
    raw?: unknown;
    occurredAt: string;
  };
};

type PolicyResult = {
  policyId: string;
  policyName: string;
  status: "passed" | "failed" | "needs_question";
  severity: "medium";
  explanation: string;
  evidence: string[];
};

type Evaluation = {
  id: string;
  fingerprint?: string;
  intentKey?: string;
  file_path?: string;
  decision: "allow" | "ask" | "deny";
  resolution?: "allow" | "deny" | null;
  resolution_guidance?: string | null;
  resolution_payload?: Record<string, unknown> | null;
  summary: string;
  question?: string;
  created_at: string;
  resolved_at?: string;
  user_name: string;
  hostname: string;
  agent_name: string;
  agent_kind: string;
  event_name: string;
  tool_name?: string;
  project_path?: string;
  payload: EvaluationRequest["event"];
  triggered_policies: Array<{
    policy_name: string;
    status: "failed" | "needs_question";
    severity: string;
    explanation: string;
    evidence: string[];
  }>;
};

type McpToolCall = {
  id: string;
  server_name: string;
  tool_name: string;
  full_tool_name: string;
  arguments: unknown;
  argument_summary: string;
  project_path?: string;
  session_id: string;
  decision: "allow" | "ask" | "deny";
  resolution?: "allow" | "deny" | null;
  risk_level: string;
  occurred_at: string;
  agent_name: string;
  agent_kind: string;
  hostname: string;
  user_name: string;
  evaluation_id: string;
};

type McpServerRegistryItem = {
  id: string;
  server_name: string;
  first_seen_at: string;
  last_seen_at: string;
  tool_count: number;
  call_count: number;
  user_count: number;
  tools: Array<{ tool_name: string }>;
  users: Array<{ name: string }>;
  calls: McpToolCall[];
};

type SkillRecord = {
  id: string;
  agent_kind: string;
  agent_name: string;
  scope: "user" | "project";
  project_path?: string | null;
  skill_name: string;
  skill_path: string;
  status: "observed" | "approved" | "suspicious" | "deleted";
  risk_score: number;
  reasons: Array<{ reason: string; quote?: string }>;
  content_hash: string;
  content?: string | null;
  content_preview?: string | null;
  purpose_summary?: string | null;
  content_updated_at?: string | null;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
};

type SkillLifecycleEvent = "detected" | "changed" | "seen" | "removed";

type IslandVisibility = "always" | "activity" | "notifications" | "off";

function normalizeIslandVisibility(
  value: unknown,
  legacyActivityOnly = false,
): IslandVisibility {
  return value === "activity" || value === "notifications" || value === "off"
    ? value
    : legacyActivityOnly
      ? "activity"
      : "always";
}

type Store = {
  token: string;
  setupComplete: boolean;
  installIdentity?: string;
  deviceIdentity?: string;
  introSeen?: boolean;
  agentDoneSound?: boolean;
  islandVisibility?: IslandVisibility;
  islandActivityOnly?: boolean;
  excludedProjectPaths: string[];
  clientMode?: ClientMode;
  remoteApiUrl?: string;
  remoteToken?: string;
  remoteOrganization?: string;
  remoteUser?: string;
  apiProvider?: "openai" | "anthropic";
  apiKey?: string;
  promptTransforms: PromptTransformConfig;
  plugins: PluginCatalogItem[];
  policies: Policy[];
  history: Evaluation[];
};

type SetupConfig = {
  clientMode?: ClientMode;
  apiProvider?: "openai" | "anthropic";
  apiKey?: string;
  remoteApiUrl?: string;
  remoteToken?: string;
  remoteOrganization?: string;
  remoteUser?: string;
  islandVisibility?: IslandVisibility;
};

type LocalServerOptions = {
  onAgentStop?: (event: { agent: string; eventName: string; body: unknown }) => void;
  onRemoteHookForward?: (event: { agent: string; eventName: string; body: unknown }) => void;
  onAgentActivity?: (activity: LocalAgentActivity) => void;
  onDesktopAuthCallback?: (callbackUrl: string) => void | Promise<void>;
  apiPort?: number;
  legacyAuthPort?: number;
};

export type LocalAgentActivity = {
  agentKind: string;
  agentName: string;
  eventName: string;
  sessionId: string;
  projectPath?: string;
  prompt?: string;
  toolName?: string;
  occurredAt: string;
};

function desktopExchangeRedirectUri(pathname: string) {
  if (pathname === "/v1/auth/google/callback") return OPENLEASH_DESKTOP_GOOGLE_REDIRECT_URI;
  if (pathname === "/v1/auth/microsoft/callback") return OPENLEASH_DESKTOP_MICROSOFT_REDIRECT_URI;
  if (pathname === "/v1/auth/github/callback") return OPENLEASH_DESKTOP_GITHUB_REDIRECT_URI;
  return undefined;
}

function desktopAuthReturnPage(callbackUrl: string) {
  const encodedUrl = JSON.stringify(callbackUrl);
  const href = escapeHtml(callbackUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Return to Leash</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #f8fafc; }
      main { max-width: 460px; padding: 32px; text-align: center; }
      h1 { margin: 0 0 10px; font-size: 24px; }
      p { margin: 0 0 20px; color: #64748b; line-height: 1.5; }
      a, button { color: #4f46e5; font-weight: 700; }
      button { border: 1px solid #e2e8f0; border-radius: 999px; background: white; padding: 10px 16px; font: inherit; cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <h1 id="title">Returning to Leash</h1>
      <p id="message">Your sign-in is complete. Leash should continue automatically.</p>
      <a href="${href}">Open Leash</a>
      <p style="margin-top:18px"><button id="closeButton" type="button">Close this tab</button></p>
    </main>
    <script>
      const callbackUrl = ${encodedUrl};
      const title = document.getElementById("title");
      const message = document.getElementById("message");
      const closeButton = document.getElementById("closeButton");
      closeButton.onclick = () => window.close();
      window.location.replace(callbackUrl);
      setTimeout(() => {
        title.textContent = "Sign-in complete";
        message.textContent = "You can close this tab and return to Leash.";
        window.close();
      }, 900);
    </script>
  </body>
</html>`;
}

function desktopAuthDirectReturnPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign-in complete</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #f8fafc; }
      main { max-width: 460px; padding: 32px; text-align: center; }
      h1 { margin: 0 0 10px; font-size: 24px; }
      p { margin: 0; color: #64748b; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Sign-in complete</h1>
      <p>You can close this tab. Leash is continuing automatically.</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char] ?? char));
}

export class LocalOpenLeashServer {
  private server?: http.Server;
  private legacyAuthServer?: http.Server;
  private db: Database.Database;
  private store!: Store;
  private pluginRuntimeStatuses: Array<{ pluginId: string; healthy: boolean; error?: string }> = [];
  private readonly sessionMonitoringPauses = new SessionMonitoringPauses();
  private readonly excludedProjectSessions = new Map<string, number>();
  private readonly remoteAvailability = new AvailabilityCircuitBreaker({
    failureThreshold: Number(
      // A hung request is classified only after two independent readiness
      // probes fail. Once that confirmed outage reaches the edge, opening on
      // the first failed action prevents a second agent action from waiting on
      // the same dead Cloud path.
      process.env.OPENLEASH_AVAILABILITY_FAILURE_THRESHOLD ?? 1,
    ),
    openDurationMs: Number(
      process.env.OPENLEASH_AVAILABILITY_OPEN_MS ?? 30_000,
    ),
  });

  constructor(private readonly dir: string, private readonly options: LocalServerOptions = {}) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrateSchema();
    this.migrateLegacyJsonStore();
    this.store = this.readStore();
  }

  get apiUrl() {
    const address = this.server?.address();
    const port = address && typeof address === "object" ? address.port : (this.options.apiPort ?? 9317);
    return `http://127.0.0.1:${port}`;
  }

  get token() {
    return this.store.token;
  }

  get setupComplete() {
    if (!this.store.setupComplete) return false;
    if (this.store.clientMode === "cloud" || this.store.clientMode === "custom") {
      return Boolean(this.store.remoteApiUrl && this.store.remoteToken);
    }
    return true;
  }

  get introSeen() {
    return Boolean(this.store.introSeen);
  }

  get policies() {
    return this.store.policies;
  }

  get history() {
    return this.store.history;
  }

  get mcpServers() {
    return this.readMcpRegistry();
  }

  get skills() {
    return this.readSkills();
  }

  resolveObservedSkill(skillPath: string, resolution: "allow" | "deny") {
    const resolved = path.resolve(skillPath);
    const skill = this.skills.find(
      (item) => path.resolve(item.skill_path) === resolved,
    );
    if (!skill) return false;
    if (resolution === "deny") {
      deleteSkillFile(skill.skill_path);
      this.markSkillDeleted(skill.skill_path);
    } else {
      this.markSkillApproved(skill.skill_path);
    }
    return true;
  }

  get apiProvider() {
    return this.store.apiProvider;
  }

  get apiKeySet() {
    return Boolean(this.store.apiKey);
  }

  get promptTransforms() {
    return this.store.promptTransforms;
  }

  get excludedProjectPaths() {
    return [...this.store.excludedProjectPaths];
  }

  get clientMode() {
    return this.store.clientMode === "custom" ? "custom" : "cloud";
  }

  get remoteApiUrl() {
    return this.store.remoteApiUrl;
  }

  get availabilityFailOpen() {
    return this.store.clientMode === "cloud" && Boolean(
      this.store.remoteApiUrl && this.store.remoteToken,
    );
  }

  get remoteOrganization() {
    return this.store.remoteOrganization;
  }

  get remoteUser() {
    return this.store.remoteUser;
  }

  get effectiveApiUrl() {
    return this.store.remoteApiUrl ?? this.apiUrl;
  }

  get effectiveToken() {
    return this.store.remoteToken ?? this.store.token;
  }

  pauseSessionMonitoring(
    agentKind: string,
    sessionIds: unknown[],
    durationMs?: number,
  ) {
    return this.sessionMonitoringPauses.pause(agentKind, sessionIds, durationMs);
  }

  resumeSessionMonitoring(agentKind: string, sessionIds: unknown[]) {
    return this.sessionMonitoringPauses.resume(agentKind, sessionIds);
  }

  replaceSessionMonitoringPauses(pauses: SessionMonitoringPause[]) {
    this.sessionMonitoringPauses.replace(pauses);
  }

  sessionMonitoringPause(
    agentKind: string,
    sessionId: unknown,
  ): SessionMonitoringPause | undefined {
    return this.sessionMonitoringPauses.active(agentKind, sessionId);
  }

  resetSetup() {
    const introSeen = this.store?.introSeen ?? false;
    this.store = {
      token: configuredDesktopToken(this.store?.token),
      setupComplete: false,
      installIdentity: this.store?.installIdentity,
      deviceIdentity: this.store?.deviceIdentity,
      introSeen,
      agentDoneSound: this.store?.agentDoneSound ?? true,
      islandVisibility: this.islandVisibility,
      excludedProjectPaths: this.store?.excludedProjectPaths ?? [],
      clientMode: initialClientMode(),
      promptTransforms: this.store?.promptTransforms ?? defaultPromptTransformConfig,
      plugins: bundledPluginCatalog(),
      policies: defaultPolicies(),
      history: []
    };
    this.writeStore();
  }

  resetAllLocalState() {
    this.store = {
      token: configuredDesktopToken(),
      setupComplete: false,
      introSeen: false,
      agentDoneSound: true,
      islandVisibility: "always",
      excludedProjectPaths: [],
      clientMode: initialClientMode(),
      promptTransforms: defaultPromptTransformConfig,
      plugins: bundledPluginCatalog(),
      policies: defaultPolicies(),
      history: []
    };
    const reset = this.db.transaction(() => {
      this.db.prepare("delete from settings").run();
      this.db.prepare("delete from policies").run();
      this.db.prepare("delete from evaluations").run();
      this.db.prepare("delete from mcp_tool_calls").run();
      this.db.prepare("delete from mcp_servers").run();
      this.db.prepare("delete from skills").run();
    });
    reset();
    this.writeStore();
  }

  installIdentity() {
    return this.settingValue("installIdentity");
  }

  deviceIdentity() {
    if (this.store.deviceIdentity) return this.store.deviceIdentity;
    this.store.deviceIdentity = crypto.randomUUID();
    this.writeStore();
    return this.store.deviceIdentity;
  }

  rememberInstallIdentity(identity: string) {
    this.store.installIdentity = identity;
    this.writeStore();
  }

  clearData() {
    this.store.history = [];
    this.db.prepare("delete from mcp_tool_calls").run();
    this.db.prepare("delete from mcp_servers").run();
    this.writeStore();
  }

  clearSettings() {
    this.resetSetup();
  }

  markIntroSeen() {
    this.store.introSeen = true;
    this.writeStore();
  }

  async start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => void this.route(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.apiPort ?? 9317, "127.0.0.1", () => resolve());
    });
    const legacyAuthServer = http.createServer((req, res) => void this.routeLegacyAuth(req, res));
    this.legacyAuthServer = legacyAuthServer;
    await new Promise<void>((resolve) => {
      const onError = () => {
        if (this.legacyAuthServer === legacyAuthServer) this.legacyAuthServer = undefined;
        resolve();
      };
      legacyAuthServer.once("error", onError);
      legacyAuthServer.listen(this.options.legacyAuthPort ?? 4317, "127.0.0.1", () => {
        legacyAuthServer.off("error", onError);
        resolve();
      });
    });
  }

  async stop() {
    const servers = [this.server, this.legacyAuthServer].filter((server): server is http.Server => Boolean(server));
    for (const server of servers) {
      server.closeIdleConnections();
      server.closeAllConnections();
    }
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    this.server = undefined;
    this.legacyAuthServer = undefined;
    this.db.close();
  }

  completeSetup(policies: Policy[], config: SetupConfig) {
    const clientMode = config.clientMode === "custom" ? "custom" : "cloud";
    this.store.policies = enforceLockedPolicies(normalizePolicies(policies, this.store.policies, true));
    this.store.clientMode = clientMode;
    this.store.remoteApiUrl = config.remoteApiUrl;
    this.store.remoteToken = config.remoteToken;
    this.store.remoteOrganization = config.remoteOrganization;
    this.store.remoteUser = config.remoteUser;
    if (config.islandVisibility !== undefined) {
      this.store.islandVisibility = normalizeIslandVisibility(config.islandVisibility);
      this.store.islandActivityOnly = this.store.islandVisibility === "activity";
    }
    this.store.apiKey = undefined;
    this.store.history = [];
    this.store.setupComplete = true;
    this.writeStore();
  }

  markSetupIncomplete() {
    this.store.setupComplete = false;
    this.writeStore();
  }

  get agentDoneSound() {
    return Boolean(this.store.agentDoneSound);
  }

  get islandActivityOnly() {
    return this.islandVisibility === "activity";
  }

  get islandVisibility(): IslandVisibility {
    return normalizeIslandVisibility(
      this.store.islandVisibility,
      Boolean(this.store.islandActivityOnly),
    );
  }

  updateIslandActivityOnly(activityOnly: boolean) {
    this.store.islandVisibility = activityOnly ? "activity" : "always";
    this.store.islandActivityOnly = activityOnly;
    this.writeStore();
  }

  addExcludedProjectPath(projectPath: string) {
    this.store.excludedProjectPaths = normalizeExcludedProjectPaths([
      ...this.store.excludedProjectPaths,
      projectPath,
    ]);
    this.writeStore();
    return this.excludedProjectPaths;
  }

  removeExcludedProjectPath(projectPath: string) {
    const normalizedTarget = normalizeExcludedProjectPaths([projectPath])[0];
    this.store.excludedProjectPaths = this.store.excludedProjectPaths.filter(
      (candidate) => normalizeExcludedProjectPaths([candidate])[0] !== normalizedTarget,
    );
    this.writeStore();
    return this.excludedProjectPaths;
  }

  isProjectExcluded(projectPath: unknown) {
    return projectPathIsExcluded(projectPath, this.store.excludedProjectPaths);
  }

  private isMonitoringExcluded(agentKind: unknown, sessionId: unknown, projectPath?: unknown) {
    const kind = String(agentKind ?? "").trim();
    const session = String(sessionId ?? "").trim();
    const key = kind && session ? `${kind}:${session}` : "";
    const now = Date.now();
    for (const [candidate, expiresAt] of this.excludedProjectSessions) {
      if (expiresAt <= now) this.excludedProjectSessions.delete(candidate);
    }
    if (this.isProjectExcluded(projectPath)) {
      if (key) this.excludedProjectSessions.set(key, now + 24 * 60 * 60_000);
      return true;
    }
    return Boolean(key && (this.excludedProjectSessions.get(key) ?? 0) > now);
  }

  get plugins() {
    return this.store.plugins;
  }

  syncPlugins(plugins: PluginCatalogItem[]) {
    this.store.plugins = plugins;
    this.writeStore();
  }

  syncPluginRuntimeStatuses(statuses: Array<{ pluginId: string; healthy: boolean; error?: string }>) {
    this.pluginRuntimeStatuses = statuses;
  }

  updateSettings(
    apiProvider: "openai" | "anthropic",
    apiKey?: string,
    agentDoneSound?: boolean,
    islandActivityOnly?: boolean,
    islandVisibility?: IslandVisibility,
  ) {
    this.store.apiProvider = undefined;
    this.store.apiKey = undefined;
    if (typeof agentDoneSound === "boolean") this.store.agentDoneSound = agentDoneSound;
    if (islandVisibility) {
      this.store.islandVisibility = normalizeIslandVisibility(islandVisibility);
      this.store.islandActivityOnly = this.store.islandVisibility === "activity";
    } else if (typeof islandActivityOnly === "boolean") {
      this.store.islandVisibility = islandActivityOnly ? "activity" : "always";
      this.store.islandActivityOnly = islandActivityOnly;
    }
    this.writeStore();
  }

  updateRemoteApiUrl(remoteApiUrl: string) {
    if (this.clientMode !== "cloud" && this.clientMode !== "custom") return;
    this.store.remoteApiUrl = remoteApiUrl;
    this.writeStore();
  }

  updatePolicies(policies: Policy[]) {
    this.store.policies = enforceLockedPolicies(normalizePolicies(policies, [], true));
    this.writeStore();
  }

  updatePromptTransforms(config: unknown) {
    this.store.promptTransforms = normalizePromptTransformConfig(config);
    this.writeStore();
    return this.store.promptTransforms;
  }

  importPolicies(input: unknown, replace = false) {
    this.store.policies = enforceLockedPolicies(normalizePolicies(input, this.store.policies, replace));
    this.writeStore();
    return this.store.policies;
  }

  resolve(id: string, resolution: "allow" | "deny", resolutionGuidance?: string, responsePayload?: Record<string, unknown>) {
    const item = this.store.history.find((entry) => entry.id === id);
    if (!item) return undefined;
    const resolvedAt = new Date().toISOString();
    const guidance = resolution === "deny" ? cleanResolutionGuidance(resolutionGuidance) : undefined;
    const response = resolution === "allow" ? cleanInteractionResponse(responsePayload) : undefined;
    item.resolution = resolution;
    item.resolution_guidance = guidance ?? null;
    item.resolution_payload = response ?? null;
    item.resolved_at = resolvedAt;
    const cutoff = Date.now() - 5 * 60_000;
    const itemIntentKey = canonicalIntentKey(item.intentKey);
    for (const entry of this.store.history) {
      if (entry.id === item.id || entry.decision !== "ask" || entry.resolution) continue;
      const sameIntent = itemIntentKey && canonicalIntentKey(entry.intentKey) === itemIntentKey;
      const sameFingerprint = item.fingerprint && entry.fingerprint === item.fingerprint;
      if (!sameIntent && !sameFingerprint) continue;
      const created = new Date(entry.created_at).getTime();
      if (!Number.isNaN(created) && created < cutoff) continue;
      entry.resolution = resolution;
      entry.resolution_guidance = guidance ?? null;
      entry.resolution_payload = response ?? null;
      entry.resolved_at = resolvedAt;
    }
    const skillPath = skillPathFromEvaluation(item);
    if (skillPath && resolution === "deny") {
      deleteSkillFile(skillPath);
      this.markSkillDeleted(skillPath);
    } else if (skillPath && resolution === "allow") {
      this.markSkillApproved(skillPath);
    }
    this.writeStore();
    return item;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const functionName = localApiFunction(req.method ?? "", req.url ?? "");
      if (functionName && !applyLocalContract(req, res, functionName)) return;
      if (req.method === "GET" && req.url === "/health") return json(res, {
        ok: true,
        mode: this.clientMode,
        availability: this.remoteAvailability.snapshot(),
      });
      const oauthCallback = new URL(req.url ?? "/", this.apiUrl);
      if (req.method === "GET" && this.redirectOAuthCallback(oauthCallback, res)) return;
      // Every local API surface after health and the browser OAuth return is a
      // private Desktop control-plane endpoint. Binding to loopback is not an
      // authentication boundary: other local processes (and browsers through
      // cross-origin requests) can still reach it. Agent hooks receive this
      // per-install token through their protected configuration.
      if (!this.isAuthorizedLocalClient(req)) {
        return json(res, { error: "unauthorized" }, 401);
      }
      if (req.method === "GET" && req.url === "/admin/tray-status") return json(res, this.trayStatus());
      if (req.method === "GET" && req.url === "/personal/state") {
        return json(res, {
          setupComplete: this.setupComplete,
          introSeen: this.introSeen,
          clientMode: this.clientMode,
          agentDoneSound: this.agentDoneSound,
          islandVisibility: this.islandVisibility,
          excludedProjectPaths: this.excludedProjectPaths,
          remoteApiUrl: this.store.remoteApiUrl,
          remoteOrganization: this.store.remoteOrganization,
          remoteUser: this.store.remoteUser,
          apiProvider: this.store.apiProvider,
          apiKeySet: this.apiKeySet,
          promptTransforms: this.store.promptTransforms,
          plugins: this.store.plugins,
          policies: this.store.policies,
          history: this.store.history,
          mcpServers: this.mcpServers,
          skills: this.skills
        });
      }
      if (req.method === "POST" && req.url === "/personal/policies") {
        const body = await readJson(req);
        this.updatePolicies(Array.isArray(body.policies) ? body.policies : this.store.policies);
        return json(res, { ok: true, policies: this.store.policies });
      }
      if (req.method === "POST" && req.url === "/personal/prompt-transforms") {
        const body = await readJson(req);
        return json(res, { ok: true, config: this.updatePromptTransforms(body.config ?? body) });
      }
      if (req.method === "POST" && req.url === "/v1/evaluate") {
        const request = await readJson(req) as EvaluationRequest;
        if (this.isMonitoringExcluded(request.agent?.kind, request.event?.sessionId, request.event?.projectPath)) {
          return json(res, projectExcludedDecision());
        }
        const pause = this.sessionMonitoringPause(
          request.agent?.kind ?? request.event?.agentKind,
          request.event?.sessionId,
        );
        if (pause) return json(res, monitoringPausedDecision(pause));
        this.notifyAgentActivity(request);
        return json(res, await this.evaluate(request));
      }
      if (req.method === "POST" && req.url === "/v1/plugin-runtime/transform") {
        const body = await readJson(req) as {
          provider?: string;
          agentKind?: string;
          agentId?: string;
          sessionId?: string;
          projectPath?: string;
          requestBody?: Record<string, unknown>;
        };
        if (!body.requestBody || typeof body.requestBody !== "object" || Array.isArray(body.requestBody)) {
          return json(res, { error: "requestBody must be a JSON object" }, 400);
        }
        if (this.isMonitoringExcluded(body.agentKind, body.sessionId, body.projectPath)) {
          return json(res, {
            protocol: "openleash-container-plugin.v1",
            requestBody: body.requestBody,
            appliedPluginIds: [],
            runs: [],
            monitoringPaused: true,
            projectExcluded: true,
          });
        }
        const pause = this.sessionMonitoringPause(body.agentKind ?? "unknown", body.sessionId);
        if (pause) {
          return json(res, {
            protocol: "openleash-container-plugin.v1",
            requestBody: body.requestBody,
            appliedPluginIds: [],
            runs: [],
            monitoringPaused: true,
            monitoringPausedUntil: new Date(pause.expiresAt).toISOString(),
          });
        }
        return json(res, await this.forwardRemoteFeatureRuntime(
          "/v1/plugin-runtime/transform",
          body,
        ));
      }
      if (req.method === "GET" && req.url === "/personal/plugin-runtime") {
        return json(res, { features: this.pluginRuntimeStatuses, containers: [] });
      }
      if (req.method === "POST" && req.url === "/v1/plugin-runtime/tools/execute") {
        const body = await readJson(req) as { pluginId?: string; sessionId?: string; tool?: string; arguments?: Record<string, unknown> };
        const plugin = this.store.plugins.find((candidate) => candidate.id === body.pluginId);
        if (!plugin) return json(res, { error: "enabled plugin not found" }, 404);
        if (!body.tool || !body.arguments || typeof body.arguments !== "object" || Array.isArray(body.arguments)) {
          return json(res, { error: "tool and object arguments are required" }, 400);
        }
        return json(res, await this.forwardRemoteFeatureRuntime(
          "/v1/plugin-runtime/tools/execute",
          body,
        ));
      }
      if (req.method === "POST" && req.url === "/v1/agent-events") {
        const body = await readJson(req);
        const scope = agentEventScope(body);
        if (this.isMonitoringExcluded(scope.agentKind, scope.sessionId, scope.projectPath)) {
          return json(res, projectExcludedDecision());
        }
        const pause = this.sessionMonitoringPause(scope.agentKind, scope.sessionId);
        if (pause) return json(res, monitoringPausedDecision(pause));
        this.notifyAgentActivity((body as { request?: unknown })?.request);
        return json(res, await this.forwardRemoteAgentEvent(body));
      }
      const hookMatch = req.url?.match(/^\/v1\/hooks\/([^/?]+)\/([^/?]+)(?:\?.*)?$/);
      if (req.method === "POST" && hookMatch) {
        const body = await readJson(req);
        const request = normalizeHookRequest(hookMatch[1], hookMatch[2], body, req.url ?? "");
        if (isBackgroundControlPrompt(request.agent.kind, request.event.prompt)) {
          return json(res, nativeHookDecision(
            hookMatch[1],
            hookMatch[2],
            { decision: "allow", summary: "Ignored private agent UI traffic." },
          ));
        }
        if (this.isMonitoringExcluded(request.agent.kind, request.event.sessionId, request.event.projectPath)) {
          return json(res, nativeHookDecision(
            hookMatch[1],
            hookMatch[2],
            projectExcludedDecision(),
          ));
        }
        const pause = this.sessionMonitoringPause(request.agent.kind, request.event.sessionId);
        if (pause) {
          return json(res, nativeHookDecision(
            hookMatch[1],
            hookMatch[2],
            monitoringPausedDecision(pause),
          ));
        }
        this.notifyAgentActivity(request);
        const remoteDecision = await this.forwardRemoteHook(hookMatch[1], hookMatch[2], body, req.url ?? "");
        if (remoteDecision) {
          this.notifyAgentStop(hookMatch[1], hookMatch[2], body);
          return json(res, remoteDecision);
        }
        return json(res, backendUnavailableHookDecision(
          hookMatch[1],
          hookMatch[2],
          this.availabilityFailOpen,
        ));
      }
      const decision = req.url?.match(/^\/v1\/decisions\/([^/]+)$/);
      if (req.method === "GET" && decision) {
        const item = this.store.history.find((entry) => entry.id === decision[1]);
        return json(res, item ? { id: item.id, decision: item.decision, resolution: item.resolution ?? null, summary: item.summary, question: item.question } : null);
      }
      const resolveMatch = req.url?.match(/^\/admin\/decisions\/([^/]+)\/resolve$/);
      if (req.method === "POST" && resolveMatch) {
        const body = await readJson(req);
        return json(res, this.resolve(resolveMatch[1], body.resolution === "allow" ? "allow" : "deny", body.resolutionGuidance, body.response) ?? null);
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (error) {
      const status = error instanceof RemoteApiError ? error.status : 500;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "unknown error" }));
    }
  }

  private isAuthorizedLocalClient(req: http.IncomingMessage) {
    const authorization = String(req.headers.authorization ?? "");
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token) return false;
    const actual = Buffer.from(token);
    const expected = Buffer.from(this.store.token);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  private notifyAgentActivity(value: unknown) {
    if (!value || typeof value !== "object") return;
    const request = value as Partial<EvaluationRequest>;
    const agent = request.agent;
    const event = request.event;
    if (!agent || !event || !agent.kind || !event.eventName || !event.sessionId) return;
    if (
      event.raw &&
      typeof event.raw === "object" &&
      (event.raw as { backgroundControl?: unknown }).backgroundControl === true
    ) return;
    this.options.onAgentActivity?.({
      agentKind: agent.kind,
      agentName: agent.displayName || hookAgentMetadata(agent.kind).displayName,
      eventName: event.eventName,
      sessionId: event.sessionId,
      projectPath: event.projectPath,
      prompt: event.prompt,
      toolName: event.tool?.name,
      occurredAt: event.occurredAt || new Date().toISOString(),
    });
  }

  private async routeLegacyAuth(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      if (req.method === "GET") {
        const oauthCallback = new URL(req.url ?? "/", "http://localhost:4317");
        if (this.redirectOAuthCallback(oauthCallback, res)) return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "internal_error", detail: error instanceof Error ? error.message : String(error) }));
    }
  }

  private redirectOAuthCallback(oauthCallback: URL, res: http.ServerResponse) {
    const exchangeRedirectUri = desktopExchangeRedirectUri(oauthCallback.pathname);
    if (!exchangeRedirectUri) return false;
    const redirect = new URL(OPENLEASH_DESKTOP_AUTH_CALLBACK_URI);
    for (const key of ["code", "state", "error", "error_description"]) {
      const value = oauthCallback.searchParams.get(key);
      if (value) redirect.searchParams.set(key, value);
    }
    redirect.searchParams.set("exchangeRedirectUri", exchangeRedirectUri);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (this.options.onDesktopAuthCallback) {
      void Promise.resolve(
        this.options.onDesktopAuthCallback(redirect.toString()),
      ).catch(() => undefined);
      res.end(desktopAuthDirectReturnPage());
      return true;
    }
    res.end(desktopAuthReturnPage(redirect.toString()));
    return true;
  }

  private async evaluate(request: EvaluationRequest) {
    const intentKey = triggerIntentKey(request);
    const handledIntent = intentKey ? this.findRecentHandledIntent(intentKey, request) : undefined;
    if (handledIntent) {
      const resolvedDecision = handledIntent.resolution ?? handledIntent.decision;
      return {
        decision: resolvedDecision,
        decisionId: handledIntent.id,
        summary: handledIntent.summary,
        question: handledIntent.resolution ? undefined : handledIntent.question,
        resolutionPayload: handledIntent.resolution === "allow" ? handledIntent.resolution_payload ?? undefined : undefined,
        results: []
      };
    }
    const evaluatedResults = this.store.policies.filter((policy) => policy.enabled).map((policy) => evaluatePolicy(policy, request));
    const results = isNonActionableHookEvent(request.event.eventName) || (shouldDeferPromptOnlyApproval(request, evaluatedResults) && !hasSensitivePromptOnlyFinding(request, evaluatedResults))
      ? deferPromptOnlyPolicyResults(evaluatedResults)
      : evaluatedResults;
    const failed = results.filter((result) => result.status === "failed" || result.status === "needs_question");
    const nativeInteraction = agentInteractionForRequest(request);
    const decision: "ask" | "allow" = failed.length > 0 || nativeInteraction ? "ask" : "allow";
    const filePath = await this.extractFilePath(request, failed);
    const summary = failed[0]
      ? summarizeBlockedAction(request, failed[0].policyName)
      : nativeInteraction?.summary
        ? nativeInteraction.summary
      : summarizeAllowedAction(request, filePath);
    if (decision === "allow" && !request.event.tool?.name) {
      return { decision, decisionId: "", summary, results };
    }
    const fingerprint = failed.length > 0 ? triggerFingerprint(request, failed, summary) : undefined;
    const duplicate = fingerprint ? this.findRecentDuplicate(fingerprint) : undefined;
    if (duplicate) {
      const resolvedDecision = duplicate.resolution ?? duplicate.decision;
      return {
        decision: resolvedDecision,
        decisionId: duplicate.id,
        summary: duplicate.summary,
        question: duplicate.resolution ? undefined : duplicate.question,
        resolutionPayload: duplicate.resolution === "allow" ? duplicate.resolution_payload ?? undefined : undefined,
        results
      };
    }
    const id = crypto.randomUUID();
    const purposeSummary = decision === "ask"
      ? nativeInteraction?.purpose ?? await this.summarizeActionPurpose(request)
      : undefined;
    const evaluation: Evaluation = {
      id,
      fingerprint,
      intentKey,
      file_path: filePath,
      decision,
      resolution: decision === "allow" ? "allow" : null,
      summary,
      question: decision === "ask" ? nativeInteraction?.question ?? `${summary} Allow this action once?` : undefined,
      created_at: new Date().toISOString(),
      resolved_at: decision === "allow" ? new Date().toISOString() : undefined,
      user_name: localUserDisplayName(),
      hostname: request.computer.hostname || os.hostname(),
      agent_name: request.agent.displayName,
      agent_kind: request.agent.kind,
      event_name: request.event.eventName,
      tool_name: request.event.tool?.name,
      project_path: request.event.projectPath,
      payload: { ...request.event, openleashIntentKey: intentKey, ...(purposeSummary ? { openleashPurposeSummary: purposeSummary } : {}) } as EvaluationRequest["event"],
      triggered_policies: failed.map((result) => ({
        policy_name: result.policyName,
        status: result.status as "failed" | "needs_question",
        severity: result.severity,
        explanation: result.explanation,
        evidence: result.evidence
      }))
    };
    this.store.history.unshift(evaluation);
    this.store.history = this.store.history.slice(0, 500);
    this.writeStore();
    this.recordLocalMcpToolCall(evaluation);
    return { decision, decisionId: id, summary, question: evaluation.question, results };
  }

  private async handlePromptTransformHook(agent: string, eventName: string, request: EvaluationRequest) {
    const prompt = request.event.prompt?.trim();
    if (!prompt) {
      return nativeHookDecision(agent, eventName, { decision: "allow", summary: "Leash approved this action." });
    }
    const result = await transformPrompt({
      prompt,
      config: this.store.promptTransforms,
      apiKey: this.store.apiProvider === "openai" ? this.store.apiKey : undefined
    });
    this.recordPromptTransformEvaluation(request, result);
    if (result.blocked) {
      return nativeHookDecision(agent, eventName, { decision: "deny", summary: result.summary });
    }
    if (result.requiresApproval) {
      return nativeHookDecision(agent, eventName, { decision: "ask", summary: result.summary, question: result.summary });
    }
    return promptTransformHookDecision(agent, eventName, result.finalPrompt, result.summary);
  }

  private recordPromptTransformEvaluation(request: EvaluationRequest, result: PromptTransformResult) {
    const id = crypto.randomUUID();
    const evaluation: Evaluation = {
      id,
      intentKey: triggerIntentKey(request),
      decision: result.blocked ? "deny" : result.requiresApproval ? "ask" : "allow",
      resolution: result.blocked ? "deny" : result.requiresApproval ? null : "allow",
      summary: result.summary,
      created_at: new Date().toISOString(),
      resolved_at: result.requiresApproval ? undefined : new Date().toISOString(),
      user_name: localUserDisplayName(),
      hostname: request.computer.hostname || os.hostname(),
      agent_name: request.agent.displayName,
      agent_kind: request.agent.kind,
      event_name: request.event.eventName,
      tool_name: request.event.tool?.name,
      project_path: request.event.projectPath,
      payload: {
        ...request.event,
        openleashPromptTransform: {
          originalPrompt: request.event.prompt ?? "",
          finalPrompt: result.finalPrompt,
          blocked: result.blocked,
          compression: result.compression,
          dlp: result.dlp,
          model: result.model
        }
      } as EvaluationRequest["event"],
      triggered_policies: result.blocked || result.requiresApproval ? [{
        policy_name: "DLP funnel",
        status: result.blocked ? "failed" : "needs_question",
        severity: result.blocked ? "high" : "medium",
        explanation: result.summary,
        evidence: result.dlp?.findings?.map((finding) => `${finding.category}: ${finding.reason}`) ?? []
      }] : []
    };
    this.store.history.unshift(evaluation);
    this.store.history = this.store.history.slice(0, 500);
    this.writeStore();
  }

  private async forwardRemoteHook(agent: string, eventName: string, body: unknown, originalUrl: string) {
    if (!this.store.remoteApiUrl || !this.store.remoteToken) return undefined;
    if (!this.remoteAvailability.canAttempt()) return undefined;
    this.options.onRemoteHookForward?.({ agent, eventName, body });
    const endpoint = new URL(`/v1/hooks/${agent}/${eventName}`, this.store.remoteApiUrl.replace(/\/+$/, ""));
    const query = new URL(originalUrl, "http://127.0.0.1").searchParams;
    for (const [key, value] of query.entries()) {
      if (key !== "user_token" && key !== "token") endpoint.searchParams.set(key, value);
    }
    const response = await this.fetchRemoteOrUnavailable(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.store.remoteToken}`,
          [OPENLEASH_API_FUNCTION_HEADER]: "tenantHookEvaluate",
          [OPENLEASH_API_VERSION_HEADER]: OPENLEASH_API_CONTRACTS.tenantHookEvaluate
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.OPENLEASH_REMOTE_HOOK_TIMEOUT_MS ?? 610000))
      });
    if (!response) return undefined;
    if (!response.ok) {
      if (isAvailabilityHttpStatus(response.status)) {
        this.remoteAvailability.recordAvailabilityFailure(
          `Leash Cloud returned HTTP ${response.status}`,
        );
        return undefined;
      }
      this.remoteAvailability.recordNonAvailabilityFailure();
      return nativeHookDecision(agent, eventName, {
        decision: "deny",
        summary: `Leash Cloud rejected this request (HTTP ${response.status}). Sign in again or contact your administrator.`,
      });
    }
    try {
      const decision = await response.json() as unknown;
      this.remoteAvailability.recordSuccess();
      return decision;
    } catch {
      this.remoteAvailability.recordNonAvailabilityFailure();
      return nativeHookDecision(agent, eventName, {
        decision: "deny",
        summary:
          "Leash Cloud returned an invalid policy response. The action was held for safety.",
      });
    }
  }

  private async forwardRemoteAgentEvent(body: unknown) {
    if (!this.store.remoteApiUrl || !this.store.remoteToken) {
      throw new RemoteApiError(401, "Leash backend credentials are unavailable");
    }
    if (!this.remoteAvailability.canAttempt()) {
      if (this.availabilityFailOpen) return backendUnavailableProxyDecision();
      throw new RemoteApiError(503, "Leash protection backend is unavailable");
    }
    const response = await this.fetchRemoteOrUnavailable(
      new URL("/v1/agent-events", this.store.remoteApiUrl.replace(/\/+$/, "")),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.store.remoteToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response) {
      if (this.availabilityFailOpen) return backendUnavailableProxyDecision();
      throw new RemoteApiError(503, "Leash protection backend is unavailable");
    }
    const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      if (isAvailabilityHttpStatus(response.status)) {
        this.remoteAvailability.recordAvailabilityFailure(
          `Leash Cloud returned HTTP ${response.status}`,
        );
        if (this.availabilityFailOpen) return backendUnavailableProxyDecision();
        throw new RemoteApiError(
          response.status,
          `Leash protection backend returned HTTP ${response.status}`,
        );
      }
      this.remoteAvailability.recordNonAvailabilityFailure();
      throw new RemoteApiError(
        response.status,
        (result as { error?: string }).error ??
          `Leash backend returned HTTP ${response.status}`,
      );
    }
    this.remoteAvailability.recordSuccess();
    return result;
  }

  private async forwardRemoteFeatureRuntime(pathname: string, body: unknown) {
    if (!this.store.remoteApiUrl || !this.store.remoteToken) {
      throw new RemoteApiError(401, "Leash backend credentials are unavailable");
    }
    if (!this.remoteAvailability.canAttempt()) {
      if (this.availabilityFailOpen) return backendUnavailableTransformDecision(body);
      throw new RemoteApiError(503, "Leash protection backend is unavailable");
    }
    const response = await this.fetchRemoteOrUnavailable(
      new URL(pathname, this.store.remoteApiUrl.replace(/\/+$/, "")),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.store.remoteToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response) {
      if (this.availabilityFailOpen) return backendUnavailableTransformDecision(body);
      throw new RemoteApiError(503, "Leash protection backend is unavailable");
    }
    const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      if (isAvailabilityHttpStatus(response.status)) {
        this.remoteAvailability.recordAvailabilityFailure(
          `Leash Cloud returned HTTP ${response.status}`,
        );
        if (this.availabilityFailOpen) return backendUnavailableTransformDecision(body);
        throw new RemoteApiError(
          response.status,
          `Leash protection backend returned HTTP ${response.status}`,
        );
      }
      this.remoteAvailability.recordNonAvailabilityFailure();
      throw new RemoteApiError(
        response.status,
        (result as { error?: string }).error ??
          `Leash backend returned HTTP ${response.status}`,
      );
    }
    this.remoteAvailability.recordSuccess();
    return result;
  }

  private async fetchRemoteOrUnavailable(
    input: URL,
    init: RequestInit,
  ) {
    const controller = new AbortController();
    const upstreamSignal = init.signal;
    const forwardAbort = () => controller.abort(upstreamSignal?.reason);
    upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });
    let completed = false;
    let readinessFailure: string | undefined;
    void this.watchRemoteReadiness(
      input.origin,
      controller,
      () => completed,
      (reason) => {
        readinessFailure = reason;
      },
    );
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (!readinessFailure && !isAvailabilityTransportError(error)) {
        this.remoteAvailability.recordNonAvailabilityFailure();
        throw error;
      }
      this.remoteAvailability.recordAvailabilityFailure(
        readinessFailure ??
          (error instanceof Error ? error.message : "Leash Cloud request failed"),
      );
      return undefined;
    } finally {
      completed = true;
      upstreamSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  private async watchRemoteReadiness(
    remoteOrigin: string,
    controller: AbortController,
    completed: () => boolean,
    onFailure: (reason: string) => void,
  ) {
    const graceMs = Math.max(
      50,
      Number(process.env.OPENLEASH_REMOTE_READINESS_GRACE_MS ?? 3_000),
    );
    const intervalMs = Math.max(
      50,
      Number(process.env.OPENLEASH_REMOTE_READINESS_INTERVAL_MS ?? 7_000),
    );
    const probeTimeoutMs = Math.max(
      50,
      Number(process.env.OPENLEASH_REMOTE_READINESS_TIMEOUT_MS ?? 1_500),
    );
    await waitForReadinessProbe(graceMs);
    let consecutiveFailures = 0;
    while (!completed() && !controller.signal.aborted) {
      try {
        const response = await fetch(new URL("/cloud/readiness", remoteOrigin), {
          signal: AbortSignal.timeout(probeTimeoutMs),
        });
        // A non-availability 4xx still proves that the service is reachable;
        // only the same narrow classes used by the circuit count as outages.
        consecutiveFailures = isAvailabilityHttpStatus(response.status) ? consecutiveFailures + 1 : 0;
      } catch (error) {
        if (isAvailabilityTransportError(error)) consecutiveFailures += 1;
        else consecutiveFailures = 0;
      }
      if (consecutiveFailures >= 2 && !completed()) {
        const reason = "Leash Cloud readiness failed twice while evaluation was pending";
        onFailure(reason);
        controller.abort(new Error(reason));
        return;
      }
      await waitForReadinessProbe(intervalMs);
    }
  }

  private notifyAgentStop(agent: string, eventName: string, body: unknown) {
    if (eventName !== "Stop") return;
    this.options.onAgentStop?.({ agent, eventName, body });
  }

  private async waitForHookDecision(decision: { decision: "allow" | "ask" | "deny"; decisionId: string; summary: string; question?: string; resolutionPayload?: Record<string, unknown>; results: PolicyResult[] }) {
    if (decision.decision !== "ask") return decision;
    const timeoutMs = Number(process.env.OPENLEASH_HOOK_APPROVAL_TIMEOUT_MS ?? 600000);
    const pollMs = Number(process.env.OPENLEASH_HOOK_APPROVAL_POLL_MS ?? 250);
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
      const item = this.store.history.find((entry) => entry.id === decision.decisionId);
      if (item?.resolution === "allow" || item?.resolution === "deny") {
        return {
          ...decision,
          decision: item.resolution,
          summary: item.resolution === "allow" ? "Leash approved this action." : item.summary,
          resolutionGuidance: item.resolution === "deny" ? item.resolution_guidance ?? undefined : undefined,
          resolutionPayload: item.resolution === "allow" ? item.resolution_payload ?? undefined : undefined,
          question: undefined
        };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(100, pollMs)));
    }
    return {
      ...decision,
      decision: "deny" as const,
      summary: "Leash timed out waiting for approval.",
      question: undefined
    };
  }

  private async extractFilePath(request: EvaluationRequest, failed: PolicyResult[]) {
    const localPath = extractFilePathLocally(request, failed);
    if (localPath && isUsefulPath(localPath)) return localPath;
    if (this.store.apiProvider !== "openai" || !this.store.apiKey) return localPath;
    return await extractFilePathWithOpenAI(request, failed, this.store.apiKey) ?? localPath;
  }

  private async summarizeActionPurpose(request: EvaluationRequest) {
    const fallback = heuristicActionPurpose(request);
    if (this.store.apiProvider !== "openai" || !this.store.apiKey) return fallback;
    return await summarizeActionPurposeWithOpenAI(request, this.store.apiKey) ?? fallback;
  }

  private findRecentDuplicate(fingerprint: string) {
    const cutoff = Date.now() - 5 * 60_000;
    return this.store.history.find((entry) => {
      if (entry.fingerprint !== fingerprint) return false;
      const created = new Date(entry.created_at).getTime();
      return Number.isNaN(created) || created >= cutoff;
    });
  }

  private findRecentHandledIntent(intentKey: string, request: EvaluationRequest) {
    const cutoff = Date.now() - 5 * 60_000;
    return this.store.history.find((entry) => {
      if (!isReusableHandledIntent({ eventName: entry.event_name, decision: entry.decision })) return false;
      if (!handledIntentKeysMatch(entry.intentKey, intentKey) && entry.fingerprint !== intentKey) return false;
      if (entry.id === request.event.raw && typeof request.event.raw === "string") return false;
      const created = new Date(entry.created_at).getTime();
      return Number.isNaN(created) || created >= cutoff;
    });
  }

  private trayStatus() {
    const pending = dedupePendingEvaluations(this.store.history.filter((entry) => entry.decision === "ask" && !entry.resolution));
    const latestByAgent = new Map<string, Evaluation>();
    for (const item of this.store.history) {
      if (isPassOnlyEvaluation(item)) continue;
      const key = `${item.agent_kind}:${item.hostname}`;
      if (!latestByAgent.has(key)) latestByAgent.set(key, item);
    }
    if (latestByAgent.size === 0) {
      for (const item of this.store.history) {
        const key = `${item.agent_kind}:${item.hostname}`;
        if (!latestByAgent.has(key)) latestByAgent.set(key, item);
      }
    }
    const sessions = this.agentSessions();
    const session_metrics = sessionMetrics(sessions);
    return {
      pending,
      session_metrics,
      availability: this.remoteAvailability.snapshot(),
      agents: [...latestByAgent.values()].slice(0, 12).map((item) => ({
        id: `${item.agent_kind}:${item.hostname}`,
        decision_id: item.id,
        kind: item.agent_kind,
        display_name: item.agent_name,
        hostname: item.hostname,
        user_name: item.user_name,
        event_name: item.event_name,
        tool_name: item.tool_name,
        project_path: item.project_path,
        payload: item.payload,
        activity_at: item.created_at,
        decision: item.decision,
        resolution: item.resolution ?? null,
        decision_summary: item.summary,
        question: item.question,
        triggered_policies: item.triggered_policies,
        recent_activity: this.store.history
          .filter((entry) => entry.agent_kind === item.agent_kind && entry.hostname === item.hostname)
          .filter((entry) => !isPassOnlyEvaluation(entry))
          .slice(0, 5)
          .map((entry) => ({ event_name: entry.event_name, tool_name: entry.tool_name, project_path: entry.project_path, created_at: entry.created_at, decision: entry.decision, summary: entry.summary })),
        sessions: sessions.filter((session) => session.agent_kind === item.agent_kind && session.hostname === item.hostname).slice(0, 8),
        short_summary: item.summary
      }))
    };
  }

  private agentSessions() {
    const groups = new Map<string, Evaluation[]>();
    for (const item of this.store.history) {
      const sessionId = item.payload?.sessionId || "unknown";
      const key = [item.agent_kind, item.hostname, sessionId, item.project_path ?? ""].join("|");
      const group = groups.get(key) ?? [];
      group.push(item);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([key, items]) => {
      const sorted = items.slice().sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const first = sorted[sorted.length - 1];
      const latest = sorted[0];
      const durationSeconds = Math.max(0, Math.round((new Date(latest.created_at).getTime() - new Date(first.created_at).getTime()) / 1000));
      const mcpServers = new Set<string>();
      const subagents = subagentStats(sorted);
      for (const item of sorted) {
        const parsed = mcpToolCallFromEvaluation(item);
        if (parsed?.serverName) mcpServers.add(parsed.serverName);
      }
      const risky = sorted.filter((item) => item.decision === "ask" || item.decision === "deny" || item.resolution === "deny" || item.triggered_policies.length > 0);
      return {
        id: key,
        session_id: String(latest.payload?.sessionId ?? "unknown"),
        agent_kind: latest.agent_kind,
        agent_name: latest.agent_name,
        hostname: latest.hostname,
        title: sessionTitle(sorted),
        summary: sessionSummary(sorted),
        project_path: latest.project_path,
        started_at: first.created_at,
        last_activity_at: latest.created_at,
        duration_seconds: durationSeconds,
        subagent_count: subagents.count,
        subagent_seconds: subagents.seconds,
        orchestrator_seconds: Math.max(0, durationSeconds - subagents.seconds),
        event_count: sorted.length,
        approval_count: sorted.filter((item) => item.decision === "ask").length,
        denied_count: sorted.filter((item) => item.decision === "deny" || item.resolution === "deny").length,
        mcp_servers: [...mcpServers].slice(0, 6),
        events: (risky.length > 0 ? risky : sorted).slice(0, 12).map((item) => ({
          id: item.id,
          event_name: item.event_name,
          tool_name: item.tool_name,
          project_path: item.project_path,
          prompt: item.payload?.prompt,
          payload: item.payload,
          created_at: item.created_at,
          decision: item.decision,
          resolution: item.resolution,
          summary: item.summary,
          question: item.question,
          triggered_policies: item.triggered_policies
        }))
      };
    }).sort((a, b) => new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime());
  }

  private readStore(): Store {
    const devToken = configuredDesktopTokenFromEnvironment();
    const token = configuredDesktopToken(this.getSetting("token") ?? undefined);
    const configuredRemoteApiUrl = this.settingValue("remoteApiUrl");
    const remoteToken = devToken && /^https?:\/\/(127\.0\.0\.1|localhost)(?::\d+)?\/?$/i.test(configuredRemoteApiUrl ?? "")
      ? devToken
      : this.settingValue("remoteToken");
    const storedPolicies = this.readPolicies();
    const policies = migrateDefaultPolicies(storedPolicies);
    const store = {
      token,
      setupComplete: this.getSetting("setupComplete") === "true",
      installIdentity: this.settingValue("installIdentity"),
      deviceIdentity: this.settingValue("deviceIdentity"),
      introSeen: this.getSetting("introSeen") === "true",
      agentDoneSound: this.getSetting("agentDoneSound") !== "false",
      islandVisibility: normalizeIslandVisibility(
        this.settingValue("islandVisibility"),
        this.getSetting("islandActivityOnly") === "true",
      ),
      excludedProjectPaths: normalizeExcludedProjectPaths(
        parseJson<unknown>(this.settingValue("excludedProjectPaths") ?? null, []),
      ),
      clientMode: normalizeClientMode(this.settingValue<ClientMode>("clientMode") ?? initialClientMode()),
      remoteApiUrl: configuredRemoteApiUrl,
      remoteToken,
      remoteOrganization: this.settingValue("remoteOrganization"),
      remoteUser: this.settingValue("remoteUser"),
      apiProvider: undefined,
      apiKey: undefined,
      promptTransforms: normalizePromptTransformConfig(parseJson<unknown>(this.settingValue("promptTransforms") ?? null, undefined)),
      plugins: bundledPluginCatalog(),
      policies: enforceLockedPolicies(policies.length > 0 ? policies : defaultPolicies()),
      history: this.readHistory()
    };
    if (
      this.getSetting("token") !== token ||
      (devToken && this.getSetting("remoteToken") !== remoteToken) ||
      policies.length !== storedPolicies.length
    ) {
      this.store = store;
      this.writeStore();
    }
    return {
      ...store,
      setupComplete: Boolean(store.setupComplete && store.remoteApiUrl && store.remoteToken)
    };
  }

  async observeSkill(input: {
    agentKind: string;
    agentName: string;
    scope: "user" | "project";
    projectPath?: string | null;
    skillName: string;
    skillPath: string;
    content: string;
    changedAt?: string;
  }) {
    const contentHash = crypto.createHash("sha256").update(input.content).digest("hex");
    const existing = this.db.prepare("select content_hash, status, content, purpose_summary, content_updated_at from skills where skill_path = ?").get(input.skillPath) as { content_hash?: string; status?: string; content?: string | null; purpose_summary?: string | null; content_updated_at?: string | null } | undefined;
    const eventType: SkillLifecycleEvent = !existing || existing.status === "deleted"
      ? "detected"
      : existing.content_hash === contentHash
        ? "seen"
        : "changed";
    if (eventType === "seen" && existing?.content && existing.purpose_summary) {
      const seenAt = input.changedAt ?? new Date().toISOString();
      this.db.prepare("update skills set last_seen_at = ?, updated_at = ? where skill_path = ?").run(seenAt, seenAt, input.skillPath);
      return { ok: true, unchanged: true, eventType, contentHash, purposeSummary: existing.purpose_summary };
    }
    const purposeSummary = heuristicSkillPurpose(input.content, input.skillName);
    const now = new Date().toISOString();
    const status = eventType === "seen" && existing?.status === "approved" ? "approved" : "observed";
    this.db.prepare(`
      insert into skills (
        id, agent_kind, agent_name, scope, project_path, skill_name, skill_path, status, risk_score,
        reasons_json, content_hash, content, content_preview, purpose_summary, content_updated_at, first_seen_at, last_seen_at, updated_at
      )
      values (@id, @agent_kind, @agent_name, @scope, @project_path, @skill_name, @skill_path, @status, @risk_score,
        @reasons_json, @content_hash, @content, @content_preview, @purpose_summary, @content_updated_at, @first_seen_at, @last_seen_at, @updated_at)
      on conflict(skill_path) do update set
        agent_kind = excluded.agent_kind,
      agent_name = excluded.agent_name,
      scope = excluded.scope,
      project_path = excluded.project_path,
      skill_name = excluded.skill_name,
      status = excluded.status,
        risk_score = excluded.risk_score,
        reasons_json = excluded.reasons_json,
        content_hash = excluded.content_hash,
        content = excluded.content,
        content_preview = excluded.content_preview,
        purpose_summary = excluded.purpose_summary,
        content_updated_at = excluded.content_updated_at,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `).run({
      id: crypto.randomUUID(),
      agent_kind: input.agentKind,
      agent_name: input.agentName,
      scope: input.scope,
      project_path: input.projectPath ?? null,
      skill_name: input.skillName,
      skill_path: input.skillPath,
      status,
      risk_score: 0,
      reasons_json: JSON.stringify([]),
      content_hash: contentHash,
      content: truncate(input.content, 80000),
      content_preview: truncate(input.content, 12000),
      purpose_summary: purposeSummary,
      content_updated_at: existing?.content_hash === contentHash ? (existing.content_updated_at ?? input.changedAt ?? now) : (input.changedAt ?? now),
      first_seen_at: now,
      last_seen_at: input.changedAt ?? now,
      updated_at: now
    });
    return { ok: true, suspicious: false, eventType, contentHash, purposeSummary };
  }

  observeSkillRemoved(input: {
    agentKind: string;
    agentName: string;
    scope: "user" | "project";
    projectPath?: string | null;
    skillName: string;
    skillPath: string;
    removedAt?: string;
  }) {
    const existing = this.db.prepare("select status, content_hash, purpose_summary from skills where skill_path = ?").get(input.skillPath) as { status?: string; content_hash?: string; purpose_summary?: string | null } | undefined;
    if (!existing || existing.status === "deleted") return { ok: true, unchanged: true, eventType: "removed" as SkillLifecycleEvent, contentHash: existing?.content_hash, purposeSummary: existing?.purpose_summary ?? undefined };
    const now = input.removedAt ?? new Date().toISOString();
    this.db.prepare(`
      update skills
      set agent_kind = ?, agent_name = ?, scope = ?, project_path = ?, skill_name = ?, status = 'deleted', last_seen_at = ?, updated_at = ?
      where skill_path = ?
    `).run(input.agentKind, input.agentName, input.scope, input.projectPath ?? null, input.skillName, now, now, input.skillPath);
    return { ok: true, suspicious: false, eventType: "removed" as SkillLifecycleEvent, contentHash: existing.content_hash, purposeSummary: existing.purpose_summary ?? undefined };
  }

  private writeStore() {
    const write = this.db.transaction((store: Store) => {
      this.db.prepare("delete from settings").run();
      this.db.prepare("delete from policies").run();
      this.db.prepare("delete from evaluations").run();
      const insertSetting = this.db.prepare("insert into settings (key, value) values (?, ?)");
      insertSetting.run("token", store.token);
      insertSetting.run("setupComplete", String(store.setupComplete));
      if (store.installIdentity) insertSetting.run("installIdentity", store.installIdentity);
      if (store.deviceIdentity) insertSetting.run("deviceIdentity", store.deviceIdentity);
      insertSetting.run("introSeen", String(Boolean(store.introSeen)));
      insertSetting.run("agentDoneSound", String(Boolean(store.agentDoneSound)));
      insertSetting.run("islandVisibility", normalizeIslandVisibility(store.islandVisibility, Boolean(store.islandActivityOnly)));
      insertSetting.run("islandActivityOnly", String(normalizeIslandVisibility(store.islandVisibility, Boolean(store.islandActivityOnly)) === "activity"));
      insertSetting.run("excludedProjectPaths", JSON.stringify(normalizeExcludedProjectPaths(store.excludedProjectPaths)));
      if (store.clientMode) insertSetting.run("clientMode", store.clientMode);
      if (store.remoteApiUrl) insertSetting.run("remoteApiUrl", store.remoteApiUrl);
      if (store.remoteToken) insertSetting.run("remoteToken", store.remoteToken);
      if (store.remoteOrganization) insertSetting.run("remoteOrganization", store.remoteOrganization);
      if (store.remoteUser) insertSetting.run("remoteUser", store.remoteUser);
      if (store.apiProvider) insertSetting.run("apiProvider", store.apiProvider);
      if (store.apiKey) insertSetting.run("apiKey", store.apiKey);
      insertSetting.run("promptTransforms", JSON.stringify(normalizePromptTransformConfig(store.promptTransforms)));
      insertSetting.run("jsonMigrated", "true");

      const insertPolicy = this.db.prepare(`
        insert into policies (id, name, category, description, enabled, locked, match_json, pattern, sort_order)
        values (@id, @name, @category, @description, @enabled, @locked, @match_json, @pattern, @sort_order)
      `);
      store.policies.forEach((policy, index) => {
        insertPolicy.run({
          id: policy.id,
          name: policy.name,
          category: policy.category,
          description: policy.description,
          enabled: policy.enabled ? 1 : 0,
          locked: policy.locked ? 1 : 0,
          match_json: policy.match ? JSON.stringify(policy.match) : null,
          pattern: policy.pattern ?? null,
          sort_order: index
        });
      });

      const insertEvaluation = this.db.prepare(`
        insert into evaluations (
        id, fingerprint, intent_key, file_path, decision, resolution, resolution_guidance, resolution_payload_json, summary, question, created_at, resolved_at,
          user_name, hostname, agent_name, agent_kind, event_name, tool_name, project_path,
          payload_json, triggered_policies_json
        )
        values (
        @id, @fingerprint, @intent_key, @file_path, @decision, @resolution, @resolution_guidance, @resolution_payload_json, @summary, @question, @created_at, @resolved_at,
          @user_name, @hostname, @agent_name, @agent_kind, @event_name, @tool_name, @project_path,
          @payload_json, @triggered_policies_json
        )
      `);
      store.history.slice(0, 500).forEach((item) => {
        insertEvaluation.run({
          id: item.id,
          fingerprint: item.fingerprint ?? null,
          intent_key: item.intentKey ?? null,
          file_path: item.file_path ?? null,
          decision: item.decision,
          resolution: item.resolution ?? null,
          resolution_guidance: item.resolution_guidance ?? null,
          resolution_payload_json: item.resolution_payload ? JSON.stringify(item.resolution_payload) : null,
          summary: item.summary,
          question: item.question ?? null,
          created_at: item.created_at,
          resolved_at: item.resolved_at ?? null,
          user_name: item.user_name,
          hostname: item.hostname,
          agent_name: item.agent_name,
          agent_kind: item.agent_kind,
          event_name: item.event_name,
          tool_name: item.tool_name ?? null,
          project_path: item.project_path ?? null,
          payload_json: JSON.stringify(item.payload ?? {}),
          triggered_policies_json: JSON.stringify(item.triggered_policies ?? [])
        });
      });
    });
    write(this.store);
  }

  private recordLocalMcpToolCall(evaluation: Evaluation) {
    const parsed = mcpToolCallFromEvaluation(evaluation);
    if (!parsed) return;
    const serverId = slug(parsed.serverName);
    const occurredAt = evaluation.created_at;
    const insertServer = this.db.prepare(`
      insert into mcp_servers (id, server_name, first_seen_at, last_seen_at, tool_count, call_count)
      values (@id, @server_name, @first_seen_at, @last_seen_at, 1, 1)
      on conflict(id) do update set last_seen_at = excluded.last_seen_at
    `);
    insertServer.run({
      id: serverId,
      server_name: parsed.serverName,
      first_seen_at: occurredAt,
      last_seen_at: occurredAt
    });
    this.db.prepare(`
      insert or ignore into mcp_tool_calls (
        id, mcp_server_id, evaluation_id, server_name, tool_name, full_tool_name,
        arguments_json, argument_summary, project_path, session_id, decision, resolution,
        risk_level, occurred_at, agent_name, agent_kind, hostname, user_name
      )
      values (
        @id, @mcp_server_id, @evaluation_id, @server_name, @tool_name, @full_tool_name,
        @arguments_json, @argument_summary, @project_path, @session_id, @decision, @resolution,
        @risk_level, @occurred_at, @agent_name, @agent_kind, @hostname, @user_name
      )
    `).run({
      id: evaluation.id,
      mcp_server_id: serverId,
      evaluation_id: evaluation.id,
      server_name: parsed.serverName,
      tool_name: parsed.toolName,
      full_tool_name: parsed.fullToolName,
      arguments_json: JSON.stringify(parsed.arguments ?? {}),
      argument_summary: parsed.argumentSummary,
      project_path: evaluation.project_path ?? null,
      session_id: evaluation.payload.sessionId,
      decision: evaluation.decision,
      resolution: evaluation.resolution ?? null,
      risk_level: evaluation.decision === "ask" ? "policy_review" : "observed",
      occurred_at: occurredAt,
      agent_name: evaluation.agent_name,
      agent_kind: evaluation.agent_kind,
      hostname: evaluation.hostname,
      user_name: evaluation.user_name
    });
    const stats = this.db.prepare(`
      select count(distinct tool_name) as tool_count, count(*) as call_count, max(occurred_at) as last_seen_at
      from mcp_tool_calls
      where mcp_server_id = ?
    `).get(serverId) as { tool_count: number; call_count: number; last_seen_at: string };
    this.db.prepare(`
      update mcp_servers set tool_count = ?, call_count = ?, last_seen_at = ? where id = ?
    `).run(stats.tool_count, stats.call_count, stats.last_seen_at, serverId);
  }

  private readMcpRegistry(): McpServerRegistryItem[] {
    const servers = this.db.prepare("select * from mcp_servers order by datetime(last_seen_at) desc limit 250").all() as Array<{
      id: string;
      server_name: string;
      first_seen_at: string;
      last_seen_at: string;
      tool_count: number;
      call_count: number;
    }>;
    const callRows = this.db.prepare("select * from mcp_tool_calls order by datetime(occurred_at) desc limit 1000").all() as Array<{
      id: string;
      mcp_server_id: string;
      evaluation_id: string;
      server_name: string;
      tool_name: string;
      full_tool_name: string;
      arguments_json: string;
      argument_summary: string;
      project_path: string | null;
      session_id: string;
      decision: "allow" | "ask" | "deny";
      resolution: "allow" | "deny" | null;
      risk_level: string;
      occurred_at: string;
      agent_name: string;
      agent_kind: string;
      hostname: string;
      user_name: string;
    }>;
    return servers.map((server) => {
      const calls = callRows.filter((call) => call.mcp_server_id === server.id).map((call) => ({
        id: call.id,
        server_name: call.server_name,
        tool_name: call.tool_name,
        full_tool_name: call.full_tool_name,
        arguments: parseJson<unknown>(call.arguments_json, {}),
        argument_summary: call.argument_summary,
        project_path: call.project_path ?? undefined,
        session_id: call.session_id,
        decision: call.decision,
        resolution: call.resolution,
        risk_level: call.risk_level,
        occurred_at: call.occurred_at,
        agent_name: call.agent_name,
        agent_kind: call.agent_kind,
        hostname: call.hostname,
        user_name: call.user_name,
        evaluation_id: call.evaluation_id
      }));
      return {
        ...server,
        user_count: new Set(calls.map((call) => call.user_name)).size,
        tools: [...new Set(calls.map((call) => call.tool_name))].map((tool_name) => ({ tool_name })),
        users: [...new Set(calls.map((call) => call.user_name))].map((name) => ({ name })),
        calls: calls.slice(0, 100)
      };
    });
  }

  private migrateSchema() {
    this.db.exec(`
      create table if not exists settings (
        key text primary key,
        value text
      );

      create table if not exists schema_migrations (
        id text primary key,
        checksum text not null,
        applied_at text not null
      );

      create table if not exists policies (
        id text primary key,
        name text not null,
        category text not null,
        description text not null,
        enabled integer not null default 1,
        locked integer not null default 0,
        match_json text,
        pattern text,
        sort_order integer not null default 0
      );

      create table if not exists evaluations (
        id text primary key,
        fingerprint text,
        intent_key text,
        file_path text,
        decision text not null,
        resolution text,
        resolution_guidance text,
        resolution_payload_json text,
        summary text not null,
        question text,
        created_at text not null,
        resolved_at text,
        user_name text not null,
        hostname text not null,
        agent_name text not null,
        agent_kind text not null,
        event_name text not null,
        tool_name text,
        project_path text,
        payload_json text not null,
        triggered_policies_json text not null
      );

      create index if not exists evaluations_created_at_idx on evaluations(created_at desc);
      create index if not exists evaluations_fingerprint_idx on evaluations(fingerprint);
      create index if not exists evaluations_agent_idx on evaluations(agent_kind, hostname, created_at desc);

      create table if not exists mcp_servers (
        id text primary key,
        server_name text not null,
        first_seen_at text not null,
        last_seen_at text not null,
        tool_count integer not null default 0,
        call_count integer not null default 0,
        metadata_json text not null default '{}'
      );

      create table if not exists mcp_tool_calls (
        id text primary key,
        mcp_server_id text not null,
        evaluation_id text not null,
        server_name text not null,
        tool_name text not null,
        full_tool_name text not null,
        arguments_json text not null,
        argument_summary text not null,
        project_path text,
        session_id text not null,
        decision text not null,
        resolution text,
        risk_level text not null,
        occurred_at text not null,
        agent_name text not null,
        agent_kind text not null,
        hostname text not null,
        user_name text not null
      );

      create index if not exists mcp_servers_last_seen_idx on mcp_servers(last_seen_at desc);
      create index if not exists mcp_tool_calls_server_idx on mcp_tool_calls(mcp_server_id, occurred_at desc);
      create index if not exists mcp_tool_calls_user_idx on mcp_tool_calls(user_name, occurred_at desc);

      create table if not exists skills (
        id text primary key,
        agent_kind text not null,
        agent_name text not null,
        scope text not null,
        project_path text,
        skill_name text not null,
        skill_path text not null unique,
        status text not null,
        risk_score integer not null default 0,
        reasons_json text not null default '[]',
        content_hash text not null,
        content text,
        content_preview text,
        purpose_summary text,
        content_updated_at text,
        first_seen_at text not null,
        last_seen_at text not null,
        updated_at text not null
      );

      create index if not exists skills_agent_idx on skills(agent_kind, status, updated_at desc);
      create index if not exists skills_project_idx on skills(project_path, updated_at desc);
    `);
    this.addColumnIfMissing("evaluations", "intent_key", "text");
    this.addColumnIfMissing("evaluations", "file_path", "text");
    this.addColumnIfMissing("evaluations", "resolution", "text");
    this.addColumnIfMissing("evaluations", "resolution_guidance", "text");
    this.addColumnIfMissing("evaluations", "resolution_payload_json", "text");
    this.addColumnIfMissing("policies", "locked", "integer not null default 0");
    this.addColumnIfMissing("skills", "content", "text");
    this.addColumnIfMissing("skills", "content_preview", "text");
    this.addColumnIfMissing("skills", "purpose_summary", "text");
    this.addColumnIfMissing("skills", "content_updated_at", "text");
    this.db.prepare("create index if not exists evaluations_intent_key_idx on evaluations(intent_key)").run();
    this.recordLocalSchemaMigration("0001_desktop_local_schema", "inline-local-server-migrate-schema-v1");
    this.recordLocalSchemaMigration(
      "0002_agent_interaction_responses",
      "evaluations-resolution-payload-json-v1",
    );
  }

  private recordLocalSchemaMigration(id: string, checksum: string) {
    this.db.prepare(`
      insert into schema_migrations (id, checksum, applied_at)
      values (?, ?, ?)
      on conflict(id) do nothing
    `).run(id, checksum, new Date().toISOString());
  }

  private readSkills(): SkillRecord[] {
    const rows = this.db.prepare("select * from skills where status <> 'deleted' order by datetime(updated_at) desc limit 500").all() as Array<{
      id: string;
      agent_kind: string;
      agent_name: string;
      scope: "user" | "project";
      project_path: string | null;
      skill_name: string;
      skill_path: string;
      status: "observed" | "approved" | "suspicious" | "deleted";
      risk_score: number;
      reasons_json: string;
      content_hash: string;
      content?: string | null;
      content_preview?: string | null;
      purpose_summary?: string | null;
      content_updated_at?: string | null;
      first_seen_at: string;
      last_seen_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      ...row,
      reasons: parseJson<SkillRecord["reasons"]>(row.reasons_json, [])
    }));
  }

  private markSkillDeleted(skillPath: string) {
    this.db.prepare("update skills set status = 'deleted', updated_at = ? where skill_path = ?").run(new Date().toISOString(), skillPath);
  }

  private markSkillApproved(skillPath: string) {
    this.db.prepare("update skills set status = 'approved', updated_at = ? where skill_path = ?").run(new Date().toISOString(), skillPath);
  }

  private migrateLegacyJsonStore() {
    if (this.getSetting("jsonMigrated") === "true") return;
    if (!fs.existsSync(this.legacyStorePath)) {
      this.setSetting("jsonMigrated", "true");
      return;
    }
    const hasData = Number((this.db.prepare("select count(*) as count from policies").get() as { count: number }).count) > 0 ||
      Number((this.db.prepare("select count(*) as count from evaluations").get() as { count: number }).count) > 0;
    if (hasData) {
      this.setSetting("jsonMigrated", "true");
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.legacyStorePath, "utf8")) as Store;
      const parsedClientMode = parsed.clientMode === "custom" ? "custom" : "cloud";
      this.store = {
        token: parsed.token || `ol_personal_${crypto.randomBytes(18).toString("base64url")}`,
        setupComplete: parsedClientMode === "cloud" || parsedClientMode === "custom"
          ? Boolean(parsed.setupComplete && parsed.remoteToken)
          : Boolean(parsed.setupComplete),
        installIdentity: parsed.installIdentity,
        deviceIdentity: parsed.deviceIdentity,
        clientMode: parsedClientMode,
        agentDoneSound: Boolean(parsed.agentDoneSound),
        islandVisibility: normalizeIslandVisibility(
          parsed.islandVisibility,
          Boolean(parsed.islandActivityOnly),
        ),
        excludedProjectPaths: normalizeExcludedProjectPaths(parsed.excludedProjectPaths),
        remoteApiUrl: parsed.remoteApiUrl,
        remoteToken: parsed.remoteToken,
        remoteOrganization: parsed.remoteOrganization,
        remoteUser: parsed.remoteUser,
        apiProvider: parsed.apiProvider,
        apiKey: parsed.apiKey,
        promptTransforms: normalizePromptTransformConfig(parsed.promptTransforms),
        plugins: bundledPluginCatalog(),
        policies: parsed.policies?.length ? parsed.policies : defaultPolicies(),
        history: Array.isArray(parsed.history) ? parsed.history : []
      };
      this.writeStore();
    } catch {
      this.setSetting("jsonMigrated", "true");
      return;
    }
    this.setSetting("jsonMigrated", "true");
  }

  private readPolicies(): Policy[] {
    const rows = this.db.prepare("select * from policies order by sort_order asc, name asc").all() as Array<{
      id: string;
      name: string;
      category: string;
      description: string;
      enabled: number;
      locked?: number;
      match_json: string | null;
      pattern: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      description: row.description,
      enabled: Boolean(row.enabled),
      locked: Boolean(row.locked),
      match: parseStringArray(row.match_json),
      pattern: row.pattern ?? undefined
    }));
  }

  private readHistory(): Evaluation[] {
    const rows = this.db.prepare("select * from evaluations order by datetime(created_at) desc limit 500").all() as Array<{
      id: string;
      fingerprint: string | null;
      intent_key?: string | null;
      file_path?: string | null;
      decision: "allow" | "ask" | "deny";
      resolution: "allow" | "deny" | null;
      resolution_guidance?: string | null;
      resolution_payload_json?: string | null;
      summary: string;
      question: string | null;
      created_at: string;
      resolved_at: string | null;
      user_name: string;
      hostname: string;
      agent_name: string;
      agent_kind: string;
      event_name: string;
      tool_name: string | null;
      project_path: string | null;
      payload_json: string;
      triggered_policies_json: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      fingerprint: row.fingerprint ?? undefined,
      intentKey: row.intent_key ?? row.fingerprint ?? undefined,
      file_path: row.file_path ?? undefined,
      decision: row.decision,
      resolution: row.resolution,
      resolution_guidance: row.resolution_guidance ?? null,
      resolution_payload: row.resolution_payload_json
        ? parseJson<Record<string, unknown> | null>(row.resolution_payload_json, null)
        : null,
      summary: row.summary,
      question: row.question ?? undefined,
      created_at: row.created_at,
      resolved_at: row.resolved_at ?? undefined,
      user_name: row.user_name,
      hostname: row.hostname,
      agent_name: row.agent_name,
      agent_kind: row.agent_kind,
      event_name: row.event_name,
      tool_name: row.tool_name ?? undefined,
      project_path: row.project_path ?? undefined,
      payload: parseJson<EvaluationRequest["event"]>(row.payload_json, {
        eventName: row.event_name,
        agentKind: row.agent_kind,
        sessionId: "unknown",
        occurredAt: row.created_at
      }),
      triggered_policies: parseJson<Evaluation["triggered_policies"]>(row.triggered_policies_json, [])
    }));
  }

  private getSetting(key: string) {
    const row = this.db.prepare("select value from settings where key = ?").get(key) as { value?: string } | undefined;
    return row?.value;
  }

  private settingValue<T extends string = string>(key: string) {
    const value = this.getSetting(key);
    return value ? value as T : undefined;
  }

  private setSetting(key: string, value: string) {
    this.db.prepare("insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
  }

  private addColumnIfMissing(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) return;
    this.db.prepare(`alter table ${table} add column ${column} ${definition}`).run();
  }

  private get dbPath() {
    return path.join(this.dir, "personal.sqlite");
  }

  private get legacyStorePath() {
    return path.join(this.dir, "personal-store.json");
  }
}

function evaluatePolicy(policy: Policy, request: EvaluationRequest): PolicyResult {
  const text = eventText(request).toLowerCase();
  const evidence = findEvidence(policy.id, text, request);
  const importedEvidence = evidence.length > 0 ? evidence : findImportedEvidence(policy, text, request);
  return {
    policyId: policy.id,
    policyName: policy.name,
    status: importedEvidence.length > 0 ? "failed" : "passed",
    severity: "medium",
    explanation: importedEvidence.length > 0 ? "The requested local agent action matches this rule." : "No matching risk was found.",
    evidence: importedEvidence
  };
}

function findEvidence(policyId: string, text: string, request: EvaluationRequest) {
  const prompt = request.event.prompt || JSON.stringify(request.event.tool?.input ?? "");
  if (policyId === "credentials") return credentialEvidence(text, request, prompt);
  if (policyId === "filesystem-destruction" && /(rm\s+-rf\s+(?:\/(?=$|[\s"'`;,)])|\.(?=$|[\s"'`;,)])|\.\/|\*|\$PWD|\$HOME|~|[^\n]*(?:project|workspace))|sudo\s+rm\s+-rf|delete\s+(?:the\s+)?(?:project|workspace|repo|repository)\s+directory|format\s+(?:disk|drive|volume))/i.test(text)) return [truncate(prompt, 160)];
  if (policyId === "database-destruction" && /\b(drop\s+(?:database|schema|table)|truncate\s+(?:table\s+)?[a-z0-9_."`-]+|delete\s+from\s+[a-z0-9_."`-]+\s*(?:;|$))/i.test(text)) return [truncate(prompt, 160)];
  if (policyId === "database-mass-update" && /\bupdate\s+[a-z0-9_."`-]+\s+set\b(?![\s\S]{0,220}\bwhere\b)/i.test(text)) return [truncate(prompt, 160)];
  if (policyId === "cloud-resource-deletion" && /(aws\s+(?:s3\s+rb|s3\s+rm|ec2\s+terminate|route53\s+delete|cloudformation\s+delete-stack)|gcloud\s+(?:projects\s+delete|compute\s+instances\s+delete|dns\s+managed-zones\s+delete|container\s+clusters\s+delete)|az\s+(?:group\s+delete|vm\s+delete|storage\s+account\s+delete)|delete\s+(?:s3\s+bucket|gcp\s+project|kubernetes\s+namespace|vm|dns\s+zone|hosted\s+zone))/i.test(text)) return [truncate(prompt, 160)];
  if (policyId === "infra-destruction" && /(terraform\s+(?:destroy|apply\s+-destroy)|tofu\s+(?:destroy|apply\s+-destroy)|kubectl\s+delete\s+(?:namespace|ns|clusterrole|crd|deployment|service)\b|helm\s+uninstall\b|helm\s+delete\b)/i.test(text)) return [truncate(prompt, 160)];
  if (policyId === "protected-branch-push" && protectedBranchPushPattern().test(text)) return [truncate(prompt, 160)];
  if (policyId === "committing-secrets" && committingSecretsPattern().test(text)) return [truncate(prompt, 160)];
  if (policyId === "git-publish" && !protectedBranchPushPattern().test(text) && !committingSecretsPattern().test(text) && /\b(git\s+push|git\s+commit|gh\s+repo\s+sync|gh\s+release\s+upload)\b/i.test(text)) return [truncate(prompt, 160)];
  if (policyId === "git-history-rewrite" && /(git\s+push\b[^\n]*(?:--force|-f|--mirror)|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*[fdx]|git\s+rebase\s+(?:-i|--interactive)|git\s+filter-branch|git\s+replace\b)/i.test(text)) return [truncate(prompt, 160)];
  if (policyId === "global-package-install" && globalPackageInstallPattern().test(text)) return [truncate(prompt, 160)];
  if (policyId === "supply-chain-change" && !globalPackageInstallPattern().test(text) && /(npm\s+(?:install|i|add|update)|pnpm\s+(?:add|install|update)|yarn\s+(?:add|install|upgrade)|pip\s+install|poetry\s+add|uv\s+add|cargo\s+(?:add|update)|go\s+get|bundle\s+(?:add|update)|brew\s+install|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|poetry\.lock|cargo\.lock|go\.sum|\.csproj)/i.test(text)) return [truncate(prompt, 160)];
  if (policyId === "exfiltration" && /(curl|wget|upload|pastebin|gist|webhook|scp\s|rsync\s|nc\s|netcat|send .*code|send .*file|post .*secret|external domain|https?:\/\/(?!localhost|127\.0\.0\.1))/i.test(text)) return [truncate(prompt, 160)];
  if (policyId === "personal-data" && /(ssn|social security|passport|credit card|personal data|customer list|employee data)/i.test(text)) return [truncate(prompt, 160)];
  if (policyId === "destructive" && /(rm\s+-[a-z]*r[a-z]*|sudo rm|find\b.+(?:^|\s)-delete\b|shutil\.rmtree|(?:fs\.)?(?:rmSync|rm)\s*\([^)]*recursive\s*:\s*true|FileUtils\.rm_rf|Remove-Item[^\n;&|]*(?:^|\s)-Recurse|truncate\s+(?:-[^\s]+\s+)*0\s+|dd\b[^\n;&|]*if=\/dev\/zero\b[^\n;&|]*of=|delete all|format disk|chmod\s+-r|chown\s+-r|git reset\s+--hard|git clean\s+(?=[^\n;&]*-[a-z]*f)|git\s+(?:checkout\s+--|restore)\s+\.(?=$|[\s"';&|])|terraform destroy)/im.test(text)) return [truncate(prompt, 160)];
  if (policyId === "git-repo" && /(git init|gh repo create|create (a )?(new )?git repo|initialize (a )?(new )?repository)/i.test(text)) return [truncate(prompt, 160)];
  if (policyId === "package-install" && /(npm install|pip install|brew install|curl .* sh|unknown package)/i.test(text)) return [truncate(prompt, 160)];
  return [];
}

function protectedBranchPushPattern() {
  return /\bgit\s+push\b[^\n]*(?:(?:origin|upstream)\s+(?:HEAD:)?(?:refs\/heads\/)?(?:main|master|trunk|production|prod|release)|(?:HEAD:|refs\/heads\/)(?:main|master|trunk|production|prod|release)|\b(?:main|master|trunk|production|prod|release)\b)/i;
}

function committingSecretsPattern() {
  return /(?:git\s+commit|commit(?:ting)?\s+(?:staged\s+)?(?:changes|files|content))[\s\S]{0,900}(?:\.env|id_rsa|id_ed25519|private key|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|aws_access_key_id|aws_secret_access_key|ghp_[a-z0-9_]+|sk-[a-z0-9_-]{12,}|-----begin [a-z ]*private key-----)|(?:\.env|id_rsa|id_ed25519|private key|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|aws_access_key_id|aws_secret_access_key|ghp_[a-z0-9_]+|sk-[a-z0-9_-]{12,})[\s\S]{0,900}(?:git\s+commit|commit(?:ting)?\s+(?:staged\s+)?(?:changes|files|content))/i;
}

function globalPackageInstallPattern() {
  return /\b(?:npm|pnpm|yarn)\s+(?:install|i|add)\b[^\n]*(?:\s-g\b|\s--global\b)|\byarn\s+global\s+add\b|\bpip(?:3)?\s+install\b[^\n]*(?:\s--user\b|\s--prefix\b|\s--target\b|\s--break-system-packages\b)|\bgem\s+install\b|\bcargo\s+install\b|\bgo\s+install\s+[^\s]+@/i;
}

function credentialEvidence(text: string, request: EvaluationRequest, prompt: string) {
  const inputText = JSON.stringify(request.event.tool?.input ?? "").toLowerCase();
  const toolName = (request.event.tool?.name ?? "").toLowerCase();
  const touchesCredentialStore = /(\.env(?:\b|["'\\/\s])|\.npmrc|id_rsa|id_ed25519|credentials|kubeconfig|private key|api[_ -]?key|secret|token|password)/i.test(text);
  if (!touchesCredentialStore) return [];

  const readsCredentialStore =
    /(^|[^a-z])(read|cat|open|print|show|display|dump|list|grep|scan|parse|copy)([^a-z]|$)/i.test(`${toolName} ${text}`) ||
    ["read", "grep", "cat"].some((name) => toolName.includes(name));
  const sendsCredentialStore =
    /(curl|wget|upload|post|webhook|pastebin|gist|send|exfiltrat|external|remote|slack|discord|email)/i.test(text);
  if (readsCredentialStore || sendsCredentialStore) return [truncate(prompt, 160)];

  const writesCredentialStore =
    /(^|[^a-z])(write|create|add|generate|save|put|touch)([^a-z]|$)/i.test(`${toolName} ${text}`) ||
    ["write", "edit", "multiedit"].some((name) => toolName.includes(name));
  const clearlyFake =
    /(fake|dummy|sample|example|placeholder|random|test|mock|local dev|development only)/i.test(text) ||
    /(fake|dummy|sample|example|placeholder|random|test|mock)/i.test(inputText);
  if (writesCredentialStore && clearlyFake) return [];

  return [truncate(prompt, 160)];
}

function findImportedEvidence(policy: Policy, text: string, request: EvaluationRequest) {
  const prompt = request.event.prompt || JSON.stringify(request.event.tool?.input ?? "");
  const matches = (policy.match ?? []).filter(Boolean);
  if (matches.some((needle) => text.includes(needle.toLowerCase()))) return [truncate(prompt, 160)];
  if (!policy.pattern) return [];
  try {
    return new RegExp(policy.pattern, "i").test(text) ? [truncate(prompt, 160)] : [];
  } catch {
    return [];
  }
}

function eventText(request: EvaluationRequest) {
  return [
    request.event.prompt,
    request.event.tool?.name,
    JSON.stringify(request.event.tool?.input ?? ""),
    JSON.stringify(request.event.raw ?? "")
  ].filter(Boolean).join("\n");
}

function extractFilePathLocally(request: EvaluationRequest, failed: PolicyResult[]) {
  const direct = directPathFromToolInput(request.event.tool?.input);
  if (direct) return normalizeDisplayPath(direct, request.event.projectPath);

  const rawText = [
    request.event.prompt,
    request.event.tool?.name,
    JSON.stringify(request.event.tool?.input ?? ""),
    JSON.stringify(request.event.raw ?? ""),
    ...failed.flatMap((result) => result.evidence)
  ].filter(Boolean).join("\n");

  const jsonPath = rawText.match(/"file_path"\s*:\s*"([^"]+)"/i)?.[1] ??
    rawText.match(/"path"\s*:\s*"([^"]+)"/i)?.[1];
  if (jsonPath) return normalizeDisplayPath(jsonPath, request.event.projectPath);

  const absolute = rawText.match(/(?:^|[\s"'`])((?:~|\/Users\/|\/private\/|\/tmp\/|\/var\/|\/etc\/|\/opt\/)[^\s"'`,;)]{2,})/i)?.[1];
  if (absolute) return normalizeDisplayPath(absolute, request.event.projectPath);

  const relative = rawText.match(/(?:^|[\s"'`])((?:\.{1,2}\/)?[A-Za-z0-9_.-]*\.env(?:\.[A-Za-z0-9_.-]+)?|(?:\.{1,2}\/)?[A-Za-z0-9_./-]+\/(?:\.env|\.npmrc|id_rsa|id_ed25519|credentials|kubeconfig))(?:$|[\s"'`,;)])/i)?.[1];
  if (relative) return normalizeDisplayPath(relative, request.event.projectPath);

  if (/\.env(?:\b|["'\\/\s])/.test(rawText)) return normalizeDisplayPath(".env", request.event.projectPath);
  return undefined;
}

async function extractFilePathWithOpenAI(request: EvaluationRequest, failed: PolicyResult[], apiKey: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const text = truncate([
      request.event.prompt,
      request.event.tool?.name,
      JSON.stringify(request.event.tool?.input ?? {}),
      ...failed.flatMap((result) => result.evidence)
    ].filter(Boolean).join("\n"), 1800);
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.OPENLEASH_PATH_EXTRACT_MODEL ?? "gpt-4.1-nano",
        input: [
          {
            role: "system",
            content: "Extract one local file path from the text. Return only compact JSON: {\"path\":\"...\"}. If no path exists, return {\"path\":null}. Do not explain."
          },
          {
            role: "user",
            content: text
          }
        ],
        temperature: 0,
        max_output_tokens: 60
      })
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const output = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("") ?? "";
    const parsed = JSON.parse(output) as { path?: unknown };
    return typeof parsed.path === "string" && parsed.path.trim()
      ? normalizeDisplayPath(parsed.path, request.event.projectPath)
      : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function summarizeActionPurposeWithOpenAI(request: EvaluationRequest, apiKey: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.OPENLEASH_ACTION_PURPOSE_MODEL ?? "gpt-4.1-nano",
        input: [
          {
            role: "system",
            content: "Summarize why the AI agent is likely taking the current action. Use one short plain-English sentence under 22 words. Do not mention policy, approval, Leash, or safety."
          },
          {
            role: "user",
            content: JSON.stringify({
              agent: request.agent.displayName,
              event: request.event.eventName,
              tool: request.event.tool?.name,
              toolInput: request.event.tool?.input,
              prompt: request.event.prompt,
              recentTranscript: request.event.transcript?.slice(-Math.max(1, ACTION_PURPOSE_CONTEXT_MESSAGES)) ?? []
            })
          }
        ],
        temperature: 0,
        max_output_tokens: 80
      })
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const output = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("") ?? "";
    return output.trim().replace(/^["']|["']$/g, "") || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function heuristicActionPurpose(request: EvaluationRequest) {
  const latestUser = request.event.transcript
    ?.slice(-Math.max(1, ACTION_PURPOSE_CONTEXT_MESSAGES))
    .reverse()
    .find((turn) => turn.role === "user" && turn.content.trim())?.content;
  const prompt = request.event.prompt || latestUser;
  const action = request.event.tool?.name
    ? `use ${request.event.tool.name}`
    : request.event.eventName === "UserPromptSubmit"
      ? "answer the latest prompt"
      : "continue the current task";
  if (prompt) return `It appears to ${action} for: ${truncate(prompt.replace(/\s+/g, " "), 90)}`;
  return `It appears to ${action} in the current session.`;
}

function directPathFromToolInput(input: unknown) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "filename", "filepath"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  const command = typeof record.command === "string" ? record.command : "";
  return command.match(/(?:^|[\s"'`])((?:~|\/Users\/|\/tmp\/|\/etc\/|\.{1,2}\/)?[A-Za-z0-9_./-]*\.env(?:\.[A-Za-z0-9_.-]+)?)(?:$|[\s"'`,;)])/)?.[1];
}

function normalizeDisplayPath(filePath: string, projectPath?: string) {
  let cleaned = filePath.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (!cleaned || cleaned === "undefined" || cleaned === "null") return undefined;
  cleaned = cleaned.replace(/^file:\/\//, "");
  if (cleaned === ".env" && projectPath) return path.join(projectPath, ".env");
  if (cleaned.startsWith("~/")) return path.join(os.homedir(), cleaned.slice(2));
  if (!path.isAbsolute(cleaned) && projectPath && !cleaned.includes("://")) return path.join(projectPath, cleaned);
  return cleaned;
}

function isUsefulPath(value: string) {
  return path.isAbsolute(value) || value.includes("/") || /\.[A-Za-z0-9_-]+$/.test(value);
}

function triggerFingerprint(request: EvaluationRequest, failed: PolicyResult[], summary: string) {
  const policyIds = failed.map((result) => result.policyId).sort().join(",");
  return [
    request.agent.kind,
    request.event.sessionId,
    request.event.projectPath ?? "",
    intentSignature(request),
    policyIds,
    summary
  ].join("|");
}

function triggerIntentKey(request: EvaluationRequest) {
  const category = intentCategory(request);
  if (!category) return undefined;
  if (category.startsWith("credential-")) {
    return [
      request.agent.kind,
      request.event.projectPath ?? "",
      category,
      primaryResource(request)
    ].join("|");
  }
  return [
    request.agent.kind,
    request.event.sessionId,
    request.event.projectPath ?? "",
    category,
    primaryResource(request)
  ].join("|");
}

function canonicalIntentKey(intentKey?: string | null) {
  if (!intentKey) return undefined;
  const parts = intentKey.split("|");
  if (parts.length === 4 && parts[2]?.startsWith("credential-")) {
    return [parts[0], parts[1], "credential", parts[3]].join("|");
  }
  if (parts.length === 5 && parts[3]?.startsWith("credential-")) {
    return [parts[0], parts[2], "credential", parts[4]].join("|");
  }
  return intentKey;
}

function dedupePendingEvaluations(items: Evaluation[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = canonicalIntentKey(item.intentKey) ?? [
      item.agent_kind,
      item.project_path ?? "",
      item.tool_name ?? item.event_name,
      item.summary,
      item.file_path ?? ""
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function intentSignature(request: EvaluationRequest) {
  const category = intentCategory(request);
  if (category) return [category, primaryResource(request)].join(":");
  const text = eventText(request).toLowerCase();
  const toolName = (request.event.tool?.name ?? request.event.eventName ?? "").toLowerCase();
  const resource = primaryResource(request);
  const credentialVerb = credentialActionVerb(toolName, text);
  return [request.event.eventName, toolName, credentialVerb, resource].filter(Boolean).join(":");
}

function intentCategory(request: EvaluationRequest) {
  const text = eventText(request).toLowerCase();
  if (/(git init|gh repo create|create (a )?(new )?git repo|initialize (a )?(new )?repository)/i.test(text)) return "git-repo";
  if (/(\.env(?:\b|["'\\/\s])|\.npmrc|id_rsa|id_ed25519|credentials|kubeconfig|private key|api[_ -]?key|secret|token|password)/i.test(text)) {
    return `credential-${credentialActionVerb((request.event.tool?.name ?? "").toLowerCase(), text)}`;
  }
  if (/(rm\s+-[a-z]*r[a-z]*|sudo rm|find\b.+(?:^|\s)-delete\b|shutil\.rmtree|(?:fs\.)?(?:rmSync|rm)\s*\([^)]*recursive\s*:\s*true|FileUtils\.rm_rf|Remove-Item[^\n;&|]*(?:^|\s)-Recurse|truncate\s+(?:-[^\s]+\s+)*0\s+|dd\b[^\n;&|]*if=\/dev\/zero\b[^\n;&|]*of=|delete all|format disk|chmod\s+-r|chown\s+-r|git reset\s+--hard|git clean\s+(?=[^\n;&]*-[a-z]*f)|git\s+(?:checkout\s+--|restore)\s+\.(?=$|[\s"';&|])|terraform destroy)/im.test(text)) return "destructive";
  if (/(curl|wget|upload|pastebin|gist|send .*code|post .*secret|external domain|webhook)/i.test(text)) return "exfiltration";
  if (/(ssn|social security|passport|credit card|personal data|customer list|employee data)/i.test(text)) return "personal-data";
  if (/(npm install|pip install|brew install|curl .* sh|unknown package)/i.test(text)) return "package-install";
  return undefined;
}

function credentialActionVerb(toolName: string, text: string) {
  if (/(curl|wget|upload|post|webhook|pastebin|gist|send|exfiltrat|external|remote)/i.test(text)) return "send";
  if (/read|cat|open|print|show|display|dump|list|grep|scan|parse|copy/i.test(`${toolName} ${text}`)) return "read";
  if (/write|create|add|generate|save|put|touch|edit|multiedit/i.test(`${toolName} ${text}`)) return "write";
  return "other";
}

function stableHookSessionId(agent: string, raw: any) {
  const projectPath = raw?.cwd ?? raw?.workspace ?? raw?.project_dir ?? raw?.context?.workspaceDir ?? process.cwd();
  const seed = [
    agent,
    projectPath,
    raw?.pid ?? "",
    raw?.process_id ?? "",
    raw?.terminal_id ?? "",
    raw?.conversation_id ?? ""
  ].join("|");
  return `${agent}-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function primaryResource(request: EvaluationRequest) {
  const input = request.event.tool?.input;
  const values: string[] = [];
  if (typeof input === "string") values.push(input);
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["file_path", "path", "command", "url"]) {
      if (typeof record[key] === "string") values.push(record[key]);
    }
  }
  const text = values.join(" ") || eventText(request);
  if (/\.env(?:\b|["'\\/\s])/.test(text)) return ".env";
  const match = text.match(/(?:^|[/"'\s])([A-Za-z0-9._-]*(?:credentials|kubeconfig|id_rsa|id_ed25519|\.npmrc)[A-Za-z0-9._-]*)/i);
  return match?.[1] ? truncate(match[1], 80) : "unknown-resource";
}

function summarizeBlockedAction(request: EvaluationRequest, policyName: string) {
  const agent = request.agent.displayName;
  const policy = policyName.toLowerCase();
  if (policy.includes("filesystem")) return `${agent} is trying to delete local files or a workspace.`;
  if (policy.includes("database") && policy.includes("mass")) return `${agent} is trying to mutate many database rows without a filter.`;
  if (policy.includes("database")) return `${agent} is trying to drop, truncate, or delete database data.`;
  if (policy.includes("cloud")) return `${agent} is trying to delete cloud resources.`;
  if (policy.includes("terraform") || policy.includes("kubernetes") || policy.includes("infra")) return `${agent} is trying to run destructive infrastructure changes.`;
  if (policy.includes("publish") || policy.includes("push")) return `${agent} is trying to commit or push code.`;
  if (policy.includes("protected branch")) return `${agent} is trying to push directly to a protected branch.`;
  if (policy.includes("history")) return `${agent} is trying to rewrite Git history or discard work.`;
  if (policy.includes("committing secrets")) return `${agent} is trying to commit sensitive credentials.`;
  if (policy.includes("dependency") || policy.includes("supply")) return `${agent} is trying to change dependencies or lockfiles.`;
  if (policy.includes("global package")) return `${agent} is trying to install a global package.`;
  if (policy.includes("credential")) return `${agent} is trying to access or create sensitive file content.`;
  if (policy.includes("destructive")) return `${agent} is trying to run a potentially destructive command.`;
  if (policy.includes("git repo")) return `${agent} is trying to create a new Git repository.`;
  if (policy.includes("external")) return `${agent} is trying to share code or data outside this workspace.`;
  if (policy.includes("personal")) return `${agent} is trying to use personal or sensitive data.`;
  if (policy.includes("package")) return `${agent} is trying to install or run a package.`;
  return `${agent} is trying to continue with an action Leash paused.`;
}

function summarizeAllowedAction(request: EvaluationRequest, filePath?: string) {
  const toolName = request.event.tool?.name || "";
  if (/^(Write|MultiEdit)$/i.test(toolName)) return `Editing ${filePath || primaryResource(request)}`;
  if (/^Read$/i.test(toolName)) return `Reading ${filePath || primaryResource(request)}`;
  if (toolName) return `${humanizeToolName(toolName)}${filePath ? ` ${filePath}` : ""}`;
  return "All active policies passed.";
}

function isPassOnlyEvaluation(item: Pick<Evaluation, "decision" | "resolution" | "summary" | "tool_name" | "triggered_policies">) {
  return item.decision === "allow"
    && (!item.resolution || item.resolution === "allow")
    && !item.tool_name
    && item.triggered_policies.length === 0
    && /all active policies passed/i.test(item.summary);
}

function shouldDeferPromptOnlyApproval(request: EvaluationRequest, results: PolicyResult[]) {
  if (!isPromptOnlyHook(request)) return false;
  return results.some((result) => result.status === "failed" || result.status === "needs_question");
}

function hasSensitivePromptOnlyFinding(request: EvaluationRequest, results: PolicyResult[]) {
  if (!isPromptOnlyHook(request)) return false;
  const text = eventText(request).toLowerCase();
  const sensitiveIntent = /(\.env|env(?:ironment)?\s+file|dotenv|secret|credential|private key|api[_ -]?key|token|password|kubeconfig|\.npmrc|id_rsa|id_ed25519)/i.test(text) &&
    /\b(read|print|show|display|dump|open|inspect|cat|copy|expose|summarize)\b/i.test(text);
  if (!sensitiveIntent) return false;
  return results.some((result) =>
    result.status === "failed" &&
    /(credential|secret|token|\.env|private key|kubeconfig|npmrc)/i.test(`${result.policyName} ${result.explanation}`)
  );
}

function isPromptOnlyHook(request: EvaluationRequest) {
  return request.event.eventName === "UserPromptSubmit" && !request.event.tool?.name;
}

function isNonActionableHookEvent(eventName: string) {
  return ["PostToolUse", "Stop", "SessionStart", "SessionEnd", "SubagentStart", "SubagentStop", "Notification"].includes(eventName);
}

function agentInteractionForRequest(request: EvaluationRequest) {
  if (request.event.eventName !== "PreToolUse") return undefined;
  const toolName = String(request.event.tool?.name ?? "").toLowerCase();
  const input = request.event.tool?.input;
  if (toolName === "askuserquestion") {
    const record = input && typeof input === "object" && !Array.isArray(input)
      ? input as { questions?: unknown }
      : undefined;
    const first = Array.isArray(record?.questions)
      ? record.questions.find((item) => item && typeof item === "object") as { question?: unknown } | undefined
      : undefined;
    const firstQuestion = typeof first?.question === "string" ? first.question.trim() : "";
    return {
      summary: firstQuestion || `${request.agent.displayName} has a question for you.`,
      question: "Answer in Leash to continue the agent.",
      purpose: `${request.agent.displayName} is waiting for your input.`
    };
  }
  if (toolName === "exitplanmode") {
    return {
      summary: `${request.agent.displayName} finished a plan and is waiting for review.`,
      question: "Approve the plan, or deny it with feedback.",
      purpose: "Review the proposed plan before the agent starts making changes."
    };
  }
  return undefined;
}

function deferPromptOnlyPolicyResults(results: PolicyResult[]): PolicyResult[] {
  return results.map((result) => result.status === "passed"
    ? result
    : {
        ...result,
        status: "passed",
        explanation: "Prompt-only intent observed. Enforcement is deferred until the agent attempts the actual tool action.",
        evidence: [],
        question: undefined
      });
}

function humanizeToolName(toolName: string) {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function sessionTitle(items: Evaluation[]) {
  const prompt = items
    .map((item) => item.payload?.prompt || item.summary)
    .find((value) => typeof value === "string" && value.trim() && !/all active policies passed/i.test(value));
  if (prompt) return truncate(String(prompt).replace(/\s+/g, " "), 56);
  const tools = [...new Set(items.map((item) => item.tool_name).filter(Boolean))];
  if (tools.length > 0) return `Used ${tools.slice(0, 2).join(", ")}`;
  return "Agent session";
}

function sessionSummary(items: Evaluation[]) {
  const approvals = items.filter((item) => item.decision === "ask").length;
  const denied = items.filter((item) => item.decision === "deny" || item.resolution === "deny").length;
  const tools = [...new Set(items.map((item) => item.tool_name).filter(Boolean))].slice(0, 3);
  const parts = [
    `${items.length} event${items.length === 1 ? "" : "s"}`,
    approvals ? `${approvals} approval${approvals === 1 ? "" : "s"}` : "",
    denied ? `${denied} denied` : "",
    tools.length ? `tools: ${tools.join(", ")}` : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function subagentStats(items: Evaluation[]) {
  const starts = new Map<string, number[]>();
  let seconds = 0;
  let count = 0;
  const sorted = items.slice().sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  for (const item of sorted) {
    const id = subagentId(item);
    if (!id) continue;
    const at = new Date(item.created_at).getTime();
    if (Number.isNaN(at)) continue;
    if (item.event_name === "SubagentStart") {
      const queue = starts.get(id) ?? [];
      queue.push(at);
      starts.set(id, queue);
    } else if (item.event_name === "SubagentStop") {
      const queue = starts.get(id) ?? [];
      const startedAt = queue.shift();
      if (startedAt !== undefined) {
        count += 1;
        seconds += Math.max(0, Math.round((at - startedAt) / 1000));
      }
      if (queue.length > 0) starts.set(id, queue);
      else starts.delete(id);
    }
  }
  return { count, seconds };
}

function subagentId(item: Evaluation) {
  const raw = item.payload?.raw && typeof item.payload.raw === "object" ? item.payload.raw as Record<string, unknown> : {};
  const value = raw.agent_id ?? raw.agentId ?? raw.subagent_id ?? raw.subagentId ?? raw.thread_id ?? raw.threadId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sessionMetrics(sessions: Array<{ last_activity_at: string; duration_seconds?: number; agent_kind?: string; agent_name?: string }>) {
  const now = Date.now();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const windows = {
    today: today.getTime(),
    last24h: now - 24 * 60 * 60 * 1000,
    week: now - 7 * 24 * 60 * 60 * 1000,
    month: now - 30 * 24 * 60 * 60 * 1000
  };
  const summarize = (cutoff: number) => {
    const scoped = sessions.filter((session) => new Date(session.last_activity_at).getTime() >= cutoff);
    return {
      session_count: scoped.length,
      duration_seconds: scoped.reduce((sum, session) => sum + Number(session.duration_seconds ?? 0), 0)
    };
  };
  const byAgent = new Map<string, { agent_kind: string; agent_name: string; session_count: number; duration_seconds: number }>();
  for (const session of sessions.filter((item) => new Date(item.last_activity_at).getTime() >= windows.last24h)) {
    const key = session.agent_kind || "unknown";
    const item = byAgent.get(key) ?? { agent_kind: key, agent_name: session.agent_name || key, session_count: 0, duration_seconds: 0 };
    item.session_count += 1;
    item.duration_seconds += Number(session.duration_seconds ?? 0);
    byAgent.set(key, item);
  }
  return {
    today: summarize(windows.today),
    last24h: summarize(windows.last24h),
    week: summarize(windows.week),
    month: summarize(windows.month),
    by_agent_24h: [...byAgent.values()].sort((a, b) => b.duration_seconds - a.duration_seconds)
  };
}

function defaultPolicies(): Policy[] {
  return [];
}

const generatedDefaultPolicyIds = new Set([
  "destructive", "git-repo", "package-install",
  "filesystem-destruction", "database-destruction", "database-mass-update",
  "cloud-resource-deletion", "infra-destruction", "git-publish",
  "protected-branch-push", "git-history-rewrite", "committing-secrets",
  "supply-chain-change", "global-package-install", "credentials",
  "exfiltration", "personal-data"
]);

export function migrateDefaultPolicies(existing: Policy[]) {
  return existing.filter((policy) => !generatedDefaultPolicyIds.has(policy.id));
}

export function normalizePolicies(input: unknown, existing: Policy[] = defaultPolicies(), replace = false): Policy[] {
  const raw = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray((input as { rules?: unknown[] }).rules)
      ? (input as { rules: unknown[] }).rules
      : input && typeof input === "object" && Array.isArray((input as { policies?: unknown[] }).policies)
        ? (input as { policies: unknown[] }).policies
        : [];
  const imported = raw.map(normalizePolicy).filter((policy): policy is Policy => Boolean(policy));
  const base = replace ? [] : existing;
  const byId = new Map(base.map((policy) => [policy.id, policy]));
  for (const policy of imported) byId.set(policy.id, { ...byId.get(policy.id), ...policy });
  return [...byId.values()];
}

function enforceLockedPolicies(policies: Policy[]) {
  return policies.map((policy) => policy.locked ? { ...policy, enabled: true } : policy);
}

function normalizePolicy(value: unknown): Policy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const name = stringValue(record.name ?? record.title);
  const id = stringValue(record.id) || slug(name);
  if (!id || !name) return undefined;
  const match = arrayOfStrings(record.match ?? record.matches ?? record.keywords);
  return {
    id,
    name,
    category: stringValue(record.category) || "Imported rules",
    description: stringValue(record.description ?? record.natural_language_rule ?? record.naturalLanguageRule) || "Imported local Leash rule.",
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    locked: Boolean(record.locked ?? record.mandatory ?? record.required),
    match: match.length > 0 ? match : undefined,
    pattern: stringValue(record.pattern ?? record.regex) || undefined
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function parseStringArray(value: string | null) {
  const parsed = parseJson<unknown[]>(value, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const MCP_TOOL_PATTERNS = [
  /^mcp__([A-Za-z0-9_.-]+)__(.+)$/i,
  /^mcp[:.]([A-Za-z0-9_.-]+)[:.](.+)$/i
];
const SECRET_ARGUMENT_KEY = /(api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|client[_-]?secret|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)/i;

function mcpToolCallFromEvaluation(evaluation: Evaluation) {
  const parsed = parseMcpToolName(evaluation.tool_name) ?? mcpToolCallFromRaw(evaluation.payload.raw);
  if (!parsed) return undefined;
  const args = redactMcpArguments(evaluation.payload.tool?.input ?? rawToolInput(evaluation.payload.raw) ?? {});
  return {
    ...parsed,
    arguments: args,
    argumentSummary: summarizeMcpArguments(args)
  };
}

function parseMcpToolName(toolName?: string) {
  const name = String(toolName ?? "").trim();
  if (!name) return undefined;
  for (const pattern of MCP_TOOL_PATTERNS) {
    const match = name.match(pattern);
    if (match?.[1] && match[2]) {
      return {
        serverName: match[1].trim().replace(/\s+/g, "-").slice(0, 160),
        toolName: match[2],
        fullToolName: name
      };
    }
  }
  return undefined;
}

function mcpToolCallFromRaw(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const tool = record.tool && typeof record.tool === "object" ? record.tool as Record<string, unknown> : undefined;
  const serverName = record.mcp_server ?? record.mcpServer ?? record.server_name ?? record.serverName ?? tool?.serverName;
  const toolName = record.tool_name ?? record.toolName ?? tool?.name;
  if (typeof serverName !== "string" || typeof toolName !== "string") return undefined;
  const normalizedServer = serverName.trim().replace(/\s+/g, "-").slice(0, 160);
  return {
    serverName: normalizedServer,
    toolName,
    fullToolName: parseMcpToolName(toolName)?.fullToolName ?? `mcp__${normalizedServer}__${toolName}`
  };
}

function rawToolInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const tool = record.tool && typeof record.tool === "object" ? record.tool as Record<string, unknown> : undefined;
  return record.tool_input ?? record.toolInput ?? tool?.input ?? record.input;
}

function redactMcpArguments(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactMcpArguments(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [
        key,
        SECRET_ARGUMENT_KEY.test(key) ? "[REDACTED]" : redactMcpArguments(item, depth + 1)
      ])
    );
  }
  if (typeof value === "string") return value.length > 800 ? `${value.slice(0, 800)}...` : value;
  return value;
}

function summarizeMcpArguments(value: unknown): string {
  if (!value || typeof value !== "object") return value === undefined ? "" : String(value).slice(0, 180);
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 4);
  if (entries.length === 0) return "No arguments";
  return entries.map(([key, item]) => `${key}: ${argumentValuePreview(item)}`).join(" · ").slice(0, 240);
}

function argumentValuePreview(value: unknown): string {
  if (value === "[REDACTED]") return "[REDACTED]";
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value.length > 54 ? `${value.slice(0, 54)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  return "{...}";
}

function skillPathFromEvaluation(item: Evaluation) {
  const raw = item.payload?.raw;
  if (!raw || typeof raw !== "object") return undefined;
  const skillPath = (raw as Record<string, unknown>).skillPath;
  return typeof skillPath === "string" ? skillPath : undefined;
}

function deleteSkillFile(skillPath: string) {
  try {
    const resolved = path.resolve(skillPath);
    const home = os.homedir();
    if (!resolved.endsWith("SKILL.md")) return;
    if (!resolved.startsWith(home) && !resolved.startsWith(process.cwd())) return;
    fs.rmSync(resolved, { force: true });
  } catch {
    // Best effort. The event remains recorded if deletion fails.
  }
}

function heuristicSkillPurpose(content: string, skillName: string) {
  const heading = content.match(/^#\s+(.+)$/m)?.[1] ?? content.match(/^description:\s*["']?(.+?)["']?\s*$/mi)?.[1];
  const source = heading || skillName.replace(/[-_]+/g, " ");
  return normalizeSkillPurpose(source, skillName) ?? titleCaseWords(skillName.replace(/[-_]+/g, " ").split(/\s+/).slice(0, 6).join(" "));
}

function normalizeSkillPurpose(value: string, fallback: string) {
  const cleaned = value.replace(/["'`]/g, "").replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length >= 4) return titleCaseWords(words.join(" "));
  const fallbackWords = fallback.replace(/[-_]+/g, " ").split(/\s+/).filter(Boolean).slice(0, 8);
  return fallbackWords.length ? titleCaseWords(fallbackWords.join(" ")) : undefined;
}

function titleCaseWords(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.length <= 3 ? word : word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function monitoringPausedDecision(pause: SessionMonitoringPause) {
  return {
    decision: "allow" as const,
    decisionId: "",
    summary: "Monitoring is temporarily paused for this conversation.",
    results: [],
    monitoringPaused: true,
    monitoringPausedUntil: new Date(pause.expiresAt).toISOString(),
  };
}

function projectExcludedDecision() {
  return {
    decision: "allow" as const,
    decisionId: "",
    summary: "This project is excluded from Leash monitoring.",
    results: [],
    monitoringPaused: true,
    projectExcluded: true,
  };
}

function agentEventScope(value: unknown) {
  const body = value && typeof value === "object"
    ? value as { request?: { agent?: { kind?: unknown }; event?: { agentKind?: unknown; sessionId?: unknown; projectPath?: unknown } } }
    : undefined;
  return {
    agentKind: String(body?.request?.agent?.kind ?? body?.request?.event?.agentKind ?? ""),
    sessionId: String(body?.request?.event?.sessionId ?? ""),
    projectPath: body?.request?.event?.projectPath,
  };
}

async function readJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  const limit = Number(process.env.OPENLEASH_DESKTOP_EDGE_MAX_BODY_BYTES ?? 20 * 1024 * 1024);
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error(`request body exceeds ${limit} bytes`);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function normalizeHookRequest(agent: string, eventName: string, raw: any, url: string): EvaluationRequest {
  const metadata = hookAgentMetadata(agent);
  const query = new URL(url, "http://127.0.0.1").searchParams;
  const sessionId = firstString(raw?.session_id, raw?.sessionId, raw?.conversation_id, raw?.conversationId, raw?.thread_id, raw?.threadId, raw?.chat_id, raw?.chatId, raw?.run_id, raw?.runId) ?? stableHookSessionId(agent, raw);
  const toolName = firstString(raw?.tool_name, raw?.toolName, raw?.tool?.name, raw?.function?.name, raw?.command?.name);
  const toolInput = firstDefined(raw?.tool_input, raw?.toolInput, raw?.tool?.input, raw?.input, raw?.arguments, raw?.args, raw?.params, raw?.command?.args);
  const prompt = normalizeHookPrompt(raw);
  return {
    computer: {
      hostname: query.get("hostname") || os.hostname(),
      platform: query.get("platform") || os.platform(),
      osRelease: query.get("os_release") || os.release()
    },
    agent: {
      kind: metadata.kind,
      displayName: metadata.displayName,
      version: query.get("agent_version") || raw?.version,
      executablePath: raw?.executable_path
    },
    event: {
      eventName,
      agentKind: metadata.kind,
      sessionId,
      projectPath: firstString(raw?.cwd, raw?.workspace, raw?.workspaceDir, raw?.workspace_dir, raw?.project_dir, raw?.projectPath, raw?.project_path, raw?.root, raw?.repo, raw?.repository, raw?.context?.workspaceDir) ?? process.cwd(),
      prompt,
      tool: toolName ? { name: toolName, input: toolInput, output: raw?.tool_response ?? raw?.output } : undefined,
      transcript: normalizeHookTranscript(raw?.transcript),
      raw,
      occurredAt: new Date().toISOString()
    }
  };
}

function hookAgentMetadata(agent: string) {
  if (agent === "codex") return { kind: "codex", displayName: "OpenAI Codex" };
  if (agent === "gemini") return { kind: "gemini", displayName: "Google Gemini CLI" };
  if (agent === "opencode") return { kind: "opencode", displayName: "OpenCode" };
  if (agent === "cursor") return { kind: "cursor", displayName: "Cursor" };
  if (agent === "cline") return { kind: "cline", displayName: "Cline" };
  if (agent === "openclaw") return { kind: "openclaw", displayName: "OpenClaw" };
  if (agent === "nanoclaw") return { kind: "nanoclaw", displayName: "NanoClaw" };
  return { kind: "claude-code", displayName: "Claude Code" };
}

function normalizeHookPrompt(raw: any) {
  const direct = firstString(
    raw?.prompt,
    raw?.user_prompt,
    raw?.userPrompt,
    raw?.message,
    raw?.input_text,
    raw?.inputText,
    raw?.prompt_response,
    raw?.promptResponse,
    raw?.agent_response,
    raw?.agentResponse,
    raw?.response,
    raw?.output_text,
    raw?.outputText,
    raw?.body,
    raw?.text,
    raw?.context?.content,
    raw?.context?.bodyForAgent,
    raw?.context?.sessionEntry?.content
  );
  if (direct) return direct;
  if (Array.isArray(raw?.messages)) {
    const message = raw.messages.slice().reverse().find((item: any) => typeof item?.content === "string" && item.content.trim());
    if (message) return message.content;
  }
  return undefined;
}

function firstString(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null);
}

function normalizeHookTranscript(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const turns = value
    .map((turn) => {
      if (!turn || typeof turn !== "object") return undefined;
      const record = turn as { role?: unknown; content?: unknown; at?: unknown };
      const role = typeof record.role === "string" ? record.role : undefined;
      const content = typeof record.content === "string" ? record.content.trim() : "";
      if (!role || !content || !["user", "assistant", "tool", "system"].includes(role)) return undefined;
      return { role, content, ...(typeof record.at === "string" ? { at: record.at } : {}) };
    })
    .filter(Boolean);
  return turns.length > 0 ? turns.slice(-20) as Array<{ role: string; content: string; at?: string }> : undefined;
}

function nativeHookDecision(agent: string, eventName: string, decision: { decision: "allow" | "ask" | "deny"; summary: string; question?: string; resolutionGuidance?: string; resolutionPayload?: Record<string, unknown> }) {
  const reason = decision.decision === "deny" && decision.resolutionGuidance
    ? `Leash denied this action. User guidance: ${decision.resolutionGuidance}`
    : decision.decision === "allow"
    ? "Leash approved this action."
    : decision.decision === "deny"
      ? decision.summary || "Leash denied this action."
      : decision.question ?? decision.summary;
  if (agent === "claude" || agent === "nanoclaw") {
    if (eventName === "PreToolUse") {
      return {
        decision: decision.decision === "deny" ? "block" : decision.decision,
        reason,
        continue: decision.decision !== "deny",
        stopReason: reason,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision.decision,
          permissionDecisionReason: reason,
          ...(decision.resolutionPayload ? { updatedInput: decision.resolutionPayload } : {})
        },
        suppressOutput: true
      };
    }
    return { continue: decision.decision !== "deny", stopReason: reason, suppressOutput: true };
  }
  return {
    decision: decision.decision === "deny" ? "block" : decision.decision,
    reason,
    ...(decision.resolutionPayload
      ? {
          response: decision.resolutionPayload,
          updatedInput: decision.resolutionPayload
        }
      : {})
  };
}

function backendUnavailableHookDecision(
  agent: string,
  eventName: string,
  failOpen: boolean,
) {
  const unavailableDecision = failOpen && process.env.OPENLEASH_BACKEND_UNAVAILABLE_DECISION !== "deny"
    ? "allow"
    : "deny";
  return nativeHookDecision(agent, eventName, {
    decision: unavailableDecision,
    summary: unavailableDecision === "deny"
      ? "Leash backend is unavailable. Connect to Leash Cloud or your personal API before continuing."
      : "Leash backend is unavailable. Leash allowed this action without remote policy evaluation."
  });
}

function isAvailabilityTransportError(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  const cause = (error as Error & { cause?: unknown }).cause;
  const code = cause && typeof cause === "object"
    ? String((cause as { code?: unknown }).code ?? "")
    : "";
  return new Set([
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ]).has(code);
}

function backendUnavailableProxyDecision() {
  return {
    decision: "allow" as const,
    decisionId: "availability-bypass",
    summary:
      "Leash Cloud is temporarily unavailable. Leash allowed this action in degraded mode.",
    results: [],
    degraded: true,
  };
}

function backendUnavailableTransformDecision(body: unknown) {
  const requestBody = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { requestBody?: unknown }).requestBody
    : undefined;
  return {
    protocol: "openleash-container-plugin.v1",
    requestBody:
      requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)
        ? requestBody
        : {},
    appliedPluginIds: [],
    runs: [],
    monitoringPaused: true,
    degraded: true,
  };
}

function waitForReadinessProbe(milliseconds: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

class RemoteApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RemoteApiError";
  }
}

function promptTransformHookDecision(agent: string, eventName: string, prompt: string, summary: string) {
  const base = nativeHookDecision(agent, eventName, { decision: "allow", summary }) as Record<string, unknown>;
  return {
    ...base,
    prompt,
    transformedPrompt: prompt,
    replacementPrompt: prompt,
    output: prompt,
    hookSpecificOutput: {
      ...(base.hookSpecificOutput && typeof base.hookSpecificOutput === "object" ? base.hookSpecificOutput as Record<string, unknown> : {}),
      hookEventName: eventName,
      prompt,
      transformedPrompt: prompt,
      replacementPrompt: prompt
    }
  };
}

function normalizePromptTransformConfig(value: unknown): PromptTransformConfig {
  const input = value && typeof value === "object" ? value as Partial<PromptTransformConfig> : {};
  const compression = input.compression && typeof input.compression === "object" ? input.compression as Partial<PromptTransformConfig["compression"]> : {};
  const dlp = input.dlp && typeof input.dlp === "object" ? input.dlp as Partial<PromptTransformConfig["dlp"]> : {};
  return {
    compression: {
      enabled: Boolean(compression.enabled),
      level: isCompressionLevel(compression.level) ? compression.level : defaultPromptTransformConfig.compression.level,
      conciseResponse: Boolean(compression.conciseResponse),
      model: cleanModel(compression.model) ?? defaultPromptTransformConfig.compression.model
    },
    dlp: {
      enabled: Boolean(dlp.enabled),
      action: isDlpAction(dlp.action) ? dlp.action : defaultPromptTransformConfig.dlp.action,
      categories: Array.isArray(dlp.categories) ? dlp.categories.filter(isDlpCategory) : defaultPromptTransformConfig.dlp.categories,
      model: cleanModel(dlp.model) ?? defaultPromptTransformConfig.dlp.model
    }
  };
}

function promptTransformsEnabled(config: PromptTransformConfig) {
  return config.compression.enabled || config.dlp.enabled;
}

async function transformPrompt({ prompt, config, apiKey }: { prompt: string; config: PromptTransformConfig; apiKey?: string }): Promise<PromptTransformResult> {
  let current = prompt;
  const models = new Set<string>();
  let compression: PromptTransformResult["compression"];
  let dlp: PromptTransformResult["dlp"];
  if (config.compression.enabled) {
    const compressed = await compressPrompt(prompt, config, apiKey);
    models.add(compressed.model);
    current = compressed.text;
    if (config.compression.conciseResponse) current = `${current.trim()}\n\nRespond concisely. Be short, direct, and avoid filler.`;
    compression = {
      enabled: true,
      originalLength: prompt.length,
      compressedLength: current.length,
      ratio: prompt.length > 0 ? current.length / prompt.length : 1
    };
  }
  if (config.dlp.enabled) {
    const checked = await checkDlp(current, config, apiKey);
    models.add(checked.model);
    dlp = {
      enabled: true,
      action: config.dlp.action,
      matched: checked.matched,
      categories: checked.categories,
      findings: checked.findings,
      masked: checked.masked
    };
    if (checked.blocked) {
      return { finalPrompt: current, blocked: true, summary: `DLP blocked prompt submission: ${checked.categories.join(", ") || "sensitive data"}.`, model: [...models].join(", ") || "heuristic", compression, dlp };
    }
    if (checked.requiresApproval) {
      return { finalPrompt: current, blocked: false, requiresApproval: true, summary: `Leash is asking before sharing ${checked.categories.join(", ") || "sensitive data"}.`, model: [...models].join(", ") || "heuristic", compression, dlp };
    }
    current = checked.text;
  }
  return { finalPrompt: current, blocked: false, summary: summaryForPromptTransform(prompt, current, compression, dlp), model: [...models].join(", ") || "none", compression, dlp };
}

async function compressPrompt(prompt: string, config: PromptTransformConfig, apiKey?: string) {
  if (!apiKey) return { text: heuristicCompressPrompt(prompt, config.compression.level), model: "heuristic-compression" };
  const response = await openAiJson(apiKey, config.compression.model, compressionInstruction(config.compression.level), { text: prompt });
  const parsed = response as { compressed?: string } | undefined;
  return { text: parsed?.compressed?.trim() || heuristicCompressPrompt(prompt, config.compression.level), model: parsed?.compressed ? config.compression.model : "heuristic-compression" };
}

async function checkDlp(prompt: string, config: PromptTransformConfig, apiKey?: string) {
  const heuristic = heuristicDlp(prompt, config);
  if (!apiKey) return { ...heuristic, model: "heuristic-dlp" };
  const response = await openAiJson(
    apiKey,
    config.dlp.model,
    [
      "You are Leash DLP. Inspect text for only the configured categories.",
      config.dlp.action === "block" ? "If configured sensitive data is present, return blocked true." : config.dlp.action === "mask" ? "If configured sensitive data is present, mask it and return maskedText." : "Detect configured sensitive data and leave the text unchanged.",
      "Return JSON with matched, blocked, maskedText, categories, findings."
    ].join("\n"),
    { categories: config.dlp.categories, action: config.dlp.action, text: prompt }
  );
  const parsed = response as any;
  if (!parsed || typeof parsed !== "object") return { ...heuristic, model: "heuristic-dlp" };
  return {
    matched: Boolean(parsed.matched),
    blocked: config.dlp.action === "block" && Boolean(parsed.matched),
    requiresApproval: config.dlp.action === "ask" && Boolean(parsed.matched),
    masked: config.dlp.action === "mask" && Boolean(parsed.matched) && typeof parsed.maskedText === "string" && parsed.maskedText !== prompt,
    text: config.dlp.action === "mask" && typeof parsed.maskedText === "string" ? parsed.maskedText : prompt,
    categories: Array.isArray(parsed.categories) ? parsed.categories.filter(isDlpCategory) : heuristic.categories,
    findings: Array.isArray(parsed.findings) ? parsed.findings.filter((item: any) => isDlpCategory(item?.category)).map((item: any) => ({ category: item.category, quote: String(item.quote ?? "").slice(0, 120), reason: String(item.reason ?? "") })) : heuristic.findings,
    model: config.dlp.model
  };
}

async function openAiJson(apiKey: string, model: string, instruction: string, payload: unknown) {
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: [{ role: "system", content: instruction }, { role: "user", content: JSON.stringify(payload) }], temperature: 0 }),
      signal: AbortSignal.timeout(Number(process.env.OPENLEASH_PROMPT_TRANSFORM_TIMEOUT_MS ?? 20000))
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const text = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).map((item) => item.text).find(Boolean);
    return text ? JSON.parse(text) as unknown : undefined;
  } catch {
    return undefined;
  }
}

function heuristicCompressPrompt(prompt: string, level: CompressionLevel) {
  const normalized = prompt.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (level === "light") return normalized;
  const limit = level === "maximum" ? 1800 : 3600;
  return normalized.length > limit ? `${normalized.slice(0, limit).trim()}\n\n[Leash compressed remaining repetitive context.]` : normalized;
}

function heuristicDlp(prompt: string, config: PromptTransformConfig) {
  let text = prompt;
  const findings: Array<{ category: DlpCategory; quote: string; reason: string }> = [];
  const add = (category: DlpCategory, regex: RegExp, replacement: string | ((match: string) => string), reason: string) => {
    if (!config.dlp.categories.includes(category)) return;
    text = text.replace(regex, (match) => {
      findings.push({ category, quote: String(match).slice(0, 120), reason });
      return typeof replacement === "function" ? replacement(String(match)) : replacement;
    });
  };
  add("pii", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL_MASKED]", "Email address detected.");
  add("pii", /\b\d{3}-\d{2}-\d{4}\b/g, "[SSN_MASKED]", "US SSN-like value detected.");
  add("tokens", /\b(?:sk|pk|ol|ghp|github_pat)_[A-Za-z0-9_=-]{16,}\b/g, "[TOKEN_MASKED]", "Token-like value detected.");
  add("keys", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATE_KEY_MASKED]", "Private key block detected.");
  add("credentials", /\b(password|secret|api[_-]?key)\s*[:=]\s*['"]?[^'"\s]{8,}/gi, (match) => `${match.split(/[:=]/)[0].trim()}=[SECRET_MASKED]`, "Credential assignment detected.");
  add("phi", /\b(patient|diagnosis|medical record|mrn)\b[^\n]{0,120}/gi, "[PHI_MASKED]", "Health-data context detected.");
  const categories = [...new Set(findings.map((item) => item.category))];
  const matched = findings.length > 0;
  return { matched, blocked: config.dlp.action === "block" && matched, requiresApproval: config.dlp.action === "ask" && matched, masked: config.dlp.action === "mask" && text !== prompt, text: config.dlp.action === "mask" ? text : prompt, categories, findings };
}

function compressionInstruction(level: CompressionLevel) {
  if (level === "light") return "Compress this prompt lightly. Remove obvious repetition while preserving all intent, constraints, code names, file paths, and facts. Return JSON {\"compressed\":\"...\"}.";
  if (level === "maximum") return "Compress this prompt as aggressively as possible while preserving task intent, hard constraints, identifiers, code names, file paths, security-sensitive details, and user requirements. Return JSON {\"compressed\":\"...\"}.";
  return "Compress this prompt to reduce tokens while preserving task intent, hard constraints, identifiers, code names, file paths, and important context. Return JSON {\"compressed\":\"...\"}.";
}

function summaryForPromptTransform(original: string, finalPrompt: string, compression?: PromptTransformResult["compression"], dlp?: PromptTransformResult["dlp"]) {
  const parts = [];
  if (compression?.enabled) parts.push(`compressed ${original.length} to ${finalPrompt.length} chars`);
  if (dlp?.enabled) parts.push(dlp.matched ? `DLP ${dlp.action}${dlp.masked ? "ed" : ""}: ${dlp.categories.join(", ")}` : "DLP passed");
  return parts.length ? `Prompt transformed (${parts.join("; ")}).` : "Prompt transform checked with no changes.";
}

function isCompressionLevel(value: unknown): value is CompressionLevel {
  return value === "light" || value === "standard" || value === "maximum";
}

function isDlpCategory(value: unknown): value is DlpCategory {
  return value === "pii" || value === "phi" || value === "tokens" || value === "keys" || value === "credentials";
}

function isDlpAction(value: unknown): value is DlpAction {
  return value === "allow" || value === "ask" || value === "block" || value === "mask";
}

function cleanModel(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function cleanResolutionGuidance(value?: string) {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim();
  return cleaned ? truncate(cleaned, 500) : undefined;
}

function cleanInteractionResponse(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized.length > 32_000) throw new Error("interaction response exceeds 32 KB");
  return JSON.parse(serialized) as Record<string, unknown>;
}

function localApiFunction(method: string, url: string): OpenLeashApiFunction | undefined {
  const pathOnly = url.split("?")[0];
  if (method === "POST" && pathOnly === "/v1/evaluate") return "localEvaluate";
  if (method === "POST" && /^\/v1\/hooks\/[^/]+\/[^/]+$/.test(pathOnly)) return "localHookEvaluate";
  if (method === "GET" && /^\/v1\/decisions\/[^/]+$/.test(pathOnly)) return "tenantDecisionPoll";
  if (method === "POST" && /^\/admin\/decisions\/[^/]+\/resolve$/.test(pathOnly)) return "tenantDecisionResolve";
  if (method === "GET" && pathOnly === "/admin/tray-status") return "tenantTrayStatus";
  if (method === "GET" && pathOnly === "/health") return "health";
  return undefined;
}

function applyLocalContract(req: http.IncomingMessage, res: http.ServerResponse, functionName: OpenLeashApiFunction) {
  const version = OPENLEASH_API_CONTRACTS[functionName];
  res.setHeader(OPENLEASH_API_FUNCTION_HEADER, functionName);
  res.setHeader(OPENLEASH_API_VERSION_HEADER, version);
  const requested = req.headers[OPENLEASH_API_VERSION_HEADER] as string | undefined;
  if (requested && requested !== version) {
    res.writeHead(426, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unsupported Leash API contract version", function: functionName, expectedVersion: version, receivedVersion: requested }));
    return false;
  }
  return true;
}

function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
