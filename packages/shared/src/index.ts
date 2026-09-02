import { LEASH_FEATURE_PRESENTATIONS } from "./feature-presentations.js";
export {
  LEASH_FEATURE_PRESENTATIONS,
  LEASH_FEATURE_SHOWCASE,
  leashFeaturePresentation,
} from "./feature-presentations.js";
export type {
  LeashFeaturePresentation,
  LeashFeatureSlug,
} from "./feature-presentations.js";

export type AgentKind =
  | "claude-code"
  | "codex"
  | "openclaw"
  | "nanoclaw"
  | "salesforce-agentforce"
  | "azure-ai-foundry"
  | "microsoft-copilot-studio"
  | "aws-bedrock-agentcore"
  | "google-vertex-ai"
  | "n8n"
  | "zapier-agents"
  | "openai-codex-cloud"
  | "cursor"
  | "gemini"
  | "opencode"
  | "cline"
  | "continue"
  | "windsurf"
  | "github-copilot"
  | "kiro"
  | "aider"
  | "zed"
  | "unknown";

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "SubagentStart"
  | "SubagentStop"
  | "Notification"
  | "SessionEnd"
  | "Stop";

export type PipelineEvent =
  | "openleash.startup"
  | "agent.detected"
  | "skill.detected"
  | "skill.changed"
  | "skill.removed"
  | "log.emitted"
  | "prompt.beforeSubmit"
  | "provider.request.beforeSend"
  | "plugin.tool.execute"
  | "agent.response"
  | "tool.beforeUse"
  | "tool.afterUse"
  | "session.started"
  | "session.ended";

export type PluginPermission =
  | "event:read"
  | "prompt:read"
  | "prompt:write"
  | "provider-request:read"
  | "provider-request:write"
  | "local-model:run"
  | "tool:read"
  | "decision:write"
  | "model:invoke"
  | "network:access"
  | "instructions:read"
  | "conversation:read"
  | "filesystem:read"
  | "filesystem:write"
  | "storage:read"
  | "storage:write"
  | "audit:write"
  | "log:write"
  | "signal:write"
  | "usage:write"
  | "notification:send"
  | "island:publish";

export type PluginEffect =
  | "observe"
  | "transform"
  | "ask"
  | "deny"
  | "notify"
  | "inventory";

/** Built-in Features run in the trusted client-api process. `container` is
 * retained only so older serialized manifests can be rejected cleanly. */
export type PluginRuntime = "builtin" | "container";

export type PluginContainerPlacement = "edge" | "server" | "either";

export type PluginContainerExecution = {
  type: "container";
  placement: PluginContainerPlacement;
  protocol: "openleash-container-plugin.v1";
  image: string;
  /** Production releases pin the immutable image digest separately from the human-readable tag. */
  digest?: string;
  healthPath?: string;
  /** Generic normalized pipeline-event endpoint. */
  eventPath?: string;
  transformPath?: string;
  toolExecutePath?: string;
  /** Loopback-only port used by the desktop edge runtime; never exposed publicly. */
  edgePort?: number;
  timeoutMs?: number;
  failureMode?: "open" | "closed";
  resources?: {
    memoryMb?: number;
    cpuShares?: number;
  };
  /**
   * shared-trusted is reserved for reviewed images that keep no tenant state in-process.
   * user-dedicated binds one workload and its storage identity to one authenticated user.
   */
  isolation?:
    | "shared-trusted"
    | "user-dedicated"
    | "tenant-dedicated"
    | "customer-hosted";
  storage?: {
    persistent: boolean;
    volumeName?: string;
  };
};

export type PluginInProcessExecution = {
  type: "in-process";
  /** Stable key resolved from the closed first-party handler registry. */
  handler: string;
  failureMode?: "open" | "closed";
};

export type PluginExecution =
  | PluginInProcessExecution
  | PluginContainerExecution;

export type PluginOrdering = {
  before?: string[];
  after?: string[];
  priority?: number;
};

export type PluginSettingSchema = {
  type: "object";
  additionalProperties?: boolean;
  properties?: Record<string, unknown>;
  required?: string[];
};

export type OpenLeashPluginManifest = {
  id: string;
  slug?: string;
  name: string;
  description: string;
  repositoryUrl?: string;
  version: string;
  publisher: "openleash" | string;
  runtime: PluginRuntime;
  execution?: PluginExecution;
  /** `cloud-only` Features are never executed by Personal Open Source. */
  executionEnvironment?: "any" | "cloud-only";
  entrypoint: string;
  events: PipelineEvent[];
  permissions: PluginPermission[];
  effects: PluginEffect[];
  ordering?: PluginOrdering;
  configSchema?: PluginSettingSchema;
  defaultConfig?: Record<string, unknown>;
  tags?: string[];
};

export type PluginMarketplaceReviewStatus = "approved" | "pending_review" | "rejected";
export type PluginMarketplaceSource = "first_party" | "community" | "private";

export type PluginMarketplaceListing = OpenLeashPluginManifest & {
  slug: string;
  developerName: string;
  developerUrl?: string;
  source: PluginMarketplaceSource;
  reviewStatus: PluginMarketplaceReviewStatus;
  shortDescription: string;
  longDescription: string;
  heroTagline: string;
  packageUrl?: string;
  repositoryUrl?: string;
  documentationUrl?: string;
  iconText: string;
  visualPng?: string;
  installCount?: number;
  downloadCount?: number;
  weeklyDownloadCount?: number;
  trendPercent?: number;
  rating?: number;
  ratingCount?: number;
  featuredRank?: number | null;
  seoTitle: string;
  seoDescription: string;
  createdAt?: string;
  updatedAt?: string;
};

export type OrganizationPluginPolicy = {
  allowUserMarketplaceInstalls: boolean;
  allowUserCommunityPlugins: boolean;
  mandatoryPluginIds: string[];
  defaultPluginIds: string[];
};

export type PluginCatalogItem = OpenLeashPluginManifest & {
  slug?: string;
  marketplace?: PluginMarketplaceListing;
  settings: PluginSettingState;
  organizationPolicy?: {
    mandatory: boolean;
    defaultEnabled: boolean;
    userInstallAllowed: boolean;
    configLocked?: boolean;
  };
};

export type PluginSettingProfile = {
  /** Stable client-generated identifier used in audit records and container caches. */
  id: string;
  name: string;
  /** Empty means every agent. Matching profiles are merged in ascending priority order. */
  agentKinds: AgentKind[];
  /** Stable enrolled-agent identifiers. Empty means any instance of a matching kind. */
  agentIds?: string[];
  /** Normalized project roots. Empty means every project; descendants match their root. */
  projectPaths?: string[];
  /** Organization user identifiers targeted by a centrally managed profile. */
  userIds?: string[];
  /** Identity-provider group identifiers targeted by a centrally managed profile. */
  groupIds?: string[];
  enabled?: boolean;
  config: Record<string, unknown>;
  priority?: number;
};

