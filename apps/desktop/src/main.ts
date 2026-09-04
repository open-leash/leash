import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  Notification,
  screen,
  Tray,
  ipcMain,
  powerMonitor,
  shell,
  type Display,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from "electron";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shouldResetLocalState } from "./install-state";
import { findDockerExecutable } from "./docker-executable";
import {
  agentIconFor,
  detectLocalAgentProtections,
  installAgentProtection,
  protectionWatchTargets,
  uninstallAllAgentProtections,
  uninstallAgentProtection,
  type LocalAgentProtection,
} from "./agent-registry";
import {
  LocalOpenLeashServer,
  normalizePolicies,
  type LocalAgentActivity,
  type Policy,
} from "./local-server";
import { apiVersionHeaders } from "./api-contract";
import {
  OPENLEASH_DESKTOP_API_URL,
  OPENLEASH_DESKTOP_AUTH_CALLBACK_URI,
  OPENLEASH_DESKTOP_GITHUB_REDIRECT_URI,
  OPENLEASH_DESKTOP_GOOGLE_REDIRECT_URI,
  OPENLEASH_DESKTOP_MICROSOFT_REDIRECT_URI,
  OPENLEASH_PUBLIC_CLOUD_API_URL,
  OPENLEASH_PUBLIC_CLOUD_DASHBOARD_URL,
} from "./public-config";
import type { PluginCatalogItem } from "./plugin-catalog";
import { canonicalPluginSlug, responsiblePluginSlug } from "./plugin-slug";
import { excludedProjectPathsCovering } from "./project-exclusions";
import type {
  OpenLeashClientViewModel,
  OpenLeashAttentionEvent,
  OpenLeashOutcomeRecord,
  PluginIslandContribution,
} from "@openleash/shared";
import {
  configureAgentProxy,
  installLocalProxy,
  localProxyStatus,
  uninstallLocalProxy,
  type LocalProxyStatus,
} from "./proxy-manager";
import { pendingIntentKey as stablePendingIntentKey } from "./intent-dedupe";
import {
  activeAgentSessions,
  activityIslandPresentationSummary,
  activityIslandKey,
  ambientIslandContributions,
  applyCompletedAgentSessions,
  contributionsForSession,
  islandDisplayTargets,
  isBackgroundControlPending,
  latestTokenSaverSavings,
  mergeImmediateAgentActivity,
  mergeRecoveredAgentSessions,
  prioritizeAgentSessions,
  recoverSuspendedAgentSessions,
  shouldPresentActivityIsland,
  type ActivityIslandSourceAgent,
  type ActiveAgentSession,
} from "./activity-island";
import {
  focusAgentSession,
  isAgentSessionFrontmost,
  shouldAutoExpandAttention,
  type AgentSessionFocusTarget,
} from "./agent-session-focus";
import {
  detectRunningAgentRestartTargets,
  restartRunningAgentTargets,
  type RunningAgentRestartTarget,
} from "./agent-restart";
import { clampNoticeWindowSize, isPointInNoticeBounds, type NoticeWindowSize } from "./notice-window";
import {
  activityPresentationKey,
  approvalPresentationKey,
  matchingPendingSourceIds,
  preferPreviouslyPresentedPending,
} from "./notice-presentation";
import {
  SESSION_MONITORING_PAUSE_MS,
  pausableSessionIds,
} from "./session-monitoring";
import {
  discoverAgentInstructionFiles,
  ruleCandidatesFromMarkdown,
} from "./instruction-rules";
import { shouldLaunchInBackground } from "./startup-visibility";

const APP_DISPLAY_NAME = app.isPackaged ? "Leash" : "Leash (Dev)";
const MAC_TRAY_GUID = "2d6829c5-f65f-4c6a-bf91-4fc686a14f0e";
let proxyStatus: LocalProxyStatus = {
  runtimeAvailable: false,
  installed: false,
  running: false,
  healthy: false,
  url: "http://127.0.0.1:9320",
  binary: "",
  configuredAgents: [],
};
let pluginContainerFingerprint = "";

function pluginFingerprint(plugins: PluginCatalogItem[]) {
  return JSON.stringify(plugins.map((plugin) => [
    plugin.id,
    plugin.version,
    plugin.settings?.enabled,
    plugin.settings?.installedVersion,
    plugin.settings?.config,
    plugin.execution?.type === "in-process" ? plugin.execution.handler : undefined,
  ]));
}

type PendingDecision = {
  id: string;
  question?: string;
  summary: string;
  agent_name: string;
  agent_kind: string;
  hostname: string;
  user_name?: string;
  event_name: string;
  tool_name?: string;
  project_path?: string;
  payload?: unknown;
  triggered_policies?: TriggeredPolicy[];
  purpose_summary?: string | null;
  recent_context?: Array<{ role?: string; content?: string; at?: string }>;
  created_at: string;
  plugin_id?: string;
  plugin_name?: string;
  quote?: string | null;
};

type AttentionEvent = OpenLeashAttentionEvent;

type AgentStatus = {
  id: string;
  decision_id?: string;
  kind: string;
  display_name: string;
  hostname: string;
  user_name?: string;
  last_seen_at?: string;
  event_name?: string;
  tool_name?: string;
  project_path?: string;
  payload?: unknown;
  activity_at?: string;
  decision?: string;
  resolution?: "allow" | "deny" | null;
  resolution_guidance?: string | null;
  decision_summary?: string;
  question?: string;
  triggered_policies?: TriggeredPolicy[];
  recent_activity?: Array<{
    id?: string;
    event_name?: string;
    tool_name?: string;
    project_path?: string;
    prompt?: string;
    payload?: unknown;
    created_at?: string;
    decision?: string;
    resolution?: "allow" | "deny" | null;
    summary?: string;
    question?: string;
    triggered_policies?: TriggeredPolicy[];
  }>;
  sessions?: AgentSession[];
  short_summary: string;
};

type AgentSession = {
  id: string;
  session_id?: string;
  agent_kind?: string;
  agent_name?: string;
  hostname?: string;
  title: string;
  summary?: string;
  project_path?: string;
  started_at?: string;
  last_activity_at?: string;
  duration_seconds?: number;
  event_count?: number;
  approval_count?: number;
  denied_count?: number;
  mcp_servers?: string[];
  events?: AgentStatus["recent_activity"];
};

type SessionMetrics = {
  today?: { session_count?: number; duration_seconds?: number };
  last24h?: { session_count?: number; duration_seconds?: number };
  week?: { session_count?: number; duration_seconds?: number };
  month?: { session_count?: number; duration_seconds?: number };
  by_agent_24h?: Array<{
    agent_kind?: string;
    agent_name?: string;
    session_count?: number;
    duration_seconds?: number;
  }>;
};

type LocalAvailabilityState = {
  state: "closed" | "open" | "half-open";
  degraded: boolean;
  consecutiveFailures?: number;
  reason?: string;
};

type RemoteMobileState = {
  policies?: Array<{
    id: string;
    name: string;
    description?: string;
    severity?: string;
    natural_language_rule?: string;
    enabled: boolean;
    locked?: boolean;
  }>;
  pendingApprovals?: Array<{
    id: string;
    question?: string;
    summary?: string;
    agent_name?: string;
    agent_kind?: string;
    hostname?: string;
    user_name?: string;
    event_name?: string;
    tool_name?: string;
    project_path?: string;
    payload?: unknown;
    triggered_policies?: TriggeredPolicy[];
    purpose_summary?: string | null;
    plugin_id?: string;
    plugin_name?: string;
    quote?: string | null;
    recent_context?: Array<{ role?: string; content?: string; at?: string }>;
    created_at?: string;
  }>;
  recentActivity?: PendingDecision[];
  agents?: Array<{
    id: string;
    kind?: string;
    display_name?: string;
    hostname?: string;
    platform?: string;
    installed?: boolean;
    protected?: boolean;
    desired_monitored?: boolean;
    desiredMonitored?: boolean;
    last_seen_at?: string;
    event_name?: string;
    tool_name?: string;
    project_path?: string;
    activity_at?: string;
    decision?: string;
    resolution?: "allow" | "deny" | null;
    decision_summary?: string;
    short_summary?: string;
    sessions?: AgentSession[];
    question?: string;
    triggered_policies?: TriggeredPolicy[];
    recent_activity?: AgentStatus["recent_activity"];
    payload?: unknown;
  }>;
  sessionMetrics?: Record<string, unknown>;
  attentionEvents?: AttentionEvent[];
  islandContributions?: PluginIslandContribution[];
  clientConfig?: {
    managedByOrganization?: boolean;
    approvalNotifications?: boolean;
  };
  sessionMonitoringPauses?: Array<{
    agentKind?: string;
    sessionIds?: string[];
    expiresAt?: string;
  }>;
};

type PluginOutcome = OpenLeashOutcomeRecord;

type DashboardActivitySummary = {
  rangeDays: number;
  totals: {
    checked: number;
    blocked: number;
    automaticallyApproved: number;
    manuallyApproved: number;
    waiting: number;
  };
  threats: Array<{
    name: string;
    total: number;
    blocked: number;
    automaticallyApproved: number;
    manuallyApproved: number;
  }>;
  agentKinds: Array<{ kind: string; name: string; count: number }>;
};

type PublicPluginListing = Record<string, unknown> & {
  id?: string;
  slug?: string;
  name?: string;
  description?: string;
  publisher?: string;
  repositoryUrl?: string;
  version?: string;
  runtime?: string;
  entrypoint?: string;
  execution?: Record<string, unknown>;
  events?: unknown[];
  permissions?: unknown[];
  effects?: unknown[];
  ordering?: Record<string, unknown>;
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
};

type TriggeredPolicy = {
  policy_name: string;
  status: "failed" | "needs_question";
  severity: string;
  explanation: string;
  evidence?: string[] | string;
};

type UpdateManifest = {
  version: string;
  updateAvailable?: boolean;
  latestVersion?: string;
  dmgUrl?: string;
  downloadUrl?: string;
  sha256?: string;
  sizeBytes?: number;
  notesUrl?: string;
  releaseNotes?: string;
  publishedAt?: string;
};

type UpdateState = {
  lastCheckedAt?: string;
  lastPromptedAt?: string;
  lastPromptedVersion?: string;
};

const localDevCloudApiUrl = "http://127.0.0.1:9318";
const apiUrl = OPENLEASH_DESKTOP_API_URL;
const cloudApiUrl =
  process.env.OPENLEASH_CLOUD_API_URL ??
  (app.isPackaged ? OPENLEASH_PUBLIC_CLOUD_API_URL : localDevCloudApiUrl);
const cloudDashboardUrl =
  process.env.OPENLEASH_CLOUD_DASHBOARD_URL ??
  OPENLEASH_PUBLIC_CLOUD_DASHBOARD_URL;
const cloudDevAuth = process.env.OPENLEASH_MOBILE_DEV_AUTH === "1";
const cloudDevAuthEmail =
  process.env.OPENLEASH_MOBILE_DEV_EMAIL ?? "mobile.user@openleash.com";
const desktopRedirectUri = OPENLEASH_DESKTOP_AUTH_CALLBACK_URI;
const desktopGoogleRedirectUri = OPENLEASH_DESKTOP_GOOGLE_REDIRECT_URI;
const desktopMicrosoftRedirectUri = OPENLEASH_DESKTOP_MICROSOFT_REDIRECT_URI;
const desktopGithubRedirectUri = OPENLEASH_DESKTOP_GITHUB_REDIRECT_URI;
const here = __dirname;
const defaultUpdateFeedUrl = app.isPackaged
  ? `${OPENLEASH_PUBLIC_CLOUD_API_URL}/api/updates/check`
  : "";
const updateCheckIntervalMs = 24 * 60 * 60 * 1000;
const individualOpenSourceApiUrl = "http://127.0.0.1:9318";
const NOTICE_CONTEXT_MESSAGE_COUNT = Number(
  process.env.OPENLEASH_ACTION_PURPOSE_MESSAGES ?? 5,
);
const MAIN_WINDOW_WIDTH = 1160;
const MAIN_WINDOW_HEIGHT = 760;
const MAIN_WINDOW_MIN_WIDTH = 1040;
const MAIN_WINDOW_MIN_HEIGHT = 700;
let localServer: LocalOpenLeashServer;
let tray: Tray | undefined;
let traySingleClickTimer: NodeJS.Timeout | undefined;
let window: BrowserWindow | undefined;
let noticeWindow: BrowserWindow | undefined;
type NativeIslandHost = {
  displayId: number;
  process: ReturnType<typeof spawn>;
  ready: boolean;
  output: string;
  pendingMessage?: Record<string, unknown>;
};
const nativeIslandHosts = new Map<number, NativeIslandHost>();
let manualIslandReveal = false;
let activeActivityFingerprint: string | undefined;
let latestPending: PendingDecision[] = [];
let latestPendingSources: PendingDecision[] = [];
let latestAgents: AgentStatus[] = [];
const completedAgentSessions = new Map<string, { completedAt: number; response?: string }>();
const pausedIslandSessions = new Map<string, {
  session: ActiveAgentSession;
  expiresAt: number;
}>();
let pausedIslandSessionTimer: NodeJS.Timeout | undefined;
const resumedIslandSessions = new Map<string, {
  session: ActiveAgentSession;
  expiresAt: number;
}>();
let suspendedIslandSessions: ActiveAgentSession[] = [];
let latestSessionMetrics: SessionMetrics = {};
let latestPlugins: PluginCatalogItem[] = [];
let latestOutcomes: PluginOutcome[] = [];
let latestViewModel: OpenLeashClientViewModel | undefined;
let latestActivitySummary: DashboardActivitySummary | undefined;
let latestActivitySummaryKey = "";
let monitoringManagedByOrganization = false;
let latestAttentionEvents: AttentionEvent[] = [];
let latestIslandContributions: PluginIslandContribution[] = [];
let presentedTrialEndKey = "";
const seenAttentionEventIds = new Set<string>();
const soundedActionableNoticeKeys = new Set<string>();
const desktopStartedAt = Date.now();
let pollInFlight = false;
let pollQueued = false;
const pendingRefreshTimers = new Set<NodeJS.Timeout>();
const immediateActivityHints = new Map<string, {
  source: ActivityIslandSourceAgent;
  expiresAt: number;
}>();
let localProtections: LocalAgentProtection[] = [];
let localProtectionCheckedAt = 0;

function remoteApiError(
  error: unknown,
  remoteApiUrl: string,
  fallback: string,
) {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const localDevApi =
    remoteApiUrl === localDevCloudApiUrl ||
    /^https?:\/\/(127\.0\.0\.1|localhost):9318\b/i.test(remoteApiUrl);
  if (
    /fetch failed|failed to fetch|econnrefused|enotfound|etimedout|econnreset|networkerror/i.test(
      raw,
    )
  ) {
    if (localDevApi && !app.isPackaged) {
      return `Leash Cloud client API is not running at ${remoteApiUrl}. Start the local Leash Cloud dev stack, then try again.`;
    }
    if (localDevApi) {
      return "Leash Cloud is temporarily unreachable. Check your connection and try again.";
    }
    if (remoteApiUrl === OPENLEASH_PUBLIC_CLOUD_API_URL) {
      return `Could not reach Leash Cloud at ${remoteApiUrl}. Check your connection and try again.`;
    }
    return `Could not reach Leash at ${remoteApiUrl}. Check the API URL and network, then try again.`;
  }
  return raw || fallback;
}

function isPersonalEmailDomain(email?: string) {
  const domain =
    String(email ?? "")
      .split("@")[1]
      ?.toLowerCase() ?? "";
  return new Set([
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "yahoo.com",
    "proton.me",
    "protonmail.com",
    "aol.com",
  ]).has(domain);
}
let activeNoticeKey: string | undefined;
let noticeDismissTimer: NodeJS.Timeout | undefined;
let completionNoticeTimer: NodeJS.Timeout | undefined;
let completionNoticeUntil = 0;
let suppressedNoticeKeys = new Set<string>();
const rememberedApprovalChoices = new Map<
  string,
  { resolution: "allow" | "deny"; expiresAt: number }
>();
let latestRemoteHistory: PendingDecision[] = [];
let resolvingDecisionIds = new Set<string>();
let remoteClientEventStreamKey = "";
let remoteClientEventStreamAbort: AbortController | undefined;
let remoteClientEventRetry: NodeJS.Timeout | undefined;
let suppressMainWindowActivationUntil = 0;
let currentTrayStatus: "ok" | "pending" | "down" = "ok";
const enforcedAgentKinds = new Set<string>();
const protectionWatchers = new Map<string, fs.FSWatcher>();
const pendingProtectionRepairs = new Map<string, NodeJS.Timeout>();
let protectionAuditTimer: NodeJS.Timeout | undefined;
let repairingProtections = false;
let proxyRestartInFlight = false;
let proxyRestartFailures = 0;
let proxyRestartNotBefore = 0;
const skillWatchers = new Map<string, fs.FSWatcher>();
const pendingSkillScans = new Map<string, NodeJS.Timeout>();
const observedSkillHashes = new Map<string, string>();
let skillWatcherSyncTimer: NodeJS.Timeout | undefined;
let quitting = false;
let desktopStartupComplete = false;
let revealExistingInstanceOnReady = false;
let pendingDesktopAuth:
  | {
      kind: "oauth" | "dashboard_handoff";
      apiUrl: string;
      providerType: string;
      state: string;
      codeVerifier?: string;
      createdAt: number;
      exchangeRedirectUri?: string;
      organizationId?: string;
      organizationSlug?: string;
      audience?: "individual" | "organization";
    }
  | undefined;
let desktopAuthSession:
  | {
      token: string;
      enrollmentFallbackToken?: string;
      enrolled?: boolean;
      apiUrl: string;
      expiresAt?: string;
      organizationName?: string;
      organizationSlug?: string;
      userName?: string;
      userEmail?: string;
      account?: { packageId?: string | null };
      evaluationProvider?: { connected?: boolean; provider?: string; masked?: string };
      billing?: Record<string, unknown>;
    }
  | undefined;

function rendererDesktopAuthSession() {
  if (!desktopAuthSession) return {};
  const payload = { ...desktopAuthSession };
  delete payload.enrollmentFallbackToken;
  delete payload.enrolled;
  return payload;
}
let selfHostedRuntime = {
  dockerInstalled: false,
  dockerRunning: false,
  apiReachable: false,
  status: "Not checked",
  log: "",
};

function startupLog(message: string) {
  try {
    fs.appendFileSync(
      path.join(os.tmpdir(), "openleash-startup.log"),
      `${new Date().toISOString()} ${message}\n`,
    );
    if (!app.isPackaged) console.log(`[openleash] ${message}`);
  } catch {
    // Best-effort packaged startup diagnostics.
  }
}

async function openTrustedExternalUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error(
      `Refusing to open unsupported external URL scheme: ${url.protocol}`,
    );
  }
  if (process.platform === "darwin") {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/open", [url.toString()], {
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`macOS could not open the browser (exit ${code ?? "unknown"}).`));
      });
    });
    return;
  }
  await shell.openExternal(url.toString());
}