export type PluginSettingState = {
  enabled: boolean;
  config: Record<string, unknown>;
  /** Profiles editable at the current API scope (organization for admin, user for client). */
  profiles?: PluginSettingProfile[];
  /** Read-only organization profiles inherited by a user. */
  inheritedProfiles?: PluginSettingProfile[];
  /** Profiles selected for the current agent event, when a runtime context is present. */
  effectiveProfileIds?: string[];
  /** False when the selected installed version has no approved executable release. */
  runtimeAvailable?: boolean;
  runtimeError?: string;
  orderingPriority?: number | null;
  installedVersion?: string;
  availableVersion?: string;
  updateAvailable?: boolean;
  updatePolicy?: "manual" | "patch" | "minor" | "locked";
  updatedAt?: string;
};

export function firstPartyFeature(
  slug: string,
  _version: string,
  options: Partial<PluginInProcessExecution> = {},
): PluginInProcessExecution {
  return {
    type: "in-process",
    handler: slug,
    failureMode: "closed",
    ...options,
  };
}

export const FIRST_PARTY_PLUGIN_MANIFESTS = [
  {
    id: "openleash.prompt-compression",
    slug: "token-saver",
    name: LEASH_FEATURE_PRESENTATIONS["token-saver"].name,
    description: LEASH_FEATURE_PRESENTATIONS["token-saver"].description,
    repositoryUrl: "https://github.com/open-leash/plugin-token-saver",
    version: "1.1.3",
    publisher: "openleash",
    runtime: "builtin",
    execution: {
      type: "in-process",
      handler: "token-saver",
      failureMode: "open",
    },
    entrypoint: "client-api",
    events: ["prompt.beforeSubmit", "provider.request.beforeSend", "plugin.tool.execute"],
    permissions: ["event:read", "prompt:read", "prompt:write", "provider-request:read", "provider-request:write", "local-model:run", "model:invoke", "audit:write", "log:write", "usage:write", "island:publish"],
    effects: ["transform", "observe"],
    ordering: { priority: 100, before: ["openleash.dlp"] },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        level: { enum: ["light", "standard", "maximum"] },
        conciseResponse: { type: "boolean" },
        model: { type: "string" },
        minimumChars: { type: "number", minimum: 256 },
        protectRecent: { type: "number", minimum: 0 },
        ccrEnabled: { type: "boolean" },
        ccrTtlSeconds: { type: "number", minimum: 60 }
      }
    },
    defaultConfig: {
      enabled: true,
      level: "standard",
      conciseResponse: false,
      minimumChars: 1200,
      protectRecent: 2,
      ccrEnabled: false,
      ccrTtlSeconds: 3600
    },
    tags: ["tokens", "cost", "prompt"]
  },
  {
    id: "openleash.skill-scanner",
    slug: "skill-scanner",
    name: LEASH_FEATURE_PRESENTATIONS["skill-scanner"].name,
    description: LEASH_FEATURE_PRESENTATIONS["skill-scanner"].description,
    repositoryUrl: "https://github.com/open-leash/plugin-skill-scanner",
    version: "1.0.2",
    publisher: "openleash",
    runtime: "builtin",
    execution: firstPartyFeature("skill-scanner", "1.0.2"),
    entrypoint: "client-api",
    events: ["openleash.startup", "agent.detected", "skill.detected", "skill.changed"],
    permissions: ["event:read", "filesystem:read", "decision:write", "model:invoke", "audit:write", "log:write", "signal:write", "notification:send"],
    effects: ["observe", "ask", "inventory"],
    ordering: { priority: 150 },
    defaultConfig: {
      enabled: true,
      suspiciousRiskThreshold: 50
    },
    tags: ["skills", "security", "inventory"]
  },
  {
    id: "openleash.dlp",
    slug: "data-leakage-prevention",
    name: LEASH_FEATURE_PRESENTATIONS["data-leakage-prevention"].name,
    description: LEASH_FEATURE_PRESENTATIONS["data-leakage-prevention"].description,
    repositoryUrl: "https://github.com/open-leash/plugin-data-leakage-prevention",
    version: "1.0.0",
    publisher: "openleash",
    runtime: "builtin",
    execution: firstPartyFeature("data-leakage-prevention", "1.0.0"),
    entrypoint: "client-api",
    events: ["prompt.beforeSubmit"],
    permissions: ["event:read", "prompt:read", "prompt:write", "decision:write", "model:invoke", "audit:write", "signal:write"],
    effects: ["transform", "deny", "observe"],
    ordering: { priority: 200, after: ["openleash.prompt-compression"] },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        action: { enum: ["allow", "ask", "block"] },
        categories: {
          type: "array",
          items: { enum: ["pii", "phi", "tokens", "keys", "credentials"] }
        },
        model: { type: "string" }
      }
    },
    defaultConfig: {
      enabled: true,
      action: "ask",
      categories: ["pii", "phi", "tokens", "keys", "credentials"]
    },
    tags: ["security", "privacy", "prompt"]
  },
  {
    id: "openleash.sensitive-access",
    slug: "sensitive-access",
    name: LEASH_FEATURE_PRESENTATIONS["sensitive-access"].name,
    description: LEASH_FEATURE_PRESENTATIONS["sensitive-access"].description,
    repositoryUrl: "https://github.com/open-leash/plugin-sensitive-access",
    version: "1.0.0",
    publisher: "openleash",
    runtime: "builtin",
    execution: firstPartyFeature("sensitive-access", "1.0.0"),
    entrypoint: "client-api",
    events: ["prompt.beforeSubmit", "agent.response", "tool.beforeUse", "tool.afterUse"],
    permissions: ["event:read", "prompt:read", "tool:read", "model:invoke", "decision:write", "audit:write", "log:write", "signal:write"],
    effects: ["observe", "ask", "deny"],
    ordering: { priority: 180, before: ["openleash.dlp", "openleash.blast-radius", "openleash.rules-enforcer"] },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        secretFileAction: { enum: ["allow", "ask", "block"] },
        envDumpAction: { enum: ["allow", "ask", "block"] },
        exfiltrationAction: { enum: ["allow", "ask", "block"] }
      }
    },
    defaultConfig: {
      enabled: true,
      secretFileAction: "ask",
      envDumpAction: "ask",
      exfiltrationAction: "block"
    },
    tags: ["security", "secrets", "credentials", "privacy"]
  },
  {
    id: "openleash.blast-radius",
    slug: "blast-radius",
    name: LEASH_FEATURE_PRESENTATIONS["blast-radius"].name,
    description: LEASH_FEATURE_PRESENTATIONS["blast-radius"].description,
    repositoryUrl: "https://github.com/open-leash/plugin-blast-radius",
    version: "1.0.3",
    publisher: "openleash",
    runtime: "builtin",
    execution: firstPartyFeature("blast-radius", "1.0.3"),
    entrypoint: "client-api",
    events: ["prompt.beforeSubmit", "tool.beforeUse"],
    permissions: ["event:read", "prompt:read", "tool:read", "decision:write", "audit:write", "log:write", "signal:write", "island:publish"],
    effects: ["observe", "ask", "deny"],
    ordering: { priority: 220, before: ["openleash.rules-enforcer", "openleash.mcp-scanner"] },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        destructiveAction: { enum: ["allow", "ask", "block"] },
        databaseMutationAction: { enum: ["allow", "ask", "block"] },
        broadFilesystemAction: { enum: ["allow", "ask", "block"] }
      }
    },
    defaultConfig: {
      enabled: true,
      destructiveAction: "ask",
      databaseMutationAction: "ask",
      broadFilesystemAction: "ask"
    },
    tags: ["security", "destructive", "database", "tools"]
  },
  {
    id: "openleash.rules-enforcer",
    slug: "rules-enforcer",
    name: LEASH_FEATURE_PRESENTATIONS["rules-enforcer"].name,
    description: LEASH_FEATURE_PRESENTATIONS["rules-enforcer"].description,
    repositoryUrl: "https://github.com/open-leash/plugin-rules-enforcer",
    version: "1.0.0",
    publisher: "openleash",
    runtime: "builtin",
    execution: firstPartyFeature("rules-enforcer", "1.0.0"),
    entrypoint: "client-api",
    events: ["prompt.beforeSubmit", "agent.response", "tool.beforeUse", "tool.afterUse"],
    permissions: ["event:read", "prompt:read", "tool:read", "decision:write", "model:invoke", "audit:write", "log:write", "signal:write", "usage:write", "notification:send"],
    effects: ["observe", "ask", "deny"],
    ordering: { priority: 300, after: ["openleash.dlp"] },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        rules: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
            action: { type: "string", enum: ["allow", "ask", "block"] }
            }
          }
        }
      }
    },
    defaultConfig: {
      enabled: true,
      rules: []
    },
    tags: ["security", "rules", "policy", "approval"]
  },
  {
    id: "openleash.mcp-scanner",
    slug: "mcp-scanner",
    name: LEASH_FEATURE_PRESENTATIONS["mcp-scanner"].name,
    description: LEASH_FEATURE_PRESENTATIONS["mcp-scanner"].description,
    repositoryUrl: "https://github.com/open-leash/plugin-mcp-scanner",
    version: "1.0.0",
    publisher: "openleash",
    runtime: "builtin",
    execution: firstPartyFeature("mcp-scanner", "1.0.0"),
    entrypoint: "client-api",
    events: ["tool.beforeUse", "tool.afterUse"],
    permissions: ["event:read", "tool:read", "audit:write", "signal:write"],
    effects: ["observe", "inventory"],
    ordering: { priority: 400, after: ["openleash.rules-enforcer"] },
    defaultConfig: {
      enabled: true,
      redactSecrets: true
    },
    tags: ["security", "mcp", "inventory", "audit"]
  }
] satisfies OpenLeashPluginManifest[];

export type PluginRunStatus = "skipped" | "passed" | "modified" | "blocked" | "needs_question" | "failed";

export type PluginFinding = {
  title: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  summary: string;
  evidence?: string[];
};

export type PluginRunRecord = {
  pluginId: string;
  event: PipelineEvent;
  status: PluginRunStatus;
  summary: string;
  durationMs?: number;
  findings?: PluginFinding[];
  metadata?: Record<string, unknown>;
};

export type PluginPromptCompressionLevel = "light" | "standard" | "maximum";
export type PluginDlpCategory = "pii" | "phi" | "tokens" | "keys" | "credentials";
// `mask` remains accepted for settings saved by older clients. New product UI
// offers the clearer Ignore, Ask me, and Stop it choices.
export type PluginDlpAction = "allow" | "ask" | "block" | "mask";

export type PluginPromptCompressionRequest = {
  prompt: string;
  level: PluginPromptCompressionLevel;
  conciseResponse?: boolean;
  model?: string;
};

export type PluginPromptCompressionConfig = {
  enabled: boolean;
  level: PluginPromptCompressionLevel;
  conciseResponse: boolean;
  model: string;
  minimumChars?: number;
};

export type PluginPromptCompressionResult = {
  prompt: string;
  model: string;
  originalLength: number;
  compressedLength: number;
  ratio: number;
};

export type PluginDlpInspectionRequest = {
  prompt: string;
  action: PluginDlpAction;
  categories: PluginDlpCategory[];
  model?: string;
};

export type PluginDlpConfig = {
  enabled: boolean;
  action: PluginDlpAction;
  categories: PluginDlpCategory[];
  model: string;
};

export type PluginPromptPipelineConfig = {
  compression: PluginPromptCompressionConfig;
  dlp: PluginDlpConfig;
};

export type PluginDlpInspectionResult = {
  prompt: string;
  blocked: boolean;
  matched: boolean;
  masked: boolean;
  model: string;
  categories: PluginDlpCategory[];
  findings: Array<{ category: PluginDlpCategory; quote: string; reason: string }>;
};

export type PluginPolicyEvaluationRequest = {
  request: EvaluationRequest;
  policies: Policy[];
};

export type PluginPolicyEvaluationResult = {
  results: PolicyDecision[];
  model: string;
};

export type PluginStorageScope = {
  userId?: string;
  agentKind?: string;
  sessionId?: string;
  conversationId?: string;
  projectPath?: string;
  key?: string;
};

export type PluginStorageRead<T = unknown> = {
  key?: string;
  scope?: PluginStorageScope;
  value: T;
  updatedAt: string;
  expiresAt?: string | null;
};

export type PluginStorageGetRequest = {
  key: string;
  scope?: PluginStorageScope;
};

export type PluginStorageSetRequest = {
  key: string;
  value: unknown;
  scope?: PluginStorageScope;
  ttlSeconds?: number;
};

export type PluginStorageListRequest = {
  keyPrefix?: string;
  scope?: PluginStorageScope;
  limit?: number;
};

export type PluginNotificationRequest = {
  level: "info" | "warning" | "critical";
  title: string;
  summary: string;
  dedupeKey?: string;
  scope?: PluginStorageScope;
  minIntervalSeconds?: number;
};

export type PluginNotificationResult = {
  sent: boolean;
  deduped: boolean;
};

export type PluginIslandTone = "neutral" | "info" | "success" | "warning" | "danger";
export type PluginIslandActivityStatus = "queued" | "running" | "waiting" | "completed" | "failed";
export type PluginIslandProgress = { current: number; total?: number; label?: string };