function hardenWindow(target: BrowserWindow) {
  target.webContents.setWindowOpenHandler(({ url }) => {
    void openTrustedExternalUrl(url).catch((error) =>
      startupLog(
        `blocked external window: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return { action: "deny" };
  });
  target.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
}

process.on("uncaughtException", (error) => {
  startupLog(`uncaughtException: ${error.stack || error.message}`);
});

process.on("unhandledRejection", (reason) => {
  startupLog(
    `unhandledRejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`,
  );
});

function showDockIcon() {
  if (process.platform !== "darwin") return;
  app.setActivationPolicy?.("regular");
  app.dock?.show();
}

function hideDockIcon() {
  if (process.platform !== "darwin") return;
  app.setActivationPolicy?.("accessory");
  app.dock?.hide();
}

function setupNeedsDockIcon() {
  return !localServer?.setupComplete;
}

function keepDockIconForSetup() {
  if (!setupNeedsDockIcon()) return;
  showDockIcon();
  if (window && !window.isDestroyed()) window.setSkipTaskbar(false);
}

function activateOpenLeashApp() {
  if (process.platform !== "darwin") return;
  showDockIcon();
  app.focus({ steal: true });
}

function hideDockIconIfTrayMode() {
  if (setupNeedsDockIcon()) {
    keepDockIconForSetup();
    return;
  }
  hideDockIcon();
}

function shouldPreserveSettingsForLaunch() {
  const args = process.argv.slice(1);
  return (
    args.includes("--keep-settings") ||
    args.includes("--preserve-settings") ||
    args.includes("--update") ||
    args.includes("--check-for-updates")
  );
}

function currentInstallIdentity() {
  if (!app.isPackaged) return undefined;
  const bundlePath = appBundlePath();
  const statTarget =
    process.platform === "darwin" ? bundlePath : process.execPath;
  try {
    const stat = fs.statSync(statTarget);
    return JSON.stringify({
      platform: process.platform,
      path: fs.realpathSync.native(bundlePath),
      version: app.getVersion(),
      birthtimeMs: Math.round(stat.birthtimeMs),
      ctimeMs: Math.round(stat.ctimeMs),
      size: stat.size,
    });
  } catch (error) {
    startupLog(
      `install identity unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function appBundlePath() {
  if (process.platform !== "darwin") return path.dirname(process.execPath);
  const marker = ".app/Contents/MacOS/";
  const markerIndex = process.execPath.indexOf(marker);
  if (markerIndex < 0) return path.dirname(process.execPath);
  return process.execPath.slice(0, markerIndex + ".app".length);
}

function syncInstallIdentity() {
  const identity = currentInstallIdentity();
  if (!identity) return false;
  const previous = localServer.installIdentity();
  const hadExistingSetup = localServer.setupComplete;
  const preserveSettings = shouldPreserveSettingsForLaunch();
  const explicitFreshStart = process.argv.includes("--fresh-install");
  if (previous === identity && !explicitFreshStart) return false;

  const shouldReset = shouldResetLocalState({
    currentIdentity: identity,
    previousIdentity: previous,
    setupComplete: localServer.setupComplete,
    preserveSettings,
    explicitFreshStart,
  });

  if (shouldReset) {
    localServer.resetAllLocalState();
    startupLog(
      previous
        ? "local state reset after app bundle replacement"
        : "local state reset after fresh app launch",
    );
  } else if (previous !== identity) {
    startupLog(
      preserveSettings
        ? "settings preserved for app bundle replacement"
        : "install identity initialized",
    );
  }
  localServer.rememberInstallIdentity(identity);
  return Boolean(previous) || explicitFreshStart || hadExistingSetup;
}

startupLog(`main loaded argv=${process.argv.join(" ")}`);
app.setName("Leash");
app.setAsDefaultProtocolClient("openleash");
app.setAboutPanelOptions({ applicationName: APP_DISPLAY_NAME });

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  startupLog("single instance lock unavailable; exiting");
  app.exit(0);
} else {
  startupLog("single instance lock acquired");
  app.on("second-instance", (_event, argv) => {
    startupLog(`second launch forwarded argv=${argv.join(" ")}`);
    const authUrl = argv.find((value) => value.startsWith("openleash://"));
    if (authUrl) {
      void handleDesktopAuthCallback(authUrl);
      return;
    }
    if (argv.includes("--update") || argv.includes("--check-for-updates")) {
      void checkForUpdates({
        source: "manual",
        force: true,
        autoInstall: argv.includes("--yes") || argv.includes("--install"),
      });
      return;
    }
    revealRunningInstance();
  });
}

if (singleInstanceLock) app
  .whenReady()
  .then(async () => {
    startupLog("ready");
    if (process.argv.includes("--cleanup-integrations")) {
      const cleanup = await cleanupDesktopIntegrations();
      if (!cleanup.ok) {
        console.error(`Leash integration cleanup failed: ${cleanup.errors.join("; ")}`);
      }
      app.exit(cleanup.ok ? 0 : 1);
      return;
    }
    const forceVisibleLaunch =
      process.argv.includes("--reset-setup") ||
      process.argv.includes("--fresh-install") ||
      process.argv.includes("--show-window");
    const loginItemSettings = app.getLoginItemSettings();
    const openedAsHidden = shouldLaunchInBackground({
      forceVisible: forceVisibleLaunch,
      hiddenArgument: process.argv.includes("--hidden"),
      wasOpenedAtLogin: loginItemSettings.wasOpenedAtLogin,
      wasOpenedAsHidden: loginItemSettings.wasOpenedAsHidden,
    });
    startupLog(
      `launch visibility background=${openedAsHidden} login=${loginItemSettings.wasOpenedAtLogin} legacyHidden=${loginItemSettings.wasOpenedAsHidden} forced=${forceVisibleLaunch}`,
    );
    const dockIcon = nativeImage.createFromPath(
      path.join(here, "openleash-icon.png"),
    );
    if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
    if (openedAsHidden) {
      hideDockIcon();
      startupLog("dock hidden for tray mode");
    } else {
      showDockIcon();
      startupLog("dock shown for visible window launch");
    }
    localServer = new LocalOpenLeashServer(app.getPath("userData"), {
      onAgentStop: handleLocalAgentStop,
      onRemoteHookForward: refreshPendingApprovalsSoon,
      onAgentActivity: handleImmediateAgentActivity,
      onDesktopAuthCallback: handleDesktopAuthCallback,
    });
    startupLog(`local server constructed at ${app.getPath("userData")}`);
    const protectedAgentsToRestore = shouldPreserveSettingsForLaunch()
      ? detectLocalAgentProtections({ appVersion: app.getVersion() })
          .filter(
            (agent) =>
              agent.installed &&
              agent.protected &&
              agent.approvalHandoff !== false &&
              agent.supportsInstall,
          )
          .map((agent) => agent.kind)
      : [];
    const installReplaced = syncInstallIdentity();
    if (installReplaced) {
      const cleanup = await cleanupDesktopIntegrations({
        removeSystemRegistration: false,
      });
      if (!cleanup.ok)
        throw new Error(`Could not clean previous agent integrations. ${cleanup.errors.join("; ")}`);
      startupLog("previous agent integrations cleaned before reinstall");
    }
    if (process.argv.includes("--reset-setup")) {
      localServer.resetSetup();
      startupLog("setup reset");
    }
    app.setLoginItemSettings({
      openAtLogin: localServer.setupComplete,
      openAsHidden: localServer.setupComplete,
      name: APP_DISPLAY_NAME,
    });
    startupLog(
      localServer.setupComplete
        ? "login item enabled for configured client"
        : "login item disabled until setup completes",
    );
    await localServer.start();
    startupLog("local server started");
    const launchRemoteApiUrl = readCliValue(
      process.argv.slice(1),
      "--remote-api-url",
    );
    if (launchRemoteApiUrl) {
      const normalizedLaunchRemoteApiUrl = normalizeRemoteApiUrl(
        launchRemoteApiUrl,
      );
      localServer.updateRemoteApiUrl(normalizedLaunchRemoteApiUrl);
      startupLog(
        `remote API target overridden for this launch: ${normalizedLaunchRemoteApiUrl}`,
      );
    }
    if (localServer.setupComplete) {
      await configureLocalAgent();
      await installLeashCli();
      if (installReplaced) {
        for (const agentKind of protectedAgentsToRestore) {
          await installAgentProtection(agentKind, hookInstallContext());
        }
        if (protectedAgentsToRestore.length > 0) {
          startupLog(
            `restored agent protections after update: ${protectedAgentsToRestore.join(", ")}`,
          );
        }
      }
      startupLog("client integration config refreshed");
    }
    pluginContainerFingerprint = pluginFingerprint(localServer.plugins);
    await migrateLocalDevCloudTarget();
    const cliResult = handleCliRuleImport();
    if (cliResult && cliResult.exitAfter) {
      startupLog("exiting after rule import");
      app.exit(cliResult.ok ? 0 : 1);
      return;
    }
    const cliEnrollResult = await handleCliEnrollment();
    if (cliEnrollResult?.exitAfter) {
      startupLog("exiting after client enrollment");
      app.exit(cliEnrollResult.ok ? 0 : 1);
      return;
    }
    const cliConfigResult = await handleCliClientConfig();
    if (cliConfigResult?.exitAfter) {
      startupLog("exiting after client config");
      app.exit(cliConfigResult.ok ? 0 : 1);
      return;
    }
    const cliUpdateResult = await handleCliUpdate();
    if (cliUpdateResult?.exitAfter) {
      startupLog("exiting after update");
      app.exit(cliUpdateResult.ok ? 0 : 1);
      return;
    }
    ensureTray("ok");
    installApplicationMenu();
    if (process.platform === "darwin") {
      const refreshNativeIslands = () => {
        setTimeout(() => syncActivityIsland(true), 180);
      };
      screen.on("display-added", refreshNativeIslands);
      screen.on("display-removed", refreshNativeIslands);
      screen.on("display-metrics-changed", refreshNativeIslands);
    }
    powerMonitor.on("suspend", captureActiveSessionsForSystemPause);
    powerMonitor.on("lock-screen", captureActiveSessionsForSystemPause);
    powerMonitor.on("resume", () => restoreActiveSessionsAfterSystemResume("wake"));
    powerMonitor.on("unlock-screen", () => restoreActiveSessionsAfterSystemResume("unlock"));
    startupLog("tray created");
    refreshMenu();
    startupLog("menu refreshed");
    await refreshLocalProtections(true);
    startupLog("protections refreshed");
    rememberCurrentlyProtectedAgents();
    proxyStatus = await localProxyStatus();
    if (
      localServer.setupComplete &&
      !proxyStatus.running &&
      localServer.effectiveToken
    ) {
      try {
        proxyStatus = await installProxyForMonitoredAgents([
          ...enforcedAgentKinds,
        ]);
        startupLog("local proxy installed for monitored agents");
      } catch (error) {
        startupLog(
          `local proxy automatic install skipped: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    startupLog(
      `local proxy ${proxyStatus.healthy ? "healthy" : proxyStatus.running ? "running" : "stopped"}`,
    );
    startProtectionIntegrityGuard();
    startSkillIntegrityGuard();
    setInterval(async () => {
      const desired = [...proxyStatus.configuredAgents];
      const current = await localProxyStatus();
      if (current.running) {
        proxyRestartFailures = 0;
        proxyRestartNotBefore = 0;
        for (const kind of desired) configureAgentProxy(kind, true);
      } else if (
        desired.length > 0 &&
        localServer.setupComplete &&
        !proxyRestartInFlight &&
        Date.now() >= proxyRestartNotBefore
      ) {
        proxyRestartInFlight = true;
        try {
          proxyStatus = await installProxyForMonitoredAgents(desired);
          proxyRestartFailures = 0;
          proxyRestartNotBefore = 0;
          startupLog("local proxy recovered after an unexpected stop");
        } catch (error) {
          proxyRestartFailures += 1;
          const delay = Math.min(
            5 * 60_000,
            5_000 * 2 ** Math.min(proxyRestartFailures - 1, 6),
          );
          proxyRestartNotBefore = Date.now() + delay;
          startupLog(
            `local proxy restart failed; retrying in ${Math.ceil(delay / 1000)}s: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          proxyRestartInFlight = false;
        }
      }
      proxyStatus = await localProxyStatus();
      refreshMenu();
    }, 15_000);
    void poll();
    setInterval(poll, 3000);
    void maybeOfferUpdate();
    desktopStartupComplete = true;
    if (!openedAsHidden || revealExistingInstanceOnReady) {
      revealExistingInstanceOnReady = false;
      showMainWindow(localServer.setupComplete ? "settings" : "setup");
      startupLog("main window shown");
    }
  })
  .catch((error) => {
    const message =
      error instanceof Error ? error.stack || error.message : String(error);
    startupLog(`ready failed: ${message}`);
    if (!app.isPackaged) console.error(`[openleash] ready failed: ${message}`);
    app.exit(1);
  });

app.on("activate", () => {
  if (Date.now() < suppressMainWindowActivationUntil) {
    return;
  }
  if (noticeWindow && !noticeWindow.isDestroyed()) {
    return;
  }
  restoreMainWindow();
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  void handleDesktopAuthCallback(url);
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  // Keep the tray process alive after the approval window is hidden.
});

ipcMain.handle("openleash:list", () => ({
  apiUrl,
  cloudApiUrl,
  cloudDevAuth,
  cloudDevAuthEmail,
  mode: localServer?.setupComplete ? "settings" : "setup",
  setupComplete: localServer?.setupComplete ?? false,
  introSeen: localServer?.introSeen ?? false,
  clientMode: localServer?.clientMode ?? "cloud",
  remoteApiUrl: localServer?.remoteApiUrl,
  remoteOrganization: localServer?.remoteOrganization,
  remoteUser: localServer?.remoteUser,
  apiProvider: localServer?.apiProvider ?? "openai",
  apiKeySet: localServer?.apiKeySet ?? false,
  agentDoneSound: localServer?.agentDoneSound ?? true,
  islandVisibility: localServer?.islandVisibility ?? "always",
  islandActivityOnly: localServer?.islandActivityOnly ?? false,
  excludedProjectPaths: localServer?.excludedProjectPaths ?? [],
  promptTransforms: localServer?.promptTransforms,
  plugins:
    latestPlugins.length > 0 ? latestPlugins : (localServer?.plugins ?? []),
  outcomes: latestOutcomes,
  viewModel: latestViewModel,
  activitySummary: latestActivitySummary,
  pending: latestPending,
  agents: latestAgents,
  sessionMetrics: latestSessionMetrics,
  localProtections,
  policies: localServer?.policies ?? [],
  history: localServer?.history ?? [],
  mcpServers: localServer?.mcpServers ?? [],
  skills: localServer?.skills ?? [],
  proxyStatus,
}));
ipcMain.handle(
  "openleash:load-history",
  async (_event, payload: { page?: number; limit?: number; agentKind?: string } = {}) => {
    const page = Math.max(1, Math.floor(Number(payload.page) || 1));
    const limit = Math.max(1, Math.min(50, Math.floor(Number(payload.limit) || 12)));
    const agentKind = optionalText(payload.agentKind);
    if (localServer?.remoteApiUrl && localServer.effectiveToken) {
      const url = new URL("/v1/client/history", localServer.remoteApiUrl);
      url.searchParams.set("page", String(page));
      url.searchParams.set("limit", String(limit));
      if (agentKind) url.searchParams.set("agentKind", agentKind);
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${localServer.effectiveToken}`,
          ...apiVersionHeaders("mobileState"),
        },
      });
      if (!response.ok) throw new Error(`History request failed (${response.status})`);
      return response.json();
    }
    const matching = (localServer?.history ?? [])
      .filter((item) => !agentKind || item.agent_kind === agentKind);
    const offset = (page - 1) * limit;
    const history = matching.slice(offset, offset + limit);
    const hasMore = offset + history.length < matching.length;
    return {
      history,
      pagination: { page, limit, hasMore, nextPage: hasMore ? page + 1 : null },
    };
  },
);
ipcMain.handle("openleash:mark-intro-seen", () => {
  localServer?.markIntroSeen();
  return { ok: true };
});
ipcMain.handle(
  "openleash:bootstrap-remote-api",
  async (_event, payload: { apiUrl?: string; organizationSlug?: string }) => {
    try {
      const remoteApiUrl = normalizeRemoteApiUrl(payload.apiUrl || cloudApiUrl);
      const result = await fetchMobileBootstrap(
        remoteApiUrl,
        payload.organizationSlug,
      );
      if (
        result.ok ||
        app.isPackaged ||
        remoteApiUrl !== OPENLEASH_PUBLIC_CLOUD_API_URL
      )
        return result;
      return fetchMobileBootstrap(
        localDevCloudApiUrl,
        payload.organizationSlug,
      );
    } catch (error) {
      const remoteApiUrl = normalizeRemoteApiUrl(payload.apiUrl || cloudApiUrl);
      return {
        ok: false,
        error: remoteApiError(
          error,
          remoteApiUrl,
          "Could not reach that Leash API.",
        ),
      };
    }
  },
);
ipcMain.handle(
  "openleash:start-remote-auth",
  async (
    _event,
    payload: {
      apiUrl?: string;
      providerType?: string;
      organizationId?: string;
      organizationSlug?: string;
      audience?: "individual" | "organization";
    },
  ) => {
    try {
      const remoteApiUrl = normalizeRemoteApiUrl(payload.apiUrl || cloudApiUrl);
      const providerType = payload.providerType || "google";
      const audience =
        payload.audience === "organization" ? "organization" : "individual";
      const result = await startMobileAuth(remoteApiUrl, providerType, {
        ...payload,
        audience,
        organizationId:
          audience === "organization" ? payload.organizationId : undefined,
        organizationSlug:
          audience === "organization" ? payload.organizationSlug : undefined,
      });
      if (
        result.ok ||
        app.isPackaged ||
        remoteApiUrl !== OPENLEASH_PUBLIC_CLOUD_API_URL
      )
        return result;
      return startMobileAuth(localDevCloudApiUrl, providerType, {
        ...payload,
        audience,
        organizationId:
          audience === "organization" ? payload.organizationId : undefined,
        organizationSlug:
          audience === "organization" ? payload.organizationSlug : undefined,
      });
    } catch (error) {
      const remoteApiUrl = normalizeRemoteApiUrl(payload.apiUrl || cloudApiUrl);
      return {
        ok: false,
        error: remoteApiError(error, remoteApiUrl, "Could not start sign-in."),
      };
    }
  },
);
ipcMain.handle(
  "openleash:start-org-cloud-onboarding",
  async (_event, payload: { provider?: "google" | "microsoft" }) => {
    try {
      keepDockIconForSetup();
      const provider = payload.provider === "microsoft" ? "microsoft" : "google";
      const state = crypto.randomBytes(32).toString("base64url");
      const codeVerifier = crypto.randomBytes(32).toString("base64url");
      const codeChallenge = crypto
        .createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
      pendingDesktopAuth = {
        kind: "dashboard_handoff",
        apiUrl: normalizeRemoteApiUrl(cloudApiUrl),
        providerType: provider === "microsoft" ? "azure_ad" : "google",
        state,
        codeVerifier,
        createdAt: Date.now(),
        audience: "organization",
      };
      const dashboardUrl = new URL(
        cloudDashboardUrl.replace(/\/$/, "") || "http://localhost:9300",
      );
      dashboardUrl.pathname = "/auth/cloud/start";
      dashboardUrl.searchParams.set("provider", provider);
      dashboardUrl.searchParams.set("desktop", "1");
      dashboardUrl.searchParams.set("desktop_state", state);
      dashboardUrl.searchParams.set("code_challenge", codeChallenge);
      dashboardUrl.searchParams.set("code_challenge_method", "S256");
      await openTrustedExternalUrl(dashboardUrl.toString());
      keepDockIconForSetup();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not open Leash Cloud sign-in.",
      };
    }
  },
);
async function fetchMobileBootstrap(
  remoteApiUrl: string,
  organizationSlug?: string,
) {
  try {
    const url = new URL("/v1/mobile/bootstrap", remoteApiUrl);
    if (organizationSlug)
      url.searchParams.set("organizationSlug", organizationSlug);
    const response = await fetch(url, {
      headers: apiVersionHeaders("mobileBootstrap"),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      return {
        ok: false,
        error: body.error || `Could not connect to ${remoteApiUrl}.`,
      };
    return { ok: true, apiUrl: remoteApiUrl, ...body };
  } catch (error) {
    return {
      ok: false,
      error: remoteApiError(
        error,
        remoteApiUrl,
        `Could not connect to ${remoteApiUrl}.`,
      ),
    };
  }
}

async function startMobileAuth(
  remoteApiUrl: string,
  providerType: string,
  payload: {
    organizationId?: string;
    organizationSlug?: string;
    audience?: "individual" | "organization";
  },
) {
  try {
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const browserRedirectUri =
      providerType === "azure_ad" || providerType === "microsoft"
        ? desktopMicrosoftRedirectUri
        : providerType === "github"
          ? desktopGithubRedirectUri
          : desktopGoogleRedirectUri;
    const response = await fetch(
      new URL("/v1/mobile/auth/start", remoteApiUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...apiVersionHeaders("mobileAuthStart"),
        },
        body: JSON.stringify({
          redirectUri: browserRedirectUri,
          audience:
            payload.audience === "organization" ? "organization" : "individual",
          providerType,
          organizationId: payload.organizationId,
          organizationSlug: payload.organizationSlug,
          codeChallenge,
          codeChallengeMethod: "S256",
        }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.authorizationUrl) {
      return {
        ok: false,
        error: body.error || "This API could not start sign-in.",
      };
    }
    pendingDesktopAuth = {
      kind: "oauth",
      apiUrl: remoteApiUrl,
      providerType: body.providerType || providerType,
      state: String(body.state ?? ""),
      codeVerifier,
      createdAt: Date.now(),
      exchangeRedirectUri: body.exchangeRedirectUri,
      organizationId: body.organizationId || payload.organizationId,
      organizationSlug: payload.organizationSlug,
      audience:
        payload.audience === "organization" ? "organization" : "individual",
    };
    if (!/^[A-Za-z0-9_-]{43}$/.test(pendingDesktopAuth.state)) {
      pendingDesktopAuth = undefined;
      return {
        ok: false,
        error: "This API did not return a secure sign-in state.",
      };
    }
    keepDockIconForSetup();
    await openTrustedExternalUrl(body.authorizationUrl);
    keepDockIconForSetup();
    return { ok: true, providerType: pendingDesktopAuth.providerType };
  } catch (error) {
    return {
      ok: false,
      error: remoteApiError(
        error,
        remoteApiUrl,
        `Could not start sign-in from ${remoteApiUrl}.`,
      ),
    };
  }
}

async function enrollDesktopEndpoint(
  remoteApiUrl: string,
  dashboardToken: string,
  agents: string[] = [],
  fallbackToken?: string,
): Promise<
  | {
      ok: true;
      token: string;
      user?: { email?: string; display_name?: string };
    }
  | { ok: false; error: string }
> {
  try {
    const enrollmentBody = JSON.stringify({
      installIdentity: localServer.deviceIdentity(),
      hostname: os.hostname(),
      platform: os.platform(),
      osRelease: os.release(),
      clientVersion: app.getVersion(),
      agents: enrollmentAgents(agents),
    });
    const enroll = async (
      token: string,
      credential: "primary" | "dashboard-fallback",
    ) => {
      const response = await fetch(new URL("/v1/desktop/enroll", remoteApiUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...apiVersionHeaders("desktopEnroll"),
        },
        body: enrollmentBody,
        signal: AbortSignal.timeout(
          Number(process.env.OPENLEASH_DESKTOP_ENROLL_TIMEOUT_MS ?? 15000),
        ),
      });
      const tokenClass = token.startsWith("ole_")
        ? "desktop-enrollment"
        : token.startsWith("ols_")
          ? "dashboard-session"
          : "other";
      startupLog(
        `desktop enrollment ${credential} (${tokenClass}) returned ${response.status} from ${new URL(remoteApiUrl).origin}`,
      );
      return { response, body: await response.json().catch(() => ({})) };
    };
    let { response, body } = await enroll(dashboardToken, "primary");
    if (
      response.status === 401 &&
      fallbackToken &&
      fallbackToken !== dashboardToken
    ) {
      ({ response, body } = await enroll(fallbackToken, "dashboard-fallback"));
    }
    if (!response.ok || !body.token) {
      return {
        ok: false,
        error:
          body.error ||
          body.message ||
          "Could not enroll this computer with Leash.",
      };
    }
    return { ok: true, token: body.token, user: body.user };
  } catch (error) {
    return {
      ok: false,
      error: remoteApiError(
        error,
        remoteApiUrl,
        "Could not enroll this computer with Leash.",
      ),
    };
  }
}

async function savePluginSettingsEndpoint(
  remoteApiUrl: string,
  token: string,
  payload: {
    pluginId?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
    profiles?: Array<{
      id: string;
      name: string;
      agentKinds: string[];
      agentIds?: string[];
      projectPaths?: string[];
      enabled?: boolean;
      config: Record<string, unknown>;
      priority?: number;
    }>;
    orderingPriority?: number | null;
    marketplace?: PublicPluginListing;
  },
) {
  const pluginId = String(payload.pluginId ?? "").trim();
  if (!pluginId) return { ok: false as const, error: "Plugin id is required." };
  const response = await fetch(
    new URL(`/v1/plugins/${encodeURIComponent(pluginId)}/settings`, remoteApiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        enabled: payload.enabled !== false,
        ...(payload.config !== undefined ? { config: payload.config } : {}),
        profiles: payload.profiles ?? undefined,
        orderingPriority: payload.orderingPriority ?? undefined,
        marketplace: payload.marketplace ?? undefined,
      }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false as const,
      error: body.error || "Could not save plugin settings.",
    };
  }
  return { ok: true as const, ...body };
}

function enrollmentAgents(agentKinds: string[]) {
  const selected = new Set(agentKinds.filter(Boolean));
  for (const agent of localProtections) {
    if (agent.installed) selected.add(agent.kind);
  }
  const detected = new Map(
    localProtections.map((agent) => [agent.kind, agent]),
  );
  return [...selected].map((kind) => {
    const detectedAgent = detected.get(kind);
    return {
      kind,
      displayName: detectedAgent?.displayName ?? agentDisplayName(kind),
      executablePath: detectedAgent?.executablePath ?? "",
    };
  });
}

function desktopInventoryAgents() {
  return localProtections.map((agent) => ({
    kind: agent.kind,
    displayName: agent.displayName,
    executablePath: agent.executablePath ?? "",
    installed: agent.installed,
    protected: agent.protected,
    detail: agent.detail,
  }));
}

function agentDisplayName(kind: string) {
  if (kind === "claude-code") return "Claude Code";
  if (kind === "codex") return "OpenAI Codex";
  if (kind === "cline") return "Cline";
  if (kind === "opencode") return "OpenCode";
  if (kind === "cursor") return "Cursor";
  if (kind === "gemini") return "Google Gemini CLI";
  if (kind === "windsurf") return "Windsurf";
  return kind;
}

ipcMain.handle(
  "openleash:save-remote-model-key",
  async (
    _event,
    payload: {
      apiUrl?: string;
      token?: string;
      apiProvider?: "openai" | "anthropic" | "deepseek";
      apiKey?: string;
    },
  ) => {
    const token = payload.token || desktopAuthSession?.token || localServer.effectiveToken;
    if (!token)
      return { ok: false, error: "Sign in before saving the model key." };
    const apiKey = String(payload.apiKey ?? "").trim();
    if (!apiKey) return { ok: false, error: "API key is required." };
    const remoteApiUrl = normalizeRemoteApiUrl(
      payload.apiUrl || desktopAuthSession?.apiUrl || cloudApiUrl,
    );
    const response = await fetch(
      new URL("/v1/mobile/model-key", remoteApiUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...apiVersionHeaders("mobileModelKey"),
        },
        body: JSON.stringify({
          provider:
            payload.apiProvider === "anthropic"
              ? "anthropic"
              : payload.apiProvider === "deepseek"
                ? "deepseek"
                : "openai",
          apiKey,
        }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      return {
        ok: false,
        error: body.error || "Could not save the model key to this tenant.",
      };
    return { ok: true, ...body };
  },
);
ipcMain.handle(
  "openleash:remote-state",
  async (_event, payload: { apiUrl?: string; token?: string }) => {
    const token = payload.token || desktopAuthSession?.token;
    if (!token)
      return { ok: false, error: "Sign in before loading managed rules." };
    const remoteApiUrl = normalizeRemoteApiUrl(
      payload.apiUrl || desktopAuthSession?.apiUrl || cloudApiUrl,
    );
    const response = await fetch(new URL("/v1/mobile/state", remoteApiUrl), {
      headers: {
        authorization: `Bearer ${token}`,
        ...apiVersionHeaders("mobileState"),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      return {
        ok: false,
        error: body.error || "Could not load managed Leash state.",
      };
    return { ok: true, ...body };
  },
);
ipcMain.handle(
  "openleash:save-plugin-settings",
  async (
    _event,
    payload: {
      apiUrl?: string;
      token?: string;
      pluginId?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
      profiles?: Array<{
        id: string;
        name: string;
        agentKinds: string[];
        agentIds?: string[];
        projectPaths?: string[];
        enabled?: boolean;
        config: Record<string, unknown>;
        priority?: number;
      }>;
      orderingPriority?: number | null;
      marketplace?: PublicPluginListing;
    },
  ) => {
    const token =
      payload.token || localServer.effectiveToken || desktopAuthSession?.token;
    if (!token)
      return { ok: false, error: "Sign in before saving plugin settings." };
    const remoteApiUrl = normalizeRemoteApiUrl(
      payload.apiUrl ||
        localServer.remoteApiUrl ||
        desktopAuthSession?.apiUrl ||
        cloudApiUrl,
    );
    return savePluginSettingsEndpoint(remoteApiUrl, token, payload);
  },
);
ipcMain.handle("openleash:import-local-plugin-folder", async () => {
  return {
    ok: false,
    error: "Leash Features are built into client-api. Add new first-party handlers in the backend source tree.",
  };
});
ipcMain.handle("openleash:docker-status", async () => {
  selfHostedRuntime = await checkSelfHostedRuntime();
  return selfHostedRuntime;
});
ipcMain.handle("openleash:start-self-hosted", async () => {
  selfHostedRuntime = await startSelfHostedRuntime();
  return selfHostedRuntime;
});
ipcMain.handle("openleash:proxy-status", async () => {
  proxyStatus = await localProxyStatus();
  return proxyStatus;
});
ipcMain.handle(
  "openleash:install-proxy",
  async (_event, payload: { agents?: string[]; corporateProxy?: string }) => {
    try {
      // The proxy talks to the loopback desktop edge, which authenticates
      // exclusively with the per-install local token. The edge owns forwarding
      // to Cloud with the separate account credential.
      const token = localServer.token;
      if (!token)
        return {
          ok: false,
          error: "Complete backend setup before installing the proxy.",
        };
      proxyStatus = await installLocalProxy({
        clientApiUrl: apiUrl,
        token,
        agents: payload?.agents ?? [],
        corporateProxy: payload?.corporateProxy,
        failOpen: localServer.availabilityFailOpen,
      });
      window?.webContents.send("openleash:update", { proxyStatus });
      return { ok: true, ...proxyStatus };
    } catch (error) {
      proxyStatus = await localProxyStatus();
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not install the local proxy.",
        ...proxyStatus,
      };
    }
  },
);
ipcMain.handle("openleash:uninstall-proxy", async () => {
  try {
    proxyStatus = await uninstallLocalProxy();
    window?.webContents.send("openleash:update", { proxyStatus });
    return { ok: true, ...proxyStatus };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not uninstall the local proxy.",
    };
  }
});
ipcMain.handle(
  "openleash:set-agent-proxy",
  async (_event, payload: { kind?: string; enabled?: boolean }) => {
    try {
      configureAgentProxy(
        String(payload?.kind ?? ""),
        payload?.enabled === true,
      );
      proxyStatus = await localProxyStatus();
      window?.webContents.send("openleash:update", { proxyStatus });
      return { ok: true, ...proxyStatus };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not configure this agent.",
      };
    }
  },
);
ipcMain.handle("openleash:open-local-config", async () => {
  const configPath = localRulesConfigPath();
  ensureLocalRulesConfig();
  await shell.openPath(configPath);
  return { ok: true, path: configPath };
});
ipcMain.handle(
  "openleash:setup",
  async (
    event,
    payload: {
      agents?: string[];
      policies?: Array<{
        id: string;
        name?: string;
        category?: string;
        description?: string;
        enabled: boolean;
        locked?: boolean;
        natural_language_rule?: string;
      }>;
      apiProvider?: "openai" | "anthropic" | "deepseek";
      apiKey?: string;
      audience?: "individual" | "organization";
      clientMode?: "personal" | "cloud" | "custom";
      remoteApiUrl?: string;
      remoteToken?: string;
      remoteOrganization?: string;
      remoteUser?: string;
      pluginSettings?: Array<{
        pluginId?: string;
        enabled?: boolean;
        config?: Record<string, unknown>;
        profiles?: Array<{
          id: string;
          name: string;
          agentKinds: string[];
          agentIds?: string[];
          projectPaths?: string[];
          enabled?: boolean;
          config: Record<string, unknown>;
          priority?: number;
        }>;
        orderingPriority?: number | null;
        marketplace?: PublicPluginListing;
      }>;
      skipDashboardOpen?: boolean;
      islandVisibility?: "always" | "activity" | "notifications" | "off";
    },
  ) => {
    const sendSetupProgress = (progress: {
      percent: number;
      stage: "prepare" | "connect" | "agents" | "verify" | "complete";
      title: string;
      detail: string;
    }) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("openleash:setup-progress", progress);
      }
    };
    sendSetupProgress({
      percent: 18,
      stage: "connect",
      title: "Connecting Leash",
      detail: "Validating your account and backend connection...",
    });
    const clientMode = payload.clientMode === "custom" ? "custom" : "cloud";
    const audience =
      payload.audience === "organization" ? "organization" as const : "individual" as const;
    const apiKey = String(payload.apiKey ?? "").trim();
    let remoteToken = payload.remoteToken || desktopAuthSession?.token;
    const remoteApiUrl = normalizeRemoteApiUrl(
      payload.remoteApiUrl || desktopAuthSession?.apiUrl || cloudApiUrl,
    );
    if (
      !remoteToken &&
      clientMode === "custom" &&
      isLocalApiUrl(remoteApiUrl)
    ) {
      remoteToken = localServer.token;
    }
    if (!remoteToken)
      return { ok: false, error: "Sign in before installing Leash." };
    let enrolledRemoteUser =
      payload.remoteUser ||
      desktopAuthSession?.userName ||
      desktopAuthSession?.userEmail;
    if (
      desktopAuthSession?.token &&
      remoteToken === desktopAuthSession.token &&
      !desktopAuthSession.enrolled
    ) {
      sendSetupProgress({
        percent: 24,
        stage: "connect",
        title: "Enrolling this Mac",
        detail: "Creating a protected identity for this installation...",
      });
      await refreshLocalProtections(true);
      const enrollment = await enrollDesktopEndpoint(
        remoteApiUrl,
        desktopAuthSession.token,
        payload.agents ?? [],
        desktopAuthSession.enrollmentFallbackToken,
      );
      if (!enrollment.ok) return { ok: false, error: enrollment.error };
      remoteToken = enrollment.token;
      desktopAuthSession.token = enrollment.token;
      desktopAuthSession.enrollmentFallbackToken = undefined;
      desktopAuthSession.enrolled = true;
      enrolledRemoteUser =
        enrollment.user?.display_name ||
        enrollment.user?.email ||
        enrolledRemoteUser;
    }
    for (const pluginSettings of payload.pluginSettings ?? []) {
      const saved = await savePluginSettingsEndpoint(
        remoteApiUrl,
        remoteToken,
        pluginSettings,
      );
      if (!saved.ok) return saved;
    }
    sendSetupProgress({
      percent: 32,
      stage: "connect",
      title: "Saving your protection policy",
      detail: "Applying your account, rules, and connection settings...",
    });
    const basePolicies = Array.isArray(payload.policies)
      ? normalizePolicies(payload.policies, localServer.policies, true)
      : localServer.policies;
    const policies = basePolicies.map((policy) => ({
      ...policy,
      enabled: policy.locked
        ? true
        : (payload.policies?.some(
            (item) => item.id === policy.id && item.enabled,
          ) ?? policy.enabled),
    }));
    localServer.completeSetup(policies, {
      clientMode,
      apiProvider: payload.apiProvider === "anthropic" ? "anthropic" : "openai",
      apiKey,
      remoteApiUrl,
      remoteToken,
      remoteOrganization:
        payload.remoteOrganization ||
        desktopAuthSession?.organizationName ||
        desktopAuthSession?.organizationSlug,
      remoteUser: enrolledRemoteUser,
      islandVisibility: payload.islandVisibility,
    });
    await configureLocalAgent();
    await installLeashCli();
    const selectedAgents = [
      ...new Set(
        (payload.agents ?? [])
          .map((kind) => String(kind).trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const agentSetupErrors: string[] = [];
    for (const [agentIndex, agentKind] of selectedAgents.entries()) {
      const agentDisplayName =
        localProtections.find((agent) => agent.kind === agentKind)?.displayName ||
        agentKind
          .split("-")
          .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : "")
          .join(" ");
      const agentProgress = selectedAgents.length
        ? 42 + Math.round((agentIndex / selectedAgents.length) * 28)
        : 70;
      sendSetupProgress({
        percent: agentProgress,
        stage: "agents",
        title: `Protecting ${agentDisplayName}`,
        detail: `Installing monitoring ${agentIndex + 1} of ${selectedAgents.length}...`,
      });
      try {
        const installed = await installAgentProtection(
          agentKind,
          hookInstallContext(),
        );
        if (!installed) {
          agentSetupErrors.push(`${agentKind}: monitoring is not supported`);
          continue;
        }
        enforcedAgentKinds.add(agentKind);
      } catch (error) {
        agentSetupErrors.push(
          `${agentKind}: ${error instanceof Error ? error.message : "installation failed"}`,
        );
      }
    }
    sendSetupProgress({
      percent: 72,
      stage: "agents",
      title: "Connecting full-conversation protection",
      detail: "Configuring the local proxy for your selected agents...",
    });
    let proxyInstallError: string | undefined;
    try {
      proxyStatus = await installProxyForMonitoredAgents(selectedAgents);
    } catch (error) {
      proxyInstallError = `Agent hooks are active, but the full-conversation proxy needs attention: ${error instanceof Error ? error.message : "unknown error"}`;
      proxyStatus = await localProxyStatus();
    }
    sendSetupProgress({
      percent: 80,
      stage: "verify",
      title: "Verifying agent protection",
      detail: "Confirming every selected agent is monitored...",
    });
    await refreshLocalProtections(true);
    const protectedByKind = new Map(
      localProtections.map((agent) => [agent.kind, agent]),
    );
    for (const agentKind of selectedAgents) {
      const protection = protectedByKind.get(agentKind);
      if (!protection?.protected) {
        agentSetupErrors.push(
          `${protection?.displayName ?? agentKind}: monitoring did not become active`,
        );
      }
      if (
        isAutomaticProxyAgent(agentKind) &&
        !(proxyStatus.configuredAgents as readonly string[]).includes(agentKind)
      ) {
        agentSetupErrors.push(
          `${protection?.displayName ?? agentKind}: full-conversation proxy was not configured`,
        );
      }
    }
    const desiredAgentKinds = new Set(selectedAgents);
    const monitoredProtections = localProtections.filter(
      (agent) => agent.installed && agent.supportsInstall,
    );
    for (const [protectionIndex, protection] of monitoredProtections.entries()) {
      sendSetupProgress({
        percent: monitoredProtections.length
          ? 86 + Math.round((protectionIndex / monitoredProtections.length) * 8)
          : 92,
        stage: "verify",
        title: "Saving monitoring preferences",
        detail: `Confirming ${protection.displayName}...`,
      });
      const saved = await saveRemoteAgentMonitoring(
        remoteApiUrl,
        remoteToken,
        protection.kind,
        desiredAgentKinds.has(protection.kind),
      );
      if (!saved.ok) {
        agentSetupErrors.push(
          `${protection.displayName}: ${saved.error ?? "monitoring preference was not saved"}`,
        );
      }
    }
    if (proxyInstallError && selectedAgents.some(isAutomaticProxyAgent)) {
      agentSetupErrors.push(proxyInstallError);
    }
    sendSetupProgress({
      percent: 94,
      stage: "verify",
      title: "Verifying built-in Features",
      detail: "Checking the API registry and handler for every enabled Feature...",
    });
    latestPlugins = await fetchRemotePluginCatalog(
      remoteApiUrl,
      remoteToken,
      latestPlugins,
    );
    pluginContainerFingerprint = pluginFingerprint(latestPlugins);
    const remotePluginVerification = await verifyRemotePluginRuntimes(
      remoteApiUrl,
      remoteToken,
    );
    if (!remotePluginVerification.ok) {
      agentSetupErrors.push(
        `Feature runtime verification failed (${remotePluginVerification.error || "unknown error"})`,
      );
    }
    if (agentSetupErrors.length > 0) {
      localServer.markSetupIncomplete();
      return {
        ok: false,
        error: `Leash could not finish installation. ${[
          ...new Set(agentSetupErrors),
        ].join(" ")}`,
      };
    }
    sendSetupProgress({
      percent: 96,
      stage: "verify",
      title: "Finishing installation",
      detail: "Starting protection and preparing your Leash workspace...",
    });
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
      name: APP_DISPLAY_NAME,
    });
    let desktopMessage: string | undefined = proxyInstallError;
    if (
      clientMode === "cloud" &&
      audience === "organization" &&
      !payload.skipDashboardOpen
    ) {
      const dashboardUrl = new URL(
        cloudDashboardUrl.replace(/\/$/, "") || "http://localhost:9300",
      );
      dashboardUrl.pathname = "/onboarding";
      await openTrustedExternalUrl(dashboardUrl.toString());
      desktopMessage = [
        "Complete your Business setup in the browser.",
        proxyInstallError,
      ]
        .filter(Boolean)
        .join(" ");
    }
    startProtectionIntegrityGuard();
    refreshMenu();
    const setupState = {
      apiUrl,
      cloudApiUrl,
      mode: "settings",
      setupComplete: true,
      introSeen: localServer.introSeen,
      clientMode,
      remoteApiUrl: localServer.remoteApiUrl,
      remoteOrganization: localServer.remoteOrganization,
      remoteUser: localServer.remoteUser,
      apiProvider: payload.apiProvider === "anthropic" ? "anthropic" : "openai",
      apiKeySet: localServer.apiKeySet,
      agentDoneSound: localServer.agentDoneSound,
      islandVisibility: localServer.islandVisibility,
      islandActivityOnly: localServer.islandActivityOnly,
      promptTransforms: localServer.promptTransforms,
      plugins: latestPlugins,
      outcomes: latestOutcomes,
      viewModel: latestViewModel,
      activitySummary: latestActivitySummary,
      pending: latestPending,
      agents: latestAgents,
      sessionMetrics: latestSessionMetrics,
      localProtections,
      proxyStatus,
      policies: localServer.policies,
      history: localServer.history,
      mcpServers: localServer.mcpServers,
      skills: localServer.skills,
      desktopMessage,
    };
    window?.webContents.send("openleash:update", setupState);
    showDecisionNotice({
      kind: "install_success",
      agentName: "Leash",
      title: "Installation complete",
      summary: "Leash installed",
      restartTargets: detectRunningAgentRestartTargets(selectedAgents),
    });
    sendSetupProgress({
      percent: 100,
      stage: "complete",
      title: "Protection active",
      detail: "Leash is installed and ready.",
    });
    return { ok: true, ...setupState };
  },
);

ipcMain.handle(
  "openleash:uninstall-agent-protection",
  async (_event, kind: string) => {
    await unprotectAgentKind(kind);
    refreshMenu();
    window?.webContents.send("openleash:update", {
      apiUrl,
      pending: latestPending,
      agents: latestAgents,
      sessionMetrics: latestSessionMetrics,
      plugins: latestPlugins,
      outcomes: latestOutcomes,
      viewModel: latestViewModel,
      history: localServer.history,
      mcpServers: localServer.mcpServers,
      skills: localServer.skills,
      localProtections,
      proxyStatus,
    });
    return { ok: true };
  },
);

ipcMain.handle(
  "openleash:set-agent-monitoring",
  async (_event, payload: { kind?: string; monitored?: boolean }) => {
    const kind = String(payload?.kind ?? "")
      .trim()
      .toLowerCase();
    if (!kind) return { ok: false, error: "Agent kind is required." };
    const monitored = Boolean(payload?.monitored);
    const remoteApiUrl = localServer.remoteApiUrl;
    const token = localServer.effectiveToken;
    if (remoteApiUrl && token) {
      const saved = await saveRemoteAgentMonitoring(
        remoteApiUrl,
        token,
        kind,
        monitored,
      );
      if (!saved.ok) return saved;
    }
    if (monitored) {
      await protectAgentKind(kind);
    } else {
      await unprotectAgentKind(kind);
    }
    proxyStatus = await localProxyStatus();
    refreshMenu();
    window?.webContents.send("openleash:update", {
      apiUrl,
      pending: latestPending,
      agents: latestAgents,
      sessionMetrics: latestSessionMetrics,
      plugins: latestPlugins,
      outcomes: latestOutcomes,
      viewModel: latestViewModel,
      history: localServer.history,
      mcpServers: localServer.mcpServers,
      skills: localServer.skills,
      localProtections,
      proxyStatus,
    });
    return { ok: true, localProtections, proxyStatus };
  },
);

ipcMain.handle(
  "openleash:save-settings",
  (
    _event,
    payload: {
      apiProvider?: "openai" | "anthropic" | "deepseek";
      apiKey?: string;
      agentDoneSound?: boolean;
      islandVisibility?: "always" | "activity" | "notifications" | "off";
      islandActivityOnly?: boolean;
    },
  ) => {
    localServer.updateSettings(
      "openai",
      undefined,
      typeof payload.agentDoneSound === "boolean"
        ? payload.agentDoneSound
        : undefined,
      typeof payload.islandActivityOnly === "boolean"
        ? payload.islandActivityOnly
        : undefined,
      payload.islandVisibility,
    );
    syncActivityIsland(true);
    return {
      ok: true,
      apiProvider: "openai",
      apiKeySet: false,
      agentDoneSound: localServer.agentDoneSound,
      islandVisibility: localServer.islandVisibility,
      islandActivityOnly: localServer.islandActivityOnly,
    };
  },
);
ipcMain.handle("openleash:choose-excluded-project", async () => {
  const options: OpenDialogOptions = {
    title: "Choose a project Leash should leave alone",
    buttonLabel: "Exclude project",
    properties: ["openDirectory"],
  };
  const selection = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (selection.canceled || !selection.filePaths[0]) {
    return { ok: false, canceled: true, excludedProjectPaths: localServer.excludedProjectPaths };
  }
  const excludedProjectPaths = localServer.addExcludedProjectPath(selection.filePaths[0]);
  syncActivityIsland(true);
  return {
    ok: true,
    excludedProjectPaths,
  };
});
ipcMain.handle(
  "openleash:remove-excluded-project",
  (_event, payload: { projectPath?: string }) => {
    const excludedProjectPaths = localServer.removeExcludedProjectPath(payload?.projectPath ?? "");
    syncActivityIsland(true);
    return { ok: true, excludedProjectPaths };
  },
);
ipcMain.handle(
  "openleash:save-prompt-transforms",
  (_event, payload: { config?: unknown }) => {
    const config = localServer.updatePromptTransforms(
      payload.config ?? payload,
    );
    return { ok: true, config };
  },
);
ipcMain.handle("openleash:delete-data", async () => {
  const options: MessageBoxOptions = {
    type: "warning",
    buttons: ["Delete data and restart", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Delete local data?",
    message: "Delete Leash local activity data?",
    detail:
      "This clears local history, approvals, and recorded agent activity on this Mac. Your setup, rules, and API key stay in place.",
  };
  const choice = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (choice.response !== 0) return { ok: false, canceled: true };
  localServer.clearData();
  relaunchOpenLeash();
  return { ok: true, restarting: true };
});
ipcMain.handle("openleash:delete-settings", async () => {
  const options: MessageBoxOptions = {
    type: "warning",
    buttons: ["Delete settings and restart", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Delete Leash settings?",
    message: "Delete Leash settings?",
    detail:
      "This clears setup, selected agents, rules, provider choice, and saved API key on this Mac. Leash will restart into the setup wizard.",
  };
  const choice = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (choice.response !== 0) return { ok: false, canceled: true };
  await removeDesktopMonitoring();
  localServer.clearSettings();
  relaunchOpenLeash();
  return { ok: true, restarting: true };
});
ipcMain.handle("openleash:disconnect-client", async () => {
  const options: MessageBoxOptions = {
    type: "warning",
    buttons: ["Disconnect this Mac", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Disconnect this Mac?",
    message: "Stop Leash protection and sign out on this Mac?",
    detail:
      "Leash will remove its agent hooks, proxy configuration, local CLI configuration, and startup registration, clear this Mac's account and setup settings, then restart in the setup wizard. The Leash app will remain installed.",
  };
  const choice = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (choice.response !== 0) return { ok: false, canceled: true };
  try {
    remoteClientEventStreamKey = "";
    remoteClientEventStreamAbort?.abort();
    remoteClientEventStreamAbort = undefined;
    if (remoteClientEventRetry) clearTimeout(remoteClientEventRetry);
    remoteClientEventRetry = undefined;
    desktopAuthSession = undefined;
    pendingDesktopAuth = undefined;
    await removeDesktopMonitoring();
    localServer.clearSettings();
    relaunchOpenLeash();
    return { ok: true, restarting: true };
  } catch (error) {
    return {
      ok: false,
      error: `Could not completely disconnect this Mac: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
});
ipcMain.handle("openleash:uninstall-application", async () => {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      error: "Complete in-app uninstall is currently available on macOS.",
    };
  }
  if (!app.isPackaged) {
    return {
      ok: false,
      error: "Complete uninstall is available from the installed Leash app, not a development build.",
    };
  }
  const options: MessageBoxOptions = {
    type: "warning",
    buttons: ["Uninstall Leash", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Uninstall Leash?",
    message: "Completely remove Leash from this Mac?",
    detail:
      "Leash will restore every managed agent configuration, remove its hooks and proxy settings, unregister startup, delete its local Open Source Docker containers and data if present, remove local Leash data, and delete the app. Docker Desktop itself will not be removed.",
  };
  const choice = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (choice.response !== 0) return { ok: false, canceled: true };

  const runtimeDir = individualOpenSourceRuntimeDirectory();
  if (fs.existsSync(path.join(runtimeDir, "docker-compose.yml"))) {
    const docker = spawnSync(findDockerExecutable(), ["info"], {
      encoding: "utf8",
      timeout: 8000,
    });
    if (docker.status !== 0) {
      return {
        ok: false,
        error:
          "Start Docker Desktop, then try again so Leash can remove its local containers and data cleanly.",
      };
    }
  }

  const cleanup = await cleanupDesktopIntegrations();
  if (!cleanup.ok) {
    return {
      ok: false,
      error: `Leash did not uninstall because cleanup was incomplete: ${cleanup.errors.join("; ")}`,
    };
  }
  try {
    startCompleteMacUninstall(runtimeDir);
    return { ok: true, uninstalling: true };
  } catch (error) {
    return {
      ok: false,
      error: `Could not start the Leash uninstaller: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
});
ipcMain.handle("openleash:delete-data-and-settings", async () => {
  const options: MessageBoxOptions = {
    type: "warning",
    buttons: ["Delete data and settings", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Delete Leash data and settings?",
    message: "Delete Leash data and settings?",
    detail:
      "This clears local history, approvals, recorded agent activity, setup, selected agents, rules, provider choice, and saved API key on this Mac. Leash will restart into the setup wizard.",
  };
  const choice = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (choice.response !== 0) return { ok: false, canceled: true };
  await removeDesktopMonitoring();
  localServer.clearData();
  localServer.clearSettings();
  relaunchOpenLeash();
  return { ok: true, restarting: true };
});
ipcMain.handle("openleash:copy-text", (_event, text: string) => {
  clipboard.writeText(String(text ?? ""));
  return { ok: true };
});
ipcMain.handle(
  "openleash:save-policies",
  (_event, policies: Array<{ id: string; enabled: boolean }>) => {
    localServer.updatePolicies(
      localServer.policies.map((policy) => ({
        ...policy,
        enabled: policy.locked
          ? true
          : policies.some((item) => item.id === policy.id && item.enabled),
      })),
    );
    return { ok: true, policies: localServer.policies };
  },
);
ipcMain.handle(
  "openleash:import-rules",
  async (
    _event,
    payload: { replace?: boolean; save?: boolean; currentRules?: Policy[] },
  ) => {
    const options: OpenDialogOptions = {
      title: "Import Leash rules",
      buttonLabel: "Import rules",
      properties: ["openFile"],
      filters: [
        {
          name: "Rules files",
          extensions: ["json", "md", "markdown", "txt", "rules"],
        },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const selected = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0])
      return { ok: false, canceled: true };
    try {
      const filePath = selected.filePaths[0];
      const content = fs.readFileSync(filePath, "utf8");
      const imported = parseRulesImport(content, filePath);
      const base = Array.isArray(payload.currentRules)
        ? payload.currentRules
        : localServer.policies;
      const policies = normalizePolicies(
        imported,
        base,
        Boolean(payload.replace),
      );
      if (payload.save) localServer.updatePolicies(policies);
      return { ok: true, policies, count: policies.length, path: filePath };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Could not import rules.",
      };
    }
  },
);
ipcMain.handle("openleash:import-rule-list-json", async () => {
  const options: OpenDialogOptions = {
    title: "Import JSON rules",
    buttonLabel: "Import JSON",
    properties: ["openFile"],
    filters: [
      { name: "JSON rules", extensions: ["json"] },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const selected = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (selected.canceled || !selected.filePaths[0])
    return { ok: false, canceled: true };
  try {
    const filePath = selected.filePaths[0];
    const content = fs.readFileSync(filePath, "utf8");
    const rules = parsePluginRulesJsonImport(content);
    return { ok: true, rules, count: rules.length, path: filePath };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Could not import JSON rules.",
    };
  }
});
ipcMain.handle(
  "openleash:discover-instruction-rules",
  async (_event, options?: { chooseProject?: boolean }) => {
    try {
      const projectPaths = new Set(knownProjectPaths());
      if (options?.chooseProject) {
        const dialogOptions: OpenDialogOptions = {
          title: "Choose a project with agent instruction files",
          buttonLabel: "Scan project",
          properties: ["openDirectory"],
        };
        const selected = window
          ? await dialog.showOpenDialog(window, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
        if (selected.canceled || !selected.filePaths[0]) {
          return { ok: false, canceled: true };
        }
        projectPaths.add(selected.filePaths[0]);
      }
      const sources = discoverAgentInstructionFiles({
        projectPaths: [...projectPaths],
      });
      const importedRules = [];
      const candidates = [];
      for (const source of sources) {
        try {
          if (fs.statSync(source.path).size > 512 * 1024) {
            startupLog(
              `instruction discovery skipped ${source.path}: file exceeds 512 KiB`,
            );
            continue;
          }
          const content = fs.readFileSync(source.path, "utf8");
          const parsed = parseRulesImport(content, source.path);
          const rules = Array.isArray((parsed as { rules?: unknown[] }).rules)
            ? (parsed as { rules: unknown[] }).rules
            : [];
          for (const rule of rules) {
            if (!rule || typeof rule !== "object") continue;
            importedRules.push({
              ...(rule as Record<string, unknown>),
              category: `${source.agent} instructions`,
              source: source.path,
            });
            const record = rule as Record<string, unknown>;
            const text = String(
              record.description ??
                record.natural_language_rule ??
                record.name ??
                "",
            ).trim();
            if (text) {
              candidates.push({
                text,
                action: "ask",
                agent: source.agent,
                label: source.label,
                path: source.path,
                scope: source.scope,
                agentKinds: source.agentKinds,
              });
            }
          }
        } catch (error) {
          startupLog(
            `instruction discovery skipped ${source.path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const policies = normalizePolicies({ rules: importedRules }, [], true);
      return {
        ok: true,
        policies,
        candidates,
        sources,
        count: policies.length,
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not scan agent instruction files.",
      };
    }
  },
);
ipcMain.handle(
  "openleash:resolve",
  async (
    _event,
    id: string,
    resolution: "allow" | "deny",
    resolutionGuidance?: string,
    rememberForMs?: number,
    responsePayload?: Record<string, unknown>,
  ) => resolveDecision(id, resolution, resolutionGuidance, rememberForMs, responsePayload),
);
ipcMain.handle("openleash:dismiss-notice", () => {
  dismissNoticeByUser();
});
ipcMain.handle("openleash:resize-notice", (_event, requestedSize: number | NoticeWindowSize) => {
  if (!noticeWindow || noticeWindow.isDestroyed()) return { ok: false };
  const { width, height } = clampNoticeWindowSize(requestedSize, noticeWindow.getBounds().width);
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
  const windowBounds = {
    x: Math.round(display.x + (display.width - width) / 2),
    y: Math.round(display.y + (process.platform === "darwin" ? 0 : 10)),
    width,
    height,
  };
  noticeWindow.setBounds(windowBounds);
  const interactiveBounds = typeof requestedSize === "object" ? requestedSize.interactiveBounds : undefined;
  noticeWindow.setIgnoreMouseEvents(
    !isPointInNoticeBounds(screen.getCursorScreenPoint(), windowBounds, interactiveBounds),
    { forward: true },
  );
  return { ok: true };
});
ipcMain.handle("openleash:set-notice-pointer-inside", (event, inside: unknown) => {
  if (!noticeWindow || noticeWindow.isDestroyed() || event.sender !== noticeWindow.webContents)
    return { ok: false };
  noticeWindow.setIgnoreMouseEvents(!Boolean(inside), { forward: true });
  return { ok: true };
});
ipcMain.handle("openleash:jump-to-agent", async (_event, payload: AgentSessionFocusTarget & { session?: AgentSessionFocusTarget }) => {
  return openAgentApplication(payload?.session ?? payload);
});
ipcMain.handle("openleash:restart-agent-targets", async (_event, payload: unknown) => {
  const targetIds = payload && typeof payload === "object" && Array.isArray((payload as { targetIds?: unknown[] }).targetIds)
    ? (payload as { targetIds: unknown[] }).targetIds.map(String)
    : [];
  return restartRunningAgentTargets(targetIds, [...enforcedAgentKinds]);
});
ipcMain.handle("openleash:set-session-monitoring", async (_event, payload: unknown) => {
  return setSessionMonitoring(payload);
});
ipcMain.handle("openleash:set-project-protection", async (_event, payload: unknown) => {
  return setProjectProtection(payload);
});
ipcMain.handle("openleash:plugin-island-action", async (_event, payload: unknown) => {
  return handlePluginIslandAction(payload);
});
ipcMain.handle("openleash:island-command", async (_event, command: unknown) => {
  return handleIslandCommand(String(command ?? ""));
});

async function resolveDecision(
  id: string,
  resolution: "allow" | "deny",
  resolutionGuidance?: string,
  rememberForMs?: number,
  responsePayload?: Record<string, unknown>,
) {
  const pending = latestPending.find((item) => item.id === id)
    ?? latestPendingSources.find((item) => item.id === id);
  if (pending && Number(rememberForMs) > 0) {
    rememberedApprovalChoices.set(rememberedDecisionKey(pending), {
      resolution,
      expiresAt: Date.now() + Math.min(Number(rememberForMs), 5 * 60_000),
    });
  }
  const noticeKey = pending ? decisionNoticeKey(pending) : activeNoticeKey;
  if (noticeKey) suppressedNoticeKeys.add(noticeKey);
  const idsToResolve = matchingPendingSourceIds(
    pending,
    latestPendingSources,
    pendingNoticeKey,
    id,
  );
  for (const decisionId of idsToResolve) resolvingDecisionIds.add(decisionId);
  let resolvedLocally = false;
  for (const decisionId of idsToResolve) {
    resolvedLocally = Boolean(localServer.resolve(
      decisionId,
      resolution,
      resolutionGuidance,
      responsePayload,
    )) || resolvedLocally;
  }
  const pendingSkillPath = skillPathFromPendingDecision(pending)
    ?? skillPathFromDecisionResponse(responsePayload);
  if (pendingSkillPath) {
    resolvedLocally = localServer.resolveObservedSkill(
      pendingSkillPath,
      resolution,
    ) || resolvedLocally;
  }
  if (!resolvedLocally && !localServer.remoteApiUrl)
    startupLog(`approval resolve did not match a local decision for ${pending ? pendingNoticeKey(pending) : id}`);
  closeNoticeWithoutOpeningMainWindow();
  latestPending = latestPending.filter((item) => !idsToResolve.includes(item.id));
  latestPendingSources = latestPendingSources.filter((item) => !idsToResolve.includes(item.id));
  setTimeout(() => syncActivityIsland(true), 180);
  refreshMenu();
  window?.webContents.send("openleash:update", {
    apiUrl,
    pending: latestPending,
    agents: latestAgents,
    sessionMetrics: latestSessionMetrics,
    plugins: latestPlugins,
    outcomes: latestOutcomes,
    viewModel: latestViewModel,
    history: localServer.history,
    mcpServers: localServer.mcpServers,
    skills: localServer.skills,
  });
  void Promise.allSettled(
    idsToResolve.map((decisionId) =>
      syncRemoteDecision(decisionId, resolution, resolutionGuidance, responsePayload),
    ),
  )
    .then((results) => {
      if (localServer.remoteApiUrl && results.every((result) => result.status === "rejected"))
        startupLog(`remote approval resolve failed for ${pending ? pendingNoticeKey(pending) : id}`);
    })
    .finally(() => {
      for (const decisionId of idsToResolve) resolvingDecisionIds.delete(decisionId);
    });
  setTimeout(() => {
    if (noticeKey) suppressedNoticeKeys.delete(noticeKey);
  }, 5 * 60_000);
  return { ok: true };
}

function skillPathFromPendingDecision(pending?: PendingDecision) {
  if (!pending?.payload || typeof pending.payload !== "object") return undefined;
  const skillPath = (pending.payload as Record<string, unknown>).skillPath;
  return typeof skillPath === "string" && skillPath.trim()
    ? skillPath
    : undefined;
}

function skillPathFromDecisionResponse(response?: Record<string, unknown>) {
  const skillPath = response?.skillPath;
  return typeof skillPath === "string" && skillPath.trim()
    ? skillPath
    : undefined;
}

async function poll() {
  if (pollInFlight) {
    pollQueued = true;
    return;
  }
  pollInFlight = true;
  try {
    ensureRemoteClientEventStream();
    await refreshLocalProtections();
    syncSkillWatchers();
    const body = await fetchTrayState();
    if (!body) return setDisconnected();
    const billing = localServer.clientMode === "cloud" && localServer.remoteApiUrl && localServer.effectiveToken
      ? await fetchCloudBilling(localServer.remoteApiUrl, localServer.effectiveToken)
      : undefined;
    const backgroundControlApprovals = body.pending.filter(isBackgroundControlPending);
    for (const item of backgroundControlApprovals) {
      if (resolvingDecisionIds.has(item.id)) continue;
      resolvingDecisionIds.add(item.id);
      localServer.resolve(item.id, "deny", "Ignored private agent UI traffic.");
      void syncRemoteDecision(item.id, "deny", "Ignored private agent UI traffic.")
        .finally(() => resolvingDecisionIds.delete(item.id));
    }
    const userPending = body.pending.filter((item) => !isBackgroundControlPending(item));
    applyRememberedApprovalChoices(userPending);
    latestPendingSources = userPending.filter(
      (item) =>
        !resolvingDecisionIds.has(item.id) &&
        !suppressedNoticeKeys.has(decisionNoticeKey(item)),
    );
    latestPending = dedupePending(latestPendingSources, latestPending);
    latestAgents = body.agents;
    latestSessionMetrics = body.sessionMetrics ?? {};
    latestPlugins = body.plugins;
    localServer.syncPlugins(latestPlugins);
    pluginContainerFingerprint = pluginFingerprint(latestPlugins);
    latestOutcomes = body.outcomes ?? [];
    latestViewModel = body.viewModel ?? latestViewModel;
    if (typeof body.managedByOrganization === "boolean")
      monitoringManagedByOrganization = body.managedByOrganization;
    if (Array.isArray(body.sessionMonitoringPauses)) {
      localServer.replaceSessionMonitoringPauses(
        body.sessionMonitoringPauses.flatMap((pause) => {
          const expiresAt = Date.parse(pause.expiresAt);
          return Number.isFinite(expiresAt)
            ? [{
                agentKind: pause.agentKind,
                sessionIds: pausableSessionIds(pause.sessionIds),
                expiresAt,
              }]
            : [];
        }),
      );
    }
    latestAttentionEvents = body.attentionEvents ?? [];
    rememberCompletedAgentSessions(latestAttentionEvents);
    latestIslandContributions = body.islandContributions ?? [];
    presentCloudTrialStatus(billing);
    setTrayStatus(
      body.availability?.degraded
        ? "down"
        : latestPending.length > 0
          ? "pending"
          : "ok",
    );
    refreshMenu();
    window?.webContents.send("openleash:update", {
      apiUrl,
      cloudApiUrl,
      mode: localServer.setupComplete ? "settings" : "setup",
      setupComplete: localServer.setupComplete,
      introSeen: localServer.introSeen,
      clientMode: localServer.clientMode,
      remoteApiUrl: localServer.remoteApiUrl,
      remoteOrganization: localServer.remoteOrganization,
      remoteUser: localServer.remoteUser,
      apiProvider: localServer.apiProvider ?? "openai",
      apiKeySet: localServer.apiKeySet,
      agentDoneSound: localServer.agentDoneSound,
      islandVisibility: localServer.islandVisibility,
      islandActivityOnly: localServer.islandActivityOnly,
      plugins: latestPlugins,
      outcomes: latestOutcomes,
      viewModel: latestViewModel,
      activitySummary: latestActivitySummary,
      pending: latestPending,
      agents: latestAgents,
      sessionMetrics: latestSessionMetrics,
      localProtections,
      policies: localServer.policies,
      history: latestRemoteHistory.length
        ? latestRemoteHistory
        : localServer.history,
      mcpServers: localServer.mcpServers,
      skills: localServer.skills,
      billing,
      availability: body.availability,
    });
    const nextPending = latestPending[0];
    if (nextPending) {
      const key = decisionNoticeKey(nextPending);
      if (!suppressedNoticeKeys.has(key)) syncActivityIsland(false, nextPending);
    } else if (activeNoticeKey?.startsWith("ask:")) {
      noticeWindow?.close();
      noticeWindow = undefined;
      activeNoticeKey = undefined;
    } else if (
      !noticeWindow ||
      noticeWindow.isDestroyed() ||
      !noticeWindow.isVisible()
    ) {
      const attention = latestAttentionEvents
        .filter((event) => event.state !== "waiting")
        .filter((event) => !seenAttentionEventIds.has(event.id))
        .filter((event) => new Date(event.createdAt).getTime() >= desktopStartedAt - 5_000)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
      if (attention) {
        seenAttentionEventIds.add(attention.id);
        showDecisionNotice({ kind: "attention", event: attention });
        if (
          localServer.agentDoneSound &&
          (attention.kind === "completed" || attention.kind === "subagent_completed")
        ) {
          playAgentDoneSound();
        }
      } else if (!activeNoticeKey || activeNoticeKey.startsWith("activity:")) {
        syncActivityIsland();
      }
    } else if (activeNoticeKey?.startsWith("activity:")) {
      syncActivityIsland();
    }
  } catch {
    await refreshLocalProtections();
    setDisconnected();
  } finally {
    pollInFlight = false;
    if (pollQueued) {
      pollQueued = false;
      void poll();
    }
  }
}

function ensureRemoteClientEventStream() {
  const remoteApiUrl = localServer.remoteApiUrl;
  const remoteToken = localServer.effectiveToken;
  const key =
    remoteApiUrl && remoteToken
      ? `${remoteApiUrl}\n${remoteToken}`
      : "";
  if (key === remoteClientEventStreamKey) return;
  remoteClientEventStreamKey = key;
  remoteClientEventStreamAbort?.abort();
  remoteClientEventStreamAbort = undefined;
  if (remoteClientEventRetry) clearTimeout(remoteClientEventRetry);
  remoteClientEventRetry = undefined;
  if (!key || !remoteApiUrl || !remoteToken) return;
  void connectRemoteClientEventStream(key, remoteApiUrl, remoteToken);
}

async function connectRemoteClientEventStream(
  key: string,
  remoteApiUrl: string,
  remoteToken: string,
) {
  const controller = new AbortController();
  remoteClientEventStreamAbort = controller;
  try {
    const response = await fetch(new URL("/v1/client/events", remoteApiUrl), {
      headers: {
        authorization: `Bearer ${remoteToken}`,
        accept: "text/event-stream",
        ...apiVersionHeaders("clientEvents"),
      },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`live event stream returned HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split(/\r?\n\r?\n/);
      buffered = frames.pop() ?? "";
      if (frames.some((frame) => frame.split(/\r?\n/).some((line) => line.startsWith("data:")))) {
        void poll();
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      startupLog(
        `live client event stream disconnected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    if (remoteClientEventStreamAbort === controller)
      remoteClientEventStreamAbort = undefined;
    if (
      !controller.signal.aborted &&
      remoteClientEventStreamKey === key &&
      !remoteClientEventRetry
    ) {
      remoteClientEventRetry = setTimeout(() => {
        remoteClientEventRetry = undefined;
        if (remoteClientEventStreamKey === key)
          void connectRemoteClientEventStream(key, remoteApiUrl, remoteToken);
      }, 2000);
    }
  }
}

function refreshPendingApprovalsSoon() {
  if (pendingRefreshTimers.size > 0) return;
  for (const delayMs of [
    100, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 7000, 10000, 15000,
    20000, 30000,
  ]) {
    const timer = setTimeout(() => {
      pendingRefreshTimers.delete(timer);
      void poll();
    }, delayMs);
    pendingRefreshTimers.add(timer);
  }
}

async function fetchTrayState(): Promise<
  | {
      pending: PendingDecision[];
      agents: AgentStatus[];
      sessionMetrics?: SessionMetrics;
      availability?: LocalAvailabilityState;
      attentionEvents?: AttentionEvent[];
      islandContributions?: PluginIslandContribution[];
      plugins: PluginCatalogItem[];
      outcomes?: PluginOutcome[];
      viewModel?: OpenLeashClientViewModel;
      managedByOrganization?: boolean;
      sessionMonitoringPauses?: Array<{
        agentKind: string;
        sessionIds: string[];
        expiresAt: string;
      }>;
    }
  | undefined
> {
  const localState = await fetchLocalTrayState();

  const remoteApiUrl = localServer.remoteApiUrl;
  const remoteToken = localServer.effectiveToken;
  if (!remoteApiUrl || !remoteToken) {
    latestActivitySummary = undefined;
    latestActivitySummaryKey = "";
    return localState;
  }
  const activitySummaryKey = `${remoteApiUrl}\0${remoteToken}`;
  if (latestActivitySummaryKey !== activitySummaryKey) {
    latestActivitySummary = undefined;
    latestActivitySummaryKey = activitySummaryKey;
  }

  try {
    const notifications = await fetchRemoteNotifications(
      remoteApiUrl,
      remoteToken,
    );
    if (notifications?.pending.length) {
      // A waiting approval is the latency-sensitive path, but it must not make
      // the desktop fall back to its bundled/stale plugin catalog. Doing so
      // immediately after setup makes successfully installed plugins appear
      // uninstalled and can reconcile their containers against the wrong
      // state. Refresh the account-owned plugin state even when we skip the
      // larger mobile-state request.
      const [plugins, outcomes] = await Promise.all([
        fetchRemotePluginCatalog(
          remoteApiUrl,
          remoteToken,
          localState?.plugins ?? latestPlugins,
        ),
        fetchRemotePluginOutcomes(remoteApiUrl, remoteToken),
      ]);
      return mergeTrayState(
        localState,
        notifications,
        plugins,
        outcomes,
      );
    }

    const [stateResponse, plugins, outcomes] = await Promise.all([
      fetch(new URL("/v1/mobile/state", remoteApiUrl), {
        headers: {
          authorization: `Bearer ${remoteToken}`,
          ...apiVersionHeaders("mobileState"),
        },
      }),
      fetchRemotePluginCatalog(
        remoteApiUrl,
        remoteToken,
        localState?.plugins ?? [],
      ),
      fetchRemotePluginOutcomes(remoteApiUrl, remoteToken),
    ]);
    if (!stateResponse.ok) {
      return notifications
        ? mergeTrayState(localState, notifications, plugins, outcomes)
        : localState
          ? { ...localState, plugins, outcomes }
          : undefined;
    }
    const remoteState = mapRemoteMobileState(
      (await stateResponse.json()) as RemoteMobileState,
    );
    remoteState.attentionEvents = notifications?.attentionEvents ?? [];
    remoteState.islandContributions = notifications?.islandContributions ?? remoteState.islandContributions ?? [];
    return mergeTrayState(
      localState,
      remoteState,
      plugins,
      outcomes,
    );
  } catch {
    return localState;
  }
}

async function fetchLocalTrayState() {
  const response = await fetch(`${apiUrl}/admin/tray-status`, {
    headers: {
      authorization: `Bearer ${localServer.token}`,
      ...apiVersionHeaders("tenantTrayStatus"),
    },
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as {
    pending: PendingDecision[];
    agents: AgentStatus[];
    session_metrics?: SessionMetrics;
    sessionMetrics?: SessionMetrics;
    availability?: LocalAvailabilityState;
  };
  return {
    pending: body.pending,
    agents: body.agents,
    sessionMetrics: body.session_metrics ?? body.sessionMetrics,
    availability: body.availability,
    plugins: localServer.plugins,
    outcomes: latestOutcomes,
    viewModel: latestViewModel,
  };
}

async function fetchRemoteNotifications(
  remoteApiUrl: string,
  remoteToken: string,
): Promise<
  | {
      pending: PendingDecision[];
      agents: AgentStatus[];
      sessionMetrics?: SessionMetrics;
      attentionEvents?: AttentionEvent[];
      islandContributions?: PluginIslandContribution[];
    }
  | undefined
> {
  try {
    const response = await fetch(
      new URL("/v1/client/notifications", remoteApiUrl),
      {
        headers: {
          authorization: `Bearer ${remoteToken}`,
          ...apiVersionHeaders("clientNotifications"),
        },
      },
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as RemoteMobileState;
    latestRemoteHistory = Array.isArray(body.recentActivity)
      ? body.recentActivity
      : latestRemoteHistory;
    return mapRemoteMobileState(body);
  } catch {
    return undefined;
  }
}

async function fetchRemotePluginCatalog(
  remoteApiUrl: string,
  remoteToken: string,
  fallback: PluginCatalogItem[],
) {
  try {
    const response = await fetch(new URL("/v1/plugins", remoteApiUrl), {
      headers: {
        authorization: `Bearer ${remoteToken}`,
        ...apiVersionHeaders("tenantPluginsRead"),
      },
    });
    if (!response.ok) return fallback;
    const body = (await response.json()) as { plugins?: PluginCatalogItem[] };
    return Array.isArray(body.plugins) ? body.plugins : fallback;
  } catch {
    return fallback;
  }
}

type RemotePluginRuntimeVerification = {
  ok: boolean;
  plugins?: Array<{
    pluginId: string;
    healthy: boolean;
    protocolVerified: boolean;
    checks: string[];
    error?: string;
  }>;
  error?: string;
};

async function verifyRemotePluginRuntimes(
  remoteApiUrl: string,
  remoteToken: string,
): Promise<RemotePluginRuntimeVerification> {
  try {
    const response = await fetch(
      new URL("/v1/plugin-runtime/verify", remoteApiUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${remoteToken}`,
          ...apiVersionHeaders("tenantPluginsRead"),
        },
        signal: AbortSignal.timeout(
          Number(
            process.env.OPENLEASH_DESKTOP_PLUGIN_VERIFY_TIMEOUT_MS ?? 180000,
          ),
        ),
      },
    );
    const body = await response.json().catch(() => ({})) as RemotePluginRuntimeVerification;
    if (!response.ok || body.ok !== true) {
      const failed = (body.plugins ?? [])
        .filter((plugin) => !plugin.protocolVerified)
        .map((plugin) => `${plugin.pluginId}: ${plugin.error || "verification failed"}`);
      return {
        ok: false,
        plugins: body.plugins,
        error: failed.join("; ") || body.error || `backend returned HTTP ${response.status}`,
      };
    }
    return body;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error
        ? error.message
        : "Could not reach the managed plugin runtime.",
    };
  }
}

function withDevelopmentPluginImage(plugin: PluginCatalogItem): PluginCatalogItem {
  if (
    process.env.OPENLEASH_DEV_PLUGIN_IMAGES !== "1" ||
    plugin.publisher !== "openleash" ||
    plugin.id === "openleash.prompt-compression" ||
    plugin.execution?.type !== "container"
  ) return plugin;
  const slug = plugin.slug || plugin.id.replace(/^openleash\./, "");
  return {
    ...plugin,
    execution: {
      ...plugin.execution,
      image: `openleash/plugin-${slug}:dev`,
      digest: undefined,
    },
  };
}

async function mergePublicCloudPluginCatalog(plugins: PluginCatalogItem[]) {
  try {
    const response = await fetch(
      new URL("/public/plugins", cloudApiUrl),
      {
        headers: apiVersionHeaders("tenantPluginsRead"),
      },
    );
    if (!response.ok) return plugins;
    const body = (await response.json()) as {
      listings?: PublicPluginListing[];
    };
    if (!Array.isArray(body.listings)) return plugins;
    const listings = new Map<string, PublicPluginListing>();
    for (const listing of body.listings) {
      const id = optionalText(listing.id);
      if (id) listings.set(id, listing);
    }
    const merged = plugins.map((plugin) => {
      const listing = listings.get(plugin.id);
      if (!listing) return plugin;
      const version = optionalText(listing.version);
      return {
        ...plugin,
        slug: plugin.slug ?? optionalText(listing.slug),
        repositoryUrl:
          plugin.repositoryUrl ?? optionalText(listing.repositoryUrl),
        marketplace: listing,
        settings: {
          ...plugin.settings,
          availableVersion: version ?? plugin.settings?.availableVersion,
          updateAvailable: Boolean(
            plugin.settings?.enabled &&
            plugin.settings?.installedVersion &&
            version &&
            plugin.settings.installedVersion !== version,
          ),
        },
      } as PluginCatalogItem;
    });
    const existingIds = new Set(merged.map((plugin) => plugin.id));
    for (const listing of listings.values()) {
      const item = publicListingToPluginCatalogItem(listing);
      if (!item || existingIds.has(item.id)) continue;
      existingIds.add(item.id);
      merged.push(item);
    }
    return merged;
  } catch {
    return plugins;
  }
}

function publicListingToPluginCatalogItem(
  listing: PublicPluginListing,
): PluginCatalogItem | undefined {
  const id = optionalText(listing.id);
  const name = optionalText(listing.name) || optionalText(listing.slug) || id;
  const description =
    optionalText(listing.description) ||
    optionalText(listing.shortDescription) ||
    "Leash plugin.";
  const version = optionalText(listing.version) || "0.0.0";
  const publisher = optionalText(listing.publisher) || "openleash";
  const runtime = optionalText(listing.runtime);
  const entrypoint = optionalText(listing.entrypoint) || "";
  const execution = containerExecutionFromListing(listing.execution);
  if (!id || !name || runtime !== "container" || entrypoint !== "container" || !execution) return undefined;
  return {
    id,
    slug: optionalText(listing.slug),
    name,
    description,
    repositoryUrl: optionalText(listing.repositoryUrl),
    version,
    publisher,
    runtime,
    execution,
    entrypoint,
    events: Array.isArray(listing.events)
      ? (listing.events as PluginCatalogItem["events"])
      : [],
    permissions: Array.isArray(listing.permissions)
      ? (listing.permissions as PluginCatalogItem["permissions"])
      : [],
    effects: Array.isArray(listing.effects)
      ? (listing.effects as PluginCatalogItem["effects"])
      : [],
    ordering:
      typeof listing.ordering === "object" && listing.ordering
        ? (listing.ordering as PluginCatalogItem["ordering"])
        : undefined,
    configSchema:
      typeof listing.configSchema === "object" && listing.configSchema
        ? (listing.configSchema as PluginCatalogItem["configSchema"])
        : undefined,
    defaultConfig:
      typeof listing.defaultConfig === "object" && listing.defaultConfig
        ? (listing.defaultConfig as Record<string, unknown>)
        : {},
    tags: Array.isArray(listing.tags) ? (listing.tags as string[]) : [],
    marketplace: listing,
    settings: {
      enabled: false,
      config:
        typeof listing.defaultConfig === "object" && listing.defaultConfig
          ? (listing.defaultConfig as Record<string, unknown>)
          : {},
      orderingPriority:
        typeof listing.ordering?.priority === "number"
          ? listing.ordering.priority
          : null,
      availableVersion: version,
      updatePolicy: "manual",
    },
    organizationPolicy: {
      mandatory: false,
      defaultEnabled: false,
      userInstallAllowed: true,
      configLocked: false,
    },
  } as PluginCatalogItem;
}

async function readLocalPluginFolderListing(
  folderPath: string,
): Promise<PublicPluginListing> {
  const stat = fs.statSync(folderPath);
  if (!stat.isDirectory()) throw new Error("Choose a plugin folder.");
  const manifest = readLocalPluginManifestJson(folderPath);
  if (!manifest) {
    throw new Error(
      "No OpenLeash plugin manifest found. Add openleash.plugin.json, plugin.json, manifest.json, or package.json with an openleash/openleashPlugin field.",
    );
  }
  const id = optionalText(manifest.id);
  const name = optionalText(manifest.name) || optionalText(manifest.slug) || id;
  const description =
    optionalText(manifest.description) ||
    optionalText(manifest.shortDescription);
  const version = optionalText(manifest.version);
  const runtime = optionalText(manifest.runtime);
  const entrypoint = optionalText(manifest.entrypoint);
  if (!id || !name || !description || !version || !runtime || !entrypoint) {
    throw new Error(
      "Plugin manifest must include id, name, description, version, runtime, and entrypoint.",
    );
  }
  if (runtime !== "container" || entrypoint !== "container" || !containerExecutionFromListing(manifest.execution)) {
    throw new Error(
      "Leash plugins must use the container runtime and provide execution.image, execution.protocol, and execution.eventPath.",
    );
  }
  const slug = slugifyLocalPlugin(optionalText(manifest.slug) || name || id);
  const publisher = optionalText(manifest.publisher) || "local";
  const shortDescription =
    optionalText(manifest.shortDescription) || description;
  return {
    ...manifest,
    id,
    slug,
    name,
    description,
    version,
    publisher,
    runtime,
    entrypoint,
    source: "private",
    reviewStatus: "approved",
    developerName:
      optionalText(manifest.developerName) ||
      (publisher === "openleash" ? "Leash" : "Local"),
    shortDescription,
    longDescription: optionalText(manifest.longDescription) || description,
    heroTagline: optionalText(manifest.heroTagline) || shortDescription,
    packageUrl: `file:${folderPath}`,
    repositoryUrl: optionalText(manifest.repositoryUrl),
    documentationUrl: optionalText(manifest.documentationUrl),
    iconText:
      optionalText(manifest.iconText) || slug.slice(0, 2).toUpperCase() || "OL",
    visualPng: optionalText(manifest.visualPng),
    events: Array.isArray(manifest.events) ? manifest.events : [],
    permissions: Array.isArray(manifest.permissions)
      ? manifest.permissions
      : [],
    effects: Array.isArray(manifest.effects) ? manifest.effects : [],
    ordering:
      typeof manifest.ordering === "object" && manifest.ordering
        ? (manifest.ordering as Record<string, unknown>)
        : undefined,
    configSchema:
      typeof manifest.configSchema === "object" && manifest.configSchema
        ? (manifest.configSchema as Record<string, unknown>)
        : undefined,
    defaultConfig:
      typeof manifest.defaultConfig === "object" && manifest.defaultConfig
        ? (manifest.defaultConfig as Record<string, unknown>)
        : {},
    tags: Array.isArray(manifest.tags) ? manifest.tags : [],
    seoTitle: optionalText(manifest.seoTitle) || `${slug} Plugin for OpenLeash`,
    seoDescription:
      optionalText(manifest.seoDescription) ||
      `Install ${slug} for OpenLeash. ${shortDescription}`,
  };
}

function containerExecutionFromListing(value: unknown): PluginCatalogItem["execution"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const execution = value as Record<string, unknown>;
  if (
    execution.type !== "container" ||
    execution.protocol !== "openleash-container-plugin.v1" ||
    !optionalText(execution.image) ||
    !optionalText(execution.eventPath)
  ) return undefined;
  const placement = optionalText(execution.placement);
  if (!placement || !["edge", "server", "either"].includes(placement)) return undefined;
  return execution as PluginCatalogItem["execution"];
}

function readLocalPluginManifestJson(
  folderPath: string,
): Record<string, unknown> | undefined {
  for (const name of [
    "openleash.plugin.json",
    "plugin.json",
    "manifest.json",
  ]) {
    const filePath = path.join(folderPath, name);
    if (!fs.existsSync(filePath)) continue;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
      string,
      unknown
    >;
  }
  const packagePath = path.join(folderPath, "package.json");
  if (!fs.existsSync(packagePath)) return undefined;
  const packageJson = JSON.parse(
    fs.readFileSync(packagePath, "utf8"),
  ) as Record<string, unknown>;
  const embedded = packageJson.openleashPlugin ?? packageJson.openleash;
  if (embedded && typeof embedded === "object") {
    return {
      ...(embedded as Record<string, unknown>),
      name:
        optionalText((embedded as Record<string, unknown>).name) ||
        optionalText(packageJson.name),
      version:
        optionalText((embedded as Record<string, unknown>).version) ||
        optionalText(packageJson.version),
    };
  }
  return undefined;
}

function slugifyLocalPlugin(value: string) {
  return value
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/^plugin-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function optionalText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

async function fetchRemotePluginOutcomes(
  remoteApiUrl: string,
  remoteToken: string,
) {
  try {
    const url = new URL("/v1/client/overview", remoteApiUrl);
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${remoteToken}`,
      },
    });
    if (!response.ok) return latestOutcomes;
    const body = (await response.json()) as {
      outcomes?: PluginOutcome[];
      viewModel?: OpenLeashClientViewModel;
      activitySummary?: DashboardActivitySummary;
    };
    latestViewModel = body.viewModel ?? latestViewModel;
    latestActivitySummary = body.activitySummary ?? latestActivitySummary;
    return Array.isArray(body.outcomes) ? body.outcomes : latestOutcomes;
  } catch {
    return latestOutcomes;
  }
}

function mergeTrayState(
  localState:
    | {
        pending: PendingDecision[];
        agents: AgentStatus[];
        sessionMetrics?: SessionMetrics;
        availability?: LocalAvailabilityState;
        plugins: PluginCatalogItem[];
        outcomes?: PluginOutcome[];
        viewModel?: OpenLeashClientViewModel;
        attentionEvents?: AttentionEvent[];
        islandContributions?: PluginIslandContribution[];
        managedByOrganization?: boolean;
        sessionMonitoringPauses?: Array<{
          agentKind: string;
          sessionIds: string[];
          expiresAt: string;
        }>;
      }
    | undefined,
  remoteState: {
    pending: PendingDecision[];
    agents: AgentStatus[];
    sessionMetrics?: SessionMetrics;
    attentionEvents?: AttentionEvent[];
    islandContributions?: PluginIslandContribution[];
    managedByOrganization?: boolean;
    sessionMonitoringPauses?: Array<{
      agentKind: string;
      sessionIds: string[];
      expiresAt: string;
    }>;
  },
  plugins: PluginCatalogItem[],
  outcomes: PluginOutcome[] = [],
) {
  if (!localState)
    return { ...remoteState, plugins, outcomes, viewModel: latestViewModel };
  return {
    pending: [...localState.pending, ...remoteState.pending],
    agents: dedupeById([...localState.agents, ...remoteState.agents]),
    sessionMetrics: remoteState.sessionMetrics ?? localState.sessionMetrics,
    availability: localState.availability,
    attentionEvents: dedupeById([
      ...(remoteState.attentionEvents ?? []),
      ...(localState.attentionEvents ?? []),
    ]),
    islandContributions: remoteState.islandContributions ?? localState.islandContributions ?? [],
    managedByOrganization:
      remoteState.managedByOrganization ?? localState.managedByOrganization,
    sessionMonitoringPauses:
      remoteState.sessionMonitoringPauses ?? localState.sessionMonitoringPauses,
    plugins,
    outcomes,
    viewModel: latestViewModel ?? localState.viewModel,
  };
}

function dedupeById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function dedupePending(items: PendingDecision[], previous: PendingDecision[] = []) {
  return preferPreviouslyPresentedPending(items, previous, pendingNoticeKey);
}

function pendingNoticeKey(item: PendingDecision) {
  return (
    canonicalIntentKey(rawIntentKey(item.payload)) ??
    credentialPendingKey(item) ??
    stablePendingIntentKey({
      agentKind: item.agent_kind,
      projectPath: item.project_path,
      prompt: requestText(item.payload),
      toolName: item.tool_name,
      eventName: item.event_name,
      summary: item.summary,
    })
  );
}

function decisionNoticeKey(item: PendingDecision) {
  return approvalPresentationKey(pendingNoticeKey(item), item.id);
}

function rememberedDecisionKey(item: PendingDecision) {
  return `${pendingNoticeKey(item)}|plugin:${noticePluginName(item).toLowerCase()}`;
}

function applyRememberedApprovalChoices(items: PendingDecision[]) {
  const now = Date.now();
  for (const [key, choice] of rememberedApprovalChoices) {
    if (choice.expiresAt <= now) rememberedApprovalChoices.delete(key);
  }
  const appliedIntents = new Set<string>();
  for (const item of items) {
    if (resolvingDecisionIds.has(item.id)) continue;
    const choice = rememberedApprovalChoices.get(rememberedDecisionKey(item));
    if (!choice || choice.expiresAt <= now) continue;
    const intentKey = pendingNoticeKey(item);
    if (appliedIntents.has(intentKey)) continue;
    appliedIntents.add(intentKey);
    const sourceIds = matchingPendingSourceIds(item, items, pendingNoticeKey, item.id);
    for (const sourceId of sourceIds) {
      resolvingDecisionIds.add(sourceId);
      localServer.resolve(sourceId, choice.resolution);
    }
    startupLog(
      `remembered approval ${choice.resolution} applied to ${intentKey}`,
    );
    void Promise.allSettled(
      sourceIds.map((sourceId) => syncRemoteDecision(sourceId, choice.resolution)),
    ).finally(() => {
      for (const sourceId of sourceIds) resolvingDecisionIds.delete(sourceId);
    });
  }
}

function credentialPendingKey(item: PendingDecision) {
  const resource = primaryPendingResource(item);
  if (!resource) return undefined;
  return [
    item.agent_kind,
    item.project_path ?? "",
    "credential",
    resource,
  ].join("|");
}

function rawIntentKey(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const raw = record.raw;
  if (raw && typeof raw === "object") {
    const intentKey = (raw as Record<string, unknown>).openleashIntentKey;
    if (typeof intentKey === "string" && intentKey.trim()) return intentKey;
  }
  const intentKey = record.openleashIntentKey;
  return typeof intentKey === "string" && intentKey.trim()
    ? intentKey
    : undefined;
}

function canonicalIntentKey(intentKey?: string) {
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

function primaryPendingResource(item: PendingDecision) {
  const text = `${item.question ?? ""} ${item.summary ?? ""} ${JSON.stringify(item.payload ?? {})}`;
  if (/\.env(?:\b|["'\\/\s])/.test(text)) return ".env";
  return "";
}

function mapRemoteMobileState(state: RemoteMobileState): {
  pending: PendingDecision[];
  agents: AgentStatus[];
  sessionMetrics?: SessionMetrics;
  attentionEvents?: AttentionEvent[];
  islandContributions?: PluginIslandContribution[];
  managedByOrganization?: boolean;
  sessionMonitoringPauses?: Array<{
    agentKind: string;
    sessionIds: string[];
    expiresAt: string;
  }>;
} {
  const employeeNotificationsEnabled =
    state.clientConfig?.approvalNotifications !== false;
  return {
    pending: (employeeNotificationsEnabled ? state.pendingApprovals ?? [] : []).map((item) => ({
      id: item.id,
      question: item.question,
      summary: item.summary ?? item.question ?? "Leash approval needed.",
      agent_name: item.agent_name ?? "AI agent",
      agent_kind: item.agent_kind ?? "unknown",
      hostname: item.hostname ?? "cloud",
      user_name: item.user_name,
      event_name: item.event_name ?? "approval",
      tool_name: item.tool_name,
      project_path: item.project_path,
      payload: item.payload,
      triggered_policies: item.triggered_policies,
      purpose_summary: item.purpose_summary,
      recent_context: item.recent_context,
      plugin_id: item.plugin_id,
      plugin_name: item.plugin_name,
      quote: item.quote,
      created_at: item.created_at ?? new Date().toISOString(),
    })),
    agents: (state.agents ?? []).map((agent) => ({
      id: agent.id,
      kind: agent.kind ?? "unknown",
      display_name: agent.display_name ?? "AI agent",
      hostname: agent.hostname ?? agent.platform ?? "cloud",
      last_seen_at: agent.last_seen_at,
      event_name: agent.event_name,
      tool_name: agent.tool_name,
      project_path: agent.project_path,
      activity_at: agent.activity_at,
      decision: agent.decision,
      resolution: agent.resolution ?? null,
      question: agent.question,
      payload: agent.payload,
      triggered_policies: agent.triggered_policies,
      recent_activity: agent.recent_activity,
      sessions: agent.sessions,
      decision_summary: agent.decision_summary,
      short_summary:
        agent.short_summary ??
        agent.decision_summary ??
        friendlyAction(agent.event_name, agent.tool_name),
    })),
    sessionMetrics: mapRemoteSessionMetrics(state.sessionMetrics),
    attentionEvents: employeeNotificationsEnabled && Array.isArray(state.attentionEvents)
      ? state.attentionEvents
      : [],
    islandContributions: Array.isArray(state.islandContributions)
      ? state.islandContributions
      : [],
    managedByOrganization: Boolean(state.clientConfig?.managedByOrganization),
    sessionMonitoringPauses: (state.sessionMonitoringPauses ?? []).flatMap((pause) => {
      const agentKind = String(pause.agentKind ?? "").trim().toLowerCase();
      const sessionIds = pausableSessionIds(pause.sessionIds ?? []);
      const expiresAt = String(pause.expiresAt ?? "");
      return agentKind && sessionIds.length > 0 && Number.isFinite(Date.parse(expiresAt))
        ? [{ agentKind, sessionIds, expiresAt }]
        : [];
    }),
  };
}

function mapRemoteSessionMetrics(
  metrics: Record<string, unknown> | undefined,
): SessionMetrics | undefined {
  if (!metrics) return undefined;
  const numberValue = (key: string) => {
    const value = metrics[key];
    return typeof value === "number" ? value : Number(value ?? 0);
  };
  return {
    today: {
      session_count: numberValue("today_sessions"),
      duration_seconds: numberValue("today_seconds"),
    },
    last24h: {
      session_count: numberValue("last24h_sessions"),
      duration_seconds: numberValue("last24h_seconds"),
    },
    week: {
      session_count: numberValue("week_sessions"),
      duration_seconds: numberValue("week_seconds"),
    },
    month: {
      session_count: numberValue("month_sessions"),
      duration_seconds: numberValue("month_seconds"),
    },
  };
}

async function syncRemoteDecision(
  id: string,
  resolution: "allow" | "deny",
  resolutionGuidance?: string,
  responsePayload?: Record<string, unknown>,
) {
  const guidance =
    resolution === "deny"
      ? cleanResolutionGuidance(resolutionGuidance)
      : undefined;

  const remoteApiUrl = localServer.remoteApiUrl;
  const remoteToken = localServer.effectiveToken;
  if (!remoteApiUrl || !remoteToken) return;
  const response = await fetch(
    new URL(`/v1/mobile/decisions/${id}/resolve`, remoteApiUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${remoteToken}`,
        ...apiVersionHeaders("mobileDecisionResolve"),
      },
      body: JSON.stringify({
        resolution,
        ...(guidance ? { resolutionGuidance: guidance } : {}),
        ...(resolution === "allow" && responsePayload
          ? { response: responsePayload }
          : {}),
      }),
    },
  );
  if (!response.ok)
    throw new Error(`Leash could not resolve approval ${id}.`);
}

function cleanResolutionGuidance(value?: string) {
  const cleaned = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 500) : undefined;
}

function handleCliRuleImport() {
  const args = process.argv.slice(1);
  const importPath =
    readCliValue(args, "--import-rules") ?? readCliValue(args, "--rules");
  if (!importPath) return undefined;
  try {
    const input = JSON.parse(
      fs.readFileSync(path.resolve(importPath), "utf8"),
    ) as unknown;
    const replace =
      args.includes("--replace-rules") || args.includes("--rules-replace");
    const policies = localServer.importPolicies(input, replace);
    console.log(
      `Leash imported ${policies.length} rule${policies.length === 1 ? "" : "s"} from ${importPath}.`,
    );
    return {
      ok: true,
      exitAfter:
        args.includes("--quit-after-import") || args.includes("--no-ui"),
    };
  } catch (error) {
    console.error(
      `Leash rule import failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return { ok: false, exitAfter: true };
  }
}

async function handleCliUpdate() {
  const args = process.argv.slice(1);
  if (!args.includes("--update") && !args.includes("--check-for-updates"))
    return undefined;
  const autoInstall = args.includes("--yes") || args.includes("--install");
  const exitAfter =
    args.includes("--no-ui") ||
    args.includes("--quit-after-update") ||
    autoInstall;
  const ok = await checkForUpdates({
    source: "cli",
    force: true,
    autoInstall,
    silent: false,
  });
  return { ok, exitAfter };
}

function readCliValue(args: string[], name: string) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function tenantToApiUrl(tenant: string) {
  const trimmed = tenant.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

async function handleCliEnrollment() {
  const args = process.argv.slice(1);
  if (!args.includes("--enroll")) return undefined;
  const tenant =
    readCliValue(args, "--tenant") ??
    readCliValue(args, "--tenant-url") ??
    readCliValue(args, "--organization");
  const deploymentToken =
    readCliValue(args, "--token") ?? readCliValue(args, "--deployment-token");
  if (!tenant || !deploymentToken) {
    console.error("Leash enrollment requires --tenant and --token.");
    return { ok: false, exitAfter: true };
  }
  const enrollmentApiUrl =
    readCliValue(args, "--api-url") ?? tenantToApiUrl(tenant);
  try {
    const response = await fetch(new URL("/v1/enroll", enrollmentApiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...apiVersionHeaders("tenantEnroll"),
      },
      body: JSON.stringify({
        deploymentToken,
        email: readCliValue(args, "--email"),
        displayName:
          readCliValue(args, "--display-name") ?? os.userInfo().username,
        installIdentity: localServer.deviceIdentity(),
        hostname: os.hostname(),
        platform: os.platform(),
        osRelease: os.release(),
        mode: readCliValue(args, "--mode") ?? "cloud",
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.token) {
      console.error(
        `Leash enrollment failed: ${body.error ?? response.statusText}`,
      );
      return { ok: false, exitAfter: true };
    }
    localServer.completeSetup(localServer.policies, {
      clientMode:
        body.mode === "enterprise" || body.mode === "private"
          ? "custom"
          : "cloud",
      remoteApiUrl: body.apiUrl ?? enrollmentApiUrl,
      remoteToken: body.token,
      remoteOrganization: body.tenantUrl ?? tenant,
      remoteUser: body.user?.email ?? readCliValue(args, "--email"),
    });
    await configureLocalAgent();
    await installLeashCli();
    const selectedAgents = (readCliValue(args, "--agents") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (args.includes("--install-hooks") || selectedAgents.length > 0) {
      const agents =
        selectedAgents.length > 0 ? selectedAgents : ["claude-code"];
      for (const agent of agents) {
        await installAgentProtection(agent, hookInstallContext());
        enforcedAgentKinds.add(agent);
      }
    }
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
      name: APP_DISPLAY_NAME,
    });
    console.log(
      `Leash Client enrolled ${os.hostname()} with ${body.tenantUrl ?? tenant}.`,
    );
    return {
      ok: true,
      exitAfter:
        args.includes("--no-ui") || args.includes("--quit-after-configure"),
    };
  } catch (error) {
    console.error(
      `Leash enrollment failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return { ok: false, exitAfter: true };
  }
}

async function handleCliClientConfig() {
  const args = process.argv.slice(1);
  const configuredApiUrl = readCliValue(args, "--api-url");
  const configuredToken =
    readCliValue(args, "--token") ?? readCliValue(args, "--user-token");
  const configuredMode = readCliValue(args, "--mode") ?? "community";
  if (!configuredApiUrl && !configuredToken) return undefined;
  const clientApiUrl = configuredApiUrl ?? cloudApiUrl;
  const token = configuredToken ?? localServer.token;
  const dir = path.join(os.homedir(), ".openleash");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    `${JSON.stringify(
      {
        apiUrl: clientApiUrl,
        token,
        mode: configuredMode,
        clientVersion: app.getVersion(),
        enrolledAt: new Date().toISOString(),
        computer: {
          id: localServer.deviceIdentity(),
          hostname: os.hostname(),
        },
      },
      null,
      2,
    )}\n`,
  );
  localServer.completeSetup(localServer.policies, {
    clientMode:
      configuredMode === "cloud"
        ? "cloud"
        : configuredMode === "enterprise" || configuredMode === "custom"
          ? "custom"
          : "custom",
    remoteApiUrl: clientApiUrl,
    remoteToken: token,
    remoteOrganization:
      readCliValue(args, "--organization") ?? readCliValue(args, "--tenant"),
    remoteUser: readCliValue(args, "--user"),
  });
  await installLeashCli();
  const selectedAgents = (readCliValue(args, "--agents") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (args.includes("--install-hooks") || selectedAgents.length > 0) {
    const agents = selectedAgents.length > 0 ? selectedAgents : ["claude-code"];
    for (const agent of agents) {
      await installAgentProtection(agent, hookInstallContext());
      enforcedAgentKinds.add(agent);
    }
  }
  if (args.includes("--uninstall-hooks") || args.includes("--unhook")) {
    const agents =
      selectedAgents.length > 0
        ? selectedAgents
        : ["claude-code", "codex", "nanoclaw", "openclaw"];
    for (const agent of agents) {
      await unprotectAgentKind(agent);
    }
  }
  console.log(`Leash Client configured for ${clientApiUrl}.`);
  return {
    ok: true,
    exitAfter:
      args.includes("--no-ui") || args.includes("--quit-after-configure"),
  };
}

async function migrateLocalDevCloudTarget() {
  if (app.isPackaged || process.env.OPENLEASH_CLOUD_API_URL) return;
  if (localServer.clientMode !== "cloud" && localServer.clientMode !== "custom")
    return;
  const current = localServer.remoteApiUrl ?? "";
  if (current && !/^https:\/\/api\.openleash\.com\/?$/i.test(current)) return;
  if (!(await canReach(new URL("/health", localDevCloudApiUrl).toString())))
    return;

  localServer.updateRemoteApiUrl(localDevCloudApiUrl);
  await configureLocalAgent();

  const protectedAgents = detectLocalAgentProtections({
    appVersion: app.getVersion(),
  }).filter((agent) => agent.protected && agent.supportsInstall);
  for (const agent of protectedAgents) {
    await installAgentProtection(agent.kind, hookInstallContext());
    enforcedAgentKinds.add(agent.kind);
  }
  startupLog(`dev cloud target migrated to ${localDevCloudApiUrl}`);
}

async function maybeOfferUpdate() {
  const state = readUpdateState();
  if (
    state.lastCheckedAt &&
    Date.now() - new Date(state.lastCheckedAt).getTime() < updateCheckIntervalMs
  )
    return;
  await checkForUpdates({ source: "auto", silent: true });
}

async function checkForUpdates(options: {
  source: "auto" | "manual" | "cli";
  force?: boolean;
  autoInstall?: boolean;
  silent?: boolean;
}) {
  try {
    const manifest = await fetchUpdateManifest();
    if (!manifest) {
      if (!options.silent && options.source !== "auto") {
        await dialog.showMessageBox({
          type: "info",
          message: "Automatic updates are disabled",
          detail:
            "This Leash install is configured for manual or private update distribution.",
        });
      }
      return true;
    }
    const state = readUpdateState();
    writeUpdateState({ ...state, lastCheckedAt: new Date().toISOString() });
    if (compareVersions(manifest.version, app.getVersion()) <= 0) {
      if (!options.silent && options.source !== "auto") {
        await dialog.showMessageBox({
          type: "info",
          message: "Leash is up to date",
          detail: `You are running Leash ${app.getVersion()}.`,
        });
      }
      return true;
    }

    if (
      options.source === "auto" &&
      !options.force &&
      wasUpdatePromptedRecently(state, manifest.version)
    ) {
      return true;
    }

    if (options.autoInstall) {
      await installUpdate(manifest);
      return true;
    }

    const buttons = manifest.notesUrl
      ? ["Install update", "Later", "Release notes"]
      : ["Install update", "Later"];
    const updatePrompt = {
      type: "info",
      buttons,
      defaultId: 0,
      cancelId: 1,
      message: `Leash ${manifest.version} is available`,
      detail:
        "A newer personal build is ready. Install it now, or keep working and update later.",
    } as const;
    const response = window
      ? await dialog.showMessageBox(window, updatePrompt)
      : await dialog.showMessageBox(updatePrompt);
    writeUpdateState({
      ...readUpdateState(),
      lastCheckedAt: new Date().toISOString(),
      lastPromptedAt: new Date().toISOString(),
      lastPromptedVersion: manifest.version,
    });
    if (response.response === 2 && manifest.notesUrl) {
      await openTrustedExternalUrl(manifest.notesUrl);
      return true;
    }
    if (response.response !== 0) return true;
    await installUpdate(manifest);
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not check for updates.";
    if (!options.silent && options.source !== "auto") {
      await dialog.showMessageBox({
        type: "warning",
        message: "Could not check for updates",
        detail: message,
      });
    }
    console.error(`Leash update check failed: ${message}`);
    return false;
  }
}

async function fetchUpdateManifest(): Promise<UpdateManifest | undefined> {
  const feedUrl = updateFeedUrl();
  if (!feedUrl) return undefined;
  const response = await fetch(feedUrl, {
    method: shouldUseUpdatePost(feedUrl) ? "POST" : "GET",
    cache: "no-store",
    headers: {
      ...(shouldUseUpdatePost(feedUrl)
        ? { "content-type": "application/json" }
        : {}),
      ...apiVersionHeaders(
        shouldUseUpdatePost(feedUrl)
          ? "clientUpdateCheck"
          : "clientUpdateLatest",
      ),
    },
    body: shouldUseUpdatePost(feedUrl)
      ? JSON.stringify(updateCheckPayload())
      : undefined,
  });
  if (!response.ok) throw new Error(`Update feed returned ${response.status}.`);
  const manifest = (await response.json()) as Partial<UpdateManifest>;
  const version = manifest.latestVersion ?? manifest.version;
  if (!version || typeof version !== "string") {
    throw new Error("Update feed is missing a version.");
  }
  manifest.version = version;
  if (!manifest.dmgUrl && !manifest.downloadUrl) {
    if (compareVersions(version, app.getVersion()) > 0) {
      throw new Error("Update feed is missing an installer download URL.");
    }
  }
  if (
    compareVersions(version, app.getVersion()) > 0 &&
    !/^[a-f0-9]{64}$/i.test(manifest.sha256 ?? "")
  ) {
    throw new Error("Update feed is missing a valid SHA-256 checksum.");
  }
  return manifest as UpdateManifest;
}

function updateFeedUrl() {
  // Development launches always run the current checkout. Never let an
  // inherited feed setting offer a packaged release over local source.
  if (!app.isPackaged) return undefined;
  const args = process.argv.slice(1);
  const mode =
    readCliValue(args, "--update-mode") ?? process.env.OPENLEASH_UPDATE_MODE;
  if (mode === "manual" || mode === "disabled" || mode === "private-manual")
    return undefined;
  return (
    readCliValue(args, "--update-feed") ??
    process.env.OPENLEASH_UPDATE_FEED_URL ??
    defaultUpdateFeedUrl
  );
}

function shouldUseUpdatePost(feedUrl: string) {
  return !/\.json(?:\?|$)/i.test(feedUrl) && !feedUrl.includes("/latest");
}

function updateCheckPayload() {
  return {
    app: process.env.OPENLEASH_UPDATE_APP ?? "openleash-personal",
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    channel: process.env.OPENLEASH_UPDATE_CHANNEL ?? "stable",
    installMode: process.env.OPENLEASH_INSTALL_MODE ?? "personal",
    updateSource: process.env.OPENLEASH_UPDATE_SOURCE ?? "public",
  };
}

function wasUpdatePromptedRecently(state: UpdateState, version: string) {
  if (state.lastPromptedVersion !== version || !state.lastPromptedAt)
    return false;
  return (
    Date.now() - new Date(state.lastPromptedAt).getTime() <
    updateCheckIntervalMs
  );
}

async function installUpdate(manifest: UpdateManifest) {
  const installerUrl = manifest.downloadUrl ?? manifest.dmgUrl;
  if (!installerUrl) throw new Error("Update has no installer URL.");
  if (process.platform !== "darwin" && process.platform !== "win32") {
    await openTrustedExternalUrl(installerUrl);
    throw new Error("Automatic updates are currently supported on macOS and Windows.");
  }
  const extension = process.platform === "win32" ? "exe" : "dmg";
  const downloadPath = path.join(
    app.getPath("temp"),
    `Leash-${manifest.version}.${extension}`,
  );
  await dialog.showMessageBox({
    type: "info",
    message: "Leash will update now",
    detail:
      "The app will close for a moment while the new version is installed. Your local settings and history will stay in place.",
  });
  await downloadFile(installerUrl, downloadPath);
  const actualSha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(downloadPath))
    .digest("hex");
  if (actualSha256.toLowerCase() !== manifest.sha256?.toLowerCase()) {
    fs.rmSync(downloadPath, { force: true });
    throw new Error("Downloaded update failed SHA-256 verification.");
  }
  const child =
    process.platform === "win32"
      ? spawn(downloadPath, ["/S"], { detached: true, stdio: "ignore" })
      : spawnMacUpdateInstaller(installerUrl, downloadPath);
  child.unref();
  quitting = true;
  noticeWindow?.destroy();
  window?.destroy();
  tray?.destroy();
  setTimeout(() => app.quit(), 250);
}

function spawnMacUpdateInstaller(installerUrl: string, downloadPath: string) {
  const installer = installerScriptPath();
  if (!fs.existsSync(installer)) {
    void openTrustedExternalUrl(installerUrl);
    throw new Error(
      "Installer helper was not found, so the DMG was opened in your browser instead.",
    );
  }
  return spawn(
    "/bin/bash",
    [installer, "--dmg", downloadPath, "--keep-settings", "--quiet"],
    { detached: true, stdio: "ignore" },
  );
}

async function downloadFile(url: string, targetPath: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download returned ${response.status}.`);
  const data = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(targetPath, data);
}

function installerScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "install-openleash-personal.sh")
    : path.resolve(
        here,
        "..",
        "..",
        "..",
        "scripts",
        "install-openleash-personal.sh",
      );
}

function individualOpenSourceRuntimeDirectory() {
  return path.join(os.homedir(), ".openleash", "individual-open-source");
}

function startCompleteMacUninstall(runtimeDir: string) {
  const installer = installerScriptPath();
  if (!fs.existsSync(installer)) throw new Error("The bundled uninstall helper is missing.");
  const bundleMarker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const markerIndex = process.execPath.lastIndexOf(bundleMarker);
  if (markerIndex < 0) throw new Error("The installed Leash application path could not be determined.");
  const applicationBundle = process.execPath.slice(0, markerIndex);
  const installDirectory = path.dirname(applicationBundle);
  const helperDirectory = fs.mkdtempSync(path.join(app.getPath("temp"), "leash-uninstall-"));
  const helper = path.join(helperDirectory, "uninstall.sh");
  fs.copyFileSync(installer, helper);
  fs.chmodSync(helper, 0o700);
  const logPath = path.join(app.getPath("temp"), "leash-uninstall.log");
  const log = fs.openSync(logPath, "a");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENLEASH_BACKEND_DIR: runtimeDir,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    "/bin/bash",
    [helper, "--uninstall", "--target", installDirectory, "--quiet"],
    {
      detached: true,
      env,
      stdio: ["ignore", log, log],
    },
  );
  fs.closeSync(log);
  if (!child.pid) throw new Error("The uninstall helper did not start.");
  child.unref();
  setTimeout(quitOpenLeash, 100);
}

function readUpdateState(): UpdateState {
  const file = updateStatePath();
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as UpdateState;
  } catch {
    return {};
  }
}

function writeUpdateState(state: UpdateState) {
  const file = updateStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function updateStatePath() {
  return path.join(app.getPath("userData"), "update-state.json");
}

function compareVersions(left: string, right: string) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function versionParts(value: string) {
  return value
    .replace(/^v/i, "")
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function setDisconnected() {
  setTrayStatus("down");
  ensureTray("down").setToolTip(`${APP_DISPLAY_NAME} API unavailable`);
  refreshMenu();
}

function ensureTray(status: "ok" | "pending" | "down" = currentTrayStatus) {
  currentTrayStatus = status;
  if (!tray || tray.isDestroyed()) {
    const image = createTrayIcon(status);
    tray = process.platform === "darwin"
      ? new Tray(image, MAC_TRAY_GUID)
      : new Tray(image);
    tray.on("click", () => {
      if (traySingleClickTimer) clearTimeout(traySingleClickTimer);
      traySingleClickTimer = setTimeout(() => {
        traySingleClickTimer = undefined;
        if (localServer?.islandVisibility === "off") restoreMainWindow();
        else revealIslandFromTray();
      }, 260);
    });
    tray.on("double-click", () => {
      if (traySingleClickTimer) {
        clearTimeout(traySingleClickTimer);
        traySingleClickTimer = undefined;
      }
      restoreMainWindow();
    });
    tray.on("right-click", () => refreshMenu(true));
  } else {
    tray.setImage(createTrayIcon(status));
  }
  tray.setTitle("");
  tray.setToolTip(trayTooltip(status));
  return tray;
}

function setTrayStatus(status: "ok" | "pending" | "down") {
  ensureTray(status);
}

function trayTooltip(status: "ok" | "pending" | "down") {
  return status === "ok"
    ? `${APP_DISPLAY_NAME} agent defense`
    : status === "pending"
      ? `${latestPending.length} ${APP_DISPLAY_NAME} approval${latestPending.length === 1 ? "" : "s"} waiting`
      : `${APP_DISPLAY_NAME} API unavailable`;
}

function refreshMenu(open = false) {
  const approvalLabel =
    latestPending.length === 0
      ? "No pending approvals"
      : `${latestPending.length} pending approval${latestPending.length === 1 ? "" : "s"}`;
  const agentLabel =
    latestAgents.length === 0
      ? "No active agents"
      : `${latestAgents.length} active agent${latestAgents.length === 1 ? "" : "s"}`;
  const installedAgents = localProtections.filter((agent) => agent.installed);
  const protectedAgents = installedAgents.filter((agent) => agent.protected);
  const protectionLabel =
    installedAgents.length === 0
      ? "No installed agents detected"
      : `${protectedAgents.length}/${installedAgents.length} agents protected`;
  const proxyLabel = proxyStatus.healthy
    ? `Proxy active · ${proxyStatus.configuredAgents.length} agent${proxyStatus.configuredAgents.length === 1 ? "" : "s"}`
    : proxyStatus.running
      ? "Proxy starting"
      : "Proxy off";
  const protectionItems =
    localProtections.length === 0
      ? [{ label: "No agents detected", enabled: false }]
      : localProtections
          .slice()
          .sort(
            (a, b) =>
              Number(b.installed) - Number(a.installed) ||
              a.displayName.localeCompare(b.displayName),
          )
          .map(agentProtectionMenuItem);
  const activeAgentItems =
    latestAgents.length === 0
      ? [{ label: "No active agents", enabled: false }]
      : latestAgents.map((agent) => ({
          label: `${agent.display_name} - ${compactSummary(agent.short_summary)}`,
          sublabel: formatAgentMenuSublabel(agent),
          click: () => showAgentDetail(agent),
        }));
  const pendingItems =
    latestPending.length === 0
      ? [{ label: "No approvals waiting", enabled: false }]
      : latestPending.map((item) => ({
          label: `${item.agent_name} - ${compactSummary(item.question ?? item.summary)}`,
          sublabel: `${item.tool_name ?? item.event_name} · ${timeAgo(item.created_at)}`,
          click: () => {
            if (localServer.islandVisibility === "off") manualIslandReveal = true;
            showDecisionNotice({ kind: "ask", pending: item });
          },
        }));

  const menu = Menu.buildFromTemplate([
    { label: "Settings", click: () => showMainWindow("settings") },
    { type: "separator" },
    { label: APP_DISPLAY_NAME, enabled: false },
    { label: `API hooks · ${protectionLabel}`, submenu: protectionItems },
    { label: proxyLabel, click: () => showMainWindow("settings") },
    { type: "separator" },
    { label: agentLabel, submenu: activeAgentItems },
    { label: approvalLabel, submenu: pendingItems },
    { type: "separator" },
    {
      label: "Check for updates",
      click: () => void checkForUpdates({ source: "manual", force: true }),
    },
    { type: "separator" },
    { label: "Quit", click: quitOpenLeash },
  ]);
  const statusItem = ensureTray();
  if (process.platform === "darwin") statusItem.setContextMenu(null);
  else statusItem.setContextMenu(menu);
  if (open) statusItem.popUpContextMenu(menu);
}

function installApplicationMenu() {
  const template: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          {
            label: APP_DISPLAY_NAME,
            submenu: [
              { role: "about", label: `About ${APP_DISPLAY_NAME}` },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide", label: `Hide ${APP_DISPLAY_NAME}` },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              {
                label: `Quit ${APP_DISPLAY_NAME}`,
                accelerator: "Command+Q",
                click: quitOpenLeash,
              },
            ],
          },
          {
            label: "File",
            submenu: [
              {
                label: "Settings",
                accelerator: "Command+,",
                click: () => showMainWindow("settings"),
              },
            ],
          },
          {
            label: "Edit",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "View",
            submenu: [
              { role: "reload" },
              { role: "toggleDevTools" },
              { type: "separator" },
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
            ],
          },
          {
            label: "Window",
            submenu: [{ role: "minimize" }, { role: "close" }],
          },
          {
            role: "help",
            submenu: [
              { label: "Settings", click: () => showMainWindow("settings") },
            ],
          },
        ]
      : [
          {
            label: "File",
            submenu: [
              { label: "Settings", click: () => showMainWindow("settings") },
              { type: "separator" },
              { label: "Quit", click: quitOpenLeash },
            ],
          },
          {
            label: "View",
            submenu: [{ role: "reload" }, { role: "toggleDevTools" }],
          },
        ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function refreshLocalProtections(force = false) {
  const now = Date.now();
  if (
    !force &&
    now - localProtectionCheckedAt < 10000 &&
    localProtections.length > 0
  )
    return;
  localProtectionCheckedAt = now;
  localProtections = detectLocalAgentProtections({
    appVersion: app.getVersion(),
  });
  void syncRemoteAgentInventory();
}

async function syncRemoteAgentInventory() {
  const remoteApiUrl = localServer.remoteApiUrl;
  const token = localServer.effectiveToken;
  if (!remoteApiUrl || !token || localProtections.length === 0) return;
  const agents = desktopInventoryAgents();
  try {
    const response = await fetch(new URL("/v1/desktop/agents", remoteApiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...apiVersionHeaders("desktopEnroll"),
      },
      body: JSON.stringify({
        installIdentity: localServer.deviceIdentity(),
        hostname: os.hostname(),
        platform: os.platform(),
        osRelease: os.release(),
        clientVersion: app.getVersion(),
        agents,
      }),
      signal: AbortSignal.timeout(
        Number(process.env.OPENLEASH_DESKTOP_INVENTORY_TIMEOUT_MS ?? 10000),
      ),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      startupLog(
        `remote agent inventory sync failed: ${response.status} ${body.error || response.statusText}`,
      );
    } else {
      startupLog(
        `remote agent inventory synced: ${agents.length} agent${agents.length === 1 ? "" : "s"}`,
      );
      await reconcileRemoteAgentMonitoring(remoteApiUrl, token);
    }
  } catch {
    startupLog("remote agent inventory sync failed: request did not complete");
  }
}

async function saveRemoteAgentMonitoring(
  remoteApiUrl: string,
  token: string,
  kind: string,
  monitored: boolean,
) {
  try {
    const response = await fetch(
      new URL(
        `/v1/agents/${encodeURIComponent(kind)}/monitoring`,
        remoteApiUrl,
      ),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...apiVersionHeaders("mobileState"),
        },
        body: JSON.stringify({ monitored }),
        signal: AbortSignal.timeout(
          Number(
            process.env.OPENLEASH_DESKTOP_AGENT_MONITORING_TIMEOUT_MS ?? 10000,
          ),
        ),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      return {
        ok: false,
        error: body.error || "Could not save agent monitoring.",
      };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach the managed Leash API." };
  }
}

async function reconcileRemoteAgentMonitoring(
  remoteApiUrl: string,
  token: string,
) {
  try {
    const response = await fetch(new URL("/v1/mobile/state", remoteApiUrl), {
      headers: {
        authorization: `Bearer ${token}`,
        ...apiVersionHeaders("mobileState"),
      },
      signal: AbortSignal.timeout(
        Number(
          process.env.OPENLEASH_DESKTOP_AGENT_MONITORING_TIMEOUT_MS ?? 10000,
        ),
      ),
    });
    if (!response.ok) return;
    const body = (await response.json()) as RemoteMobileState;
    const desiredByKind = new Map<string, boolean>();
    for (const agent of body.agents ?? []) {
      const desired = agent.desired_monitored ?? agent.desiredMonitored;
      if (typeof desired === "boolean")
        desiredByKind.set(String(agent.kind ?? "").toLowerCase(), desired);
    }
    if (desiredByKind.size === 0) return;
    let changed = false;
    for (const agent of detectLocalAgentProtections({
      appVersion: app.getVersion(),
    })) {
      const desired = desiredByKind.get(agent.kind);
      if (
        typeof desired !== "boolean" ||
        !agent.installed ||
        !agent.supportsInstall
      )
        continue;
      if (desired && !agent.protected) {
        await protectAgentKind(agent.kind);
        changed = true;
      } else if (!desired && agent.protected) {
        await unprotectAgentKind(agent.kind);
        changed = true;
      }
    }
    if (changed) {
      localProtections = detectLocalAgentProtections({
        appVersion: app.getVersion(),
      });
      await postRemoteAgentInventory(
        remoteApiUrl,
        token,
        desktopInventoryAgents(),
      );
      refreshMenu();
      window?.webContents.send("openleash:update", {
        apiUrl,
        localProtections,
      });
    }
  } catch {
    startupLog(
      "remote agent monitoring reconcile failed: request did not complete",
    );
  }
}

async function postRemoteAgentInventory(
  remoteApiUrl: string,
  token: string,
  agents: ReturnType<typeof desktopInventoryAgents>,
) {
  await fetch(new URL("/v1/desktop/agents", remoteApiUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...apiVersionHeaders("desktopEnroll"),
    },
    body: JSON.stringify({
      installIdentity: localServer.deviceIdentity(),
      hostname: os.hostname(),
      platform: os.platform(),
      osRelease: os.release(),
      clientVersion: app.getVersion(),
      agents,
    }),
    signal: AbortSignal.timeout(
      Number(process.env.OPENLEASH_DESKTOP_INVENTORY_TIMEOUT_MS ?? 10000),
    ),
  }).catch(() => undefined);
}

function rememberCurrentlyProtectedAgents() {
  for (const agent of localProtections) {
    if (agent.protected && agent.supportsInstall)
      enforcedAgentKinds.add(agent.kind);
  }
}

function startProtectionIntegrityGuard() {
  syncProtectionWatchers();
  protectionAuditTimer ??= setInterval(
    () => {
      scheduleProtectionRepair("periodic-audit");
    },
    5 * 60 * 1000,
  );
}

async function protectAgentKind(kind: string) {
  await installAgentProtection(kind, hookInstallContext());
  enforcedAgentKinds.add(kind);
  if (proxyStatus.running && isAutomaticProxyAgent(kind))
    configureAgentProxy(kind, true);
  await refreshLocalProtections(true);
  startProtectionIntegrityGuard();
}

const automaticProxyAgents = new Set([
  "claude-code",
  "codex",
  "opencode",
  "nanoclaw",
]);

function isAutomaticProxyAgent(kind: string) {
  return automaticProxyAgents.has(kind);
}

async function installProxyForMonitoredAgents(agents: string[]) {
  // Never put the Cloud account token on the loopback proxy hop. The desktop
  // edge validates its local token, then adds the Cloud credential upstream.
  const token = localServer.token;
  if (!token) throw new Error("Leash backend token is unavailable.");
  return installLocalProxy({
    clientApiUrl: apiUrl,
    token,
    agents: agents.filter(isAutomaticProxyAgent),
    failOpen: localServer.availabilityFailOpen,
  });
}

async function removeDesktopMonitoring() {
  const cleanup = await cleanupDesktopIntegrations();
  if (!cleanup.ok) throw new Error(cleanup.errors.join("; "));
  enforcedAgentKinds.clear();
  syncProtectionWatchers();
  await refreshLocalProtections(true);
}

async function cleanupDesktopIntegrations(options: {
  removeSystemRegistration?: boolean;
} = {}) {
  const errors: string[] = [];
  try {
    await uninstallLocalProxy();
  } catch (error) {
    errors.push(`proxy: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await uninstallAllAgentProtections();
  } catch (error) {
    errors.push(`hooks: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const file of [
    path.join(os.homedir(), ".openleash", "config.json"),
    path.join(os.homedir(), ".openleash", "bin", "leash"),
  ]) {
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (options.removeSystemRegistration !== false) {
    try {
      app.setLoginItemSettings({ openAtLogin: false });
      app.removeAsDefaultProtocolClient("openleash");
    } catch (error) {
      errors.push(`system registration: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

async function unprotectAgentKind(kind: string) {
  enforcedAgentKinds.delete(kind);
  const pending = pendingProtectionRepairs.get(kind);
  if (pending) clearTimeout(pending);
  pendingProtectionRepairs.delete(kind);
  syncProtectionWatchers();
  if (isAutomaticProxyAgent(kind)) configureAgentProxy(kind, false);
  await uninstallAgentProtection(kind);
  await refreshLocalProtections(true);
  syncProtectionWatchers();
}

function syncProtectionWatchers() {
  const targets = protectionWatchTargets().filter((target) =>
    enforcedAgentKinds.has(target.kind),
  );
  const wantedPaths = new Set<string>();
  for (const target of targets) {
    for (const filePath of target.paths) {
      wantedPaths.add(filePath);
      ensureProtectionWatcher(filePath, target.kind);
      ensureProtectionWatcher(path.dirname(filePath), target.kind);
    }
  }
  for (const [watchPath, watcher] of protectionWatchers) {
    if (
      !wantedPaths.has(watchPath) &&
      ![...wantedPaths].some((filePath) => path.dirname(filePath) === watchPath)
    ) {
      watcher.close();
      protectionWatchers.delete(watchPath);
    }
  }
}

function ensureProtectionWatcher(watchPath: string, kind: string) {
  if (protectionWatchers.has(watchPath)) return;
  try {
    if (!fs.existsSync(watchPath))
      fs.mkdirSync(
        path.extname(watchPath) ? path.dirname(watchPath) : watchPath,
        { recursive: true },
      );
    const watcher = fs.watch(watchPath, { persistent: false }, () => {
      scheduleProtectionRepair(`watch:${kind}`);
    });
    watcher.on("error", (error) => {
      startupLog(
        `protection watcher failed for ${watchPath}: ${error.message}`,
      );
      protectionWatchers.delete(watchPath);
    });
    protectionWatchers.set(watchPath, watcher);
  } catch (error) {
    startupLog(
      `could not watch ${watchPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function scheduleProtectionRepair(reason: string) {
  for (const kind of enforcedAgentKinds) {
    const existing = pendingProtectionRepairs.get(kind);
    if (existing) clearTimeout(existing);
    pendingProtectionRepairs.set(
      kind,
      setTimeout(() => {
        pendingProtectionRepairs.delete(kind);
        void repairProtectedAgent(kind, reason);
      }, 1000),
    );
  }
}

function startSkillIntegrityGuard() {
  syncSkillWatchers();
  skillWatcherSyncTimer ??= setInterval(() => syncSkillWatchers(), 60 * 1000);
}

function syncSkillWatchers() {
  if (!localServer?.setupComplete) return;
  const targets = skillWatchTargets();
  const wanted = new Set(targets.map((target) => target.dir));
  for (const target of targets) {
    ensureSkillWatcher(target);
    scheduleSkillScan(target.dir, target, 50);
  }
  for (const [dir, watcher] of skillWatchers) {
    if (!wanted.has(dir)) {
      watcher.close();
      skillWatchers.delete(dir);
    }
  }
  reconcileRemovedSkills();
}

function reconcileRemovedSkills() {
  if (!localServer?.setupComplete) return;
  for (const skill of localServer.skills) {
    if (fs.existsSync(skill.skill_path)) continue;
    const target = {
      agentKind: skill.agent_kind,
      agentName: skill.agent_name,
      scope: skill.scope,
      projectPath: skill.project_path,
    };
    const observation = localServer.observeSkillRemoved({
      ...target,
      skillName:
        skill.skill_name || path.basename(path.dirname(skill.skill_path)),
      skillPath: skill.skill_path,
    });
    if (!observation.unchanged) {
      observedSkillHashes.delete(skill.skill_path);
      void sendRemoteSkillObservation({
        target,
        skillPath: skill.skill_path,
        observation,
      });
    }
  }
}

function skillWatchTargets() {
  const home = os.homedir();
  const claudeConfigDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const targets: Array<{
    dir: string;
    agentKind: string;
    agentName: string;
    scope: "user" | "project";
    projectPath?: string | null;
  }> = [
    {
      dir: path.join(claudeConfigDir, "skills"),
      agentKind: "claude-code",
      agentName: "Claude Code",
      scope: "user",
    },
    {
      dir: path.join(codexHome, "skills"),
      agentKind: "codex",
      agentName: "OpenAI Codex",
      scope: "user",
    },
  ];
  targets.push(...discoverClaudePluginSkillTargets(claudeConfigDir));
  for (const projectPath of knownProjectPaths()) {
    targets.push(...discoverProjectSkillTargets(projectPath));
  }
  return targets
    .map((target) => ({
      ...target,
      dir: path.resolve(target.dir),
      projectPath: target.projectPath
        ? path.resolve(target.projectPath)
        : target.projectPath,
    }))
    .filter((target) => fs.existsSync(target.dir))
    .filter(
      (target, index, all) =>
        all.findIndex((item) => item.dir === target.dir) === index,
    );
}

function knownProjectPaths() {
  const paths = new Set<string>();
  paths.add(process.cwd());
  if (process.env.OPENLEASH_PROJECT_ROOT)
    paths.add(process.env.OPENLEASH_PROJECT_ROOT);
  if (process.env.PWD) paths.add(process.env.PWD);
  for (const agent of latestAgents) {
    if (agent.project_path) paths.add(agent.project_path);
    for (const session of agent.sessions ?? []) {
      if (session.project_path) paths.add(session.project_path);
    }
  }
  for (const item of localServer?.history ?? [])
    if (item.project_path) paths.add(item.project_path);
  return [...paths]
    .map((item) => path.resolve(item))
    .filter((item) => item.startsWith(os.homedir()) && fs.existsSync(item))
    .slice(0, 100);
}

function discoverProjectSkillTargets(projectPath: string) {
  const targets: Array<{
    dir: string;
    agentKind: string;
    agentName: string;
    scope: "project";
    projectPath: string;
  }> = [];
  for (const base of projectConfigBases(projectPath)) {
    targets.push(
      {
        dir: path.join(base, ".claude", "skills"),
        agentKind: "claude-code",
        agentName: "Claude Code",
        scope: "project",
        projectPath: base,
      },
      {
        dir: path.join(base, ".codex", "skills"),
        agentKind: "codex",
        agentName: "OpenAI Codex",
        scope: "project",
        projectPath: base,
      },
      {
        dir: path.join(base, ".agents", "skills"),
        agentKind: "unknown",
        agentName: "Local agent",
        scope: "project",
        projectPath: base,
      },
    );
  }
  for (const dir of findNestedSkillDirs(projectPath)) {
    const normalized = dir.replace(/\\/g, "/");
    const agentKind = normalized.includes("/.claude/")
      ? "claude-code"
      : normalized.includes("/.codex/")
        ? "codex"
        : "unknown";
    targets.push({
      dir,
      agentKind,
      agentName:
        agentKind === "claude-code"
          ? "Claude Code"
          : agentKind === "codex"
            ? "OpenAI Codex"
            : "Local agent",
      scope: "project",
      projectPath,
    });
  }
  return targets;
}

function projectConfigBases(projectPath: string) {
  const bases: string[] = [];
  let current = path.resolve(projectPath);
  const stop = repoRootFor(current);
  while (true) {
    bases.push(current);
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return bases;
}

function repoRootFor(projectPath: string) {
  let current = path.resolve(projectPath);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return projectPath;
    current = parent;
  }
}

function findNestedSkillDirs(root: string) {
  // Project-level skill directories are already checked directly above. A
  // recursive walk is only useful for monorepos, and walking an arbitrary
  // Documents/iCloud folder can synchronously block Electron while macOS
  // materializes a File Provider directory.
  const repositoryRoot = path.resolve(repoRootFor(root));
  if (!fs.existsSync(path.join(repositoryRoot, ".git"))) return [];
  const fileProviderRoots = [
    path.join(os.homedir(), "Desktop"),
    path.join(os.homedir(), "Documents"),
    path.join(os.homedir(), "Library", "CloudStorage"),
    path.join(os.homedir(), "Library", "Mobile Documents"),
  ];
  if (
    fileProviderRoots.some(
      (candidate) =>
        repositoryRoot === candidate ||
        repositoryRoot.startsWith(`${candidate}${path.sep}`),
    )
  )
    return [];
  const found: string[] = [];
  const stack = [{ dir: repositoryRoot, depth: 0 }];
  let inspectedDirectoryCount = 0;
  while (
    stack.length &&
    found.length < 200 &&
    inspectedDirectoryCount < 2_000
  ) {
    const { dir, depth } = stack.pop()!;
    if (depth > 5) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
      inspectedDirectoryCount += 1;
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (
        ["node_modules", ".git", "dist", "build", ".next", "target"].includes(
          entry.name,
        )
      )
        continue;
      const full = path.join(dir, entry.name);
      if ([".claude", ".codex", ".agents"].includes(entry.name)) {
        const skills = path.join(full, "skills");
        if (fs.existsSync(skills)) found.push(skills);
      }
      stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return found;
}

function discoverClaudePluginSkillTargets(claudeConfigDir: string) {
  const roots = [
    path.join(claudeConfigDir, "plugins"),
    path.join(claudeConfigDir, "plugins", "cache"),
  ].filter((dir) => fs.existsSync(dir));
  const targets: Array<{
    dir: string;
    agentKind: string;
    agentName: string;
    scope: "user";
    projectPath?: null;
  }> = [];
  for (const root of roots) {
    const pluginSkillDirs = findPluginSkillDirs(root);
    for (const dir of pluginSkillDirs) {
      targets.push({
        dir,
        agentKind: "claude-code",
        agentName: "Claude Code plugin",
        scope: "user",
        projectPath: null,
      });
    }
  }
  return targets;
}

function findPluginSkillDirs(root: string) {
  const found: string[] = [];
  const stack = [{ dir: path.resolve(root), depth: 0 }];
  while (stack.length && found.length < 500) {
    const { dir, depth } = stack.pop()!;
    if (depth > 6) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const hasPluginManifest =
      entries.some(
        (entry) => entry.isDirectory() && entry.name === ".claude-plugin",
      ) || entries.some((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (hasPluginManifest) {
      if (fs.existsSync(path.join(dir, "SKILL.md"))) found.push(dir);
      const skills = path.join(dir, "skills");
      if (fs.existsSync(skills)) found.push(skills);
    }
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !["node_modules", ".git", "dist", "build"].includes(entry.name)
      ) {
        stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return found;
}

function ensureSkillWatcher(target: {
  dir: string;
  agentKind: string;
  agentName: string;
  scope: "user" | "project";
  projectPath?: string | null;
}) {
  if (skillWatchers.has(target.dir)) return;
  try {
    if (!fs.existsSync(target.dir)) return;
    const recursive =
      process.platform === "darwin" || process.platform === "win32";
    const watcher = fs.watch(target.dir, { persistent: false, recursive }, () =>
      scheduleSkillScan(target.dir, target),
    );
    watcher.on("error", (error) => {
      startupLog(`skill watcher failed for ${target.dir}: ${error.message}`);
      skillWatchers.delete(target.dir);
    });
    skillWatchers.set(target.dir, watcher);
  } catch (error) {
    startupLog(
      `could not watch skills ${target.dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function scheduleSkillScan(
  dir: string,
  target: {
    dir: string;
    agentKind: string;
    agentName: string;
    scope: "user" | "project";
    projectPath?: string | null;
  },
  delay = 700,
) {
  const existing = pendingSkillScans.get(dir);
  if (existing) clearTimeout(existing);
  pendingSkillScans.set(
    dir,
    setTimeout(() => {
      pendingSkillScans.delete(dir);
      void scanSkillDirectory(target);
    }, delay),
  );
}

async function scanSkillDirectory(target: {
  dir: string;
  agentKind: string;
  agentName: string;
  scope: "user" | "project";
  projectPath?: string | null;
}) {
  if (!localServer?.setupComplete || !fs.existsSync(target.dir)) return;
  const foundSkillPaths = new Set<string>();
  for (const skillPath of findSkillManifests(target.dir)) {
    try {
      const content = fs.readFileSync(skillPath, "utf8");
      const stat = fs.statSync(skillPath);
      const changedAt = new Date(stat.mtimeMs).toISOString();
      const hash = `${stat.mtimeMs}:${content.length}:${content.slice(0, 64)}`;
      foundSkillPaths.add(path.resolve(skillPath));
      if (observedSkillHashes.get(skillPath) === hash) continue;
      observedSkillHashes.set(skillPath, hash);
      const observation = await localServer.observeSkill({
        agentKind: target.agentKind,
        agentName: target.agentName,
        scope: target.scope,
        projectPath: target.projectPath,
        skillName: path.basename(path.dirname(skillPath)),
        skillPath,
        content,
        changedAt,
      });
      void sendRemoteSkillObservation({
        target,
        skillPath,
        content,
        observation,
      });
      window?.webContents.send("openleash:update", {
        apiUrl,
        pending: latestPending,
        agents: latestAgents,
        sessionMetrics: latestSessionMetrics,
        plugins: latestPlugins,
        outcomes: latestOutcomes,
        viewModel: latestViewModel,
        history: localServer.history,
        mcpServers: localServer.mcpServers,
        skills: localServer.skills,
        localProtections,
      });
    } catch (error) {
      startupLog(
        `could not inspect skill ${skillPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const skill of localServer.skills) {
    const skillPath = path.resolve(skill.skill_path);
    if (!isPathInside(skillPath, target.dir) || foundSkillPaths.has(skillPath))
      continue;
    const observation = localServer.observeSkillRemoved({
      agentKind: target.agentKind,
      agentName: target.agentName,
      scope: target.scope,
      projectPath: target.projectPath,
      skillName:
        skill.skill_name || path.basename(path.dirname(skill.skill_path)),
      skillPath: skill.skill_path,
    });
    if (!observation.unchanged) {
      observedSkillHashes.delete(skill.skill_path);
      void sendRemoteSkillObservation({
        target,
        skillPath: skill.skill_path,
        observation,
      });
    }
  }
}

function isPathInside(filePath: string, directory: string) {
  const relative = path.relative(
    path.resolve(directory),
    path.resolve(filePath),
  );
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function findSkillManifests(root: string) {
  const found: string[] = [];
  const stack = [root];
  while (stack.length && found.length < 500) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", "dist", "build"].includes(entry.name))
          stack.push(full);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        found.push(full);
      }
    }
  }
  return found;
}

async function sendRemoteSkillObservation({
  target,
  skillPath,
  content,
  observation,
}: {
  target: {
    agentKind: string;
    agentName: string;
    scope: "user" | "project";
    projectPath?: string | null;
  };
  skillPath: string;
  content?: string;
  observation: {
    assessment?: {
      riskScore?: number;
      reasons?: Array<{ reason: string; quote?: string }>;
      malicious?: boolean;
    };
    suspicious?: boolean;
    unchanged?: boolean;
    eventType?: "detected" | "changed" | "seen" | "removed";
    contentHash?: string;
    purposeSummary?: string;
  };
}) {
  const remoteApiUrl = localServer.remoteApiUrl;
  const token = localServer.effectiveToken;
  if (!remoteApiUrl || !token) return;
  const contentHash = content
    ? crypto.createHash("sha256").update(content).digest("hex")
    : observation.contentHash;
  try {
    await fetch(new URL("/v1/skills/observations", remoteApiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...apiVersionHeaders("tenantSkillObservation"),
      },
      body: JSON.stringify({
        agentKind: target.agentKind,
        agentName: target.agentName,
        scope: target.scope,
        projectPath: target.projectPath,
        skillName: path.basename(path.dirname(skillPath)),
        skillPath,
        eventType:
          observation.eventType ?? (observation.unchanged ? "seen" : "changed"),
        contentHash,
        content: content?.slice(0, 80000),
        contentPreview: content?.slice(0, 12000),
        purposeSummary: observation.purposeSummary,
        status:
          observation.eventType === "removed"
            ? "deleted"
            : observation.suspicious
              ? "suspicious"
              : "observed",
        riskScore: observation.assessment?.riskScore ?? 0,
        reasons: observation.assessment?.reasons ?? [],
      }),
    });
  } catch (error) {
    startupLog(
      `could not send skill observation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function pluginEnabled(pluginId: string) {
  const plugin = (
    latestPlugins.length > 0 ? latestPlugins : localServer.plugins
  ).find((item) => item.id === pluginId);
  return plugin?.settings?.enabled ?? true;
}

async function repairProtectedAgent(kind: string, reason: string) {
  if (repairingProtections || !localServer?.setupComplete) return;
  repairingProtections = true;
  try {
    const before = detectLocalAgentProtections({
      appVersion: app.getVersion(),
    }).find((agent) => agent.kind === kind);
    if (
      !before?.installed ||
      (before.protected && before.approvalHandoff !== false)
    )
      return;
    await installAgentProtection(kind, hookInstallContext());
    startupLog(`repaired ${kind} protection after ${reason}`);
    await refreshLocalProtections(true);
    syncProtectionWatchers();
    refreshMenu();
    window?.webContents.send("openleash:update", {
      apiUrl,
      pending: latestPending,
      agents: latestAgents,
      sessionMetrics: latestSessionMetrics,
      plugins: latestPlugins,
      outcomes: latestOutcomes,
      viewModel: latestViewModel,
      history: localServer.history,
      mcpServers: localServer.mcpServers,
      skills: localServer.skills,
      localProtections,
    });
  } catch (error) {
    startupLog(
      `could not repair ${kind} protection: ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
  } finally {
    repairingProtections = false;
  }
}

function showMainWindow(
  mode: "setup" | "settings" = localServer?.setupComplete
    ? "settings"
    : "setup",
) {
  showDockIcon();
  const sendState = () => {
    window?.webContents.send("openleash:update", {
      apiUrl,
      cloudApiUrl,
      mode,
      setupComplete: localServer?.setupComplete ?? false,
      introSeen: localServer?.introSeen ?? false,
      clientMode: localServer?.clientMode ?? "cloud",
      remoteApiUrl: localServer?.remoteApiUrl,
      remoteOrganization: localServer?.remoteOrganization,
      remoteUser: localServer?.remoteUser,
      apiProvider: localServer?.apiProvider ?? "openai",
      apiKeySet: localServer?.apiKeySet ?? false,
      agentDoneSound: localServer?.agentDoneSound ?? true,
      islandVisibility: localServer?.islandVisibility ?? "always",
      islandActivityOnly: localServer?.islandActivityOnly ?? false,
      pending: latestPending,
      agents: latestAgents,
      sessionMetrics: latestSessionMetrics,
      plugins: latestPlugins,
      outcomes: latestOutcomes,
      viewModel: latestViewModel,
      localProtections,
      policies: localServer?.policies ?? [],
      history: localServer?.history ?? [],
      mcpServers: localServer?.mcpServers ?? [],
      skills: localServer?.skills ?? [],
    });
  };
  if (!window) {
    let hiddenByCloseButton = false;
    window = new BrowserWindow({
      width: MAIN_WINDOW_WIDTH,
      height: MAIN_WINDOW_HEIGHT,
      minWidth: MAIN_WINDOW_MIN_WIDTH,
      minHeight: MAIN_WINDOW_MIN_HEIGHT,
      show: false,
      skipTaskbar: false,
      frame: true,
      movable: true,
      resizable: true,
      title: APP_DISPLAY_NAME,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        preload: path.join(here, "preload.js"),
      },
    });
    const mainWindow = window;
    hardenWindow(mainWindow);
    mainWindow.loadFile(path.join(here, "window.html"));
    mainWindow.webContents.once("did-finish-load", sendState);
    mainWindow.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      hiddenByCloseButton = true;
      window?.setSkipTaskbar(!setupNeedsDockIcon());
      window?.hide();
      hideDockIconIfTrayMode();
    });
    mainWindow.on("minimize", () => {
      hiddenByCloseButton = false;
      mainWindow.setSkipTaskbar(false);
      showDockIcon();
    });
    mainWindow.on("restore", () => {
      hiddenByCloseButton = false;
      mainWindow.setSkipTaskbar(false);
      showDockIcon();
    });
    mainWindow.on("show", () => {
      hiddenByCloseButton = false;
    });
    mainWindow.on("hide", () => {
      if (quitting) return;
      if (hiddenByCloseButton) {
        mainWindow.setSkipTaskbar(!setupNeedsDockIcon());
        hideDockIconIfTrayMode();
      } else {
        mainWindow.setSkipTaskbar(false);
        showDockIcon();
      }
    });
    mainWindow.on("closed", () => {
      if (window === mainWindow) window = undefined;
    });
  }
  window.setTitle(APP_DISPLAY_NAME);
  if (window.isMinimized()) window.restore();
  if (mode === "setup" || !localServer?.setupComplete) {
    fitMainWindowOnLargestDisplay(window);
  } else {
    window.center();
  }
  activateOpenLeashApp();
  window.setSkipTaskbar(false);
  window.show();
  window.moveTop();
  window.focus();
  showDockIcon();
  setTimeout(() => {
    if (!window || window.isDestroyed()) return;
    activateOpenLeashApp();
    window.show();
    window.moveTop();
    window.focus();
  }, 80);
  if (!window.webContents.isLoading()) sendState();
}

function quitOpenLeash() {
  quitting = true;
  if (noticeDismissTimer) clearTimeout(noticeDismissTimer);
  noticeWindow?.destroy();
  noticeWindow = undefined;
  sendNativeIsland({ type: "quit" });
  for (const host of nativeIslandHosts.values()) host.process.kill();
  nativeIslandHosts.clear();
  window?.destroy();
  window = undefined;
  for (const watcher of protectionWatchers.values()) watcher.close();
  protectionWatchers.clear();
  if (protectionAuditTimer) clearInterval(protectionAuditTimer);
  for (const timer of pendingProtectionRepairs.values()) clearTimeout(timer);
  pendingProtectionRepairs.clear();
  for (const watcher of skillWatchers.values()) watcher.close();
  skillWatchers.clear();
  if (skillWatcherSyncTimer) clearInterval(skillWatcherSyncTimer);
  for (const timer of pendingSkillScans.values()) clearTimeout(timer);
  pendingSkillScans.clear();
  tray?.destroy();
  tray = undefined;
  app.quit();
}

function relaunchOpenLeash() {
  quitting = true;
  latestPending = [];
  latestAgents = [];
  activeNoticeKey = undefined;
  app.relaunch();
  setTimeout(() => app.exit(0), 250);
}

function restoreMainWindow() {
  if (!app.isReady() || !localServer) return;
  if (Date.now() < suppressMainWindowActivationUntil) return;
  showMainWindow(localServer.setupComplete ? "settings" : "setup");
}

function revealRunningInstance() {
  revealExistingInstanceOnReady = true;
  suppressMainWindowActivationUntil = 0;
  if (!app.isReady() || !desktopStartupComplete || !localServer) return;
  revealExistingInstanceOnReady = false;
  showMainWindow(localServer.setupComplete ? "settings" : "setup");
}

function suppressMainWindowActivation(durationMs = 30000) {
  suppressMainWindowActivationUntil = Date.now() + durationMs;
}

function closeNoticeWithoutOpeningMainWindow() {
  suppressMainWindowActivation();
  manualIslandReveal = false;
  if (noticeDismissTimer) clearTimeout(noticeDismissTimer);
  noticeDismissTimer = undefined;
  if (noticeWindow && !noticeWindow.isDestroyed()) noticeWindow.destroy();
  noticeWindow = undefined;
  for (const host of nativeIslandHosts.values()) host.pendingMessage = undefined;
  sendNativeIsland({ type: "dismiss" });
  activeNoticeKey = undefined;
  activeActivityFingerprint = undefined;
  if (window && !window.isDestroyed() && !window.isVisible()) {
    window.hide();
    window.setSkipTaskbar(!setupNeedsDockIcon());
    hideDockIconIfTrayMode();
  }
  if (process.platform === "darwin" && !setupNeedsDockIcon()) app.hide();
}

function expandVisibleIsland() {
  if (process.platform === "darwin" && nativeIslandHosts.size > 0 && activeNoticeKey) {
    const displayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
    return sendNativeIsland({ type: "expand" }, nativeIslandHosts.get(displayId));
  }
  if (noticeWindow && !noticeWindow.isDestroyed() && noticeWindow.isVisible()) {
    void noticeWindow.webContents.executeJavaScript(
      "window.expandOpenLeashIsland && window.expandOpenLeashIsland()",
    );
    return true;
  }
  return false;
}

function revealIslandFromTray() {
  if (!app.isReady() || !localServer) return;
  if (expandVisibleIsland()) return;
  manualIslandReveal = true;
  const pending = latestPending[0];
  if (pending) {
    syncActivityIsland(true, pending);
    return;
  }
  syncActivityIsland(true, undefined, true);
}

function dismissNoticeByUser() {
  if (
    activeNoticeKey?.startsWith("activity:") &&
    localServer.islandVisibility === "always"
  ) return;
  closeNoticeWithoutOpeningMainWindow();
  setTimeout(() => syncActivityIsland(true), 180);
}

function handlePluginIslandAction(payload: unknown) {
  if (!payload || typeof payload !== "object") return { ok: false };
  const input = payload as { action?: { type?: string }; session?: AgentSessionFocusTarget };
  const type = input.action?.type;
  if (type === "open-session") return openAgentApplication(input.session);
  if (type === "open-plugin-settings" || type === "open-plugin-outcome") {
    closeNoticeWithoutOpeningMainWindow();
    setTimeout(() => syncActivityIsland(true), 180);
    showMainWindow("settings");
    return { ok: true };
  }
  return { ok: false };
}

function sessionMonitoringPauseAllowed() {
  if (monitoringManagedByOrganization) return false;
  const hasLockedPolicy = localServer.policies.some(
    (policy) => policy.enabled && policy.locked,
  );
  const hasMandatoryPlugin = latestPlugins.some(
    (plugin) =>
      plugin.settings?.enabled &&
      plugin.organizationPolicy?.mandatory,
  );
  return !hasLockedPolicy && !hasMandatoryPlugin;
}

async function setSessionMonitoring(payload: unknown) {
  if (!payload || typeof payload !== "object")
    return { ok: false, error: "Conversation is required." };
  const input = payload as {
    paused?: unknown;
    session?: Partial<ActiveAgentSession>;
  };
  const requested = input.session;
  const requestedAgentKind = String(requested?.agentKind ?? "").trim().toLowerCase();
  const requestedIds = pausableSessionIds([
    requested?.sessionId,
    ...(Array.isArray(requested?.sourceSessionIds) ? requested.sourceSessionIds : []),
    requested?.id,
  ]);
  const session = currentActiveAgentSessions().find((candidate) =>
    candidate.agentKind.toLowerCase() === requestedAgentKind &&
    (
      candidate.id === requested?.id ||
      candidate.sourceSessionIds.some((id) => requestedIds.includes(id))
    )
  );
  if (!session) return { ok: false, error: "Conversation is no longer available." };

  const sessionIds = pausableSessionIds([
    session.sessionId,
    ...session.sourceSessionIds,
  ]);
  if (sessionIds.length === 0)
    return { ok: false, error: "This conversation has no stable monitoring identifier." };
  const paused = input.paused === true;
  if (paused && !sessionMonitoringPauseAllowed()) {
    return {
      ok: false,
      error: "Monitoring cannot be paused while mandatory organization protection is active.",
    };
  }

  const expiresAt = Date.now() + SESSION_MONITORING_PAUSE_MS;
  const remote = await syncRemoteSessionMonitoring({
    agentKind: session.agentKind,
    sessionIds,
    paused,
    expiresAt,
  });
  if (!remote.ok) return remote;

  if (paused) {
    const pause = localServer.pauseSessionMonitoring(
      session.agentKind,
      sessionIds,
      SESSION_MONITORING_PAUSE_MS,
    );
    if (!pause) return { ok: false, error: "Could not pause this conversation." };
    pausedIslandSessions.set(session.id, {
      expiresAt: pause.expiresAt,
      session: {
        ...session,
        sourceSessionIds: sessionIds,
        latestAction: "Monitoring paused",
        monitoringPausedUntil: new Date(pause.expiresAt).toISOString(),
      },
    });
  } else {
    localServer.resumeSessionMonitoring(session.agentKind, sessionIds);
    for (const [key, item] of pausedIslandSessions) {
      if (
        item.session.agentKind === session.agentKind &&
        item.session.sourceSessionIds.some((id) => sessionIds.includes(id))
      ) pausedIslandSessions.delete(key);
    }
  }
  schedulePausedIslandSessionRefresh();
  syncActivityIsland(true, latestPending[0], true);
  return {
    ok: true,
    paused,
    expiresAt: paused ? new Date(expiresAt).toISOString() : undefined,
  };
}

function setProjectProtection(payload: unknown) {
  if (!payload || typeof payload !== "object")
    return { ok: false, error: "Project is required." };
  const input = payload as { projectPath?: unknown; protected?: unknown };
  const projectPath = String(input.projectPath ?? "").trim();
  if (!projectPath) return { ok: false, error: "This agent did not report a project folder." };
  const protectedNow = input.protected === true;
  let excludedProjectPaths = localServer.excludedProjectPaths;
  if (protectedNow) {
    for (const excludedPath of excludedProjectPathsCovering(projectPath, excludedProjectPaths)) {
      excludedProjectPaths = localServer.removeExcludedProjectPath(excludedPath);
    }
  } else {
    excludedProjectPaths = localServer.addExcludedProjectPath(projectPath);
  }
  window?.webContents.send("openleash:update", { excludedProjectPaths });
  syncActivityIsland(true);
  return { ok: true, protected: protectedNow, excludedProjectPaths };
}

async function syncRemoteSessionMonitoring(input: {
  agentKind: string;
  sessionIds: string[];
  paused: boolean;
  expiresAt: number;
}) {
  const remoteApiUrl = localServer.remoteApiUrl;
  const token = localServer.effectiveToken;
  if (!remoteApiUrl || !token) return { ok: true };
  try {
    const response = await fetch(new URL("/v1/session-monitoring", remoteApiUrl), {
      method: input.paused ? "POST" : "DELETE",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...apiVersionHeaders("sessionMonitoring"),
      },
      body: JSON.stringify({
        agentKind: input.agentKind,
        sessionIds: input.sessionIds,
        ...(input.paused ? { expiresAt: new Date(input.expiresAt).toISOString() } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      return {
        ok: false,
        error: body.error || "Could not change monitoring for this conversation.",
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Could not reach Leash to change monitoring for this conversation.",
    };
  }
}

function schedulePausedIslandSessionRefresh() {
  if (pausedIslandSessionTimer) clearTimeout(pausedIslandSessionTimer);
  pausedIslandSessionTimer = undefined;
  const nextExpiry = [...pausedIslandSessions.values()]
    .map((item) => item.expiresAt)
    .sort((left, right) => left - right)[0];
  if (!nextExpiry) return;
  pausedIslandSessionTimer = setTimeout(() => {
    pausedIslandSessionTimer = undefined;
    syncActivityIsland(true);
  }, Math.max(0, nextExpiry - Date.now()) + 50);
}

function islandMenuState() {
  const installedAgents = localProtections.filter((agent) => agent.installed);
  const protectedAgents = installedAgents.filter((agent) => agent.protected);
  const sessions = currentActiveAgentSessions();
  const activeSessions = sessions.filter((session) => session.visualState !== "completed");
  return {
    protection: installedAgents.length === 0
      ? "No installed agents detected"
      : `${protectedAgents.length}/${installedAgents.length} agents protected`,
    proxy: proxyStatus.healthy
      ? `Proxy active · ${proxyStatus.configuredAgents.length} agent${proxyStatus.configuredAgents.length === 1 ? "" : "s"}`
      : proxyStatus.running
        ? "Proxy starting"
        : "Proxy off",
    sessions: activeSessions.length > 0
      ? `${activeSessions.length} active session${activeSessions.length === 1 ? "" : "s"}`
      : sessions.length > 0
        ? `${sessions.length} recent session${sessions.length === 1 ? "" : "s"}`
        : "No active sessions",
    approvals: latestPending.length === 0
      ? "No pending approvals"
      : `${latestPending.length} pending approval${latestPending.length === 1 ? "" : "s"}`,
  };
}

function handleIslandCommand(command: string) {
  if (command === "settings" || command === "protection" || command === "proxy") {
    showMainWindow("settings");
    return { ok: true };
  }
  if (command === "check-updates") {
    void checkForUpdates({ source: "manual", force: true });
    return { ok: true };
  }
  if (command === "social-x") {
    void openTrustedExternalUrl("https://x.com/OpenLeashCom");
    return { ok: true };
  }
  if (command === "social-linkedin") {
    void openTrustedExternalUrl("https://www.linkedin.com/company/open-leash/");
    return { ok: true };
  }
  if (command === "approvals") {
    const pending = latestPending[0];
    if (pending) syncActivityIsland(true, pending);
    return { ok: Boolean(pending) };
  }
  if (command === "quit") {
    quitOpenLeash();
    return { ok: true };
  }
  return { ok: false };
}

function activityNoticeKey(
  sessions: ActiveAgentSession[],
  contributions: PluginIslandContribution[],
  pending?: PendingDecision,
) {
  const activity = activityIslandKey(sessions);
  const pluginActivity = contributions
    .map((item) => `${item.pluginId}:${item.key}`)
    .sort()
    .join("|");
  return activityPresentationKey({
    activityKey: activity,
    pluginActivity,
    pendingKey: pending ? pendingNoticeKey(pending) : undefined,
  });
}

function syncActivityIsland(
  force = false,
  pending = latestPending[0],
  manualReveal = false,
) {
  manualReveal ||= manualIslandReveal;
  const sessions = currentActiveAgentSessions();
  const contributions = activeIslandContributions();
  const hasNonTokenSaverContribution = contributions.some(
    (contribution) => contribution.pluginId !== "openleash.prompt-compression",
  );
  const hasVisibleActivity = sessions.length > 0 || hasNonTokenSaverContribution;
  if (!pending && !hasVisibleActivity && Date.now() < completionNoticeUntil) return;
  if (!shouldPresentActivityIsland({
    visibility: localServer.islandVisibility,
    hasPending: Boolean(pending),
    hasVisibleActivity,
    manualReveal,
  })) {
    if (activeNoticeKey?.startsWith("activity:")) closeNoticeWithoutOpeningMainWindow();
    return;
  }
  const key = activityNoticeKey(sessions, contributions, pending);
  const fingerprint = JSON.stringify(pending
    ? {
        pending: [
          pendingNoticeKey(pending),
          pending.id,
          pending.created_at,
          pending.summary,
          pending.question,
          pending.quote,
          latestPending.length,
        ],
      }
    : {
        sessions: sessions.map((session) => [session.id, session.lastActivityAt, session.latestAction, session.eventCount]),
        contributions: contributions.map((item) => [item.id, item.updatedAt, item.expiresAt]),
      });
  if (!force && activeNoticeKey === key && activeActivityFingerprint === fingerprint) return;
  activeActivityFingerprint = fingerprint;
  const autoExpand = pending
    ? (force || shouldAutoExpandAttention(isAgentSessionFrontmost(focusTargetForPending(pending, sessions))))
    : false;
  showDecisionNotice({ kind: "activity", sessions, contributions, pending, autoExpand });
}

function activeIslandContributions() {
  return latestIslandContributions.filter(
    (contribution) => Date.parse(contribution.expiresAt) > Date.now(),
  );
}

function currentActiveAgentSessions() {
  const now = Date.now();
  const cutoff = Date.now() - 10 * 60_000;
  for (const [sessionId, completion] of completedAgentSessions) {
    if (completion.completedAt < cutoff) completedAgentSessions.delete(sessionId);
  }
  for (const [key, hint] of immediateActivityHints) {
    if (hint.expiresAt <= Date.now()) immediateActivityHints.delete(key);
  }
  const current = activeAgentSessions([
    ...latestAgents,
    ...[...immediateActivityHints.values()].map((hint) => hint.source),
  ]);
  const recovered = [...resumedIslandSessions.entries()].flatMap(([key, item]) => {
    if (item.expiresAt <= now) {
      resumedIslandSessions.delete(key);
      return [];
    }
    return [item.session];
  });
  const active = applyCompletedAgentSessions(
    mergeRecoveredAgentSessions(current, recovered),
    completedAgentSessions,
  );
  const activeIds = new Set(active.map((session) => session.id));
  for (const [key, item] of pausedIslandSessions) {
    if (item.expiresAt <= now) {
      localServer.resumeSessionMonitoring(
        item.session.agentKind,
        item.session.sourceSessionIds,
      );
      pausedIslandSessions.delete(key);
    }
  }
  const decorated = active.map((session) => {
    const pause = session.sourceSessionIds
      .map((sessionId) => localServer.sessionMonitoringPause(session.agentKind, sessionId))
      .find(Boolean);
    if (!pause) return session;
    return {
      ...session,
      latestAction: "Monitoring paused",
      monitoringPausedUntil: new Date(pause.expiresAt).toISOString(),
    };
  });
  for (const item of pausedIslandSessions.values()) {
    if (!activeIds.has(item.session.id)) decorated.push(item.session);
  }
  return decorated;
}

function captureActiveSessionsForSystemPause() {
  const sessions = currentActiveAgentSessions().filter(
    (session) => session.visualState !== "completed",
  );
  if (sessions.length > 0) suspendedIslandSessions = sessions;
  startupLog(`system pause captured ${sessions.length} active island session${sessions.length === 1 ? "" : "s"}`);
}

function restoreActiveSessionsAfterSystemResume(reason: "wake" | "unlock") {
  if (suspendedIslandSessions.length === 0) {
    void poll();
    setTimeout(() => syncActivityIsland(true), 180);
    return;
  }
  const resumedAt = Date.now();
  const current = activeAgentSessions([
    ...latestAgents,
    ...[...immediateActivityHints.values()].map((hint) => hint.source),
  ]);
  const recovered = recoverSuspendedAgentSessions(
    suspendedIslandSessions,
    current,
    resumedAt,
  );
  suspendedIslandSessions = [];
  for (const session of recovered) {
    resumedIslandSessions.set(session.id, {
      session,
      expiresAt: resumedAt + 2 * 60_000,
    });
  }
  startupLog(`${reason} recovered ${recovered.length} active island session${recovered.length === 1 ? "" : "s"}`);
  void poll();
  syncActivityIsland(true);
}

function handleImmediateAgentActivity(activity: LocalAgentActivity) {
  const key = [activity.agentKind, activity.sessionId, activity.projectPath ?? "workspace"].join(":");
  const previous = immediateActivityHints.get(key)?.source;
  immediateActivityHints.set(key, {
    source: mergeImmediateAgentActivity(previous, activity),
    expiresAt: Date.now() + 15_000,
  });
  syncActivityIsland();
  refreshPendingApprovalsSoon();
}

function rememberCompletedAgentSessions(events: AttentionEvent[]) {
  for (const event of events) {
    if (event.kind !== "completed" || !event.session?.id) continue;
    const completedAt = Date.parse(event.createdAt);
    completedAgentSessions.set(event.session.id, {
      completedAt: Number.isFinite(completedAt) ? completedAt : Date.now(),
      response: event.body,
    });
  }
}

function showAgentDetail(_agent: AgentStatus) {
  showMainWindow("settings");
}

function largestDisplay(): Display {
  return screen.getAllDisplays().reduce((largest, candidate) => {
    const largestArea = largest.workArea.width * largest.workArea.height;
    const candidateArea = candidate.workArea.width * candidate.workArea.height;
    return candidateArea > largestArea ? candidate : largest;
  }, screen.getPrimaryDisplay());
}

function centerWindowOnLargestDisplay(target: BrowserWindow) {
  const display = largestDisplay().workArea;
  const bounds = target.getBounds();
  target.setPosition(
    Math.round(display.x + (display.width - bounds.width) / 2),
    Math.round(display.y + (display.height - bounds.height) / 2),
    false,
  );
}

function fitMainWindowOnLargestDisplay(target: BrowserWindow) {
  const display = largestDisplay().workArea;
  const width = Math.min(
    MAIN_WINDOW_WIDTH,
    Math.max(MAIN_WINDOW_MIN_WIDTH, display.width - 48),
  );
  const height = Math.min(
    MAIN_WINDOW_HEIGHT,
    Math.max(MAIN_WINDOW_MIN_HEIGHT, display.height - 48),
  );
  target.setMinimumSize(
    Math.min(MAIN_WINDOW_MIN_WIDTH, width),
    Math.min(MAIN_WINDOW_MIN_HEIGHT, height),
  );
  target.setBounds(
    {
      x: Math.round(display.x + (display.width - width) / 2),
      y: Math.round(display.y + (display.height - height) / 2),
      width,
      height,
    },
    false,
  );
}

type DecisionNotice =
  | { kind: "ask"; pending: PendingDecision }
  | { kind: "attention"; event: AttentionEvent }
  | {
      kind: "activity";
      sessions: ActiveAgentSession[];
      contributions: PluginIslandContribution[];
      pending?: PendingDecision;
      autoExpand?: boolean;
    }
  | {
      kind: "install_success";
      agentName: string;
      title: string;
      summary: string;
      restartTargets?: RunningAgentRestartTarget[];
    }
  | {
      kind: "sample";
      agentName: string;
      summary: string;
      policy: string;
      project: string;
    };

function noticeWorkArea(notice: DecisionNotice) {
  if (notice.kind === "attention" || notice.kind === "ask" || notice.kind === "activity") {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
  }
  return largestDisplay().bounds;
}

function nativeIslandExecutable() {
  const names = app.isPackaged
    ? [
        path.join(process.resourcesPath, "app.asar.unpacked", "apps", "desktop", "dist", "openleash-island"),
        path.join(process.resourcesPath, "app.asar.unpacked", "dist", "openleash-island"),
      ]
    : [path.join(here, "openleash-island")];
  return names.find((candidate) => fs.existsSync(candidate));
}

function ensureNativeIslands() {
  if (process.platform !== "darwin") return [];
  const executable = nativeIslandExecutable();
  const html = executable && app.isPackaged
    ? path.join(path.dirname(executable), "notice.html")
    : path.join(here, "notice.html");
  if (!executable || !fs.existsSync(html)) return [];

  const displayIds = new Set(screen.getAllDisplays().map((display) => display.id));
  for (const [displayId, host] of nativeIslandHosts) {
    if (displayIds.has(displayId) && !host.process.killed) continue;
    host.process.kill();
    nativeIslandHosts.delete(displayId);
  }
  for (const displayId of displayIds) {
    if (nativeIslandHosts.has(displayId)) continue;
    try {
      const child = spawn(executable, [html], { stdio: ["pipe", "pipe", "pipe"] });
      const host: NativeIslandHost = {
        displayId,
        process: child,
        ready: false,
        output: "",
      };
      nativeIslandHosts.set(displayId, host);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        host.output += chunk;
        let newline = host.output.indexOf("\n");
        while (newline >= 0) {
          const line = host.output.slice(0, newline).trim();
          host.output = host.output.slice(newline + 1);
          if (line) handleNativeIslandMessage(line, host);
          newline = host.output.indexOf("\n");
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        const message = chunk.trim();
        if (message) startupLog(`native island display ${displayId}: ${message}`);
      });
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") startupLog(`native island display ${displayId} input failed: ${error.message}`);
        if (nativeIslandHosts.get(displayId) === host) nativeIslandHosts.delete(displayId);
        host.ready = false;
        if (!child.killed) child.kill();
      });
      child.once("error", (error) => {
        startupLog(`native island display ${displayId} failed: ${error.message}`);
      });
      child.once("exit", (code, signal) => {
        if (!quitting) startupLog(`native island display ${displayId} exited (${code ?? signal ?? "unknown"})`);
        if (nativeIslandHosts.get(displayId) === host) nativeIslandHosts.delete(displayId);
        host.ready = false;
      });
    } catch (error) {
      startupLog(`native island display ${displayId} launch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...nativeIslandHosts.values()];
}

function sendNativeIsland(
  message: Record<string, unknown>,
  target?: NativeIslandHost,
) {
  const hosts = target ? [target] : [...nativeIslandHosts.values()];
  let sent = false;
  for (const host of hosts) {
    const input = host.process.stdin;
    if (!input || input.destroyed) continue;
    try {
      input.write(`${JSON.stringify(message)}\n`);
      sent = true;
    } catch (error) {
      startupLog(`native island display ${host.displayId} input failed: ${error instanceof Error ? error.message : String(error)}`);
      if (nativeIslandHosts.get(host.displayId) === host) nativeIslandHosts.delete(host.displayId);
      host.ready = false;
    }
  }
  return sent;
}

function passiveNativeIslandPayload() {
  const sessions = currentActiveAgentSessions();
  const contributions = activeIslandContributions();
  const hasVisibleActivity = sessions.length > 0 || contributions.some(
    (contribution) => contribution.pluginId !== "openleash.prompt-compression",
  );
  if (!shouldPresentActivityIsland({
    visibility: localServer.islandVisibility,
    hasPending: false,
    hasVisibleActivity,
  })) return undefined;
  return {
    ...(formatNotice({
      kind: "activity",
      sessions,
      contributions,
    }) as Record<string, unknown>),
    islandMenu: islandMenuState(),
  };
}

function showNativeIsland(payload: Record<string, unknown>, noticeKey: string) {
  const hosts = ensureNativeIslands();
  if (hosts.length === 0) return false;
  const activeDisplayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
  const passivePayload = passiveNativeIslandPayload();
  suppressMainWindowActivation();
  noticeWindow?.destroy();
  noticeWindow = undefined;
  activeNoticeKey = noticeKey;
  const presentations = new Map(islandDisplayTargets(
    hosts.map((host) => host.displayId),
    activeDisplayId,
    Boolean(passivePayload),
  ).map((item) => [item.displayId, item.presentation]));
  for (const host of hosts) {
    const presentation = presentations.get(host.displayId);
    const hostPayload = presentation === "active"
      ? payload
      : presentation === "passive"
        ? passivePayload
        : undefined;
    if (!hostPayload) {
      host.pendingMessage = undefined;
      if (host.ready) sendNativeIsland({ type: "dismiss" }, host);
      continue;
    }
    host.pendingMessage = {
      type: "show",
      payload: hostPayload,
      displayId: host.displayId,
      reposition: true,
    };
    if (host.ready) sendNativeIsland(host.pendingMessage, host);
  }
  return true;
}

function handleNativeIslandMessage(line: string, host: NativeIslandHost) {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    startupLog(`native island display ${host.displayId} returned malformed JSON`);
    return;
  }
  if (message.type === "ready") {
    host.ready = true;
    if (host.pendingMessage) sendNativeIsland(host.pendingMessage, host);
    return;
  }
  if (message.type !== "action") return;
  if (message.action === "dismiss") {
    dismissNoticeByUser();
    return;
  }
  if (message.action === "jump") {
    const payload = message.payload && typeof message.payload === "object"
      ? message.payload as AgentSessionFocusTarget & { session?: AgentSessionFocusTarget }
      : undefined;
    void openAgentApplication(payload?.session ?? payload);
    return;
  }
  if (message.action === "restart-agent-targets") {
    const payload = message.payload && typeof message.payload === "object"
      ? message.payload as { targetIds?: unknown[] }
      : undefined;
    const targetIds = Array.isArray(payload?.targetIds) ? payload.targetIds.map(String) : [];
    void restartRunningAgentTargets(targetIds, [...enforcedAgentKinds]);
    return;
  }
  if (message.action === "session-monitoring") {
    void setSessionMonitoring(message.payload);
    return;
  }
  if (message.action === "project-protection") {
    void setProjectProtection(message.payload);
    return;
  }
  if (message.action === "plugin-action") {
    void handlePluginIslandAction(message.payload);
    return;
  }
  if (message.action === "island-command") {
    void handleIslandCommand(String(message.command ?? ""));
    return;
  }
  if (message.action === "resolve") {
    const resolution = message.resolution === "allow" ? "allow" : "deny";
    const response = message.response && typeof message.response === "object"
      ? message.response as Record<string, unknown>
      : undefined;
    void resolveDecision(
      String(message.id ?? ""),
      resolution,
      typeof message.guidance === "string" ? message.guidance : "",
      Number(message.rememberForMs ?? 0),
      response,
    );
  }
}

function showDecisionNotice(notice: DecisionNotice) {
  if (localServer.islandVisibility === "off" && !manualIslandReveal) return;
  const display = noticeWorkArea(notice);
  const width = 300;
  const supportsGuidance =
    notice.kind === "ask"
      ? supportsAgentGuidance(notice.pending.agent_kind)
      : false;
  const height = 118;
  const noticeKey =
    notice.kind === "ask"
      ? decisionNoticeKey(notice.pending)
      : notice.kind === "attention"
        ? notice.event.id
        : notice.kind === "activity"
          ? activityNoticeKey(notice.sessions, notice.contributions, notice.pending)
        : notice.kind;
  maybePlayActionRequiredSound(notice);
  const payload = {
    ...(formatNotice(notice) as Record<string, unknown>),
    islandMenu: islandMenuState(),
  };
  if (process.platform === "darwin" && showNativeIsland(payload, noticeKey)) {
    if (notice.kind === "attention") scheduleAttentionDismiss(noticeKey);
    return;
  }
  if (
    activeNoticeKey === noticeKey &&
    noticeWindow &&
    !noticeWindow.isDestroyed()
  ) {
    noticeWindow.webContents.send("openleash:notice", payload);
    if (!noticeWindow.isVisible()) noticeWindow.showInactive();
    return;
  }
  const previousNoticeWindow = noticeWindow;
  previousNoticeWindow?.close();
  suppressMainWindowActivation();
  activeNoticeKey = noticeKey;
  const createdNoticeWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(display.x + (display.width - width) / 2),
    y: Math.round(display.y + (process.platform === "darwin" ? 0 : 10)),
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    hiddenInMissionControl: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    acceptFirstMouse: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(here, "preload.js"),
    },
  });
  noticeWindow = createdNoticeWindow;
  hardenWindow(noticeWindow);
  createdNoticeWindow.setIgnoreMouseEvents(true, { forward: true });
  noticeWindow.setAlwaysOnTop(true, "screen-saver");
  noticeWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  noticeWindow.loadFile(path.join(here, "notice.html"));
  noticeWindow.once("closed", () => {
    if (noticeWindow !== createdNoticeWindow) return;
    noticeWindow = undefined;
    if (activeNoticeKey === noticeKey) activeNoticeKey = undefined;
  });
  noticeWindow.webContents.once("did-finish-load", () => {
    if (
      noticeWindow !== createdNoticeWindow ||
      createdNoticeWindow.isDestroyed()
    )
      return;
    createdNoticeWindow.webContents.send(
      "openleash:notice",
      payload,
    );
    createdNoticeWindow.showInactive();
    createdNoticeWindow.setAlwaysOnTop(true, "screen-saver");
    createdNoticeWindow.moveTop();
    if (notice.kind === "attention") scheduleAttentionDismiss(noticeKey);
  });
}

function scheduleAttentionDismiss(noticeKey: string) {
  if (noticeDismissTimer) clearTimeout(noticeDismissTimer);
  noticeDismissTimer = setTimeout(() => {
    if (activeNoticeKey === noticeKey) syncActivityIsland(true);
  }, 5200);
}

function formatPendingNotice(item: PendingDecision) {
  return {
    kind: "ask",
    id: item.id,
    intentKey: pendingNoticeKey(item),
    agentName: item.agent_name,
    agentKind: item.agent_kind,
    agentIcon: noticeAgentIconFor(item.agent_name),
    action: friendlyAction(item.event_name, item.tool_name),
    title: approvalTitle(item),
    summary: approvalSummary(item),
    purpose: undefined,
    evidence: item.quote || requestText(item.payload),
    contextSummary: precedingContextSummary(item),
    detail: noticeDetail(item),
    policy: item.triggered_policies?.[0]?.policy_name,
    pluginName: noticePluginName(item),
    project: projectTag(item.project_path),
    time: timeAgo(item.created_at),
    supportsGuidance: supportsAgentGuidance(item.agent_kind),
    pendingCount: latestPending.length,
    visualState: "waiting",
    interaction: interactionForPending(item),
  };
}

function formatNotice(notice: DecisionNotice) {
  if (notice.kind === "ask") {
    return formatPendingNotice(notice.pending);
  }
  if (notice.kind === "attention") {
    return {
      kind: notice.event.kind,
      id: undefined,
      eventId: notice.event.id,
      agentName: notice.event.agent?.name ?? "AI agent",
      agentKind: notice.event.agent?.kind ?? "unknown",
      agentIcon: noticeAgentIconFor(notice.event.agent?.name ?? ""),
      title: notice.event.title,
      summary: notice.event.body,
      project: projectTag(notice.event.session?.projectPath),
      time: timeAgo(notice.event.createdAt),
      session: notice.event.session,
      canJump: canOpenAgent(notice.event.agent?.kind),
      visualState: notice.event.kind === "completed" ? "completed" : undefined,
    };
  }
  if (notice.kind === "activity") {
    const rankedSessions = prioritizeAgentSessions(notice.sessions, notice.pending ? {
      agentKind: notice.pending.agent_kind,
      projectPath: notice.pending.project_path,
      sessionId: pendingSessionId(notice.pending),
    } : undefined);
    const decorated = notice.contributions.map(decorateIslandContribution);
    const sourceSessionIds = rankedSessions.flatMap((session) => session.sourceSessionIds);
    const ambient = ambientIslandContributions(decorated, sourceSessionIds)
      .filter((item) => item.pluginId !== "openleash.prompt-compression");
    const tokenSaver = latestTokenSaverSavings(decorated);
    const activeSessionCount = notice.sessions.filter((session) => session.visualState !== "completed").length;
    const presentation = activityIslandPresentationSummary({
      sessionCount: notice.sessions.length,
      activeSessionCount,
      pluginUpdateCount: ambient.length,
      pendingCount: notice.pending ? latestPending.length : 0,
      pendingAgentName: notice.pending?.agent_name,
    });
    return {
      kind: "activity",
      agentName: "Leash",
      agentIcon: noticeAgentIconFor("Leash"),
      title: presentation.title,
      project: presentation.project,
      autoExpand: notice.autoExpand ?? Boolean(notice.pending),
      sessions: rankedSessions.map((session) => ({
        ...session,
        agentIcon: noticeAgentIconFor(session.agentName),
        canJump: canOpenAgent(session.agentKind),
        canSetProjectProtection: Boolean(session.projectPath),
        projectProtected: !localServer.isProjectExcluded(session.projectPath),
        canPauseMonitoring:
          Boolean(session.monitoringPausedUntil) ||
          (
            session.visualState !== "completed" &&
            sessionMonitoringPauseAllowed() &&
            pausableSessionIds([session.sessionId, ...session.sourceSessionIds]).length > 0
          ),
        time: timeAgo(session.lastActivityAt),
        contributions: contributionsForSession(decorated, session.sourceSessionIds),
      })),
      contributions: ambient,
      tokenSaver,
      attention: notice.pending ? formatPendingNotice(notice.pending) : undefined,
      pendingCount: latestPending.length,
    };
  }
  if (notice.kind === "sample") {
    return {
      kind: "sample",
      agentName: notice.agentName,
      agentIcon: noticeAgentIconFor(notice.agentName),
      summary: notice.summary,
      policy: notice.policy,
      project: notice.project,
      time: "example",
    };
  }
  return {
    kind: "install_success",
    agentName: notice.agentName,
    agentIcon: noticeAgentIconFor(notice.agentName),
    title: notice.title,
    summary: notice.summary,
    restartTargets: notice.restartTargets ?? [],
    time: "ready",
  };
}

function noticeAgentIconFor(name: string) {
  const value = name.toLowerCase();
  if (value.includes("openleash")) return "openleash-icon.png";
  const local = value.includes("claude")
    ? "claude"
    : value.includes("codex") || value.includes("openai")
      ? "openai"
      : value.includes("opencode")
        ? "opencode"
        : value.includes("gemini")
          ? "gemini"
          : value.includes("github") || value.includes("copilot")
            ? "copilot"
            : value.includes("cursor")
              ? "cursor"
              : undefined;
  return local ? `agent-icons/${local}.svg` : agentIconFor(name);
}

function noticePluginName(item: PendingDecision) {
  const payload =
    item.payload && typeof item.payload === "object"
      ? (item.payload as {
          openleashPluginRuns?: Array<{
            pluginId?: string;
            plugin_id?: string;
            decision?: string;
          }>;
        })
      : undefined;
  const runs = Array.isArray(payload?.openleashPluginRuns)
    ? payload.openleashPluginRuns
    : [];
  return responsiblePluginSlug(item.plugin_id, {
    openleashPluginRuns: runs,
  });
}

function approvalTitle(item: PendingDecision) {
  const text = `${requestText(item.payload) ?? ""} ${item.summary ?? ""}`;
  if (/\b(?:drop|delete|remove)\b[\s\S]{0,80}\b(?:sqlite\s+)?tables?\b/i.test(text)) {
    return "Delete database tables?";
  }
  return "Permission request";
}

function approvalSummary(item: PendingDecision) {
  const plugin = noticePluginName(item);
  const text = `${requestText(item.payload) ?? ""} ${item.summary ?? ""}`;
  if (plugin === "blast-radius" && /\b(?:drop|delete|remove)\b[\s\S]{0,80}\btables?\b/i.test(text)) {
    return "This can permanently erase data in the SQLite database.";
  }
  const policy = item.triggered_policies?.[0];
  return truncate(policy?.explanation || item.summary || "This action needs your approval.", 150);
}

function decorateIslandContribution(contribution: PluginIslandContribution) {
  const plugin = latestPlugins.find((item) => item.id === contribution.pluginId);
  const pluginName = canonicalPluginSlug(plugin?.slug || contribution.pluginId);
  const iconText = (plugin as { marketplace?: { iconText?: unknown } } | undefined)?.marketplace?.iconText;
  return {
    ...contribution,
    pluginName,
    pluginIcon: typeof iconText === "string" && iconText.trim() ? iconText.trim() : "OL",
  };
}

function precedingContextSummary(item: PendingDecision) {
  const turns = (item.recent_context ?? []).filter((turn) =>
    turn.content?.trim(),
  );
  if (turns.length < 2) return undefined;
  const prior = turns.slice(0, -1).slice(-2);
  return prior
    .map(
      (turn) =>
        `${turn.role === "assistant" ? "Agent" : "User"}: ${truncate(String(turn.content).replace(/\s+/g, " "), 90)}`,
    )
    .join(" · ");
}

function supportsAgentGuidance(agentKind?: string) {
  return ["claude-code", "codex", "openclaw", "nanoclaw"].includes(
    String(agentKind ?? ""),
  );
}

function noticeDetail(item: {
  project_path?: string;
  hostname?: string;
  payload?: unknown;
}) {
  return [projectTag(item.project_path), item.hostname]
    .filter(Boolean)
    .join(" · ");
}

function noticePurpose(item: {
  event_name?: string;
  tool_name?: string;
  payload?: unknown;
  question?: string;
  summary?: string;
}) {
  const payload =
    item.payload && typeof item.payload === "object"
      ? (item.payload as {
          openleashPurposeSummary?: unknown;
          transcript?: Array<{ role?: string; content?: string }>;
          prompt?: string;
          tool?: { name?: string; input?: unknown };
        })
      : undefined;
  if (
    typeof payload?.openleashPurposeSummary === "string" &&
    payload.openleashPurposeSummary.trim()
  ) {
    return payload.openleashPurposeSummary.trim();
  }
  const recent =
    payload?.transcript?.slice(-NOTICE_CONTEXT_MESSAGE_COUNT) ?? [];
  const latestUser = [...recent]
    .reverse()
    .find((turn) => turn.role === "user" && turn.content?.trim())?.content;
  const prompt = payload?.prompt || latestUser;
  const action =
    item.tool_name || payload?.tool?.name
      ? `use ${item.tool_name ?? payload?.tool?.name}`
      : item.event_name === "UserPromptSubmit"
        ? "answer the latest prompt"
        : "continue the current task";
  if (prompt)
    return `It appears to ${action} for: ${truncate(prompt.replace(/\s+/g, " "), 110)}`;
  return undefined;
}

function requestText(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const event = payload as { prompt?: unknown; tool?: { input?: unknown } };
  if (typeof event.prompt === "string" && event.prompt.trim())
    return truncate(event.prompt, 220);
  const input = event.tool?.input;
  if (typeof input === "string" && input.trim()) return truncate(input, 120);
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const value =
      record.command ?? record.file_path ?? record.path ?? record.url;
    if (typeof value === "string" && value.trim()) return truncate(value, 120);
  }
  return undefined;
}

function evidenceItems(value: string[] | string | undefined) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        )
      : [value];
  } catch {
    return [value];
  }
}

function projectTag(value?: string) {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function friendlyAction(eventName?: string, toolName?: string) {
  if (/^Write$/i.test(toolName || "") || /^MultiEdit$/i.test(toolName || ""))
    return "edit a file";
  if (toolName) return `use ${toolName}`;
  if (eventName === "UserPromptSubmit") return "submit your prompt";
  if (eventName === "PreToolUse") return "use a tool";
  if (eventName === "PostToolUse") return "finish a tool result";
  if (eventName === "Stop") return "finish this session";
  return "continue";
}

let lastAgentDoneSoundAt = 0;
let lastQuestionSoundAt = 0;
function handleLocalAgentStop(event: { agent: string; body: unknown }) {
  if (isBackgroundControlPending({
    agent_kind: event.agent,
    payload: event.body,
  })) return;
  const body = objectValue(event.body);
  const agentName = localAgentDisplayName(event.agent);
  const sessionId = String(body?.session_id ?? body?.sessionId ?? "unknown");
  const attention: AttentionEvent = {
    schemaVersion: "2026-07-19.v1",
    id: `local-completed:${event.agent}:${sessionId === "unknown" ? Date.now() : sessionId}`,
    kind: "completed",
    state: "resolved",
    title: `${agentName} finished`,
    body:
      [body?.last_assistant_message, body?.prompt_response, body?.message]
        .find((value): value is string => typeof value === "string" && value.trim().length > 0)
        ?.trim()
        .slice(0, 180) ?? "The agent finished its latest turn.",
    createdAt: new Date().toISOString(),
    agent: { kind: event.agent, name: agentName, hostname: os.hostname() },
    session: {
      id: sessionId,
      projectPath:
      typeof body?.cwd === "string" ? body.cwd : undefined,
    },
  };
  if (sessionId !== "unknown") {
    completedAgentSessions.set(sessionId, {
      completedAt: Date.parse(attention.createdAt),
      response: attention.body,
    });
  }
  seenAttentionEventIds.add(attention.id);
  if (!latestPending.length) {
    completionNoticeUntil = Date.now() + 3_200;
    if (completionNoticeTimer) clearTimeout(completionNoticeTimer);
    showDecisionNotice({ kind: "attention", event: attention });
    completionNoticeTimer = setTimeout(() => {
      completionNoticeUntil = 0;
      completionNoticeTimer = undefined;
      syncActivityIsland(true);
    }, 3_200);
  }
  if (localServer.agentDoneSound) playAgentDoneSound();
}

function localAgentDisplayName(agent: string) {
  const names: Record<string, string> = {
    claude: "Claude Code",
    codex: "OpenAI Codex",
    gemini: "Gemini CLI",
    opencode: "OpenCode",
    cursor: "Cursor",
    copilot: "GitHub Copilot",
    nanoclaw: "NanoClaw",
    openclaw: "OpenClaw",
  };
  return names[agent] ?? agent;
}

function playAgentDoneSound() {
  const now = Date.now();
  if (now - lastAgentDoneSoundAt < 1200) return;
  lastAgentDoneSoundAt = now;
  if (process.platform === "darwin") {
    const child = spawn("afplay", ["/System/Library/Sounds/Glass.aiff"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return;
  }
  process.stdout.write("\x07");
}

function maybePlayActionRequiredSound(notice: DecisionNotice) {
  if (!localServer?.agentDoneSound) return;
  const key = notice.kind === "ask"
    ? decisionNoticeKey(notice.pending)
    : notice.kind === "activity" && notice.pending
      ? decisionNoticeKey(notice.pending)
      : notice.kind === "attention" && notice.event.state === "waiting" && ["approval", "question", "plan_review"].includes(notice.event.kind)
        ? `attention:${notice.event.id}`
        : undefined;
  if (!key || soundedActionableNoticeKeys.has(key)) return;
  soundedActionableNoticeKeys.add(key);
  playQuestionSound();
}

function playQuestionSound() {
  const now = Date.now();
  if (now - lastQuestionSoundAt < 1200) return;
  lastQuestionSoundAt = now;
  const soundPath = path.join(here, "question.mp3");
  const command = process.platform === "darwin"
    ? { executable: "afplay", args: [soundPath] }
    : process.platform === "win32"
      ? {
          executable: "powershell.exe",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName PresentationCore; $player = New-Object System.Windows.Media.MediaPlayer; $player.Open([Uri]$args[0]); $player.Play(); Start-Sleep -Milliseconds 3000",
            soundPath,
          ],
        }
      : { executable: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", soundPath] };
  const child = spawn(command.executable, command.args, {
    stdio: "ignore",
    detached: true,
  });
  child.once("error", () => process.stdout.write("\x07"));
  child.unref();
}

function openAgentApplication(target?: string | AgentSessionFocusTarget) {
  const session = typeof target === "string" ? { agentKind: target } : target ?? {};
  return focusAgentSession(session);
}

function focusTargetForPending(
  pending: PendingDecision,
  sessions = currentActiveAgentSessions(),
): AgentSessionFocusTarget {
  const project = projectTag(pending.project_path);
  const sessionId = pendingSessionId(pending);
  const match = sessions.find((session) =>
    session.agentKind === pending.agent_kind &&
    (sessionId ? session.sourceSessionIds.includes(sessionId) : true) &&
    (pending.project_path ? session.projectPath === pending.project_path : true)
  ) ?? sessions.find((session) => session.agentKind === pending.agent_kind && session.project === project);
  return {
    agentKind: pending.agent_kind,
    agentName: pending.agent_name,
    sessionId: sessionId ?? match?.sessionId,
    sourceSessionIds: match?.sourceSessionIds,
    projectPath: pending.project_path ?? match?.projectPath,
    project: match?.project ?? project,
    title: match?.title ?? pending.summary,
  };
}

function pendingSessionId(item: PendingDecision) {
  const payload = objectValue(item.payload);
  const raw = objectValue(payload?.raw);
  const value = payload?.session_id ?? payload?.sessionId ?? raw?.session_id ?? raw?.sessionId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function configureLocalAgent() {
  const dir = path.join(os.homedir(), ".openleash");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    `${JSON.stringify(
      {
        apiUrl,
        // Agent hooks authenticate only to the loopback edge. The managed
        // Cloud credential never leaves the desktop process or lands in an
        // agent config file.
        token: localServer.token,
        mode: localServer.clientMode,
        remoteApiUrl: localServer.remoteApiUrl,
        clientVersion: app.getVersion(),
        enrolledAt: new Date().toISOString(),
        computer: {
          id: localServer.deviceIdentity(),
          hostname: os.hostname(),
        },
      },
      null,
      2,
    )}\n`,
  );
}

function localHookInstallContext() {
  return {
    apiUrl,
    token: localServer.token,
    clientVersion: app.getVersion(),
    apiFunction: "localHookEvaluate",
    apiVersion: "2026-05-22.local-hook-evaluate.v1",
    availabilityFailOpen: localServer.availabilityFailOpen,
  };
}

function interactionForPending(item: PendingDecision) {
  const payload = objectValue(item.payload);
  const tool = objectValue(payload?.tool);
  const input = objectValue(tool?.input) ?? {};
  if (/^AskUserQuestion$/i.test(item.tool_name ?? "")) {
    const questions = Array.isArray(input.questions)
      ? input.questions
          .map((value) => objectValue(value))
          .filter((value): value is Record<string, unknown> => Boolean(value))
          .slice(0, 4)
          .map((question) => ({
            question: String(question.question ?? "").trim(),
            header: String(question.header ?? "Question").trim().slice(0, 40),
            multiSelect: Boolean(question.multiSelect ?? question.multiple),
            options: (Array.isArray(question.options) ? question.options : [])
              .map((value) => objectValue(value))
              .filter((value): value is Record<string, unknown> => Boolean(value))
              .slice(0, 12)
              .map((option) => ({
                label: String(option.label ?? "").trim(),
                description:
                  typeof option.description === "string"
                    ? option.description.trim()
                    : undefined,
              }))
              .filter((option) => option.label),
          }))
          .filter((question) => question.question)
      : [];
    return { type: "questions", questions, originalInput: input };
  }
  if (/^ExitPlanMode$/i.test(item.tool_name ?? "")) {
    const raw = objectValue(payload?.raw);
    const markdown = [
      input.plan,
      input.content,
      input.planContent,
      raw?.plan,
      raw?.plan_content,
      raw?.planContent,
    ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
    return { type: "plan", markdown, originalInput: input };
  }
  return { type: "approval" };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function canOpenAgent(kind?: string) {
  return Boolean(kind && kind !== "unknown");
}

function hookInstallContext() {
  return {
    // Keep agent integrations pointed at the stable desktop edge. The edge
    // owns Cloud forwarding and availability classification, so an outage or
    // recovery never requires rewriting hooks or restarting an IDE.
    apiUrl,
    token: localServer.token,
    clientVersion: app.getVersion(),
    apiFunction: "localHookEvaluate",
    apiVersion: "2026-05-22.local-hook-evaluate.v1",
    availabilityFailOpen: localServer.availabilityFailOpen,
  };
}

function normalizeRemoteApiUrl(value: string) {
  const trimmed = String(value || "").trim();
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = new URL(withProtocol);
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("Remote API URL must use http or https.");
  if ((url.username || url.password) && !isLocalApiHost(url.hostname)) {
    throw new Error("Remote API URL cannot include credentials.");
  }
  if (url.protocol === "http:" && !isLocalApiHost(url.hostname)) {
    throw new Error(
      "Remote API URL must use https unless it is local development.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function isLocalApiHost(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function isLocalApiUrl(value: string) {
  try {
    return isLocalApiHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

async function checkSelfHostedRuntime() {
  const dockerExecutable = findDockerExecutable();
  const docker = spawnSync(dockerExecutable, ["--version"], { encoding: "utf8" });
  const dockerInstalled = docker.status === 0;
  const info = dockerInstalled
    ? spawnSync(dockerExecutable, ["info"], { encoding: "utf8", timeout: 8000 })
    : undefined;
  const dockerRunning = Boolean(info && info.status === 0);
  const apiReachable = await canReach("http://127.0.0.1:9318/health");
  return {
    dockerInstalled,
    dockerRunning,
    apiReachable,
    status: apiReachable
      ? "Leash API is reachable"
      : dockerRunning
        ? "Docker is ready"
        : dockerInstalled
          ? "Docker is installed but not running"
          : "Docker is not installed",
    log: [docker.stdout, docker.stderr, info?.stderr]
      .filter(Boolean)
      .join("\n")
      .trim(),
  };
}

async function startSelfHostedRuntime() {
  const before = await checkSelfHostedRuntime();
  // run.py's Individual Open Source mode already owns the real local client-api
  // and Postgres processes. Starting the installed Compose runtime here would
  // put an older container on the same IPv4 port and silently split desktop,
  // proxy, and hook traffic across two backends.
  if (
    process.env.OPENLEASH_CLIENT_MODE === "custom" &&
    process.env.OPENLEASH_CLOUD_API_URL &&
    before.apiReachable
  ) {
    return {
      ...before,
      status: "Using the local Leash development backend.",
      log: `Backend: ${process.env.OPENLEASH_CLOUD_API_URL}`,
    };
  }
  if (!before.dockerInstalled) {
    await openTrustedExternalUrl(
      "https://www.docker.com/products/docker-desktop/",
    );
    return {
      ...before,
      status:
        "Docker Desktop is required. Install it, start it, then continue.",
      log: before.log,
    };
  }
  if (!before.dockerRunning) {
    return {
      ...before,
      status: "Start Docker Desktop, then click Start local Leash again.",
      log: before.log,
    };
  }
  const runtimeDir = path.join(
    os.homedir(),
    ".openleash",
    "individual-open-source",
  );
  ensureIndividualOpenSourceRuntime(runtimeDir);
  const dockerExecutable = findDockerExecutable();
  const dockerEnv = individualOpenSourceDockerEnvironment(runtimeDir);
  const compose = dockerComposeArgs();
  const setup = [
    spawnSync(dockerExecutable, [...compose, "pull"], {
      encoding: "utf8",
      timeout: 300000,
      cwd: runtimeDir,
      env: dockerEnv,
    }),
    spawnSync(dockerExecutable, [...compose, "up", "-d", "postgres"], {
      encoding: "utf8",
      timeout: 180000,
      cwd: runtimeDir,
      env: dockerEnv,
    }),
    spawnSync(
      dockerExecutable,
      [...compose, "--profile", "setup", "run", "--rm", "migrate"],
      { encoding: "utf8", timeout: 180000, cwd: runtimeDir, env: dockerEnv },
    ),
    spawnSync(
      dockerExecutable,
      [...compose, "--profile", "setup", "run", "--rm", "seed"],
      { encoding: "utf8", timeout: 180000, cwd: runtimeDir, env: dockerEnv },
    ),
    spawnSync(dockerExecutable, [...compose, "up", "-d", "client-api"], {
      encoding: "utf8",
      timeout: 180000,
      cwd: runtimeDir,
      env: dockerEnv,
    }),
  ];
  const failed = setup.find((result) => result.status !== 0);
  const apiReachable = await waitForReachable(
    `${individualOpenSourceApiUrl}/health`,
    60000,
  );
  return {
    dockerInstalled: true,
    dockerRunning: true,
    apiReachable,
    status: apiReachable
      ? "Setup finished. Local Leash is ready."
      : "Containers started, but setup is not ready yet.",
    log: [
      `Runtime: ${runtimeDir}`,
      ...setup.flatMap((result) => [result.stdout, result.stderr]),
      failed ? `Failed command exited ${failed.status}` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .trim(),
  };
}

function dockerComposeArgs() {
  const compose = spawnSync(findDockerExecutable(), ["compose", "version"], {
    encoding: "utf8",
  });
  if (compose.status === 0) return ["compose"];
  return ["compose"];
}

function individualOpenSourceDockerEnvironment(runtimeDir: string) {
  // Public runtime images do not need the user's registry credentials. A GUI
  // launch can otherwise hang forever in docker-credential-desktop while the
  // keychain helper waits for an unavailable terminal interaction.
  const configDir = path.join(runtimeDir, ".docker");
  const configPath = path.join(configDir, "config.json");
  fs.mkdirSync(configDir, { recursive: true });
  const cliPluginsExtraDirs = process.platform === "darwin"
    ? ["/Applications/Docker.app/Contents/Resources/cli-plugins"].filter(
        (candidate) => fs.existsSync(candidate),
      )
    : [];
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ cliPluginsExtraDirs }, null, 2)}\n`,
  );
  return { ...process.env, DOCKER_CONFIG: configDir };
}

function ensureIndividualOpenSourceRuntime(runtimeDir: string) {
  fs.mkdirSync(path.join(runtimeDir, "backups"), { recursive: true });
  const envPath = path.join(runtimeDir, ".env");
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(
      envPath,
      [
        "OPENLEASH_IMAGE_REGISTRY=ghcr.io/open-leash",
        `OPENLEASH_VERSION=${process.env.OPENLEASH_BACKEND_VERSION || "0.37.0@sha256:caa0f268c62e5cf2cf29076877a8b6ca3caf00ddedc8c5229e10df8c929661db"}`,
        "OPENLEASH_POSTGRES_DB=openleash",
        "OPENLEASH_POSTGRES_USER=openleash",
        `OPENLEASH_POSTGRES_PASSWORD=${randomHexSecret()}`,
        "OPENLEASH_CLIENT_API_PORT=9318",
        `OPENLEASH_RELEASE_ADMIN_TOKEN=${randomHexSecret()}`,
        `OPENLEASH_MODEL_KEY_ENCRYPTION_KEY=${randomHexSecret()}`,
        `OPENLEASH_PROVIDER_USAGE_ENCRYPTION_KEY=${randomHexSecret()}`,
        `OPENLEASH_SECRET_KEY=${randomHexSecret()}`,
        `OPENLEASH_PLUGIN_RUNTIME_SECRET=${randomHexSecret()}`,
        "",
      ].join("\n"),
    );
  }
  upsertEnvValues(envPath, {
    OPENLEASH_DEV_TOKEN: localServer.token,
    OPENLEASH_ALLOW_PROD_DEV_TOKEN_SEED: "1",
    OPENLEASH_DEV_ORG_SLUG: "individual-open-source",
    OPENLEASH_DEV_ORG_NAME: "Individual Open Source",
    OPENLEASH_PLUGIN_RUNTIME_SECRET:
      readEnvValue(envPath, "OPENLEASH_PLUGIN_RUNTIME_SECRET") || randomHexSecret(),
  });
  fs.writeFileSync(
    path.join(runtimeDir, "docker-compose.yml"),
    individualOpenSourceCompose(),
  );
}

function readEnvValue(envPath: string, key: string) {
  if (!fs.existsSync(envPath)) return undefined;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return fs.readFileSync(envPath, "utf8").match(new RegExp(`^${escaped}=(.*)$`, "m"))?.[1];
}

function upsertEnvValues(envPath: string, values: Record<string, string>) {
  const existing = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : "";
  const lines = existing.split(/\r?\n/).filter((line) => line.length > 0);
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    if (!(key in values)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  fs.writeFileSync(envPath, `${next.join("\n")}\n`);
}

function randomHexSecret() {
  return crypto.randomBytes(24).toString("hex");
}

function individualOpenSourceCompose() {
  return `name: openleash-individual

services:
  postgres:
    image: postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
    container_name: openleash-individual-postgres
    environment:
      POSTGRES_DB: \${OPENLEASH_POSTGRES_DB:-openleash}
      POSTGRES_USER: \${OPENLEASH_POSTGRES_USER:-openleash}
      POSTGRES_PASSWORD: \${OPENLEASH_POSTGRES_PASSWORD:-openleash}
    volumes:
      - openleash-individual-postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${OPENLEASH_POSTGRES_USER:-openleash} -d \${OPENLEASH_POSTGRES_DB:-openleash}"]
      interval: 5s
      timeout: 5s
      retries: 20

  migrate:
    image: \${OPENLEASH_IMAGE_REGISTRY:-ghcr.io/open-leash}/client-api:\${OPENLEASH_VERSION:-0.37.0@sha256:caa0f268c62e5cf2cf29076877a8b6ca3caf00ddedc8c5229e10df8c929661db}
    profiles: ["setup"]
    environment:
      DATABASE_URL: postgres://\${OPENLEASH_POSTGRES_USER:-openleash}:\${OPENLEASH_POSTGRES_PASSWORD:-openleash}@postgres:5432/\${OPENLEASH_POSTGRES_DB:-openleash}
      OPENLEASH_DEV_TOKEN: \${OPENLEASH_DEV_TOKEN:-}
      OPENLEASH_ALLOW_PROD_DEV_TOKEN_SEED: \${OPENLEASH_ALLOW_PROD_DEV_TOKEN_SEED:-1}
      OPENLEASH_DEV_ORG_SLUG: individual-open-source
      OPENLEASH_DEV_ORG_NAME: Individual Open Source
      OPENLEASH_DEPLOYMENT_MODE: individual-open-source
    command: ["node", "apps/client-api/dist/migrate.js", "--apply"]
    depends_on:
      postgres:
        condition: service_healthy

  seed:
    image: \${OPENLEASH_IMAGE_REGISTRY:-ghcr.io/open-leash}/client-api:\${OPENLEASH_VERSION:-0.37.0@sha256:caa0f268c62e5cf2cf29076877a8b6ca3caf00ddedc8c5229e10df8c929661db}
    profiles: ["setup"]
    environment:
      DATABASE_URL: postgres://\${OPENLEASH_POSTGRES_USER:-openleash}:\${OPENLEASH_POSTGRES_PASSWORD:-openleash}@postgres:5432/\${OPENLEASH_POSTGRES_DB:-openleash}
    command: ["node", "apps/client-api/dist/bootstrap-personal.js", "--name", "Individual Open Source", "--slug", "individual-open-source", "--mode", "private"]
    depends_on:
      postgres:
        condition: service_healthy

  client-api:
    image: \${OPENLEASH_IMAGE_REGISTRY:-ghcr.io/open-leash}/client-api:\${OPENLEASH_VERSION:-0.37.0@sha256:caa0f268c62e5cf2cf29076877a8b6ca3caf00ddedc8c5229e10df8c929661db}
    container_name: openleash-individual-client-api
    environment:
      DATABASE_URL: postgres://\${OPENLEASH_POSTGRES_USER:-openleash}:\${OPENLEASH_POSTGRES_PASSWORD:-openleash}@postgres:5432/\${OPENLEASH_POSTGRES_DB:-openleash}
      OPENLEASH_API_PORT: 9318
      OPENLEASH_API_SURFACE: client
      OPENLEASH_DEPLOYMENT_MODE: individual-open-source
      OPENLEASH_DEV_ORG_SLUG: individual-open-source
      OPENLEASH_DEV_ORG_NAME: Individual Open Source
      OPENLEASH_DEV_TOKEN: \${OPENLEASH_DEV_TOKEN:-}
      OPENLEASH_ALLOW_PROD_DEV_TOKEN_SEED: \${OPENLEASH_ALLOW_PROD_DEV_TOKEN_SEED:-1}
      OPENLEASH_RELEASE_ADMIN_TOKEN: \${OPENLEASH_RELEASE_ADMIN_TOKEN:-local-release-admin-token}
      OPENLEASH_MODEL_KEY_ENCRYPTION_KEY: \${OPENLEASH_MODEL_KEY_ENCRYPTION_KEY:-openleash-local-model-key-change-me}
      OPENLEASH_PROVIDER_USAGE_ENCRYPTION_KEY: \${OPENLEASH_PROVIDER_USAGE_ENCRYPTION_KEY:-openleash-local-provider-key-change-me}
      OPENLEASH_SECRET_KEY: \${OPENLEASH_SECRET_KEY:-openleash-local-secret-change-me}
      OPENLEASH_PLUGIN_RUNTIME_SECRET: \${OPENLEASH_PLUGIN_RUNTIME_SECRET}
      OPENLEASH_PLUGIN_ENDPOINTS: '{"openleash.prompt-compression":"http://host.docker.internal:9349","openleash.blast-radius":"http://host.docker.internal:9349","openleash.sensitive-access":"http://host.docker.internal:9349","openleash.dlp":"http://host.docker.internal:9349","openleash.rules-enforcer":"http://host.docker.internal:9349","openleash.mcp-scanner":"http://host.docker.internal:9349","openleash.code-scanner":"http://host.docker.internal:9349","openleash.skill-scanner":"http://host.docker.internal:9349"}'
    ports:
      - "127.0.0.1:\${OPENLEASH_CLIENT_API_PORT:-9318}:9318"
    depends_on:
      postgres:
        condition: service_healthy
    extra_hosts:
      - "host.docker.internal:host-gateway"

volumes:
  openleash-individual-postgres:
`;
}

function findRepoFile(fileName: string) {
  const candidates = [
    process.cwd(),
    here,
    path.resolve(here, ".."),
    path.resolve(here, "..", ".."),
    path.resolve(here, "..", "..", ".."),
    path.resolve(here, "..", "..", "..", ".."),
  ].map((dir) => path.join(dir, fileName));
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function canReach(url: string) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForReachable(url: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canReach(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

function localRulesConfigPath() {
  return path.join(os.homedir(), ".openleash", "rules.json");
}

function parseRulesImport(content: string, filePath: string) {
  if (path.extname(filePath).toLowerCase() === ".json")
    return JSON.parse(content) as unknown;
  const rules = ruleCandidatesFromMarkdown(content).map((text) => ({
    id: `imported-${crypto.createHash("sha1").update(text).digest("hex").slice(0, 12)}`,
    name: importedRuleTitle(text),
    category: "Imported rules",
    description: text,
    enabled: true,
    match: [text],
  }));
  return { rules };
}

function parsePluginRulesJsonImport(content: string) {
  const parsed = JSON.parse(content) as unknown;
  const rawRules = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { rules?: unknown[] }).rules)
      ? (parsed as { rules: unknown[] }).rules
      : [];
  if (rawRules.length === 0) {
    throw new Error(
      "JSON must be an array of rules or an object with a rules array.",
    );
  }
  const rules = rawRules
    .map((rule) => {
      if (typeof rule === "string") return { text: rule.trim(), action: "ask" };
      if (rule && typeof rule === "object") {
        const record = rule as Record<string, unknown>;
        return {
          text: String(
            record.text ??
              record.rule ??
              record.description ??
              record.natural_language_rule ??
              "",
          ).trim(),
          action: record.action === "block" ? "block" : "ask",
        };
      }
      return { text: "", action: "ask" };
    })
    .filter((rule) => rule.text);
  if (rules.length === 0)
    throw new Error("No valid rules found in that JSON file.");
  return rules;
}

function importedRuleTitle(rule: string) {
  const cleaned = rule
    .replace(/[^\w\s.+/#-]/g, " ")
    .replace(
      /\b(do not|don't|never|always|must|should|the|a|an|to|from|that|which|any|before)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const title = (cleaned || "Imported rule").split(/\s+/).slice(0, 7).join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function ensureLocalRulesConfig() {
  const rulesPath = localRulesConfigPath();
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  if (!fs.existsSync(rulesPath)) {
    fs.writeFileSync(
      rulesPath,
      `${JSON.stringify({ rules: localServer.policies }, null, 2)}\n`,
    );
  }
}

async function installLeashCli() {
  const binDir = path.join(os.homedir(), ".openleash", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "leash");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -lt 1 ]]; then
  echo "Usage: leash <agent> [args...]" >&2
  exit 2
fi
agent="$1"
shift
case "$agent" in
  claude|claude-code) exec claude "$@" ;;
  codex|openai-codex) exec codex "$@" ;;
  gemini) exec gemini "$@" ;;
  opencode) exec opencode "$@" ;;
  openclaw) exec openclaw "$@" ;;
  nanoclaw) exec nanoclaw "$@" ;;
  *) exec "$agent" "$@" ;;
esac
`,
  );
  fs.chmodSync(scriptPath, 0o755);
}

async function handleDesktopAuthCallback(rawUrl: string) {
  try {
    const callback = new URL(rawUrl);
    if (
      callback.protocol !== "openleash:" ||
      callback.hostname !== "auth" ||
      callback.pathname !== "/callback"
    )
      return;
    if (
      callback.searchParams.has("dashboard_token") ||
      callback.searchParams.has("enrollment_token") ||
      callback.searchParams.has("token")
    ) {
      notifyDesktopAuthFailure(
        "Leash rejected an unsafe sign-in link. Start sign-in again from this app.",
      );
      return;
    }
    const code = callback.searchParams.get("code");
    const state = callback.searchParams.get("state") ?? "";
    const pending = pendingDesktopAuth;
    if (
      !code ||
      !pending ||
      Date.now() - pending.createdAt > 10 * 60 * 1000 ||
      !secureDesktopValueEquals(state, pending.state)
    ) {
      notifyDesktopAuthFailure(
        "This sign-in request expired, was already used, or was not started by this Leash app.",
      );
      return;
    }
    // Consume local state before any network exchange. A duplicate custom URL
    // event can never race the first callback into a second credential.
    pendingDesktopAuth = undefined;
    const providerError =
      callback.searchParams.get("error_description") ||
      callback.searchParams.get("error");
    if (providerError) {
      notifyDesktopAuthFailure(providerError);
      return;
    }
    if (pending.kind === "dashboard_handoff") {
      if (!pending.codeVerifier || !/^olh_[A-Za-z0-9_-]{43}$/.test(code)) {
        notifyDesktopAuthFailure("Leash did not receive a valid Desktop handoff.");
        return;
      }
      const callbackApiUrl = normalizeRemoteApiUrl(
        callback.searchParams.get("api_url") || pending.apiUrl,
      );
      if (callbackApiUrl !== normalizeRemoteApiUrl(pending.apiUrl)) {
        notifyDesktopAuthFailure("Leash rejected a handoff from an unexpected API.");
        return;
      }
      const handoffResponse = await fetch(
        new URL("/v1/mobile/auth/handoff/exchange", pending.apiUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...apiVersionHeaders("mobileAuthExchange"),
          },
          body: JSON.stringify({
            code,
            state,
            codeVerifier: pending.codeVerifier,
          }),
        },
      );
      const handoffBody = await handoffResponse.json().catch(() => ({}));
      if (!handoffResponse.ok || !handoffBody.desktopEnrollmentToken) {
        notifyDesktopAuthFailure(
          handoffBody.error ||
            handoffBody.message ||
            "Leash could not finish the Desktop handoff.",
        );
        return;
      }
      desktopAuthSession = {
        token: handoffBody.desktopEnrollmentToken,
        apiUrl: pending.apiUrl,
        organizationName: handoffBody.organization?.name,
        organizationSlug: handoffBody.organization?.slug,
        userName: handoffBody.user?.display_name || handoffBody.user?.name,
        userEmail: handoffBody.user?.email,
        account: handoffBody.account,
        evaluationProvider: handoffBody.evaluationProvider,
      };
      presentCloudTrialStatus(desktopAuthSession.billing);
      restoreMainWindow();
      window?.webContents.send("openleash:auth", {
        ok: true,
        ...rendererDesktopAuthSession(),
      });
      return;
    }
    const response = await fetch(
      new URL("/v1/mobile/auth/exchange", pending.apiUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...apiVersionHeaders("mobileAuthExchange"),
        },
        body: JSON.stringify({
          redirectUri:
            pending.exchangeRedirectUri || desktopRedirectUri,
          authorizationCode: code,
          state,
          codeVerifier: pending.codeVerifier,
          providerType: pending.providerType,
          organizationId: pending.organizationId,
          organizationSlug: pending.organizationSlug,
          audience: pending.audience ?? "individual",
          desktopEnrollment: true,
        }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      window?.webContents.send("openleash:auth", {
        ok: false,
        error:
          body.message || body.error || "Leash could not finish sign-in.",
      });
      return;
    }
    const token =
      body.token ||
      body.sessionToken ||
      body.session?.token ||
      body.tokens?.accessToken;
    if (!token) {
      window?.webContents.send("openleash:auth", {
        ok: false,
        error: "The API did not return a client session token.",
      });
      return;
    }
    const issuedEnrollmentToken =
      typeof body.desktopEnrollmentToken === "string" &&
      body.desktopEnrollmentToken.trim()
        ? body.desktopEnrollmentToken.trim()
        : undefined;
    desktopAuthSession = {
      token: issuedEnrollmentToken || token,
      enrollmentFallbackToken: issuedEnrollmentToken ? token : undefined,
      apiUrl: pending.apiUrl,
      expiresAt: body.tokens?.expiresAt,
      organizationName:
        body.organization?.name || body.session?.organization?.name,
      organizationSlug:
        body.organization?.slug ||
        body.session?.organization?.slug ||
        pending.organizationSlug,
      userName:
        body.user?.display_name ||
        body.user?.name ||
        body.session?.user?.display_name ||
        body.session?.user?.name,
      userEmail: body.user?.email || body.session?.user?.email,
      account: body.account || body.session?.account,
      evaluationProvider: body.evaluationProvider || body.session?.evaluationProvider,
      billing: await fetchCloudBilling(pending.apiUrl, token),
    };
    presentCloudTrialStatus(desktopAuthSession.billing);
    restoreMainWindow();
    window?.webContents.send("openleash:auth", {
      ok: true,
      ...rendererDesktopAuthSession(),
    });
  } catch (error) {
    window?.webContents.send("openleash:auth", {
      ok: false,
      error: "Leash could not process the sign-in callback.",
    });
  }
}

function secureDesktopValueEquals(provided: string, expected: string) {
  if (!provided || !expected) return false;
  const left = crypto.createHash("sha256").update(provided).digest();
  const right = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

function notifyDesktopAuthFailure(error: string) {
  restoreMainWindow();
  window?.webContents.send("openleash:auth", { ok: false, error });
}

async function fetchCloudBilling(apiUrl: string, token: string) {
  try {
    const response = await fetch(new URL("/auth/account/billing", apiUrl), {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.ok ? await response.json() as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function presentCloudTrialStatus(billing: Record<string, unknown> | undefined) {
  const trial = billing?.trial && typeof billing.trial === "object"
    ? billing.trial as Record<string, unknown>
    : undefined;
  if (!billing?.upgradeRequired || !trial?.expired) return;
  const now = new Date();
  latestIslandContributions = [
    ...latestIslandContributions.filter((item) => item.key !== "cloud-trial-ended"),
    {
      schemaVersion: "2026-07-20.plugin-island.v1",
      id: "leash-cloud-trial-ended",
      pluginId: "openleash.cloud",
      kind: "status",
      key: "cloud-trial-ended",
      title: "Your Leash Cloud trial ended",
      detail: "Upgrade to keep Leash AI protection active.",
      tone: "danger",
      status: "waiting",
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    },
  ];
  const notificationKey = String(trial.endsAt ?? "cloud-trial-ended");
  if (presentedTrialEndKey !== notificationKey && Notification.isSupported()) {
    presentedTrialEndKey = notificationKey;
    new Notification({
      title: "Your Leash Cloud trial ended",
      body: "Upgrade to keep Leash AI protection active.",
    }).show();
  }
  if (localServer?.islandVisibility !== "off") syncActivityIsland(true);
}

function compactSummary(value: string) {
  const words = value
    .replace(/^(Allowed|Blocked|Needs approval)\s*·\s*/i, "")
    .replace(/\s+in\s+\/.*$/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 7);
  return words.length === 0 ? "Recently active..." : `${words.join(" ")}...`;
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function formatAgentMenuSublabel(agent: AgentStatus) {
  return `${agent.decision ?? "active"} · ${timeAgo(agent.activity_at ?? agent.last_seen_at)}`;
}

function agentProtectionSublabel(agent: LocalAgentProtection) {
  if (!agent.installed) return agent.detail || "Not installed";
  if (!agent.supportsInstall)
    return agent.detail || "Protection not supported yet";
  if (!agent.protected) return agent.detail || "Ready to protect";
  return agent.approvalHandoff
    ? "Protected · Leash approvals primary"
    : "Protected";
}

function agentProtectionMenuItem(
  agent: LocalAgentProtection,
): MenuItemConstructorOptions {
  const canToggle = agent.installed && agent.supportsInstall;
  const unavailableLabel = !agent.installed
    ? "Not installed"
    : agent.detail || "Protection not supported yet";

  return {
    label: agent.displayName,
    sublabel: agentProtectionSublabel(agent),
    enabled: agent.installed,
    submenu: canToggle
      ? [
          {
            label: "Protected",
            type: "radio",
            checked: agent.protected,
            click: async () => {
              if (agent.protected) return;
              await protectAgentKind(agent.kind);
              refreshMenu(true);
            },
          },
          {
            label: "Unprotected",
            type: "radio",
            checked: !agent.protected,
            click: async () => {
              if (!agent.protected) return;
              await unprotectAgentKind(agent.kind);
              refreshMenu(true);
            },
          },
        ]
      : [{ label: unavailableLabel, enabled: false }],
  };
}

function timeAgo(value?: string) {
  if (!value) return "now";
  const date = new Date(value);
  const seconds = Math.max(1, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function createTrayIcon(status: "ok" | "pending" | "down") {
  const image = nativeImage
    .createFromPath(path.join(here, "tray-icon.png"))
    .resize({ width: 22, height: 22 });
  if (image.isEmpty()) {
    const color =
      status === "ok"
        ? "#11795f"
        : status === "pending"
          ? "#a76800"
          : "#bc2d3f";
    return nativeImage.createFromDataURL(createBadgeSvg(color));
  }
  image.setTemplateImage(false);
  return image;
}

function createBadgeSvg(color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect width="64" height="64" fill="none"/>
    <g transform="translate(7 7) scale(1.45)">
      <path d="M8 8c0 4.4 3.6 8 8 8s8-3.6 8-8" stroke="#F7F8FA" stroke-width="2.8" stroke-linecap="round" fill="none"/>
      <path d="M8 17c0 4.4 3.6 8 8 8s8-3.6 8-8" stroke="#F7F8FA" stroke-width="2.8" stroke-linecap="round" opacity=".72" fill="none"/>
      <circle cx="26" cy="8" r="3.4" fill="#F7F8FA"/>
    </g>
    <circle cx="47" cy="17" r="7" fill="${color}" stroke="white" stroke-width="3"/>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