export type PluginIslandAction =
  | { id: string; label: string; type: "open-session" }
  | { id: string; label: string; type: "open-plugin-settings" }
  | { id: string; label: string; type: "open-plugin-outcome"; outcomeId: string };

export type PluginIslandBaseRequest = {
  /** Stable within the plugin. Re-publishing the same key updates the existing contribution. */
  key: string;
  /** Defaults to the current event session. */
  sessionId?: string;
  /** Expiring contributions prevent stale plugin UI. Defaults to 120 seconds. */
  ttlSeconds?: number;
  action?: PluginIslandAction;
};

export type PluginIslandAnnotationRequest = PluginIslandBaseRequest & {
  label: string;
  detail?: string;
  value?: string;
  tone?: PluginIslandTone;
};

export type PluginIslandActivityRequest = PluginIslandBaseRequest & {
  title: string;
  detail?: string;
  status: PluginIslandActivityStatus;
  progress?: PluginIslandProgress;
  tone?: PluginIslandTone;
};

export type PluginIslandStatusRequest = Omit<PluginIslandBaseRequest, "sessionId"> & {
  title: string;
  detail?: string;
  tone?: PluginIslandTone;
  progress?: PluginIslandProgress;
  relatedSessionIds?: string[];
};

export type PluginIslandClearRequest = { key: string; sessionId?: string };
export type PluginIslandPublishRequest =
  | ({ kind: "annotation" } & PluginIslandAnnotationRequest)
  | ({ kind: "activity" } & PluginIslandActivityRequest)
  | ({ kind: "status" } & PluginIslandStatusRequest);

export type PluginIslandContribution = {
  schemaVersion: "2026-07-20.plugin-island.v1";
  id: string;
  pluginId: string;
  kind: PluginIslandPublishRequest["kind"];
  key: string;
  sessionId?: string;
  agentKind?: string;
  /** Host-derived stable enrolled agent runtime identifier when available. */
  agentId?: string;
  projectPath?: string;
  label?: string;
  title?: string;
  detail?: string;
  value?: string;
  tone: PluginIslandTone;
  status?: PluginIslandActivityStatus;
  progress?: PluginIslandProgress;
  action?: PluginIslandAction;
  relatedSessionIds?: string[];
  updatedAt: string;
  expiresAt: string;
};

export type PluginIslandPublishResult = {
  contribution: PluginIslandContribution;
};

export type PluginLogLevel = "debug" | "info" | "warn" | "error" | "security";

export type PluginLogRequest = {
  level: PluginLogLevel;
  message: string;
  code?: string;
  category?: "system" | "plugin" | "security" | "audit";
  data?: Record<string, unknown>;
  scope?: PluginStorageScope;
};

export type PluginLogRecord = {
  id?: string;
  pluginId: string;
  level: PluginLogLevel;
  message: string;
  code?: string;
  category: "system" | "plugin" | "security" | "audit";
  data: Record<string, unknown>;
  scope?: PluginStorageScope;
  createdAt: string;
};

export type PluginSignalKind =
  | "security.finding"
  | "policy.decision"
  | "approval.event"
  | "secret.detected"
  | "tool.risk"
  | "mcp.discovery"
  | "identity.risk"
  | "audit.event"
  | "plugin.health"
  | "export.status";

export type PluginSignalSeverity = "info" | "low" | "medium" | "high" | "critical";

export type PluginSignalRequest = {
  kind: PluginSignalKind;
  severity?: PluginSignalSeverity;
  title: string;
  summary?: string;
  decision?: "allow" | "ask" | "deny" | "blocked" | "approved" | "rejected" | "observed";
  status?: string;
  target?: {
    type?: string;
    name?: string;
    id?: string;
  };
  evidence?: unknown;
  details?: Record<string, unknown>;
  correlationKeys?: string[];
  occurredAt?: string;
};

export type PluginSignalRecord = PluginSignalRequest & {
  id?: string;
  pluginId: string;
  organizationId?: string;
  conversationEventId?: string;
  userId?: string;
  computerId?: string;
  agentRuntimeId?: string;
  agentKind?: string;
  sessionId?: string;
  projectPath?: string;
  createdAt: string;
};

export type OpenLeashOutcomeDomain =
  | "security"
  | "data_protection"
  | "tool_risk"
  | "identity"
  | "cost"
  | "productivity"
  | "compliance"
  | "operations";

export type OpenLeashOutcomeStatus =
  | "observed"
  | "passed"
  | "modified"
  | "masked"
  | "blocked"
  | "needs_review"
  | "failed";

export type OpenLeashOutcomeDecision =
  | "allow"
  | "ask"
  | "deny"
  | "blocked"
  | "approved"
  | "rejected"
  | "observed";

export type OpenLeashOutcomeEvidence = {
  label: string;
  value?: string;
  kind?: "text" | "code" | "path" | "url" | "json";
  sensitive?: boolean;
};

export type OpenLeashOutcomeRecord = {
  id: string;
  domain: OpenLeashOutcomeDomain;
  title: string;
  summary?: string | null;
  severity: PluginSignalSeverity;
  status: OpenLeashOutcomeStatus;
  decision?: OpenLeashOutcomeDecision | null;
  occurredAt: string;
  createdAt: string;
  source: {
    pluginId: string;
    label: string;
    kind: PluginSignalKind | PluginUsageKind | "plugin.run" | "plugin.log";
  };
  subject?: {
    type?: string;
    name?: string;
    id?: string;
  };
  actor?: {
    userId?: string | null;
    name?: string | null;
    email?: string | null;
  };
  agent?: {
    kind?: string | null;
    name?: string | null;
    hostname?: string | null;
  };
  context?: {
    organizationId?: string;
    organizationSlug?: string;
    conversationEventId?: string | null;
    evaluationId?: string | null;
    eventName?: string | null;
    toolName?: string | null;
    projectPath?: string | null;
    correlationKeys?: string[];
  };
  evidence?: OpenLeashOutcomeEvidence[];
  details?: Record<string, unknown>;
};

export type OpenLeashPluginCategoryId = "cost" | "security" | "observability" | "utility";

export type OpenLeashPluginCategoryMeta = {
  id: OpenLeashPluginCategoryId;
  label: string;
  color: string;
  icon: "trend" | "shield" | "eye" | "bolt";
};

export const OPENLEASH_PLUGIN_CATEGORIES: OpenLeashPluginCategoryMeta[] = [
  { id: "security", label: "Protections", color: "#0b7968", icon: "shield" },
  { id: "cost", label: "Cost", color: "#5b47e0", icon: "trend" },
  { id: "observability", label: "Visibility", color: "#2a63d8", icon: "eye" },
  { id: "utility", label: "Other", color: "#a15b12", icon: "bolt" }
];

export type OpenLeashClientPluginView = {
  id: string;
  packageId: string;
  displayName: string;
  description?: string;
  category: OpenLeashPluginCategoryId;
  installed: boolean;
  iconText?: string;
  configSchema?: PluginSettingSchema;
  defaultConfig?: Record<string, unknown>;
  settings?: PluginSettingState;
  outcomeCount: number;
  latestOutcome?: OpenLeashOutcomeRecord;
};

export type OpenLeashClientPluginCategory = OpenLeashPluginCategoryMeta & {
  count: number;
  plugins: OpenLeashClientPluginView[];
};

export type OpenLeashClientViewModel = {
  version: "2026-06-26.client-view-model.v1";
  generatedAt: string;
  shellSections: Array<"overview" | "agents" | "activity" | "approvals" | "policies" | "settings" | "identity">;
  pluginCategories: OpenLeashClientPluginCategory[];
  outcomes: OpenLeashOutcomeRecord[];
  summary?: {
    total?: number;
    totalOutcomes: number;
    highSeverity: number;
    blocked: number;
    needsReview: number;
    byDomain: Record<string, number>;
  };
};

export function pluginPackageId(plugin: Pick<PluginCatalogItem, "id" | "slug" | "name" | "marketplace">) {
  return plugin.slug || plugin.marketplace?.slug || String(plugin.id || "").split(".").pop() || plugin.name || plugin.id;
}

export function pluginCategoryId(plugin: Pick<PluginCatalogItem, "id" | "slug" | "name" | "description" | "tags" | "marketplace"> & { category?: unknown; manifest?: { category?: unknown } }): OpenLeashPluginCategoryId {
  const featureId = pluginPackageId(plugin);
  if (["blast-radius", "code-scanner", "data-leakage-prevention", "mcp-scanner", "rules-enforcer", "sensitive-access", "skill-scanner"].includes(featureId)) return "security";
  if (["prompt-compression", "token-saver"].includes(featureId)) return "cost";
  const raw = (plugin.marketplace as { category?: unknown } | undefined)?.category || plugin.category || plugin.manifest?.category || "";
  const text = String(raw || `${plugin.id || ""} ${plugin.name || ""} ${plugin.description || ""} ${(plugin.marketplace?.tags || []).join(" ")} ${(plugin.tags || []).join(" ")}`).toLowerCase();
  if (/mcp-scanner|skill-scanner/.test(text)) return "security";
  if (/security|policy|guard|skill|prompt-injection|risk|approval|dlp|leak|sensitive|secret|credential/.test(text)) return "security";
  if (/visibility|observability|observe|log|mcp|siem|audit|telemetry|monitor/.test(text)) return "observability";
  if (/cost|token|compression|usage|budget|spend/.test(text)) return "cost";
  return "utility";
}

export function buildOpenLeashClientViewModel({
  plugins,
  outcomes,
  summary,
  shellSections = ["overview", "agents", "activity", "approvals", "policies", "settings"]
}: {
  plugins: PluginCatalogItem[];
  outcomes: OpenLeashOutcomeRecord[];
  summary?: Partial<OpenLeashClientViewModel["summary"]>;
  shellSections?: OpenLeashClientViewModel["shellSections"];
}): OpenLeashClientViewModel {
  const outcomesByPlugin = new Map<string, OpenLeashOutcomeRecord[]>();
  for (const outcome of outcomes) {
    const pluginId = outcome.source?.pluginId || "openleash";
    const list = outcomesByPlugin.get(pluginId) || [];
    list.push(outcome);
    outcomesByPlugin.set(pluginId, list);
  }
  const installed = plugins
    .filter((plugin) => plugin.settings?.enabled === true)
    .map((plugin): OpenLeashClientPluginView => {
      const pluginOutcomes = outcomesByPlugin.get(plugin.id) || [];
      return {
        id: plugin.id,
        packageId: pluginPackageId(plugin),
        // Compatibility IDs remain internal. Clients receive the one readable
        // Feature name authored in the built-in manifest.
        displayName: plugin.name || pluginPackageId(plugin),
        description: plugin.marketplace?.shortDescription || plugin.description,
        category: pluginCategoryId(plugin),
        installed: true,
        iconText: plugin.marketplace?.iconText,
        configSchema: plugin.configSchema,
        defaultConfig: plugin.defaultConfig,
        settings: plugin.settings,
        outcomeCount: pluginOutcomes.length,
        latestOutcome: pluginOutcomes[0]
      };
    });
  return {
    version: "2026-06-26.client-view-model.v1",
    generatedAt: new Date().toISOString(),
    shellSections,
    pluginCategories: OPENLEASH_PLUGIN_CATEGORIES.map((category) => {
      const categoryPlugins = installed.filter((plugin) => plugin.category === category.id);
      return { ...category, count: categoryPlugins.length, plugins: categoryPlugins };
    }),
    outcomes,
    summary: clientViewSummary(outcomes, summary)
  };
}

function clientViewSummary(outcomes: OpenLeashOutcomeRecord[], summary?: Partial<OpenLeashClientViewModel["summary"]>): NonNullable<OpenLeashClientViewModel["summary"]> {
  const fallback = {
    totalOutcomes: outcomes.length,
    highSeverity: outcomes.filter((item) => item.severity === "high" || item.severity === "critical").length,
    blocked: outcomes.filter((item) => item.status === "blocked" || item.decision === "blocked" || item.decision === "deny").length,
    needsReview: outcomes.filter((item) => item.status === "needs_review" || item.decision === "ask").length,
    byDomain: outcomes.reduce<Record<string, number>>((acc, item) => {
      acc[item.domain] = (acc[item.domain] ?? 0) + 1;
      return acc;
    }, {})
  };
  return {
    totalOutcomes: summary?.totalOutcomes ?? summary?.total ?? fallback.totalOutcomes,
    highSeverity: summary?.highSeverity ?? fallback.highSeverity,
    blocked: summary?.blocked ?? fallback.blocked,
    needsReview: summary?.needsReview ?? fallback.needsReview,
    byDomain: summary?.byDomain ?? fallback.byDomain
  };
}

export type PluginUsageKind = "llm.tokens" | "plugin.compute" | "plugin.operation" | "network.egress" | "storage.bytes";

export type PluginUsageRecordRequest = {
  kind: PluginUsageKind;
  quantity?: number;
  unit?: string;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  savedTokens?: number;
  estimatedCostUsd?: number;
  details?: Record<string, unknown>;
  occurredAt?: string;
};

export type PluginUsageRecord = PluginUsageRecordRequest & {
  id?: string;
  pluginId: string;
  organizationId?: string;
  conversationEventId?: string;
  userId?: string;
  computerId?: string;
  agentRuntimeId?: string;
  agentKind?: string;
  sessionId?: string;
  projectPath?: string;
  createdAt: string;
};

export type PluginInstructionFile = {
  agent: string;
  scope: "global" | "project";
  label?: string;
  path?: string;
  content: string;
  parsedLines?: string[];
};

export type PluginInstructionListRequest = {
  agent?: string;
  scope?: "global" | "project";
};

export type PluginConversationRecentRequest = {
  /** Bounded by the runtime. Defaults to 20 and never exceeds 100. */
  limit?: number;
};

export type PluginConversationContext = {
  sessionId: string;
  turns: ConversationTurn[];
  /** True when older turns exist outside the returned bounded window. */
  truncated: boolean;
};

export type PluginLlmJsonRequest = {
  system?: string;
  prompt: string;
  schema?: Record<string, unknown>;
  maxOutputTokens?: number;
  temperature?: number;
  purpose?: string;
};

export type PluginLlmJsonResult<T = unknown> = {
  json: T;
  model: string;
  provider: string;
  source: "tenant-byok" | "openleash-managed" | "heuristic";
};

export type PluginCapabilities = {
  context: {
    instructions: {
      list(request?: PluginInstructionListRequest): Promise<PluginInstructionFile[]>;
    };
    conversation: {
      /**
       * Returns only the authenticated current session. A plugin cannot select
       * another user, organization, or arbitrary session through this API.
       */
      recent(request?: PluginConversationRecentRequest): Promise<PluginConversationContext>;
    };
  };
  llm: {
    evaluateJson<T = unknown>(request: PluginLlmJsonRequest): Promise<PluginLlmJsonResult<T> | undefined>;
  };
  storage: {
    get<T = unknown>(request: PluginStorageGetRequest): Promise<PluginStorageRead<T> | undefined>;
    set(request: PluginStorageSetRequest): Promise<PluginStorageRead>;
    list<T = unknown>(request?: PluginStorageListRequest): Promise<Array<PluginStorageRead<T>>>;
    delete(request: PluginStorageGetRequest): Promise<void>;
  };
  notification: {
    send(request: PluginNotificationRequest): Promise<PluginNotificationResult>;
  };
  island: {
    annotateSession(request: PluginIslandAnnotationRequest): Promise<PluginIslandPublishResult>;
    reportActivity(request: PluginIslandActivityRequest): Promise<PluginIslandPublishResult>;
    publishStatus(request: PluginIslandStatusRequest): Promise<PluginIslandPublishResult>;
    clear(request: PluginIslandClearRequest): Promise<void>;
  };
  log: {
    emit(request: PluginLogRequest): Promise<PluginLogRecord>;
  };
  signals: {
    emit(request: PluginSignalRequest): Promise<PluginSignalRecord>;
  };
  usage: {
    record(request: PluginUsageRecordRequest): Promise<PluginUsageRecord>;
  };
};

export type OpenLeashEvent = {
  eventName: HookEventName;
  agentKind: AgentKind;
  agentVersion?: string;
  sessionId: string;
  projectPath?: string;
  transcript?: ConversationTurn[];
  tool?: {
    name: string;
    input?: unknown;
    output?: unknown;
  };
  prompt?: string;
  raw?: unknown;
  occurredAt: string;
};

export type McpToolCall = {
  serverName: string;
  toolName: string;
  fullToolName: string;
  arguments: unknown;
  argumentSummary: string;
};

export type ConversationTurn = {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  at?: string;
};

export type Policy = {
  id: string;
  name: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  naturalLanguageRule: string;
  enabled: boolean;
  locked?: boolean;
  enforcementAction?: "allow" | "ask" | "block";
};

export type PolicyDecision = {
  policyId: string;
  policyName: string;
  status: "passed" | "failed" | "needs_question";
  severity: Policy["severity"];
  explanation: string;
  evidence?: string[];
  question?: string;
};

export type EvaluationRequest = {
  computer: {
    hostname: string;
    platform: string;
    osRelease?: string;
  };
  agent: {
    kind: AgentKind;
    displayName: string;
    instanceId?: string;
    version?: string;
    executablePath?: string;
  };
  event: OpenLeashEvent;
};

/** Transport-independent event contract used by hooks, the local proxy and pullers. */
export type AgentEventSource = "api_hook" | "local_proxy" | "provider_puller";

export type AgentEventCapabilities = {
  observe: true;
  block: boolean;
  rewritePrompt: boolean;
  rewriteToolInput: boolean;
  rewriteResponse: boolean;
};

export type NormalizedAgentEvent = {
  schemaVersion: "2026-07-12.v1";
  idempotencyKey: string;
  correlationId?: string;
  source: AgentEventSource;
  provider: string;
  capabilities: AgentEventCapabilities;
  request: EvaluationRequest;
  receivedAt?: string;
};

export type NormalizedAgentEventResult = EvaluationResponse & {
  deduplicated: boolean;
  source: AgentEventSource;
  finalPrompt?: string;
};

export type EvaluationResponse = {
  decision: "allow" | "deny" | "ask";
  decisionId: string;
  summary: string;
  /** The recorded decision before a Business learning-only policy allowed execution. */
  observedDecision?: "deny" | "ask";
  runtimePolicy?: BusinessRuntimePolicy;
  resolutionGuidance?: string;
  /** Agent-native interaction data returned after a human answers in an OpenLeash client. */
  resolutionPayload?: Record<string, unknown>;
  question?: string;
  results: PolicyDecision[];
};

/** Business-only organization controls supplied by the private cloud control plane. */
export type BusinessRuntimePolicy = {
  enforcementMode: "enforce" | "learning";
  notifyEmployees: boolean;
  updatedAt?: string | null;
};

export type DashboardActivitySummary = {
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
  agentKinds: Array<{
    kind: string;
    name: string;
    count: number;
  }>;
};

export type OpenLeashAttentionEvent = {
  schemaVersion: "2026-07-19.v1";
  id: string;
  decisionId?: string;
  kind:
    | "approval"
    | "question"
    | "plan_review"
    | "completed"
    | "subagent_completed"
    | "blocked";
  state: "waiting" | "resolved";
  title: string;
  body?: string;
  createdAt: string;
  agent: { kind: string; name: string; hostname: string };
  session: { id: string; projectPath?: string };
  interaction?:
    | { type: "approval" }
    | {
        type: "questions";
        originalInput: Record<string, unknown>;
        questions: Array<{
          question: string;
          header?: string;
          multiSelect: boolean;
          options: Array<{ label: string; description?: string }>;
        }>;
      }
    | {
        type: "plan";
        markdown?: string;
        originalInput: Record<string, unknown>;
      };
};

export type MobileIdentityProvider = {
  id: string;
  type: "google" | "google_workspace" | "github" | "okta" | "azure_ad" | "ping" | "oidc" | "custom";
  label: string;
  organizationId?: string;
  organizationSlug?: string;
  authorizationUrl?: string;
};

export type MobileBootstrapResponse = {
  mode: OpenLeashClientMode;
  apiUrl: string;
  cloudApiUrl: string;
  providers: MobileIdentityProvider[];
  organization?: {
    id: string;
    name: string;
    slug: string;
    region?: string | null;
  };
};

export type MobileAuthStartRequest = {
  audience?: "individual" | "organization";
  organizationSlug?: string;
  organizationId?: string;
  providerType?: MobileIdentityProvider["type"];
  redirectUri: string;
  /** RFC 7636 challenge binding a custom-scheme callback to this app instance. */
  codeChallenge?: string;
  codeChallengeMethod?: "S256";
};

export type MobileAuthStartResponse = {
  authorizationUrl: string;
  state: string;
  providerType: MobileIdentityProvider["type"];
  organizationId?: string;
};

export type MobileAuthExchangeRequest = {
  audience?: "individual" | "organization";
  organizationId?: string;
  organizationSlug?: string;
  providerType: MobileIdentityProvider["type"];
  authorizationCode?: string;
  /** Opaque, single-use state returned by the matching auth start request. */
  state?: string;
  /** RFC 7636 verifier matching the challenge supplied when sign-in started. */
  codeVerifier?: string;
  idToken?: string;
  redirectUri: string;
  provisionUser?: boolean;
  /**
   * Also issue a short-lived enrollment grant for an authenticated Desktop handoff.
   * The dashboard access token remains browser-only.
   */
  desktopEnrollment?: boolean;
};

export type MobileAuthExchangeResponse = {
  success: boolean;
  /** Short-lived credential accepted only by the Desktop enrollment endpoint. */
  desktopEnrollmentToken?: string;
  tokens: {
    accessToken: string;
    expiresAt: string;
  };
  user: {
    id: string;
    email: string;
    display_name: string;
    role: string;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
    region?: string | null;
  };
  authMode: "sso" | "google" | "development";
};

export type MobileDeviceRegisterRequest = {
  platform: "ios" | "android" | "web" | "unknown";
  pushToken?: string;
  deviceName?: string;
  appVersion?: string;
};

export type MobilePendingApproval = {
  id: string;
  attention_kind: "approval" | "question" | "plan_review";
  interaction?: OpenLeashAttentionEvent["interaction"];
  summary: string;
  question?: string;
  created_at: string;
  agent_name: string;
  agent_kind: AgentKind;
  project_path?: string | null;
  project_name?: string | null;
  primary_policy?: string | null;
  quote?: string | null;
  purpose_summary?: string | null;
  recent_context?: Array<{
    role: ConversationTurn["role"];
    content: string;
    at?: string;
  }>;
  triggered_policies: Array<{
    policy_name: string;
    status: string;
    severity: string;
    explanation: string;
    evidence?: string[];
  }>;
};

export type MobileStateResponse = {
  user: MobileAuthExchangeResponse["user"];
  organization: MobileAuthExchangeResponse["organization"];
  apiUrl: string;
  mode: OpenLeashClientMode;
  pendingApprovals: MobilePendingApproval[];
  attentionEvents: OpenLeashAttentionEvent[];
  clientConfig: {
    approvalNotifications: boolean;
    managedByOrganization: boolean;
    runtimePolicy?: BusinessRuntimePolicy;
  };
};

export type OpenLeashClientSyncEvent = {
  schemaVersion: "2026-07-27.client-sync.v1";
  id: string;
  kind:
    | "activity.created"
    | "interaction.created"
    | "interaction.resolved";
  occurredAt: string;
};

export type MobileDecisionResolveRequest = {
  resolution: "allow" | "deny";
  resolutionGuidance?: string;
  /** Structured response for agent-native questions and plan review. */
  response?: Record<string, unknown>;
};

export type MobileDecisionResolveResponse = {
  id: string;
  decision: "ask";
  resolution: "allow" | "deny";
  resolution_guidance?: string | null;
  resolved_at: string;
} | null;

export type HookAgentSlug =
  | "claude"
  | "codex"
  | "copilot"
  | "cursor"
  | "gemini"
  | "opencode"
  | "openclaw"
  | "nanoclaw";

export const HOOK_AGENT_METADATA: Record<HookAgentSlug, { kind: AgentKind; displayName: string }> = {
  claude: { kind: "claude-code", displayName: "Claude Code" },
  codex: { kind: "codex", displayName: "OpenAI Codex" },
  copilot: { kind: "github-copilot", displayName: "GitHub Copilot" },
  cursor: { kind: "cursor", displayName: "Cursor" },
  gemini: { kind: "gemini", displayName: "Google Gemini CLI" },
  opencode: { kind: "opencode", displayName: "OpenCode" },
  openclaw: { kind: "openclaw", displayName: "OpenClaw" },
  nanoclaw: { kind: "nanoclaw", displayName: "NanoClaw" }
};

export type HookContextQuery = {
  user_token?: string;
  token?: string;
  agent_version?: string;
  client_version?: string;
  hostname?: string;
  platform?: string;
  os_release?: string;
};

export const OPENLEASH_API_FUNCTION_HEADER = "x-openleash-api-function";
export const OPENLEASH_API_VERSION_HEADER = "x-openleash-api-version";

export const OPENLEASH_API_CONTRACTS = {
  health: "2026-05-16.health.v1",
  tenantEnroll: "2026-05-16.tenant-enroll.v1",
  tenantEvaluate: "2026-05-16.tenant-evaluate.v1",
  tenantHookEvaluate: "2026-05-22.tenant-hook-evaluate.v1",
  tenantDecisionPoll: "2026-05-16.tenant-decision-poll.v1",
  tenantDecisionResolve: "2026-05-16.tenant-decision-resolve.v1",
  tenantTrayStatus: "2026-05-16.tenant-tray-status.v1",
  tenantSkillObservation: "2026-05-27.tenant-skill-observation.v1",
  tenantPluginsRead: "2026-06-20.tenant-plugins-read.v1",
  desktopEnroll: "2026-06-03.desktop-enroll.v1",
  adminOverview: "2026-05-16.admin-overview.v1",
  adminSecurity: "2026-06-22.admin-security.v1",
  adminOutcomes: "2026-06-24.admin-outcomes.v1",
  adminMcpServers: "2026-05-27.admin-mcp-servers.v1",
  adminMcpServerDetail: "2026-05-27.admin-mcp-server-detail.v1",
  adminSkills: "2026-05-27.admin-skills.v1",
  adminPluginsRead: "2026-06-20.admin-plugins-read.v1",
  adminPluginsWrite: "2026-06-20.admin-plugins-write.v1",
  adminLogs: "2026-06-03.admin-logs.v1",
  adminLogDetail: "2026-06-03.admin-log-detail.v1",
  adminTriggers: "2026-05-16.admin-triggers.v1",
  adminTriggerDetail: "2026-05-16.admin-trigger-detail.v1",
  adminEventDetail: "2026-05-16.admin-event-detail.v1",
  adminExternalAgents: "2026-05-16.admin-external-agents.v1",
  adminExternalAgentsSync: "2026-05-16.admin-external-agents-sync.v1",
  adminProviderUsageRead: "2026-06-09.admin-provider-usage-read.v1",
  adminProviderUsageWrite: "2026-06-09.admin-provider-usage-write.v1",
  adminProviderUsageSync: "2026-06-09.admin-provider-usage-sync.v1",
  adminOnboardingRead: "2026-05-16.admin-onboarding-read.v1",
  adminOnboardingWrite: "2026-05-16.admin-onboarding-write.v1",
  adminIdentityRead: "2026-05-16.admin-identity-read.v1",
  adminUsersWrite: "2026-05-16.admin-users-write.v1",
  adminDeploymentTokensRead: "2026-05-16.admin-deployment-tokens-read.v1",
  adminDeploymentTokensWrite: "2026-05-16.admin-deployment-tokens-write.v1",
  adminPoliciesRead: "2026-05-16.admin-policies-read.v1",
  adminPoliciesWrite: "2026-05-16.admin-policies-write.v1",
  adminPromptTransformsRead: "2026-06-06.admin-prompt-transforms-read.v1",
  adminPromptTransformsWrite: "2026-06-06.admin-prompt-transforms-write.v1",
  authSession: "2026-05-16.auth-session.v1",
  authAccountOutcomes: "2026-06-24.auth-account-outcomes.v1",
  authLogout: "2026-05-16.auth-logout.v1",
  authSsoAuthorize: "2026-05-16.auth-sso-authorize.v1",
  authSsoCallback: "2026-05-16.auth-sso-callback.v1",
  authGoogleCallback: "2026-05-24.auth-google-callback.v1",
  mobileBootstrap: "2026-05-22.mobile-bootstrap.v1",
  mobileAuthStart: "2026-05-22.mobile-auth-start.v1",
  mobileAuthExchange: "2026-05-22.mobile-auth-exchange.v1",
  mobileModelKey: "2026-05-23.mobile-model-key.v1",
  mobileDeviceRegister: "2026-05-22.mobile-device-register.v1",
  mobileState: "2026-05-22.mobile-state.v1",
  clientOverview: "2026-08-13.client-overview.v1",
  mobileDecisionResolve: "2026-05-22.mobile-decision-resolve.v1",
  clientNotifications: "2026-06-28.client-notifications.v1",
  clientEvents: "2026-07-27.client-events.v1",
  clientDecisionResolve: "2026-06-28.client-decision-resolve.v1",
  sessionMonitoring: "2026-07-29.session-monitoring.v1",
  organizationsRead: "2026-05-16.organizations-read.v1",
  organizationsWrite: "2026-05-16.organizations-write.v1",
  organizationSsoProviders: "2026-05-16.organization-sso-providers.v1",
  clientUpdateCheck: "2026-05-16.client-update-check.v1",
  clientUpdateLatest: "2026-05-16.client-update-latest.v1",
  clientReleasePublish: "2026-05-16.client-release-publish.v1",
  localEvaluate: "2026-05-16.local-evaluate.v1",
  localHookEvaluate: "2026-05-22.local-hook-evaluate.v1"
} as const;

export type OpenLeashApiFunction = keyof typeof OPENLEASH_API_CONTRACTS;

export function apiVersionHeaders(functionName: OpenLeashApiFunction): Record<string, string> {
  return {
    [OPENLEASH_API_FUNCTION_HEADER]: functionName,
    [OPENLEASH_API_VERSION_HEADER]: OPENLEASH_API_CONTRACTS[functionName]
  };
}

export function apiContractFor(functionName: OpenLeashApiFunction) {
  return {
    functionName,
    version: OPENLEASH_API_CONTRACTS[functionName]
  };
}

export type OpenLeashClientMode = "community" | "cloud" | "enterprise";

const MCP_TOOL_PATTERNS = [
  /^mcp__([A-Za-z0-9_.-]+)__(.+)$/i,
  /^mcp[:.]([A-Za-z0-9_.-]+)[:.](.+)$/i
];

const SECRET_ARGUMENT_KEY = /(api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|client[_-]?secret|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)/i;

export function parseMcpToolName(toolName?: string): Pick<McpToolCall, "serverName" | "toolName" | "fullToolName"> | undefined {
  const name = String(toolName ?? "").trim();
  if (!name) return undefined;
  for (const pattern of MCP_TOOL_PATTERNS) {
    const match = name.match(pattern);
    if (match?.[1] && match[2]) {
      return {
        serverName: normalizeMcpServerName(match[1]),
        toolName: match[2],
        fullToolName: name
      };
    }
  }
  return undefined;
}

export function mcpToolCallFromEvent(event: OpenLeashEvent): McpToolCall | undefined {
  const parsed =
    parseMcpToolName(event.tool?.name) ??
    mcpToolCallFromRaw(event.raw);
  if (!parsed) return undefined;
  const args = redactMcpArguments(event.tool?.input ?? rawToolInput(event.raw) ?? {});
  return {
    ...parsed,
    arguments: args,
    argumentSummary: summarizeMcpArguments(args)
  };
}

export function redactMcpArguments(value: unknown, depth = 0): unknown {
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

export function summarizeMcpArguments(value: unknown): string {
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

function normalizeMcpServerName(value: string) {
  return value.trim().replace(/\s+/g, "-").slice(0, 160);
}

function rawToolInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const tool = record.tool && typeof record.tool === "object" ? record.tool as Record<string, unknown> : undefined;
  return record.tool_input ?? record.toolInput ?? tool?.input ?? record.input;
}

function mcpToolCallFromRaw(raw: unknown): Pick<McpToolCall, "serverName" | "toolName" | "fullToolName"> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const serverName =
    record.mcp_server ??
    record.mcpServer ??
    record.server_name ??
    record.serverName ??
    (record.tool && typeof record.tool === "object" ? (record.tool as Record<string, unknown>).serverName : undefined);
  const toolName =
    record.tool_name ??
    record.toolName ??
    (record.tool && typeof record.tool === "object" ? (record.tool as Record<string, unknown>).name : undefined);
  if (typeof serverName !== "string" || typeof toolName !== "string") return undefined;
  return {
    serverName: normalizeMcpServerName(serverName),
    toolName,
    fullToolName: parseMcpToolName(toolName)?.fullToolName ?? `mcp__${normalizeMcpServerName(serverName)}__${toolName}`
  };
}
