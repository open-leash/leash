import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import cors from "cors";
import "dotenv/config";
import express, { type Express } from "express";
import type { PoolClient } from "pg";
import {
  buildOpenLeashClientViewModel,
  OPENLEASH_API_CONTRACTS,
  OPENLEASH_API_FUNCTION_HEADER,
  OPENLEASH_API_VERSION_HEADER,
  HOOK_AGENT_METADATA,
  type AgentKind,
  type ConversationTurn,
  type DashboardActivitySummary,
  type EvaluationRequest,
  type EvaluationResponse,
  type AgentEventSource,
  type NormalizedAgentEvent,
  type HookAgentSlug,
  type HookEventName,
  type MobileAuthExchangeRequest,
  type MobileAuthStartRequest,
  type MobileDeviceRegisterRequest,
  type MobileDecisionResolveRequest,
  type OpenLeashApiFunction,
  type McpToolCall,
  type OpenLeashPluginManifest,
  type OpenLeashOutcomeDomain,
  type OpenLeashOutcomeRecord,
  type OpenLeashOutcomeStatus,
  type PluginCatalogItem,
  type PluginFinding,
  type PluginLogRecord,
  type PluginLogRequest,
  type PluginIslandPublishRequest,
  type PluginMarketplaceListing,
  type PipelineEvent,
  type PluginRunRecord,
  type PluginSignalRequest,
  type PluginSettingProfile,
  type PluginSettingState,
  type PluginUsageRecordRequest,
  type Policy,
  type PolicyDecision,
} from "@openleash/shared";
import {
  configureRuntimePolicyProvider,
  effectiveRuntimeDecision,
  runtimePolicyForUser,
  type RuntimePolicyProvider,
} from "./runtime-policy.js";
import {
  acceptsLegacyHookContract,
  negotiateApiContractVersion,
  OPENLEASH_API_COMPATIBILITY_HEADER,
  OPENLEASH_API_NEGOTIATED_VERSION_HEADER,
} from "./api-versioning.js";
import { z } from "zod";
import {
  defaultAccountPackage,
  deploymentUsesManagedEvaluation,
} from "./account-package.js";
import { ensureDevToken, getUserByToken, hashToken, pool } from "./db.js";
import { summarizeActionPurpose } from "./evaluator.js";
import { nativeHookDecision } from "./hook-decisions.js";
import { attributedHookAgent } from "./hook-attribution.js";
import { pluginIconText } from "./plugin-icons.js";
import { normalizePluginIconInput } from "./plugin-icon-input.js";
import { canonicalPluginSlug } from "./plugin-slug.js";
import { notificationPluginAttribution } from "./notification-plugin-attribution.js";
import { activeIslandContributions } from "./plugins/island-contributions.js";
import {
  defaultPromptTransformConfig,
  normalizePromptTransformConfig,
  promptTransformsEnabled,
  type PromptTransformConfig,
} from "./prompt-transforms.js";
import { firstPartyPluginManifests } from "./plugins/registry.js";
import { eventForHookEvent } from "./plugins/events.js";
import { runEvaluationPipeline, runPromptPipeline } from "./plugins/runtime.js";
import { createPluginCapabilities } from "./plugins/capabilities.js";
import {
  transformProviderRequestWithFeatures,
  verifyBuiltinFeatureRegistry,
} from "./plugins/feature-runtime.js";
import { runSkillScanner } from "./plugins/skill-scanner/index.js";
import {
  configureAuditExportProvider,
  exportAuditDecision,
  exportAuditLog,
  type AuditExportProvider,
} from "./audit-export.js";
export {
  activeAuditExportProviderId,
  configureAuditExportProvider,
  exportAuditDecision,
  exportAuditLog,
} from "./audit-export.js";
export type {
  AuditDecisionExport,
  AuditExportProvider,
  AuditExportResult,
  AuditExportSeverity,
  AuditLogExport,
} from "./audit-export.js";
import { normalizePluginSettingProfiles, resolvePluginSettingProfiles } from "./plugins/settings-profiles.js";
import {
  canUserConfigurePlugin,
  canUserInstallPlugin,
  canUserUninstallPlugin,
  normalizeOrganizationPluginPolicy,
  pluginEnabledForUser,
  pluginProvidedByOrganization,
} from "./plugins/plugin-policy.js";
import type { PromptPipelineResult } from "./plugins/types.js";
import {
  EXTERNAL_PROVIDER_IDS,
  externalConversationToEvaluation,
  externalEvaluationKey,
  externalProviderLabel,
  fetchConfiguredExternalConversations,
  listExternalConnectors,
  type ExternalProvider,
} from "./external-agents.js";
import {
  listProviderUsageConnections,
  normalizeUsageProvider,
  providerUsageOverview,
  syncProviderUsage,
  upsertProviderUsageConnection,
  upsertProviderUsageBudget,
  validateProviderConnection,
} from "./provider-usage.js";
import {
  deleteTenantModelKey,
  normalizeTenantModelProvider,
  readTenantModelKey,
  tenantModelKeySummary,
  upsertTenantModelKey,
} from "./model-keys.js";
import {
  hasCapability,
  isOrganizationManagedAccount,
  openLeashProductModeFromEnv,
  pluginExecutionAvailable,
  pluginImageDigestRequired,
  publicProductMode,
  type OpenLeashCapability,
} from "./product-mode.js";
import {
  assertReleaseAdmin,
  checkForClientUpdate,
  updateRequestSchema,
  upsertRelease,
} from "./releases.js";
import {
  normalizeAgentEvent,
  OBSERVATION_ONLY_CAPABILITIES,
} from "./agent-events.js";
import { agentInteractionForRequest } from "./agent-interactions.js";
import {
  canonicalIntentKey,
  handledIntentKeysMatch,
  isReusableHandledIntent,
  pendingIntentKey,
} from "./intent-dedupe.js";
import {
  attentionEventForPending,
  attentionKindForTool,
  buildAttentionEvents,
} from "./attention-events.js";
import { ClientSyncBroker } from "./client-sync.js";
import {
  isMissingSessionMonitoringSchema,
  normalizeSessionMonitoringScope,
  normalizedSessionPauseExpiry,
  tolerateMissingSessionMonitoringSchema,
} from "./session-monitoring.js";

class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function statusCodeForError(error: unknown) {
  if (!error || typeof error !== "object") return 500;
  if ("code" in error && String(error.code) === "P0001" && "message" in error) {
    const message = String(error.message);
    if (
      /Leash workspace.*capacity/i.test(message)
      || /Cloud trial protects one computer per person/i.test(message)
      || /Personal Cloud protects up to two computers/i.test(message)
    ) {
      return 403;
    }
    if (/stable Leash installation identity/i.test(message)) return 400;
    if (/Leash Cloud account is not active/i.test(message)) return 402;
  }
  const candidate = "statusCode" in error
    ? Number(error.statusCode)
    : "status" in error
      ? Number(error.status)
      : 500;
  return Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
    ? candidate
    : 500;
}

function isEvaluationResponse(value: unknown): value is EvaluationResponse {
  return Boolean(
    value &&
      typeof value === "object" &&
      "decision" in value &&
      "decisionId" in value &&
      "summary" in value &&
      "results" in value,
  );
}

export type ApiSurface = "client" | "dashboard" | "all";
export type OpenLeashApiExtension = (
  context: OpenLeashApiContext,
) => void | Promise<void>;
export type OpenLeashApiContext = {
  app: Express;
  surface: ApiSurface;
};
export type StartOpenLeashApiOptions = {
  app?: Express;
  surface?: ApiSurface;
  port?: number;
  extensions?: OpenLeashApiExtension[];
  auditExportProvider?: AuditExportProvider;
  runtimePolicyProvider?: RuntimePolicyProvider;
};
export type PrepareOpenLeashApiOptions = Pick<
  StartOpenLeashApiOptions,
  "app" | "surface" | "extensions" | "auditExportProvider" | "runtimePolicyProvider"
>;

export const app = express();
const clientSyncBroker = new ClientSyncBroker(pool);
type NormalizedEventDecision =
  EvaluationResponse | Awaited<ReturnType<typeof handlePromptOnlyHook>>;
const inflightNormalizedEvents = new Map<
  string,
  Promise<NormalizedEventDecision>
>();
let missingSessionMonitoringSchemaWarningLogged = false;
const pipelineTraceEnabled = process.env.OPENLEASH_PIPELINE_TRACE === "1";
const pipelineTraceFile = process.env.OPENLEASH_PIPELINE_TRACE_FILE?.trim();
export const apiSurface = apiSurfaceFromEnv();
export const productMode = openLeashProductModeFromEnv();
const LOCAL_HOOK_AGENT_METADATA: Record<
  string,
  { kind: AgentKind | string; displayName: string }
> = {
  ...HOOK_AGENT_METADATA,
  gemini: { kind: "gemini", displayName: "Google Gemini CLI" },
  opencode: { kind: "opencode", displayName: "OpenCode" },
};
const LOCAL_PROXY_PROMPT_AGENTS = new Set([
  "claude-code",
  "codex",
  "opencode",
  "nanoclaw",
]);

app.disable("x-powered-by");
app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedCorsOrigin(origin)) return callback(null, true);
      return callback(
        new Error("origin is not allowed by OpenLeash CORS policy"),
      );
    },
    credentials: false,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "authorization",
      "content-type",
      OPENLEASH_API_FUNCTION_HEADER,
      OPENLEASH_API_VERSION_HEADER,
    ],
    exposedHeaders: [
      OPENLEASH_API_FUNCTION_HEADER,
      OPENLEASH_API_VERSION_HEADER,
      OPENLEASH_API_NEGOTIATED_VERSION_HEADER,
      OPENLEASH_API_COMPATIBILITY_HEADER,
    ],
  }),
);
app.use(express.json({ limit: process.env.OPENLEASH_API_JSON_LIMIT ?? "20mb" }));
app.use((req, res, next) => {
  const routeSurface = surfaceForRequest(req.method, req.path);
  if (
    apiSurface !== "all" &&
    routeSurface &&
    routeSurface !== "all" &&
    routeSurface !== apiSurface
  ) {
    return res.status(404).json({
      error: "not found",
      service:
        apiSurface === "dashboard"
          ? "openleash-dashboard-api"
          : "openleash-api",
    });
  }
  return next();
});
app.use((req, res, next) => {
  const capability = capabilityForRequest(req.method, req.path);
  if (capability && !hasCapability(productMode, capability)) {
    return res.status(404).json({
      error: "not found",
      service:
        apiSurface === "dashboard"
          ? "openleash-dashboard-api"
          : "openleash-client-api",
    });
  }
  return next();
});
app.use((req, res, next) => {
  const functionName = apiFunctionForRequest(req.method, req.path);
  if (!functionName) return next();
  res.setHeader(OPENLEASH_API_FUNCTION_HEADER, functionName);
  res.setHeader(
    OPENLEASH_API_VERSION_HEADER,
    OPENLEASH_API_CONTRACTS[functionName],
  );
  const requestedVersion = req.header(OPENLEASH_API_VERSION_HEADER);
  const negotiation = negotiateApiContractVersion(
    functionName,
    requestedVersion,
  );
  const acceptsLegacyLocalHookVersion = acceptsLegacyHookContract(
    functionName,
    req.path,
    requestedVersion,
  );
  res.setHeader(
    OPENLEASH_API_NEGOTIATED_VERSION_HEADER,
    acceptsLegacyLocalHookVersion
      ? requestedVersion ?? negotiation.negotiatedVersion
      : negotiation.negotiatedVersion,
  );
  res.setHeader(
    OPENLEASH_API_COMPATIBILITY_HEADER,
    acceptsLegacyLocalHookVersion ? "backward-compatible" : negotiation.mode,
  );
  if (!negotiation.compatible && !acceptsLegacyLocalHookVersion) {
    return res.status(426).json({
      error: "unsupported OpenLeash API contract version",
      function: functionName,
      expectedVersion: negotiation.currentVersion,
      receivedVersion: requestedVersion,
      compatibility: "Use the same contract name and major version, or update Leash.",
    });
  }
  return next();
});
app.use(async (req, res, next) => {
  try {
    if (!requiresDashboardWriteSession(req)) return next();
    if (allowsLocalDashboardWriteBypass(req)) return next();
    const session = await getDashboardSession(
      req.header("authorization") ?? "",
    );
    const permittedRoles = req.path.startsWith("/admin/decisions/")
      ? ["owner", "admin", "ciso", "security_admin", "responder"]
      : ["owner", "admin", "ciso", "security_admin"];
    if (!session) {
      return res
        .status(401)
        .json({ error: "dashboard admin session required" });
    }
    if (!permittedRoles.includes(session.user.role)) {
      return res
        .status(403)
        .json({ error: "dashboard role cannot perform this action" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
});
app.use(async (req, res, next) => {
  try {
    const requestedSlug =
      typeof req.query.organizationSlug === "string"
        ? req.query.organizationSlug
        : undefined;
    if (!requestedSlug || !req.path.startsWith("/admin/")) return next();
    const session = await getDashboardSession(
      req.header("authorization") ?? "",
    );
    if (session && requestedSlug !== session.organization.slug) {
      return res.status(403).json({ error: "cannot access another organization" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
});

const eventSchema = z.object({
  computer: z.object({
    hostname: z.string(),
    platform: z.string(),
    osRelease: z.string().optional(),
  }),
  agent: z.object({
    kind: z.string(),
    displayName: z.string(),
    version: z.string().optional(),
    executablePath: z.string().optional(),
  }),
  event: z.object({
    eventName: z.string(),
    agentKind: z.string(),
    agentVersion: z.string().optional(),
    sessionId: z.string(),
    projectPath: z.string().optional(),
    transcript: z.array(z.any()).optional(),
    tool: z.any().optional(),
    prompt: z.string().optional(),
    raw: z.any().optional(),
    occurredAt: z.string(),
  }),
});

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    service: "leash-client-api",
    surface: apiSurface,
    productMode: publicProductMode(productMode),
    apiContracts: Object.fromEntries(
      Object.entries(OPENLEASH_API_CONTRACTS).filter(([name]) =>
        !name.startsWith("admin") &&
        !name.startsWith("organizations") &&
        name !== "organizationSsoProviders" &&
        name !== "authSsoAuthorize" &&
        name !== "authSsoCallback",
      ),
    ),
  }),
);

app.get("/admin/prompt-transforms", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    res.json({ config: await readPromptTransformConfig(organizationId) });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/prompt-transforms", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const config = normalizePromptTransformConfig(req.body?.config ?? req.body);
    await pool.query(
      `insert into prompt_transform_settings (organization_id, config, updated_at)
       values ($1, $2, now())
       on conflict (organization_id) do update set config = excluded.config, updated_at = now()`,
      [organizationId, JSON.stringify(config)],
    );
    res.json({ ok: true, config });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/client/prompt-transforms", async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    const user = token ? await getUserByToken(token) : undefined;
    if (!user)
      return res.status(401).json({ error: "invalid OpenLeash token" });
    const organizationId =
      user.organization_id ?? (await ensureDefaultOrganization()).id;
    res.json({
      config: await readPromptTransformConfig(organizationId, user.id),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/client/prompt-transforms", async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    const user = token ? await getUserByToken(token) : undefined;
    if (!user)
      return res.status(401).json({ error: "invalid OpenLeash token" });
    const organizationId =
      user.organization_id ?? (await ensureDefaultOrganization()).id;
    const config = normalizePromptTransformConfig(req.body?.config ?? req.body);
    await pool.query(
      `insert into prompt_transform_settings (organization_id, config, updated_at)
       values ($1, $2, now())
       on conflict (organization_id) do update set config = excluded.config, updated_at = now()`,
      [organizationId, JSON.stringify(config)],
    );
    await Promise.all([
      savePluginSettingsForUser(
        organizationId,
        user.id,
        "openleash.prompt-compression",
        config.compression.enabled
          ? { enabled: true, config: config.compression }
          : { enabled: false },
      ),
      savePluginSettingsForUser(organizationId, user.id, "openleash.dlp", {
        enabled: config.dlp.enabled,
        ...(config.dlp.enabled ? { config: config.dlp } : {}),
      }),
    ]);
    res.json({ ok: true, config });
  } catch (error) {
    next(error);
  }
});

app.post("/api/updates/check", async (req, res) => {
  try {
    const updateRequest = updateRequestSchema.parse(req.body);
    res.json(await checkForClientUpdate(updateRequest));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid update request.",
    });
  }
});

app.get("/api/updates/latest", async (req, res) => {
  const response = await checkForClientUpdate({
    app: firstQuery(req.query.app) || "openleash-personal",
    version: firstQuery(req.query.version) || "0.0.0",
    platform: firstQuery(req.query.platform) || "darwin",
    arch: firstQuery(req.query.arch) || "arm64",
    channel: firstQuery(req.query.channel) || "stable",
    installMode: firstQuery(req.query.installMode) || "personal",
    updateSource: "latest-get",
  });
  res.json({
    version: response.latestVersion,
    dmgUrl: response.dmgUrl,
    downloadUrl: response.downloadUrl,
    sha256: response.sha256,
    sizeBytes: response.sizeBytes,
    notesUrl: response.notesUrl,
    releaseNotes: response.releaseNotes,
    publishedAt: response.publishedAt,
    updateAvailable: response.updateAvailable,
  });
});

app.post("/api/admin/releases", async (req, res) => {
  try {
    if (!assertReleaseAdmin(req))
      return res.status(401).json({ error: "Unauthorized." });
    const release = await upsertRelease(req.body);
    res.json({ ok: true, release });
  } catch (error) {
    res.status(400).json({
      error:
        error instanceof Error ? error.message : "Could not publish release.",
    });
  }
});

app.post("/v1/enroll", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const deploymentToken = String(
      req.body.deploymentToken ?? req.body.token ?? "",
    ).trim();
    if (!deploymentToken)
      return res.status(401).json({ error: "missing deployment token" });
    const installIdentity = String(req.body?.installIdentity ?? "").trim();
    if (installIdentity.length < 16 || installIdentity.length > 1024) {
      return res.status(400).json({
        error: "A stable desktop installation identity is required. Update Leash and try again.",
      });
    }
    await client.query("begin");
    const token = await client.query<{
      id: string;
      organization_id: string;
      label: string;
      mode: string;
      tenant_url: string;
      mdm: string | null;
    }>(
      `update deployment_tokens
       set last_used_at = now()
       where token_hash = $1
         and revoked_at is null
         and (expires_at is null or expires_at > now())
         and organization_id is not null
       returning id, organization_id, label, mode, tenant_url, mdm`,
      [hashToken(deploymentToken)],
    );
    const deployment = token.rows[0];
    if (!deployment) {
      await client.query("rollback");
      return res
        .status(401)
        .json({ error: "invalid or expired deployment token" });
    }
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `openleash-protected-user-capacity:${deployment.organization_id}`,
    ]);

    const hostname =
      String(req.body.hostname ?? os.hostname()).trim() || os.hostname();
    const platform = String(req.body.platform ?? "unknown");
    const osRelease =
      typeof req.body.osRelease === "string" ? req.body.osRelease : null;
    const displayName =
      String(req.body.displayName ?? req.body.userName ?? hostname).trim() ||
      hostname;
    const email = String(
      req.body.email ?? `${slug(displayName)}@managed.openleash.com`,
    ).toLowerCase();
    const agentToken = `ol_${crypto.randomBytes(24).toString("base64url")}`;

    const existingIdentity = await client.query<{
      id: string;
      organization_id: string;
      email: string;
      display_name: string;
      status: string;
      same_installation: boolean;
    }>(
      `select u.id, u.organization_id, u.email, u.display_name, u.status,
              exists (
                select 1 from computers c
                where c.user_id = u.id and c.install_identity = $2
              ) as same_installation
       from users u
       where lower(u.email) = lower($1)
       limit 1`,
      [email, installIdentity],
    );
    const existingUser = existingIdentity.rows[0];
    if (existingUser && existingUser.organization_id !== deployment.organization_id) {
      await client.query("rollback");
      return res.status(409).json({
        error: "This email is already enrolled in a different OpenLeash organization.",
      });
    }
    if (existingUser && existingUser.status !== "active") {
      await client.query("rollback");
      return res.status(403).json({
        error: "This employee is not active. Ask a workspace admin before enrolling this computer.",
        code: "enrollment_identity_inactive",
      });
    }
    if (existingUser && !existingUser.same_installation) {
      await client.query("rollback");
      return res.status(409).json({
        error: "This employee already belongs to the workspace. Sign in as that employee to protect a new computer.",
        code: "enrollment_identity_requires_sign_in",
      });
    }
    // A reusable organization deployment token cannot authenticate a person.
    // New installations use the employee's one-time Desktop sign-in grant;
    // this endpoint may only recover the exact installation already associated
    // with an active user.
    if (!existingUser) {
      await client.query("rollback");
      return res.status(409).json({
        error: "Sign in as the employee before enrolling this computer. A shared deployment token cannot create a Leash identity.",
        code: "enrollment_identity_requires_sign_in",
      });
    }
    const user = { rows: [{
      id: existingUser.id,
      email: existingUser.email,
      display_name: existingUser.display_name,
    }] };
    const computer = await client.query<{ id: string }>(
      `insert into computers (
         user_id, hostname, platform, os_release, install_identity,
         enrollment_token_id, enrolled_at, last_seen_at
       ) values ($1, $2, $3, $4, $5, $6, now(), now())
       on conflict (user_id, install_identity) where install_identity is not null do update set
         hostname = excluded.hostname,
         platform = excluded.platform,
         os_release = excluded.os_release,
         enrollment_token_id = excluded.enrollment_token_id,
         enrolled_at = coalesce(computers.enrolled_at, now()),
         last_seen_at = now()
       returning id`,
      [user.rows[0].id, hostname, platform, osRelease, installIdentity, deployment.id],
    );
    await client.query(
      `insert into desktop_credentials (
         organization_id, user_id, computer_id, token_hash, last_seen_at
       ) values ($1, $2, $3, $4, now())
       on conflict (computer_id) do update set
         organization_id = excluded.organization_id,
         user_id = excluded.user_id,
         token_hash = excluded.token_hash,
         revoked_at = null,
         last_seen_at = now()`,
      [deployment.organization_id, user.rows[0].id, computer.rows[0].id, hashToken(agentToken)],
    );
    await client.query("commit");

    res.status(201).json({
      mode: deployment.mode,
      tenantUrl: deployment.tenant_url,
      apiUrl: publicApiUrl(req),
      token: agentToken,
      user: user.rows[0],
      computer: { id: computer.rows[0].id, hostname },
      rulesManagedBy: "admin-dashboard",
    });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

app.post("/v1/session-monitoring", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    if (isOrganizationManagedAccount(productMode, session.account?.audience)) {
      return res.status(403).json({
        error: "Organization-managed monitoring cannot be paused from the Island.",
      });
    }
    const scope = normalizeSessionMonitoringScope(req.body);
    if (!scope)
      return res.status(400).json({
        error: "A stable agent kind and conversation identifier are required.",
      });
    const expiresAt = normalizedSessionPauseExpiry(req.body?.expiresAt);
    await pool.query(
      `insert into session_monitoring_pauses
         (organization_id, user_id, agent_kind, session_id, expires_at, updated_at)
       select $1, $2, $3, unnest($4::text[]), $5, now()
       on conflict (organization_id, user_id, agent_kind, session_id)
       do update set expires_at = excluded.expires_at, updated_at = now()`,
      [
        session.organization.id,
        session.user.id,
        scope.agentKind,
        scope.sessionIds,
        expiresAt,
      ],
    );
    res.json({
      ok: true,
      paused: true,
      agentKind: scope.agentKind,
      sessionIds: scope.sessionIds,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    next(sessionMonitoringRouteError(error));
  }
});

app.delete("/v1/session-monitoring", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const scope = normalizeSessionMonitoringScope(req.body);
    if (!scope)
      return res.status(400).json({
        error: "A stable agent kind and conversation identifier are required.",
      });
    await pool.query(
      `delete from session_monitoring_pauses
       where organization_id = $1
         and user_id = $2
         and agent_kind = $3
         and session_id = any($4::text[])`,
      [
        session.organization.id,
        session.user.id,
        scope.agentKind,
        scope.sessionIds,
      ],
    );
    res.json({
      ok: true,
      paused: false,
      agentKind: scope.agentKind,
      sessionIds: scope.sessionIds,
    });
  } catch (error) {
    next(sessionMonitoringRouteError(error));
  }
});

app.post("/v1/evaluate", async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    const user = token ? await getUserByToken(token) : undefined;
    if (!user)
      return res.status(401).json({ error: "invalid OpenLeash token" });

    const request = eventSchema.parse(req.body) as EvaluationRequest;
    if (await isSessionMonitoringPaused(user, request)) {
      return res.json(sessionMonitoringPausedDecision());
    }
    res.json(await effectiveRuntimeDecision(user, await evaluateAndRecord(request, user)));
  } catch (error) {
    next(error);
  }
});

app.post("/v1/agent-events", async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    const user = token ? await getUserByToken(token) : undefined;
    if (!user)
      return res.status(401).json({ error: "invalid OpenLeash token" });
    const source = String(req.body?.source ?? "") as AgentEventSource;
    if (!["api_hook", "local_proxy", "provider_puller"].includes(source)) {
      return res.status(400).json({
        error: "source must be api_hook, local_proxy, or provider_puller",
      });
    }
    const request = eventSchema.parse(req.body?.request) as EvaluationRequest;
    if (await isSessionMonitoringPaused(user, request)) {
      return res.json({
        ...sessionMonitoringPausedDecision(),
        source,
        deduplicated: false,
      });
    }
    await writePipelineTrace("ingress.raw", {
      source,
      provider: req.body?.provider,
      agent: request.agent.kind,
      event: request.event.eventName,
      sessionId: request.event.sessionId,
      payload: req.body,
    });
    const responseObservation =
      source === "local_proxy" &&
      Boolean(
        (request.event.raw as { response?: unknown } | undefined)?.response,
      ) &&
      !Boolean((request.event.raw as { gated?: unknown } | undefined)?.gated);
    const envelope = normalizeAgentEvent({
      source,
      provider: String(req.body?.provider || request.agent.kind),
      request,
      idempotencyKey:
        typeof req.body?.idempotencyKey === "string"
          ? req.body.idempotencyKey
          : undefined,
      correlationId:
        typeof req.body?.correlationId === "string"
          ? req.body.correlationId
          : undefined,
      capabilities: responseObservation
        ? OBSERVATION_ONLY_CAPABILITIES
        : undefined,
    });
    await writePipelineTrace("pipeline.normalized", {
      traceId: envelope.idempotencyKey,
      source,
      provider: envelope.provider,
      agent: envelope.request.agent.kind,
      event: envelope.request.event.eventName,
      sessionId: envelope.request.event.sessionId,
      envelope,
    });
    const duplicate = await existingNormalizedEvent(
      user.id,
      envelope.idempotencyKey,
    );
    if (duplicate) {
      await writePipelineTrace("pipeline.deduplicated", {
        traceId: envelope.idempotencyKey,
        source,
        agent: envelope.request.agent.kind,
        event: envelope.request.event.eventName,
        decision: duplicate.decision,
      });
      const effective = await effectiveRuntimeDecision(user, duplicate);
      return res.json({ ...effective, source, deduplicated: true });
    }
    const inflightKey = `${user.id}:${envelope.idempotencyKey}`;
    const inflight = inflightNormalizedEvents.get(inflightKey);
    if (inflight) {
      const result = await inflight;
      await writePipelineTrace("pipeline.deduplicated_inflight", {
        traceId: envelope.idempotencyKey,
        source,
        agent: envelope.request.agent.kind,
        event: envelope.request.event.eventName,
        decision: "decision" in result ? result.decision : undefined,
      });
      const effective = isEvaluationResponse(result)
        ? await effectiveRuntimeDecision(user, result)
        : result;
      return res.json({ ...effective, source, deduplicated: true });
    }
    envelope.request.event.raw = attachEventEnvelope(
      envelope.request.event.raw,
      envelope,
    );
    const evaluation = deduplicateConcurrentNormalizedEvent(
      user.id,
      envelope.idempotencyKey,
      async (): Promise<NormalizedEventDecision> => {
      if (source === "local_proxy" && isPromptOnlyHook(envelope.request)) {
        return handlePromptOnlyHook(
          request.agent.kind as HookAgentSlug,
          request.event.eventName,
          request,
          user,
          "proxy",
        );
      }
      const decision = await evaluateAndRecord(envelope.request, user);
      const gatedResponse =
        source === "local_proxy" &&
        Boolean((request.event.raw as { gated?: unknown } | undefined)?.gated);
      return gatedResponse ? waitForHookDecision(user, decision) : decision;
      },
    );
    inflightNormalizedEvents.set(inflightKey, evaluation);
    try {
      const result = await evaluation;
      const resultDecision = "decision" in result ? result.decision : undefined;
      const gatedResponse = Boolean(
        (request.event.raw as { gated?: unknown } | undefined)?.gated,
      );
      await writePipelineTrace("pipeline.final", {
        traceId: envelope.idempotencyKey,
        source,
        provider: envelope.provider,
        agent: envelope.request.agent.kind,
        event: envelope.request.event.eventName,
        sessionId: envelope.request.event.sessionId,
        decision: resultDecision,
        transportOutcome:
          resultDecision === "allow"
            ? gatedResponse
              ? "provider_tool_bytes_released_to_agent"
              : "request_released_to_provider"
            : "intercepted_bytes_not_released",
        result,
      });
      const effective = isEvaluationResponse(result)
        ? await effectiveRuntimeDecision(user, result)
        : result;
      res.json({ ...effective, source, deduplicated: false });
    } finally {
      if (inflightNormalizedEvents.get(inflightKey) === evaluation)
        inflightNormalizedEvents.delete(inflightKey);
    }
  } catch (error) {
    next(error);
  }
});

app.post("/v1/plugin-runtime/transform", async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    const user = token ? await getUserByToken(token) : undefined;
    if (!user) return res.status(401).json({ error: "invalid OpenLeash token" });
    const organizationId =
      user.organization_id ?? (await ensureDefaultOrganization()).id;
    const requestBody = req.body?.requestBody;
    if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
      return res.status(400).json({ error: "requestBody must be a JSON object" });
    }
    const provider = String(req.body?.provider ?? "unknown").trim() || "unknown";
    const agentKind = String(req.body?.agentKind ?? "unknown").trim() || "unknown";
    const agentId = await validatedAgentRuntimeId(
      user.id,
      agentKind,
      optionalString(req.body?.agentId),
    );
    const sessionId = String(req.body?.sessionId ?? "proxy").trim() || "proxy";
    const projectPath = optionalString(req.body?.projectPath);
    if (await isSessionMonitoringPaused(user, {
      agent: { kind: agentKind },
      event: { agentKind, sessionId },
    })) {
      return res.json({
        protocol: "openleash-container-plugin.v1",
        requestBody,
        appliedPluginIds: [],
        runs: [],
        monitoringPaused: true,
      });
    }
    const catalog = await pluginCatalogForOrganization(
      organizationId,
      user.id,
      { agentKind, agentId, projectPath },
    );
    const [config, tenantModelKey] = await Promise.all([
      readPromptTransformConfig(
        organizationId,
        user.id,
        agentKind,
        agentId,
        projectPath,
      ),
      tenantModelKeyForEvaluation(organizationId),
    ]);
    const result = await transformProviderRequestWithFeatures({
      requestBody: requestBody as Record<string, unknown>,
      config,
      plugins: new Map(catalog.plugins.map((feature) => [feature.id, feature.settings])),
      tenantModelKey,
      organizationId,
      userId: user.id,
      provider,
      agentKind,
      sessionId,
      projectPath,
      agentId,
    });
    res.json({
      protocol: "openleash-container-plugin.v1",
      runtime: "in-process",
      requestBody: result.requestBody,
      appliedPluginIds: result.appliedPluginIds,
      runs: result.runs,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/plugin-runtime/verify", async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    const user = token ? await getUserByToken(token) : undefined;
    if (!user) return res.status(401).json({ error: "invalid OpenLeash token" });
    const organizationId =
      user.organization_id ?? (await ensureDefaultOrganization()).id;
    const catalog = await pluginCatalogForOrganization(
      organizationId,
      user.id,
    );
    const plugins = catalog.plugins.filter((feature) => feature.settings.enabled);
    const results = verifyBuiltinFeatureRegistry(plugins);
    const failed = results.filter((result) => !result.protocolVerified);
    const body = {
      ok: failed.length === 0,
      plugins: results,
      verifiedAt: new Date().toISOString(),
      ...(failed.length > 0 ? {
        error: `Feature runtime verification failed for ${failed.map((item) => item.pluginId).join(", ")}.`,
      } : {}),
    };
    return res.status(failed.length > 0 ? 503 : 200).json(body);
  } catch (error) {
    next(error);
  }
});

app.post("/v1/plugin-runtime/tools/execute", async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    const user = token ? await getUserByToken(token) : undefined;
    if (!user) return res.status(401).json({ error: "invalid OpenLeash token" });
    const organizationId =
      user.organization_id ?? (await ensureDefaultOrganization()).id;
    const pluginId = String(req.body?.pluginId ?? "").trim();
    const tool = String(req.body?.tool ?? "").trim();
    const args = req.body?.arguments;
    if (!pluginId || !tool || !args || typeof args !== "object" || Array.isArray(args)) {
      return res.status(400).json({ error: "pluginId, tool, and object arguments are required" });
    }
    const agentKind = String(req.body?.agentKind ?? "unknown").trim() || "unknown";
    const agentId = await validatedAgentRuntimeId(
      user.id,
      agentKind,
      optionalString(req.body?.agentId),
    );
    const projectPath = optionalString(req.body?.projectPath);
    const catalog = await pluginCatalogForOrganization(
      organizationId,
      user.id,
      { agentKind, agentId, projectPath },
    );
    const plugin = catalog.plugins.find((candidate) => candidate.id === pluginId);
    if (!plugin) return res.status(404).json({ error: "enabled plugin not found" });
    return res.status(404).json({
      error: `The built-in Feature ${plugin.name} does not expose the legacy runtime tool ${tool}.`,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/hooks/:agent/:event", async (req, res, next) => {
  try {
    const token = tokenFromRequest(req);
    const user = token ? await getUserByToken(token) : undefined;
    if (!user)
      return res.status(401).json({ error: "invalid OpenLeash token" });
    const agent = req.params.agent as HookAgentSlug;
    const eventName = req.params.event as HookEventName;
    if (!LOCAL_HOOK_AGENT_METADATA[agent] || !isHookEventName(eventName)) {
      return res
        .status(400)
        .json({ error: "unsupported OpenLeash hook target" });
    }
    const activityAgent = attributedHookAgent(agent, req.body);
    const request = normalizeHookRequest(activityAgent, eventName, req.body, req.query);
    if (await isSessionMonitoringPaused(user, request)) {
      return res.json(nativeHookDecision(
        agent,
        eventName,
        sessionMonitoringPausedDecision(),
      ));
    }
    await writePipelineTrace("ingress.raw_hook", {
      source: "api_hook",
      provider: activityAgent,
      agent: request.agent.kind,
      event: eventName,
      sessionId: request.event.sessionId,
      payload: req.body,
      query: req.query,
    });
    const hookEnvelope = normalizeAgentEvent({
      source: "api_hook",
      provider: activityAgent,
      request,
    });
    await writePipelineTrace("pipeline.normalized_hook", {
      traceId: hookEnvelope.idempotencyKey,
      source: "api_hook",
      provider: activityAgent,
      agent: request.agent.kind,
      event: eventName,
      sessionId: request.event.sessionId,
      envelope: hookEnvelope,
    });
    if (
      process.env.OPENLEASH_LOCAL_PROXY_AUTHORITATIVE === "1" &&
      isPromptOnlyHook(request) &&
      LOCAL_PROXY_PROMPT_AGENTS.has(String(request.agent.kind).toLowerCase())
    ) {
      const handoff: EvaluationResponse = {
        decision: "allow",
        decisionId: `local-proxy-handoff:${hookEnvelope.idempotencyKey}`,
        summary:
          "Prompt hook handed off to the authoritative local-proxy evaluation path.",
        results: [],
      };
      await writePipelineTrace("pipeline.deferred_to_local_proxy", {
        traceId: hookEnvelope.idempotencyKey,
        source: "api_hook",
        agent: request.agent.kind,
        event: eventName,
        sessionId: request.event.sessionId,
        decision: "allow",
        authoritativeSource: "local_proxy",
      });
      return res.json(nativeHookDecision(agent, eventName, handoff));
    }
    const duplicate = await existingNormalizedEvent(
      user.id,
      hookEnvelope.idempotencyKey,
    );
    if (duplicate) {
      await writePipelineTrace("pipeline.deduplicated_hook", {
        traceId: hookEnvelope.idempotencyKey,
        source: "api_hook",
        agent: request.agent.kind,
        event: eventName,
        decision: duplicate.decision,
      });
      const effective = await effectiveRuntimeDecision(user, duplicate);
      return res.json(nativeHookDecision(agent, eventName, effective));
    }
    request.event.raw = attachEventEnvelope(request.event.raw, hookEnvelope);
    if (isPromptOnlyHook(request)) {
      const transformed = await deduplicateConcurrentNormalizedEvent(
        user.id,
        hookEnvelope.idempotencyKey,
        () => handlePromptOnlyHook(agent, eventName, request, user),
      );
      await writePipelineTrace("pipeline.final_hook", {
        traceId: hookEnvelope.idempotencyKey,
        source: "api_hook",
        agent: request.agent.kind,
        event: eventName,
        sessionId: request.event.sessionId,
        result: transformed,
      });
      return res.json(transformed);
    }
    const decision = await deduplicateConcurrentNormalizedEvent(
      user.id,
      hookEnvelope.idempotencyKey,
      () => evaluateAndRecord(request, user),
    );
    const resolvedDecision = await waitForHookDecision(user, decision);
    await writePipelineTrace("pipeline.final_hook", {
      traceId: hookEnvelope.idempotencyKey,
      source: "api_hook",
      agent: request.agent.kind,
      event: eventName,
      sessionId: request.event.sessionId,
      decision: resolvedDecision.decision,
      result: resolvedDecision,
    });
    res.json(nativeHookDecision(agent, eventName, resolvedDecision));
  } catch (error) {
    next(error);
  }
});

app.get("/admin/external-agents", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const connectors = await listExternalConnectors();
    const known = await pool.query(
      `select ar.id, ar.kind, ar.display_name, ar.version, ar.last_seen_at,
              c.hostname, u.display_name as user_name,
              latest.session_id, latest.created_at as latest_event_at,
              ev.id as latest_evaluation_id, ev.decision, ev.summary
       from agent_runtimes ar
       join computers c on c.id = ar.computer_id
       left join users u on u.id = c.user_id
       left join lateral (
         select ce.*
         from conversation_events ce
         where ce.agent_runtime_id = ar.id
         order by ce.created_at desc
         limit 1
       ) latest on true
       left join evaluations ev on ev.conversation_event_id = latest.id
       where ar.kind = any($1) and u.organization_id = $2
       order by greatest(ar.last_seen_at, coalesce(latest.created_at, ar.last_seen_at)) desc`,
      [EXTERNAL_PROVIDER_IDS, organizationId],
    );
    res.json({ connectors, known: known.rows });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/external-agents/sync", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const provider =
      typeof req.body?.provider === "string"
        ? (req.body.provider as ExternalProvider)
        : undefined;
    const conversations = await fetchConfiguredExternalConversations(provider);
    const user = await ensureExternalUser(organizationId, provider ?? "external-agents");
    const synced = [];
    const skipped = [];
    for (const conversation of conversations) {
      const key = externalEvaluationKey(conversation);
      if (await externalEventExists(organizationId, key)) {
        skipped.push({
          provider: conversation.provider,
          sessionId: conversation.sessionId,
          reason: "already synced",
        });
        continue;
      }
      const request = externalConversationToEvaluation(conversation);
      const envelope = normalizeAgentEvent({
        source: "provider_puller",
        provider: conversation.provider,
        request,
        idempotencyKey: key,
      });
      request.event.raw = attachEventEnvelope(request.event.raw, envelope);
      const response = await evaluateAndRecord(request, user);
      synced.push({
        provider: conversation.provider,
        sessionId: conversation.sessionId,
        decisionId: response.decisionId,
        decision: response.decision,
      });
    }
    res.json({ ok: true, synced, skipped, total: conversations.length });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/provider-usage", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const days = Math.max(1, Math.min(180, Number(req.query.days ?? 30) || 30));
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    res.json(await providerUsageOverview(organizationId, start));
  } catch (error) {
    next(error);
  }
});

app.get("/admin/provider-usage/connections", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    res.json({
      connections: await listProviderUsageConnections(organizationId),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/provider-usage/connections", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const provider = normalizeUsageProvider(req.body?.provider);
    const apiKey = String(req.body?.apiKey ?? "").trim();
    if (!provider)
      return res.status(400).json({
        ok: false,
        message: "provider must be cursor, openai, or anthropic",
      });
    if (!apiKey)
      return res.status(400).json({ ok: false, message: "apiKey is required" });
    const result = await upsertProviderUsageConnection({
      organizationId,
      provider,
      apiKey,
      label: typeof req.body?.label === "string" ? req.body.label : undefined,
      externalOrgId:
        typeof req.body?.externalOrgId === "string"
          ? req.body.externalOrgId
          : undefined,
    });
    if (!result.ok) return res.status(400).json(result);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/provider-usage/validate", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const provider = normalizeUsageProvider(req.body?.provider);
    if (!provider)
      return res.status(400).json({
        ok: false,
        message: "provider must be cursor, openai, or anthropic",
      });
    const result = await validateProviderConnection(organizationId, provider);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/provider-usage/budgets", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const provider = normalizeUsageProvider(req.body?.provider);
    const budget = await upsertProviderUsageBudget({
      organizationId,
      provider,
      monthlyBudgetCents: Number(req.body?.monthlyBudgetCents ?? 0),
    });
    res.json({ ok: true, budget });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/provider-usage/sync", async (req, res, next) => {
  let started: { rows: Array<{ id: string }> } | undefined;
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const provider = normalizeUsageProvider(req.body?.provider);
    started = await pool.query<{ id: string }>(
      `insert into provider_usage_sync_jobs (organization_id, provider, status, triggered_by)
       values ($1, $2, 'running', $3)
       returning id`,
      [
        organizationId,
        provider ?? null,
        typeof req.body?.triggeredBy === "string"
          ? req.body.triggeredBy
          : "manual",
      ],
    );
    const result = await syncProviderUsage(organizationId, provider);
    const records = result.synced.reduce((sum, item) => sum + item.events, 0);
    await pool.query(
      `update provider_usage_sync_jobs
       set status = $2, records = $3, error = $4, finished_at = now()
       where id = $1`,
      [
        started.rows[0].id,
        result.ok ? "completed" : "partial",
        records,
        result.failed
          .map((item) => `${item.provider}: ${item.error}`)
          .join("; ") || null,
      ],
    );
    res.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown sync error";
    if (started?.rows[0]?.id) {
      await pool.query(
        `update provider_usage_sync_jobs
         set status = 'failed', error = $2, finished_at = now()
         where id = $1`,
        [started.rows[0].id, message],
      );
    }
    next(error);
  }
});

app.post("/admin/evaluation-key", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    if (await organizationUsesManagedEvaluation(organizationId)) {
      return res.status(409).json({
        ok: false,
        error:
          "This organization uses OpenLeash-managed evaluation. Switch to a BYOK package before adding an evaluation key.",
      });
    }
    const provider = normalizeTenantModelProvider(
      req.body?.provider ?? req.body?.apiProvider,
    );
    const apiKey = String(req.body?.apiKey ?? "").trim();
    if (!provider)
      return res.status(400).json({
        ok: false,
        error: "provider must be openai, anthropic, or deepseek",
      });
    if (!apiKey)
      return res.status(400).json({ ok: false, error: "apiKey is required" });
    const result = await upsertTenantModelKey({
      organizationId,
      provider,
      apiKey,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/overview", async (req, res, next) => {
  try {
    const session = await getDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const dashboardRole = isDashboardAccessRole(session.user.role);
    const scopeParams = [
      session.organization.id,
      session.user.id,
      dashboardRole,
    ];
    const eventScope = `exists (
          select 1
          from computers scope_c
          where scope_c.id = ce.computer_id
            and scope_c.user_id is not null
            and exists (
              select 1
              from users scope_u
              where scope_u.id = scope_c.user_id
                and scope_u.organization_id = $1
            )
            and ($3::boolean or scope_c.user_id = $2)
        )`;
    const [
      metrics,
      sessionMetrics,
      agentSessions,
      usageSessions,
      agents,
      recent,
      policies,
      users,
    ] = await Promise.all([
      pool.query(
        `select
        (select count(*)
         from computers c
         join users u on u.id = c.user_id
         where u.organization_id = $1 and ($3::boolean or c.user_id = $2)) as computers,
        (select count(*)
         from agent_runtimes ar
         join computers c on c.id = ar.computer_id
         join users u on u.id = c.user_id
         where u.organization_id = $1 and ($3::boolean or c.user_id = $2) and ar.kind not in ('openclaw', 'nanoclaw')) as agents,
        (select count(*)
         from conversation_events ce
         join computers c on c.id = ce.computer_id
         join users u on u.id = c.user_id
         where u.organization_id = $1 and ($3::boolean or c.user_id = $2) and ce.created_at > now() - interval '30 days') as events,
        (select count(*)
         from evaluations e
         join conversation_events ce on ce.id = e.conversation_event_id
         join computers c on c.id = ce.computer_id
         join users u on u.id = c.user_id
         where u.organization_id = $1 and ($3::boolean or c.user_id = $2) and e.decision = 'deny' and e.created_at > now() - interval '30 days') as denied,
        (select count(*)
         from evaluations e
         join conversation_events ce on ce.id = e.conversation_event_id
         join computers c on c.id = ce.computer_id
         join users u on u.id = c.user_id
         where u.organization_id = $1 and ($3::boolean or c.user_id = $2) and e.decision = 'ask' and e.created_at > now() - interval '30 days') as questions`,
        scopeParams,
      ),
      dashboardSessionMetrics(eventScope, scopeParams),
      dashboardAgentSessions(eventScope, scopeParams),
      dashboardUsageSessions(eventScope, scopeParams),
      pool.query(
        `select ar.*, c.hostname, u.display_name as user_name
        from agent_runtimes ar
        join computers c on c.id = ar.computer_id
        left join users u on u.id = c.user_id
        where ar.kind not in ('openclaw', 'nanoclaw')
          and u.organization_id = $1
          and ($3::boolean or c.user_id = $2)
        order by ar.last_seen_at desc limit 20`,
        scopeParams,
      ),
      pool.query(
        `select e.id, e.decision, e.resolution, e.summary, e.question, e.created_at, ce.event_name, ce.tool_name, ce.project_path, ce.prompt,
          ar.kind as agent_kind, ar.display_name as agent_name, c.hostname, u.display_name as user_name,
          coalesce(triggered.items, '[]'::jsonb) as triggered_policies
        from evaluations e
        join conversation_events ce on ce.id = e.conversation_event_id
        join agent_runtimes ar on ar.id = ce.agent_runtime_id
        join computers c on c.id = ce.computer_id
        left join users u on u.id = e.user_id
        left join lateral (
          select jsonb_agg(
            jsonb_build_object(
              'policy_name', pr.policy_name,
              'status', pr.status,
              'severity', pr.severity,
              'explanation', pr.explanation,
              'evidence', pr.evidence
            )
            order by pr.created_at asc
          ) as items
          from policy_results pr
          where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
        ) triggered on true
        where (
          e.decision in ('ask', 'deny')
          or e.resolution = 'deny'
          or exists (
            select 1 from policy_results pr
            where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
          )
        )
          and exists (
            select 1
            from users scope_u
            where scope_u.id = c.user_id
              and scope_u.organization_id = $1
          )
          and ($3::boolean or c.user_id = $2)
        order by e.created_at desc limit 30`,
        scopeParams,
      ),
      pool.query(
        policyInventorySql(
          "u.organization_id = $1 and ($3::boolean or e.user_id = $2)",
        ),
        scopeParams,
      ),
      pool.query(
        `select u.id, u.email, u.display_name, u.role, u.created_at,
          u.department, u.title as hr_title, u.idp_provider, u.status,
          count(distinct c.id) as endpoint_count,
          count(distinct ar.id) filter (where ar.kind not in ('openclaw', 'nanoclaw')) as agent_count,
          max(greatest(c.last_seen_at, coalesce(ar.last_seen_at, c.last_seen_at))) as last_seen_at,
          coalesce(jsonb_agg(distinct ar.display_name) filter (where ar.id is not null and ar.kind not in ('openclaw', 'nanoclaw')), '[]'::jsonb) as agents,
          coalesce(jsonb_agg(distinct c.hostname) filter (where c.id is not null), '[]'::jsonb) as hostnames,
          coalesce(jsonb_agg(distinct jsonb_build_object(
            'id', c.id,
            'hostname', c.hostname,
            'platform', c.platform,
            'osRelease', c.os_release,
            'lastSeenAt', c.last_seen_at
          )) filter (where c.id is not null), '[]'::jsonb) as devices
        from users u
        left join computers c on c.user_id = u.id
        left join agent_runtimes ar on ar.computer_id = c.id
        where u.organization_id = $1
          and ($3::boolean or u.id = $2)
        group by u.id
        order by u.display_name asc`,
        scopeParams,
      ),
    ]);
    res.json({
      metrics: { ...metrics.rows[0], session_time: sessionMetrics.rows[0] },
      agents: agents.rows.map((agent) => ({
        ...agent,
        sessions: agentSessions.rows
          .filter((session) => session.agent_runtime_id === agent.id)
          .slice(0, 8),
      })),
      recent: recent.rows,
      policies: policies.rows,
      users: users.rows,
      usage: { sessions: usageSessions.rows },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/security", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const days = Math.max(1, Math.min(180, Number(req.query.days ?? 30) || 30));
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [
      summary,
      signals,
      byPlugin,
      byUser,
      usageByPlugin,
      usageByUser,
      correlations,
    ] = await Promise.all([
      pool.query(
        `select
           count(*)::int as total_signals,
           count(*) filter (where kind = 'security.finding')::int as findings,
           count(*) filter (where severity in ('high', 'critical'))::int as high_severity,
           count(*) filter (where decision in ('blocked', 'deny', 'ask'))::int as contained,
           count(distinct user_id)::int as affected_users
         from plugin_signals
         where organization_id = $1 and created_at >= $2`,
        [organizationId, start],
      ),
      pool.query(
        `select ps.id, ps.plugin_id, ps.kind, ps.severity, ps.title, ps.summary, ps.decision, ps.status,
                ps.target, ps.details, ps.correlation_keys, ps.occurred_at, ps.created_at,
                u.id as user_id, u.email as user_email, u.display_name as user_name,
                c.hostname, ar.kind as agent_kind, ar.display_name as agent_name,
                ce.event_name, ce.tool_name, ce.project_path, e.id as evaluation_id,
                e.resolution as evaluation_resolution
         from plugin_signals ps
         left join users u on u.id = ps.user_id
         left join computers c on c.id = ps.computer_id
         left join agent_runtimes ar on ar.id = ps.agent_runtime_id
         left join conversation_events ce on ce.id = ps.conversation_event_id
         left join evaluations e on e.conversation_event_id = ce.id
         where ps.organization_id = $1 and ps.created_at >= $2
         order by ps.created_at desc
         limit 100`,
        [organizationId, start],
      ),
      pool.query(
        `select plugin_id, kind, severity, count(*)::int as count
         from plugin_signals
         where organization_id = $1 and created_at >= $2
         group by plugin_id, kind, severity
         order by count desc, plugin_id asc`,
        [organizationId, start],
      ),
      pool.query(
        `select u.id as user_id, u.email, u.display_name as name,
                count(*)::int as signal_count,
                count(*) filter (where ps.severity in ('high', 'critical'))::int as high_count,
                max(ps.created_at) as last_signal_at
         from plugin_signals ps
         left join users u on u.id = ps.user_id
         where ps.organization_id = $1 and ps.created_at >= $2
         group by u.id, u.email, u.display_name
         order by high_count desc, signal_count desc
         limit 25`,
        [organizationId, start],
      ),
      pool.query(
        `select plugin_id, kind, coalesce(provider, 'plugin') as provider, coalesce(model, '') as model,
                count(*)::int as records,
                coalesce(sum(input_tokens), 0)::int as input_tokens,
                coalesce(sum(output_tokens), 0)::int as output_tokens,
                coalesce(sum(saved_tokens), 0)::int as saved_tokens,
                coalesce(sum(estimated_cost_cents), 0)::int as estimated_cost_cents
         from plugin_usage_records
         where organization_id = $1 and created_at >= $2
         group by plugin_id, kind, provider, model
         order by estimated_cost_cents desc, records desc
         limit 50`,
        [organizationId, start],
      ),
      pool.query(
        `select u.id as user_id, u.email, u.display_name as name,
                count(pur.*)::int as records,
                coalesce(sum(pur.input_tokens), 0)::int as input_tokens,
                coalesce(sum(pur.output_tokens), 0)::int as output_tokens,
                coalesce(sum(pur.saved_tokens), 0)::int as saved_tokens,
                coalesce(sum(pur.estimated_cost_cents), 0)::int as estimated_cost_cents,
                max(pur.created_at) as last_usage_at
         from plugin_usage_records pur
         left join users u on u.id = pur.user_id
         where pur.organization_id = $1 and pur.created_at >= $2
         group by u.id, u.email, u.display_name
         order by estimated_cost_cents desc, records desc
         limit 25`,
        [organizationId, start],
      ),
      pool.query(
        `select key as correlation_key,
                count(*)::int as signal_count,
                count(distinct plugin_id)::int as plugin_count,
                count(distinct user_id)::int as user_count,
                max(created_at) as last_signal_at,
                array_agg(distinct plugin_id) as plugin_ids
         from plugin_signals ps, unnest(ps.correlation_keys) as key
         where ps.organization_id = $1 and ps.created_at >= $2
         group by key
         having count(*) > 1 or count(distinct plugin_id) > 1
         order by plugin_count desc, signal_count desc, last_signal_at desc
         limit 30`,
        [organizationId, start],
      ),
    ]);
    res.json({
      range: { days, since: start.toISOString() },
      summary: summary.rows[0] ?? {},
      signals: signals.rows,
      byPlugin: byPlugin.rows,
      byUser: byUser.rows,
      usage: {
        byPlugin: usageByPlugin.rows,
        byUser: usageByUser.rows,
      },
      correlations: correlations.rows,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/outcomes", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const days = Math.max(1, Math.min(365, Number(req.query.days ?? 30) || 30));
    const limit = Math.max(
      1,
      Math.min(200, Number(req.query.limit ?? 80) || 80),
    );
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const domain = normalizeOutcomeDomain(req.query.domain);
    const severity = normalizeOutcomeSeverity(req.query.severity);
    const search = String(req.query.search ?? "").trim();
    const params: unknown[] = [organizationId, start];
    const where = ["ps.organization_id = $1", "ps.created_at >= $2"];
    if (domain) {
      params.push(kindsForOutcomeDomain(domain));
      where.push(`ps.kind = any($${params.length}::text[])`);
    }
    if (severity) {
      params.push(severity);
      where.push(`ps.severity = $${params.length}`);
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where.push(`(
        lower(ps.title) like $${params.length}
        or lower(coalesce(ps.summary, '')) like $${params.length}
        or lower(ps.plugin_id) like $${params.length}
        or lower(coalesce(u.email, '')) like $${params.length}
        or lower(coalesce(u.display_name, '')) like $${params.length}
        or lower(coalesce(ce.project_path, '')) like $${params.length}
      )`);
    }
    params.push(limit);
    const limitIndex = params.length;
    const rows = await pool.query(
      `select ps.id, ps.organization_id, ps.plugin_id, ps.kind, ps.severity, ps.title, ps.summary,
              ps.decision, ps.status, ps.target, ps.evidence, ps.details, ps.correlation_keys,
              ps.conversation_event_id, ps.user_id, ps.computer_id, ps.agent_runtime_id,
              ps.occurred_at, ps.created_at,
              o.slug as organization_slug,
              u.email as user_email, u.display_name as user_name,
              c.hostname, ar.kind as agent_kind, ar.display_name as agent_name,
              ce.event_name, ce.tool_name, ce.project_path, e.id as evaluation_id,
              e.resolution as evaluation_resolution
       from plugin_signals ps
       left join organizations o on o.id = ps.organization_id
       left join users u on u.id = ps.user_id
       left join computers c on c.id = ps.computer_id
       left join agent_runtimes ar on ar.id = ps.agent_runtime_id
       left join conversation_events ce on ce.id = ps.conversation_event_id
       left join evaluations e on e.conversation_event_id = ce.id
       where ${where.join(" and ")}
       order by ps.created_at desc
       limit $${limitIndex}`,
      params,
    );
    const outcomes = rows.rows.map(signalRowToOutcome);
    const summary = outcomeSummary(outcomes);
    const { plugins } = await pluginCatalogForOrganization(organizationId);
    res.json({
      range: { days, since: start.toISOString() },
      summary,
      outcomes,
      viewModel: buildOpenLeashClientViewModel({
        plugins,
        outcomes,
        summary,
        shellSections: [
          "overview",
          "agents",
          "activity",
          "approvals",
          "policies",
          "settings",
          "identity",
        ],
      }),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/outcomes", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const days = Math.max(1, Math.min(365, Number(req.query.days ?? 30) || 30));
    const limit = Math.max(
      1,
      Math.min(50, Number(req.query.limit ?? 20) || 20),
    );
    const page = Math.max(1, Math.floor(Number(req.query.page ?? 1) || 1));
    const agentKind = optionalString(req.query.agentKind);
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const params: unknown[] = [session.organization.id, session.user.id, start];
    const filters = [
      "ps.organization_id = $1",
      "ps.user_id = $2",
      "ps.created_at >= $3",
    ];
    if (agentKind) {
      params.push(agentKind);
      filters.push(`ar.kind = $${params.length}`);
    }
    params.push(limit + 1);
    const limitIndex = params.length;
    params.push((page - 1) * limit);
    const offsetIndex = params.length;
    const rows = await pool.query(
      `select ps.id, ps.organization_id, ps.plugin_id, ps.kind, ps.severity, ps.title, ps.summary,
              ps.decision, ps.status, ps.target, ps.evidence, ps.details, ps.correlation_keys,
              ps.conversation_event_id, ps.user_id, ps.computer_id, ps.agent_runtime_id,
              ps.occurred_at, ps.created_at,
              o.slug as organization_slug,
              u.email as user_email, u.display_name as user_name,
              c.hostname, ar.kind as agent_kind, ar.display_name as agent_name,
              ce.event_name, ce.tool_name, ce.project_path, e.id as evaluation_id,
              e.resolution as evaluation_resolution
       from plugin_signals ps
       left join organizations o on o.id = ps.organization_id
       left join users u on u.id = ps.user_id
       left join computers c on c.id = ps.computer_id
       left join agent_runtimes ar on ar.id = ps.agent_runtime_id
       left join conversation_events ce on ce.id = ps.conversation_event_id
       left join evaluations e on e.conversation_event_id = ce.id
       where ${filters.join(" and ")}
       order by ps.created_at desc, ps.id desc
       limit $${limitIndex}
       offset $${offsetIndex}`,
      params,
    );
    const hasMore = rows.rows.length > limit;
    const outcomes = rows.rows.slice(0, limit).map(signalRowToOutcome);
    const summary = outcomeSummary(outcomes);
    const includeViewModel = String(req.query.viewModel ?? "1") !== "0";
    const plugins = includeViewModel
      ? (await pluginCatalogForOrganization(session.organization.id, session.user.id)).plugins
      : [];
    res.json({
      range: { days, since: start.toISOString() },
      pagination: {
        page,
        limit,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
      },
      summary,
      outcomes,
      ...(includeViewModel ? { viewModel: buildOpenLeashClientViewModel({ plugins, outcomes, summary }) } : {}),
    });
  } catch (error) {
    next(error);
  }
});

function signalRowToOutcome(row: any): OpenLeashOutcomeRecord {
  const domain = outcomeDomainForSignal(row.kind, row.plugin_id);
  const finalDecision = outcomeDecisionForSignal(
    row.evaluation_resolution,
    row.decision,
  );
  return {
    id: String(row.id),
    domain,
    title: String(row.title ?? outcomeDomainLabel(domain)),
    summary: row.summary ?? null,
    severity: normalizeSignalSeverity(row.severity),
    status: outcomeStatusForSignal(row.status, finalDecision, row.kind),
    decision: finalDecision,
    occurredAt: new Date(
      row.occurred_at ?? row.created_at ?? Date.now(),
    ).toISOString(),
    createdAt: new Date(row.created_at ?? Date.now()).toISOString(),
    source: {
      pluginId: String(row.plugin_id ?? "openleash"),
      label: outcomeSourceLabel(row.plugin_id),
      kind: row.kind,
    },
    subject: normalizeOutcomeSubject(row.target),
    actor: {
      userId: row.user_id ?? null,
      name: row.user_name ?? null,
      email: row.user_email ?? null,
    },
    agent: {
      kind: row.agent_kind ?? null,
      name: row.agent_name ?? null,
      hostname: row.hostname ?? null,
    },
    context: {
      organizationId: row.organization_id,
      organizationSlug: row.organization_slug,
      conversationEventId: row.conversation_event_id ?? null,
      evaluationId: row.evaluation_id ?? null,
      eventName: row.event_name ?? null,
      toolName: row.tool_name ?? null,
      projectPath: row.project_path ?? null,
      correlationKeys: Array.isArray(row.correlation_keys)
        ? row.correlation_keys
        : [],
    },
    evidence: normalizeOutcomeEvidence(row.evidence),
    details: row.details && typeof row.details === "object" ? row.details : {},
  };
}

function outcomeSummary(outcomes: OpenLeashOutcomeRecord[]) {
  return {
    total: outcomes.length,
    highSeverity: outcomes.filter(
      (item) => item.severity === "high" || item.severity === "critical",
    ).length,
    blocked: outcomes.filter(
      (item) =>
        item.status === "blocked" ||
        item.decision === "blocked" ||
        item.decision === "deny",
    ).length,
    needsReview: outcomes.filter(
      (item) => item.status === "needs_review" || item.decision === "ask",
    ).length,
    byDomain: outcomes.reduce<Record<string, number>>((acc, item) => {
      acc[item.domain] = (acc[item.domain] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

async function userPluginOutcomes(
  organizationId: string,
  userId: string,
  options: { days?: number; limit?: number } = {},
) {
  const days = Math.max(1, Math.min(365, Number(options.days ?? 30) || 30));
  const limit = Math.max(1, Math.min(100, Number(options.limit ?? 40) || 40));
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await pool.query(
    `select ps.id, ps.organization_id, ps.plugin_id, ps.kind, ps.severity, ps.title, ps.summary,
            ps.decision, ps.status, ps.target, ps.evidence, ps.details, ps.correlation_keys,
            ps.conversation_event_id, ps.user_id, ps.computer_id, ps.agent_runtime_id,
            ps.occurred_at, ps.created_at,
            o.slug as organization_slug,
            u.email as user_email, u.display_name as user_name,
            c.hostname, ar.kind as agent_kind, ar.display_name as agent_name,
            ce.event_name, ce.tool_name, ce.project_path, e.id as evaluation_id,
            e.resolution as evaluation_resolution
     from plugin_signals ps
     left join organizations o on o.id = ps.organization_id
     left join users u on u.id = ps.user_id
     left join computers c on c.id = ps.computer_id
     left join agent_runtimes ar on ar.id = ps.agent_runtime_id
     left join conversation_events ce on ce.id = ps.conversation_event_id
     left join evaluations e on e.conversation_event_id = ce.id
     where ps.organization_id = $1
       and ps.user_id = $2
       and ps.created_at >= $3
     order by ps.created_at desc
     limit $4`,
    [organizationId, userId, start, limit],
  );
  return {
    range: { days, since: start.toISOString() },
    outcomes: rows.rows.map(signalRowToOutcome),
  };
}

function outcomeDomainForSignal(
  kind: string,
  pluginId?: string,
): OpenLeashOutcomeDomain {
  if (kind === "secret.detected" || pluginId === "openleash.dlp")
    return "data_protection";
  if (
    kind === "tool.risk" ||
    kind === "mcp.discovery" ||
    pluginId === "openleash.mcp-scanner"
  )
    return "tool_risk";
  if (kind === "identity.risk") return "identity";
  if (kind === "export.status" || kind === "plugin.health") return "operations";
  if (
    kind === "policy.decision" ||
    kind === "security.finding" ||
    pluginId === "openleash.rules-enforcer" ||
    pluginId === "openleash.skill-scanner"
  )
    return "security";
  return "compliance";
}

function kindsForOutcomeDomain(domain: OpenLeashOutcomeDomain) {
  if (domain === "data_protection") return ["secret.detected"];
  if (domain === "tool_risk") return ["tool.risk", "mcp.discovery"];
  if (domain === "identity") return ["identity.risk"];
  if (domain === "operations")
    return ["plugin.health", "export.status", "audit.event"];
  if (domain === "security") return ["security.finding", "policy.decision"];
  return [
    "security.finding",
    "policy.decision",
    "approval.event",
    "audit.event",
  ];
}

function normalizeOutcomeDomain(
  value: unknown,
): OpenLeashOutcomeDomain | undefined {
  const normalized = String(value ?? "").trim();
  return [
    "security",
    "data_protection",
    "tool_risk",
    "identity",
    "cost",
    "productivity",
    "compliance",
    "operations",
  ].includes(normalized)
    ? (normalized as OpenLeashOutcomeDomain)
    : undefined;
}

function normalizeOutcomeSeverity(value: unknown) {
  const normalized = String(value ?? "").trim();
  return ["info", "low", "medium", "high", "critical"].includes(normalized)
    ? normalized
    : undefined;
}

function normalizeSignalSeverity(value: unknown) {
  const normalized = String(value ?? "").trim();
  return ["info", "low", "medium", "high", "critical"].includes(normalized)
    ? (normalized as OpenLeashOutcomeRecord["severity"])
    : "info";
}

function outcomeStatusForSignal(
  status: unknown,
  decision: unknown,
  kind: string,
): OpenLeashOutcomeStatus {
  const statusText = String(status ?? "").toLowerCase();
  const decisionText = String(decision ?? "").toLowerCase();
  if (statusText === "masked") return "masked";
  if (
    statusText === "blocked" ||
    decisionText === "blocked" ||
    decisionText === "deny" ||
    decisionText === "rejected"
  )
    return "blocked";
  if (decisionText === "approved") return "passed";
  if (statusText === "failed") return "failed";
  if (statusText === "needs_question" || decisionText === "ask")
    return "needs_review";
  if (statusText === "modified") return "modified";
  if (kind === "policy.decision" && !statusText) return "passed";
  return "observed";
}

function outcomeDecisionForSignal(
  resolution: unknown,
  decision: unknown,
): OpenLeashOutcomeRecord["decision"] {
  const resolved = String(resolution ?? "").toLowerCase();
  if (resolved === "allow") return "approved";
  if (resolved === "deny") return "rejected";
  const initial = String(decision ?? "").toLowerCase();
  if (
    ["allow", "ask", "deny", "blocked", "approved", "rejected", "observed"].includes(
      initial,
    )
  ) {
    return initial as OpenLeashOutcomeRecord["decision"];
  }
  return null;
}

function normalizeOutcomeSubject(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const target = value as Record<string, unknown>;
  return {
    type: typeof target.type === "string" ? target.type : undefined,
    name: typeof target.name === "string" ? target.name : undefined,
    id: typeof target.id === "string" ? target.id : undefined,
  };
}

function normalizeOutcomeEvidence(
  value: unknown,
): OpenLeashOutcomeRecord["evidence"] {
  const evidence = Array.isArray(value) ? value : [];
  return evidence.slice(0, 12).map((item, index) => {
    if (typeof item === "string")
      return {
        label: `Evidence ${index + 1}`,
        value: item,
        kind: "text" as const,
      };
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const label = String(
        record.category ??
          record.label ??
          record.reason ??
          `Evidence ${index + 1}`,
      );
      const value =
        record.quote ??
        record.value ??
        record.text ??
        record.path ??
        record.name ??
        record.reason;
      return {
        label,
        value: value === undefined ? undefined : String(value),
        kind: record.path ? ("path" as const) : ("text" as const),
        sensitive: Boolean(record.sensitive),
      };
    }
    return {
      label: `Evidence ${index + 1}`,
      value: String(item),
      kind: "text" as const,
    };
  });
}

function outcomeSourceLabel(pluginId?: string | null) {
  return canonicalPluginSlug(pluginId);
}

function outcomeDomainLabel(domain: OpenLeashOutcomeDomain) {
  if (domain === "data_protection") return "Data protection";
  if (domain === "tool_risk") return "Tool risk";
  return domain.charAt(0).toUpperCase() + domain.slice(1);
}

function dashboardSessionMetrics(whereClause = "true", params: unknown[] = []) {
  return pool.query(
    `with sessions as (
       select ce.agent_runtime_id,
              ce.session_id,
              coalesce(ce.project_path, '') as project_path_key,
              min(ce.created_at) as started_at,
              max(ce.created_at) as last_activity_at,
              greatest(0, extract(epoch from max(ce.created_at) - min(ce.created_at)))::int as duration_seconds
       from conversation_events ce
       where ${whereClause}
       group by ce.agent_runtime_id, ce.session_id, coalesce(ce.project_path, '')
     )
     select
       coalesce(sum(duration_seconds) filter (where last_activity_at >= date_trunc('day', now())), 0)::int as today_seconds,
       count(*) filter (where last_activity_at >= date_trunc('day', now()))::int as today_sessions,
       coalesce(sum(duration_seconds) filter (where last_activity_at >= now() - interval '24 hours'), 0)::int as last24h_seconds,
       count(*) filter (where last_activity_at >= now() - interval '24 hours')::int as last24h_sessions,
       coalesce(sum(duration_seconds) filter (where last_activity_at >= now() - interval '7 days'), 0)::int as week_seconds,
       count(*) filter (where last_activity_at >= now() - interval '7 days')::int as week_sessions,
       coalesce(sum(duration_seconds) filter (where last_activity_at >= now() - interval '30 days'), 0)::int as month_seconds,
       count(*) filter (where last_activity_at >= now() - interval '30 days')::int as month_sessions
     from sessions`,
    params,
  );
}

function dashboardAgentSessions(whereClause = "true", params: unknown[] = []) {
  return pool.query(
    `with session_groups as (
       select ce.agent_runtime_id,
              ce.session_id,
              coalesce(ce.project_path, '') as project_path_key,
              min(ce.created_at) as started_at,
              max(ce.created_at) as last_activity_at,
              greatest(0, extract(epoch from max(ce.created_at) - min(ce.created_at)))::int as duration_seconds,
              count(*)::int as event_count,
              count(e.id) filter (where e.decision = 'ask')::int as approval_count,
              count(e.id) filter (where e.decision = 'deny' or e.resolution = 'deny')::int as denied_count
       from conversation_events ce
       left join evaluations e on e.conversation_event_id = ce.id
       where ${whereClause}
       group by ce.agent_runtime_id, ce.session_id, coalesce(ce.project_path, '')
       order by max(ce.created_at) desc
       limit 200
     )
     select sg.agent_runtime_id,
            concat(sg.agent_runtime_id, ':', sg.session_id, ':', sg.project_path_key) as id,
            sg.session_id,
            nullif(sg.project_path_key, '') as project_path,
            sg.started_at,
            sg.last_activity_at,
            sg.duration_seconds,
            sg.event_count,
            sg.approval_count,
            sg.denied_count,
            coalesce(title_item.title, 'Agent session') as title,
            concat_ws(' · ',
              sg.event_count::text || case when sg.event_count = 1 then ' event' else ' events' end,
              case when sg.approval_count > 0 then sg.approval_count::text || case when sg.approval_count = 1 then ' approval' else ' approvals' end end,
              case when sg.denied_count > 0 then sg.denied_count::text || ' denied' end
            ) as summary
     from session_groups sg
     left join lateral (
       select left(regexp_replace(coalesce(ce.prompt, e.summary, ce.tool_name, ce.event_name, 'Agent session'), '\\s+', ' ', 'g'), 64) as title
       from conversation_events ce
       left join evaluations e on e.conversation_event_id = ce.id
       where ce.agent_runtime_id = sg.agent_runtime_id
         and ce.session_id = sg.session_id
         and coalesce(ce.project_path, '') = sg.project_path_key
       order by case when ce.prompt is not null and length(ce.prompt) > 0 then 0 else 1 end, ce.created_at desc
       limit 1
     ) title_item on true
     order by sg.last_activity_at desc`,
    params,
  );
}

function dashboardUsageSessions(whereClause = "true", params: unknown[] = []) {
  return pool.query(usageSessionsSql(whereClause, params, "limit 500"));
}

function usageSessionsSql(
  whereClause: string,
  params: unknown[],
  limitClause: string,
) {
  return {
    text: `with session_groups as (
       select ce.agent_runtime_id,
              ce.session_id,
              coalesce(ce.project_path, '') as project_path_key,
              min(ce.created_at) as started_at,
              max(ce.created_at) as last_activity_at,
              greatest(0, extract(epoch from max(ce.created_at) - min(ce.created_at)))::int as duration_seconds,
              count(*)::int as event_count,
              count(e.id) filter (where e.decision = 'ask')::int as approval_count,
              count(e.id) filter (where e.decision = 'deny' or e.resolution = 'deny')::int as denied_count,
              max(ce.user_id::text) as user_id,
              max(ce.computer_id::text) as computer_id
       from conversation_events ce
       left join evaluations e on e.conversation_event_id = ce.id
       where ${whereClause}
       group by ce.agent_runtime_id, ce.session_id, coalesce(ce.project_path, '')
     ),
     subagent_events as (
       select ce.agent_runtime_id,
              ce.session_id,
              coalesce(ce.project_path, '') as project_path_key,
              ce.created_at,
              ce.event_name,
              coalesce(ce.payload->>'agent_id', ce.payload->>'agentId', ce.payload->>'subagent_id', ce.payload->>'subagentId', ce.payload->>'thread_id', ce.payload->>'threadId') as subagent_id
       from conversation_events ce
       where ${whereClause}
         and ce.event_name in ('SubagentStart', 'SubagentStop')
     ),
     subagent_pairs as (
       select start_event.agent_runtime_id,
              start_event.session_id,
              start_event.project_path_key,
              start_event.subagent_id,
              start_event.created_at as started_at,
              (
                select min(stop_event.created_at)
                from subagent_events stop_event
                where stop_event.agent_runtime_id = start_event.agent_runtime_id
                  and stop_event.session_id = start_event.session_id
                  and stop_event.project_path_key = start_event.project_path_key
                  and stop_event.subagent_id = start_event.subagent_id
                  and stop_event.event_name = 'SubagentStop'
                  and stop_event.created_at >= start_event.created_at
              ) as stopped_at
       from subagent_events start_event
       where start_event.event_name = 'SubagentStart'
         and start_event.subagent_id is not null
     ),
     subagent_totals as (
       select agent_runtime_id,
              session_id,
              project_path_key,
              count(*)::int as subagent_count,
              coalesce(sum(greatest(0, extract(epoch from coalesce(stopped_at, started_at) - started_at))), 0)::int as subagent_seconds
       from subagent_pairs
       group by agent_runtime_id, session_id, project_path_key
     )
     select concat(sg.agent_runtime_id, ':', sg.session_id, ':', sg.project_path_key) as id,
            sg.agent_runtime_id,
            sg.session_id,
            nullif(sg.project_path_key, '') as project_path,
            sg.started_at,
            sg.last_activity_at,
            sg.duration_seconds,
            coalesce(st.subagent_count, 0)::int as subagent_count,
            coalesce(st.subagent_seconds, 0)::int as subagent_seconds,
            greatest(0, sg.duration_seconds - coalesce(st.subagent_seconds, 0))::int as orchestrator_seconds,
            sg.event_count,
            sg.approval_count,
            sg.denied_count,
            u.id as user_id,
            u.email as user_email,
            u.display_name as user_name,
            c.hostname,
            ar.kind as agent_kind,
            ar.display_name as agent_name,
            coalesce(title_item.title, 'Agent session') as title,
            concat_ws(' · ',
              sg.event_count::text || case when sg.event_count = 1 then ' event' else ' events' end,
              case when sg.approval_count > 0 then sg.approval_count::text || case when sg.approval_count = 1 then ' approval' else ' approvals' end end,
              case when sg.denied_count > 0 then sg.denied_count::text || ' denied' end,
              case when coalesce(st.subagent_seconds, 0) > 0 then 'subagents ' || coalesce(st.subagent_seconds, 0)::text || 's' end
            ) as summary
     from session_groups sg
     join agent_runtimes ar on ar.id = sg.agent_runtime_id
     left join users u on u.id = sg.user_id::uuid
     left join computers c on c.id = sg.computer_id::uuid
     left join subagent_totals st on st.agent_runtime_id = sg.agent_runtime_id and st.session_id = sg.session_id and st.project_path_key = sg.project_path_key
     left join lateral (
       select left(regexp_replace(coalesce(ce.prompt, e.summary, ce.tool_name, ce.event_name, 'Agent session'), '\\s+', ' ', 'g'), 72) as title
       from conversation_events ce
       left join evaluations e on e.conversation_event_id = ce.id
       where ce.agent_runtime_id = sg.agent_runtime_id
         and ce.session_id = sg.session_id
         and coalesce(ce.project_path, '') = sg.project_path_key
       order by case when ce.prompt is not null and length(ce.prompt) > 0 then 0 else 1 end, ce.created_at desc
       limit 1
     ) title_item on true
     order by sg.last_activity_at desc
     ${limitClause}`,
    values: params,
  };
}

app.get("/admin/mcp-servers", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const servers = await pool.query(
      `select s.id, s.server_name, s.first_seen_at, s.last_seen_at, s.tool_count, s.call_count,
              count(distinct c.user_id) as user_count,
              coalesce(jsonb_agg(distinct jsonb_build_object('tool_name', c.tool_name)) filter (where c.tool_name is not null), '[]'::jsonb) as tools,
              coalesce(jsonb_agg(distinct jsonb_build_object('id', u.id, 'name', u.display_name, 'email', u.email)) filter (where u.id is not null), '[]'::jsonb) as users,
              coalesce(recent.items, '[]'::jsonb) as recent_calls
       from mcp_servers s
       left join mcp_tool_calls c on c.mcp_server_id = s.id
       left join users u on u.id = c.user_id and u.organization_id = $1
       left join lateral (
         select jsonb_agg(jsonb_build_object(
           'id', rc.id,
           'tool_name', rc.tool_name,
           'argument_summary', rc.argument_summary,
           'project_path', rc.project_path,
           'decision', rc.decision,
           'risk_level', rc.risk_level,
           'occurred_at', rc.occurred_at,
           'agent_name', ar.display_name,
           'hostname', comp.hostname,
           'user_name', ru.display_name
         ) order by rc.occurred_at desc) as items
         from (
           select *
           from mcp_tool_calls
           where mcp_server_id = s.id
             and exists (select 1 from users scoped_user where scoped_user.id = mcp_tool_calls.user_id and scoped_user.organization_id = $1)
           order by occurred_at desc
           limit 5
         ) rc
         left join agent_runtimes ar on ar.id = rc.agent_runtime_id
         left join computers comp on comp.id = rc.computer_id
         left join users ru on ru.id = rc.user_id
       ) recent on true
       where exists (
         select 1 from mcp_tool_calls scoped_call
         join users scoped_user on scoped_user.id = scoped_call.user_id
         where scoped_call.mcp_server_id = s.id and scoped_user.organization_id = $1
       )
       group by s.id, recent.items
       order by s.last_seen_at desc
       limit 250`,
      [organizationId],
    );
    res.json({ servers: servers.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/mcp-servers/:id", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const [server, calls] = await Promise.all([
      pool.query(
        `select s.id, s.server_name, s.first_seen_at, s.last_seen_at, s.tool_count, s.call_count,
                count(distinct c.user_id) as user_count
         from mcp_servers s
         left join mcp_tool_calls c on c.mcp_server_id = s.id
         where s.id = $1 and u.organization_id = $2
         group by s.id`,
        [req.params.id, organizationId],
      ),
      pool.query(
        `select c.id, c.server_name, c.tool_name, c.full_tool_name, c.arguments, c.argument_summary,
                c.project_path, c.session_id, c.decision, c.resolution, c.risk_level, c.occurred_at, c.created_at,
                e.summary, e.question, e.resolution as evaluation_resolution,
                ce.event_name, ar.display_name as agent_name, ar.kind as agent_kind,
                comp.hostname, u.display_name as user_name, u.email as user_email
         from mcp_tool_calls c
         left join evaluations e on e.id = c.evaluation_id
         left join conversation_events ce on ce.id = c.conversation_event_id
         left join agent_runtimes ar on ar.id = c.agent_runtime_id
         left join computers comp on comp.id = c.computer_id
         left join users u on u.id = c.user_id
         where c.mcp_server_id = $1 and u.organization_id = $2
         order by c.occurred_at desc
         limit 100`,
        [req.params.id, organizationId],
      ),
    ]);
    if (!server.rows[0])
      return res.status(404).json({ error: "MCP server not found" });
    res.json({ server: server.rows[0], calls: calls.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/skills", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const skills = await pool.query(
      `select s.*, u.display_name as user_name, u.email as user_email
       from skills s
       left join users u on u.id = s.user_id
       where s.status <> 'deleted' and u.organization_id = $1
       order by s.updated_at desc
       limit 500`,
      [organizationId],
    );
    const events = await pool.query(
      `select se.*, u.display_name as user_name
       from skill_events se
       left join users u on u.id = se.user_id
       where u.organization_id = $1
       order by se.created_at desc
       limit 100`,
      [organizationId],
    );
    res.json({ skills: skills.rows, events: events.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/bootstrap/status", async (req, res, next) => {
  try {
    const privateMode = normalizeDeploymentMode(process.env.OPENLEASH_DEPLOYMENT_MODE) === "private";
    const requestedSlug = String(req.query.organizationSlug ?? "").trim();
    const organization = requestedSlug ? await getOrganizationBySlug(requestedSlug) : undefined;
    if (!privateMode || !organization) {
      return res.json({ available: false, required: false, configured: false });
    }
    const administrators = await pool.query(
      `select count(*)::int as count from users
       where organization_id = $1 and status = 'active'
         and role in ('owner', 'admin', 'ciso', 'security_admin')`,
      [organization.id],
    );
    res.json({
      available: true,
      required: Number(administrators.rows[0]?.count ?? 0) === 0,
      configured: Boolean(privateBootstrapToken()),
      organization: {
        name: organization.name,
        slug: organization.slug,
        deploymentMode: "private",
        setupCompleted: organization.setup_completed,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/bootstrap", async (req, res, next) => {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    if (normalizeDeploymentMode(process.env.OPENLEASH_DEPLOYMENT_MODE) !== "private") {
      return res.status(404).json({ error: "not found" });
    }
    const expectedToken = privateBootstrapToken();
    if (!expectedToken) {
      return res.status(503).json({
        error: "Private Cloud bootstrap is not configured on the dashboard API.",
      });
    }
    const suppliedToken = String(
      req.body?.bootstrapToken ?? req.header("x-openleash-bootstrap-token") ?? "",
    ).trim();
    if (!secureTokenEquals(suppliedToken, expectedToken)) {
      return res.status(401).json({ error: "Invalid bootstrap token." });
    }
    const requestedSlug = String(req.body?.organizationSlug ?? "").trim();
    const name = String(req.body?.organizationName ?? "").trim();
    const adminName = String(req.body?.adminName ?? "").trim();
    const adminEmail = String(req.body?.adminEmail ?? "").trim().toLowerCase();
    if (!requestedSlug) return res.status(400).json({ error: "organizationSlug is required" });
    if (!name) return res.status(400).json({ error: "Organization name is required." });
    if (!adminName) return res.status(400).json({ error: "Administrator name is required." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
      return res.status(400).json({ error: "Enter a valid administrator email." });
    }

    await client.query("begin");
    transactionStarted = true;
    const organizationResult = await client.query(
      `select * from organizations where slug = $1 for update`,
      [requestedSlug],
    );
    const organization = organizationResult.rows[0];
    if (!organization) throw new HttpError(404, "organization not found");
    const existingAdmin = await client.query(
      `select 1 from users
       where organization_id = $1 and status = 'active'
         and role in ('owner', 'admin', 'ciso', 'security_admin')
       limit 1`,
      [organization.id],
    );
    if ((existingAdmin.rowCount ?? 0) > 0) {
      throw new HttpError(409, "Private Cloud bootstrap has already been completed.");
    }
    const existingEmail = await client.query(
      `select organization_id from users where lower(email) = lower($1) limit 1`,
      [adminEmail],
    );
    if (existingEmail.rows[0] && existingEmail.rows[0].organization_id !== organization.id) {
      throw new HttpError(409, "That administrator email already belongs to another organization.");
    }
    const userResult = existingEmail.rows[0]
      ? await client.query(
          `update users
           set display_name = $2, role = 'owner', status = 'active',
               metadata = coalesce(metadata, '{}'::jsonb) || $4::jsonb
           where organization_id = $1 and lower(email) = lower($3)
           returning id, email, display_name, role`,
          [organization.id, adminName, adminEmail, JSON.stringify({ accountAudience: "organization", privateBootstrap: true })],
        )
      : await client.query(
          `insert into users (organization_id, email, display_name, role, status, metadata)
           values ($1, $2, $3, 'owner', 'active', $4::jsonb)
           returning id, email, display_name, role`,
          [organization.id, adminEmail, adminName, JSON.stringify({ accountAudience: "organization", privateBootstrap: true })],
        );
    const user = userResult.rows[0];
    const sessionToken = `ols_${crypto.randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(
      Date.now() + Number(process.env.OPENLEASH_DASHBOARD_SESSION_DAYS ?? 14) * 86400000,
    );
    await client.query(
      `insert into dashboard_sessions (organization_id, user_id, token_hash, provider, expires_at)
       values ($1, $2, $3, 'private_bootstrap', $4)`,
      [organization.id, user.id, hashToken(sessionToken), expiresAt.toISOString()],
    );
    const updatedOrganization = await client.query(
      `update organizations
       set name = $2, setup_completed = false,
           current_step = greatest(current_step, 2), updated_at = now()
       where id = $1
       returning id, name, slug, region, setup_completed, current_step, deployment_mode`,
      [organization.id, name],
    );
    await client.query("commit");
    transactionStarted = false;
    res.status(201).json({
      success: true,
      token: sessionToken,
      tokens: { accessToken: sessionToken, expiresAt: expiresAt.toISOString() },
      user,
      organization: updatedOrganization.rows[0],
      account: { audience: "organization", packageId: null },
    });
  } catch (error) {
    if (transactionStarted) await client.query("rollback").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

app.get("/admin/onboarding", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const [idp, groups, users, roles, tokens, providerUsage, readiness] =
      await Promise.all([
        pool.query(
          `select id, provider, enabled, last_sync_at, user_count, group_count, last_error, created_at, updated_at,
                config - array['ClientSecret','clientSecret','PrivateKey','privateKey','ApiToken','apiToken','AccessToken','accessToken','ServiceAccountJson','serviceAccountJson'] as config
         from idp_connections
         where organization_id = $1
         limit 1`,
          [organization.id],
        ),
        pool.query(
          `select g.id, g.name, g.description, g.idp_group_id, g.idp_provider,
                count(gm.user_id) as member_count
         from identity_groups g
         left join identity_group_members gm on gm.group_id = g.id
         where g.organization_id = $1
         group by g.id
         order by g.name asc`,
          [organization.id],
        ),
        pool.query(
          `select id, email, display_name, role, first_name, last_name, department, title, idp_provider, status, last_login_at, created_at
         from users
         where organization_id = $1
         order by display_name asc
         limit 500`,
          [organization.id],
        ),
        pool.query(
          `select ra.id, ra.role, ra.user_id, ra.group_id, u.display_name as user_name, g.name as group_name
         from role_assignments ra
         left join users u on u.id = ra.user_id
         left join identity_groups g on g.id = ra.group_id
         where ra.organization_id = $1
         order by ra.role asc, coalesce(g.name, u.display_name) asc`,
          [organization.id],
        ),
        pool.query(
          `select id, label, mode, tenant_url, mdm, expires_at, revoked_at, created_at, last_used_at
         from deployment_tokens
         where organization_id = $1
         order by created_at desc
         limit 10`,
          [organization.id],
        ),
        pool.query(
          `select
           (select count(*)::int from provider_usage_connections where organization_id = $1 and enabled = true) as connection_count,
           (select count(*)::int from provider_usage_budgets where organization_id = $1 and enabled = true) as budget_count`,
          [organization.id],
        ),
        pool.query(
          `select
           (select count(*)::int from users where organization_id = $1 and status = 'active' and role in ('owner', 'admin', 'ciso', 'security_admin')) as administrator_count,
           (select count(*)::int from policies where organization_id = $1 and enabled = true) as active_policy_count,
           (select count(*)::int from plugin_settings where organization_id = $1 and enabled = true) as enabled_plugin_count,
           (select count(*)::int from organization_plugin_policy where organization_id = $1 and (mandatory = true or default_enabled = true or user_install_allowed = false)) as governed_plugin_count`,
          [organization.id],
        ),
      ]);
    const deploymentMode =
      process.env.OPENLEASH_DEPLOYMENT_MODE ??
      process.env.OPENLEASH_EDITION ??
      organization.deployment_mode ??
      "cloud";
    res.json({
      organization: { ...organization, deployment_mode: deploymentMode },
      idp: idp.rows[0] ?? null,
      groups: groups.rows,
      users: users.rows,
      roles: roles.rows,
      deploymentTokens: tokens.rows,
      providerUsage: providerUsage.rows[0] ?? {
        connection_count: 0,
        budget_count: 0,
      },
      readiness: readiness.rows[0] ?? {
        administrator_count: 0,
        active_policy_count: 0,
        enabled_plugin_count: 0,
        governed_plugin_count: 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/organizations/:slug", async (req, res, next) => {
  try {
    const organization = await getOrganizationBySlug(req.params.slug);
    if (!organization)
      return res.status(404).json({ error: "Organization not found" });
    res.json({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      setupCompleted: organization.setup_completed,
      deploymentMode: organization.deployment_mode,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/organizations", async (req, res, next) => {
  try {
    const bootstrapToken = process.env.OPENLEASH_ORG_BOOTSTRAP_TOKEN?.trim();
    const suppliedToken =
      req.header("x-openleash-bootstrap-token")?.trim() ||
      bearerToken(req.header("authorization") ?? "");
    if (!bootstrapToken)
      return res.status(404).json({ error: "not found" });
    if (!secureTokenEquals(suppliedToken, bootstrapToken))
      return res.status(403).json({ error: "organization bootstrap authorization is required" });
    const name = String(req.body.name ?? "").trim();
    if (!name)
      return res.status(400).json({ error: "Organization name is required" });
    const requestedSlug = String(req.body.slug ?? "").trim();
    const slug = slugifyTenant(requestedSlug || name);
    if (!slug)
      return res.status(400).json({ error: "Organization slug is required" });
    const result = await pool.query(
      `insert into organizations (name, slug, region, setup_completed, current_step, deployment_mode)
       values ($1, $2, $3, false, 1, $4)
       on conflict (slug) do update set
         name = excluded.name,
         region = excluded.region,
         setup_completed = false,
         current_step = 1,
         deployment_mode = excluded.deployment_mode,
         updated_at = now()
       returning id, name, slug, region, setup_completed, current_step, deployment_mode`,
      [
        name,
        slug,
        req.body.region ?? null,
        normalizeDeploymentMode(
          req.body.deploymentMode ?? process.env.OPENLEASH_DEPLOYMENT_MODE,
        ),
      ],
    );
    res.status(201).json({ organization: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.get("/organizations/:slug/sso-providers", async (req, res, next) => {
  try {
    const organization = await getOrganizationBySlug(req.params.slug);
    if (!organization)
      return res.status(404).json({ error: "Organization not found" });
    const result = await pool.query(
      `select id, provider, enabled, config
       from idp_connections
       where organization_id = $1 and enabled = true
       order by updated_at desc`,
      [organization.id],
    );
    const providers = result.rows
      .map((row) => ssoProviderFromIdp(row, organization.id))
      .filter(Boolean);
    res.json({ providers });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/sso/authorize", async (req, res, next) => {
  try {
    const organizationId = String(req.body.organizationId ?? "").trim();
    const providerType = String(req.body.providerType ?? "").trim();
    if (!organizationId || !providerType)
      return res
        .status(400)
        .json({ error: "organizationId and providerType are required" });
    const result = await pool.query(
      `select provider, config from idp_connections where organization_id = $1 and enabled = true`,
      [organizationId],
    );
    const row = result.rows.find(
      (item) => ssoProviderType(item.provider) === providerType,
    );
    if (!row)
      return res
        .status(404)
        .json({ error: "SSO provider not found or disabled" });
    const redirectUri =
      process.env.OPENLEASH_SSO_REDIRECT_URI ??
      `${process.env.OPENLEASH_TENANT_URL ?? "http://localhost:9300"}/auth/sso/callback`;
    const state = await createOAuthLoginState({
      providerType,
      audience: "organization",
      organizationId,
      finalRedirectUri: redirectUri,
      exchangeRedirectUri: redirectUri,
    });
    const authorizationUrl = await buildAuthorizationUrl(
      providerType,
      row.config ?? {},
      redirectUri,
      state,
    );
    if (!authorizationUrl)
      return res
        .status(400)
        .json({ error: `Unsupported provider type: ${providerType}` });
    res.json({ authorizationUrl, state, providerType, organizationId, redirectUri });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/sso/callback", async (req, res, next) => {
  try {
    const organizationId = String(req.body.organizationId ?? "").trim();
    const providerType = String(req.body.providerType ?? "").trim();
    const authorizationCode = String(
      req.body.authorizationCode ?? req.body.code ?? "",
    ).trim();
    const redirectUri = String(req.body.redirectUri ?? "").trim();
    const state = String(req.body.state ?? "").trim();
    if (
      !organizationId ||
      !providerType ||
      !authorizationCode ||
      !redirectUri ||
      !state
    ) {
      return res.status(400).json({
        success: false,
        message:
          "organizationId, providerType, authorizationCode, redirectUri, and state are required",
      });
    }

    if (
      !(await consumeOAuthLoginState({
        state,
        providerType,
        audience: "organization",
        organizationId,
        exchangeRedirectUri: redirectUri,
      }))
    ) {
      return res.status(400).json({
        success: false,
        message: "This sign-in request expired, was already used, or does not match this organization.",
      });
    }

    const providerResult = await pool.query(
      `select provider, config from idp_connections where organization_id = $1 and enabled = true`,
      [organizationId],
    );
    const row = providerResult.rows.find(
      (item) => ssoProviderType(item.provider) === providerType,
    );
    if (!row)
      return res.status(404).json({
        success: false,
        message: "SSO provider not found or disabled",
      });

    const organizationResult = await pool.query(
      `select id, name, slug, region from organizations where id = $1 limit 1`,
      [organizationId],
    );
    const organization = organizationResult.rows[0];
    if (!organization)
      return res
        .status(404)
        .json({ success: false, message: "Organization not found" });

    const tokenSet = await exchangeAuthorizationCode(
      providerType,
      row.config ?? {},
      authorizationCode,
      redirectUri,
    );
    const profile = await fetchSsoProfile(
      providerType,
      row.config ?? {},
      tokenSet,
    );
    if (!profile.email)
      return res.status(400).json({
        success: false,
        message: "Identity provider did not return an email address",
      });

    const response = await createDashboardSessionFromProfile({
      organizationId,
      providerType,
      profile,
      provisionUser: false,
      accountAudience: "organization",
    });
    res.json(response);
  } catch (error) {
    next(error);
  }
});

app.get("/auth/google/start", async (req, res) => {
  const finalRedirectUri = String(req.query.redirectUri ?? "").trim();
  if (!finalRedirectUri || !isAllowedAuthRedirectUri(finalRedirectUri)) {
    return res.status(400).json({
      error:
        "redirectUri is required and must be an allowed OpenLeash dashboard URL",
    });
  }
  const exchangeRedirectUri = webGoogleRedirectUri(req);
  if (process.env.OPENLEASH_MOBILE_DEV_AUTH === "1") {
    const state = await createOAuthLoginState({
      providerType: "google",
      audience: "organization",
      finalRedirectUri,
      exchangeRedirectUri,
    });
    const redirect = new URL(finalRedirectUri);
    redirect.searchParams.set("code", "dev-auth");
    redirect.searchParams.set("state", state);
    redirect.searchParams.set("exchangeRedirectUri", exchangeRedirectUri);
    return res.redirect(302, redirect.toString());
  }
  const state = await createOAuthLoginState({
    providerType: "google",
    audience: "organization",
    finalRedirectUri,
    exchangeRedirectUri,
  });
  const authorizationUrl = await buildMobileGoogleAuthorizationUrl(
    exchangeRedirectUri,
    state,
  );
  if (!authorizationUrl) {
    return res.status(501).json({
      error: "Managed Google login is not configured",
      required: [
        "OPENLEASH_GOOGLE_CLIENT_ID",
        "OPENLEASH_GOOGLE_CLIENT_SECRET",
      ],
    });
  }
  res.redirect(302, authorizationUrl);
});

app.get("/auth/microsoft/start", async (req, res) => {
  const finalRedirectUri = String(req.query.redirectUri ?? "").trim();
  if (!finalRedirectUri || !isAllowedAuthRedirectUri(finalRedirectUri)) {
    return res.status(400).json({
      error:
        "redirectUri is required and must be an allowed OpenLeash dashboard URL",
    });
  }
  const exchangeRedirectUri = webMicrosoftRedirectUri(req);
  if (process.env.OPENLEASH_MOBILE_DEV_AUTH === "1") {
    const state = await createOAuthLoginState({
      providerType: "azure_ad",
      audience: "organization",
      finalRedirectUri,
      exchangeRedirectUri,
    });
    const redirect = new URL(finalRedirectUri);
    redirect.searchParams.set("code", "dev-auth");
    redirect.searchParams.set("state", state);
    redirect.searchParams.set("exchangeRedirectUri", exchangeRedirectUri);
    return res.redirect(302, redirect.toString());
  }
  const state = await createOAuthLoginState({
    providerType: "azure_ad",
    audience: "organization",
    finalRedirectUri,
    exchangeRedirectUri,
  });
  const authorizationUrl = await buildAuthorizationUrl(
    "azure_ad",
    cloudMicrosoftConfig(),
    exchangeRedirectUri,
    state,
  );
  if (!authorizationUrl) {
    return res.status(501).json({
      error: "Managed Microsoft 365 login is not configured",
      required: [
        "OPENLEASH_MICROSOFT_CLIENT_ID",
        "OPENLEASH_MICROSOFT_CLIENT_SECRET",
      ],
    });
  }
  res.redirect(302, authorizationUrl);
});

app.get("/auth/google/callback", async (req, res, next) => {
 try {
  const state = String(req.query.state ?? "");
  const callbackState = await activeOAuthLoginState(state, "google");
  const finalRedirectUri = callbackState?.finalRedirectUri;
  if (!finalRedirectUri || !isAllowedAuthRedirectUri(finalRedirectUri)) {
    return res
      .status(400)
      .send(
        "Leash sign-in could not continue because the return URL is invalid.",
      );
  }

  const redirect = new URL(finalRedirectUri);
  const exchangeRedirectUri =
    callbackState.exchangeRedirectUri ?? webGoogleRedirectUri(req);
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = req.query[key];
    if (typeof value === "string" && value)
      redirect.searchParams.set(key, value);
  }
  redirect.searchParams.set("exchangeRedirectUri", exchangeRedirectUri);
  res.redirect(302, redirect.toString());
 } catch (error) {
   next(error);
 }
});

app.get("/auth/microsoft/callback", async (req, res, next) => {
 try {
  const state = String(req.query.state ?? "");
  const callbackState = await activeOAuthLoginState(state, "azure_ad");
  const finalRedirectUri = callbackState?.finalRedirectUri;
  if (!finalRedirectUri || !isAllowedAuthRedirectUri(finalRedirectUri)) {
    return res
      .status(400)
      .send(
        "Leash sign-in could not continue because the return URL is invalid.",
      );
  }

  const redirect = new URL(finalRedirectUri);
  const exchangeRedirectUri =
    callbackState.exchangeRedirectUri ?? webMicrosoftRedirectUri(req);
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = req.query[key];
    if (typeof value === "string" && value)
      redirect.searchParams.set(key, value);
  }
  redirect.searchParams.set("exchangeRedirectUri", exchangeRedirectUri);
  res.redirect(302, redirect.toString());
 } catch (error) {
   next(error);
 }
});

app.get("/auth/session", async (req, res, next) => {
  try {
    const session = await getDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session) return res.status(401).json({ authenticated: false });
    const desktop = await pool.query(
      `select id, hostname, platform, os_release, enrolled_at, last_seen_at
       from computers
       where user_id = $1
         and enrolled_at is not null
         and last_seen_at > now() - interval '90 days'
       order by last_seen_at desc
       limit 1`,
      [session.user.id],
    );
    const evaluationProvider = await tenantModelKeySummary(
      session.organization.id,
    );
    res.json({
      authenticated: true,
      user: session.user,
      organization: session.organization,
      account: session.account,
      evaluationProvider,
      desktop: {
        connected: Boolean(desktop.rows[0]),
        computer: desktop.rows[0] ?? null,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/account/package", async (req, res, next) => {
  try {
    const session = await getDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid Leash session" });
    if (session.account.audience !== "individual") {
      return res.status(403).json({
        error: "Business package changes are managed in Leash Cloud.",
      });
    }
    const packageId = normalizeAccountPackage(
      req.body?.packageId ?? req.body?.plan,
    );
    if (packageId !== "personal-byok" && packageId !== "personal-managed") {
      return res.status(400).json({
        error: "packageId must be personal-byok or personal-managed",
      });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update users
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'accountPackage', $2::text,
           'accountPackageSelectedAt', now()
         )
         where id = $1`,
        [session.user.id, packageId],
      );
      await client.query(
        `update organizations
         set infrastructure_config = coalesce(infrastructure_config, '{}'::jsonb) || jsonb_build_object(
           'accountPackage', $2::text,
           'accountPackageSelectedAt', now()
         ),
         updated_at = now()
         where id = $1`,
        [session.organization.id, packageId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    res.json({ ok: true, packageId });
  } catch (error) {
    next(error);
  }
});

app.get("/auth/account/outcomes", async (req, res, next) => {
  try {
    const session = await getDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const days = Math.max(1, Math.min(365, Number(req.query.days ?? 30) || 30));
    const limit = Math.max(
      1,
      Math.min(100, Number(req.query.limit ?? 40) || 40),
    );
    const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await pool.query(
      `select ps.id, ps.organization_id, ps.plugin_id, ps.kind, ps.severity, ps.title, ps.summary,
              ps.decision, ps.status, ps.target, ps.evidence, ps.details, ps.correlation_keys,
              ps.conversation_event_id, ps.user_id, ps.computer_id, ps.agent_runtime_id,
              ps.occurred_at, ps.created_at,
              o.slug as organization_slug,
              u.email as user_email, u.display_name as user_name,
              c.hostname, ar.kind as agent_kind, ar.display_name as agent_name,
              ce.event_name, ce.tool_name, ce.project_path, e.id as evaluation_id,
              e.resolution as evaluation_resolution
       from plugin_signals ps
       left join organizations o on o.id = ps.organization_id
       left join users u on u.id = ps.user_id
       left join computers c on c.id = ps.computer_id
       left join agent_runtimes ar on ar.id = ps.agent_runtime_id
       left join conversation_events ce on ce.id = ps.conversation_event_id
       left join evaluations e on e.conversation_event_id = ce.id
       where ps.organization_id = $1
         and ps.user_id = $2
         and ps.created_at >= $3
       order by ps.created_at desc
       limit $4`,
      [session.organization.id, session.user.id, start, limit],
    );
    const outcomes = rows.rows.map(signalRowToOutcome);
    const summary = outcomeSummary(outcomes);
    const { plugins } = await pluginCatalogForOrganization(
      session.organization.id,
      session.user.id,
    );
    res.json({
      range: { days, since: start.toISOString() },
      summary,
      outcomes,
      viewModel: buildOpenLeashClientViewModel({ plugins, outcomes, summary }),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/logout", async (req, res, next) => {
  try {
    const token = bearerToken(req.header("authorization") ?? "");
    if (token) {
      await pool.query(
        `update dashboard_sessions set revoked_at = now() where token_hash = $1`,
        [hashToken(token)],
      );
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/mobile/bootstrap", async (req, res, next) => {
  try {
    const slug = String(
      req.query.organizationSlug ?? req.query.slug ?? "",
    ).trim();
    let organization = slug ? await getOrganizationBySlug(slug) : undefined;
    if (!organization && clientModeFromEnvironment() === "enterprise") {
      const defaultSlug = String(
        process.env.OPENLEASH_MANAGED_MOBILE_ORG_SLUG ??
          process.env.OPENLEASH_DEV_ORG_SLUG ??
          "",
      ).trim();
      organization = defaultSlug
        ? await getOrganizationBySlug(defaultSlug)
        : await ensureDefaultOrganization();
    }
    const providers = organization
      ? await mobileProvidersForOrganization(organization.id, organization.slug)
      : defaultMobileProviders();
    res.json({
      mode: clientModeFromEnvironment(),
      apiUrl: publicApiUrl(req),
      cloudApiUrl: process.env.OPENLEASH_CLOUD_API_URL ?? publicApiUrl(req),
      providers,
      organization: organization
        ? {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            region: "region" in organization ? organization.region : null,
          }
        : undefined,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/mobile/auth/start", async (req, res, next) => {
  try {
    const body = req.body as MobileAuthStartRequest;
    const audience =
      body.audience === "organization" ||
      body.organizationId ||
      body.organizationSlug
        ? "organization"
        : "individual";
    const redirectUri = String(body.redirectUri ?? "").trim();
    if (!redirectUri)
      return res.status(400).json({ error: "redirectUri is required" });
    if (!isAllowedAuthRedirectUri(redirectUri)) {
      return res.status(400).json({ error: "redirectUri is not allowed" });
    }
    const codeChallenge = String(body.codeChallenge ?? "").trim();
    const codeChallengeMethod = String(body.codeChallengeMethod ?? "").trim();
    const usesCustomScheme = new URL(redirectUri).protocol === "openleash:";
    if (
      (usesCustomScheme || codeChallenge) &&
      (codeChallengeMethod !== "S256" || !validPkceValue(codeChallenge))
    ) {
      return res.status(400).json({
        error: "A valid S256 PKCE challenge is required for app sign-in.",
      });
    }
    if (
      normalizePublicCloudAuthProvider(String(body.providerType ?? "google")) === "github" &&
      audience === "organization"
    ) {
      return res.status(400).json({
        error: "GitHub sign-in is available for individual accounts only.",
      });
    }

    const organization = body.organizationId
      ? await getOrganizationById(body.organizationId)
      : body.organizationSlug
        ? await getOrganizationBySlug(body.organizationSlug)
        : undefined;

    if (organization) {
      const providerType = String(body.providerType ?? "").trim();
      const provider = await configuredSsoProvider(
        organization.id,
        providerType,
      );
      if (!provider)
        return res.status(404).json({
          error: "Identity provider is not configured for this organization",
        });
      const state = await createOAuthLoginState({
        providerType: provider.providerType,
        audience: "organization",
        organizationId: organization.id,
        organizationSlug: organization.slug,
        finalRedirectUri: redirectUri,
        exchangeRedirectUri: redirectUri,
        codeChallenge: codeChallenge || undefined,
      });
      const authorizationUrl = await buildAuthorizationUrl(
        provider.providerType,
        provider.config,
        redirectUri,
        state,
      );
      if (!authorizationUrl)
        return res.status(400).json({
          error: `Identity provider ${provider.providerType} is missing OAuth configuration`,
        });
      return res.json({
        authorizationUrl,
        state,
        providerType: provider.providerType,
        organizationId: organization.id,
        exchangeRedirectUri: redirectUri,
      });
    }

    const requestedProviderType = String(body.providerType ?? "google").trim();
    const providerType = normalizePublicCloudAuthProvider(
      requestedProviderType,
    );
    if (providerType === "github" && audience !== "individual") {
      return res.status(400).json({
        error: "GitHub sign-in is available for individual accounts only.",
      });
    }
    if (process.env.OPENLEASH_MOBILE_DEV_AUTH === "1") {
      const state = await createOAuthLoginState({
        providerType,
        audience,
        organizationSlug: body.organizationSlug,
        finalRedirectUri: redirectUri,
        exchangeRedirectUri: redirectUri,
        codeChallenge: codeChallenge || undefined,
      });
      const authorizationUrl = new URL(
        "/v1/mobile/dev-auth/callback",
        publicApiUrl(req),
      );
      authorizationUrl.searchParams.set("redirectUri", redirectUri);
      authorizationUrl.searchParams.set("audience", audience);
      authorizationUrl.searchParams.set("state", state);
      if (body.organizationId)
        authorizationUrl.searchParams.set(
          "organizationId",
          body.organizationId,
        );
      if (body.organizationSlug)
        authorizationUrl.searchParams.set(
          "organizationSlug",
          body.organizationSlug,
        );
      return res.json({
        authorizationUrl: authorizationUrl.toString(),
        state,
        providerType,
        exchangeRedirectUri: redirectUri,
        organizationId: body.organizationId,
        development: true,
      });
    }

    const exchangeRedirectUri = publicCloudAuthRedirectUri(
      req,
      providerType,
      redirectUri,
    );
    const state = await createOAuthLoginState({
      providerType,
      audience,
      organizationSlug: body.organizationSlug,
      finalRedirectUri: redirectUri,
      exchangeRedirectUri,
      codeChallenge: codeChallenge || undefined,
    });
    const authorizationUrl =
      providerType === "azure_ad"
        ? await buildAuthorizationUrl(
            "azure_ad",
            cloudMicrosoftConfig(),
            exchangeRedirectUri,
            state,
          )
        : providerType === "github"
          ? await buildAuthorizationUrl(
              "github",
              cloudGithubConfig(exchangeRedirectUri),
              exchangeRedirectUri,
              state,
            )
          : await buildMobileGoogleAuthorizationUrl(exchangeRedirectUri, state);
    if (!authorizationUrl) {
      return res.status(501).json({
        error:
          providerType === "azure_ad"
            ? "Managed Microsoft 365 login is not configured"
            : providerType === "github"
              ? "Managed GitHub login is not configured"
              : "Managed Google login is not configured",
        required:
          providerType === "azure_ad"
            ? [
                "OPENLEASH_MICROSOFT_CLIENT_ID",
                "OPENLEASH_MICROSOFT_CLIENT_SECRET",
              ]
            : providerType === "github"
              ? ["OPENLEASH_GITHUB_CLIENT_ID", "OPENLEASH_GITHUB_CLIENT_SECRET"]
              : [
                  "OPENLEASH_GOOGLE_CLIENT_ID",
                  "OPENLEASH_GOOGLE_CLIENT_SECRET",
                ],
      });
    }
    res.json({ authorizationUrl, state, providerType, exchangeRedirectUri });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/mobile/dev-auth/callback", (req, res) => {
  if (process.env.OPENLEASH_MOBILE_DEV_AUTH !== "1")
    return res.status(404).send("Not found");
  const redirectUri = String(
    req.query.redirectUri ?? desktopRedirectUriFallback(),
  ).trim();
  if (!isAllowedAuthRedirectUri(redirectUri)) {
    return res
      .status(400)
      .send(
        "Leash sign-in could not continue because the return URL is invalid.",
      );
  }
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", "development");
  redirect.searchParams.set("state", String(req.query.state ?? "development"));
  // The dashboard callback uses the same URI for the development exchange.
  // Production providers carry this value in encoded OAuth state; the local
  // development shortcut must preserve the same callback contract.
  redirect.searchParams.set("exchangeRedirectUri", redirectUri);
  const audience = String(req.query.audience ?? "").trim();
  if (audience) redirect.searchParams.set("audience", audience);
  res.redirect(302, redirect.toString());
});

app.get("/v1/auth/google/callback", async (req, res, next) => {
 try {
  const state = String(req.query.state ?? "");
  const callbackState = await activeOAuthLoginState(state, "google");
  const finalRedirectUri = callbackState?.finalRedirectUri;
  if (!finalRedirectUri || !isAllowedAuthRedirectUri(finalRedirectUri)) {
    return res
      .status(400)
      .send(
        "Leash sign-in could not continue because the return URL is invalid.",
      );
  }

  const redirect = new URL(finalRedirectUri);
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = req.query[key];
    if (typeof value === "string" && value)
      redirect.searchParams.set(key, value);
  }
  redirect.searchParams.set(
    "exchangeRedirectUri",
    callbackState.exchangeRedirectUri ??
      `${publicApiUrl(req)}/v1/auth/google/callback`,
  );
  res.redirect(302, redirect.toString());
 } catch (error) {
   next(error);
 }
});

app.get("/v1/auth/microsoft/callback", async (req, res, next) => {
 try {
  const state = String(req.query.state ?? "");
  const callbackState = await activeOAuthLoginState(state, "azure_ad");
  const finalRedirectUri = callbackState?.finalRedirectUri;
  if (!finalRedirectUri || !isAllowedAuthRedirectUri(finalRedirectUri)) {
    return res
      .status(400)
      .send(
        "Leash sign-in could not continue because the return URL is invalid.",
      );
  }

  const redirect = new URL(finalRedirectUri);
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = req.query[key];
    if (typeof value === "string" && value)
      redirect.searchParams.set(key, value);
  }
  redirect.searchParams.set(
    "exchangeRedirectUri",
    callbackState.exchangeRedirectUri ??
      `${publicApiUrl(req)}/v1/auth/microsoft/callback`,
  );
  res.redirect(302, redirect.toString());
 } catch (error) {
   next(error);
 }
});

app.get("/v1/auth/github/callback", async (req, res, next) => {
 try {
  const state = String(req.query.state ?? "");
  const callbackState = await activeOAuthLoginState(state, "github");
  const finalRedirectUri = callbackState?.finalRedirectUri;
  if (!finalRedirectUri || !isAllowedAuthRedirectUri(finalRedirectUri)) {
    return res
      .status(400)
      .send(
        "Leash sign-in could not continue because the return URL is invalid.",
      );
  }

  const redirect = new URL(finalRedirectUri);
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = req.query[key];
    if (typeof value === "string" && value)
      redirect.searchParams.set(key, value);
  }
  redirect.searchParams.set(
    "exchangeRedirectUri",
    callbackState.exchangeRedirectUri ??
      `${publicApiUrl(req)}/v1/auth/github/callback`,
  );
  res.redirect(302, redirect.toString());
 } catch (error) {
   next(error);
 }
});

app.post("/v1/mobile/auth/exchange", async (req, res, next) => {
  try {
    const body = req.body as MobileAuthExchangeRequest;
    const audience =
      body.audience === "organization" ||
      body.organizationId ||
      body.organizationSlug
        ? "organization"
        : "individual";
    const requestedProviderType = String(body.providerType ?? "").trim();
    const redirectUri = String(body.redirectUri ?? "").trim();
    const authorizationCode = String(body.authorizationCode ?? "").trim();
    const state = String(body.state ?? "").trim();
    const codeVerifier = String(body.codeVerifier ?? "").trim();
    const idToken = String(body.idToken ?? "").trim();
    if (!redirectUri)
      return res
        .status(400)
        .json({ success: false, message: "redirectUri is required" });
    if (
      normalizePublicCloudAuthProvider(requestedProviderType || "google") === "github" &&
      audience === "organization"
    ) {
      return res.status(400).json({
        success: false,
        message: "GitHub sign-in is available for individual accounts only.",
      });
    }

    const requestedOrganization = body.organizationId
      ? await getOrganizationById(body.organizationId)
      : body.organizationSlug
        ? await getOrganizationBySlug(body.organizationSlug)
        : undefined;
    if (
      (body.organizationId || body.organizationSlug) &&
      !requestedOrganization
    )
      return res
        .status(404)
        .json({ success: false, message: "Organization not found" });

    const developmentProviderType = normalizePublicCloudAuthProvider(
      requestedProviderType || "google",
    );
    const isDevelopmentMobileAuthCode =
      authorizationCode === "development" || authorizationCode === "dev-auth";
    if (
      (developmentProviderType === "google" ||
        developmentProviderType === "azure_ad" ||
        developmentProviderType === "github") &&
      (!authorizationCode || isDevelopmentMobileAuthCode) &&
      !idToken &&
      process.env.OPENLEASH_MOBILE_DEV_AUTH === "1"
    ) {
      if (
        !(await consumeOAuthLoginState({
          state,
          providerType: developmentProviderType,
          audience,
          organizationId: requestedOrganization?.id,
          organizationSlug:
            requestedOrganization?.slug ?? body.organizationSlug,
          exchangeRedirectUri: redirectUri,
          codeVerifier: codeVerifier || undefined,
        }))
      ) {
        return res.status(400).json({
          success: false,
          message: "This sign-in request expired, was already used, or does not match this device.",
        });
      }
      const developmentEmail =
        process.env.OPENLEASH_MOBILE_DEV_EMAIL ??
        (requestedOrganization
          ? "developer@example.test"
          : "dev-user@openleash.local");
      const developmentName =
        process.env.OPENLEASH_MOBILE_DEV_NAME ??
        displayNameFromEmail(developmentEmail);
      const profile = {
        subject: `mobile-dev:${developmentEmail.toLowerCase()}`,
        email: developmentEmail,
        name: developmentName,
        givenName: null,
        familyName: null,
        raw: { development: true },
      };
      if (
        audience === "organization" &&
        isPersonalEmailDomain(profile.email) &&
        !(
          requestedOrganization &&
          (await canUseCloudOwnerLogin(requestedOrganization.id, profile.email))
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Use your company Google Workspace or Microsoft 365 account, not a personal email address.",
        });
      }
      const provisionUser = requestedOrganization
        ? false
        : body.provisionUser !== false;
      const organization: ManagedOrganization = requestedOrganization
        ? { ...requestedOrganization }
        : provisionUser
          ? await resolveManagedMobileOrganization(profile, audience)
          : await resolveExistingMobileOrganizationForProfile(profile);
      const response = await createDashboardSessionFromProfile({
        organizationId: organization.id,
        providerType: developmentProviderType,
        profile,
        role:
          organization.defaultUserRole ??
          (audience === "organization" ? "admin" : "engineer"),
        provisionUser,
        accountAudience: audience,
        issueDesktopEnrollmentToken: body.desktopEnrollment === true,
      });
      return res.json({ ...response, authMode: "development" });
    }

    const organizationSsoProvider = requestedOrganization
      ? await configuredSsoProvider(
          requestedOrganization.id,
          requestedProviderType
            ? ssoProviderType(requestedProviderType)
            : undefined,
        )
      : undefined;
    if (requestedOrganization && !organizationSsoProvider) {
      return res.status(404).json({
        success: false,
        message: "Identity provider is not configured for this organization",
      });
    }

    const providerType =
      organizationSsoProvider?.providerType ??
      normalizePublicCloudAuthProvider(requestedProviderType || "google");
    if (authorizationCode) {
      if (
        !(await consumeOAuthLoginState({
          state,
          providerType,
          audience,
          organizationId: requestedOrganization?.id,
          organizationSlug:
            requestedOrganization?.slug ?? body.organizationSlug,
          exchangeRedirectUri: redirectUri,
          codeVerifier: codeVerifier || undefined,
        }))
      ) {
        return res.status(400).json({
          success: false,
          message: "This sign-in request expired, was already used, or does not match this device.",
        });
      }
    }
    const organizationForProvider =
      requestedOrganization ??
      (providerType === "google" ||
      providerType === "azure_ad" ||
      providerType === "github"
        ? undefined
        : await ensureManagedMobileOrganization());
    const publicProviderType =
      providerType === "google" ? "google_workspace" : providerType;
    const publicProviderConfig =
      providerType === "google"
        ? mobileGoogleConfig()
        : providerType === "azure_ad"
          ? cloudMicrosoftConfig()
          : providerType === "github"
            ? cloudGithubConfig(redirectUri)
            : {};
    const tokenSet = organizationSsoProvider
      ? await exchangeAuthorizationCode(
          organizationSsoProvider.providerType,
          organizationSsoProvider.config,
          authorizationCode,
          redirectUri,
        )
      : providerType === "google" ||
          providerType === "github" ||
          (providerType === "azure_ad" && !requestedOrganization)
        ? await exchangeAuthorizationCode(
            publicProviderType,
            publicProviderConfig,
            authorizationCode,
            redirectUri,
          )
        : await exchangeAuthorizationCode(
            providerType,
            {},
            authorizationCode,
            redirectUri,
          );

    const profile = organizationSsoProvider
      ? await fetchSsoProfile(
          organizationSsoProvider.providerType,
          organizationSsoProvider.config,
          idToken ? { id_token: idToken } : tokenSet,
        )
      : providerType === "google" ||
          providerType === "github" ||
          (providerType === "azure_ad" && !requestedOrganization)
        ? await fetchSsoProfile(
            publicProviderType,
            publicProviderConfig,
            idToken ? { id_token: idToken } : tokenSet,
          )
        : await fetchSsoProfile(
            providerType,
            {},
            idToken ? { id_token: idToken } : tokenSet,
          );
    if (!profile.email)
      return res.status(400).json({
        success: false,
        message: "Identity provider did not return an email address",
      });
    if (
      audience === "organization" &&
      isPersonalEmailDomain(profile.email) &&
      !(
        requestedOrganization &&
        (await canUseCloudOwnerLogin(requestedOrganization.id, profile.email))
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Use your company Google Workspace or Microsoft 365 account, not a personal email address.",
      });
    }

    const provisionUser = requestedOrganization
      ? false
      : body.provisionUser !== false;
    const organization: ManagedOrganization = requestedOrganization
      ? { ...requestedOrganization }
      : provisionUser
        ? providerType === "google" ||
          providerType === "azure_ad" ||
          providerType === "github"
          ? await resolveManagedMobileOrganization(profile, audience)
          : organizationForProvider!
        : await resolveExistingMobileOrganizationForProfile(profile);
    const response = await createDashboardSessionFromProfile({
      organizationId: organization.id,
      providerType,
      profile,
      role:
        organization.defaultUserRole ??
        (audience === "organization" ? "admin" : "engineer"),
      provisionUser,
      accountAudience: audience,
      issueDesktopEnrollmentToken: body.desktopEnrollment === true,
    });
    res.json({ ...response, authMode: providerType });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/mobile/auth/handoff", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const session = await getDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "valid dashboard session required" });
    const state = String(req.body?.state ?? "").trim();
    const codeChallenge = String(req.body?.codeChallenge ?? "").trim();
    if (!validOAuthState(state) || !validPkceValue(codeChallenge)) {
      return res.status(400).json({
        error: "A valid Desktop state and PKCE challenge are required.",
      });
    }
    const code = `olh_${crypto.randomBytes(32).toString("base64url")}`;
    await client.query("begin");
    try {
      await client.query(
        `update desktop_auth_handoffs
         set consumed_at = coalesce(consumed_at, now())
         where user_id = $1 and consumed_at is null`,
        [session.user.id],
      );
      await client.query(
        `insert into desktop_auth_handoffs (
           organization_id, user_id, code_hash, state_hash, code_challenge,
           expires_at
         ) values ($1, $2, $3, $4, $5, now() + interval '5 minutes')`,
        [
          session.organization.id,
          session.user.id,
          hashToken(code),
          hashToken(state),
          codeChallenge,
        ],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
    res.status(201).json({ code, expiresIn: 300 });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

app.post("/v1/mobile/auth/handoff/exchange", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const code = String(req.body?.code ?? "").trim();
    const state = String(req.body?.state ?? "").trim();
    const codeVerifier = String(req.body?.codeVerifier ?? "").trim();
    if (
      !/^olh_[A-Za-z0-9_-]{43}$/.test(code) ||
      !validOAuthState(state) ||
      !validPkceValue(codeVerifier)
    ) {
      return res.status(400).json({
        error: "The Desktop handoff is malformed. Start sign-in again from Leash.",
      });
    }
    await client.query("begin");
    const handoffResult = await client.query<{
      id: string;
      organization_id: string;
      user_id: string;
      state_hash: string;
      code_challenge: string;
      email: string;
      display_name: string;
      role: string;
      user_metadata: Record<string, unknown> | null;
      organization_name: string;
      organization_slug: string;
      region: string | null;
      infrastructure_config: Record<string, unknown> | null;
    }>(
      `select h.id, h.organization_id, h.user_id, h.state_hash,
              h.code_challenge, u.email, u.display_name, u.role,
              u.metadata as user_metadata, o.name as organization_name,
              o.slug as organization_slug, o.region,
              o.infrastructure_config
       from desktop_auth_handoffs h
       join users u on u.id = h.user_id and u.organization_id = h.organization_id
       join organizations o on o.id = h.organization_id
       where h.code_hash = $1
         and h.consumed_at is null
         and h.expires_at > now()
         and u.status = 'active'
       for update of h`,
      [hashToken(code)],
    );
    const handoff = handoffResult.rows[0];
    const calculatedChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    if (
      !handoff ||
      !secureHashEquals(hashToken(state), handoff.state_hash) ||
      !secureTokenEquals(calculatedChallenge, handoff.code_challenge)
    ) {
      await client.query("rollback");
      return res.status(401).json({
        error: "This Desktop handoff expired, was already used, or does not match this Leash app.",
      });
    }
    await client.query(
      `update desktop_auth_handoffs set consumed_at = now() where id = $1`,
      [handoff.id],
    );
    const enrollmentToken = `ole_${crypto.randomBytes(24).toString("base64url")}`;
    await client.query(
      `insert into dashboard_sessions (
         organization_id, user_id, token_hash, provider, expires_at
       ) values ($1, $2, $3, 'desktop_enrollment', now() + interval '10 minutes')`,
      [handoff.organization_id, handoff.user_id, hashToken(enrollmentToken)],
    );
    await client.query("commit");
    const userMetadata = handoff.user_metadata ?? {};
    const organizationConfig = handoff.infrastructure_config ?? {};
    res.json({
      success: true,
      desktopEnrollmentToken: enrollmentToken,
      user: {
        id: handoff.user_id,
        email: handoff.email,
        display_name: handoff.display_name,
        role: handoff.role,
      },
      organization: {
        id: handoff.organization_id,
        name: handoff.organization_name,
        slug: handoff.organization_slug,
        region: handoff.region,
      },
      account: {
        audience:
          userMetadata.accountAudience === "individual"
            ? "individual"
            : "organization",
        packageId: normalizeAccountPackage(
          userMetadata.accountPackage ?? organizationConfig.accountPackage,
        ),
      },
      evaluationProvider: await tenantModelKeySummary(handoff.organization_id),
    });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

app.post("/v1/mobile/model-key", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    if (await organizationUsesManagedEvaluation(session.organization.id)) {
      return res.status(409).json({
        error: "Switch to your own AI provider before connecting a key.",
      });
    }
    const provider = normalizeTenantModelProvider(
      req.body.provider ?? req.body.apiProvider,
    );
    const apiKey = String(req.body.apiKey ?? "").trim();
    if (!provider)
      return res
        .status(400)
        .json({ error: "provider must be openai, anthropic, or deepseek" });
    if (!apiKey) return res.status(400).json({ error: "apiKey is required" });
    const result = await upsertTenantModelKey({
      organizationId: session.organization.id,
      provider,
      apiKey,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.delete("/v1/mobile/model-key", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid Leash session" });
    if (!(await organizationUsesManagedEvaluation(session.organization.id))) {
      return res.status(409).json({
        error: "Switch to Leash AI before removing your provider key.",
      });
    }
    res.json(await deleteTenantModelKey(session.organization.id));
  } catch (error) {
    next(error);
  }
});

app.post("/v1/mobile/devices", async (req, res, next) => {
  try {
    const session = await getDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const body = req.body as MobileDeviceRegisterRequest;
    const result = await pool.query(
      `insert into mobile_devices (organization_id, user_id, platform, push_token, device_name, app_version, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (user_id, push_token) do update set
         platform = excluded.platform,
         device_name = excluded.device_name,
         app_version = excluded.app_version,
         last_seen_at = now()
       returning id, platform, device_name, app_version, last_seen_at`,
      [
        session.organization.id,
        session.user.id,
        body.platform ?? "unknown",
        String(body.pushToken ?? `${session.user.id}:manual`).trim(),
        body.deviceName ?? null,
        body.appVersion ?? null,
      ],
    );
    res.status(201).json({ device: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/desktop/enroll", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const authorization = req.header("authorization") ?? "";
    const enrollmentSession = await getDashboardSession(
      authorization,
      "desktop_enrollment",
    );
    const session =
      enrollmentSession ?? (await getDashboardSession(authorization));
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const hostname =
      String(req.body?.hostname ?? os.hostname()).trim() || os.hostname();
    const platform = String(req.body?.platform ?? "unknown");
    const osRelease =
      typeof req.body?.osRelease === "string" ? req.body.osRelease : null;
    const clientVersion =
      typeof req.body?.clientVersion === "string"
        ? req.body.clientVersion
        : null;
    const installIdentity = String(req.body?.installIdentity ?? "").trim();
    if (installIdentity.length < 16 || installIdentity.length > 1024) {
      return res.status(400).json({
        error: "A stable desktop installation identity is required. Update Leash and try again.",
      });
    }
    const agents = normalizeEnrollmentAgents(req.body?.agents);
    const agentToken = `ol_${crypto.randomBytes(24).toString("base64url")}`;
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `openleash-desktop-enrollment:${session.user.id}`,
    ]);
    const user = await client.query(
      `update users
       set status = 'active', last_login_at = now()
       where id = $1 and organization_id = $2
       returning id, email, display_name, organization_id`,
      [session.user.id, session.organization.id],
    );
    if (!user.rows[0]) throw new HttpError(404, "session user not found");
    // Authenticated legacy installs predate stable installation identities.
    // Claim exactly one legacy row only when the user has no modern device;
    // this preserves history without trusting a hostname or a shared token.
    await client.query(
      `with claimable as (
         select legacy.id
         from computers legacy
         where legacy.user_id = $1
           and legacy.install_identity is null
           and not exists (
             select 1 from computers modern
             where modern.user_id = $1 and modern.install_identity is not null
           )
           and 1 = (
             select count(*) from computers candidate
             where candidate.user_id = $1 and candidate.install_identity is null
           )
         for update
       )
       update computers computer
       set install_identity = $2, hostname = $3, platform = $4,
           os_release = $5, enrolled_at = coalesce(computer.enrolled_at, now()),
           last_seen_at = now()
       from claimable
       where computer.id = claimable.id`,
      [session.user.id, installIdentity, hostname, platform, osRelease],
    );
    const computer = await client.query(
      `insert into computers (user_id, hostname, platform, os_release, install_identity, enrolled_at, last_seen_at)
       values ($1, $2, $3, $4, $5, now(), now())
       on conflict (user_id, install_identity) where install_identity is not null do update set
         hostname = excluded.hostname,
         platform = excluded.platform,
         os_release = excluded.os_release,
         enrolled_at = coalesce(computers.enrolled_at, now()),
         last_seen_at = now()
       returning id, hostname, platform, os_release, install_identity, enrolled_at, last_seen_at`,
      [session.user.id, hostname, platform, osRelease, installIdentity],
    );
    await client.query(
      `insert into desktop_credentials (
         organization_id, user_id, computer_id, token_hash, last_seen_at
       ) values ($1, $2, $3, $4, now())
       on conflict (computer_id) do update set
         organization_id = excluded.organization_id,
         user_id = excluded.user_id,
         token_hash = excluded.token_hash,
         revoked_at = null,
         last_seen_at = now()`,
      [
        session.organization.id,
        session.user.id,
        computer.rows[0].id,
        hashToken(agentToken),
      ],
    );
    if (enrollmentSession) {
      await client.query(
        `update dashboard_sessions
         set revoked_at = now(), last_seen_at = now()
         where token_hash = $1 and provider = 'desktop_enrollment'`,
        [hashToken(bearerToken(authorization) ?? "")],
      );
    }
    await client.query("commit");
    await upsertDesktopAgentInventory(computer.rows[0].id, agents, clientVersion);
    res.status(201).json({
      token: agentToken,
      user: user.rows[0],
      computer: computer.rows[0],
      agents,
      organization: session.organization,
      clientVersion,
      rulesManagedBy: "openleash-cloud",
    });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

app.post("/v1/desktop/agents", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const hostname =
      String(req.body?.hostname ?? os.hostname()).trim() || os.hostname();
    const platform = String(req.body?.platform ?? "unknown");
    const osRelease =
      typeof req.body?.osRelease === "string" ? req.body.osRelease : null;
    const installIdentity = String(req.body?.installIdentity ?? "").trim();
    if (installIdentity.length < 16 || installIdentity.length > 1024) {
      return res.status(400).json({
        error: "A stable desktop installation identity is required. Update Leash and try again.",
      });
    }
    const agents = normalizeEnrollmentAgents(req.body?.agents);
    if (session.source === "client" && session.computerId) {
      const computer = await pool.query(
        `update computers
         set hostname = $3, platform = $4, os_release = $5,
             install_identity = coalesce(install_identity, $6),
             enrolled_at = coalesce(enrolled_at, now()), last_seen_at = now()
         where id = $1 and user_id = $2
           and (install_identity = $6 or install_identity is null)
         returning id, hostname, platform, os_release, install_identity, enrolled_at, last_seen_at`,
        [session.computerId, session.user.id, hostname, platform, osRelease, installIdentity],
      );
      if (!computer.rows[0]) {
        return res.status(409).json({
          error: "This desktop credential belongs to a different Leash installation.",
        });
      }
      const clientVersion =
        typeof req.body?.clientVersion === "string"
          ? req.body.clientVersion
          : null;
      await upsertDesktopAgentInventory(
        computer.rows[0].id,
        agents,
        clientVersion,
      );
      return res.json({ ok: true, computer: computer.rows[0], agents });
    }
    const computer = await pool.query(
      `insert into computers (user_id, hostname, platform, os_release, install_identity, enrolled_at, last_seen_at)
       values ($1, $2, $3, $4, $5, now(), now())
       on conflict (user_id, install_identity) where install_identity is not null do update set
         hostname = excluded.hostname,
         platform = excluded.platform,
         os_release = excluded.os_release,
         enrolled_at = coalesce(computers.enrolled_at, now()),
         last_seen_at = now()
       returning id, hostname, platform, os_release, install_identity, enrolled_at, last_seen_at`,
      [session.user.id, hostname, platform, osRelease, installIdentity],
    );
    const clientVersion =
      typeof req.body?.clientVersion === "string"
        ? req.body.clientVersion
        : null;
    await upsertDesktopAgentInventory(
      computer.rows[0].id,
      agents,
      clientVersion,
    );
    res.json({ ok: true, computer: computer.rows[0], agents });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/agents/:kind/monitoring", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const kind = normalizeAgentKindForSettings(req.params.kind);
    if (!kind) return res.status(400).json({ error: "agent kind is required" });
    const monitored = Boolean(req.body?.monitored);
    await pool.query(
      `insert into agent_monitoring_settings (user_id, organization_id, kind, monitored, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (user_id, kind) do update set
         organization_id = excluded.organization_id,
         monitored = excluded.monitored,
         updated_at = now()`,
      [session.user.id, session.organization.id, kind, monitored],
    );
    res.json({ kind, monitored });
  } catch (error) {
    next(error);
  }
});

async function upsertDesktopAgentInventory(
  computerId: string,
  agents: ReturnType<typeof normalizeEnrollmentAgents>,
  clientVersion?: string | null,
) {
  for (const agent of agents) {
    await pool.query(
      `insert into agent_runtimes (computer_id, kind, display_name, executable_path, version, installed, protected, detail, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (computer_id, kind, executable_path_key) do update set
         display_name = excluded.display_name,
         version = coalesce($5, agent_runtimes.version),
         installed = excluded.installed,
         protected = excluded.protected,
         detail = excluded.detail,
         last_seen_at = now()`,
      [
        computerId,
        agent.kind,
        agent.displayName,
        agent.executablePath,
        clientVersion,
        agent.installed,
        agent.protected,
        agent.detail || null,
      ],
    );
  }
}

function normalizeAgentKindForSettings(value: unknown) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!text) return "";
  if (text.includes("claude")) return "claude-code";
  if (text.includes("copilot")) return "github-copilot";
  if (text.includes("gemini")) return "gemini";
  if (text.includes("opencode")) return "opencode";
  if (text.includes("codex") || text.includes("openai")) return "codex";
  if (text.includes("cline")) return "cline";
  if (text.includes("cursor")) return "cursor";
  if (text.includes("windsurf")) return "windsurf";
  return text;
}

function normalizeEnrollmentAgents(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const kind =
      typeof item === "string"
        ? item
        : String((item as { kind?: unknown })?.kind ?? "");
    const cleanKind = kind.trim().toLowerCase();
    if (!cleanKind || seen.has(cleanKind)) return [];
    seen.add(cleanKind);
    const displayName =
      typeof item === "object" &&
      item &&
      typeof (item as { displayName?: unknown }).displayName === "string"
        ? (item as { displayName: string }).displayName.trim()
        : "";
    const executablePath =
      typeof item === "object" &&
      item &&
      typeof (item as { executablePath?: unknown }).executablePath === "string"
        ? (item as { executablePath: string }).executablePath.trim()
        : "";
    const installed =
      typeof item === "object" &&
      item &&
      typeof (item as { installed?: unknown }).installed === "boolean"
        ? Boolean((item as { installed: boolean }).installed)
        : true;
    const protectedByOpenLeash =
      typeof item === "object" &&
      item &&
      typeof (item as { protected?: unknown }).protected === "boolean"
        ? Boolean((item as { protected: boolean }).protected)
        : false;
    const detail =
      typeof item === "object" &&
      item &&
      typeof (item as { detail?: unknown }).detail === "string"
        ? (item as { detail: string }).detail.trim()
        : "";
    return [
      {
        kind: cleanKind,
        displayName: displayName || enrollmentAgentDisplayName(cleanKind),
        executablePath,
        installed,
        protected: protectedByOpenLeash,
        detail,
      },
    ];
  });
}

function enrollmentAgentDisplayName(kind: string) {
  if (kind === "claude-code") return "Claude Code";
  if (kind === "codex") return "OpenAI Codex";
  if (kind === "cline") return "Cline";
  if (kind === "opencode") return "OpenCode";
  if (kind === "cursor") return "Cursor";
  if (kind === "gemini") return "Google Gemini CLI";
  if (kind === "windsurf") return "Windsurf";
  return kind;
}

app.get("/v1/mobile/state", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const [
      pending,
      blocked,
      agents,
      history,
      sessionMetrics,
      policies,
      pluginCatalog,
      pluginOutcomes,
      sessionMonitoringPauses,
    ] = await Promise.all([
      mobilePendingApprovals(session.user.id, session.organization.id, false),
      browserBlockedNotifications(session.organization.id, session.user.id),
      mobileAgents(session.organization.id, session.user.id),
      mobileRecentActivity(session.organization.id, session.user.id, {
        limit: 11,
        pageSize: 10,
      }),
      mobileSessionMetrics(session.organization.id, session.user.id),
      pool.query(
        `select id, name, description, severity, natural_language_rule, enabled, locked
         from policies where organization_id = $1 order by created_at asc`,
        [session.organization.id],
      ),
      pluginCatalogForOrganization(session.organization.id, session.user.id),
      userPluginOutcomes(session.organization.id, session.user.id, {
        limit: 40,
      }),
      activeSessionMonitoringPauses(
        session.organization.id,
        session.user.id,
      ),
    ]);
    const islandContributions = await activeIslandContributions(
      session.organization.id,
      session.user.id,
      pluginCatalog.plugins,
    );
    const runtimePolicy = await runtimePolicyForUser(session.user);
    const summary = outcomeSummary(pluginOutcomes.outcomes);
    res.json({
      user: session.user,
      organization: session.organization,
      apiUrl: publicApiUrl(req),
      mode: clientModeFromEnvironment(),
      pendingApprovals: pending.rows,
      attentionEvents: buildAttentionEvents({
        pending: pending.rows,
        blocked: blocked.rows,
        activity: history.rows,
      }),
      agents: agents.rows,
      recentActivity: history.rows.slice(0, 10),
      historyPagination: {
        page: 1,
        limit: 10,
        hasMore: history.rows.length > 10,
        nextPage: history.rows.length > 10 ? 2 : null,
      },
      sessionMetrics: sessionMetrics.rows[0],
      policies: policies.rows,
      plugins: pluginCatalog.plugins,
      outcomes: pluginOutcomes.outcomes,
      islandContributions,
      sessionMonitoringPauses: sessionMonitoringPauses.map((item) => ({
        agentKind: item.agent_kind,
        sessionIds: [item.session_id],
        expiresAt: item.expires_at.toISOString(),
      })),
      viewModel: buildOpenLeashClientViewModel({
        plugins: pluginCatalog.plugins,
        outcomes: pluginOutcomes.outcomes,
        summary,
      }),
      clientConfig: {
        approvalNotifications: runtimePolicy.notifyEmployees,
        managedByOrganization: isOrganizationManagedAccount(
          productMode,
          session.account?.audience,
        ),
        runtimePolicy,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/client/overview", async (req, res, next) => {
  try {
    res.set("Cache-Control", "private, max-age=5, stale-while-revalidate=25");
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const [agents, pluginCatalog, pluginOutcomes, activitySummary] = await Promise.all([
      clientOverviewAgents(session.organization.id, session.user.id),
      pluginCatalogForOrganization(session.organization.id, session.user.id),
      userPluginOutcomes(session.organization.id, session.user.id, { limit: 12 }),
      personalDashboardActivitySummary(session.organization.id, session.user.id),
    ]);
    const summary = outcomeSummary(pluginOutcomes.outcomes);
    res.json({
      agents: agents.rows,
      plugins: pluginCatalog.plugins,
      outcomes: pluginOutcomes.outcomes,
      activitySummary,
      viewModel: buildOpenLeashClientViewModel({
        plugins: pluginCatalog.plugins,
        outcomes: pluginOutcomes.outcomes,
        summary,
      }),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/client/history", async (req, res, next) => {
  try {
    res.set("Cache-Control", "private, max-age=5");
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const limit = Math.max(
      1,
      Math.min(50, Math.floor(Number(req.query.limit ?? 12) || 12)),
    );
    const page = Math.max(
      1,
      Math.floor(Number(req.query.page ?? 1) || 1),
    );
    const agentKind = optionalString(req.query.agentKind);
    const history = await mobileRecentActivity(
      session.organization.id,
      session.user.id,
      { limit: limit + 1, page, pageSize: limit, agentKind },
    );
    const hasMore = history.rows.length > limit;
    res.json({
      history: history.rows.slice(0, limit),
      pagination: {
        page,
        limit,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/mobile/decisions/:id/resolve", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const body = req.body as MobileDecisionResolveRequest;
    const resolution = body.resolution === "allow" ? "allow" : "deny";
    const result = await resolveApprovalGroup(
      req.params.id,
      resolution,
      `mobile:${session.user.id}`,
      {
        userId: session.user.id,
      },
      body.resolutionGuidance,
      body.response,
    );
    if (!result) return res.status(404).json({ error: "approval not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/v1/client/notifications", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const [pending, blocked, activity, pluginCatalog] = await Promise.all([
      mobilePendingApprovals(session.user.id, session.organization.id, false),
      browserBlockedNotifications(session.organization.id, session.user.id),
      mobileRecentActivity(session.organization.id, session.user.id, {
        limit: 12,
      }),
      pluginCatalogForOrganization(session.organization.id, session.user.id),
    ]);
    const islandContributions = await activeIslandContributions(
      session.organization.id,
      session.user.id,
      pluginCatalog.plugins,
    );
    const runtimePolicy = await runtimePolicyForUser(session.user);
    res.json({
      serverTime: new Date().toISOString(),
      pendingApprovals: pending.rows,
      blockedEvents: blocked.rows.map((row) => ({
        ...row,
        ...notificationPluginAttribution(row.payload),
      })),
      recentActivity: activity.rows,
      islandContributions,
      attentionEvents: buildAttentionEvents({
        pending: pending.rows,
        blocked: blocked.rows,
        activity: activity.rows,
      }),
      clientConfig: {
        approvalNotifications: runtimePolicy.notifyEmployees,
        runtimePolicy,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/client/events", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    res.status(200);
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();

    let closed = false;
    const writeEvent = (event: unknown) => {
      if (closed || res.writableEnded) return;
      res.write(`event: sync\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = await clientSyncBroker.subscribe(
      { userId: session.user.id },
      writeEvent,
    );
    writeEvent({
      schemaVersion: "2026-07-27.client-sync.v1",
      id: `ready:${Date.now()}`,
      kind: "activity.created",
      occurredAt: new Date().toISOString(),
    });
    const heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(": heartbeat\n\n");
    }, 20_000);
    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
    return undefined;
  } catch (error) {
    next(error);
  }
});

app.post("/v1/client/decisions/:id/resolve", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const body = req.body as MobileDecisionResolveRequest;
    const resolution = body.resolution === "allow" ? "allow" : "deny";
    const result = await resolveApprovalGroup(
      req.params.id,
      resolution,
      `web:${session.user.id}`,
      {
        userId: session.user.id,
      },
      body.resolutionGuidance,
      body.response,
    );
    if (!result) return res.status(404).json({ error: "approval not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

async function resolveApprovalGroup(
  id: string,
  resolution: "allow" | "deny",
  resolvedBy: string,
  scope: { organizationId?: string; userId?: string } = {},
  resolutionGuidance?: string,
  responsePayload?: Record<string, unknown>,
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const selected = await client.query<{
      id: string;
      decision: "ask";
      resolution: null;
      resolved_at: Date | null;
      intent_key: string | null;
    }>(
      `select e.id, e.decision, e.resolution, e.resolved_at, ce.payload->'raw'->>'openleashIntentKey' as intent_key
       from evaluations e
       join conversation_events ce on ce.id = e.conversation_event_id
       where e.id = $1
         and e.decision = 'ask'
         and e.resolution is null
         and ($2::uuid is null or e.user_id = $2)
         and (
           $3::uuid is null or exists (
             select 1 from users owner
             where owner.id = e.user_id and owner.organization_id = $3
           )
         )
       for update`,
      [id, scope.userId ?? null, scope.organizationId ?? null],
    );
    const row = selected.rows[0];
    if (!row) {
      await client.query("rollback");
      return undefined;
    }
    const guidance =
      resolution === "deny"
        ? cleanResolutionGuidance(resolutionGuidance)
        : undefined;
    const response =
      resolution === "allow"
        ? cleanInteractionResponse(responsePayload)
        : undefined;
    const result = await client.query(
      `update evaluations
       set resolution = $2, resolved_at = now(), resolved_by = $3,
           resolution_guidance = $4, resolution_payload = $5
       where id = $1
         and decision = 'ask'
         and resolution is null
       returning id, decision, resolution, resolution_guidance, resolution_payload, resolved_at`,
      [id, resolution, resolvedBy, guidance ?? null, response ?? null],
    );
    if (row.intent_key) {
      await client.query(
        `update evaluations e
         set resolution = $2, resolved_at = now(), resolved_by = $3,
             resolution_guidance = $7, resolution_payload = $8
         from conversation_events ce
         where ce.id = e.conversation_event_id
           and e.id <> $1
           and e.decision = 'ask'
           and e.resolution is null
           and ce.payload->'raw'->>'openleashIntentKey' = $4
           and e.created_at > now() - interval '5 minutes'
           and ($5::uuid is null or e.user_id = $5)
           and (
             $6::uuid is null or exists (
               select 1 from users owner
               where owner.id = e.user_id and owner.organization_id = $6
             )
           )`,
        [
          id,
          resolution,
          resolvedBy,
          row.intent_key,
          scope.userId ?? null,
          scope.organizationId ?? null,
          guidance ?? null,
          response ?? null,
        ],
      );
      const candidates = await client.query<{
        id: string;
        intent_key: string | null;
      }>(
        `select e.id, ce.payload->'raw'->>'openleashIntentKey' as intent_key
         from evaluations e
         join conversation_events ce on ce.id = e.conversation_event_id
         where e.id <> $1
           and e.decision = 'ask'
           and e.resolution is null
           and e.created_at > now() - interval '5 minutes'
           and ($2::uuid is null or e.user_id = $2)
           and (
             $3::uuid is null or exists (
               select 1 from users owner
               where owner.id = e.user_id and owner.organization_id = $3
             )
           )`,
        [id, scope.userId ?? null, scope.organizationId ?? null],
      );
      const canonicalKey = canonicalIntentKey(row.intent_key);
      const duplicateIds = candidates.rows
        .filter(
          (candidate) =>
            canonicalIntentKey(candidate.intent_key) === canonicalKey,
        )
        .map((candidate) => candidate.id);
      if (duplicateIds.length > 0) {
        await client.query(
          `update evaluations
           set resolution = $2, resolved_at = now(), resolved_by = $3,
               resolution_guidance = $4, resolution_payload = $5
           where id = any($1::uuid[])`,
          [duplicateIds, resolution, resolvedBy, guidance ?? null, response ?? null],
        );
      }
    }
    await client.query("commit");
    return result.rows[0];
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

app.post("/admin/onboarding/infrastructure", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const deploymentMode = normalizeDeploymentMode(
      req.body.deploymentMode ?? process.env.OPENLEASH_DEPLOYMENT_MODE,
    );
    if (deploymentMode !== "private") {
      return res.json({ success: true, organization });
    }
    const config = {
      apiUrl: String(req.body.apiUrl ?? "").trim(),
      dashboardUrl: String(req.body.dashboardUrl ?? "").trim(),
      identityLoaderUrl: String(req.body.identityLoaderUrl ?? "").trim(),
      updateMode: String(req.body.updateMode ?? "public").trim(),
      updateFeedUrl: String(req.body.updateFeedUrl ?? "").trim(),
    };
    const result = await pool.query(
      `update organizations
       set deployment_mode = 'private', infrastructure_config = $2, current_step = greatest(current_step, 2), updated_at = now()
       where id = $1
       returning *`,
      [organization.id, JSON.stringify(config)],
    );
    res.json({ success: true, organization: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/onboarding/company", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const name = String(
      req.body.name ?? req.body.organizationName ?? "",
    ).trim();
    if (!name)
      return res
        .status(400)
        .json({ success: false, error: "Organization name is required" });
    const requestedSlug = String(req.body.slug ?? "").trim();
    const slug = slugifyTenant(requestedSlug || name);
    const existingSlug = await pool.query(
      `select id from organizations where slug = $1 and id <> $2 limit 1`,
      [slug, organization.id],
    );
    if ((existingSlug.rowCount ?? 0) > 0) {
      return res.status(409).json({
        success: false,
        error: "That dashboard URL is already taken.",
      });
    }
    const packageId =
      normalizeAccountPackage(req.body.packageId ?? req.body.plan) ??
      "work-managed";
    const result = await pool.query(
      `update organizations
       set name = $2,
           slug = $3,
           region = $4,
           logo_url = $5,
           infrastructure_config = coalesce(infrastructure_config, '{}'::jsonb) || jsonb_build_object(
             'accountPackage', $6::text,
             'accountPackageSelectedAt', now()
           ),
           current_step = greatest(current_step, 2),
           updated_at = now()
       where id = $1
       returning *`,
      [
        organization.id,
        name,
        slug,
        req.body.region ?? null,
        req.body.logoUrl ?? null,
        packageId,
      ],
    );
    res.json({ organization: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/onboarding/generate-code", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const code = generateOnboardingCode();
    const result = await pool.query(
      `update organizations set onboarding_code = $2, updated_at = now() where id = $1 returning *`,
      [organization.id, code],
    );
    res.json({
      organization: result.rows[0],
      code,
      url: `/setup?code=${encodeURIComponent(code)}`,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/onboarding/test-idp", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const provider = normalizeIdpProvider(req.body.provider);
    const credentials = providerCredentials(
      provider,
      req.body.credentials ?? req.body,
    );
    if (!provider)
      return res
        .status(400)
        .json({ success: false, error: "Unsupported identity provider" });
    const identityLoader = process.env.IDENTITY_LOADER_URL;
    if (identityLoader) {
      const response = await fetch(
        `${identityLoader.replace(/\/+$/, "")}/api/sync/test`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idpType: provider.idpType,
            credentials,
            additionalConfig: { OrganizationId: organization.id },
          }),
        },
      );
      const data = await response.json().catch(() => ({}));
      return res.status(response.ok ? 200 : 400).json(data);
    }
    res.status(400).json({
      success: false,
      error:
        "Identity sync service is not configured. Set IDENTITY_LOADER_URL to test this provider.",
    });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/onboarding/sync-identity", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const existing = await pool.query<{
      provider: string;
      config: Record<string, unknown>;
    }>(
      `select provider, config from idp_connections where organization_id = $1 limit 1`,
      [organization.id],
    );
    const provider = normalizeIdpProvider(
      req.body.provider ?? existing.rows[0]?.provider,
    );
    if (!provider)
      return res
        .status(400)
        .json({ success: false, error: "Unsupported identity provider" });
    const incomingCredentials = providerCredentials(
      provider,
      req.body.credentials ?? req.body,
    );
    const credentials = hasAnyCredential(incomingCredentials)
      ? incomingCredentials
      : (existing.rows[0]?.config ?? {});

    await pool.query(
      `insert into idp_connections (organization_id, provider, config, enabled, updated_at)
       values ($1, $2, $3, true, now())
       on conflict (organization_id) do update set provider = excluded.provider, config = excluded.config, enabled = true, updated_at = now()`,
      [organization.id, provider.idpType, JSON.stringify(credentials)],
    );

    const identityLoader = process.env.IDENTITY_LOADER_URL;
    if (!identityLoader) {
      const error =
        "Identity sync service is not configured. Set IDENTITY_LOADER_URL to sync real users and groups.";
      await pool.query(
        `update idp_connections set last_error = $2, updated_at = now() where organization_id = $1`,
        [organization.id, error],
      );
      return res.status(400).json({ success: false, error });
    }
    const response = await fetch(
      `${identityLoader.replace(/\/+$/, "")}/api/sync`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idpType: provider.idpType,
          credentials,
          additionalConfig: { OrganizationId: organization.id },
        }),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
      await pool.query(
        `update idp_connections set last_error = $2, updated_at = now() where organization_id = $1`,
        [organization.id, data.error ?? data.message ?? "Identity sync failed"],
      );
      return res.status(400).json(data);
    }
    const stats = {
      usersProcessed: Number(data.statistics?.usersProcessed ?? 0),
      groupsProcessed: Number(data.statistics?.groupsProcessed ?? 0),
      membershipsProcessed: Number(data.statistics?.membershipsProcessed ?? 0),
    };

    await pool.query(
      `update idp_connections
       set last_sync_at = now(), user_count = $2, group_count = $3, last_error = null, updated_at = now()
       where organization_id = $1`,
      [organization.id, stats.usersProcessed, stats.groupsProcessed],
    );
    await pool.query(
      `update organizations set current_step = greatest(current_step, 4), updated_at = now() where id = $1`,
      [organization.id],
    );
    res.json({
      success: true,
      message: "Identity sync completed",
      statistics: stats,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/onboarding/rbac", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    await pool.query(
      `delete from role_assignments where organization_id = $1`,
      [organization.id],
    );
    const roles = Array.isArray(req.body.roles) ? req.body.roles : [];
    const assignedRoles = new Map<string, { role: string; direct: boolean }>();
    const roleRank: Record<string, number> = { viewer: 1, responder: 2, analyst: 3, admin: 4, security_admin: 5, ciso: 6 };
    for (const item of roles) {
      const role = ["admin", "ciso", "security_admin", "analyst", "responder", "viewer"].includes(
        item.role,
      )
        ? item.role
        : "viewer";
      const groupId =
        typeof item.groupId === "string" && item.groupId ? item.groupId : null;
      const userId =
        typeof item.userId === "string" && item.userId ? item.userId : null;
      if (!groupId && !userId) continue;
      await pool.query(
        `insert into role_assignments (organization_id, role, group_id, user_id) values ($1, $2, $3, $4)`,
        [organization.id, role, groupId, userId],
      );
      const targetUserIds = userId
        ? [userId]
        : (await pool.query<{ user_id: string }>(
            `select gm.user_id
             from identity_group_members gm
             join identity_groups g on g.id = gm.group_id
             where gm.group_id = $1 and g.organization_id = $2`,
            [groupId, organization.id],
          )).rows.map((row) => row.user_id);
      for (const targetUserId of targetUserIds) {
        const current = assignedRoles.get(targetUserId);
        if (!current || Boolean(userId) || (!current.direct && roleRank[role] > roleRank[current.role])) {
          assignedRoles.set(targetUserId, { role, direct: Boolean(userId) });
        }
      }
    }
    await pool.query(
      `update users set role = 'engineer'
       where organization_id = $1 and role in ('admin', 'ciso', 'security_admin', 'analyst', 'responder', 'viewer')`,
      [organization.id],
    );
    for (const [userId, assignment] of assignedRoles) {
      await pool.query(
        `update users set role = $3 where organization_id = $1 and id = $2`,
        [organization.id, userId, assignment.role],
      );
    }
    await pool.query(
      `update organizations set current_step = greatest(current_step, 5), updated_at = now() where id = $1`,
      [organization.id],
    );
    res.json({ success: true, count: roles.length });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/onboarding/complete", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    if (!organization.name?.trim()) {
      return res.status(400).json({
        success: false,
        error: "Save your company profile before activating OpenLeash.",
      });
    }
    const readiness = await pool.query(
      `select
       (select count(*)::int from users where organization_id = $1 and status = 'active' and role in ('owner', 'admin', 'ciso', 'security_admin')) as administrators,
       (select count(*)::int from idp_connections where organization_id = $1 and enabled = true and last_error is null) as identity_connections,
       (select count(*)::int from role_assignments where organization_id = $1) as role_assignments,
       (select count(*)::int from deployment_tokens where organization_id = $1 and revoked_at is null and (expires_at is null or expires_at > now())) as deployment_tokens,
       (select count(*)::int from policies where organization_id = $1 and enabled = true) as active_policies,
       (select count(*)::int from plugin_settings where organization_id = $1 and enabled = true) as enabled_plugins,
       (select count(*)::int from organization_plugin_policy where organization_id = $1 and (mandatory = true or default_enabled = true or user_install_allowed = false)) as governed_plugins`,
      [organization.id],
    );
    const state = readiness.rows[0] ?? {};
    const missing = [
      Number(state.administrators ?? 0) < 1 ? "an active organization administrator" : null,
      Number(state.identity_connections ?? 0) < 1 ? "a connected identity provider" : null,
      Number(state.role_assignments ?? 0) < 1 ? "at least one delegated dashboard role" : null,
      Number(state.deployment_tokens ?? 0) < 1 ? "an active endpoint deployment token" : null,
      Number(state.active_policies ?? 0) + Number(state.enabled_plugins ?? 0) < 1
        ? "at least one enabled organization safeguard or plugin"
        : null,
      Number(state.governed_plugins ?? 0) < 1 ? "an organization plugin governance rule" : null,
    ].filter(Boolean);
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Complete the rollout baseline first: ${missing.join(", ")}.`,
        missing,
      });
    }
    const result = await pool.query(
      `update organizations set setup_completed = true, current_step = 8, updated_at = now() where id = $1 returning *`,
      [organization.id],
    );
    res.json({ success: true, organization: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/identity", async (req, res, next) => {
  try {
    const organization = { id: await organizationIdForAdminRequest(req) };
    const [idp, groups, users, roles] = await Promise.all([
      pool.query(
        `select provider, enabled, last_sync_at, user_count, group_count, last_error from idp_connections where organization_id = $1`,
        [organization.id],
      ),
      pool.query(
        `select g.id, g.name, g.description, g.idp_provider, count(gm.user_id) as member_count
         from identity_groups g
         left join identity_group_members gm on gm.group_id = g.id
         where g.organization_id = $1
         group by g.id
         order by g.name asc`,
        [organization.id],
      ),
      pool.query(
        `select u.id, u.email, u.display_name, u.role, u.department, u.title, u.idp_provider, u.status,
                count(distinct c.id) as endpoint_count,
                count(distinct ar.id) as agent_count,
                max(greatest(c.last_seen_at, coalesce(ar.last_seen_at, c.last_seen_at))) as last_seen_at
         from users u
         left join computers c on c.user_id = u.id
         left join agent_runtimes ar on ar.computer_id = c.id
         where u.organization_id = $1
         group by u.id
         order by u.display_name asc`,
        [organization.id],
      ),
      pool.query(
        `select role, count(*) as count from role_assignments where organization_id = $1 group by role`,
        [organization.id],
      ),
    ]);
    res.json({
      organization,
      idp: idp.rows[0] ?? null,
      groups: groups.rows,
      users: users.rows,
      roles: roles.rows,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/triggers", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const filters: string[] = [
      "u.organization_id = $1",
      "exists (select 1 from policy_results pr where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question'))",
    ];
    const values: unknown[] = [organizationId];
    const add = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      const param = add(`%${req.query.q.trim()}%`);
      filters.push(
        `(e.summary ilike ${param} or ce.prompt ilike ${param} or ce.project_path ilike ${param} or ce.tool_name ilike ${param})`,
      );
    }
    if (typeof req.query.user === "string" && req.query.user.trim()) {
      const param = add(`%${req.query.user.trim()}%`);
      filters.push(`u.display_name ilike ${param}`);
    }
    if (typeof req.query.policy === "string" && req.query.policy.trim()) {
      const param = add(`%${req.query.policy.trim()}%`);
      filters.push(
        `exists (select 1 from policy_results pr where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question') and pr.policy_name ilike ${param})`,
      );
    }
    if (
      typeof req.query.decision === "string" &&
      ["ask", "deny", "allow"].includes(req.query.decision)
    ) {
      filters.push(`e.decision = ${add(req.query.decision)}`);
    }
    if (typeof req.query.dateFrom === "string" && req.query.dateFrom.trim()) {
      filters.push(`e.created_at >= ${add(req.query.dateFrom)}`);
    }
    if (typeof req.query.dateTo === "string" && req.query.dateTo.trim()) {
      filters.push(`e.created_at <= ${add(req.query.dateTo)}`);
    }
    const limit = Math.min(Number(req.query.limit ?? 100), 250);
    const result = await pool.query(
      `select e.id, e.decision, e.resolution, e.summary, e.question, e.created_at,
              ce.id as event_id, ce.event_name, ce.tool_name, ce.project_path, ce.prompt,
              ar.display_name as agent_name, ar.kind as agent_kind,
              c.hostname, u.display_name as user_name,
              coalesce(triggered.items, '[]'::jsonb) as triggered_policies
       from evaluations e
       join conversation_events ce on ce.id = e.conversation_event_id
       join agent_runtimes ar on ar.id = ce.agent_runtime_id
       join computers c on c.id = ce.computer_id
       left join users u on u.id = e.user_id
       left join lateral (
         select jsonb_agg(
           jsonb_build_object(
             'policy_name', pr.policy_name,
             'status', pr.status,
             'severity', pr.severity,
             'explanation', pr.explanation,
             'evidence', pr.evidence
           )
           order by pr.created_at asc
         ) as items
         from policy_results pr
         where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
       ) triggered on true
       where ${filters.join(" and ")}
       order by e.created_at desc
       limit ${add(limit)}`,
      values,
    );
    res.json({ triggers: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/triggers/:id", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const [trigger, policies] = await Promise.all([
      pool.query(
        `select e.id, e.decision, e.resolution, e.resolved_at, e.resolved_by, e.summary, e.question, e.model, e.created_at,
                ce.id as event_id, ce.session_id, ce.event_name, ce.tool_name, ce.project_path, ce.prompt, ce.payload, ce.occurred_at,
                ar.display_name as agent_name, ar.kind as agent_kind, ar.version as agent_version,
                c.hostname, c.platform, u.display_name as user_name, u.email as user_email
         from evaluations e
         join conversation_events ce on ce.id = e.conversation_event_id
         join agent_runtimes ar on ar.id = ce.agent_runtime_id
         join computers c on c.id = ce.computer_id
         left join users u on u.id = e.user_id
         where e.id = $1 and u.organization_id = $2`,
        [req.params.id, organizationId],
      ),
      pool.query(
        `select pr.policy_name, pr.status, pr.severity, pr.explanation, pr.evidence, pr.question, pr.created_at
         from policy_results pr
         join evaluations e on e.id = pr.evaluation_id
         join users u on u.id = e.user_id
         where pr.evaluation_id = $1 and u.organization_id = $2
         order by pr.created_at asc`,
        [req.params.id, organizationId],
      ),
    ]);
    if (!trigger.rows[0])
      return res.status(404).json({ error: "trigger not found" });
    const payload = await withTranscriptContext(
      trigger.rows[0].payload,
      trigger.rows[0].occurred_at,
    );
    res.json({
      trigger: { ...trigger.rows[0], payload, policy_results: policies.rows },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/logs", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const filters: string[] = ["u.organization_id = $1"];
    const values: unknown[] = [organization.id];
    const add = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      const param = add(`%${req.query.q.trim()}%`);
      filters.push(`(
        ce.prompt ilike ${param}
        or ce.project_path ilike ${param}
        or ce.tool_name ilike ${param}
        or ce.session_id ilike ${param}
        or ce.event_name ilike ${param}
        or ar.display_name ilike ${param}
        or ar.kind ilike ${param}
        or c.hostname ilike ${param}
        or u.display_name ilike ${param}
        or u.email ilike ${param}
        or ce.payload::text ilike ${param}
      )`);
    }
    if (typeof req.query.userId === "string" && req.query.userId.trim()) {
      filters.push(`u.id = ${add(req.query.userId.trim())}`);
    }
    if (typeof req.query.user === "string" && req.query.user.trim()) {
      const param = add(`%${req.query.user.trim()}%`);
      filters.push(`(u.display_name ilike ${param} or u.email ilike ${param})`);
    }
    if (typeof req.query.agent === "string" && req.query.agent.trim()) {
      const param = add(`%${req.query.agent.trim()}%`);
      filters.push(
        `(ar.display_name ilike ${param} or ar.kind ilike ${param})`,
      );
    }
    if (typeof req.query.event === "string" && req.query.event.trim()) {
      filters.push(`ce.event_name = ${add(req.query.event.trim())}`);
    }
    if (
      typeof req.query.decision === "string" &&
      ["ask", "deny", "allow", "passed", "logged"].includes(req.query.decision)
    ) {
      if (req.query.decision === "logged") {
        filters.push(`e.id is null`);
      } else if (req.query.decision === "passed") {
        filters.push(
          `e.decision = 'allow' and not exists (select 1 from policy_results pr where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question'))`,
        );
      } else {
        filters.push(`e.decision = ${add(req.query.decision)}`);
      }
    }
    if (typeof req.query.dateFrom === "string" && req.query.dateFrom.trim()) {
      filters.push(`ce.created_at >= ${add(req.query.dateFrom)}`);
    }
    if (typeof req.query.dateTo === "string" && req.query.dateTo.trim()) {
      filters.push(`ce.created_at <= ${add(req.query.dateTo)}`);
    }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 250);
    const result = await pool.query(
      `select ce.id, ce.session_id, ce.event_name, ce.project_path, ce.prompt, ce.tool_name,
              ce.payload, ce.occurred_at, ce.created_at,
              e.id as evaluation_id, e.decision, e.resolution, e.summary, e.question, e.created_at as evaluated_at,
              ar.display_name as agent_name, ar.kind as agent_kind, ar.version as agent_version,
              c.hostname, c.platform,
              u.id as user_id, u.display_name as user_name, u.email as user_email,
              coalesce(policy_summary.items, '[]'::jsonb) as policy_results
       from conversation_events ce
       join users u on u.id = ce.user_id
       left join evaluations e on e.conversation_event_id = ce.id
       left join agent_runtimes ar on ar.id = ce.agent_runtime_id
       left join computers c on c.id = ce.computer_id
       left join lateral (
         select jsonb_agg(
           jsonb_build_object(
             'policy_name', pr.policy_name,
             'status', pr.status,
             'severity', pr.severity,
             'explanation', pr.explanation,
             'question', pr.question,
             'evidence', pr.evidence
           )
           order by case pr.status when 'failed' then 0 when 'needs_question' then 1 else 2 end, pr.created_at asc
         ) as items
         from policy_results pr
         where pr.evaluation_id = e.id
       ) policy_summary on true
       where ${filters.join(" and ")}
       order by ce.created_at desc
       limit ${add(limit)}`,
      values,
    );
    res.json({ logs: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/debug", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const filters: string[] = ["ple.organization_id = $1"];
    const values: unknown[] = [organization.id];
    const add = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (typeof req.query.q === "string" && req.query.q.trim()) {
      const param = add(`%${req.query.q.trim()}%`);
      filters.push(`(
        ple.message ilike ${param}
        or ple.code ilike ${param}
        or ple.category ilike ${param}
        or ple.plugin_id ilike ${param}
        or ple.data::text ilike ${param}
        or ple.scope::text ilike ${param}
        or ce.session_id ilike ${param}
        or ce.project_path ilike ${param}
        or ce.event_name ilike ${param}
        or ce.tool_name ilike ${param}
        or ar.display_name ilike ${param}
        or ar.kind ilike ${param}
        or c.hostname ilike ${param}
        or u.display_name ilike ${param}
        or u.email ilike ${param}
      )`);
    }
    if (typeof req.query.plugin === "string" && req.query.plugin.trim()) {
      const param = add(`%${req.query.plugin.trim()}%`);
      filters.push(`ple.plugin_id ilike ${param}`);
    }
    if (
      typeof req.query.level === "string" &&
      ["debug", "info", "warn", "error", "security"].includes(req.query.level)
    ) {
      filters.push(`ple.level = ${add(req.query.level)}`);
    }
    if (typeof req.query.category === "string" && req.query.category.trim()) {
      filters.push(`ple.category = ${add(req.query.category.trim())}`);
    }
    if (typeof req.query.session === "string" && req.query.session.trim()) {
      filters.push(
        `coalesce(ce.session_id, ple.scope->>'sessionId') = ${add(req.query.session.trim())}`,
      );
    }
    if (typeof req.query.dateFrom === "string" && req.query.dateFrom.trim()) {
      filters.push(`ple.created_at >= ${add(req.query.dateFrom)}`);
    }
    if (typeof req.query.dateTo === "string" && req.query.dateTo.trim()) {
      filters.push(`ple.created_at <= ${add(req.query.dateTo)}`);
    }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 150), 1), 500);
    const result = await pool.query(
      `select ple.id, ple.plugin_id, ple.level, ple.category, ple.code, ple.message, ple.scope, ple.data, ple.created_at,
              ce.id as conversation_event_id, ce.session_id, ce.event_name, ce.tool_name, ce.project_path, ce.occurred_at,
              ar.display_name as agent_name, ar.kind as agent_kind, ar.version as agent_version,
              c.hostname, c.platform,
              u.id as user_id, u.display_name as user_name, u.email as user_email
       from plugin_log_events ple
       left join conversation_events ce on ce.id = ple.conversation_event_id
       left join agent_runtimes ar on ar.id = coalesce(ple.agent_runtime_id, ce.agent_runtime_id)
       left join computers c on c.id = coalesce(ple.computer_id, ce.computer_id)
       left join users u on u.id = coalesce(ple.user_id, ce.user_id)
       where ${filters.join(" and ")}
       order by ple.created_at desc
       limit ${add(limit)}`,
      values,
    );
    res.json({ debugLogs: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/logs/:id", async (req, res, next) => {
  try {
    const organization = await resolveOnboardingOrganization(req);
    const [log, policies] = await Promise.all([
      pool.query(
        `select ce.id, ce.session_id, ce.event_name, ce.project_path, ce.prompt, ce.tool_name,
                ce.payload, ce.occurred_at, ce.created_at,
                e.id as evaluation_id, e.decision, e.resolution, e.resolution_guidance, e.summary, e.question, e.model, e.created_at as evaluated_at,
                ar.display_name as agent_name, ar.kind as agent_kind, ar.version as agent_version,
                c.hostname, c.platform,
                u.id as user_id, u.display_name as user_name, u.email as user_email
         from conversation_events ce
         join users u on u.id = ce.user_id
         left join evaluations e on e.conversation_event_id = ce.id
         left join agent_runtimes ar on ar.id = ce.agent_runtime_id
         left join computers c on c.id = ce.computer_id
         where ce.id = $1 and u.organization_id = $2`,
        [req.params.id, organization.id],
      ),
      pool.query(
        `select pr.policy_name, pr.status, pr.severity, pr.explanation, pr.evidence, pr.question, pr.created_at
         from policy_results pr
         join evaluations e on e.id = pr.evaluation_id
         join conversation_events ce on ce.id = e.conversation_event_id
         join users u on u.id = ce.user_id
         where ce.id = $1 and u.organization_id = $2
         order by pr.created_at asc`,
        [req.params.id, organization.id],
      ),
    ]);
    if (!log.rows[0]) return res.status(404).json({ error: "log not found" });
    const payload = await withTranscriptContext(
      log.rows[0].payload,
      log.rows[0].occurred_at,
    );
    res.json({
      log: { ...log.rows[0], payload, policy_results: policies.rows },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/skills/observations", async (req, res, next) => {
  try {
    const token = bearerToken(req.header("authorization") ?? "");
    const user = token ? await getUserByToken(token) : undefined;
    if (!user)
      return res
        .status(401)
        .json({ error: "missing or invalid OpenLeash token" });
    const organizationId =
      user.organization_id ?? (await ensureDefaultOrganization()).id;
    const body = req.body as {
      agentKind?: string;
      agentName?: string;
      scope?: "user" | "project";
      projectPath?: string | null;
      skillName?: string;
      skillPath?: string;
      contentHash?: string;
      content?: string;
      contentPreview?: string;
      purposeSummary?: string;
      eventType?: string;
      status?: string;
      riskScore?: number;
      reasons?: Array<{ reason?: string; quote?: string }>;
    };
    const skillName = String(body.skillName ?? "").trim();
    const skillPath = String(body.skillPath ?? "").trim();
    if (!skillName || !skillPath)
      return res
        .status(400)
        .json({ error: "skillName and skillPath are required" });
    const runtimePlugins = await pluginSettingsForRuntime(
      organizationId,
      user.id,
      String(body.agentKind ?? "unknown"),
      undefined,
      body.projectPath ?? undefined,
    );
    const reasons = normalizeSkillReasons(body.reasons);
    const content =
      typeof body.content === "string" ? body.content.slice(0, 80000) : null;
    const contentPreview =
      typeof body.contentPreview === "string"
        ? body.contentPreview.slice(0, 12000)
        : (content?.slice(0, 12000) ?? null);
    const agentKind = String(body.agentKind ?? "unknown") as AgentKind;
    const agentName = body.agentName ?? "Local agent";
    const requestedEventType = normalizeSkillObservationEventType(
      body.eventType,
    );
    const existingSkill = await pool.query(
      `select id, status, risk_score, reasons, content_hash, purpose_summary
       from skills
       where organization_id = $1 and user_id = $2 and skill_path = $3
       limit 1`,
      [organizationId, user.id, skillPath],
    );
    const existing = existingSkill.rows[0] as
      | {
          id: string;
          status: string;
          risk_score: number | string;
          reasons: unknown;
          content_hash: string;
          purpose_summary?: string | null;
        }
      | undefined;
    const contentHash =
      body.contentHash ??
      existing?.content_hash ??
      crypto
        .createHash("sha256")
        .update(content ?? skillPath)
        .digest("hex");
    const skillEventType = inferSkillObservationEventType(
      requestedEventType,
      existing,
      contentHash,
    );
    const pipelineSkillEvent = pipelineEventForSkillObservation(skillEventType);
    const skillProtectionMode = normalizeBusinessProtectionMode(
      runtimePlugins.get("openleash.skill-scanner")?.config?.protectionMode,
    );
    const shouldScanSkill =
      runtimePlugins.get("openleash.skill-scanner")?.enabled !== false &&
      skillProtectionMode !== "off" &&
      (skillEventType === "detected" || skillEventType === "changed");
    const tenantModelKey = shouldScanSkill
      ? await tenantModelKeyForEvaluation(organizationId)
      : undefined;
    const skillScanRequest: EvaluationRequest = {
      computer: {
        hostname: req.hostname || "unknown",
        platform: "unknown",
      },
      agent: {
        kind: agentKind,
        displayName: agentName,
      },
      event: {
        eventName: "SubagentStart",
        agentKind,
        sessionId: `skill:${skillPath}`,
        projectPath: body.projectPath ?? undefined,
        prompt: `Skill ${skillName} ${skillEventType} at ${skillPath}`,
        occurredAt: new Date().toISOString(),
        raw: {
          openleashEventType: `skill-${skillEventType}`,
          skillName,
          skillPath,
          skillEventType,
          contentPreview: contentPreview ?? "",
          contentHash,
        },
      },
    };
    const skillScannerManifest = firstPartyPluginManifests.find(
      (plugin) => plugin.id === "openleash.skill-scanner",
    );
    const skillScannerSettings = runtimePlugins.get("openleash.skill-scanner");
    const skillScan = shouldScanSkill && skillScannerManifest && skillScannerSettings
      ? await runSkillScanner({
            event: pipelineSkillEvent,
            agentKind,
            agentName,
            skillName,
            skillPath,
            content,
            contentPreview,
            status: body.status,
            riskScore: body.riskScore,
            reasons,
          }, createPluginCapabilities({
            organizationId,
            pluginId: "openleash.skill-scanner",
            userId: user.id,
            tenantModelKey,
            request: skillScanRequest,
            permissions: skillScannerManifest.permissions,
          }))
      : {
          status:
            skillEventType === "removed"
              ? "deleted"
              : normalizeSkillStatus(body.status, existing?.status),
          riskScore: Number(existing?.risk_score ?? body.riskScore ?? 0),
          reasons: normalizeExistingSkillReasons(existing?.reasons, reasons),
          findings: [],
          run: undefined,
        };
    const suspicious = shouldScanSkill && skillScan.status === "suspicious";
    const status = skillEventType === "removed" ? "deleted" : skillScan.status;
    const purposeSummary = await skillPurposeSummary({
      provided: body.purposeSummary ?? existing?.purpose_summary ?? undefined,
      content: content ?? contentPreview ?? "",
      skillName,
      skillPath,
    });
    const client = await pool.connect();
    let signalContext:
      { eventId: string; computerId: string; runtimeId: string } | undefined;
    try {
      await client.query("begin");
      const skill = await client.query(
        `insert into skills
         (organization_id, user_id, agent_kind, agent_name, scope, project_path, skill_name, skill_path, status, risk_score, reasons, content_hash, content, content_preview, purpose_summary, content_updated_at, first_seen_at, last_seen_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, now(), now(), now(), now())
         on conflict (organization_id, user_id, skill_path) do update set
           agent_kind = excluded.agent_kind,
           agent_name = excluded.agent_name,
           scope = excluded.scope,
           project_path = excluded.project_path,
           skill_name = excluded.skill_name,
           status = excluded.status,
           risk_score = excluded.risk_score,
           reasons = excluded.reasons,
           content_hash = excluded.content_hash,
           content = coalesce(excluded.content, skills.content),
           content_preview = coalesce(excluded.content_preview, skills.content_preview),
           purpose_summary = coalesce(excluded.purpose_summary, skills.purpose_summary),
           content_updated_at = case when skills.content_hash is distinct from excluded.content_hash then excluded.content_updated_at else coalesce(skills.content_updated_at, excluded.content_updated_at) end,
           last_seen_at = now(),
           updated_at = now()
         returning *`,
        [
          organizationId,
          user.id,
          body.agentKind ?? "unknown",
          body.agentName ?? "Local agent",
          body.scope === "project" ? "project" : "user",
          body.projectPath ?? null,
          skillName,
          skillPath,
          status,
          skillScan.riskScore,
          JSON.stringify(skillScan.reasons),
          contentHash,
          content,
          contentPreview,
          purposeSummary,
        ],
      );
      let evaluationId: string | null = null;
      if (suspicious) {
        const conversationEventName =
          skillEventType === "detected" ? "SkillDetected" : "SkillChanged";
        const skillPluginRuns = skillScan.run ? [skillScan.run] : [];
        const computerId = await upsertActivityComputer(client, user, {
          hostname: req.hostname || "unknown",
          platform: "unknown",
          osRelease: null,
        });
        const runtime = await client.query(
          `insert into agent_runtimes (computer_id, kind, display_name, executable_path, last_seen_at)
           values ($1, $2, $3, $4, now())
           on conflict (computer_id, kind, executable_path_key) do update set display_name = excluded.display_name, last_seen_at = now()
           returning id`,
          [
            computerId,
            body.agentKind ?? "unknown",
            body.agentName ?? "Local agent",
            "",
          ],
        );
        const event = await client.query(
          `insert into conversation_events
           (user_id, computer_id, agent_runtime_id, session_id, event_name, project_path, prompt, tool_name, payload, occurred_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'agent-skill', $8::jsonb, now())
           returning id`,
          [
            user.id,
            computerId,
            runtime.rows[0].id,
            `skill:${skillPath}`,
            conversationEventName,
            body.projectPath ?? null,
            `Skill ${skillName} ${skillEventType} at ${skillPath}`,
            JSON.stringify({
              openleashEventType: "skill-risk",
              skillEventType,
              skillName,
              skillPath,
              reasons: skillScan.reasons,
              contentPreview: contentPreview ?? "",
              purposeSummary,
              openleashPluginRuns: skillPluginRuns,
            }),
          ],
        );
        const monitorOnly = skillProtectionMode === "monitor";
        const evaluation = await client.query(
          `insert into evaluations (conversation_event_id, user_id, decision, summary, question, model)
           values ($1, $2, $3, $4, $5, 'skill-evaluator') returning id`,
          [
            event.rows[0].id,
            user.id,
            monitorOnly ? "allow" : "ask",
            monitorOnly
              ? "Leash observed a possibly malicious agent skill in monitor-only mode."
              : "Leash detected a possibly malicious agent skill.",
            monitorOnly ? null : "Leash detected a possibly malicious agent skill. Delete this skill or approve it?",
          ],
        );
        evaluationId = evaluation.rows[0].id;
        signalContext = {
          eventId: event.rows[0].id,
          computerId,
          runtimeId: runtime.rows[0].id,
        };
        await client.query(
          `insert into policy_results (evaluation_id, policy_id, policy_name, status, severity, explanation, evidence, question)
           values ($1, null, 'Agent skill integrity', $2, 'high', $3, $4::jsonb, $5)`,
          [
            evaluationId,
            monitorOnly ? "passed" : "needs_question",
            monitorOnly
              ? "Monitor only: a newly added or edited agent skill may contain unsafe instructions or executable behavior."
              : "A newly added or edited agent skill may contain unsafe instructions or executable behavior.",
            JSON.stringify(
              skillScan.reasons.map((reason) =>
                reason.quote
                  ? `${reason.reason}: ${reason.quote}`
                  : reason.reason,
              ),
            ),
            monitorOnly ? null : "Delete this skill or approve it?",
          ],
        );
      }
      const event = await client.query(
        `insert into skill_events
         (organization_id, skill_id, evaluation_id, user_id, agent_kind, agent_name, scope, project_path, skill_name, skill_path, event_type, status, risk_score, reasons, content_preview, purpose_summary)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16)
         returning *`,
        [
          organizationId,
          skill.rows[0].id,
          evaluationId,
          user.id,
          body.agentKind ?? "unknown",
          body.agentName ?? "Local agent",
          body.scope === "project" ? "project" : "user",
          body.projectPath ?? null,
          skillName,
          skillPath,
          skillEventType,
          status,
          skillScan.riskScore,
          JSON.stringify(skillScan.reasons),
          contentPreview,
          purposeSummary,
        ],
      );
      await client.query("commit");
      if (signalContext) {
        await createPluginCapabilities({
          organizationId,
          pluginId: "openleash.skill-scanner",
          conversationEventId: signalContext.eventId,
          userId: user.id,
          computerId: signalContext.computerId,
          runtimeId: signalContext.runtimeId,
          request: skillScanRequest,
          permissions: skillScannerManifest?.permissions ?? [],
        }).signals.emit({
          kind: "security.finding",
          severity: "high",
          title: "Suspicious skill behavior",
          summary: "Skill scanner found behavior that needs review.",
          decision: skillProtectionMode === "monitor" ? "observed" : "ask",
          status,
          target: { type: "agent_skill", name: skillName },
          evidence: skillScan.reasons,
          details: {
            skillName,
            skillPath,
            agentKind: body.agentKind ?? "unknown",
            agentName: body.agentName ?? "Local agent",
            riskScore: skillScan.riskScore,
          },
          correlationKeys: [
            `skill:${skillName}`,
            `agent:${body.agentKind ?? "unknown"}`,
          ],
        });
      }
      if (evaluationId && skillProtectionMode !== "monitor") {
        notifyMobileApprovers(
          user.id,
          evaluationId,
          "Possible malicious skill",
          "Delete this skill or approve it?",
          undefined,
        ).catch((error) => {
          console.warn("mobile skill notification failed", error);
        });
      }
      res
        .status(201)
        .json({ skill: skill.rows[0], event: event.rows[0], evaluationId });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.get("/admin/pending-decisions", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const pending = await pool.query(
      `select e.id, e.decision, e.summary, e.question, e.created_at,
              ce.event_name, ce.tool_name, ce.project_path, ce.payload,
              ar.display_name as agent_name, ar.kind as agent_kind,
              c.hostname, u.display_name as user_name,
              coalesce(triggered.items, '[]'::jsonb) as triggered_policies
       from evaluations e
       join conversation_events ce on ce.id = e.conversation_event_id
       join agent_runtimes ar on ar.id = ce.agent_runtime_id
       join computers c on c.id = ce.computer_id
       left join users u on u.id = e.user_id
       left join lateral (
         select jsonb_agg(
           jsonb_build_object(
             'policy_name', pr.policy_name,
             'status', pr.status,
             'severity', pr.severity,
             'explanation', pr.explanation,
             'evidence', pr.evidence
           )
           order by pr.created_at asc
         ) as items
         from policy_results pr
         where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
       ) triggered on true
       where e.decision = 'ask' and e.resolution is null and u.organization_id = $1
       order by e.created_at asc
       limit 20`,
      [organizationId],
    );
    res.json({ pending: pending.rows });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/tray-status", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const [pending, agents] = await Promise.all([
      pool.query(
        `select e.id, e.decision, e.summary, e.question, e.created_at,
                ce.event_name, ce.tool_name, ce.project_path, ce.payload,
                ar.display_name as agent_name, ar.kind as agent_kind,
                c.hostname, u.display_name as user_name,
                coalesce(triggered.items, '[]'::jsonb) as triggered_policies
         from evaluations e
         join conversation_events ce on ce.id = e.conversation_event_id
         join agent_runtimes ar on ar.id = ce.agent_runtime_id
         join computers c on c.id = ce.computer_id
         left join users u on u.id = e.user_id
         left join lateral (
           select jsonb_agg(
             jsonb_build_object(
               'policy_name', pr.policy_name,
               'status', pr.status,
               'severity', pr.severity,
               'explanation', pr.explanation,
               'evidence', pr.evidence
             )
             order by pr.created_at asc
           ) as items
           from policy_results pr
           where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
         ) triggered on true
         where e.decision = 'ask' and e.resolution is null and u.organization_id = $1
         order by e.created_at asc
         limit 20`,
        [organizationId],
      ),
      pool.query(
        `select ar.id, ar.kind, ar.display_name, ar.version, ar.last_seen_at,
                c.hostname, u.display_name as user_name,
                latest.event_name, latest.tool_name, latest.project_path, latest.prompt,
                latest.payload, latest.created_at as activity_at,
                ev.id as decision_id, ev.decision, ev.resolution, ev.resolved_at, ev.summary as decision_summary, ev.question,
                coalesce(triggered.items, '[]'::jsonb) as triggered_policies,
                coalesce(recent.items, '[]'::jsonb) as recent_activity
         from agent_runtimes ar
         join computers c on c.id = ar.computer_id
         left join users u on u.id = c.user_id
         left join lateral (
           select *
           from conversation_events ce
           where ce.agent_runtime_id = ar.id
           order by ce.created_at desc
           limit 1
         ) latest on true
         left join evaluations ev on ev.conversation_event_id = latest.id
         left join lateral (
           select jsonb_agg(
             jsonb_build_object(
               'policy_name', pr.policy_name,
               'status', pr.status,
               'severity', pr.severity,
               'explanation', pr.explanation,
               'evidence', pr.evidence
             )
             order by pr.created_at asc
           ) as items
           from policy_results pr
           where pr.evaluation_id = ev.id and pr.status in ('failed', 'needs_question')
         ) triggered on true
         left join lateral (
           select jsonb_agg(
             jsonb_build_object(
               'event_name', item.event_name,
               'tool_name', item.tool_name,
               'project_path', item.project_path,
               'created_at', item.created_at,
               'decision', item.decision,
               'summary', item.summary
             )
             order by item.created_at desc
           ) as items
           from (
             select ce.event_name, ce.tool_name, ce.project_path, ce.created_at, e.decision, e.summary
             from conversation_events ce
             left join evaluations e on e.conversation_event_id = ce.id
             where ce.agent_runtime_id = ar.id
             order by ce.created_at desc
             limit 5
           ) item
         ) recent on true
         where u.organization_id = $1
           and (ar.last_seen_at > now() - interval '5 minutes'
             or latest.created_at > now() - interval '5 minutes')
         order by greatest(ar.last_seen_at, coalesce(latest.created_at, ar.last_seen_at)) desc
         limit 12`,
        [organizationId],
      ),
    ]);

    res.json({
      pending: pending.rows,
      agents: agents.rows.map((agent) => ({
        ...agent,
        short_summary: summarizeAgentActivity(agent),
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/decisions/:id", async (req, res, next) => {
  try {
    const auth = req.header("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const user = token ? await getUserByToken(token) : undefined;
    if (!user)
      return res.status(401).json({ error: "invalid OpenLeash token" });

    const decision = await pool.query(
      `select id, decision, resolution, summary, question, resolved_at
       from evaluations
       where id = $1 and user_id = $2`,
      [req.params.id, user.id],
    );
    res.json(decision.rows[0] ?? null);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/decisions/:id/resolve", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const scopedDecision = await pool.query(
      `select 1 from evaluations e
       join users u on u.id = e.user_id
       where e.id = $1 and u.organization_id = $2`,
      [req.params.id, organizationId],
    );
    if (!scopedDecision.rows[0]) return res.status(404).json({ error: "decision not found" });
    const resolution = req.body.resolution === "allow" ? "allow" : "deny";
    const result = await resolveApprovalGroup(
      req.params.id,
      resolution,
      req.body.resolvedBy ?? "local-user",
      {},
      req.body.resolutionGuidance,
    );
    res.json(result ?? null);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/users", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const token = `ol_${crypto.randomBytes(24).toString("base64url")}`;
    const user = await pool.query(
      `insert into users (organization_id, email, display_name, role, token_hash)
       values ($1, $2, $3, $4, $5)
       returning id, email, display_name, role, created_at`,
      [
        organizationId,
        req.body.email,
        req.body.displayName,
        req.body.role ?? "engineer",
        hashToken(token),
      ],
    );
    res.status(201).json({ user: user.rows[0], token });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/deployment-tokens", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const tokens = await pool.query(
      `select id, label, mode, tenant_url, mdm, expires_at, revoked_at, created_at, last_used_at
       from deployment_tokens
       where organization_id = $1
       order by created_at desc
       limit 50`,
      [organizationId],
    );
    res.json({ tokens: tokens.rows });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/deployment-tokens", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const organizationResult = await pool.query<{ deployment_mode: string | null }>(
      `select deployment_mode from organizations where id = $1 limit 1`,
      [organizationId],
    );
    const organizationMode = organizationResult.rows[0]?.deployment_mode === "private" ? "private" : "cloud";
    const token = `ol_deploy_${crypto.randomBytes(24).toString("base64url")}`;
    const label =
      String(req.body.label ?? "MDM deployment").trim() || "MDM deployment";
    const mode = req.body.mode === "private" ? "private" : "cloud";
    if (mode !== organizationMode) {
      return res.status(400).json({
        error: `This organization is configured for OpenLeash ${organizationMode === "private" ? "Private Cloud" : "Cloud"}; a ${mode} deployment token cannot be issued.`,
      });
    }
    const tenantUrl = String(
      req.body.tenantUrl ?? process.env.OPENLEASH_TENANT_URL ?? "openleash.com",
    ).trim();
    if (!tenantUrl) {
      return res.status(400).json({ error: "A Leash Engine URL is required." });
    }
    if (mode === "private") {
      try {
        const parsedTenantUrl = new URL(tenantUrl);
        if (!["http:", "https:"].includes(parsedTenantUrl.protocol)) throw new Error("unsupported protocol");
      } catch {
        return res.status(400).json({
          error: "Private Cloud enrollment requires the full reachable Leash Engine URL, including https://.",
        });
      }
    }
    const mdm =
      typeof req.body.mdm === "string" && req.body.mdm.trim()
        ? req.body.mdm.trim()
        : null;
    const expiresInDays = Number(req.body.expiresInDays ?? 30);
    const result = await pool.query(
      `insert into deployment_tokens (organization_id, label, token_hash, mode, tenant_url, mdm, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + ($7::text || ' days')::interval)
       returning id, label, mode, tenant_url, mdm, expires_at, created_at`,
      [
        organizationId,
        label,
        hashToken(token),
        mode,
        tenantUrl,
        mdm,
        Number.isFinite(expiresInDays)
          ? Math.max(1, Math.min(365, expiresInDays))
          : 30,
      ],
    );
    res.status(201).json({
      token,
      deploymentToken: result.rows[0],
      command: enrollmentCommand(tenantUrl, token),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/deployment-tokens/:id/revoke", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const result = await pool.query(
      `update deployment_tokens set revoked_at = now()
       where id = $1 and organization_id = $2
       returning id, revoked_at`,
      [req.params.id, organizationId],
    );
    res.json(result.rows[0] ?? null);
  } catch (error) {
    next(error);
  }
});

app.get("/admin/events/:id", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const event = await pool.query(
      `select ce.*, e.decision, e.summary, e.question
       from conversation_events ce
       left join evaluations e on e.conversation_event_id = ce.id
       join computers c on c.id = ce.computer_id
       join users u on u.id = c.user_id
       where ce.id = $1 and u.organization_id = $2`,
      [req.params.id, organizationId],
    );
    res.json(event.rows[0] ?? null);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/policies", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const naturalLanguageRule = String(
      req.body.naturalLanguageRule ?? req.body.rule ?? "",
    ).trim();
    if (!naturalLanguageRule) {
      return res.status(400).json({
        error: "naturalLanguageRule is required",
      });
    }
    const name = summarizePolicyTitle(naturalLanguageRule);
    const category = policyCategory(
      String(req.body.category ?? ""),
      name,
      naturalLanguageRule,
    );
    const result = await pool.query(
      `insert into policies (organization_id, name, category, description, severity, natural_language_rule, enabled, locked)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        organizationId,
        name,
        category,
        req.body.description ?? "",
        req.body.severity ?? "medium",
        naturalLanguageRule,
        req.body.enabled ?? true,
        Boolean(req.body.locked),
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.get("/admin/plugins", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    res.json(await pluginCatalogForOrganization(organizationId));
  } catch (error) {
    next(error);
  }
});

app.get("/v1/plugins", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const agentKind = optionalString(req.query.agentKind);
    const agentId = await validatedAgentRuntimeId(
      session.user.id,
      agentKind,
      optionalString(req.query.agentId),
    );
    res.json(await pluginCatalogForOrganization(
      session.organization.id,
      session.user.id,
      { agentKind, agentId },
    ));
  } catch (error) {
    next(error);
  }
});

// Compatibility tombstone: Leash ships a closed set of built-in Features.
// These former marketplace and upload endpoints remain explicit so old clients
// receive a deterministic migration response instead of finding a shadow API.
app.all([
  "/v1/plugin-marketplace",
  "/public/plugins",
  "/public/plugins/:slug",
  "/admin/plugin-marketplace",
  "/admin/plugin-marketplace/policy",
  "/admin/plugin-releases",
  "/admin/plugin-releases/:id/approve",
  "/admin/plugin-releases/:id/reject",
  "/admin/plugin-releases/:id/yank",
  "/v1/plugin-submissions",
  "/v1/plugin-releases",
], (_req, res) => {
  res.status(410).json({
    error: "Leash Features are built in. The plugin marketplace and third-party upload API have been retired.",
  });
});

app.get("/v1/plugin-marketplace", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    res.json(
      await pluginMarketplaceForOrganization(
        session.organization.id,
        String(req.query.search ?? ""),
        { userId: session.user.id },
      ),
    );
  } catch (error) {
    next(error);
  }
});

app.get("/public/plugins", async (req, res, next) => {
  try {
    res.json({
      listings: await readMarketplaceListings(String(req.query.search ?? "")),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/public/plugins/:slug", async (req, res, next) => {
  try {
    const plugin = await readMarketplaceListingBySlug(req.params.slug);
    if (!plugin) return res.status(404).json({ error: "plugin not found" });
    res.json(plugin);
  } catch (error) {
    next(error);
  }
});

app.get("/admin/plugin-marketplace", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    res.json(
      await pluginMarketplaceForOrganization(
        organizationId,
        String(req.query.search ?? ""),
        { includePending: true },
      ),
    );
  } catch (error) {
    next(error);
  }
});

app.get("/admin/plugin-releases", async (req, res, next) => {
  try {
    if (!requirePluginReleaseAdmin(req, res)) return;
    res.json({
      releases: await listPluginReleases(String(req.query.status ?? "")),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/plugin-releases/:id/approve", async (req, res, next) => {
  try {
    if (!requirePluginReleaseAdmin(req, res)) return;
    const result = await approvePluginRelease(
      req.params.id,
      undefined,
      req.body,
    );
    if (!result)
      return res.status(404).json({ error: "plugin release not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/plugin-releases/:id/reject", async (req, res, next) => {
  try {
    if (!requirePluginReleaseAdmin(req, res)) return;
    const result = await reviewPluginRelease(
      req.params.id,
      "rejected",
      undefined,
      req.body?.reviewerNote,
    );
    if (!result)
      return res.status(404).json({ error: "plugin release not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/plugin-releases/:id/yank", async (req, res, next) => {
  try {
    if (!requirePluginReleaseAdmin(req, res)) return;
    const result = await reviewPluginRelease(
      req.params.id,
      "yanked",
      undefined,
      req.body?.reviewerNote,
    );
    if (!result)
      return res.status(404).json({ error: "plugin release not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/plugins/:pluginId/settings", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const result = await savePluginSettingsForOrganization(
      organizationId,
      req.params.pluginId,
      req.body,
    );
    if (!result) return res.status(404).json({ error: "plugin not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/plugins/:pluginId/update", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const result = await updateMarketplacePluginForOrganization(
      organizationId,
      req.params.pluginId,
    );
    if (!result)
      return res
        .status(404)
        .json({ error: "plugin not found or not installed" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/plugins/:pluginId/policy", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const result = await saveOrganizationPluginPolicy(
      organizationId,
      req.params.pluginId,
      req.body,
    );
    if (!result) return res.status(404).json({ error: "plugin not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/plugin-marketplace/policy", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    res.json(await saveOrganizationMarketplacePolicy(organizationId, req.body));
  } catch (error) {
    next(error);
  }
});

app.post("/v1/plugins/:pluginId/settings", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const result = await savePluginSettingsForUser(
      session.organization.id,
      session.user.id,
      req.params.pluginId,
      req.body,
    );
    if (!result) return res.status(404).json({ error: "plugin not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/v1/plugins/:pluginId/install", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const result = await savePluginSettingsForUser(
      session.organization.id,
      session.user.id,
      req.params.pluginId,
      { enabled: true },
    );
    if (!result)
      return res
        .status(404)
        .json({ error: "Feature not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/v1/plugins/:pluginId/update", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const catalog = await pluginCatalogForOrganization(
      session.organization.id,
      session.user.id,
    );
    const result = catalog.plugins.find((feature) => feature.id === req.params.pluginId);
    if (!result)
      return res
        .status(404)
        .json({ error: "Feature not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/v1/plugins/:pluginId/uninstall", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const result = await savePluginSettingsForUser(
      session.organization.id,
      session.user.id,
      req.params.pluginId,
      { enabled: false },
    );
    if (!result)
      return res.status(404).json({ error: "Feature not found" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/v1/plugin-submissions", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const submission = await createPluginSubmission(
      session.organization.id,
      session.user.id,
      req.body,
    );
    res.status(201).json(submission);
  } catch (error) {
    next(error);
  }
});

app.post("/v1/plugin-releases", async (req, res, next) => {
  try {
    const session = await getClientOrDashboardSession(
      req.header("authorization") ?? "",
    );
    if (!session)
      return res.status(401).json({ error: "invalid OpenLeash session" });
    const release = await createPluginReleaseSubmission(
      session.organization.id,
      session.user.id,
      req.body,
    );
    res.status(201).json(release);
  } catch (error) {
    next(error);
  }
});

type ApiUser = {
  id: string;
  email?: string;
  display_name?: string;
  organization_id?: string | null;
  desktop_computer_id?: string | null;
};

async function upsertActivityComputer(
  client: PoolClient,
  user: ApiUser,
  computer: { hostname: string; platform: string; osRelease?: string | null },
) {
  if (user.desktop_computer_id) {
    const bound = await client.query<{ id: string }>(
      `update computers
       set hostname = $3, platform = $4, os_release = $5, last_seen_at = now()
       where id = $1 and user_id = $2
       returning id`,
      [
        user.desktop_computer_id,
        user.id,
        computer.hostname,
        computer.platform,
        computer.osRelease ?? null,
      ],
    );
    if (!bound.rows[0]) {
      throw new HttpError(
        409,
        "This desktop credential is no longer bound to an enrolled computer.",
      );
    }
    return bound.rows[0].id;
  }

  // Legacy/local tokens retain hostname reconciliation. A managed Cloud
  // database rejects any new computer without an installation identity, so
  // this cannot bypass hosted device capacity.
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `openleash-legacy-computer:${user.id}`,
  ]);
  const existing = await client.query<{ id: string }>(
    `update computers
     set platform = $3, os_release = $4, last_seen_at = now()
     where user_id = $1 and hostname = $2 and install_identity is null
     returning id`,
    [user.id, computer.hostname, computer.platform, computer.osRelease ?? null],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await client.query<{ id: string }>(
    `insert into computers (user_id, hostname, platform, os_release, last_seen_at)
     values ($1, $2, $3, $4, now())
     returning id`,
    [user.id, computer.hostname, computer.platform, computer.osRelease ?? null],
  );
  return inserted.rows[0].id;
}

async function handlePromptOnlyHook(
  agent: HookAgentSlug,
  eventName: HookEventName,
  request: EvaluationRequest,
  user: ApiUser,
  responseFormat: "native" | "proxy" = "native",
) {
  const intentKey = triggerIntentKey(request);
  const handledIntent = intentKey
    ? await findRecentHandledIntent(user.id, request, intentKey)
    : undefined;
  if (handledIntent) {
    const reused: EvaluationResponse = {
      decision: handledIntent.resolution ?? handledIntent.decision,
      decisionId: handledIntent.id,
      summary: handledIntent.summary,
      question: handledIntent.resolution
        ? undefined
        : (handledIntent.question ?? undefined),
      results: [],
    };
    const resolved = await waitForHookDecision(user, reused);
    if (responseFormat === "proxy") {
      return { ...resolved, finalPrompt: request.event.prompt };
    }
    return nativeHookDecision(agent, eventName, resolved);
  }
  const { conversationEventId, computerId, runtimeId, organizationId } =
    await recordConversationEvent(request, user, intentKey);
  const containerRuns = await recordContainerRuntimeRuns({ request, organizationId, conversationEventId, userId: user.id, computerId, runtimeId });
  const [config, runtimePlugins, tenantModelKey, policies] = await Promise.all([
    readPromptTransformConfig(organizationId, user.id, request.agent.kind, runtimeId || request.agent.instanceId, request.event.projectPath),
    pluginSettingsForRuntime(organizationId, user.id, request.agent.kind, runtimeId || request.agent.instanceId, request.event.projectPath),
    tenantModelKeyForEvaluation(organizationId),
    pool.query<Policy>(
      `select id, name, description, severity, natural_language_rule as "naturalLanguageRule", enabled, locked
       from policies where organization_id = $1 and enabled = true order by created_at asc`,
      [organizationId],
    ),
  ]);
  const promptEvaluation =
    request.event.prompt && promptTransformsEnabled(config)
      ? runPromptPipeline({
          request,
          config,
          organizationId,
          conversationEventId,
          userId: user.id,
          computerId,
          runtimeId,
          tenantModelKey,
          plugins: runtimePlugins,
        })
      : Promise.resolve(undefined);
  const runtimePolicies = policiesForEvaluation(
    policies.rows,
    runtimePlugins,
  );
  const evaluationPlugins = pluginsWithPolicyEngine(
    runtimePlugins,
    policies.rows.length > 0,
  );
  const [promptResult, pipeline] = await Promise.all([
    promptEvaluation,
    runEvaluationPipeline({
      request,
      organizationId,
      conversationEventId,
      userId: user.id,
      computerId,
      runtimeId,
      policies: runtimePolicies,
      tenantModelKey,
      plugins: evaluationPlugins,
    }),
  ]);
  if (promptResult) {
    await recordPromptTransformResult(
      conversationEventId,
      user.id,
      request.event.prompt ?? "",
      promptResult,
    );
  }
  const results = applyConfiguredRuleActions(pipeline.results, runtimePolicies);
  const decision =
    promptResult?.blocked ||
    results.some((result) => result.status === "failed")
      ? "deny"
      : promptResult?.requiresApproval ||
          results.some((result) => result.status === "needs_question")
        ? "ask"
        : "allow";
  const blockingResult = results.find((result) => result.status === "failed");
  const reviewResult = results.find(
    (result) => result.status === "needs_question",
  );
  const summary = promptResult?.blocked
    ? promptResult.summary
    : promptResult?.requiresApproval
      ? promptResult.summary
      : (blockingResult?.explanation ??
        reviewResult?.explanation ??
        promptResult?.summary ??
        "Leash logged this prompt intent.");
  const question =
    reviewResult?.question ??
    (decision === "ask"
      ? promptResult?.requiresApproval
        ? `${request.agent.displayName} is waiting because a plugin safety check failed. Allow this action once?`
        : `${request.agent.displayName} wants to proceed with sensitive access. Allow it once?`
      : undefined);
  const runtimePolicy = await runtimePolicyForUser(user);
  const evaluation = await pool.query<{ id: string }>(
    `insert into evaluations (conversation_event_id, user_id, decision, summary, question, model)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      conversationEventId,
      user.id,
      decision,
      summary,
      question ?? null,
      pipeline.model,
    ],
  );
  for (const result of results) {
    const policyId = resolvePolicyResultPolicyId(result, policies.rows);
    await pool.query(
      `insert into policy_results
       (evaluation_id, policy_id, policy_name, status, severity, explanation, evidence, question)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        evaluation.rows[0].id,
        policyId,
        result.policyName,
        result.status,
        result.severity,
        result.explanation,
        JSON.stringify(result.evidence ?? []),
        result.question ?? null,
      ],
    );
  }
  await recordPluginRuns(conversationEventId, [
    ...containerRuns,
    ...(promptResult?.runs ?? []),
    ...pipeline.runs,
  ]);
  if (decision === "ask") {
    const purposeSummary = await summarizeActionPurpose(
      request,
      tenantModelKey,
    );
    const notification = runtimePolicy.enforcementMode === "learning"
      ? notifyMobileEvent(user.id, {
          title: "Leash observed an action in learning mode",
          body: summary,
          data: { decisionId: evaluation.rows[0].id, kind: "learning_only" },
        })
      : notifyMobileApprovers(
          user.id,
          evaluation.rows[0].id,
          summary,
          question,
          purposeSummary,
          attentionKindForTool(request.event.tool?.name ?? ""),
        );
    notification.catch((error) => {
      console.warn("mobile approval notification failed", error);
    });
  } else if (decision === "deny") {
    notifyMobileEvent(user.id, {
      title: runtimePolicy.enforcementMode === "learning"
        ? "Leash observed an action in learning mode"
        : "Leash blocked an agent action",
      body: summary,
      data: {
        decisionId: evaluation.rows[0].id,
        kind: runtimePolicy.enforcementMode === "learning" ? "learning_only" : "blocked",
      },
    }).catch((error) => {
      console.warn("mobile blocked notification failed", error);
    });
  }
  const response: EvaluationResponse = {
    decision,
    decisionId: evaluation.rows[0].id,
    summary,
    question,
    results,
  };
  const resolvedDecision = await waitForHookDecision(user, response);
  const finalPrompt =
    resolvedDecision.decision === "allow" && promptResult
      ? promptResult.finalPrompt
      : request.event.prompt;
  if (responseFormat === "proxy") {
    return { ...resolvedDecision, finalPrompt };
  }
  if (
    resolvedDecision.decision === "allow" &&
    promptResult &&
    promptResult.finalPrompt !== request.event.prompt
  ) {
    return promptTransformHookDecision(
      agent,
      eventName,
      promptResult.finalPrompt,
      promptResult.summary,
    );
  }
  return nativeHookDecision(agent, eventName, resolvedDecision);
}

async function readPromptTransformConfig(
  organizationId: string,
  userId?: string,
  agentKind?: string,
  agentId?: string,
  projectPath?: string,
): Promise<PromptTransformConfig> {
  const row = await pool.query<{ config: unknown }>(
    "select config from prompt_transform_settings where organization_id = $1",
    [organizationId],
  );
  const config = normalizePromptTransformConfig(
    row.rows[0]?.config ?? defaultPromptTransformConfig,
  );
  const [pluginSettings, userPluginSettings, policy, groupIds] = await Promise.all([
    readPluginSettings(organizationId),
    userId
      ? readUserPluginSettings(organizationId, userId)
      : Promise.resolve(new Map<string, PluginSettingRecord>()),
    readOrganizationPluginPolicy(organizationId),
    userId ? identityGroupIdsForUser(organizationId, userId) : Promise.resolve([]),
  ]);
  const effectiveTransformPlugin = (pluginId: string) => {
    const organizationStored = pluginSettings.get(pluginId);
    const userStored = userPluginSettings.get(pluginId);
    const pluginPolicy = policy.get(pluginId);
    const configLocked = Boolean(pluginPolicy?.configLocked);
    if (!organizationStored && !userStored && !pluginPolicy) return undefined;
    return resolvePluginSettingProfiles({
      enabled: pluginPolicy?.mandatory
        ? true
        : (userStored?.enabled ??
          organizationStored?.enabled ??
          pluginPolicy?.defaultEnabled ??
          false),
      config: {
        ...(organizationStored?.config ?? {}),
        ...(configLocked ? {} : (userStored?.config ?? {})),
      },
      organizationProfiles: organizationStored?.profiles,
      userProfiles: userStored?.profiles,
      agentKind,
      agentId,
      projectPath,
      userId,
      groupIds,
      configLocked,
    });
  };
  const compression = effectiveTransformPlugin("openleash.prompt-compression");
  if (compression) {
    config.compression = normalizePromptTransformConfig({
      compression: {
        ...config.compression,
        ...(compression.config ?? {}),
        enabled: compression.enabled,
      },
    }).compression;
  }
  const dlp = effectiveTransformPlugin("openleash.dlp");
  if (dlp) {
    config.dlp = normalizePromptTransformConfig({
      dlp: {
        ...config.dlp,
        ...(dlp.config ?? {}),
        enabled: dlp.enabled,
      },
    }).dlp;
  }
  return config;
}

type PluginSettingRecord = {
  pluginId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  profiles: PluginSettingProfile[];
  orderingPriority: number | null;
  installedVersion?: string;
  updatePolicy?: "manual" | "patch" | "minor" | "locked";
  updatedAt?: string;
};

type PluginPolicyRecord = {
  pluginId: string;
  mandatory: boolean;
  defaultEnabled: boolean;
  userInstallAllowed: boolean;
  configLocked: boolean;
};

type MarketplacePolicyRecord = {
  allowUserMarketplaceInstalls: boolean;
  allowUserCommunityPlugins: boolean;
};

async function pluginCatalogForOrganization(
  organizationId: string,
  userId?: string,
  options: { agentKind?: string; agentId?: string; projectPath?: string } = {},
): Promise<{
  plugins: PluginCatalogItem[];
}> {
  const [settings, userSettings, groupIds] = await Promise.all([
    readPluginSettings(organizationId),
    userId
      ? readUserPluginSettings(organizationId, userId)
      : Promise.resolve(new Map<string, PluginSettingRecord>()),
    userId ? identityGroupIdsForUser(organizationId, userId) : Promise.resolve([]),
  ]);
  return {
    plugins: firstPartyPluginManifests.map((manifest) => pluginCatalogItem(
      manifest,
      settings.get(manifest.id),
      userSettings.get(manifest.id),
      undefined,
      undefined,
      undefined,
      new Map(),
      options.agentKind,
      options.agentId,
      options.projectPath,
      Boolean(userId),
      userId,
      groupIds,
    )),
  };
}

function pluginCatalogItem(
  manifest: OpenLeashPluginManifest,
  organizationSettings?: PluginSettingRecord,
  userSettings?: PluginSettingRecord,
  marketplace?: PluginMarketplaceListing,
  policy?: PluginPolicyRecord,
  marketplacePolicy?: MarketplacePolicyRecord,
  approvedReleases: Map<string, OpenLeashPluginManifest> = new Map(),
  agentKind?: string,
  agentId?: string,
  projectPath?: string,
  userScoped = false,
  userId?: string,
  groupIds: string[] = [],
): PluginCatalogItem {
  const baseEnabled =
    userSettings?.enabled ??
    organizationSettings?.enabled ??
    Boolean(manifest.defaultConfig?.enabled);
  const configLocked = false;
  const availableVersion = manifest.version;
  const installedVersion =
    userSettings?.installedVersion ??
      organizationSettings?.installedVersion ??
    (baseEnabled ? availableVersion : undefined);
  const selectedManifest = manifest;
  const releaseAvailable =
    manifest.runtime === "builtin" &&
    manifest.execution?.type === "in-process" &&
    manifest.entrypoint === "client-api";
  const environmentAvailable = pluginExecutionAvailable(productMode, selectedManifest.executionEnvironment);
  const runtimeAvailable = releaseAvailable && environmentAvailable;
  const baseConfig = {
    ...(manifest.defaultConfig ?? {}),
    ...(organizationSettings?.config ?? {}),
    ...(configLocked ? {} : (userSettings?.config ?? {})),
  };
  const organizationProfiles = organizationSettings?.profiles ?? [];
  const userProfiles = configLocked ? [] : (userSettings?.profiles ?? []);
  const resolved = resolvePluginSettingProfiles({
    enabled: baseEnabled,
    config: baseConfig,
    organizationProfiles,
    userProfiles,
    agentKind,
    agentId,
    projectPath,
    userId,
    groupIds,
    mergeArrayKeys: manifest.id === "openleash.rules-enforcer" ? ["rules"] : [],
    configLocked,
    mandatory: policy?.mandatory,
  });
  return {
    ...selectedManifest,
    slug: manifest.slug ?? marketplace?.slug,
    repositoryUrl: manifest.repositoryUrl ?? marketplace?.repositoryUrl,
    marketplace,
    settings: {
      enabled: resolved.enabled,
      config: resolved.config,
      profiles: userScoped ? userProfiles : organizationProfiles,
      inheritedProfiles: userScoped ? organizationProfiles : [],
      effectiveProfileIds: resolved.effectiveProfileIds,
      runtimeAvailable,
      ...(runtimeAvailable ? {} : {
        runtimeError: environmentAvailable
          ? `${selectedManifest.name} has no registered built-in Feature handler.`
          : `${selectedManifest.name} runs only in Leash Cloud and is unavailable in ${productMode.label}.`,
      }),
      orderingPriority:
        userSettings?.orderingPriority ??
        organizationSettings?.orderingPriority ??
        manifest.ordering?.priority ??
        null,
      installedVersion,
      availableVersion,
      updateAvailable: Boolean(installedVersion && installedVersion !== availableVersion),
      updatePolicy:
        userSettings?.updatePolicy ??
        organizationSettings?.updatePolicy ??
        "manual",
      updatedAt: userSettings?.updatedAt ?? organizationSettings?.updatedAt,
    },
  };
}

async function identityGroupIdsForUser(organizationId: string, userId: string) {
  const result = await pool.query<{ id: string }>(
    `select igm.group_id::text as id
     from identity_group_members igm
     join identity_groups ig on ig.id = igm.group_id
     where ig.organization_id = $1 and igm.user_id = $2`,
    [organizationId, userId],
  );
  return result.rows.map((row) => row.id);
}

function pluginManifestFromRelease(release: ReturnType<typeof pluginReleaseFromRow>): OpenLeashPluginManifest {
  return {
    id: release.pluginId,
    slug: release.slug,
    name: release.name,
    description: release.description,
    repositoryUrl: release.repositoryUrl,
    version: release.version,
    publisher: release.publisher,
    runtime: release.runtime as OpenLeashPluginManifest["runtime"],
    execution: release.execution as OpenLeashPluginManifest["execution"],
    executionEnvironment: release.executionEnvironment as OpenLeashPluginManifest["executionEnvironment"],
    entrypoint: release.entrypoint,
    events: release.events as OpenLeashPluginManifest["events"],
    permissions: release.permissions as OpenLeashPluginManifest["permissions"],
    effects: release.effects as OpenLeashPluginManifest["effects"],
    ordering: release.ordering as OpenLeashPluginManifest["ordering"],
    configSchema: release.configSchema as OpenLeashPluginManifest["configSchema"],
    defaultConfig: release.defaultConfig,
    tags: release.tags,
  };
}

function assertPluginExecutionAvailable(
  manifest: OpenLeashPluginManifest,
  marketplace?: unknown,
) {
  if (
    manifest.runtime !== "builtin" ||
    manifest.execution?.type !== "in-process" ||
    manifest.entrypoint !== "client-api"
  ) {
    throw new HttpError(409, `${manifest.name} has no registered built-in Feature handler.`);
  }
  if (pluginExecutionAvailable(productMode, manifest.executionEnvironment)) return;
  throw new HttpError(
    409,
    `${manifest.name} runs only in Leash Cloud and is unavailable in ${productMode.label}.`,
  );
}

function validContainerManifest(
  manifest: OpenLeashPluginManifest,
  requireDigest: boolean,
) {
  const execution = manifest.execution;
  return Boolean(
    manifest.runtime === "container" &&
    execution?.type === "container" &&
    execution.protocol === "openleash-container-plugin.v1" &&
    optionalString(execution.image) &&
    optionalString(execution.eventPath) &&
    (!requireDigest || /^sha256:[a-f0-9]{64}$/.test(execution.digest ?? "")),
  );
}

async function savePluginSettingsForOrganization(
  organizationId: string,
  pluginId: string,
  body: Record<string, unknown>,
) {
  const manifest = await manifestForPluginId(pluginId, body.marketplace);
  if (!manifest) return undefined;
  const policy = (await readOrganizationPluginPolicy(organizationId)).get(
    pluginId,
  );
  const currentSettings = (await readPluginSettings(organizationId)).get(pluginId);
  const requestedProfiles = Array.isArray(body.profiles)
    ? normalizePluginSettingProfiles(body.profiles)
    : undefined;
  const enabled = policy?.mandatory
    ? true
    : typeof body.enabled === "boolean"
      ? body.enabled
      : (currentSettings?.enabled ?? true);
  if (
    (!currentSettings?.enabled && enabled) ||
    requestedProfiles?.some((profile) => profile.enabled === true)
  ) {
    assertPluginExecutionAvailable(manifest, body.marketplace);
  }
  const config =
    body.config &&
    typeof body.config === "object" &&
    !Array.isArray(body.config)
      ? (body.config as Record<string, unknown>)
      : (currentSettings?.config ?? manifest.defaultConfig ?? {});
  const orderingPriority = Number.isFinite(Number(body.orderingPriority))
    ? Number(body.orderingPriority)
    : (currentSettings?.orderingPriority ?? manifest.ordering?.priority ?? null);
  const requestedInstalledVersion = optionalString(body.installedVersion);
  const availableVersion = manifest.version;
  const updatePolicy = pluginUpdatePolicy(body.updatePolicy);
  const profiles = requestedProfiles
    ? requestedProfiles
    : (currentSettings?.profiles ?? []);
  const result = await pool.query(
    `insert into plugin_settings (organization_id, plugin_id, enabled, config, profiles, ordering_priority, installed_version, update_policy, updated_at)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, coalesce($7, $9), coalesce($8, 'manual'), now())
     on conflict (organization_id, plugin_id) do update set
       enabled = excluded.enabled,
       config = excluded.config,
       profiles = excluded.profiles,
       ordering_priority = excluded.ordering_priority,
       installed_version = coalesce($7, plugin_settings.installed_version, excluded.installed_version),
       update_policy = coalesce($8, plugin_settings.update_policy, 'manual'),
       updated_at = now()
     returning plugin_id, enabled, config, profiles, ordering_priority as "orderingPriority",
               installed_version as "installedVersion", update_policy as "updatePolicy", updated_at`,
    [
      organizationId,
      manifest.id,
      enabled,
      JSON.stringify(config),
      JSON.stringify(profiles),
      orderingPriority,
      requestedInstalledVersion,
      updatePolicy,
      availableVersion,
    ],
  );
  return { pluginId: manifest.id, settings: result.rows[0] };
}

async function savePluginSettingsForUser(
  organizationId: string,
  userId: string,
  pluginId: string,
  body: Record<string, unknown>,
) {
  const manifest = await manifestForPluginId(pluginId);
  if (!manifest) return undefined;
  const [organizationSettings, currentUserSettings] = await Promise.all([
    readPluginSettings(organizationId),
    readUserPluginSettings(organizationId, userId),
  ]);
  const organizationSetting = organizationSettings.get(manifest.id);
  const currentUserSetting = currentUserSettings.get(manifest.id);
  const requestedProfiles = Array.isArray(body.profiles)
    ? normalizePluginSettingProfiles(body.profiles)
    : undefined;
  const currentlyEnabled = currentUserSetting?.enabled ??
    organizationSetting?.enabled ??
    Boolean(manifest.defaultConfig?.enabled);
  const enabled = typeof body.enabled === "boolean" ? body.enabled : currentlyEnabled;
  if ((!currentlyEnabled && enabled) || requestedProfiles?.some((profile) => profile.enabled === true)) {
    assertPluginExecutionAvailable(manifest, body.marketplace);
  }
  const config = body.config &&
        typeof body.config === "object" &&
        !Array.isArray(body.config)
      ? (body.config as Record<string, unknown>)
      : (currentUserSetting?.config ?? {});
  const orderingPriority = Number.isFinite(Number(body.orderingPriority))
      ? Number(body.orderingPriority)
      : (currentUserSetting?.orderingPriority ?? organizationSetting?.orderingPriority ??
        manifest.ordering?.priority ??
        null);
  const requestedInstalledVersion = optionalString(body.installedVersion);
  const availableVersion = manifest.version;
  const updatePolicy = pluginUpdatePolicy(body.updatePolicy);
  const profiles = requestedProfiles
    ? requestedProfiles
    : (currentUserSetting?.profiles ?? []);
  const result = await pool.query<{
    plugin_id: string;
    enabled: boolean;
    config: Record<string, unknown>;
    profiles: PluginSettingProfile[];
    orderingPriority: number | null;
    installedVersion: string | null;
    updatePolicy: "manual" | "patch" | "minor" | "locked";
    updated_at: string;
  }>(
    `insert into user_plugin_settings (user_id, organization_id, plugin_id, enabled, config, profiles, ordering_priority, installed_version, update_policy, updated_at)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, coalesce($8, $10), coalesce($9, 'manual'), now())
     on conflict (user_id, plugin_id) do update set
       organization_id = excluded.organization_id,
       enabled = excluded.enabled,
       config = excluded.config,
       profiles = excluded.profiles,
       ordering_priority = excluded.ordering_priority,
       installed_version = coalesce($8, user_plugin_settings.installed_version, excluded.installed_version),
       update_policy = coalesce($9, user_plugin_settings.update_policy, 'manual'),
       updated_at = now()
     returning plugin_id, enabled, config, profiles, ordering_priority as "orderingPriority",
               installed_version as "installedVersion", update_policy as "updatePolicy", updated_at`,
    [
      userId,
      organizationId,
      manifest.id,
      enabled,
      JSON.stringify(config),
      JSON.stringify(profiles),
      orderingPriority,
      requestedInstalledVersion,
      updatePolicy,
      availableVersion,
    ],
  );
  const stored = result.rows[0];
  return {
    pluginId: manifest.id,
    settings: pluginCatalogItem(
      manifest,
      organizationSettings.get(manifest.id),
      {
        pluginId: manifest.id,
        enabled: stored.enabled,
        config: stored.config ?? {},
        profiles: normalizePluginSettingProfiles(stored.profiles),
        orderingPriority: stored.orderingPriority,
        installedVersion: stored.installedVersion ?? undefined,
        updatePolicy: stored.updatePolicy,
        updatedAt: stored.updated_at,
      },
      undefined,
      undefined,
      undefined,
      new Map(),
      undefined,
      undefined,
      undefined,
      true,
    ).settings,
  };
}

async function pluginMarketplaceForOrganization(
  organizationId: string,
  search: string,
  options: { includePending?: boolean; userId?: string } = {},
) {
  const [plugins, marketplacePolicy] = await Promise.all([
    pluginCatalogForOrganization(organizationId, options.userId),
    readOrganizationMarketplacePolicy(organizationId),
  ]);
  let listings = await readMarketplaceListings(search, options);
  if (!marketplacePolicy.allowUserCommunityPlugins) {
    listings = listings.filter((listing) => listing.source === "first_party");
  }
  const installed = new Set(
    plugins.plugins
      .filter((plugin) => plugin.settings.enabled)
      .map((plugin) => plugin.id),
  );
  const mandatory = new Set(
    plugins.plugins
      .filter((plugin) => plugin.organizationPolicy?.mandatory)
      .map((plugin) => plugin.id),
  );
  return {
    marketplacePolicy,
    listings: listings.map((listing) => ({
      ...listing,
      installed: installed.has(listing.id),
      mandatory: mandatory.has(listing.id),
      installable:
        marketplacePolicy.allowUserMarketplaceInstalls ||
        mandatory.has(listing.id) ||
        installed.has(listing.id),
    })),
  };
}

async function readMarketplaceListings(
  search: string,
  options: { includePending?: boolean } = {},
): Promise<PluginMarketplaceListing[]> {
  const query = search.trim();
  const params: unknown[] = [];
  const where = [
    options.includePending
      ? "review_status <> 'rejected'"
      : "review_status = 'approved'",
  ];
  if (query) {
    params.push(query);
    where.push(`(
      to_tsvector('english', slug || ' ' || description || ' ' || short_description || ' ' || coalesce(tags::text, '')) @@ plainto_tsquery('english', $${params.length})
      or slug ilike '%' || $${params.length} || '%'
    )`);
  }
  const rows = await pool.query(
    `select *
     from plugin_marketplace
     where ${where.join(" and ")}
     order by featured_rank nulls last, slug asc
     limit 50`,
    params,
  );
  return rows.rows.map(marketplaceListingFromRow);
}

async function readMarketplaceListingBySlug(
  slug: string,
): Promise<PluginMarketplaceListing | undefined> {
  const rows = await pool.query(
    `select *
     from plugin_marketplace
     where slug = $1 and review_status = 'approved'
     limit 1`,
    [slug],
  );
  return rows.rows[0] ? marketplaceListingFromRow(rows.rows[0]) : undefined;
}

function marketplaceListingFromRow(
  row: Record<string, unknown>,
): PluginMarketplaceListing {
  const slug = String(row.slug);
  return {
    id: String(row.plugin_id),
    slug,
    name: slug,
    description: String(row.description),
    version: String(row.version),
    publisher: String(row.publisher),
    developerName: String(row.developer_name),
    developerUrl: optionalString(row.developer_url),
    source: String(row.source) as PluginMarketplaceListing["source"],
    reviewStatus: String(
      row.review_status,
    ) as PluginMarketplaceListing["reviewStatus"],
    shortDescription: String(row.short_description),
    longDescription: String(row.long_description),
    heroTagline: String(row.hero_tagline),
    packageUrl: optionalString(row.package_url),
    repositoryUrl: normalizedPluginRepositoryUrl(
      String(row.plugin_id),
      slug,
      optionalString(row.repository_url),
    ),
    documentationUrl: optionalString(row.documentation_url),
    runtime: String(row.runtime) as PluginMarketplaceListing["runtime"],
    executionEnvironment: row.execution_environment === "cloud-only" ? "cloud-only" : "any",
    execution: objectValue(row.execution) as PluginMarketplaceListing["execution"],
    entrypoint: String(row.entrypoint),
    events: arrayValue(row.events) as PluginMarketplaceListing["events"],
    permissions: arrayValue(
      row.permissions,
    ) as PluginMarketplaceListing["permissions"],
    effects: arrayValue(row.effects) as PluginMarketplaceListing["effects"],
    ordering: objectValue(row.ordering) as PluginMarketplaceListing["ordering"],
    configSchema: objectValue(
      row.config_schema,
    ) as PluginMarketplaceListing["configSchema"],
    defaultConfig: objectValue(row.default_config) ?? {},
    tags: arrayValue(row.tags),
    iconText: String(row.icon_text ?? "OL"),
    visualPng: optionalString(row.visual_png),
    installCount:
      row.install_count === undefined
        ? undefined
        : Number(row.install_count ?? 0),
    downloadCount:
      row.download_count === undefined
        ? undefined
        : Number(row.download_count ?? 0),
    weeklyDownloadCount:
      row.weekly_download_count === undefined
        ? undefined
        : Number(row.weekly_download_count ?? 0),
    trendPercent:
      row.trend_percent === undefined
        ? undefined
        : Number(row.trend_percent ?? 0),
    rating: row.rating === undefined ? undefined : Number(row.rating ?? 0),
    ratingCount:
      row.rating_count === undefined
        ? undefined
        : Number(row.rating_count ?? 0),
    featuredRank:
      row.featured_rank === null || row.featured_rank === undefined
        ? null
        : Number(row.featured_rank),
    seoTitle: String(row.seo_title),
    seoDescription: String(row.seo_description),
    createdAt: optionalString(row.created_at),
    updatedAt: optionalString(row.updated_at),
  };
}

function normalizedPluginRepositoryUrl(
  pluginId: string,
  slug: string,
  repositoryUrl?: string,
) {
  if (pluginId === "openleash.prompt-compression")
    return "https://github.com/open-leash/plugin-token-saver";
  if (pluginId === "openleash.dlp")
    return "https://github.com/open-leash/plugin-data-leakage-prevention";
  if (pluginId.startsWith("openleash."))
    return `https://github.com/open-leash/plugin-${slug}`;
  if (repositoryUrl === "https://github.com/open-leash/open-leash")
    return undefined;
  if (repositoryUrl === "https://github.com/open-leash/plugins")
    return undefined;
  return repositoryUrl;
}

async function manifestForPluginId(
  pluginId: string,
  _marketplaceInput?: unknown,
): Promise<OpenLeashPluginManifest | undefined> {
  return firstPartyPluginManifests.find(
    (plugin) => plugin.id === pluginId,
  );
}

async function installMarketplacePluginForUser(
  organizationId: string,
  userId: string,
  pluginId: string,
) {
  const manifest = await manifestForPluginId(pluginId);
  if (!manifest) return undefined;
  return savePluginSettingsForUser(organizationId, userId, pluginId, {
    enabled: true,
    config: {
      ...(manifest.defaultConfig ?? {}),
      ...(Object.hasOwn(manifest.defaultConfig ?? {}, "enabled")
        ? { enabled: true }
        : {}),
    },
    installedVersion: manifest.version,
  });
}

function marketplaceListingFromInput(
  pluginId: string,
  input: unknown,
): PluginMarketplaceListing | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const id = optionalString(value.id);
  if (!id || id !== pluginId) return undefined;
  const name = optionalString(value.name) || optionalString(value.slug) || id;
  const description =
    optionalString(value.description) ||
    optionalString(value.shortDescription) ||
    "Leash plugin.";
  const version = optionalString(value.version) || "0.0.0";
  const publisher = optionalString(value.publisher) || "openleash";
  const runtime = optionalString(value.runtime) as
    OpenLeashPluginManifest["runtime"] | undefined;
  const entrypoint = optionalString(value.entrypoint);
  if (!runtime || !entrypoint) return undefined;
  const slug = slugify(optionalString(value.slug) || name || id);
  const shortDescription = sentence(
    optionalString(value.shortDescription) || description,
  );
  const developerName =
    optionalString(value.developerName) ||
    (publisher === "openleash" ? "Leash" : titleize(publisher));
  return {
    id,
    slug,
    name,
    description,
    repositoryUrl: optionalString(value.repositoryUrl),
    version,
    publisher,
    developerName,
    developerUrl: optionalString(value.developerUrl),
    source: (["first_party", "community", "private"].includes(
      String(value.source),
    )
      ? String(value.source)
      : publisher === "openleash"
        ? "first_party"
        : "community") as PluginMarketplaceListing["source"],
    reviewStatus: "approved",
    shortDescription,
    longDescription: optionalString(value.longDescription) || description,
    heroTagline: optionalString(value.heroTagline) || shortDescription,
    packageUrl: optionalString(value.packageUrl),
    documentationUrl: optionalString(value.documentationUrl),
    runtime,
    executionEnvironment: value.executionEnvironment === "cloud-only" ? "cloud-only" : "any",
    execution: objectValue(value.execution) as PluginMarketplaceListing["execution"],
    entrypoint,
    events: arrayValue(value.events) as PluginMarketplaceListing["events"],
    permissions: arrayValue(
      value.permissions,
    ) as PluginMarketplaceListing["permissions"],
    effects: arrayValue(value.effects) as PluginMarketplaceListing["effects"],
    ordering: objectValue(
      value.ordering,
    ) as PluginMarketplaceListing["ordering"],
    configSchema: objectValue(
      value.configSchema,
    ) as PluginMarketplaceListing["configSchema"],
    defaultConfig: objectValue(value.defaultConfig) ?? {},
    tags: arrayValue(value.tags),
    iconText:
      optionalString(value.iconText) || slug.slice(0, 2).toUpperCase() || "OL",
    visualPng: optionalString(value.visualPng),
    featuredRank:
      typeof value.featuredRank === "number" ? value.featuredRank : null,
    seoTitle: optionalString(value.seoTitle) || `${slug} Plugin for OpenLeash`,
    seoDescription:
      optionalString(value.seoDescription) ||
      `Install ${slug} for OpenLeash. ${shortDescription}`,
  };
}

async function upsertLocalMarketplaceListing(plugin: PluginMarketplaceListing) {
  await pool.query(
    `insert into plugin_marketplace (
       plugin_id, slug, name, description, version, publisher, developer_name, developer_url,
       source, review_status, short_description, long_description, hero_tagline, package_url,
       repository_url, documentation_url, runtime, execution_environment, execution, entrypoint, events, permissions, effects,
       ordering, config_schema, default_config, tags, icon_text, visual_png,
       featured_rank, seo_title, seo_description, updated_at
     )
     values (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, 'approved', $10, $11, $12, $13,
       $14, $15, $16, $17, $18::jsonb, $19, $20::jsonb, $21::jsonb, $22::jsonb,
       $23::jsonb, $24::jsonb, $25::jsonb, $26::jsonb, $27, $28,
       $29, $30, $31, now()
     )
     on conflict (plugin_id) do update set
       slug = excluded.slug,
       name = excluded.name,
       description = excluded.description,
       version = excluded.version,
       publisher = excluded.publisher,
       developer_name = excluded.developer_name,
       developer_url = excluded.developer_url,
       source = excluded.source,
       review_status = 'approved',
       short_description = excluded.short_description,
       long_description = excluded.long_description,
       hero_tagline = excluded.hero_tagline,
       package_url = excluded.package_url,
       repository_url = excluded.repository_url,
       documentation_url = excluded.documentation_url,
       runtime = excluded.runtime,
       execution_environment = excluded.execution_environment,
       execution = excluded.execution,
       entrypoint = excluded.entrypoint,
       events = excluded.events,
       permissions = excluded.permissions,
       effects = excluded.effects,
       ordering = excluded.ordering,
       config_schema = excluded.config_schema,
       default_config = excluded.default_config,
       tags = excluded.tags,
       icon_text = excluded.icon_text,
       visual_png = excluded.visual_png,
       featured_rank = excluded.featured_rank,
       seo_title = excluded.seo_title,
       seo_description = excluded.seo_description,
       updated_at = now()`,
    [
      plugin.id,
      plugin.slug,
      plugin.slug,
      plugin.description,
      plugin.version,
      plugin.publisher,
      plugin.developerName,
      plugin.developerUrl ?? null,
      plugin.source,
      plugin.shortDescription,
      plugin.longDescription,
      plugin.heroTagline,
      plugin.packageUrl ?? null,
      plugin.repositoryUrl ?? null,
      plugin.documentationUrl ?? null,
      plugin.runtime,
      plugin.executionEnvironment ?? "any",
      JSON.stringify(plugin.execution ?? null),
      plugin.entrypoint,
      JSON.stringify(plugin.events),
      JSON.stringify(plugin.permissions),
      JSON.stringify(plugin.effects),
      JSON.stringify(plugin.ordering ?? null),
      JSON.stringify(plugin.configSchema ?? null),
      JSON.stringify(plugin.defaultConfig ?? {}),
      JSON.stringify(plugin.tags ?? []),
      plugin.iconText,
      plugin.visualPng ?? null,
      plugin.featuredRank ?? null,
      plugin.seoTitle,
      plugin.seoDescription,
    ],
  );
}

async function updateMarketplacePluginForUser(
  organizationId: string,
  userId: string,
  pluginId: string,
) {
  const manifest = await manifestForPluginId(pluginId);
  if (!manifest) return undefined;
  const settings = (await readUserPluginSettings(organizationId, userId)).get(
    manifest.id,
  );
  if (!settings?.enabled) return undefined;
  if (settings.updatePolicy === "locked") return undefined;
  return savePluginSettingsForUser(organizationId, userId, pluginId, {
    enabled: true,
    installedVersion: manifest.version,
    updatePolicy: settings.updatePolicy,
  });
}

async function uninstallMarketplacePluginForUser(
  organizationId: string,
  userId: string,
  pluginId: string,
) {
  const manifest = await manifestForPluginId(pluginId);
  if (!manifest) return undefined;
  return savePluginSettingsForUser(organizationId, userId, pluginId, {
    enabled: false,
    config: manifest.defaultConfig ?? {},
  });
}

async function updateMarketplacePluginForOrganization(
  organizationId: string,
  pluginId: string,
) {
  const manifest = await manifestForPluginId(pluginId);
  if (!manifest) return undefined;
  const settings = (await readPluginSettings(organizationId)).get(manifest.id);
  if (!settings?.enabled) return undefined;
  return savePluginSettingsForOrganization(organizationId, pluginId, {
    enabled: true,
    config: settings.config,
    orderingPriority: settings.orderingPriority,
    installedVersion: manifest.version,
    updatePolicy: settings.updatePolicy,
  });
}

async function saveOrganizationPluginPolicy(
  organizationId: string,
  pluginId: string,
  body: Record<string, unknown>,
) {
  const manifest = await manifestForPluginId(pluginId);
  if (!manifest) return undefined;
  const currentPolicy = (await readOrganizationPluginPolicy(organizationId)).get(pluginId);
  const {
    mandatory,
    defaultEnabled,
    userInstallAllowed,
    configLocked,
  } = normalizeOrganizationPluginPolicy(body, currentPolicy);
  if (mandatory || defaultEnabled) assertPluginExecutionAvailable(manifest);
  const result = await pool.query(
    `insert into organization_plugin_policy (organization_id, plugin_id, mandatory, default_enabled, user_install_allowed, config_locked, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (organization_id, plugin_id) do update set
       mandatory = excluded.mandatory,
       default_enabled = excluded.default_enabled,
       user_install_allowed = excluded.user_install_allowed,
       config_locked = excluded.config_locked,
       updated_at = now()
     returning plugin_id as "pluginId", mandatory, default_enabled as "defaultEnabled", user_install_allowed as "userInstallAllowed", config_locked as "configLocked", updated_at as "updatedAt"`,
    [
      organizationId,
      pluginId,
      mandatory,
      defaultEnabled,
      userInstallAllowed,
      configLocked,
    ],
  );
  if (mandatory)
    await savePluginSettingsForOrganization(organizationId, pluginId, {
      enabled: true,
    });
  return { pluginId, policy: result.rows[0] };
}

async function saveOrganizationMarketplacePolicy(
  organizationId: string,
  body: Record<string, unknown>,
) {
  const allowUserMarketplaceInstalls =
    body.allowUserMarketplaceInstalls !== false;
  const allowUserCommunityPlugins = Boolean(body.allowUserCommunityPlugins);
  const result = await pool.query(
    `insert into organization_plugin_marketplace_policy (organization_id, allow_user_marketplace_installs, allow_user_community_plugins, updated_at)
     values ($1, $2, $3, now())
     on conflict (organization_id) do update set
       allow_user_marketplace_installs = excluded.allow_user_marketplace_installs,
       allow_user_community_plugins = excluded.allow_user_community_plugins,
       updated_at = now()
     returning allow_user_marketplace_installs as "allowUserMarketplaceInstalls",
               allow_user_community_plugins as "allowUserCommunityPlugins",
               updated_at as "updatedAt"`,
    [organizationId, allowUserMarketplaceInstalls, allowUserCommunityPlugins],
  );
  return { marketplacePolicy: result.rows[0] };
}

async function readOrganizationPluginPolicy(organizationId: string) {
  const rows = await pool.query<{
    plugin_id: string;
    mandatory: boolean;
    default_enabled: boolean;
    user_install_allowed: boolean;
    config_locked: boolean;
  }>(
    `select plugin_id, mandatory, default_enabled, user_install_allowed, config_locked
     from organization_plugin_policy
     where organization_id = $1`,
    [organizationId],
  );
  return new Map<string, PluginPolicyRecord>(
    rows.rows.map((row) => [
      row.plugin_id,
      {
        pluginId: row.plugin_id,
        mandatory: row.mandatory,
        defaultEnabled: row.default_enabled,
        userInstallAllowed: row.user_install_allowed,
        configLocked: row.config_locked,
      },
    ]),
  );
}

async function readOrganizationMarketplacePolicy(
  organizationId: string,
): Promise<MarketplacePolicyRecord> {
  const rows = await pool.query<{
    allow_user_marketplace_installs: boolean;
    allow_user_community_plugins: boolean;
  }>(
    `select allow_user_marketplace_installs, allow_user_community_plugins
     from organization_plugin_marketplace_policy
     where organization_id = $1`,
    [organizationId],
  );
  return {
    allowUserMarketplaceInstalls:
      rows.rows[0]?.allow_user_marketplace_installs ?? true,
    allowUserCommunityPlugins:
      rows.rows[0]?.allow_user_community_plugins ?? true,
  };
}

async function createPluginSubmission(
  organizationId: string,
  submittedBy: string,
  body: Record<string, unknown>,
) {
  const slug = slugify(String(body.slug ?? body.name ?? ""));
  const pluginId = String(body.pluginId ?? `community.${slug}`).trim();
  const developerName = String(body.developerName ?? "").trim();
  const repositoryUrl = normalizeGithubRepositoryUrl(body.repositoryUrl);
  if (!slug || !developerName) {
    const error = new Error("Plugin slug and developer name are required.");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  if (!repositoryUrl) {
    const error = new Error("A public GitHub repository URL is required.");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  const manifest =
    body.manifest &&
    typeof body.manifest === "object" &&
    !Array.isArray(body.manifest)
      ? body.manifest
      : {};
  const icon = normalizePluginIconInput({
    iconText:
      optionalString(body.iconText) ??
      optionalString((manifest as Record<string, unknown>).iconText),
    visualPng:
      optionalString(body.visualPng) ??
      optionalString((manifest as Record<string, unknown>).visualPng),
  });
  const submissionManifest = {
    ...(manifest as Record<string, unknown>),
    iconText: icon.iconText || undefined,
    visualPng: icon.visualPng || undefined,
  };
  const result = await pool.query(
    `insert into plugin_submissions (organization_id, submitted_by, plugin_id, slug, name, developer_name, package_url, repository_url, manifest)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     returning id, plugin_id as "pluginId", slug, name, developer_name as "developerName", status, created_at as "createdAt"`,
    [
      organizationId,
      submittedBy,
      pluginId,
      slug,
      slug,
      developerName,
      optionalString(body.packageUrl),
      repositoryUrl,
      JSON.stringify(submissionManifest),
    ],
  );
  return { submission: result.rows[0] };
}

async function createPluginReleaseSubmission(
  organizationId: string,
  submittedBy: string,
  body: Record<string, unknown>,
) {
  const repositoryUrl = normalizeGithubRepositoryUrl(body.repositoryUrl);
  if (!repositoryUrl)
    throw new HttpError(400, "A public GitHub repository URL is required.");
  const manifestPath =
    optionalString(body.manifestPath) ?? "openleash.plugin.json";
  const gitRef = optionalString(body.gitRef) ?? optionalString(body.version);
  if (!gitRef)
    throw new HttpError(
      400,
      "gitRef is required for an immutable plugin release.",
    );
  const rawManifest =
    body.manifest &&
    typeof body.manifest === "object" &&
    !Array.isArray(body.manifest)
      ? (body.manifest as Record<string, unknown>)
      : await fetchGithubPluginManifest(repositoryUrl, gitRef, manifestPath);
  const release = pluginReleaseFieldsFromManifest(rawManifest, {
    repositoryUrl,
    gitRef,
    manifestPath,
    commitSha: optionalString(body.commitSha),
    source: body.source === "private" ? "private" : "community",
    developerName: optionalString(body.developerName),
  });
  const result = await pool.query(
    `insert into plugin_releases (
       plugin_id, version, slug, name, description, publisher, developer_name, developer_url,
       source, review_status, short_description, long_description, hero_tagline, package_url,
       repository_url, documentation_url, runtime, execution_environment, execution, entrypoint, events, permissions, effects,
       ordering, config_schema, default_config, tags, icon_text, visual_png,
       git_ref, commit_sha, manifest_path, manifest, submitted_by, updated_at
     )
     values (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, 'pending_review', $10, $11, $12, $13,
       $14, $15, $16, $17, $18::jsonb, $19, $20::jsonb, $21::jsonb, $22::jsonb,
       $23::jsonb, $24::jsonb, $25::jsonb, $26::jsonb, $27, $28,
       $29, $30, $31, $32::jsonb, $33, now()
     )
     on conflict (plugin_id, version) do update set
       slug = excluded.slug,
       name = excluded.name,
       description = excluded.description,
       publisher = excluded.publisher,
       developer_name = excluded.developer_name,
       developer_url = excluded.developer_url,
       source = excluded.source,
       review_status = 'pending_review',
       short_description = excluded.short_description,
       long_description = excluded.long_description,
       hero_tagline = excluded.hero_tagline,
       package_url = excluded.package_url,
       repository_url = excluded.repository_url,
       documentation_url = excluded.documentation_url,
       runtime = excluded.runtime,
       execution_environment = excluded.execution_environment,
       execution = excluded.execution,
       entrypoint = excluded.entrypoint,
       events = excluded.events,
       permissions = excluded.permissions,
       effects = excluded.effects,
       ordering = excluded.ordering,
       config_schema = excluded.config_schema,
       default_config = excluded.default_config,
       tags = excluded.tags,
       icon_text = excluded.icon_text,
       visual_png = excluded.visual_png,
       git_ref = excluded.git_ref,
       commit_sha = excluded.commit_sha,
       manifest_path = excluded.manifest_path,
       manifest = excluded.manifest,
       submitted_by = excluded.submitted_by,
       reviewed_by = null,
       reviewer_note = null,
       approved_at = null,
       updated_at = now()
     returning *`,
    [
      release.pluginId,
      release.version,
      release.slug,
      release.name,
      release.description,
      release.publisher,
      release.developerName,
      release.developerUrl ?? null,
      release.source,
      release.shortDescription,
      release.longDescription,
      release.heroTagline,
      release.packageUrl ?? null,
      release.repositoryUrl,
      release.documentationUrl ?? null,
      release.runtime,
      release.executionEnvironment,
      JSON.stringify(release.execution ?? null),
      release.entrypoint,
      JSON.stringify(release.events),
      JSON.stringify(release.permissions),
      JSON.stringify(release.effects),
      JSON.stringify(release.ordering ?? null),
      JSON.stringify(release.configSchema ?? null),
      JSON.stringify(release.defaultConfig ?? {}),
      JSON.stringify(release.tags ?? []),
      release.iconText,
      release.visualPng ?? null,
      release.gitRef,
      release.commitSha ?? null,
      release.manifestPath,
      JSON.stringify(rawManifest),
      submittedBy,
    ],
  );
  await pool.query(
    `insert into plugin_submissions (organization_id, submitted_by, plugin_id, slug, name, developer_name, package_url, repository_url, manifest, status, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'pending_review', now())
     on conflict do nothing`,
    [
      organizationId,
      submittedBy,
      release.pluginId,
      release.slug,
      release.name,
      release.developerName,
      release.packageUrl ?? null,
      release.repositoryUrl,
      JSON.stringify(rawManifest),
    ],
  );
  return { release: pluginReleaseFromRow(result.rows[0]) };
}

async function listPluginReleases(status: string) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (
    status === "pending_review" ||
    status === "approved" ||
    status === "rejected" ||
    status === "yanked"
  ) {
    params.push(status);
    where.push(`review_status = $${params.length}`);
  }
  const rows = await pool.query(
    `select * from plugin_releases
     ${where.length ? `where ${where.join(" and ")}` : ""}
     order by created_at desc
     limit 100`,
    params,
  );
  return rows.rows.map(pluginReleaseFromRow);
}

async function approvePluginRelease(
  id: string,
  reviewerId: string | undefined,
  body: Record<string, unknown>,
) {
  const reviewed = await reviewPluginRelease(
    id,
    "approved",
    reviewerId,
    body?.reviewerNote,
  );
  if (!reviewed) return undefined;
  const release = reviewed.release;
  await pool.query(
    `insert into plugin_marketplace (
       plugin_id, slug, name, description, version, publisher, developer_name, developer_url,
       source, review_status, short_description, long_description, hero_tagline, package_url,
       repository_url, documentation_url, runtime, execution_environment, execution, entrypoint, events, permissions, effects,
       ordering, config_schema, default_config, tags, icon_text, visual_png,
       featured_rank, seo_title, seo_description, updated_at
     )
     values (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, 'approved', $10, $11, $12, $13,
       $14, $15, $16, $17, $18::jsonb, $19, $20::jsonb, $21::jsonb, $22::jsonb,
       $23::jsonb, $24::jsonb, $25::jsonb, $26::jsonb, $27, $28,
       null, $29, $30, now()
     )
     on conflict (plugin_id) do update set
       slug = excluded.slug,
       name = excluded.name,
       description = excluded.description,
       version = excluded.version,
       publisher = excluded.publisher,
       developer_name = excluded.developer_name,
       developer_url = excluded.developer_url,
       source = excluded.source,
       review_status = 'approved',
       short_description = excluded.short_description,
       long_description = excluded.long_description,
       hero_tagline = excluded.hero_tagline,
       package_url = excluded.package_url,
       repository_url = excluded.repository_url,
       documentation_url = excluded.documentation_url,
       runtime = excluded.runtime,
       execution_environment = excluded.execution_environment,
       execution = excluded.execution,
       entrypoint = excluded.entrypoint,
       events = excluded.events,
       permissions = excluded.permissions,
       effects = excluded.effects,
       ordering = excluded.ordering,
       config_schema = excluded.config_schema,
       default_config = excluded.default_config,
       tags = excluded.tags,
       icon_text = excluded.icon_text,
       visual_png = excluded.visual_png,
       seo_title = excluded.seo_title,
       seo_description = excluded.seo_description,
       updated_at = now()`,
    [
      release.pluginId,
      release.slug,
      release.slug,
      release.description,
      release.version,
      release.publisher,
      release.developerName,
      release.developerUrl ?? null,
      release.source,
      release.shortDescription,
      release.longDescription,
      release.heroTagline,
      release.packageUrl ?? null,
      release.repositoryUrl,
      release.documentationUrl ?? null,
      release.runtime,
      release.executionEnvironment,
      JSON.stringify(release.execution ?? null),
      release.entrypoint,
      JSON.stringify(release.events),
      JSON.stringify(release.permissions),
      JSON.stringify(release.effects),
      JSON.stringify(release.ordering ?? null),
      JSON.stringify(release.configSchema ?? null),
      JSON.stringify(release.defaultConfig ?? {}),
      JSON.stringify(release.tags ?? []),
      release.iconText,
      release.visualPng ?? null,
      `${release.slug} Plugin for OpenLeash`,
      `Install ${release.slug} for OpenLeash. ${release.shortDescription}`,
    ],
  );
  await pool.query(
    "update plugin_submissions set status = 'approved', updated_at = now() where plugin_id = $1 and status = 'pending_review'",
    [release.pluginId],
  );
  return reviewed;
}

async function reviewPluginRelease(
  id: string,
  status: "approved" | "rejected" | "yanked",
  reviewerId?: string,
  reviewerNote?: unknown,
) {
  const result = await pool.query(
    `update plugin_releases
     set review_status = $2,
         reviewed_by = $3,
         reviewer_note = $4,
         approved_at = case when $2 = 'approved' then now() else approved_at end,
         updated_at = now()
     where id = $1
     returning *`,
    [id, status, reviewerId ?? null, optionalString(reviewerNote) ?? null],
  );
  return result.rows[0]
    ? { release: pluginReleaseFromRow(result.rows[0]) }
    : undefined;
}

type PluginReleaseFields = {
  pluginId: string;
  version: string;
  slug: string;
  name: string;
  description: string;
  publisher: string;
  developerName: string;
  developerUrl?: string;
  source: "community" | "private";
  shortDescription: string;
  longDescription: string;
  heroTagline: string;
  packageUrl?: string;
  repositoryUrl: string;
  documentationUrl?: string;
  runtime: OpenLeashPluginManifest["runtime"];
  executionEnvironment: NonNullable<OpenLeashPluginManifest["executionEnvironment"]>;
  execution?: OpenLeashPluginManifest["execution"];
  entrypoint: string;
  events: OpenLeashPluginManifest["events"];
  permissions: OpenLeashPluginManifest["permissions"];
  effects: OpenLeashPluginManifest["effects"];
  ordering?: OpenLeashPluginManifest["ordering"];
  configSchema?: OpenLeashPluginManifest["configSchema"];
  defaultConfig?: Record<string, unknown>;
  tags?: string[];
  iconText: string;
  visualPng?: string;
  gitRef: string;
  commitSha?: string;
  manifestPath: string;
};

function pluginReleaseFieldsFromManifest(
  manifest: Record<string, unknown>,
  source: {
    repositoryUrl: string;
    gitRef: string;
    manifestPath: string;
    commitSha?: string;
    source: "community" | "private";
    developerName?: string;
  },
): PluginReleaseFields {
  const pluginId = optionalString(manifest.id) ?? "";
  const version = optionalString(manifest.version) ?? "";
  const name = optionalString(manifest.name) ?? pluginId.split(".").pop() ?? "";
  const slug = slugify(optionalString(manifest.slug) ?? name);
  const publisher =
    optionalString(manifest.publisher) ?? pluginId.split(".")[0] ?? "community";
  const description = optionalString(manifest.description) ?? "";
  if (!pluginId || !version || !slug || !description) {
    throw new HttpError(
      400,
      "Plugin manifest requires id, version, name or slug, and description.",
    );
  }
  if (manifest.runtime !== "container") {
    throw new HttpError(400, "Leash plugins must use the container runtime.");
  }
  const runtime: OpenLeashPluginManifest["runtime"] = "container";
  const executionEnvironment = manifest.executionEnvironment === "cloud-only" ? "cloud-only" : "any";
  const execution = objectValue(manifest.execution) as OpenLeashPluginManifest["execution"];
  if (
    execution?.type !== "container" ||
    execution.protocol !== "openleash-container-plugin.v1" ||
    !optionalString(execution.image) ||
    !optionalString(execution.digest) ||
    !optionalString(execution.eventPath)
  ) {
    throw new HttpError(
      400,
      "Plugins require a container execution block with an immutable image digest and generic event endpoint.",
    );
  }
  const entrypoint = optionalString(manifest.entrypoint) ?? "";
  if (!entrypoint)
    throw new HttpError(400, "Plugin manifest requires entrypoint.");
  const events = pluginStringArray(manifest.events);
  const permissions = pluginStringArray(manifest.permissions);
  const effects = pluginStringArray(manifest.effects);
  if (events.length === 0 || permissions.length === 0 || effects.length === 0) {
    throw new HttpError(
      400,
      "Plugin manifest requires events, permissions, and effects.",
    );
  }
  const shortDescription =
    optionalString(manifest.shortDescription) ?? sentence(description);
  return {
    pluginId,
    version,
    slug,
    name,
    description,
    publisher,
    developerName: source.developerName ?? titleize(publisher),
    developerUrl: optionalString(manifest.developerUrl),
    source: source.source,
    shortDescription,
    longDescription: optionalString(manifest.longDescription) ?? description,
    heroTagline: optionalString(manifest.heroTagline) ?? shortDescription,
    packageUrl: optionalString(manifest.packageUrl),
    repositoryUrl: source.repositoryUrl,
    documentationUrl: optionalString(manifest.documentationUrl),
    runtime,
    executionEnvironment,
    execution,
    entrypoint,
    events: events as OpenLeashPluginManifest["events"],
    permissions: permissions as OpenLeashPluginManifest["permissions"],
    effects: effects as OpenLeashPluginManifest["effects"],
    ordering: objectValue(
      manifest.ordering,
    ) as OpenLeashPluginManifest["ordering"],
    configSchema: objectValue(
      manifest.configSchema,
    ) as OpenLeashPluginManifest["configSchema"],
    defaultConfig: objectValue(manifest.defaultConfig) ?? {},
    tags: pluginStringArray(manifest.tags),
    iconText: optionalString(manifest.iconText) ?? pluginIconText(slug),
    visualPng: optionalString(manifest.visualPng),
    gitRef: source.gitRef,
    commitSha: source.commitSha,
    manifestPath: source.manifestPath,
  };
}

async function fetchGithubPluginManifest(
  repositoryUrl: string,
  gitRef: string,
  manifestPath: string,
): Promise<Record<string, unknown>> {
  const rawUrl = githubRawUrl(repositoryUrl, gitRef, manifestPath);
  if (!rawUrl)
    throw new HttpError(
      400,
      "repositoryUrl must point to a GitHub repository.",
    );
  const response = await fetch(rawUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(
      Number(process.env.OPENLEASH_PLUGIN_MANIFEST_FETCH_TIMEOUT_MS ?? 10000),
    ),
  });
  if (!response.ok)
    throw new HttpError(
      400,
      `Could not fetch plugin manifest from GitHub (${response.status}).`,
    );
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("manifest must be an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Plugin manifest must be JSON.");
  }
}

function githubRawUrl(
  repositoryUrl: string,
  gitRef: string,
  manifestPath: string,
) {
  try {
    const url = new URL(repositoryUrl);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    const [owner, repo] = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (!owner || !repo) return undefined;
    const pathParts = manifestPath
      .replace(/^\/+/, "")
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
    return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(gitRef)}/${pathParts}`;
  } catch {
    return undefined;
  }
}

function pluginReleaseFromRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    pluginId: String(row.plugin_id),
    version: String(row.version),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description),
    publisher: String(row.publisher),
    developerName: String(row.developer_name),
    developerUrl: optionalString(row.developer_url),
    source: String(row.source),
    reviewStatus: String(row.review_status),
    shortDescription: String(row.short_description),
    longDescription: String(row.long_description),
    heroTagline: String(row.hero_tagline),
    packageUrl: optionalString(row.package_url),
    repositoryUrl: String(row.repository_url),
    documentationUrl: optionalString(row.documentation_url),
    runtime: String(row.runtime),
    executionEnvironment: row.execution_environment === "cloud-only" ? "cloud-only" : "any",
    execution: objectValue(row.execution),
    entrypoint: String(row.entrypoint),
    events: arrayValue(row.events),
    permissions: arrayValue(row.permissions),
    effects: arrayValue(row.effects),
    ordering: objectValue(row.ordering),
    configSchema: objectValue(row.config_schema),
    defaultConfig: objectValue(row.default_config) ?? {},
    tags: arrayValue(row.tags),
    iconText: String(row.icon_text ?? "OL"),
    visualPng: optionalString(row.visual_png),
    gitRef: String(row.git_ref),
    commitSha: optionalString(row.commit_sha),
    manifestPath: String(row.manifest_path),
    manifest: objectValue(row.manifest) ?? {},
    reviewerNote: optionalString(row.reviewer_note),
    approvedAt: optionalString(row.approved_at),
    createdAt: optionalString(row.created_at),
    updatedAt: optionalString(row.updated_at),
  };
}

function pluginStringArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function sentence(value: string) {
  return (
    value
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.!?]+$/, "")
      .slice(0, 180) + "."
  );
}

function titleize(value: string) {
  return (
    value
      .replace(/^@/, "")
      .replace(/[-_.]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .trim() || "Community"
  );
}

async function readPluginSettings(organizationId: string) {
  const rows = await pool.query<{
    plugin_id: string;
    enabled: boolean;
    config: Record<string, unknown>;
    profiles: PluginSettingProfile[];
    ordering_priority: number | null;
    installed_version: string | null;
    update_policy: "manual" | "patch" | "minor" | "locked";
    updated_at: string;
  }>(
    `select plugin_id, enabled, config, profiles, ordering_priority, installed_version, update_policy, updated_at
     from plugin_settings
     where organization_id = $1`,
    [organizationId],
  );
  return withLegacyRulesEnforcerSetting(
    new Map<string, PluginSettingRecord>(
      rows.rows.map((row) => [
        row.plugin_id,
        {
          pluginId: row.plugin_id,
          enabled: row.enabled,
          config: row.config ?? {},
          profiles: normalizePluginSettingProfiles(row.profiles),
          orderingPriority: row.ordering_priority,
          installedVersion: row.installed_version ?? undefined,
          updatePolicy: row.update_policy ?? "manual",
          updatedAt: row.updated_at,
        },
      ]),
    ),
  );
}

async function readUserPluginSettings(organizationId: string, userId: string) {
  const rows = await pool.query<{
    plugin_id: string;
    enabled: boolean;
    config: Record<string, unknown>;
    profiles: PluginSettingProfile[];
    ordering_priority: number | null;
    installed_version: string | null;
    update_policy: "manual" | "patch" | "minor" | "locked";
    updated_at: string;
  }>(
    `select plugin_id, enabled, config, profiles, ordering_priority, installed_version, update_policy, updated_at
     from user_plugin_settings
     where organization_id = $1 and user_id = $2`,
    [organizationId, userId],
  );
  return withLegacyRulesEnforcerSetting(
    new Map<string, PluginSettingRecord>(
      rows.rows.map((row) => [
        row.plugin_id,
        {
          pluginId: row.plugin_id,
          enabled: row.enabled,
          config: row.config ?? {},
          profiles: normalizePluginSettingProfiles(row.profiles),
          orderingPriority: row.ordering_priority,
          installedVersion: row.installed_version ?? undefined,
          updatePolicy: row.update_policy ?? "manual",
          updatedAt: row.updated_at,
        },
      ]),
    ),
  );
}

function withLegacyRulesEnforcerSetting(
  settings: Map<string, PluginSettingRecord>,
) {
  if (!settings.has("openleash.rules-enforcer")) {
    const legacy = settings.get("openleash.security-evaluator");
    if (legacy) {
      settings.set("openleash.rules-enforcer", {
        ...legacy,
        pluginId: "openleash.rules-enforcer",
      });
    }
  }
  return settings;
}

async function pluginSettingsForRuntime(
  organizationId: string,
  userId?: string,
  agentKind?: string,
  agentId?: string,
  projectPath?: string,
) {
  const { plugins } = await pluginCatalogForOrganization(
    organizationId,
    userId,
    { agentKind, agentId, projectPath },
  );
  return new Map<string, PluginSettingState>(
    plugins.map((plugin) => [plugin.id, plugin.settings]),
  );
}

function normalizeBusinessProtectionMode(value: unknown) {
  return value === "monitor" || value === "off" ? value : "active";
}

async function validatedAgentRuntimeId(
  userId: string,
  agentKind?: string,
  candidate?: string,
) {
  if (!candidate) return undefined;
  const result = await pool.query<{ id: string }>(
    `select ar.id::text as id
     from agent_runtimes ar
     join computers c on c.id = ar.computer_id
     where c.user_id = $1
       and ar.id::text = $2
       and ($3::text is null or ar.kind = $3)
     limit 1`,
    [userId, candidate, agentKind ?? null],
  );
  return result.rows[0]?.id;
}

async function organizationIdForAdminRequest(req: express.Request) {
  const session = await getDashboardSession(req.header("authorization") ?? "");
  if (!session) throw new HttpError(401, "dashboard session required");
  if (!isDashboardAccessRole(session.user.role))
    throw new HttpError(403, "dashboard admin role required");
  const slug =
    typeof req.query.organizationSlug === "string"
      ? req.query.organizationSlug
      : undefined;
  if (slug && slug !== session.organization.slug) {
    throw new HttpError(403, "cannot access another organization");
  }
  return session.organization.id;
}

async function adminUserForRequest(req: express.Request) {
  const session = await getDashboardSession(req.header("authorization") ?? "");
  if (!session) throw new HttpError(401, "dashboard session required");
  if (!isDashboardAccessRole(session.user.role))
    throw new HttpError(403, "dashboard admin role required");
  return session.user;
}

async function recordPromptTransformResult(
  conversationEventId: string,
  _userId: string,
  originalPrompt: string,
  result: PromptPipelineResult,
) {
  await pool.query(
    `update conversation_events
     set payload = payload || $2::jsonb
     where id = $1`,
    [
      conversationEventId,
      JSON.stringify({
        openleashPromptTransform: {
          originalPrompt,
          finalPrompt: result.finalPrompt,
          blocked: result.blocked,
          compression: result.compression,
          dlp: result.dlp,
        },
        openleashPluginRuns: result.runs,
      }),
    ],
  );
}

async function recordPluginRuns(
  conversationEventId: string,
  runs: PluginRunRecord[],
) {
  if (runs.length === 0) return;
  await writePipelineTrace("pipeline.plugins", {
    traceId: conversationEventId,
    conversationEventId,
    runs: runs.map((run) => ({
      pluginId: run.pluginId,
      event: run.event,
      status: run.status,
      summary: run.summary,
      durationMs: run.durationMs,
      findings: run.findings,
      metadata: run.metadata,
    })),
  });
  await pool.query(
    `update conversation_events
     set payload = payload || $2::jsonb
     where id = $1`,
    [conversationEventId, JSON.stringify({ openleashPluginRuns: runs })],
  );
}

async function recordContainerRuntimeRuns(input: {
  request: EvaluationRequest;
  organizationId: string;
  conversationEventId: string;
  userId: string;
  computerId: string;
  runtimeId: string;
}): Promise<PluginRunRecord[]> {
  const raw = input.request.event.raw && typeof input.request.event.raw === "object"
    ? input.request.event.raw as Record<string, unknown>
    : {};
  const sourceRuns = Array.isArray(raw.containerPluginRuns) ? raw.containerPluginRuns : [];
  if (sourceRuns.length === 0) return [];
  const runtimeSettings = await pluginSettingsForRuntime(input.organizationId, input.userId, input.request.agent.kind, input.runtimeId || input.request.agent.instanceId, input.request.event.projectPath);
  const runs: PluginRunRecord[] = [];
  for (const value of sourceRuns.slice(0, 32)) {
    if (!value || typeof value !== "object") continue;
    const run = value as Record<string, unknown>;
    const pluginId = String(run.pluginId ?? "").trim();
    if (!pluginId) continue;
    const manifest = await manifestForPluginId(pluginId);
    if (
      !manifest ||
      manifest.execution?.type !== "in-process" ||
      runtimeSettings.get(pluginId)?.enabled !== true
    ) continue;
    const sourceStatus = String(run.status ?? "failed");
    const status: PluginRunRecord["status"] = sourceStatus === "modified"
      ? "modified"
      : sourceStatus === "failed"
        ? "failed"
        : sourceStatus === "skipped"
          ? "skipped"
          : "passed";
    const summary = String(run.summary ?? `Feature ${sourceStatus}.`).slice(0, 2_000);
    const metadata = {
      runtime: "in-process",
      metrics: run.metrics && typeof run.metrics === "object" ? run.metrics : undefined,
      ccrHashes: Array.isArray(run.ccrHashes) ? run.ccrHashes.slice(0, 32) : undefined,
    };
    runs.push({
      pluginId,
      event: "provider.request.beforeSend",
      status,
      summary,
      durationMs: Number.isFinite(Number(run.durationMs)) ? Number(run.durationMs) : undefined,
      metadata,
    });
    await pool.query(
      `insert into plugin_log_events
       (organization_id, plugin_id, conversation_event_id, user_id, computer_id, agent_runtime_id, level, category, code, message, data)
       values ($1, $2, $3, $4, $5, $6, $7, 'plugin', 'feature-runtime', $8, $9::jsonb)`,
      [
        input.organizationId,
        pluginId,
        input.conversationEventId,
        input.userId,
        input.computerId,
        input.runtimeId,
        status === "failed" ? "error" : "info",
        summary,
        JSON.stringify({ status, durationMs: run.durationMs, ...metadata }),
      ],
    );
    const emissions = run.emissions && typeof run.emissions === "object"
      ? run.emissions as Record<string, unknown>
      : {};
    const capabilities = createPluginCapabilities({
      organizationId: input.organizationId,
      pluginId,
      request: input.request,
      conversationEventId: input.conversationEventId,
      userId: input.userId,
      computerId: input.computerId,
      runtimeId: input.runtimeId,
      permissions: manifest.permissions,
    });
    if (manifest.permissions.includes("log:write")) {
      const logs = Array.isArray(emissions.logs) ? emissions.logs.slice(0, 16) : [];
      for (const log of logs) {
        if (log && typeof log === "object") {
          await capabilities.log.emit(log as PluginLogRequest);
        }
      }
    }
    if (manifest.permissions.includes("signal:write")) {
      const signals = Array.isArray(emissions.signals) ? emissions.signals.slice(0, 16) : [];
      for (const signal of signals) {
        if (signal && typeof signal === "object") {
          await capabilities.signals.emit(signal as PluginSignalRequest);
        }
      }
    }
    if (manifest.permissions.includes("usage:write")) {
      const usageRecords = Array.isArray(emissions.usage) ? emissions.usage.slice(0, 16) : [];
      for (const usage of usageRecords) {
        if (usage && typeof usage === "object") {
          await capabilities.usage.record(usage as PluginUsageRecordRequest);
        }
      }
    }
    if (manifest.permissions.includes("island:publish")) {
      const contributions = Array.isArray(emissions.island) ? emissions.island.slice(0, 16) : [];
      for (const contribution of contributions) {
        if (!contribution || typeof contribution !== "object") continue;
        const request = contribution as PluginIslandPublishRequest;
        if (request.kind === "annotation") await capabilities.island.annotateSession(request);
        else if (request.kind === "activity") await capabilities.island.reportActivity(request);
        else if (request.kind === "status") await capabilities.island.publishStatus(request);
      }
    }
  }
  return runs;
}

async function writePipelineTrace(
  stage: string,
  details: Record<string, unknown>,
) {
  if (!pipelineTraceEnabled) return;
  const record = {
    timestamp: new Date().toISOString(),
    stage,
    ...(redactTraceValue(details) as Record<string, unknown>),
  };
  const agent = String(details.agent ?? "-");
  const event = String(details.event ?? "-");
  const sessionId = String(details.sessionId ?? "-").slice(0, 20);
  const traceId = String(details.traceId ?? "-").slice(0, 12);
  const decision = details.decision ? ` decision=${details.decision}` : "";
  console.log(
    `[openleash:flow] stage=${stage} trace=${traceId} session=${sessionId} agent=${agent} event=${event}${decision}`,
  );
  if (!pipelineTraceFile) return;
  await fs.mkdir(path.dirname(pipelineTraceFile), { recursive: true });
  await fs.appendFile(pipelineTraceFile, `${JSON.stringify(record)}\n`, "utf8");
}

function redactTraceValue(value: unknown, key = ""): unknown {
  if (
    /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|cookie/i.test(
      key,
    )
  )
    return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactTraceValue(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([childKey, child]) => [childKey, redactTraceValue(child, childKey)],
      ),
    );
  return value;
}

async function readPluginLogsForConversation(
  conversationEventId: string,
): Promise<PluginLogRecord[]> {
  const rows = await pool.query<{
    id: string;
    plugin_id: string;
    level: PluginLogRecord["level"];
    category: PluginLogRecord["category"];
    code: string | null;
    message: string;
    scope: PluginLogRecord["scope"] | null;
    data: Record<string, unknown> | null;
    created_at: string;
  }>(
    `select id, plugin_id, level, category, code, message, scope, data, created_at
     from plugin_log_events
     where conversation_event_id = $1
     order by created_at asc`,
    [conversationEventId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    pluginId: row.plugin_id,
    level: row.level,
    category: row.category,
    code: row.code ?? undefined,
    message: row.message,
    scope: row.scope ?? undefined,
    data: row.data ?? {},
    createdAt: row.created_at,
  }));
}

async function recordOpenLeashSystemLog({
  organizationId,
  conversationEventId,
  userId,
  computerId,
  runtimeId,
  level,
  code,
  message,
  data,
}: {
  organizationId: string;
  conversationEventId: string;
  userId?: string;
  computerId?: string;
  runtimeId?: string;
  level: PluginLogRecord["level"];
  code: string;
  message: string;
  data?: Record<string, unknown>;
}) {
  await pool.query(
    `insert into plugin_log_events
     (organization_id, plugin_id, conversation_event_id, user_id, computer_id, agent_runtime_id, level, category, code, message, data)
     values ($1, 'openleash.core', $2, $3, $4, $5, $6, 'system', $7, $8, $9::jsonb)`,
    [
      organizationId,
      conversationEventId,
      userId ?? null,
      computerId ?? null,
      runtimeId ?? null,
      level,
      code,
      message,
      JSON.stringify(data ?? {}),
    ],
  );
}

async function exportPluginLogs({
  logs,
  organization,
  user,
  request,
  conversationEventId,
}: {
  logs: PluginLogRecord[];
  organization: { id: string; name?: string; slug?: string | null };
  user: { id: string; email?: string; displayName?: string };
  request: EvaluationRequest;
  conversationEventId: string;
}) {
  for (const log of logs) {
    await exportAuditLog({
      log,
      organization,
      user,
      request,
      conversationEventId,
    });
  }
}

async function evaluateAndRecord(
  request: EvaluationRequest,
  user: ApiUser,
): Promise<EvaluationResponse> {
  const intentKey = triggerIntentKey(request);
  const { conversationEventId, computerId, runtimeId, organizationId } =
    await recordConversationEvent(request, user, intentKey);
  const containerRuns = await recordContainerRuntimeRuns({ request, organizationId, conversationEventId, userId: user.id, computerId, runtimeId });
  const handledIntent = intentKey
    ? await findRecentHandledIntent(user.id, request, intentKey)
    : undefined;
  if (handledIntent) {
    return {
      decision: handledIntent.resolution ?? handledIntent.decision,
      decisionId: handledIntent.id,
      summary: handledIntent.summary,
      question: handledIntent.resolution
        ? undefined
        : (handledIntent.question ?? undefined),
      results: [],
    };
  }
  const tenantModelKey = await tenantModelKeyForEvaluation(organizationId);
  const runtimePlugins = await pluginSettingsForRuntime(
    organizationId,
    user.id,
    request.agent.kind,
    runtimeId || request.agent.instanceId,
    request.event.projectPath,
  );
  const policies = await pool.query<Policy>(
    `select id, name, description, severity, natural_language_rule as "naturalLanguageRule", enabled, locked
     from policies where organization_id = $1 and enabled = true order by created_at asc`,
    [organizationId],
  );
  const runtimePolicies = policiesForEvaluation(
    policies.rows,
    runtimePlugins,
  );
  const evaluationPlugins = pluginsWithPolicyEngine(
    runtimePlugins,
    policies.rows.length > 0,
  );
  const pipeline = await runEvaluationPipeline({
    request,
    organizationId,
    conversationEventId,
    userId: user.id,
    computerId,
    runtimeId,
    policies: runtimePolicies,
    tenantModelKey,
    plugins: evaluationPlugins,
  });
  const { results: evaluatedResults, model } = pipeline;
  const actionedResults = applyConfiguredRuleActions(
    evaluatedResults,
    runtimePolicies,
  );
  const approvalDeferred =
    shouldDeferPromptOnlyApproval(request, actionedResults) ||
    isNonActionableHookEvent(request.event.eventName) ||
    eventEnvelope(request).capabilities?.block === false;
  const results = approvalDeferred
    ? deferPromptOnlyPolicyResults(actionedResults)
    : actionedResults;
  const nativeInteraction = agentInteractionForRequest(request);
  const decision = results.some((r) => r.status === "failed")
    ? "deny"
    : nativeInteraction
      ? "ask"
    : results.some((r) => r.status === "needs_question")
      ? "ask"
      : "allow";
  const blockingResult = results.find((r) => r.status === "failed");
  const approvalSummary = blockingResult
    ? summarizeBlockedAction(request, blockingResult.policyName)
    : nativeInteraction?.summary
      ? nativeInteraction.summary
    : (results.find((r) => r.status === "needs_question")?.explanation ??
      "Leash needs a human decision before continuing.");
  const question = blockingResult
    ? `${approvalSummary} Allow this action once?`
    : nativeInteraction?.question
      ? nativeInteraction.question
    : (results.find((r) => r.status === "needs_question")?.question ??
      (decision === "ask"
        ? `${request.agent.displayName} needs approval for ${request.event.tool?.name ?? request.event.eventName}. Allow it?`
        : undefined));
  const summary =
    decision === "allow" ? "All active policies passed." : approvalSummary;
  const runtimePolicy = await runtimePolicyForUser(user);
  const evaluation = await pool.query(
    `insert into evaluations (conversation_event_id, user_id, decision, summary, question, model)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [conversationEventId, user.id, decision, summary, question ?? null, model],
  );
  for (const result of results) {
    const policyId = resolvePolicyResultPolicyId(result, policies.rows);
    await pool.query(
      `insert into policy_results
       (evaluation_id, policy_id, policy_name, status, severity, explanation, evidence, question)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        evaluation.rows[0].id,
        policyId,
        result.policyName,
        result.status,
        result.severity,
        result.explanation,
        JSON.stringify(result.evidence ?? []),
        result.question ?? null,
      ],
    );
  }
  await recordMcpToolCall({
    call: pipeline.mcpCall,
    organizationId,
    conversationEventId,
    evaluationId: evaluation.rows[0].id,
    userId: user.id,
    computerId,
    runtimeId,
    request,
    decision,
  });
  if (decision === "ask") {
    await recordOpenLeashSystemLog({
      organizationId,
      conversationEventId,
      userId: user.id,
      computerId,
      runtimeId,
      level: "security",
      code: runtimePolicy.enforcementMode === "learning"
        ? "action-observed-learning-only"
        : "action-held-for-approval",
      message: summary,
      data: {
        evaluationId: evaluation.rows[0].id,
        eventName: request.event.eventName,
        toolName: request.event.tool?.name,
        policyNames: results
          .filter(
            (result) =>
              result.status === "failed" || result.status === "needs_question",
          )
          .map((result) => result.policyName),
      },
    });
  }
  const organization = await organizationSummary(organizationId);
  const pluginLogs = await readPluginLogsForConversation(conversationEventId);
  await exportPluginLogs({
    logs: pluginLogs,
    organization,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
    },
    request,
    conversationEventId,
  });
  await exportAuditDecision({
    request,
    event: eventForRequest(request),
    decision,
    summary,
    evaluationId: evaluation.rows[0].id,
    conversationEventId,
    organization,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
    },
    computerId,
    runtimeId,
    policyResults: results,
    featureRuns: pipeline.runs,
    featureLogs: pluginLogs,
  });
  await recordPluginRuns(conversationEventId, [
    ...containerRuns,
    ...pipeline.runs,
  ]);
  let purposeSummary: string | undefined;
  if (decision === "ask") {
    purposeSummary =
      nativeInteraction?.purpose ??
      (await summarizeActionPurpose(request, tenantModelKey));
    await pool.query(
      `update conversation_events
       set payload = payload || $2::jsonb
       where id = $1`,
      [
        conversationEventId,
        JSON.stringify({ openleashPurposeSummary: purposeSummary }),
      ],
    );
    const notification = runtimePolicy.enforcementMode === "learning"
      ? notifyMobileEvent(user.id, {
          title: "Leash observed an action in learning mode",
          body: summary,
          data: { decisionId: evaluation.rows[0].id, kind: "learning_only" },
        })
      : notifyMobileApprovers(
          user.id,
          evaluation.rows[0].id,
          summary,
          question,
          purposeSummary,
          attentionKindForTool(request.event.tool?.name ?? ""),
        );
    notification.catch((error) => {
      console.warn("mobile approval notification failed", error);
    });
  } else if (decision === "deny") {
    notifyMobileEvent(user.id, {
      title: runtimePolicy.enforcementMode === "learning"
        ? "Leash observed an action in learning mode"
        : "Leash blocked an agent action",
      body: summary,
      data: {
        decisionId: evaluation.rows[0].id,
        kind: runtimePolicy.enforcementMode === "learning" ? "learning_only" : "blocked",
      },
    }).catch((error) => {
      console.warn("mobile blocked notification failed", error);
    });
  }
  if (
    ["Stop", "SessionEnd", "SubagentStop"].includes(request.event.eventName)
  ) {
    const subagent = request.event.eventName === "SubagentStop";
    notifyMobileEvent(user.id, {
      title: subagent
        ? `${request.agent.displayName} subagent finished`
        : `${request.agent.displayName} finished`,
      body:
        eventCompletionSummary(request) ??
        (subagent
          ? "A delegated agent finished its latest task."
          : "The agent finished its latest turn."),
      data: {
        kind: subagent ? "subagent_completed" : "completed",
        sessionId: request.event.sessionId,
      },
    }).catch((error) => {
      console.warn("mobile completion notification failed", error);
    });
  }
  return {
    decision,
    decisionId: evaluation.rows[0].id,
    summary,
    question,
    results,
  };
}

function resolvePolicyResultPolicyId(
  result: PolicyDecision,
  policies: Policy[],
) {
  const byId = policies.find((policy) => policy.id === result.policyId);
  if (byId) return byId.id;
  const byName = policies.find((policy) => policy.name === result.policyName);
  return byName?.id ?? null;
}

function policiesForRulesEnforcer(
  settings: Map<string, PluginSettingRecord | PluginSettingState>,
): Policy[] {
  const rulesPlugin = settings.get("openleash.rules-enforcer");
  const rules = normalizeRuleConfigs(rulesPlugin?.config?.rules);
  return rules.map((rule, index) => ({
    id: `rules-enforcer-${stableRuleId(rule.text, index)}`,
    name: summarizePolicyTitle(rule.text),
    description: rule.text,
    severity: "medium",
    naturalLanguageRule: rule.text,
    enabled: true,
    locked: false,
    enforcementAction: rule.action,
  }));
}

function policiesForEvaluation(
  organizationPolicies: Policy[],
  settings: Map<string, PluginSettingRecord | PluginSettingState>,
) {
  const policies = organizationPolicies.filter(
    (policy) => policy.enabled && policy.naturalLanguageRule?.trim(),
  );
  const organizationRules = new Set(
    policies.map((policy) => policy.naturalLanguageRule.trim().toLowerCase()),
  );
  return [
    ...policies,
    ...policiesForRulesEnforcer(settings).filter(
      (policy) =>
        !organizationRules.has(policy.naturalLanguageRule.trim().toLowerCase()),
    ),
  ];
}

function pluginsWithPolicyEngine(
  settings: Map<string, PluginSettingState>,
  hasOrganizationPolicies: boolean,
) {
  if (!hasOrganizationPolicies) return settings;
  const policyEngine = settings.get("openleash.rules-enforcer");
  if (policyEngine?.enabled) return settings;
  const enabled = new Map(settings);
  enabled.set("openleash.rules-enforcer", {
    ...(policyEngine ?? {}),
    enabled: true,
    config: policyEngine?.config ?? { rules: [] },
  });
  return enabled;
}

function normalizeRuleConfigs(
  value: unknown,
): Array<{ text: string; action: "allow" | "ask" | "block" }> {
  if (Array.isArray(value)) {
    const seen = new Set<string>();
    const rules: Array<{ text: string; action: "allow" | "ask" | "block" }> = [];
    for (const item of value) {
      const normalized = normalizeRuleConfig(item);
      if (!normalized || seen.has(normalized.text)) continue;
      seen.add(normalized.text);
      rules.push(normalized);
    }
    return rules;
  }
  if (typeof value === "string") {
    return [
      ...new Set(
        splitRuleString(value)
          .map((line) => line.replace(/^[-*]\s+/, "").trim())
          .filter(Boolean),
      ),
    ].map((text) => ({ text, action: "ask" }));
  }
  return [];
}

function normalizeRuleConfig(
  value: unknown,
): { text: string; action: "allow" | "ask" | "block" } | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { text, action: "ask" } : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const text = String(
    record.text ?? record.rule ?? record.description ?? "",
  ).trim();
  if (!text) return undefined;
  return {
    text,
    action: record.action === "allow" ? "allow" : record.action === "block" ? "block" : "ask",
  };
}

function splitRuleString(value: string) {
  const lines = value.split(/\r?\n/g);
  if (lines.length > 1) return lines;
  return value.split(
    /,\s+(?=Ask before|Never|Do not|Don't|Always|Require|Block|Pause)/gi,
  );
}

function applyConfiguredRuleActions(
  results: PolicyDecision[],
  policies: Policy[],
): PolicyDecision[] {
  const policyActions = new Map(
    policies.map((policy) => [policy.id, policy.enforcementAction ?? "ask"]),
  );
  return results.map((result) => {
    if (result.status === "passed") return result;
    const action =
      policyActions.get(result.policyId) ??
      policyActions.get(policyIdForPolicyName(result.policyName, policies));
    if (!action) return result;
    if (action === "allow") {
      return {
        ...result,
        status: "passed",
        explanation: `${result.explanation} Leash recorded it and let the agent continue.`,
        question: undefined,
      };
    }
    if (action === "block") {
      return {
        ...result,
        status: "failed",
        question: undefined,
      };
    }
    return {
      ...result,
      status: "needs_question",
      question:
        result.question ??
        "Leash found a rule match. Allow this action once?",
    };
  });
}

function policyIdForPolicyName(policyName: string, policies: Policy[]) {
  return policies.find((policy) => policy.name === policyName)?.id ?? "";
}

function stableRuleId(rule: string, index: number) {
  const slug = rule
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `rule-${index + 1}`;
}

async function tenantModelKeyForEvaluation(organizationId: string) {
  try {
    if (await organizationUsesManagedEvaluation(organizationId)) {
      return undefined;
    }
    return (await readTenantModelKey(organizationId)) ?? {
      provider: "openai" as const,
      apiKey: "",
      masked: "",
      fingerprint: "",
      updatedAt: "",
      managedFallback: false,
    };
  } catch (error) {
    console.warn(
      "tenant model key unavailable; falling back to managed or heuristic evaluation",
      error,
    );
    return {
      provider: "openai" as const,
      apiKey: "",
      masked: "",
      fingerprint: "",
      updatedAt: "",
      managedFallback: false,
    };
  }
}

async function organizationSummary(organizationId: string) {
  const result = await pool.query<{
    id: string;
    name: string;
    slug: string | null;
  }>("select id, name, slug from organizations where id = $1 limit 1", [
    organizationId,
  ]);
  return result.rows[0] ?? { id: organizationId };
}

function eventForRequest(request: EvaluationRequest) {
  return eventForHookEvent(request.event.eventName);
}

async function recordConversationEvent(
  request: EvaluationRequest,
  user: ApiUser,
  intentKey?: string,
) {
  const client = await pool.connect();
  let conversationEventId = "";
  let computerId = "";
  let runtimeId = "";
  const organizationId =
    user.organization_id ?? (await ensureDefaultOrganization()).id;
  try {
    await client.query("begin");
    computerId = await upsertActivityComputer(client, user, {
      hostname: request.computer.hostname,
      platform: request.computer.platform,
      osRelease: request.computer.osRelease ?? null,
    });
    const runtime = await client.query(
      `insert into agent_runtimes (computer_id, kind, display_name, version, executable_path, last_seen_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (computer_id, kind, executable_path_key) do update set display_name = excluded.display_name, version = excluded.version, last_seen_at = now()
       returning id`,
      [
        computerId,
        request.agent.kind,
        request.agent.displayName,
        request.agent.version ?? null,
        request.agent.executablePath ?? "",
      ],
    );
    runtimeId = runtime.rows[0].id;
    const event = await client.query(
      `insert into conversation_events
       (user_id, computer_id, agent_runtime_id, session_id, event_name, project_path, prompt, tool_name, payload, occurred_at,
        source, provider, idempotency_key, correlation_id, source_capabilities)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       returning id`,
      [
        user.id,
        computerId,
        runtimeId,
        request.event.sessionId,
        request.event.eventName,
        request.event.projectPath ?? null,
        request.event.prompt ?? null,
        request.event.tool?.name ?? null,
        {
          ...request.event,
          raw: {
            ...(request.event.raw && typeof request.event.raw === "object"
              ? request.event.raw
              : {}),
            openleashIntentKey: intentKey,
          },
        },
        request.event.occurredAt,
        eventEnvelope(request).source,
        eventEnvelope(request).provider,
        eventEnvelope(request).idempotencyKey ?? null,
        eventEnvelope(request).correlationId ?? null,
        eventEnvelope(request).capabilities,
      ],
    );
    conversationEventId = event.rows[0].id;
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return { conversationEventId, computerId, runtimeId, organizationId };
}

function attachEventEnvelope(raw: unknown, envelope: NormalizedAgentEvent) {
  return {
    ...(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}),
    openleashEventEnvelope: {
      schemaVersion: envelope.schemaVersion,
      source: envelope.source,
      provider: envelope.provider,
      idempotencyKey: envelope.idempotencyKey,
      correlationId: envelope.correlationId,
      capabilities: envelope.capabilities,
    },
  };
}

function eventEnvelope(request: EvaluationRequest) {
  const raw =
    request.event.raw && typeof request.event.raw === "object"
      ? (request.event.raw as Record<string, unknown>)
      : {};
  const stored =
    raw.openleashEventEnvelope && typeof raw.openleashEventEnvelope === "object"
      ? (raw.openleashEventEnvelope as Partial<NormalizedAgentEvent>)
      : undefined;
  return (
    stored ?? {
      source: "api_hook" as const,
      provider: request.agent.kind,
      idempotencyKey: undefined,
      correlationId: undefined,
      capabilities: {
        observe: true as const,
        block: true,
        rewritePrompt: false,
        rewriteToolInput: true,
        rewriteResponse: false,
      },
    }
  );
}

async function existingNormalizedEvent(userId: string, key: string) {
  const row = await pool.query(
    `select ev.decision, ev.id as "decisionId", ev.summary, ev.question
     from conversation_events ce join evaluations ev on ev.conversation_event_id = ce.id
     where ce.user_id = $1 and ce.idempotency_key = $2 order by ev.created_at desc limit 1`,
    [userId, key],
  );
  return row.rows[0] as EvaluationResponse | undefined;
}

async function deduplicateConcurrentNormalizedEvent<T extends NormalizedEventDecision>(
  userId: string,
  idempotencyKey: string,
  evaluate: () => Promise<T>,
): Promise<T> {
  try {
    return await evaluate();
  } catch (error) {
    if (!isConversationEventIdempotencyConflict(error)) throw error;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const existing = await existingNormalizedEvent(userId, idempotencyKey);
      if (existing) return existing as T;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw error;
  }
}

function isConversationEventIdempotencyConflict(error: unknown) {
  const postgresError = error as { code?: string; constraint?: string };
  return postgresError?.code === "23505" &&
    postgresError.constraint === "conversation_events_user_idempotency_key_uidx";
}

async function recordMcpToolCall({
  call,
  organizationId,
  conversationEventId,
  evaluationId,
  userId,
  computerId,
  runtimeId,
  request,
  decision,
}: {
  call?: McpToolCall;
  organizationId?: string | null;
  conversationEventId: string;
  evaluationId: string;
  userId: string;
  computerId: string;
  runtimeId: string;
  request: EvaluationRequest;
  decision: "allow" | "ask" | "deny";
}) {
  if (!call) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const server = await client.query(
      `insert into mcp_servers (organization_id, server_name, first_seen_at, last_seen_at, tool_count, call_count)
       values ($1, $2, $3, $3, 1, 1)
       on conflict (organization_id, server_name) do update
         set last_seen_at = greatest(mcp_servers.last_seen_at, excluded.last_seen_at),
             call_count = mcp_servers.call_count + 1,
             tool_count = greatest(
               mcp_servers.tool_count,
               (select count(distinct tool_name)::int + 1 from mcp_tool_calls where mcp_server_id = mcp_servers.id and tool_name <> $4)
             )
       returning id`,
      [
        organizationId ?? null,
        call.serverName,
        request.event.occurredAt,
        call.toolName,
      ],
    );
    await client.query(
      `insert into mcp_tool_calls
       (organization_id, mcp_server_id, conversation_event_id, evaluation_id, user_id, computer_id, agent_runtime_id,
        server_name, tool_name, full_tool_name, arguments, argument_summary, project_path, session_id, decision, risk_level, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17)`,
      [
        organizationId ?? null,
        server.rows[0].id,
        conversationEventId,
        evaluationId,
        userId,
        computerId,
        runtimeId,
        call.serverName,
        call.toolName,
        call.fullToolName,
        JSON.stringify(call.arguments ?? {}),
        call.argumentSummary || null,
        request.event.projectPath ?? null,
        request.event.sessionId,
        decision,
        decision === "ask" ? "policy_review" : "observed",
        request.event.occurredAt,
      ],
    );
    await client.query(
      `update mcp_servers s
       set tool_count = stats.tool_count,
           call_count = stats.call_count,
           last_seen_at = stats.last_seen_at
       from (
         select mcp_server_id, count(distinct tool_name)::int as tool_count, count(*)::int as call_count, max(occurred_at) as last_seen_at
         from mcp_tool_calls
         where mcp_server_id = $1
         group by mcp_server_id
       ) stats
       where s.id = stats.mcp_server_id`,
      [server.rows[0].id],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    console.warn("failed to record MCP tool call", error);
  } finally {
    client.release();
  }
}

async function waitForHookDecision(
  user: ApiUser,
  decision: EvaluationResponse,
): Promise<EvaluationResponse> {
  // The original hook/proxy request owns this waiter. A phone or web client
  // only resolves the durable evaluation; the resulting native response is
  // returned to that exact desktop, cloud-agent, or SaaS request rather than
  // being broadcast as an executable command to an arbitrary desktop.
  decision = await effectiveRuntimeDecision(user, decision);
  if (decision.decision !== "ask") return decision;
  const timeoutMs = Number(
    process.env.OPENLEASH_HOOK_APPROVAL_TIMEOUT_MS ?? 600000,
  );
  const pollMs = Number(process.env.OPENLEASH_HOOK_APPROVAL_POLL_MS ?? 250);
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (Date.now() < deadline) {
    const result = await pool.query<{
      resolution: "allow" | "deny" | null;
      resolution_guidance: string | null;
      resolution_payload: Record<string, unknown> | null;
      summary: string | null;
    }>(
      `select resolution, resolution_guidance, resolution_payload, summary
       from evaluations
       where id = $1 and user_id = $2`,
      [decision.decisionId, user.id],
    );
    const row = result.rows[0];
    if (row?.resolution === "allow" || row?.resolution === "deny") {
      return {
        ...decision,
        decision: row.resolution,
        summary:
          row.resolution === "allow"
            ? "Leash approved this action."
            : (row.summary ?? decision.summary),
        resolutionGuidance:
          row.resolution === "deny"
            ? (row.resolution_guidance ?? undefined)
            : undefined,
        resolutionPayload:
          row.resolution === "allow"
            ? (row.resolution_payload ?? undefined)
            : undefined,
        question: undefined,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, pollMs)));
  }
  return {
    ...decision,
    decision: "deny",
    summary: "Leash timed out waiting for approval.",
    question: undefined,
  };
}

async function ensureExternalUser(organizationId: string, provider: string): Promise<ApiUser> {
  const displayName =
    provider === "external-agents"
      ? "SaaS agents"
      : externalProviderLabel(provider);
  const email = `${slug(displayName)}.${organizationId.slice(0, 8)}@external.openleash.com`;
  const result = await pool.query<{
    id: string;
    organization_id: string;
    email: string;
    display_name: string;
  }>(
    `insert into users (organization_id, email, display_name, role)
     values ($1, $2, $3, 'external-agent')
     on conflict (email) do update set display_name = excluded.display_name
     returning id, organization_id, email, display_name`,
    [organizationId, email, displayName],
  );
  return result.rows[0];
}

async function externalEventExists(organizationId: string, key: string) {
  const result = await pool.query(
    `select 1
     from conversation_events ce
     join users u on u.id = ce.user_id
     where u.organization_id = $1
       and ce.payload->'raw'->>'externalEvaluationKey' = $2
     limit 1`,
    [organizationId, key],
  );
  return (result.rowCount ?? 0) > 0;
}

async function findRecentHandledIntent(
  userId: string,
  request: EvaluationRequest,
  intentKey: string,
) {
  const sessionScoped = !isSessionlessIntentKey(intentKey);
  const result = await pool.query<{
    id: string;
    decision: "allow" | "ask" | "deny";
    resolution: "allow" | "deny" | null;
    summary: string;
    question: string | null;
    intent_key: string | null;
    event_name: string;
  }>(
    `select e.id, e.decision, e.resolution, e.summary, e.question,
            ce.event_name, ce.payload->'raw'->>'openleashIntentKey' as intent_key
     from evaluations e
     join conversation_events ce on ce.id = e.conversation_event_id
     join agent_runtimes ar on ar.id = ce.agent_runtime_id
     where e.user_id = $1
       and ar.kind = $2
       and (ce.event_name <> 'UserPromptSubmit' or e.decision = 'ask')
       and ($6::boolean = false or ce.session_id = $3)
       and ($6::boolean = false or coalesce(ce.project_path, '') = $4)
       and ($6::boolean = false or ce.payload->'raw'->>'openleashIntentKey' = $5)
       and e.created_at > now() - interval '5 minutes'
     order by e.created_at desc
     limit 25`,
    [
      userId,
      request.agent.kind,
      request.event.sessionId,
      request.event.projectPath ?? "",
      intentKey,
      sessionScoped,
    ],
  );
  const reusable = result.rows.filter((row) =>
    isReusableHandledIntent({
      eventName: row.event_name,
      decision: row.decision,
      intentKey: row.intent_key,
    }),
  );
  if (sessionScoped) return reusable[0];
  return reusable.find(
    (row) => handledIntentKeysMatch(row.intent_key, intentKey),
  );
}

function triggerIntentKey(request: EvaluationRequest) {
  const category = intentCategory(request);
  if (!category) return undefined;
  if (category.startsWith("credential-")) {
    return [
      request.agent.kind,
      request.event.projectPath ?? "",
      category,
      primaryResource(request),
    ].join("|");
  }
  return [
    request.agent.kind,
    request.event.sessionId,
    request.event.projectPath ?? "",
    category,
    primaryResource(request),
  ].join("|");
}

function isSessionlessIntentKey(intentKey: string) {
  return intentKey.includes("|credential-");
}

function intentCategory(request: EvaluationRequest) {
  const text = eventTextForIntent(request).toLowerCase();
  if (
    /(git init|gh repo create|create (a )?(new )?git repo|initialize (a )?(new )?repository)/i.test(
      text,
    )
  )
    return "git-repo";
  if (
    /(\.env(?:\b|["'\\/\s])|\.npmrc|id_rsa|id_ed25519|credentials|kubeconfig|private key|api[_ -]?key|secret|token|password)/i.test(
      text,
    )
  ) {
    return `credential-${credentialActionVerb((request.event.tool?.name ?? "").toLowerCase(), text)}`;
  }
  if (
    /(rm\s+-rf|sudo rm|delete all|format disk|chmod\s+-r|chown\s+-r|git reset\s+--hard|terraform destroy)/i.test(
      text,
    )
  )
    return "destructive";
  if (
    /(curl|wget|upload|pastebin|gist|send .*code|post .*secret|external domain|webhook)/i.test(
      text,
    )
  )
    return "exfiltration";
  if (
    /(ssn|social security|passport|credit card|personal data|customer list|employee data|customer emails?|email export)/i.test(
      text,
    )
  )
    return "personal-data";
  if (
    /(npm install|pip install|brew install|curl .* sh|unknown package)/i.test(
      text,
    )
  )
    return "package-install";
  return undefined;
}

function eventTextForIntent(request: EvaluationRequest) {
  return [
    request.event.prompt,
    request.event.tool?.name,
    JSON.stringify(request.event.tool?.input ?? ""),
    JSON.stringify(request.event.raw ?? ""),
  ]
    .filter(Boolean)
    .join("\n");
}

function credentialActionVerb(toolName: string, text: string) {
  if (
    /(curl|wget|upload|post|webhook|pastebin|gist|send|exfiltrat|external|remote)/i.test(
      text,
    )
  )
    return "send";
  if (
    /read|cat|open|print|show|display|dump|list|grep|scan|parse|copy/i.test(
      `${toolName} ${text}`,
    )
  )
    return "read";
  if (
    /write|create|add|generate|save|put|touch|edit|multiedit/i.test(
      `${toolName} ${text}`,
    )
  )
    return "write";
  return "other";
}

function stableHookSessionId(agent: string, raw: any) {
  const projectPath =
    raw?.cwd ??
    raw?.workspace ??
    raw?.project_dir ??
    raw?.context?.workspaceDir ??
    process.cwd();
  const seed = [
    agent,
    projectPath,
    raw?.pid ?? "",
    raw?.process_id ?? "",
    raw?.terminal_id ?? "",
    raw?.conversation_id ?? "",
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
  const text = values.join(" ") || eventTextForIntent(request);
  if (/\.env(?:\b|["'\\/\s])/.test(text)) return ".env";
  const match = text.match(
    /(?:^|[/"'\s])([A-Za-z0-9._-]*(?:credentials|kubeconfig|id_rsa|id_ed25519|\.npmrc)[A-Za-z0-9._-]*)/i,
  );
  return match?.[1] ? truncate(match[1], 80) : "unknown-resource";
}

app.put("/admin/policies/:id", async (req, res, next) => {
  try {
    const organizationId = await organizationIdForAdminRequest(req);
    const naturalLanguageRule = String(req.body.naturalLanguageRule ?? "");
    const name = summarizePolicyTitle(naturalLanguageRule);
    const category = policyCategory(
      String(req.body.category ?? ""),
      name,
      naturalLanguageRule,
    );
    const result = await pool.query(
      `update policies set name = $3, category = $4, description = $5, severity = $6, natural_language_rule = $7, enabled = $8, locked = $9, updated_at = now()
       where id = $1 and organization_id = $2 returning *`,
      [
        req.params.id,
        organizationId,
        name,
        category,
        req.body.description ?? "",
        req.body.severity ?? "medium",
        naturalLanguageRule,
        req.body.enabled,
        Boolean(req.body.locked),
      ],
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const status = statusCodeForError(err);
    if (status >= 500) console.error(err);
    const message = err instanceof Error ? err.message : "unknown error";
    res.status(status).json({ success: false, error: message, message });
  },
);

function summarizeAgentActivity(agent: {
  display_name: string;
  event_name?: string;
  tool_name?: string;
  prompt?: string;
  project_path?: string;
  decision?: string;
  resolution?: string;
  question?: string;
  decision_summary?: string;
  payload?: unknown;
}) {
  if (agent.question && !agent.resolution)
    return `Waiting for approval: ${agent.question}`;
  const purpose = actionPurposeFromPayload(agent.payload);
  if (purpose) return truncate(purpose, 140);

  const target = extractTarget(agent.payload);
  if (agent.tool_name) {
    return target
      ? `Using ${agent.tool_name} on ${truncate(target, 70)}`
      : `Using ${agent.tool_name}`;
  }
  if (agent.event_name === "UserPromptSubmit" && agent.prompt) {
    return `Prompt: ${truncate(agent.prompt, 100)}`;
  }
  if (
    agent.decision_summary &&
    !isBoringEvaluationSummary(agent.decision_summary)
  ) {
    return truncate(agent.decision_summary, 140);
  }
  return agent.prompt ? `Prompt: ${truncate(agent.prompt, 100)}` : "Active";
}

function extractTarget(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const event = payload as { tool?: { input?: unknown }; prompt?: string };
  const input = event.tool?.input;
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const candidate =
    record.file_path ?? record.path ?? record.command ?? record.url;
  return typeof candidate === "string" ? candidate : undefined;
}

function actionPurposeFromPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const summary = (payload as { openleashPurposeSummary?: unknown })
    .openleashPurposeSummary;
  return typeof summary === "string" && summary.trim()
    ? summary.trim()
    : undefined;
}

function isBoringEvaluationSummary(summary?: string | null) {
  if (!summary) return false;
  return /all active policies passed/i.test(summary);
}

function shouldDeferPromptOnlyApproval(
  request: EvaluationRequest,
  results: PolicyDecision[],
) {
  if (!isPromptOnlyHook(request)) return false;
  return results.some(
    (result) =>
      result.status === "failed" || result.status === "needs_question",
  );
}

function isPromptOnlyHook(request: EvaluationRequest) {
  return (
    request.event.eventName === "UserPromptSubmit" && !request.event.tool?.name
  );
}

function isNonActionableHookEvent(eventName: string) {
  return [
    "PostToolUse",
    "Stop",
    "SessionStart",
    "SessionEnd",
    "SubagentStart",
    "SubagentStop",
    "Notification",
  ].includes(eventName);
}

function deferPromptOnlyPolicyResults(
  results: PolicyDecision[],
): PolicyDecision[] {
  return results.map((result) =>
    result.status === "passed"
      ? result
      : {
          ...result,
          status: "passed",
          explanation:
            "Prompt-only intent observed. Enforcement is deferred until the agent attempts the actual tool action.",
          evidence: [],
          question: undefined,
        },
  );
}

async function withTranscriptContext(
  payload: unknown,
  occurredAt?: string | Date,
) {
  if (!payload || typeof payload !== "object") return payload;
  const event = payload as {
    transcript?: unknown;
    raw?: { transcript_path?: unknown; transcriptPath?: unknown };
  };
  if (Array.isArray(event.transcript) && event.transcript.length > 0)
    return payload;
  const transcript = await readClaudeTranscript(
    event.raw?.transcript_path ?? event.raw?.transcriptPath,
    occurredAt,
  );
  return transcript ? { ...event, transcript } : payload;
}

async function readClaudeTranscript(
  filePath: unknown,
  occurredAt?: string | Date,
): Promise<ConversationTurn[] | undefined> {
  if (typeof filePath !== "string" || !filePath.trim()) return undefined;
  const resolved = path.resolve(filePath);
  const claudeProjects = path.join(os.homedir(), ".claude", "projects");
  if (!resolved.startsWith(claudeProjects)) return undefined;
  try {
    const cutoff = occurredAt
      ? new Date(occurredAt).getTime() + 5000
      : undefined;
    const content = await fs.readFile(resolved, "utf8");
    const turns = content
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => claudeTranscriptTurn(line))
      .filter((turn) => {
        if (!cutoff || !turn.at) return true;
        const at = new Date(turn.at).getTime();
        return Number.isNaN(at) || at <= cutoff;
      });
    return turns.length > 0 ? turns.slice(-20) : undefined;
  } catch {
    return undefined;
  }
}

function claudeTranscriptTurn(line: string): ConversationTurn[] {
  try {
    const record = JSON.parse(line) as {
      type?: unknown;
      timestamp?: unknown;
      message?: { role?: unknown; content?: unknown };
    };
    const role =
      typeof record.message?.role === "string"
        ? record.message.role
        : record.type;
    if (role !== "user" && role !== "assistant") return [];
    const content = transcriptContentToText(record.message?.content);
    if (!content || shouldSkipTranscriptText(content)) return [];
    return [
      {
        role,
        content,
        at: typeof record.timestamp === "string" ? record.timestamp : undefined,
      },
    ];
  } catch {
    return [];
  }
}

function transcriptContentToText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as {
        type?: unknown;
        text?: unknown;
        content?: unknown;
      };
      if (record.type === "text" && typeof record.text === "string")
        return record.text;
      if (record.type === "tool_result" && typeof record.content === "string")
        return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function shouldSkipTranscriptText(value: string) {
  const normalized = value.trim();
  return (
    !normalized ||
    normalized.startsWith("Operation stopped by hook:") ||
    normalized.startsWith("<system-reminder>") ||
    normalized.startsWith("Caveat:") ||
    normalized.includes("<local-command-stdout>")
  );
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function projectTag(value?: string) {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function publicApiUrl(req: express.Request) {
  return (
    process.env.OPENLEASH_PUBLIC_API_URL ??
    `${req.protocol}://${req.get("host")}`
  );
}

function desktopRedirectUriFallback() {
  return "openleash://auth/callback";
}

function webGoogleRedirectUri(req: express.Request) {
  return (
    process.env.OPENLEASH_GOOGLE_WEB_REDIRECT_URI ??
    `${publicApiUrl(req)}/v1/auth/google/callback`
  );
}

function webMicrosoftRedirectUri(req: express.Request) {
  return (
    process.env.OPENLEASH_MICROSOFT_WEB_REDIRECT_URI ??
    `${publicApiUrl(req)}/v1/auth/microsoft/callback`
  );
}

function webGithubRedirectUri(req: express.Request) {
  return githubRedirectUriForRequest(req, "web");
}

function publicCloudAuthRedirectUri(
  req: express.Request,
  providerType: "google" | "azure_ad" | "github",
  finalRedirectUri: string,
) {
  const surface = isMainWebAccountCallbackRedirect(finalRedirectUri)
    ? "web"
    : "desktop";
  if (providerType === "azure_ad") {
    return surface === "web"
      ? `${publicApiUrl(req)}/v1/auth/microsoft/callback`
      : (process.env.OPENLEASH_MICROSOFT_REDIRECT_URI ??
          `${publicApiUrl(req)}/v1/auth/microsoft/callback`);
  }
  if (providerType === "github")
    return githubRedirectUriForRequest(req, surface);
  return surface === "web"
    ? `${publicApiUrl(req)}/v1/auth/google/callback`
    : (process.env.OPENLEASH_GOOGLE_REDIRECT_URI ??
        `${publicApiUrl(req)}/v1/auth/google/callback`);
}

function isMainWebAccountCallbackRedirect(redirectUri: string) {
  try {
    const url = new URL(redirectUri);
    return url.pathname === "/account/callback";
  } catch {
    return false;
  }
}

async function ensureDefaultOrganization() {
  const existing = await pool.query(
    `select * from organizations
     order by setup_completed desc, updated_at desc, created_at desc
     limit 1`,
  );
  if (existing.rows[0]) {
    const organization = existing.rows[0];
    await pool.query(
      `update users set organization_id = $1 where organization_id is null`,
      [organization.id],
    );
    return organization as {
      id: string;
      name: string;
      slug: string;
      region?: string | null;
      logo_url?: string | null;
      setup_completed: boolean;
      current_step: number;
      onboarding_code?: string | null;
      deployment_mode?: string | null;
      infrastructure_config?: Record<string, unknown> | null;
      created_at: string;
      updated_at: string;
    };
  }
  const result = await pool.query(
    `insert into organizations (name, slug, region, onboarding_code)
     values ($1, $2, $3, $4)
     on conflict (slug) do update set updated_at = now()
     returning *`,
    [
      process.env.OPENLEASH_ORG_NAME ?? "",
      process.env.OPENLEASH_ORG_SLUG ?? "openleash",
      process.env.OPENLEASH_ORG_REGION ?? null,
      process.env.OPENLEASH_ONBOARDING_CODE ?? null,
    ],
  );
  const organization = result.rows[0];
  await pool.query(
    `update users set organization_id = $1 where organization_id is null`,
    [organization.id],
  );
  return organization as {
    id: string;
    name: string;
    slug: string;
    region?: string | null;
    logo_url?: string | null;
    setup_completed: boolean;
    current_step: number;
    onboarding_code?: string | null;
    deployment_mode?: string | null;
    infrastructure_config?: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  };
}

async function resolveOnboardingOrganization(req: express.Request) {
  const session = await getDashboardSession(req.header("authorization") ?? "");
  if (!session) throw new HttpError(401, "dashboard session required");
  if (!isDashboardAccessRole(session.user.role)) {
    throw new HttpError(403, "dashboard admin role required");
  }
  const slug = String(
    req.query.organizationSlug ??
      req.body?.organizationSlug ??
      req.query.slug ??
      "",
  ).trim();
  if (slug) {
    if (slug !== session.organization.slug)
      throw new HttpError(403, "cannot access another organization");
    const organization = await getOrganizationBySlug(slug);
    if (!organization) {
      const error = new Error(`Organization ${slug} was not found`);
      (error as Error & { status?: number }).status = 404;
      throw error;
    }
    await pool.query(
      `update users set organization_id = $1 where organization_id is null`,
      [organization.id],
    );
    return organization as Awaited<
      ReturnType<typeof ensureDefaultOrganization>
    >;
  }
  const organization = await getOrganizationById(session.organization.id);
  if (!organization) throw new HttpError(404, "organization not found");
  return organization as Awaited<ReturnType<typeof ensureDefaultOrganization>>;
}

async function ensureManagedMobileOrganization() {
  const slug = slugifyTenant(
    process.env.OPENLEASH_MANAGED_MOBILE_ORG_SLUG ??
      process.env.OPENLEASH_DEV_ORG_SLUG ??
      "openleash-dev",
  );
  const deploymentMode = normalizeDeploymentMode(
    process.env.OPENLEASH_DEPLOYMENT_MODE,
  );
  const result = await pool.query(
    `insert into organizations (name, slug, region, setup_completed, current_step, deployment_mode)
     values ($1, $2, $3, true, 6, $4)
     on conflict (slug) do update set updated_at = now()
     returning id, name, slug, region, setup_completed, current_step, deployment_mode`,
    [
      process.env.OPENLEASH_MANAGED_MOBILE_ORG_NAME ?? "Leash Managed Dev",
      slug,
      process.env.OPENLEASH_ORG_REGION ?? null,
      deploymentMode,
    ],
  );
  return result.rows[0] as {
    id: string;
    name: string;
    slug: string;
    region?: string | null;
    setup_completed: boolean;
    current_step: number;
    deployment_mode?: string | null;
  };
}

type ManagedAuthProfile = {
  subject: string;
  email: string;
  name: string;
  givenName: string | null;
  familyName: string | null;
  raw: Record<string, unknown>;
};

type ManagedOrganization = {
  id: string;
  name: string;
  slug: string;
  region?: string | null;
  setup_completed: boolean;
  current_step?: number;
  deployment_mode?: string | null;
  defaultUserRole?: string;
};

async function resolveManagedMobileOrganization(
  profile: ManagedAuthProfile,
  audience: "individual" | "organization" = "individual",
): Promise<ManagedOrganization> {
  const email = profile.email.toLowerCase();
  const domain = email.split("@")[1]?.trim() ?? "";
  if (audience === "organization" && domain) {
    const organization = await resolveOrganizationForWorkDomain(domain);
    return {
      ...organization,
      defaultUserRole: await initialOrganizationLoginRole(organization.id),
    };
  }
  const personal = await resolvePersonalCloudOrganization(profile);
  if (personal) return { ...personal, defaultUserRole: "owner" };
  const configuredSlug =
    process.env.OPENLEASH_MANAGED_MOBILE_ORG_SLUG ??
    process.env.OPENLEASH_DEV_ORG_SLUG;
  const existing = configuredSlug
    ? await getOrganizationBySlug(configuredSlug)
    : undefined;
  if (existing) {
    const configuredName =
      process.env.OPENLEASH_MANAGED_MOBILE_ORG_NAME?.trim();
    if (configuredName && !String(existing.name ?? "").trim()) {
      const updated = await pool.query(
        `update organizations set name = $2, deployment_mode = $3, updated_at = now() where id = $1 returning *`,
        [
          existing.id,
          configuredName,
          normalizeDeploymentMode(process.env.OPENLEASH_DEPLOYMENT_MODE),
        ],
      );
      return {
        ...updated.rows[0],
        defaultUserRole:
          audience === "organization"
            ? await initialOrganizationLoginRole(existing.id)
            : "engineer",
      };
    }
    return {
      ...existing,
      defaultUserRole: "engineer",
    };
  }

  return {
    ...(await ensureManagedMobileOrganization()),
    defaultUserRole: "engineer",
  };
}

async function resolvePersonalCloudOrganization(
  profile: ManagedAuthProfile,
): Promise<ManagedOrganization | undefined> {
  const email = profile.email.trim().toLowerCase();
  if (!email) return undefined;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `openleash-personal-workspace:${email}`,
    ]);
    const existing = await client.query(
      `select o.*,u.id as personal_user_id,
              (select count(*)::int from users members
               where members.organization_id=o.id and members.status='active') as active_user_count
       from users u
       join organizations o on o.id = u.organization_id
       where lower(u.email) = lower($1)
       limit 1
       for update of u`,
      [email],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0] as ManagedOrganization & {
        personal_user_id: string;
        active_user_count: number;
        infrastructure_config?: Record<string, unknown>;
      };
      const config = row.infrastructure_config ?? {};
      const explicitlyPersonal =
        config.accountAudience === "individual" ||
        config.accountPackage === "personal_cloud";
      const explicitlyBusiness =
        config.accountAudience === "organization" ||
        config.accountPackage === "work-managed";
      if (explicitlyBusiness) {
        throw new HttpError(
          409,
          "This work email already belongs to a Business workspace. Continue with Business instead.",
        );
      }
      if (explicitlyPersonal && Number(row.active_user_count) <= 1) {
        await client.query("commit");
        return row;
      }

      // Legacy Personal identities were once pooled in one development
      // workspace. Split them on their next sign-in without carrying another
      // person's data or credentials into the new tenant.
      await client.query(
        `update dashboard_sessions set revoked_at=coalesce(revoked_at,now()) where user_id=$1`,
        [row.personal_user_id],
      );
      if ((await client.query<{ exists: boolean }>(
        `select to_regclass('desktop_credentials') is not null as exists`,
      )).rows[0]?.exists) {
        await client.query(
          `update desktop_credentials set revoked_at=coalesce(revoked_at,now()) where user_id=$1`,
          [row.personal_user_id],
        );
      }
      await client.query(
        `update mobile_devices set push_token=null where user_id=$1`,
        [row.personal_user_id],
      );
      await client.query(
        `update users
         set email=concat('isolated-',id::text,'@personal.invalid'),
             status='disabled',token_hash=null,idp_user_id=null,idp_provider=null,
             metadata=coalesce(metadata,'{}'::jsonb)
               || jsonb_build_object('isolatedPersonalWorkspaceAt',now()::text,'previousEmail',$2::text)
         where id=$1`,
        [row.personal_user_id, email],
      );
    }
    const suffix = crypto.createHash("sha256").update(email).digest("hex").slice(0, 16);
    const inserted = await client.query(
      `insert into organizations (
         name, slug, region, setup_completed, current_step, deployment_mode, infrastructure_config
       ) values (
         'Personal workspace', $1, $2, true, 6, 'cloud',
         jsonb_build_object('accountPackage', 'personal_cloud', 'accountAudience', 'individual')
       )
       on conflict (slug) do update set updated_at = now()
       returning *`,
      [`personal-${suffix}`, process.env.OPENLEASH_ORG_REGION ?? null],
    );
    await client.query("commit");
    return inserted.rows[0] as ManagedOrganization;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function resolveOrganizationForWorkDomain(
  rawDomain: string,
): Promise<ManagedOrganization> {
  const domain = rawDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) {
    throw new HttpError(400, "A valid company email domain is required");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    // Serializes the first login for one domain without blocking unrelated
    // companies. A mailbox login observes the domain; it does not claim that
    // the employee is an IdP administrator or that the domain is DNS-verified.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `openleash-company-domain:${domain}`,
    ]);
    const mapped = await client.query(
      `select o.*
       from organization_domains domain_map
       join organizations o on o.id = domain_map.organization_id
       where domain_map.normalized_domain = $1
       limit 1`,
      [domain],
    );
    if (mapped.rows[0]) {
      await client.query("commit");
      return mapped.rows[0] as ManagedOrganization;
    }

    // Never infer company ownership from arbitrary users who happen to share
    // an email suffix. Legacy Personal accounts lived in a shared workspace;
    // adopting it here would cross tenant boundaries. A first Business login
    // always creates a distinct company workspace under the domain lock.
    const accountPackage = accountPackageForNewSession("organization");
    const baseSlug = slugifyTenant(domain);
    const fallbackSlug = `${baseSlug.slice(0, 39)}-${crypto
      .createHash("sha256")
      .update(domain)
      .digest("hex")
      .slice(0, 8)}`;
    const inserted = await client.query(
        `insert into organizations (
           name, slug, region, setup_completed, current_step, deployment_mode, infrastructure_config
         ) values (
           $1, $2, $3, false, 1, 'cloud',
           jsonb_build_object(
             'accountPackage', $4::text,
             'identityDomain', $5::text,
             'domainJoinPolicy', 'invite_only'
           )
         )
         on conflict (slug) do nothing
         returning *`,
        [
          organizationNameFromDomain(domain),
          baseSlug,
          process.env.OPENLEASH_ORG_REGION ?? null,
          accountPackage,
          domain,
        ],
    );
    let organization = inserted.rows[0] as ManagedOrganization | undefined;
    if (!organization) {
      const fallback = await client.query(
          `insert into organizations (
             name, slug, region, setup_completed, current_step, deployment_mode, infrastructure_config
           ) values (
             $1, $2, $3, false, 1, 'cloud',
             jsonb_build_object(
               'accountPackage', $4::text,
               'identityDomain', $5::text,
               'domainJoinPolicy', 'invite_only'
             )
           )
           returning *`,
          [
            organizationNameFromDomain(domain),
            fallbackSlug,
            process.env.OPENLEASH_ORG_REGION ?? null,
            accountPackage,
            domain,
          ],
      );
      organization = fallback.rows[0] as ManagedOrganization;
    }

    await client.query(
      `insert into organization_domains (
         normalized_domain, organization_id, status, verification_method, updated_at
       ) values ($1, $2, 'observed', 'oauth_email_domain', now())
       on conflict (normalized_domain) do nothing`,
      [domain, organization.id],
    );
    await client.query(
      `update organizations
       set infrastructure_config = coalesce(infrastructure_config, '{}'::jsonb)
         || jsonb_build_object('identityDomain', $2::text),
           updated_at = now()
       where id = $1`,
      [organization.id, domain],
    );
    await client.query("commit");
    return organization;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function initialOrganizationLoginRole(organizationId: string) {
  const result = await pool.query(
    `select exists (
       select 1
       from users
       where organization_id = $1
         and status = 'active'
         and role in ('owner', 'admin', 'ciso', 'security_admin')
     ) as has_administrator`,
    [organizationId],
  );
  return result.rows[0]?.has_administrator ? "engineer" : "admin";
}

async function resolveExistingMobileOrganizationForProfile(
  profile: ManagedAuthProfile,
): Promise<ManagedOrganization> {
  const result = await pool.query(
    `select o.id, o.name, o.slug, o.region, o.setup_completed, o.current_step, o.deployment_mode, u.role as default_user_role
     from users u
     join organizations o on o.id = u.organization_id
     where lower(u.email) = lower($1)
       and u.status = 'active'
     order by case when u.role in ('owner', 'admin') then 0 else 1 end, u.last_login_at desc nulls last
     limit 1`,
    [profile.email],
  );
  if (result.rows[0]) {
    return {
      ...result.rows[0],
      defaultUserRole: result.rows[0].default_user_role ?? "engineer",
    };
  }
  const error = new Error(
    "No OpenLeash account exists for this email. Create your account from desktop or the web, then sign in on mobile.",
  );
  (error as Error & { status?: number }).status = 403;
  throw error;
}

function organizationNameFromDomain(domain: string) {
  const first = domain.split(".")[0] || "Company";
  return (
    first
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ") || "Company"
  );
}

function displayNameFromEmail(email: string) {
  const localPart = email.split("@")[0]?.trim() ?? "";
  const displayName = localPart
    .split(/[._+-]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
  return displayName || "Leash user";
}

function isPersonalEmailDomain(email: string) {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
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
    "ymail.com",
    "proton.me",
    "protonmail.com",
    "aol.com",
    "gmx.com",
    "mail.com",
    "hey.com",
  ]).has(domain);
}

async function canUseCloudOwnerLogin(organizationId: string, email: string) {
  const result = await pool.query(
    `select 1
     from users
     where organization_id = $1
       and lower(email) = lower($2)
       and role in ('owner', 'admin')
       and status = 'active'
     limit 1`,
    [organizationId, email],
  );
  return Boolean(result.rows[0]);
}

function generateOnboardingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chars = Array.from(
    { length: 12 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

function slugifyTenant(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "openleash"
  );
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function optionalString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function pluginUpdatePolicy(
  value: unknown,
): PluginSettingRecord["updatePolicy"] | undefined {
  return value === "manual" ||
    value === "patch" ||
    value === "minor" ||
    value === "locked"
    ? value
    : undefined;
}

function normalizeGithubRepositoryUrl(value: unknown) {
  const raw = optionalString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || host !== "github.com") return undefined;
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    const owner = parts[0];
    const repo = parts[1]?.replace(/\.git$/i, "");
    if (!owner || !repo || owner.startsWith(".") || repo.startsWith("."))
      return undefined;
    return `https://github.com/${owner}/${repo}`;
  } catch {
    return undefined;
  }
}

function arrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeDeploymentMode(value: unknown) {
  const normalized = String(value ?? "cloud").toLowerCase();
  return normalized.includes("private") ||
    normalized.includes("onprem") ||
    normalized.includes("on-prem")
    ? "private"
    : "cloud";
}

function normalizeAccountPackage(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (
    ["personal-byok", "personal-managed", "work-byok", "work-managed"].includes(
      normalized,
    )
  ) {
    return normalized as
      "personal-byok" | "personal-managed" | "work-byok" | "work-managed";
  }
  return null;
}

function accountPackageForNewSession(
  audience: "individual" | "organization",
) {
  const configured = normalizeAccountPackage(
    process.env.OPENLEASH_DEV_ACCOUNT_PACKAGE,
  );
  if (audience === "individual") {
    if (configured?.startsWith("personal-")) return configured;
    return defaultAccountPackage(audience, process.env.OPENLEASH_DEPLOYMENT_MODE);
  }
  return defaultAccountPackage(audience, process.env.OPENLEASH_DEPLOYMENT_MODE);
}

async function organizationUsesManagedEvaluation(organizationId: string) {
  void organizationId;
  return deploymentUsesManagedEvaluation(
    process.env.OPENLEASH_DEPLOYMENT_MODE,
  );
}

async function getOrganizationBySlug(slug: string) {
  const normalized = slugifyTenant(slug);
  const result = await pool.query(
    `select * from organizations where slug = $1 limit 1`,
    [normalized],
  );
  return result.rows[0] as
    | {
        id: string;
        name: string;
        slug: string;
        setup_completed: boolean;
        deployment_mode?: string | null;
      }
    | undefined;
}

async function getOrganizationById(id: string) {
  const result = await pool.query(
    `select * from organizations where id = $1 limit 1`,
    [id],
  );
  return result.rows[0] as
    | {
        id: string;
        name: string;
        slug: string;
        region?: string | null;
        setup_completed: boolean;
        deployment_mode?: string | null;
      }
    | undefined;
}

function ssoProviderType(provider: string) {
  const normalized = provider.toLowerCase();
  if (normalized === "azuread") return "azure_ad";
  if (normalized === "okta") return "okta";
  if (normalized === "google") return "google_workspace";
  if (normalized === "ping") return "ping";
  if (
    normalized === "oidc" ||
    normalized === "openidconnect" ||
    normalized === "openid_connect" ||
    normalized === "generic_oidc"
  )
    return "oidc";
  if (normalized === "activedirectory") return "active_directory";
  return normalized;
}

function normalizePublicCloudAuthProvider(provider: string) {
  const normalized = provider.toLowerCase().replace(/[\s-]+/g, "_");
  if (
    normalized === "azure_ad" ||
    normalized === "azuread" ||
    normalized === "microsoft"
  )
    return "azure_ad";
  if (normalized === "github") return "github";
  return "google";
}

function clientModeFromEnvironment() {
  const mode = String(
    process.env.OPENLEASH_CLIENT_MODE ??
      process.env.OPENLEASH_DEPLOYMENT_MODE ??
      "cloud",
  ).toLowerCase();
  if (
    mode.includes("enterprise") ||
    mode.includes("private") ||
    mode.includes("onprem") ||
    mode.includes("on-prem")
  )
    return "enterprise";
  if (
    mode.includes("community") ||
    mode.includes("personal") ||
    mode.includes("individual") ||
    mode.includes("open-source") ||
    mode.includes("opensource")
  )
    return "community";
  return "cloud";
}

function mobileGoogleConfig() {
  return {
    ClientId:
      process.env.OPENLEASH_GOOGLE_CLIENT_ID ??
      process.env.GOOGLE_CLIENT_ID ??
      "",
    ClientSecret:
      process.env.OPENLEASH_GOOGLE_CLIENT_SECRET ??
      process.env.GOOGLE_CLIENT_SECRET ??
      "",
  };
}

function cloudMicrosoftConfig() {
  return {
    TenantId:
      process.env.OPENLEASH_MICROSOFT_TENANT_ID ??
      process.env.MICROSOFT_ENTRA_TENANT_ID ??
      process.env.AZURE_TENANT_ID ??
      "organizations",
    ClientId:
      process.env.OPENLEASH_MICROSOFT_CLIENT_ID ??
      process.env.MICROSOFT_CLIENT_ID ??
      process.env.AZURE_CLIENT_ID ??
      "",
    ClientSecret:
      process.env.OPENLEASH_MICROSOFT_CLIENT_SECRET ??
      process.env.MICROSOFT_CLIENT_SECRET ??
      process.env.AZURE_CLIENT_SECRET ??
      "",
  };
}

function cloudGithubConfig(redirectUri?: string) {
  const useDev = isLocalhostRedirectUri(redirectUri);
  return useDev
    ? {
        ClientId:
          process.env.OPENLEASH_GITHUB_DEV_CLIENT_ID ??
          process.env.OPENLEASH_GITHUB_CLIENT_ID ??
          process.env.GITHUB_CLIENT_ID ??
          "",
        ClientSecret:
          process.env.OPENLEASH_GITHUB_DEV_CLIENT_SECRET ??
          process.env.OPENLEASH_GITHUB_CLIENT_SECRET ??
          process.env.GITHUB_CLIENT_SECRET ??
          "",
      }
    : {
        ClientId:
          process.env.OPENLEASH_GITHUB_CLIENT_ID ??
          process.env.GITHUB_CLIENT_ID ??
          "",
        ClientSecret:
          process.env.OPENLEASH_GITHUB_CLIENT_SECRET ??
          process.env.GITHUB_CLIENT_SECRET ??
          "",
      };
}

function githubRedirectUriForRequest(
  req: express.Request,
  surface: "desktop" | "web" = "desktop",
) {
  const localDefault = `${publicApiUrl(req)}/v1/auth/github/callback`;
  if (isLocalhostRedirectUri(localDefault)) {
    return surface === "web"
      ? (process.env.OPENLEASH_GITHUB_DEV_WEB_REDIRECT_URI ??
          process.env.OPENLEASH_GITHUB_DEV_REDIRECT_URI ??
          localDefault)
      : (process.env.OPENLEASH_GITHUB_DEV_REDIRECT_URI ?? localDefault);
  }
  return surface === "web"
    ? (process.env.OPENLEASH_GITHUB_WEB_REDIRECT_URI ??
        process.env.OPENLEASH_GITHUB_REDIRECT_URI ??
        localDefault)
    : (process.env.OPENLEASH_GITHUB_REDIRECT_URI ?? localDefault);
}

function isLocalhostRedirectUri(redirectUri?: string) {
  if (!redirectUri) return false;
  try {
    const url = new URL(redirectUri);
    return ["localhost", "127.0.0.1"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function buildMobileGoogleAuthorizationUrl(
  redirectUri: string,
  state: string,
) {
  return buildAuthorizationUrl(
    "google_workspace",
    mobileGoogleConfig(),
    redirectUri,
    state,
  );
}

type OAuthLoginState = {
  providerType: string;
  audience: "individual" | "organization";
  organizationId?: string;
  organizationSlug?: string;
  finalRedirectUri: string;
  exchangeRedirectUri: string;
  codeChallenge?: string;
};

async function createOAuthLoginState(context: OAuthLoginState) {
  const state = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `insert into oauth_login_states (
       state_hash, provider_type, audience, organization_id,
       organization_slug, final_redirect_uri, exchange_redirect_uri, code_challenge,
       expires_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '10 minutes')`,
    [
      hashToken(state),
      context.providerType,
      context.audience,
      context.organizationId ?? null,
      context.organizationSlug ?? null,
      context.finalRedirectUri,
      context.exchangeRedirectUri,
      context.codeChallenge ?? null,
    ],
  );
  return state;
}

async function activeOAuthLoginState(
  state: string,
  expectedProviderType: string,
) {
  if (!validOAuthState(state)) return undefined;
  const result = await pool.query<{
    provider_type: string;
    audience: "individual" | "organization";
    organization_id: string | null;
    organization_slug: string | null;
    final_redirect_uri: string;
    exchange_redirect_uri: string;
  }>(
    `select provider_type, audience, organization_id, organization_slug,
            final_redirect_uri, exchange_redirect_uri
     from oauth_login_states
     where state_hash = $1
       and provider_type = $2
       and consumed_at is null
       and expires_at > now()
     limit 1`,
    [hashToken(state), expectedProviderType],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    providerType: row.provider_type,
    audience: row.audience,
    organizationId: row.organization_id ?? undefined,
    organizationSlug: row.organization_slug ?? undefined,
    finalRedirectUri: row.final_redirect_uri,
    exchangeRedirectUri: row.exchange_redirect_uri,
  } satisfies OAuthLoginState;
}

async function consumeOAuthLoginState({
  state,
  providerType,
  audience,
  organizationId,
  organizationSlug,
  exchangeRedirectUri,
  codeVerifier,
}: {
  state: string;
  providerType: string;
  audience: "individual" | "organization";
  organizationId?: string;
  organizationSlug?: string;
  exchangeRedirectUri: string;
  codeVerifier?: string;
}) {
  if (!validOAuthState(state)) return false;
  const codeChallenge = codeVerifier && validPkceValue(codeVerifier)
    ? crypto.createHash("sha256").update(codeVerifier).digest("base64url")
    : null;
  const result = await pool.query(
    `update oauth_login_states
     set consumed_at = now()
     where state_hash = $1
       and provider_type = $2
       and audience = $3
       and organization_id is not distinct from $4::uuid
       and coalesce(organization_slug, '') = coalesce($5::text, '')
       and exchange_redirect_uri = $6
       and code_challenge is not distinct from $7::text
       and consumed_at is null
       and expires_at > now()
     returning id`,
    [
      hashToken(state),
      providerType,
      audience,
      organizationId ?? null,
      organizationSlug ?? null,
      exchangeRedirectUri,
      codeChallenge,
    ],
  );
  return (result.rowCount ?? 0) === 1;
}

function validOAuthState(state: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(state);
}

function isAllowedAuthRedirectUri(redirectUri: string) {
  try {
    const url = new URL(redirectUri);
    if (url.protocol === "openleash:") {
      return url.hostname === "auth" &&
        url.pathname === "/callback" &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash;
    }
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
      return true;
    const allowedHosts = (
      process.env.OPENLEASH_ALLOWED_AUTH_REDIRECT_HOSTS ?? "localhost,127.0.0.1"
    )
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    if (
      url.protocol === "https:" &&
      allowedHosts.includes(url.hostname.toLowerCase())
    )
      return true;
    return false;
  } catch {
    return false;
  }
}

function defaultMobileProviders() {
  return [
    {
      id: "openleash-google",
      type: "google",
      label: "Google Workspace",
    },
    {
      id: "openleash-github",
      type: "github",
      label: "GitHub",
    },
    {
      id: "openleash-microsoft",
      type: "azure_ad",
      label: "Microsoft 365",
    },
  ];
}

async function mobileProvidersForOrganization(
  organizationId: string,
  organizationSlug: string,
) {
  const result = await pool.query(
    `select id, provider, enabled, config
     from idp_connections
     where organization_id = $1 and enabled = true
     order by updated_at desc`,
    [organizationId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    type: ssoProviderType(row.provider),
    label: ssoProviderLabel(row.provider),
    organizationId,
    organizationSlug,
  }));
}

async function configuredSsoProvider(
  organizationId: string,
  requestedProviderType?: string,
) {
  const result = await pool.query(
    `select provider, config from idp_connections where organization_id = $1 and enabled = true`,
    [organizationId],
  );
  const row =
    result.rows.find(
      (item) => ssoProviderType(item.provider) === requestedProviderType,
    ) ?? result.rows[0];
  if (!row) return undefined;
  return {
    providerType: ssoProviderType(row.provider),
    config: (row.config ?? {}) as Record<string, unknown>,
  };
}

async function exchangeOrganizationAuthorizationCode(
  organizationId: string,
  providerType: string,
  authorizationCode: string,
  redirectUri: string,
) {
  const provider = await configuredSsoProvider(organizationId, providerType);
  if (!provider)
    throw new Error(
      "Identity provider is not configured for this organization",
    );
  return exchangeAuthorizationCode(
    provider.providerType,
    provider.config,
    authorizationCode,
    redirectUri,
  );
}

async function createDashboardSessionFromProfile({
  organizationId,
  providerType,
  profile,
  role = "engineer",
  provisionUser = true,
  accountAudience = "individual",
  issueDesktopEnrollmentToken = false,
}: {
  organizationId: string;
  providerType: string;
  profile: ManagedAuthProfile;
  role?: string;
  provisionUser?: boolean;
  accountAudience?: "individual" | "organization";
  issueDesktopEnrollmentToken?: boolean;
}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const organizationResult = await client.query(
      `select id, name, slug, region, setup_completed, infrastructure_config
       from organizations where id = $1 limit 1`,
      [organizationId],
    );
    const organization = organizationResult.rows[0];
    if (!organization) throw new Error("Organization not found");
    const accountPackage =
      normalizeAccountPackage(organization.infrastructure_config?.accountPackage) ??
      accountPackageForNewSession(accountAudience);
    const profileNameParts = splitProfileName(profile.name || "");
    const firstName = profile.givenName || profileNameParts.givenName;
    const lastName = profile.familyName || profileNameParts.familyName;
    const displayName =
      [firstName, lastName].filter(Boolean).join(" ") ||
      profile.name ||
      profile.email.split("@")[0] ||
      "Leash user";
    const userEmail = profile.email.toLowerCase();
    const membership = provisionUser && accountAudience === "organization"
      ? await authorizeBusinessProvisioning(client, organizationId, userEmail, role)
      : { role };
    if (provisionUser && accountAudience === "organization") {
      await retirePersonalAccountForBusiness(
        client,
        userEmail,
        organizationId,
      );
    }
    const sessionMetadata = JSON.stringify({
      ssoProfile: profile.raw,
      mobile: true,
      accountAudience,
      accountPackage,
      ...(membership.grantId
        ? { membershipApproval: "grant", membershipGrantId: membership.grantId }
        : {}),
    });
    const userResult = provisionUser
      ? await client.query<{
          id: string;
          email: string;
          display_name: string;
          role: string;
        }>(
          `insert into users (organization_id, email, display_name, role, first_name, last_name, idp_user_id, idp_provider, status, last_login_at, metadata)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'active', now(), $9)
           on conflict (email) do update set
             display_name = excluded.display_name,
             role = case
               when users.role in ('owner', 'admin', 'ciso', 'security_admin') then users.role
               else excluded.role
             end,
             first_name = excluded.first_name,
             last_name = excluded.last_name,
             idp_user_id = excluded.idp_user_id,
             idp_provider = excluded.idp_provider,
             status = 'active',
             last_login_at = now(),
             metadata = coalesce(users.metadata, '{}'::jsonb) || excluded.metadata
           where users.organization_id = excluded.organization_id
           returning id, email, display_name, role`,
          [
            organizationId,
            userEmail,
            displayName,
            membership.role,
            firstName,
            lastName,
            profile.subject,
            providerType,
            sessionMetadata,
          ],
        )
      : await client.query<{
          id: string;
          email: string;
          display_name: string;
          role: string;
        }>(
          `update users
           set last_login_at = now(),
               idp_user_id = coalesce(users.idp_user_id, $3),
               idp_provider = coalesce(users.idp_provider, $4),
               metadata = coalesce(users.metadata, '{}'::jsonb) || $5::jsonb
           where organization_id = $1
             and lower(email) = lower($2)
             and status = 'active'
           returning id, email, display_name, role`,
          [
            organizationId,
            userEmail,
            profile.subject || null,
            providerType || null,
            sessionMetadata,
          ],
        );
    if (!userResult.rows[0]) {
      if (!provisionUser) {
        throw new HttpError(
          403,
          accountAudience === "organization"
            ? "This account is not provisioned for this Leash organization. Ask an admin to sync or invite your identity first."
            : "No Leash account exists for this email. Create your account from desktop or the web, then sign in on mobile.",
        );
      }
      throw new HttpError(
        409,
        "This email already belongs to another Leash workspace. Sign in to that workspace or ask its administrator to remove the account first.",
      );
    }
    if (membership.grantId) {
      await client.query(
        `update organization_membership_grants
         set consumed_at = coalesce(consumed_at, now()),
             consumed_by = coalesce(consumed_by, $2)
         where id = $1 and organization_id = $3`,
        [membership.grantId, userResult.rows[0].id, organizationId],
      );
    }
    const sessionToken = `ols_${crypto.randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(
      Date.now() +
        Number(process.env.OPENLEASH_DASHBOARD_SESSION_DAYS ?? 14) * 86400000,
    );
    await client.query(
      `insert into dashboard_sessions (organization_id, user_id, token_hash, provider, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [
        organizationId,
        userResult.rows[0].id,
        hashToken(sessionToken),
        providerType,
        expiresAt.toISOString(),
      ],
    );
    const desktopEnrollmentToken = issueDesktopEnrollmentToken
      ? `ole_${crypto.randomBytes(24).toString("base64url")}`
      : undefined;
    if (desktopEnrollmentToken) {
      const enrollmentExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await client.query(
        `insert into dashboard_sessions (organization_id, user_id, token_hash, provider, expires_at)
         values ($1, $2, $3, 'desktop_enrollment', $4)`,
        [
          organizationId,
          userResult.rows[0].id,
          hashToken(desktopEnrollmentToken),
          enrollmentExpiresAt.toISOString(),
        ],
      );
    }
    await client.query("commit");
    return {
      success: true,
      ...(desktopEnrollmentToken ? { desktopEnrollmentToken } : {}),
      token: sessionToken,
      sessionToken,
      tokens: { accessToken: sessionToken, expiresAt: expiresAt.toISOString() },
      user: userResult.rows[0],
      organization,
      account: {
        audience: accountAudience,
        packageId: accountPackage,
      },
      evaluationProvider: await tenantModelKeySummary(organizationId),
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function retirePersonalAccountForBusiness(
  client: PoolClient,
  email: string,
  targetOrganizationId: string,
) {
  const existing = await client.query<{
    id: string;
    organization_id: string;
    organization_slug: string;
    infrastructure_config: Record<string, unknown> | null;
  }>(
    `select u.id, u.organization_id, o.slug as organization_slug,
            o.infrastructure_config
     from users u
     join organizations o on o.id = u.organization_id
     where lower(u.email) = lower($1)
     limit 1
     for update of u`,
    [email],
  );
  const account = existing.rows[0];
  if (!account || account.organization_id === targetOrganizationId) return;
  const configuredLegacySlug = slugifyTenant(
    process.env.OPENLEASH_MANAGED_MOBILE_ORG_SLUG ??
      process.env.OPENLEASH_DEV_ORG_SLUG ??
      "openleash-dev",
  );
  const personalWorkspace =
    account.infrastructure_config?.accountAudience === "individual" ||
    account.infrastructure_config?.accountPackage === "personal_cloud" ||
    account.organization_slug === configuredLegacySlug;
  if (!personalWorkspace) return;

  const hasCloudBilling = await client.query<{ exists: boolean }>(
    `select to_regclass('cloud_billing_accounts') is not null as exists`,
  );
  if (hasCloudBilling.rows[0]?.exists) {
    const paid = await client.query<{ provider_subscription_id: string | null }>(
      `select provider_subscription_id
       from cloud_billing_accounts
       where organization_id=$1
         and provider_subscription_id is not null
         and (
           lower(status) in ('active','paid','past_due','on_trial','trialing')
           or (
             lower(status) in ('cancelled','canceled')
             and coalesce(ends_at,current_period_end) > now()
           )
         )
       limit 1
       for update`,
      [account.organization_id],
    );
    if (paid.rows[0]?.provider_subscription_id) {
      throw new HttpError(
        409,
        "Change your Personal Cloud subscription before joining a Business workspace so Leash never bills both accounts.",
      );
    }
    await client.query(
      `update cloud_billing_accounts
       set status='cancelled',trial_ends_at=least(coalesce(trial_ends_at,now()),now()),updated_at=now()
       where organization_id=$1
         and provider_subscription_id is null
         and lower(status) in ('pending','trial_pending','on_trial','trialing')`,
      [account.organization_id],
    );
  }

  // A Personal identity and its history are not silently transplanted into an
  // employer workspace. Retire its credentials, preserve its audit records in
  // the Personal tenant, and let the upsert below create a fresh Business user.
  await client.query(
    `update dashboard_sessions
     set revoked_at = coalesce(revoked_at, now())
     where user_id = $1`,
    [account.id],
  );
  if ((await client.query<{ exists: boolean }>(
    `select to_regclass('desktop_credentials') is not null as exists`,
  )).rows[0]?.exists) {
    await client.query(
      `update desktop_credentials
       set revoked_at=coalesce(revoked_at,now())
       where user_id=$1`,
      [account.id],
    );
  }
  await client.query(
    `update mobile_devices
     set push_token=null
     where user_id=$1`,
    [account.id],
  );
  await client.query(
    `update users
     set email = concat('converted-',id::text,'@personal.invalid'),
         status = 'disabled',
         token_hash = null,
         idp_user_id = null,
         idp_provider = null,
         metadata = coalesce(metadata, '{}'::jsonb)
           || jsonb_build_object(
                'convertedToBusinessOrganizationId',$2::text,
                'convertedAt',now()::text,
                'previousEmail',$3::text
              )
     where id = $1`,
    [account.id, targetOrganizationId, email],
  );
}

async function authorizeBusinessProvisioning(
  client: PoolClient,
  organizationId: string,
  email: string,
  requestedRole: string,
) {
  // Keep first-owner election and invitation consumption in the same
  // transaction as the user insert. Domain ownership alone is not membership.
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `openleash-business-membership:${organizationId}`,
  ]);
  const existing = await client.query<{ role: string; status: string }>(
    `select role, status from users
     where organization_id = $1 and lower(email) = lower($2)
     limit 1`,
    [organizationId, email],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].status !== "active") {
      throw new HttpError(
        403,
        "This Leash workspace membership is disabled. Contact your administrator.",
      );
    }
    return { role: existing.rows[0].role };
  }

  const bootstrap = await client.query<{
    member_count: number;
    bootstrap_claimed: boolean;
  }>(
    `select
       (select count(*)::int from users where organization_id=$1) as member_count,
       coalesce(infrastructure_config->>'bootstrapAdminClaimed','false')='true' as bootstrap_claimed
     from organizations
     where id=$1
     for update`,
    [organizationId],
  );
  if (
    Number(bootstrap.rows[0]?.member_count ?? 0) === 0 &&
    !bootstrap.rows[0]?.bootstrap_claimed
  ) {
    await client.query(
      `update organizations
       set infrastructure_config=coalesce(infrastructure_config,'{}'::jsonb)
         || jsonb_build_object(
              'bootstrapAdminClaimed',true,
              'bootstrapAdminClaimedAt',now()::text,
              'bootstrapAdminEmail',lower($2::text)
            ),
           updated_at=now()
       where id=$1`,
      [organizationId, email],
    );
    return { role: "admin" };
  }

  const grant = await client.query<{ id: string; granted_role: string }>(
      `select id, granted_role
       from organization_membership_grants
       where organization_id = $1
         and normalized_email = lower($2)
         and granted_role in ('engineer','viewer')
         and consumed_at is null
         and revoked_at is null
         and expires_at > now()
       order by created_at desc
       limit 1
       for update`,
      [organizationId, email],
  );
    if (grant.rows[0]) {
      return {
        role: grant.rows[0].granted_role || requestedRole,
        grantId: grant.rows[0].id,
      };
    }

  throw new HttpError(
    403,
    "Your company already has a Leash workspace. Ask its administrator to invite your exact work email, or sign in through its configured identity provider.",
  );
}

async function mobilePendingApprovals(
  userId: string,
  organizationId: string,
  includeOrganization = true,
) {
  const result = await pool.query(
    `select e.id, e.summary, e.question, e.created_at,
            ce.event_name, ce.tool_name, ce.project_path, ce.prompt, ce.payload, ce.occurred_at,
            ce.payload->'raw'->>'openleashIntentKey' as intent_key,
            ar.display_name as agent_name,
            ar.kind as agent_kind,
            c.hostname,
            u.display_name as user_name,
            coalesce(triggered.items, '[]'::jsonb) as triggered_policies
     from evaluations e
     join conversation_events ce on ce.id = e.conversation_event_id
     join agent_runtimes ar on ar.id = ce.agent_runtime_id
     join computers c on c.id = ce.computer_id
     left join users u on u.id = e.user_id
     left join lateral (
       select jsonb_agg(
         jsonb_build_object(
           'policy_name', pr.policy_name,
           'status', pr.status,
           'severity', pr.severity,
           'explanation', pr.explanation,
           'evidence', pr.evidence
         )
         order by pr.created_at asc
       ) as items
       from policy_results pr
       where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
     ) triggered on true
     where e.decision = 'ask'
       and e.resolution is null
       and (e.user_id = $1 or ($3::boolean and exists (
         select 1 from users u
         where u.id = e.user_id and u.organization_id = $2
       )))
     order by e.created_at asc
     limit 20`,
    [userId, organizationId, includeOrganization],
  );
  const rows = dedupePendingApprovalRows(result.rows);
  return {
    ...result,
    rows: await Promise.all(rows.map((row) => enrichMobileApproval(row))),
  };
}

function dedupePendingApprovalRows<
  T extends {
    intent_key?: string | null;
    agent_kind?: string | null;
    project_path?: string | null;
    tool_name?: string | null;
    event_name?: string | null;
    prompt?: string | null;
    summary?: string | null;
  },
>(rows: T[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = pendingIntentKey({
      intentKey: row.intent_key,
      agentKind: row.agent_kind,
      projectPath: row.project_path,
      prompt: "prompt" in row ? String(row.prompt ?? "") : undefined,
      toolName: row.tool_name,
      eventName: row.event_name,
      summary: row.summary,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function enrichMobileApproval(row: {
  id?: string;
  tool_name?: string | null;
  agent_name?: string | null;
  agent_kind?: string | null;
  hostname?: string | null;
  created_at?: string | Date;
  project_path?: string | null;
  prompt?: string | null;
  payload?: unknown;
  occurred_at?: string | Date;
  question?: string | null;
  summary?: string | null;
  triggered_policies?: unknown;
}) {
  const payloadWithContext = await withTranscriptContext(
    row.payload,
    row.occurred_at,
  );
  const triggeredPolicies = Array.isArray(row.triggered_policies)
    ? row.triggered_policies
    : [];
  const primaryPolicy = triggeredPolicies.find(
    (policy) => policy && typeof policy === "object",
  ) as Record<string, unknown> | undefined;
  const purposeSummary = await approvalPurposeSummary({
    ...row,
    payload: payloadWithContext,
  });
  const attention = attentionEventForPending({
    ...row,
    payload: payloadWithContext,
  });
  return {
    ...row,
    ...notificationPluginAttribution(payloadWithContext),
    payload: payloadWithContext,
    project_name: projectTag(row.project_path ?? undefined) ?? null,
    primary_policy:
      typeof primaryPolicy?.policy_name === "string"
        ? primaryPolicy.policy_name
        : null,
    purpose_summary: purposeSummary,
    quote: approvalQuote(
      { ...row, payload: payloadWithContext },
      primaryPolicy,
    ),
    recent_context: approvalRecentContext(payloadWithContext),
    attention_kind: attention.kind,
    interaction: attention.interaction,
  };
}

async function approvalPurposeSummary(row: {
  payload?: unknown;
  project_path?: string | null;
  prompt?: string | null;
}) {
  if (!row.payload || typeof row.payload !== "object") return null;
  const event = row.payload as {
    openleashPurposeSummary?: unknown;
    eventName?: string;
    agentKind?: string;
    agentVersion?: string;
    sessionId?: string;
    projectPath?: string;
    prompt?: string;
    tool?: { name?: string; input?: unknown; output?: unknown };
    transcript?: ConversationTurn[];
    raw?: unknown;
    occurredAt?: string;
  };
  if (
    typeof event.openleashPurposeSummary === "string" &&
    event.openleashPurposeSummary.trim()
  ) {
    return event.openleashPurposeSummary.trim();
  }
  return summarizeActionPurpose({
    computer: { hostname: "unknown", platform: "unknown" },
    agent: { kind: "unknown", displayName: "Agent" },
    event: {
      eventName: (event.eventName as any) ?? "UserPromptSubmit",
      agentKind: "unknown",
      sessionId: event.sessionId ?? "unknown",
      projectPath: event.projectPath ?? row.project_path ?? undefined,
      prompt: event.prompt ?? row.prompt ?? undefined,
      tool:
        typeof event.tool?.name === "string"
          ? {
              name: event.tool.name,
              input: event.tool.input,
              output: event.tool.output,
            }
          : undefined,
      transcript: Array.isArray(event.transcript)
        ? event.transcript
        : undefined,
      raw: event.raw,
      occurredAt: event.occurredAt ?? new Date().toISOString(),
    },
  });
}

function approvalQuote(
  row: {
    prompt?: string | null;
    payload?: unknown;
    question?: string | null;
    summary?: string | null;
  },
  primaryPolicy?: Record<string, unknown>,
) {
  const prompt = typeof row.prompt === "string" ? row.prompt : undefined;
  if (prompt?.trim()) return truncate(cleanContextText(prompt), 220);

  const evidence = primaryPolicy?.evidence;
  const evidenceItems = Array.isArray(evidence)
    ? evidence
    : typeof evidence === "string"
      ? safeJsonArray(evidence)
      : [];
  const evidenceText = evidenceItems.find(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
  if (evidenceText) return truncate(cleanContextText(evidenceText), 220);

  const target = extractTarget(row.payload);
  if (target) return truncate(cleanContextText(target), 220);

  const question = typeof row.question === "string" ? row.question : undefined;
  if (question?.trim()) return truncate(cleanContextText(question), 220);
  return null;
}

function approvalRecentContext(payload: unknown) {
  if (!payload || typeof payload !== "object") return [];
  const transcript = (payload as { transcript?: unknown }).transcript;
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter(
      (turn): turn is { role?: unknown; content?: unknown; at?: unknown } =>
        Boolean(turn && typeof turn === "object"),
    )
    .map((turn) => {
      const role =
        typeof turn.role === "string" && isConversationRole(turn.role)
          ? turn.role
          : "user";
      const content =
        typeof turn.content === "string" ? cleanContextText(turn.content) : "";
      if (!content) return undefined;
      return {
        role,
        content: truncate(content, 220),
        ...(typeof turn.at === "string" ? { at: turn.at } : {}),
      };
    })
    .filter(
      (
        turn,
      ): turn is {
        role: ConversationTurn["role"];
        content: string;
        at?: string;
      } => Boolean(turn),
    )
    .slice(-5);
}

function safeJsonArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [value];
  }
}

function cleanContextText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

async function mobileAgents(organizationId: string, userId: string) {
  const result = await pool.query(
    `with latest_runs as (
       select distinct on (ar.id)
              ar.id as id,
              ar.id as agent_runtime_id,
              ar.kind,
              ar.display_name,
              ar.version,
              ar.installed,
              ar.protected,
              coalesce(ams.monitored, ar.protected) as desired_monitored,
              ar.detail,
              ar.last_seen_at,
              c.hostname,
              c.platform,
              ce.session_id,
              ce.event_name,
              ce.tool_name,
              ce.project_path,
              ce.prompt,
              ce.payload,
              ce.created_at as activity_at,
              ev.id as decision_id,
              ev.decision,
              ev.resolution,
              ev.resolved_at,
              ev.summary as decision_summary,
              ev.question
       from conversation_events ce
       join agent_runtimes ar on ar.id = ce.agent_runtime_id
       join computers c on c.id = ce.computer_id
       left join agent_monitoring_settings ams on ams.user_id = c.user_id
        and ams.organization_id = $1
        and ams.kind = ar.kind
       left join evaluations ev on ev.conversation_event_id = ce.id
       where ce.event_name <> 'Stop'
         and exists (
           select 1
           from users u
           where u.id = c.user_id and u.organization_id = $1
         )
         and c.user_id = $2
       order by ar.id, ce.created_at desc
     )
     select latest_runs.*,
            coalesce(triggered.items, '[]'::jsonb) as triggered_policies,
            coalesce(recent.items, '[]'::jsonb) as recent_activity
     from latest_runs
     left join lateral (
       select jsonb_agg(
         jsonb_build_object(
           'policy_name', pr.policy_name,
           'status', pr.status,
           'severity', pr.severity,
           'explanation', pr.explanation,
           'evidence', pr.evidence
         )
         order by pr.created_at asc
       ) as items
       from policy_results pr
       where pr.evaluation_id = latest_runs.decision_id
         and pr.status in ('failed', 'needs_question')
     ) triggered on true
     left join lateral (
       select jsonb_agg(
         jsonb_build_object(
           'id', item.id,
           'event_name', item.event_name,
           'tool_name', item.tool_name,
           'project_path', item.project_path,
           'prompt', item.prompt,
           'payload', item.payload,
           'created_at', item.created_at,
           'decision', item.decision,
           'resolution', item.resolution,
           'summary', item.summary,
           'question', item.question,
           'triggered_policies', item.triggered_policies
         )
         order by item.created_at desc
       ) as items
       from (
         select e.id,
                ce.event_name,
                ce.tool_name,
                ce.project_path,
                ce.prompt,
                ce.payload,
                ce.created_at,
                e.decision,
                e.resolution,
                e.summary,
                e.question,
                coalesce(policy_items.items, '[]'::jsonb) as triggered_policies
         from conversation_events ce
         join evaluations e on e.conversation_event_id = ce.id
         left join lateral (
           select jsonb_agg(
             jsonb_build_object(
               'policy_name', pr.policy_name,
               'status', pr.status,
               'severity', pr.severity,
               'explanation', pr.explanation,
               'evidence', pr.evidence
             )
             order by pr.created_at asc
           ) as items
           from policy_results pr
           where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
         ) policy_items on true
         where ce.agent_runtime_id = latest_runs.agent_runtime_id
           and ce.event_name <> 'Stop'
           and (
             e.decision in ('ask', 'deny')
             or e.resolution = 'deny'
             or exists (
               select 1 from policy_results pr
               where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
             )
           )
         order by ce.created_at desc
         limit 5
       ) item
     ) recent on true
     order by latest_runs.activity_at desc
     limit 50`,
    [organizationId, userId],
  );
  const sessions = await mobileAgentSessions(organizationId, userId);
  const seenRuntimeIds = new Set(
    result.rows.map((agent) => String(agent.agent_runtime_id || agent.id)),
  );
  const inventory = await pool.query(
    `select ar.id,
            ar.id as agent_runtime_id,
            ar.kind,
            ar.display_name,
            ar.version,
            ar.installed,
            ar.protected,
            coalesce(ams.monitored, ar.protected) as desired_monitored,
            ar.detail,
            ar.last_seen_at,
            c.hostname,
            c.platform,
            null::text as session_id,
            null::text as event_name,
            null::text as tool_name,
            null::text as project_path,
            null::text as prompt,
            null::jsonb as payload,
            null::timestamptz as activity_at,
            null::uuid as decision_id,
            null::text as decision,
            null::text as resolution,
            null::timestamptz as resolved_at,
            null::text as decision_summary,
            null::text as question,
            '[]'::jsonb as triggered_policies,
            '[]'::jsonb as recent_activity
     from agent_runtimes ar
     join computers c on c.id = ar.computer_id
     join users u on u.id = c.user_id
     left join agent_monitoring_settings ams on ams.user_id = c.user_id
      and ams.organization_id = $1
      and ams.kind = ar.kind
     where u.organization_id = $1
       and c.user_id = $2
       and ar.last_seen_at > now() - interval '90 days'
     order by ar.last_seen_at desc
     limit 50`,
    [organizationId, userId],
  );
  const rows = [
    ...result.rows,
    ...inventory.rows.filter(
      (agent) =>
        !seenRuntimeIds.has(String(agent.agent_runtime_id || agent.id)),
    ),
  ];
  return {
    ...result,
    rows: rows.map((agent) => ({
      ...agent,
      sessions: sessions
        .filter(
          (session) => session.agent_runtime_id === agent.agent_runtime_id,
        )
        .slice(0, 8),
      short_summary: summarizeAgentActivity(agent),
    })),
  };
}

function clientOverviewAgents(organizationId: string, userId: string) {
  return pool.query(
    `select distinct on (ar.kind)
            ar.id, ar.kind, ar.display_name, ar.version, ar.installed, ar.protected,
            coalesce(ams.monitored, ar.protected) as desired_monitored,
            ar.detail, ar.last_seen_at, c.hostname, c.platform
     from agent_runtimes ar
     join computers c on c.id = ar.computer_id
     left join agent_monitoring_settings ams on ams.user_id = c.user_id
      and ams.organization_id = $1
      and ams.kind = ar.kind
     where c.user_id = $2
       and exists (
         select 1 from users u
         where u.id = c.user_id and u.organization_id = $1
       )
     order by ar.kind, ar.last_seen_at desc`,
    [organizationId, userId],
  );
}

async function personalDashboardActivitySummary(
  organizationId: string,
  userId: string,
  rangeDays = 30,
): Promise<DashboardActivitySummary> {
  const [totals, threats, agentKinds] = await Promise.all([
    pool.query(
      `select count(*)::int as checked,
              count(*) filter (
                where e.resolution = 'deny'
                   or (e.decision = 'deny' and coalesce(e.resolved_by, '') <> 'organization-learning-mode')
              )::int as blocked,
              count(*) filter (
                where e.decision = 'allow'
                   or (e.resolution = 'allow' and e.resolved_by = 'organization-learning-mode')
              )::int as automatically_approved,
              count(*) filter (
                where e.decision = 'ask'
                  and e.resolution = 'allow'
                  and coalesce(e.resolved_by, '') <> 'organization-learning-mode'
              )::int as manually_approved,
              count(*) filter (where e.decision = 'ask' and e.resolution is null)::int as waiting
       from evaluations e
       join users u on u.id = e.user_id
       where u.organization_id = $1
         and e.user_id = $2
         and e.created_at >= now() - make_interval(days => $3)`,
      [organizationId, userId, rangeDays],
    ),
    pool.query(
      `select coalesce(nullif(p.category, ''), nullif(pr.policy_name, ''), 'Other threats') as name,
              count(distinct e.id)::int as total,
              count(distinct e.id) filter (
                where e.resolution = 'deny'
                   or (e.decision = 'deny' and coalesce(e.resolved_by, '') <> 'organization-learning-mode')
              )::int as blocked,
              count(distinct e.id) filter (
                where e.resolution = 'allow' and e.resolved_by = 'organization-learning-mode'
              )::int as automatically_approved,
              count(distinct e.id) filter (
                where e.decision = 'ask'
                  and e.resolution = 'allow'
                  and coalesce(e.resolved_by, '') <> 'organization-learning-mode'
              )::int as manually_approved
       from evaluations e
       join users u on u.id = e.user_id
       join policy_results pr on pr.evaluation_id = e.id
       left join policies p on p.id = pr.policy_id
       where u.organization_id = $1
         and e.user_id = $2
         and e.created_at >= now() - make_interval(days => $3)
         and pr.status in ('failed', 'needs_question')
       group by coalesce(nullif(p.category, ''), nullif(pr.policy_name, ''), 'Other threats')
       order by total desc, name asc
       limit 8`,
      [organizationId, userId, rangeDays],
    ),
    pool.query(
      `select ar.kind,
              max(ar.display_name) as name,
              count(distinct ar.id)::int as count
       from agent_runtimes ar
       join computers c on c.id = ar.computer_id
       join users u on u.id = c.user_id
       where u.organization_id = $1
         and c.user_id = $2
         and ar.last_seen_at >= now() - interval '90 days'
       group by ar.kind
       order by count desc, name asc`,
      [organizationId, userId],
    ),
  ]);
  const row = totals.rows[0] ?? {};
  return {
    rangeDays,
    totals: {
      checked: Number(row.checked ?? 0),
      blocked: Number(row.blocked ?? 0),
      automaticallyApproved: Number(row.automatically_approved ?? 0),
      manuallyApproved: Number(row.manually_approved ?? 0),
      waiting: Number(row.waiting ?? 0),
    },
    threats: threats.rows.map((item) => ({
      name: String(item.name),
      total: Number(item.total ?? 0),
      blocked: Number(item.blocked ?? 0),
      automaticallyApproved: Number(item.automatically_approved ?? 0),
      manuallyApproved: Number(item.manually_approved ?? 0),
    })),
    agentKinds: agentKinds.rows.map((item) => ({
      kind: String(item.kind),
      name: String(item.name || item.kind),
      count: Number(item.count ?? 0),
    })),
  };
}

async function mobileAgentSessions(organizationId: string, userId: string) {
  const result = await pool.query(
    `with session_groups as (
       select ce.agent_runtime_id,
              ce.session_id,
              coalesce(ce.project_path, '') as project_path_key,
              min(ce.created_at) as started_at,
              max(ce.created_at) as last_activity_at,
              greatest(0, extract(epoch from max(ce.created_at) - min(ce.created_at)))::int as duration_seconds,
              count(*)::int as event_count,
              count(e.id) filter (where e.decision = 'ask')::int as approval_count,
              count(e.id) filter (where e.decision = 'deny' or e.resolution = 'deny')::int as denied_count,
              array_remove(array_agg(distinct c.server_name), null) as mcp_servers
       from conversation_events ce
       join agent_runtimes ar on ar.id = ce.agent_runtime_id
       join computers comp on comp.id = ce.computer_id
       left join evaluations e on e.conversation_event_id = ce.id
       left join mcp_tool_calls c on c.evaluation_id = e.id
       where exists (
           select 1 from users u
           where u.id = comp.user_id and u.organization_id = $1
         )
         and comp.user_id = $2
       group by ce.agent_runtime_id, ce.session_id, coalesce(ce.project_path, '')
       order by max(ce.created_at) desc
       limit 120
     )
     select sg.agent_runtime_id,
            concat(sg.agent_runtime_id, ':', sg.session_id, ':', sg.project_path_key) as id,
            sg.session_id,
            nullif(sg.project_path_key, '') as project_path,
            sg.started_at,
            sg.last_activity_at,
            sg.duration_seconds,
            sg.event_count,
            sg.approval_count,
            sg.denied_count,
            coalesce(to_jsonb(sg.mcp_servers), '[]'::jsonb) as mcp_servers,
            coalesce(title_item.title, 'Agent session') as title,
            concat_ws(' · ',
              sg.event_count::text || case when sg.event_count = 1 then ' event' else ' events' end,
              case when sg.approval_count > 0 then sg.approval_count::text || case when sg.approval_count = 1 then ' approval' else ' approvals' end end,
              case when sg.denied_count > 0 then sg.denied_count::text || ' denied' end,
              case when cardinality(sg.mcp_servers) > 0 then 'MCP: ' || array_to_string(sg.mcp_servers[1:3], ', ') end
            ) as summary,
            coalesce(events.items, '[]'::jsonb) as events
     from session_groups sg
     left join lateral (
       select left(regexp_replace(coalesce(ce.prompt, e.summary, ce.tool_name, ce.event_name, 'Agent session'), '\\s+', ' ', 'g'), 64) as title
       from conversation_events ce
       left join evaluations e on e.conversation_event_id = ce.id
       where ce.agent_runtime_id = sg.agent_runtime_id
         and ce.session_id = sg.session_id
         and coalesce(ce.project_path, '') = sg.project_path_key
       order by case when ce.prompt is not null and length(ce.prompt) > 0 then 0 else 1 end, ce.created_at desc
       limit 1
     ) title_item on true
     left join lateral (
       select jsonb_agg(
         jsonb_build_object(
           'id', item.id,
           'event_name', item.event_name,
           'tool_name', item.tool_name,
           'project_path', item.project_path,
           'prompt', item.prompt,
           'payload', item.payload,
           'created_at', item.created_at,
           'decision', item.decision,
           'resolution', item.resolution,
           'summary', item.summary,
           'question', item.question,
           'mcp_server', item.mcp_server,
           'mcp_tool', item.mcp_tool,
           'triggered_policies', item.triggered_policies
         )
         order by item.created_at desc
       ) as items
       from (
         select e.id,
                ce.event_name,
                ce.tool_name,
                ce.project_path,
                ce.prompt,
                ce.payload,
                ce.created_at,
                e.decision,
                e.resolution,
                e.summary,
                e.question,
                m.server_name as mcp_server,
                m.tool_name as mcp_tool,
                coalesce(policy_items.items, '[]'::jsonb) as triggered_policies
         from conversation_events ce
         left join evaluations e on e.conversation_event_id = ce.id
         left join mcp_tool_calls m on m.evaluation_id = e.id
         left join lateral (
           select jsonb_agg(
             jsonb_build_object(
               'policy_name', pr.policy_name,
               'status', pr.status,
               'severity', pr.severity,
               'explanation', pr.explanation,
               'evidence', pr.evidence
             )
             order by pr.created_at asc
           ) as items
           from policy_results pr
           where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
         ) policy_items on true
         where ce.agent_runtime_id = sg.agent_runtime_id
           and ce.session_id = sg.session_id
           and coalesce(ce.project_path, '') = sg.project_path_key
         order by ce.created_at desc
         limit 20
       ) item
     ) events on true
     order by sg.last_activity_at desc`,
    [organizationId, userId],
  );
  return result.rows;
}

function mobileSessionMetrics(organizationId: string, userId: string) {
  return pool.query(
    `with sessions as (
       select ce.agent_runtime_id,
              ce.session_id,
              coalesce(ce.project_path, '') as project_path_key,
              min(ce.created_at) as started_at,
              max(ce.created_at) as last_activity_at,
              greatest(0, extract(epoch from max(ce.created_at) - min(ce.created_at)))::int as duration_seconds
       from conversation_events ce
       join computers comp on comp.id = ce.computer_id
       where exists (
           select 1 from users u
           where u.id = comp.user_id and u.organization_id = $1
         )
         and comp.user_id = $2
       group by ce.agent_runtime_id, ce.session_id, coalesce(ce.project_path, '')
     )
     select
       coalesce(sum(duration_seconds) filter (where last_activity_at >= date_trunc('day', now())), 0)::int as today_seconds,
       count(*) filter (where last_activity_at >= date_trunc('day', now()))::int as today_sessions,
       coalesce(sum(duration_seconds) filter (where last_activity_at >= now() - interval '24 hours'), 0)::int as last24h_seconds,
       count(*) filter (where last_activity_at >= now() - interval '24 hours')::int as last24h_sessions,
       coalesce(sum(duration_seconds) filter (where last_activity_at >= now() - interval '7 days'), 0)::int as week_seconds,
       count(*) filter (where last_activity_at >= now() - interval '7 days')::int as week_sessions,
       coalesce(sum(duration_seconds) filter (where last_activity_at >= now() - interval '30 days'), 0)::int as month_seconds,
       count(*) filter (where last_activity_at >= now() - interval '30 days')::int as month_sessions
     from sessions`,
    [organizationId, userId],
  );
}

function mobileRecentActivity(
  organizationId: string,
  userId: string,
  options: {
    limit?: number;
    page?: number;
    pageSize?: number;
    agentKind?: string;
  } = {},
) {
  const limit = Math.max(1, Math.min(121, options.limit ?? 120));
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.max(1, Math.min(120, options.pageSize ?? limit));
  const params: unknown[] = [organizationId, userId];
  const agentFilter = options.agentKind
    ? `and ar.kind = $${params.push(options.agentKind)}`
    : "";
  const limitIndex = params.push(limit);
  const offsetIndex = params.push((page - 1) * pageSize);
  return pool.query(
    `select e.id, e.decision, e.resolution, e.summary, e.question, e.created_at,
            ce.event_name, ce.tool_name, ce.project_path, ce.prompt, ce.payload,
            ar.display_name as agent_name, ar.kind as agent_kind,
            c.hostname,
            coalesce(triggered.items, '[]'::jsonb) as triggered_policies
     from evaluations e
     join conversation_events ce on ce.id = e.conversation_event_id
     join agent_runtimes ar on ar.id = ce.agent_runtime_id
     join computers c on c.id = ce.computer_id
     left join lateral (
       select jsonb_agg(
         jsonb_build_object(
           'policy_name', pr.policy_name,
           'status', pr.status,
           'severity', pr.severity,
           'explanation', pr.explanation,
           'evidence', pr.evidence
         )
         order by pr.created_at asc
       ) as items
       from policy_results pr
       where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
     ) triggered on true
     where exists (
       select 1
       from users u
       where u.id = e.user_id and u.organization_id = $1
     )
       and e.user_id = $2
       ${agentFilter}
     order by e.created_at desc, e.id desc
     limit $${limitIndex}
     offset $${offsetIndex}`,
    params,
  );
}

function browserBlockedNotifications(organizationId: string, userId: string) {
  return pool.query(
    `select e.id, e.decision, e.resolution, e.summary, e.question, e.created_at,
            ce.event_name, ce.tool_name, ce.project_path, ce.prompt, ce.payload,
            ar.display_name as agent_name, ar.kind as agent_kind,
            c.hostname,
            coalesce(triggered.items, '[]'::jsonb) as triggered_policies
     from evaluations e
     join conversation_events ce on ce.id = e.conversation_event_id
     join agent_runtimes ar on ar.id = ce.agent_runtime_id
     join computers c on c.id = ce.computer_id
     left join lateral (
       select jsonb_agg(
         jsonb_build_object(
           'policy_name', pr.policy_name,
           'status', pr.status,
           'severity', pr.severity,
           'explanation', pr.explanation,
           'evidence', pr.evidence
         )
         order by pr.created_at asc
       ) as items
       from policy_results pr
       where pr.evaluation_id = e.id and pr.status in ('failed', 'needs_question')
     ) triggered on true
     where e.user_id = $2
       and exists (
         select 1
         from users u
         where u.id = e.user_id and u.organization_id = $1
       )
       and e.decision = 'deny'
       and e.created_at > now() - interval '30 minutes'
       and ce.event_name <> 'Stop'
     order by e.created_at desc
     limit 10`,
    [organizationId, userId],
  );
}

async function notifyMobileApprovers(
  userId: string,
  decisionId: string,
  summary: string,
  question?: string,
  purposeSummary?: string,
  kind: "approval" | "question" | "plan_review" = "approval",
) {
  await notifyMobileEvent(userId, {
    title:
      kind === "question"
        ? "An agent has a question"
        : kind === "plan_review"
          ? "An agent plan is ready"
          : summary || "Leash approval needed",
    body:
      [purposeSummary, question].filter(Boolean).join("\n") ||
      (kind === "question"
        ? "Open OpenLeash to answer and continue the agent."
        : kind === "plan_review"
          ? "Open OpenLeash to approve the plan or request changes."
          : "An AI agent is waiting for your decision."),
    categoryId:
      kind === "approval" ? "openleash.approval" : `openleash.${kind}`,
    data: { decisionId, purposeSummary, kind },
  });
}

function eventCompletionSummary(request: EvaluationRequest) {
  const raw =
    request.event.raw &&
    typeof request.event.raw === "object" &&
    !Array.isArray(request.event.raw)
      ? (request.event.raw as Record<string, unknown>)
      : {};
  const direct = firstString(
    raw.last_assistant_message,
    raw.prompt_response,
    raw.message,
  );
  if (direct) return truncate(cleanContextText(direct), 180);
  const lastAssistant = [...(request.event.transcript ?? [])]
    .reverse()
    .find((turn) => turn.role === "assistant" && turn.content.trim());
  return lastAssistant
    ? truncate(cleanContextText(lastAssistant.content), 180)
    : undefined;
}

async function notifyMobileEvent(
  userId: string,
  notification: {
    title: string;
    body: string;
    categoryId?: string;
    data?: Record<string, unknown>;
  },
) {
  const runtimePolicy = await runtimePolicyForUser({ id: userId });
  if (!runtimePolicy.notifyEmployees) return;
  const devices = await mobilePushDevicesForUser(userId);
  const expoMessages = devices
    .filter((token): token is string =>
      Boolean(
        token &&
        /^ExponentPushToken\[[^\]]+\]$|^ExpoPushToken\[[^\]]+\]$/.test(token),
      ),
    )
    .map((token) => ({
      to: token,
      title: notification.title,
      body: notification.body,
      sound: "default",
      ...(notification.categoryId
        ? { categoryId: notification.categoryId }
        : {}),
      data: notification.data ?? {},
    }));
  if (!expoMessages.length) return;
  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(expoMessages),
  });
}

async function mobilePushDevicesForUser(userId: string) {
  const devices = await pool.query<{ push_token: string }>(
    `select distinct md.push_token
     from mobile_devices md
     where md.push_token is not null
       and md.user_id = $1
       and md.last_seen_at > now() - interval '45 days'
     limit 50`,
    [userId],
  );
  return devices.rows.map((row) => row.push_token);
}

function ssoProviderFromIdp(
  row: {
    id: string;
    provider: string;
    enabled: boolean;
    config: Record<string, unknown>;
  },
  organizationId: string,
) {
  const providerType = ssoProviderType(row.provider);
  return {
    id: row.id,
    organizationId,
    providerType,
    providerName: ssoProviderLabel(row.provider),
    enabled: row.enabled,
    isPrimary: true,
  };
}

function ssoProviderLabel(provider: string) {
  if (provider === "AzureAD") return "Microsoft Entra ID";
  if (provider === "Google") return "Google Workspace";
  if (provider === "OIDC") return "Generic OIDC";
  return provider;
}

async function buildAuthorizationUrl(
  providerType: string,
  config: Record<string, unknown>,
  redirectUri: string,
  state: string,
) {
  const clientId = String(config.ClientId ?? config.clientId ?? "");
  const scope = encodeURIComponent(
    providerType === "github" ? "read:user user:email" : "openid profile email",
  );
  if (providerType === "github") {
    if (!clientId) return "";
    return `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${encodeURIComponent(state)}`;
  }
  if (providerType === "okta") {
    const domain = String(config.Domain ?? config.domain ?? "").replace(
      /\/+$/,
      "",
    );
    if (!domain || !clientId) return "";
    return `${domain}/oauth2/v1/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}`;
  }
  if (providerType === "azure_ad") {
    const tenantId = String(config.TenantId ?? config.tenantId ?? "common");
    if (!clientId) return "";
    return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}`;
  }
  if (providerType === "google_workspace") {
    if (!clientId) return "";
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}&access_type=offline&prompt=select_account`;
  }
  if (providerType === "oidc") {
    const authorizationEndpoint = await oidcEndpoint(
      config,
      "authorization_endpoint",
    );
    if (!authorizationEndpoint || !clientId) return "";
    return `${authorizationEndpoint}?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}`;
  }
  return "";
}

async function exchangeAuthorizationCode(
  providerType: string,
  config: Record<string, unknown>,
  code: string,
  redirectUri: string,
) {
  const tokenEndpoint = await oauthTokenEndpoint(providerType, config);
  const clientId = String(config.ClientId ?? config.clientId ?? "");
  const clientSecret = String(config.ClientSecret ?? config.clientSecret ?? "");
  if (!tokenEndpoint || !clientId)
    throw new Error(`SSO token exchange is not configured for ${providerType}`);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  });

  if (clientSecret) {
    body.set("client_secret", clientSecret);
  } else {
    const assertion = clientAssertion(providerType, config, tokenEndpoint);
    if (assertion) {
      body.set(
        "client_assertion_type",
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      );
      body.set("client_assertion", assertion);
    }
  }

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      String(
        payload.error_description ??
          payload.error ??
          "SSO token exchange failed",
      ),
    );
  return payload as {
    access_token?: string;
    id_token?: string;
    token_type?: string;
  };
}

async function fetchSsoProfile(
  providerType: string,
  config: Record<string, unknown>,
  tokenSet: { access_token?: string; id_token?: string },
) {
  if (providerType === "github") return fetchGithubProfile(tokenSet);
  const userinfoEndpoint = await oauthUserinfoEndpoint(providerType, config);
  let raw: Record<string, unknown> = {};
  if (userinfoEndpoint && tokenSet.access_token) {
    const response = await fetch(userinfoEndpoint, {
      headers: {
        authorization: `Bearer ${tokenSet.access_token}`,
        accept: "application/json",
      },
    });
    if (response.ok) raw = (await response.json()) as Record<string, unknown>;
  }
  if (!Object.keys(raw).length && tokenSet.id_token)
    raw = decodeJwtPayload(tokenSet.id_token);
  return {
    subject: String(raw.sub ?? raw.oid ?? raw.id ?? ""),
    email: String(
      raw.email ?? raw.preferred_username ?? raw.upn ?? "",
    ).toLowerCase(),
    name: normalizedProfileName(raw),
    givenName: nullableString(raw.given_name),
    familyName: nullableString(raw.family_name),
    raw,
  };
}

async function fetchGithubProfile(tokenSet: { access_token?: string }) {
  if (!tokenSet.access_token)
    throw new Error("GitHub token exchange did not return an access token");
  const headers = {
    authorization: `Bearer ${tokenSet.access_token}`,
    accept: "application/vnd.github+json",
    "user-agent": "Leash",
  };
  const [userResponse, emailResponse] = await Promise.all([
    fetch("https://api.github.com/user", { headers }),
    fetch("https://api.github.com/user/emails", { headers }),
  ]);
  if (!userResponse.ok) throw new Error("Could not fetch GitHub profile");
  const raw = (await userResponse.json()) as Record<string, unknown>;
  const emails = emailResponse.ok
    ? ((await emailResponse.json().catch(() => [])) as Array<
        Record<string, unknown>
      >)
    : [];
  const primaryEmail =
    emails.find((item) => item.primary === true && item.verified !== false)
      ?.email ??
    emails.find((item) => item.verified !== false)?.email ??
    raw.email;
  const fullName = normalizedProfileName(raw) || String(raw.login ?? "");
  const split = splitProfileName(fullName);
  return {
    subject: String(raw.id ?? raw.node_id ?? raw.login ?? ""),
    email: String(primaryEmail ?? "").toLowerCase(),
    name: fullName,
    givenName: split.givenName,
    familyName: split.familyName,
    raw: { ...raw, emails },
  };
}

function normalizedProfileName(raw: Record<string, unknown>) {
  return String(
    raw.name ??
      [raw.given_name, raw.family_name].filter(Boolean).join(" ") ??
      "",
  ).trim();
}

function splitProfileName(name: string) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return { givenName: null, familyName: null };
  if (parts.length === 1) return { givenName: parts[0], familyName: null };
  return { givenName: parts[0], familyName: parts.slice(1).join(" ") };
}

async function oauthTokenEndpoint(
  providerType: string,
  config: Record<string, unknown>,
) {
  if (providerType === "okta") {
    const domain = String(config.Domain ?? config.domain ?? "").replace(
      /\/+$/,
      "",
    );
    return domain ? `${domain}/oauth2/v1/token` : "";
  }
  if (providerType === "azure_ad") {
    const tenantId = String(config.TenantId ?? config.tenantId ?? "common");
    return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  }
  if (providerType === "google_workspace")
    return "https://oauth2.googleapis.com/token";
  if (providerType === "github")
    return "https://github.com/login/oauth/access_token";
  if (providerType === "oidc") return oidcEndpoint(config, "token_endpoint");
  return "";
}

async function oauthUserinfoEndpoint(
  providerType: string,
  config: Record<string, unknown>,
) {
  if (providerType === "okta") {
    const domain = String(config.Domain ?? config.domain ?? "").replace(
      /\/+$/,
      "",
    );
    return domain ? `${domain}/oauth2/v1/userinfo` : "";
  }
  if (providerType === "azure_ad")
    return "https://graph.microsoft.com/oidc/userinfo";
  if (providerType === "google_workspace")
    return "https://openidconnect.googleapis.com/v1/userinfo";
  if (providerType === "oidc") return oidcEndpoint(config, "userinfo_endpoint");
  return "";
}

async function oidcEndpoint(
  config: Record<string, unknown>,
  key: "authorization_endpoint" | "token_endpoint" | "userinfo_endpoint",
) {
  const explicit = String(
    config[key] ??
      config[camelCaseOidcKey(key)] ??
      config[pascalCaseOidcKey(key)] ??
      "",
  ).trim();
  if (explicit) return explicit;
  const discovery = await oidcDiscovery(config);
  return typeof discovery[key] === "string" ? discovery[key] : "";
}

const oidcDiscoveryCache = new Map<
  string,
  { expiresAt: number; data: Record<string, unknown> }
>();

async function oidcDiscovery(config: Record<string, unknown>) {
  const issuer = String(
    config.IssuerUrl ?? config.issuerUrl ?? config.issuer ?? "",
  ).replace(/\/+$/, "");
  if (!issuer) return {};
  const cached = oidcDiscoveryCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(
      "OIDC discovery failed. Check the issuer URL and network access from the API.",
    );
  const data = (await response.json()) as Record<string, unknown>;
  oidcDiscoveryCache.set(issuer, { expiresAt: Date.now() + 10 * 60_000, data });
  return data;
}

function camelCaseOidcKey(value: string) {
  return value.replace(/_([a-z])/g, (_match, char: string) =>
    char.toUpperCase(),
  );
}

function pascalCaseOidcKey(value: string) {
  const camel = camelCaseOidcKey(value);
  return `${camel[0]?.toUpperCase() ?? ""}${camel.slice(1)}`;
}

function clientAssertion(
  providerType: string,
  config: Record<string, unknown>,
  audience: string,
) {
  if (providerType !== "okta" && providerType !== "azure_ad") return "";
  const privateKey = String(
    config.PrivateKey ?? config.privateKey ?? "",
  ).trim();
  const clientId = String(config.ClientId ?? config.clientId ?? "").trim();
  if (!privateKey || !clientId) return "";
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: String(config.KeyId ?? config.kid ?? "") || undefined,
  };
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: audience,
    jti: crypto.randomBytes(16).toString("hex"),
    iat: now,
    exp: now + 300,
  };
  const input = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(input), privateKey)
    .toString("base64url");
  return `${input}.${signature}`;
}

async function getDashboardSession(
  authHeader: string,
  purpose: "dashboard" | "desktop_enrollment" = "dashboard",
) {
  const token = bearerToken(authHeader);
  if (!token) return null;
  const result = await pool.query<{
    user_id: string;
    email: string;
    display_name: string;
    role: string;
    user_metadata: Record<string, unknown> | null;
    organization_id: string;
    organization_name: string;
    organization_slug: string;
    region: string | null;
    infrastructure_config: Record<string, unknown> | null;
    session_provider: string;
  }>(
    `update dashboard_sessions ds
     set last_seen_at = now()
     from users u
     join organizations o on o.id = u.organization_id
     where ds.user_id = u.id
       and ds.organization_id = u.organization_id
       and u.status = 'active'
       and ds.token_hash = $1
       and (($2 = 'dashboard' and ds.provider <> 'desktop_enrollment')
         or ($2 = 'desktop_enrollment' and ds.provider = 'desktop_enrollment'))
       and ds.revoked_at is null
       and ds.expires_at > now()
     returning u.id as user_id, u.email, u.display_name, u.role, u.metadata as user_metadata,
               o.id as organization_id, o.name as organization_name, o.slug as organization_slug, o.region,
               o.infrastructure_config, ds.provider as session_provider`,
    [hashToken(token), purpose],
  );
  const row = result.rows[0];
  if (!row) return null;
  const userMetadata = row.user_metadata ?? {};
  const organizationConfig = row.infrastructure_config ?? {};
  const accountAudience =
    userMetadata.accountAudience === "individual"
      ? "individual"
      : "organization";
  const packageId = normalizeAccountPackage(
    userMetadata.accountPackage ?? organizationConfig.accountPackage,
  );
  return {
    user: {
      id: row.user_id,
      email: row.email,
      display_name: row.display_name,
      role: row.role,
    },
    organization: {
      id: row.organization_id,
      name: row.organization_name,
      slug: row.organization_slug,
      region: row.region,
    },
    account: {
      audience: accountAudience,
      packageId,
    },
    sessionProvider: row.session_provider,
  };
}

async function getClientOrDashboardSession(authHeader: string) {
  const dashboardSession = await getDashboardSession(authHeader);
  if (dashboardSession)
    return { ...dashboardSession, source: "dashboard" as const };

  const token = bearerToken(authHeader);
  const user = token ? await getUserByToken(token) : undefined;
  if (!user?.organization_id) return null;

  const organization = await pool.query<{
    id: string;
    name: string;
    slug: string | null;
    region: string | null;
    user_metadata: Record<string, unknown> | null;
    infrastructure_config: Record<string, unknown> | null;
  }>(
    `select o.id, o.name, o.slug, o.region,
            u.metadata as user_metadata,
            o.infrastructure_config
     from organizations o
     join users u on u.organization_id = o.id
     where o.id = $1 and u.id = $2
     limit 1`,
    [user.organization_id, user.id],
  );
  const row = organization.rows[0];
  if (!row) return null;
  return {
    source: "client" as const,
    computerId: user.desktop_computer_id ?? null,
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: "client",
    },
    organization: {
      id: row.id,
      name: row.name,
      slug: row.slug,
      region: row.region,
    },
    account: {
      audience: row.user_metadata?.accountAudience === "organization"
        ? "organization" as const
        : "individual" as const,
      packageId: normalizeAccountPackage(
        row.user_metadata?.accountPackage ?? row.infrastructure_config?.accountPackage,
      ),
    },
  };
}

async function isSessionMonitoringPaused(
  user: { id: string; organization_id?: string | null },
  request: {
    agent?: { kind?: unknown };
    event?: { agentKind?: unknown; sessionId?: unknown };
  },
) {
  if (!user.organization_id) return false;
  const agentKind = String(
    request.agent?.kind ?? request.event?.agentKind ?? "",
  ).trim().toLowerCase();
  const sessionId = String(request.event?.sessionId ?? "").trim();
  if (!agentKind || !sessionId) return false;
  return tolerateMissingSessionMonitoringSchema(async () => {
    const result = await pool.query(
      `select 1
       from session_monitoring_pauses
       where organization_id = $1
         and user_id = $2
         and agent_kind = $3
         and session_id = $4
         and expires_at > now()
       limit 1`,
      [user.organization_id, user.id, agentKind, sessionId],
    );
    return result.rowCount === 1;
  }, false, warnMissingSessionMonitoringSchema);
}

async function activeSessionMonitoringPauses(
  organizationId: string,
  userId: string,
) {
  return tolerateMissingSessionMonitoringSchema(async () => {
    const result = await pool.query<{
      agent_kind: string;
      session_id: string;
      expires_at: Date;
    }>(
      `select agent_kind, session_id, expires_at
       from session_monitoring_pauses
       where organization_id = $1
         and user_id = $2
         and expires_at > now()
      order by expires_at asc`,
      [organizationId, userId],
    );
    return result.rows;
  }, [], warnMissingSessionMonitoringSchema);
}

function sessionMonitoringRouteError(error: unknown) {
  if (!isMissingSessionMonitoringSchema(error)) return error;
  warnMissingSessionMonitoringSchema();
  return new HttpError(
    503,
    "Conversation monitoring controls are unavailable until database migrations finish.",
  );
}

function warnMissingSessionMonitoringSchema() {
  if (missingSessionMonitoringSchemaWarningLogged) return;
  missingSessionMonitoringSchemaWarningLogged = true;
  console.warn(
    "session monitoring schema is not migrated; model traffic will continue without conversation pauses",
  );
}

function sessionMonitoringPausedDecision(): EvaluationResponse & {
  monitoringPaused: true;
} {
  return {
    decision: "allow",
    decisionId: "",
    summary: "Monitoring is temporarily paused for this conversation.",
    results: [],
    monitoringPaused: true,
  };
}

function bearerToken(authHeader: string) {
  return authHeader.replace(/^Bearer\s+/i, "").trim();
}

function privateBootstrapToken() {
  return String(process.env.OPENLEASH_PRIVATE_BOOTSTRAP_TOKEN ?? "").trim();
}

function secureTokenEquals(provided: string, expected: string) {
  if (!provided || !expected) return false;
  const providedHash = Buffer.from(hashToken(provided));
  const expectedHash = Buffer.from(hashToken(expected));
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

function secureHashEquals(providedHash: string, expectedHash: string) {
  if (!providedHash || !expectedHash) return false;
  const provided = Buffer.from(providedHash);
  const expected = Buffer.from(expectedHash);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function validPkceValue(value: string) {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

function requirePluginReleaseAdmin(req: express.Request, res: express.Response) {
  const expected = String(process.env.OPENLEASH_RELEASE_ADMIN_TOKEN ?? "").trim();
  if (!expected) {
    res.status(503).json({ error: "Plugin release administration is not configured." });
    return false;
  }
  if (!secureTokenEquals(bearerToken(req.header("authorization") ?? ""), expected)) {
    res.status(403).json({ error: "Plugin release administrator authorization is required." });
    return false;
  }
  return true;
}

function isDashboardAccessRole(role: unknown) {
  return ["owner", "admin", "ciso", "cio", "security_admin"].includes(
    String(role ?? "").toLowerCase(),
  );
}

function isAllowedCorsOrigin(origin: string | undefined) {
  if (!origin) return true;
  const allowed = configuredCorsOrigins();
  if (allowed.has("*")) return true;
  try {
    const url = new URL(origin);
    if (isLocalHostname(url.hostname)) return true;
  } catch {
    return false;
  }
  return allowed.has(origin);
}

function configuredCorsOrigins() {
  return new Set(
    (
      process.env.OPENLEASH_ALLOWED_ORIGINS ??
      process.env.OPENLEASH_DASHBOARD_ORIGINS ??
      ""
    )
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function requiresDashboardWriteSession(req: express.Request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return false;
  if (req.path === "/admin/bootstrap") return false;
  if (req.path.startsWith("/admin/plugin-releases")) return false;
  if (req.path.startsWith("/admin/")) return true;
  if (req.path === "/admin/external-agents/sync") return true;
  if (req.path.startsWith("/admin/provider-usage")) return true;
  if (req.path.startsWith("/admin/onboarding")) return true;
  if (req.path.startsWith("/admin/decisions/")) return true;
  if (req.path === "/admin/users") return true;
  if (req.path.startsWith("/admin/deployment-tokens")) return true;
  if (req.path.startsWith("/admin/policies")) return true;
  if (req.path.startsWith("/admin/plugin-releases")) return true;
  if (req.path === "/admin/prompt-transforms") return true;
  return false;
}

function allowsLocalDashboardWriteBypass(_req: express.Request) {
  return process.env.OPENLEASH_INSECURE_ADMIN_WRITE === "1";
}

function isLocalAddress(value: string) {
  const address = value.replace(/^::ffff:/, "");
  return (
    address === "127.0.0.1" || address === "::1" || address === "localhost"
  );
}

function isLocalHostname(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function normalizeSkillReasons(
  value: unknown,
): Array<{ reason: string; quote?: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const reason =
        typeof record.reason === "string" ? truncate(record.reason, 240) : "";
      const quote =
        typeof record.quote === "string"
          ? truncate(record.quote, 320)
          : undefined;
      return reason ? [{ reason, ...(quote ? { quote } : {}) }] : [];
    })
    .slice(0, 12);
}

type SkillObservationEventType = "detected" | "changed" | "seen" | "removed";

function normalizeSkillObservationEventType(
  value: unknown,
): SkillObservationEventType | undefined {
  return value === "detected" ||
    value === "changed" ||
    value === "seen" ||
    value === "removed"
    ? value
    : undefined;
}

function inferSkillObservationEventType(
  requested: SkillObservationEventType | undefined,
  existing: { status?: string; content_hash?: string } | undefined,
  contentHash: string,
): SkillObservationEventType {
  if (requested === "removed") return "removed";
  if (!existing || existing.status === "deleted") return "detected";
  if (existing.content_hash && existing.content_hash !== contentHash)
    return "changed";
  return "seen";
}

function pipelineEventForSkillObservation(
  eventType: SkillObservationEventType,
): Extract<
  PipelineEvent,
  "skill.detected" | "skill.changed" | "skill.removed"
> {
  if (eventType === "detected") return "skill.detected";
  if (eventType === "removed") return "skill.removed";
  return "skill.changed";
}

function normalizeSkillStatus(
  provided: unknown,
  existing?: string,
): "observed" | "approved" | "suspicious" {
  if (
    provided === "suspicious" ||
    provided === "approved" ||
    provided === "observed"
  )
    return provided;
  if (
    existing === "suspicious" ||
    existing === "approved" ||
    existing === "observed"
  )
    return existing;
  return "observed";
}

function normalizeExistingSkillReasons(
  existing: unknown,
  fallback: Array<{ reason: string; quote?: string }>,
) {
  const normalized = normalizeSkillReasons(existing);
  return normalized.length ? normalized : fallback;
}

async function skillPurposeSummary({
  provided,
  content,
  skillName,
}: {
  provided?: string;
  content: string;
  skillName: string;
  skillPath: string;
}) {
  const normalized = normalizeSkillPurpose(provided ?? "", skillName);
  if (normalized) return normalized;
  return heuristicSkillPurpose(content, skillName);
}

function heuristicSkillPurpose(content: string, skillName: string) {
  const heading =
    content.match(/^#\s+(.+)$/m)?.[1] ??
    content.match(/^description:\s*["']?(.+?)["']?\s*$/im)?.[1];
  return (
    normalizeSkillPurpose(
      heading ?? skillName.replace(/[-_]+/g, " "),
      skillName,
    ) ?? titleCaseWords(skillName.replace(/[-_]+/g, " "))
  );
}

function normalizeSkillPurpose(value: string, fallback: string) {
  const cleaned = value
    .replace(/["'`]/g, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length >= 4) return titleCaseWords(words.join(" "));
  const fallbackWords = fallback
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  return fallbackWords.length
    ? titleCaseWords(fallbackWords.join(" "))
    : undefined;
}

function titleCaseWords(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word.length <= 3 ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function decodeJwtPayload(jwt: string) {
  try {
    const [, payload] = jwt.split(".");
    if (!payload) return {};
    return JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function base64urlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function nullableString(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeIdpProvider(provider: unknown) {
  const value = String(provider ?? "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const providers = [
    {
      keys: ["azure", "azuread", "entra", "entraid", "microsoftentra"],
      idpType: "AzureAD",
      label: "Microsoft Entra ID",
    },
    { keys: ["okta"], idpType: "Okta", label: "Okta" },
    { keys: ["ping", "pingone"], idpType: "Ping", label: "Ping Identity" },
    {
      keys: ["google", "googleworkspace", "workspace"],
      idpType: "Google",
      label: "Google Workspace",
    },
    {
      keys: ["activedirectory", "ad", "ldap"],
      idpType: "ActiveDirectory",
      label: "Active Directory / LDAP",
    },
  ];
  return providers.find((item) => item.keys.includes(value));
}

function providerCredentials(
  provider: ReturnType<typeof normalizeIdpProvider>,
  body: Record<string, unknown>,
) {
  if (!provider) return {};
  const value = (key: string) => String(body[key] ?? "").trim();
  switch (provider.idpType) {
    case "AzureAD":
      return {
        TenantId: value("tenantId") || value("TenantId"),
        ClientId: value("clientId") || value("ClientId"),
        ClientSecret: value("clientSecret") || value("ClientSecret"),
      };
    case "OIDC":
      return {
        IssuerUrl: value("issuerUrl") || value("issuer") || value("IssuerUrl"),
        ClientId: value("clientId") || value("ClientId"),
        ClientSecret: value("clientSecret") || value("ClientSecret"),
        AuthorizationEndpoint:
          value("authorizationEndpoint") || value("AuthorizationEndpoint"),
        TokenEndpoint: value("tokenEndpoint") || value("TokenEndpoint"),
        UserinfoEndpoint:
          value("userinfoEndpoint") || value("UserinfoEndpoint"),
      };
    case "Okta":
      return {
        Domain: value("domain") || value("Domain"),
        ClientId:
          value("clientId") || value("oktaClientId") || value("ClientId"),
        PrivateKey:
          value("privateKey") ||
          value("oktaPrivateKey") ||
          value("PrivateKey") ||
          value("apiToken") ||
          value("ApiToken"),
      };
    case "Ping":
      return {
        ApiUrl: value("apiUrl") || value("ApiUrl"),
        AccessToken: value("accessToken") || value("AccessToken"),
        EnvironmentId: value("environmentId") || value("EnvironmentId"),
      };
    case "Google":
      return {
        ServiceAccountJson:
          value("serviceAccountJson") || value("ServiceAccountJson"),
        AdminEmail: value("adminEmail") || value("AdminEmail"),
      };
    case "ActiveDirectory":
      return {
        LdapHost: value("ldapHost") || value("LdapHost"),
        LdapPort: value("ldapPort") || value("LdapPort"),
        BindDn: value("bindDn") || value("BindDn"),
        BindPassword: value("bindPassword") || value("BindPassword"),
        BaseDn: value("baseDn") || value("BaseDn"),
        UseSsl: value("useSsl") || value("UseSsl"),
      };
    default:
      return {};
  }
}

function hasAnyCredential(credentials: Record<string, unknown>) {
  return Object.values(credentials).some(
    (value) => String(value ?? "").trim().length > 0,
  );
}

function enrollmentCommand(tenantUrl: string, token: string) {
  return `openleash enroll --tenant ${tenantUrl} --token ${token}`;
}

function tokenFromRequest(req: express.Request) {
  const auth = req.header("authorization") ?? "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}

function firstQuery(value: unknown) {
  if (Array.isArray(value))
    return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function normalizeHookRequest(
  agent: HookAgentSlug,
  eventName: HookEventName,
  raw: any,
  query: express.Request["query"],
): EvaluationRequest {
  const metadata = LOCAL_HOOK_AGENT_METADATA[agent];
  const agentKind = metadata.kind as AgentKind;
  const sessionId =
    firstString(
      raw?.session_id,
      raw?.sessionId,
      raw?.conversation_id,
      raw?.conversationId,
      raw?.thread_id,
      raw?.threadId,
      raw?.chat_id,
      raw?.chatId,
      raw?.run_id,
      raw?.runId,
    ) ?? stableHookSessionId(agent, raw);
  const toolName = firstString(
    raw?.tool_name,
    raw?.toolName,
    raw?.tool?.name,
    raw?.function?.name,
    raw?.command?.name,
  );
  const toolInput = firstDefined(
    raw?.tool_input,
    raw?.toolInput,
    raw?.tool?.input,
    raw?.input,
    raw?.arguments,
    raw?.args,
    raw?.params,
    raw?.command?.args,
  );
  const prompt = normalizeHookPrompt(raw);
  return {
    computer: {
      hostname: firstQuery(query.hostname) ?? os.hostname(),
      platform: firstQuery(query.platform) ?? "unknown",
      osRelease: firstQuery(query.os_release),
    },
    agent: {
      kind: agentKind,
      displayName: metadata.displayName,
      version: firstQuery(query.agent_version) ?? raw?.version,
      executablePath: raw?.executable_path,
    },
    event: {
      eventName,
      agentKind,
      agentVersion: firstQuery(query.agent_version) ?? raw?.version,
      sessionId,
      projectPath: firstString(
        raw?.cwd,
        raw?.workspace,
        raw?.workspaceDir,
        raw?.workspace_dir,
        raw?.project_dir,
        raw?.projectPath,
        raw?.project_path,
        raw?.root,
        raw?.repo,
        raw?.repository,
        raw?.context?.workspaceDir,
      ),
      prompt,
      tool: toolName
        ? {
            name: toolName,
            input: toolInput,
            output: raw?.tool_response ?? raw?.output,
          }
        : undefined,
      transcript: normalizeHookTranscript(raw?.transcript),
      raw,
      occurredAt: new Date().toISOString(),
    },
  };
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
    raw?.context?.sessionEntry?.content,
  );
  if (direct) return direct;
  if (Array.isArray(raw?.messages)) {
    const message = raw.messages
      .slice()
      .reverse()
      .find(
        (item: any) => typeof item?.content === "string" && item.content.trim(),
      );
    if (message) return message.content;
  }
  return undefined;
}

function firstString(...values: unknown[]) {
  return values.find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
}

function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null);
}

function normalizeHookTranscript(
  value: unknown,
): ConversationTurn[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const turns = value
    .map((turn) => {
      if (!turn || typeof turn !== "object") return undefined;
      const record = turn as {
        role?: unknown;
        content?: unknown;
        at?: unknown;
      };
      const role =
        typeof record.role === "string" && isConversationRole(record.role)
          ? record.role
          : undefined;
      const content =
        typeof record.content === "string" ? record.content.trim() : "";
      if (!role || !content) return undefined;
      return {
        role,
        content,
        ...(typeof record.at === "string" ? { at: record.at } : {}),
      };
    })
    .filter((turn): turn is ConversationTurn => Boolean(turn));
  return turns.length > 0 ? turns.slice(-20) : undefined;
}

function isConversationRole(value: string): value is ConversationTurn["role"] {
  return (
    value === "user" ||
    value === "assistant" ||
    value === "tool" ||
    value === "system"
  );
}

function isHookEventName(value: string): value is HookEventName {
  return [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Notification",
    "SessionEnd",
    "Stop",
  ].includes(value);
}

function promptTransformHookDecision(
  agent: HookAgentSlug,
  eventName: HookEventName,
  prompt: string,
  summary: string,
) {
  const base = nativeHookDecision(agent, eventName, {
    decision: "allow",
    decisionId: "",
    summary,
    results: [],
  });
  return {
    ...base,
    prompt,
    transformedPrompt: prompt,
    replacementPrompt: prompt,
    output: prompt,
    hookSpecificOutput: {
      ...((base as { hookSpecificOutput?: object }).hookSpecificOutput ?? {}),
      hookEventName: eventName,
      prompt,
      transformedPrompt: prompt,
      replacementPrompt: prompt,
    },
  };
}

function cleanResolutionGuidance(value?: string) {
  const cleaned = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 500) : undefined;
}

function cleanInteractionResponse(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const serialized = JSON.stringify(value);
  if (serialized.length > 32_000) {
    const error = new Error("interaction response exceeds 32 KB") as Error & {
      status?: number;
    };
    error.status = 400;
    throw error;
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.+|\.+$/g, "")
      .slice(0, 64) || "user"
  );
}

function apiSurfaceFromEnv(): ApiSurface {
  // The public Leash service is permanently client-facing. Keep the exported
  // union and option shape for source compatibility with older embedders, but
  // never allow an environment variable to revive the retired dashboard API.
  return "client";
}

function surfaceForRequest(
  method: string,
  requestPath: string,
): ApiSurface | undefined {
  const verb = method.toUpperCase();
  if (requestPath === "/health") return "all";
  if (
    requestPath === "/auth/session" ||
    requestPath === "/auth/account/outcomes" ||
    requestPath === "/auth/logout"
  ) {
    return "all";
  }

  if (
    requestPath === "/admin/overview" ||
    requestPath === "/admin/security" ||
    requestPath === "/admin/outcomes" ||
    requestPath === "/admin/mcp-servers" ||
    /^\/admin\/mcp-servers\/[^/]+$/.test(requestPath) ||
    requestPath === "/admin/skills" ||
    requestPath === "/admin/plugins" ||
    requestPath.startsWith("/admin/plugins/") ||
    requestPath === "/admin/plugin-marketplace" ||
    requestPath === "/admin/plugin-marketplace/policy" ||
    requestPath === "/admin/plugin-releases" ||
    requestPath.startsWith("/admin/plugin-releases/") ||
    requestPath === "/admin/debug" ||
    requestPath === "/admin/logs" ||
    /^\/admin\/logs\/[^/]+$/.test(requestPath) ||
    requestPath === "/admin/triggers" ||
    /^\/admin\/triggers\/[^/]+$/.test(requestPath) ||
    /^\/admin\/events\/[^/]+$/.test(requestPath) ||
    requestPath === "/admin/external-agents" ||
    requestPath === "/admin/external-agents/sync" ||
    requestPath === "/admin/provider-usage" ||
    requestPath.startsWith("/admin/provider-usage/") ||
    requestPath === "/admin/evaluation-key" ||
    requestPath === "/admin/bootstrap/status" ||
    requestPath === "/admin/bootstrap" ||
    requestPath === "/admin/onboarding" ||
    requestPath.startsWith("/admin/onboarding/") ||
    requestPath === "/admin/identity" ||
    requestPath === "/admin/users" ||
    requestPath === "/admin/deployment-tokens" ||
    requestPath.startsWith("/admin/deployment-tokens") ||
    requestPath === "/admin/policies" ||
    /^\/admin\/policies\/[^/]+$/.test(requestPath) ||
    requestPath === "/admin/prompt-transforms" ||
    requestPath === "/auth/sso/authorize" ||
    requestPath === "/auth/sso/callback" ||
    requestPath === "/auth/google/start" ||
    requestPath === "/auth/google/callback" ||
    requestPath === "/auth/microsoft/start" ||
    requestPath === "/auth/microsoft/callback" ||
    /^\/organizations\/[^/]+\/sso-providers$/.test(requestPath) ||
    /^\/organizations\/[^/]+$/.test(requestPath) ||
    (verb === "POST" && requestPath === "/organizations")
  ) {
    return "dashboard";
  }

  if (
    requestPath === "/v1/enroll" ||
    requestPath === "/v1/auth/google/callback" ||
    requestPath === "/v1/auth/microsoft/callback" ||
    requestPath === "/v1/auth/github/callback" ||
    requestPath === "/public/plugins" ||
    /^\/public\/plugins\/[^/]+$/.test(requestPath) ||
    requestPath === "/v1/evaluate" ||
    /^\/v1\/hooks\/[^/]+\/[^/]+$/.test(requestPath) ||
    requestPath === "/v1/desktop/enroll" ||
    requestPath === "/v1/desktop/agents" ||
    /^\/v1\/agents\/[^/]+\/monitoring$/.test(requestPath) ||
    requestPath === "/v1/plugins" ||
    requestPath === "/v1/plugin-marketplace" ||
    requestPath === "/v1/outcomes" ||
    requestPath === "/v1/plugin-submissions" ||
    requestPath === "/v1/plugin-releases" ||
    requestPath === "/v1/client/notifications" ||
    requestPath === "/v1/client/events" ||
    /^\/v1\/client\/decisions\/[^/]+\/resolve$/.test(requestPath) ||
    /^\/v1\/plugins\/[^/]+\/settings$/.test(requestPath) ||
    /^\/v1\/plugins\/[^/]+\/install$/.test(requestPath) ||
    /^\/v1\/plugins\/[^/]+\/update$/.test(requestPath) ||
    /^\/v1\/plugins\/[^/]+\/uninstall$/.test(requestPath) ||
    requestPath === "/v1/skills/observations" ||
    /^\/v1\/decisions\/[^/]+$/.test(requestPath) ||
    /^\/admin\/decisions\/[^/]+\/resolve$/.test(requestPath) ||
    requestPath === "/admin/tray-status" ||
    requestPath.startsWith("/v1/mobile/") ||
    requestPath === "/api/updates/check" ||
    requestPath === "/api/updates/latest" ||
    requestPath === "/api/admin/releases"
  ) {
    return "client";
  }

  return undefined;
}

function capabilityForRequest(
  method: string,
  requestPath: string,
): OpenLeashCapability | undefined {
  const surface = surfaceForRequest(method, requestPath);
  if (surface === "dashboard") return "dashboard";
  if (requestPath === "/v1/enroll") return "deploymentTokens";
  if (
    requestPath === "/public/plugins" ||
    /^\/public\/plugins\/[^/]+$/.test(requestPath)
  )
    return "publicPluginCatalog";
  if (
    requestPath === "/api/updates/check" ||
    requestPath === "/api/updates/latest" ||
    requestPath === "/api/admin/releases"
  )
    return "desktopUpdates";
  return undefined;
}

function apiFunctionForRequest(
  method: string,
  requestPath: string,
): OpenLeashApiFunction | undefined {
  const verb = method.toUpperCase();
  if (requestPath === "/health") return "health";
  if (verb === "POST" && requestPath === "/v1/enroll") return "tenantEnroll";
  if (verb === "POST" && requestPath === "/v1/desktop/enroll")
    return "desktopEnroll";
  if (verb === "POST" && requestPath === "/v1/desktop/agents")
    return "desktopEnroll";
  if (verb === "POST" && /^\/v1\/agents\/[^/]+\/monitoring$/.test(requestPath))
    return "mobileState";
  if (
    ["POST", "DELETE"].includes(verb) &&
    requestPath === "/v1/session-monitoring"
  )
    return "sessionMonitoring";
  if (verb === "GET" && requestPath === "/v1/plugins")
    return "tenantPluginsRead";
  if (verb === "GET" && requestPath === "/v1/plugin-marketplace")
    return "tenantPluginsRead";
  if (verb === "GET" && requestPath === "/v1/outcomes")
    return "authAccountOutcomes";
  if (verb === "GET" && requestPath === "/public/plugins")
    return "tenantPluginsRead";
  if (verb === "GET" && /^\/public\/plugins\/[^/]+$/.test(requestPath))
    return "tenantPluginsRead";
  if (verb === "POST" && /^\/v1\/plugins\/[^/]+\/settings$/.test(requestPath))
    return "adminPluginsWrite";
  if (verb === "POST" && /^\/v1\/plugins\/[^/]+\/install$/.test(requestPath))
    return "adminPluginsWrite";
  if (verb === "POST" && /^\/v1\/plugins\/[^/]+\/update$/.test(requestPath))
    return "adminPluginsWrite";
  if (verb === "POST" && /^\/v1\/plugins\/[^/]+\/uninstall$/.test(requestPath))
    return "adminPluginsWrite";
  if (verb === "POST" && requestPath === "/v1/plugin-submissions")
    return "adminPluginsWrite";
  if (verb === "POST" && requestPath === "/v1/plugin-releases")
    return "adminPluginsWrite";
  if (verb === "POST" && requestPath === "/v1/evaluate")
    return "tenantEvaluate";
  if (verb === "POST" && /^\/v1\/hooks\/[^/]+\/[^/]+$/.test(requestPath))
    return "tenantHookEvaluate";
  if (verb === "POST" && requestPath === "/v1/skills/observations")
    return "tenantSkillObservation";
  if (verb === "GET" && /^\/v1\/decisions\/[^/]+$/.test(requestPath))
    return "tenantDecisionPoll";
  if (
    verb === "POST" &&
    /^\/admin\/decisions\/[^/]+\/resolve$/.test(requestPath)
  )
    return "tenantDecisionResolve";
  if (verb === "GET" && requestPath === "/admin/tray-status")
    return "tenantTrayStatus";
  if (verb === "GET" && requestPath === "/admin/overview")
    return "adminOverview";
  if (verb === "GET" && requestPath === "/admin/security")
    return "adminSecurity";
  if (verb === "GET" && requestPath === "/admin/outcomes")
    return "adminOutcomes";
  if (verb === "GET" && requestPath === "/admin/mcp-servers")
    return "adminMcpServers";
  if (verb === "GET" && /^\/admin\/mcp-servers\/[^/]+$/.test(requestPath))
    return "adminMcpServerDetail";
  if (verb === "GET" && requestPath === "/admin/skills") return "adminSkills";
  if (verb === "GET" && requestPath === "/admin/plugins")
    return "adminPluginsRead";
  if (verb === "GET" && requestPath === "/admin/plugin-marketplace")
    return "adminPluginsRead";
  if (verb === "GET" && requestPath === "/admin/plugin-releases")
    return "adminPluginsRead";
  if (verb === "POST" && requestPath.startsWith("/admin/plugin-releases/"))
    return "adminPluginsWrite";
  if (
    verb === "POST" &&
    /^\/admin\/plugins\/[^/]+\/settings$/.test(requestPath)
  )
    return "adminPluginsWrite";
  if (verb === "POST" && /^\/admin\/plugins\/[^/]+\/update$/.test(requestPath))
    return "adminPluginsWrite";
  if (verb === "POST" && /^\/admin\/plugins\/[^/]+\/policy$/.test(requestPath))
    return "adminPluginsWrite";
  if (verb === "POST" && requestPath === "/admin/plugin-marketplace/policy")
    return "adminPluginsWrite";
  if (verb === "GET" && requestPath === "/admin/logs") return "adminLogs";
  if (verb === "GET" && requestPath === "/admin/debug") return "adminLogs";
  if (verb === "GET" && /^\/admin\/logs\/[^/]+$/.test(requestPath))
    return "adminLogDetail";
  if (verb === "GET" && requestPath === "/admin/triggers")
    return "adminTriggers";
  if (verb === "GET" && /^\/admin\/triggers\/[^/]+$/.test(requestPath))
    return "adminTriggerDetail";
  if (verb === "GET" && /^\/admin\/events\/[^/]+$/.test(requestPath))
    return "adminEventDetail";
  if (verb === "GET" && requestPath === "/admin/external-agents")
    return "adminExternalAgents";
  if (verb === "POST" && requestPath === "/admin/external-agents/sync")
    return "adminExternalAgentsSync";
  if (
    verb === "GET" &&
    (requestPath === "/admin/provider-usage" ||
      requestPath === "/admin/provider-usage/connections")
  )
    return "adminProviderUsageRead";
  if (verb === "POST" && requestPath === "/admin/provider-usage/sync")
    return "adminProviderUsageSync";
  if (verb === "POST" && requestPath.startsWith("/admin/provider-usage/"))
    return "adminProviderUsageWrite";
  if (verb === "POST" && requestPath === "/admin/evaluation-key")
    return "adminProviderUsageWrite";
  if (verb === "GET" && requestPath === "/admin/bootstrap/status")
    return "adminOnboardingRead";
  if (verb === "POST" && requestPath === "/admin/bootstrap")
    return "adminOnboardingWrite";
  if (verb === "GET" && requestPath === "/admin/onboarding")
    return "adminOnboardingRead";
  if (verb === "GET" && requestPath === "/admin/identity")
    return "adminIdentityRead";
  if (requestPath.startsWith("/admin/onboarding/"))
    return "adminOnboardingWrite";
  if (verb === "POST" && requestPath === "/admin/users")
    return "adminUsersWrite";
  if (verb === "GET" && requestPath === "/admin/deployment-tokens")
    return "adminDeploymentTokensRead";
  if (requestPath.startsWith("/admin/deployment-tokens"))
    return "adminDeploymentTokensWrite";
  if (verb === "POST" && requestPath === "/admin/policies")
    return "adminPoliciesWrite";
  if (verb === "PUT" && /^\/admin\/policies\/[^/]+$/.test(requestPath))
    return "adminPoliciesWrite";
  if (verb === "GET" && requestPath === "/admin/prompt-transforms")
    return "adminPromptTransformsRead";
  if (verb === "POST" && requestPath === "/admin/prompt-transforms")
    return "adminPromptTransformsWrite";
  if (verb === "GET" && requestPath === "/auth/session") return "authSession";
  if (verb === "GET" && requestPath === "/auth/account/outcomes")
    return "authAccountOutcomes";
  if (verb === "POST" && requestPath === "/auth/logout") return "authLogout";
  if (verb === "POST" && requestPath === "/auth/sso/authorize")
    return "authSsoAuthorize";
  if (verb === "POST" && requestPath === "/auth/sso/callback")
    return "authSsoCallback";
  if (verb === "GET" && requestPath === "/v1/auth/google/callback")
    return "authGoogleCallback";
  if (verb === "GET" && requestPath === "/v1/auth/microsoft/callback")
    return "authGoogleCallback";
  if (verb === "GET" && requestPath === "/v1/auth/github/callback")
    return "authGoogleCallback";
  if (verb === "GET" && requestPath === "/auth/microsoft/start")
    return "authGoogleCallback";
  if (verb === "GET" && requestPath === "/auth/microsoft/callback")
    return "authGoogleCallback";
  if (verb === "GET" && requestPath === "/v1/mobile/bootstrap")
    return "mobileBootstrap";
  if (verb === "POST" && requestPath === "/v1/mobile/auth/start")
    return "mobileAuthStart";
  if (verb === "POST" && requestPath === "/v1/mobile/auth/exchange")
    return "mobileAuthExchange";
  if (verb === "POST" && requestPath === "/v1/mobile/model-key")
    return "mobileModelKey";
  if (verb === "POST" && requestPath === "/v1/mobile/devices")
    return "mobileDeviceRegister";
  if (verb === "GET" && requestPath === "/v1/mobile/state")
    return "mobileState";
  if (verb === "GET" && requestPath === "/v1/client/overview")
    return "clientOverview";
  if (verb === "GET" && requestPath === "/v1/client/history")
    return "mobileState";
  if (
    verb === "POST" &&
    /^\/v1\/mobile\/decisions\/[^/]+\/resolve$/.test(requestPath)
  )
    return "mobileDecisionResolve";
  if (verb === "GET" && requestPath === "/v1/client/notifications")
    return "clientNotifications";
  if (verb === "GET" && requestPath === "/v1/client/events")
    return "clientEvents";
  if (
    verb === "POST" &&
    /^\/v1\/client\/decisions\/[^/]+\/resolve$/.test(requestPath)
  )
    return "clientDecisionResolve";
  if (
    verb === "GET" &&
    /^\/organizations\/[^/]+\/sso-providers$/.test(requestPath)
  )
    return "organizationSsoProviders";
  if (verb === "GET" && /^\/organizations\/[^/]+$/.test(requestPath))
    return "organizationsRead";
  if (verb === "POST" && requestPath === "/organizations")
    return "organizationsWrite";
  if (verb === "POST" && requestPath === "/api/updates/check")
    return "clientUpdateCheck";
  if (verb === "GET" && requestPath === "/api/updates/latest")
    return "clientUpdateLatest";
  if (verb === "POST" && requestPath === "/api/admin/releases")
    return "clientReleasePublish";
  return undefined;
}

function summarizeBlockedAction(
  request: EvaluationRequest,
  policyName: string,
) {
  const agent = request.agent.displayName;
  const tool = request.event.tool?.name;
  const input = request.event.tool?.input;
  const inputText = JSON.stringify(input ?? {}).toLowerCase();
  const policy = policyName.toLowerCase();
  if (
    policy.includes("credential") ||
    policy.includes("secret") ||
    /(\.env|credential|secret|token|private key|id_rsa|kubeconfig)/.test(
      inputText,
    )
  ) {
    return `${agent} is trying to access or create sensitive file content.`;
  }
  if (
    policy.includes("destructive") ||
    /(rm\s+-rf|delete|destroy|git reset|chmod|chown)/.test(inputText)
  ) {
    return `${agent} is trying to run a potentially destructive command.`;
  }
  if (
    policy.includes("git repo") ||
    /(git init|new git repo|create .*repo)/.test(inputText)
  ) {
    return `${agent} is trying to create a new Git repository.`;
  }
  if (
    policy.includes("external") ||
    policy.includes("sharing") ||
    /(http|curl|upload|send)/.test(inputText)
  ) {
    return `${agent} is trying to share code or data outside this workspace.`;
  }
  if (tool)
    return `${agent} is trying to use ${tool} in a way OpenLeash paused.`;
  if (request.event.eventName === "UserPromptSubmit")
    return `${agent} is trying to answer a prompt OpenLeash paused.`;
  return `${agent} is trying to continue with an action OpenLeash paused.`;
}

function summarizePolicyTitle(rule: string) {
  const lower = rule.toLowerCase();
  if (
    /(credential files|local files|\.env|kubeconfig|npm token|password vault|cloud credentials|api key stores)/.test(
      lower,
    )
  )
    return "Credential files access";
  if (
    /(delete files|destructive|irreversible|rewrite history|terraform destroy|git reset|change permissions)/.test(
      lower,
    )
  )
    return "Destructive commands";
  if (
    /(personal data|pii|reveal secrets|tokens|private keys|credentials)/.test(
      lower,
    )
  )
    return "Secret and personal data";
  if (/5\s*(\+|plus|add|added to)\s*4/.test(lower)) return "5 plus 4 answers";
  if (/(new git repo|create .*git repo|git init|repository)/.test(lower))
    return "Git repo creation";
  if (/(source code|external domains|unknown external|exfiltrat)/.test(lower))
    return "External code sharing";
  const cleaned = rule
    .replace(/[^\w\s.+/#-]/g, " ")
    .replace(
      /\b(do not|don't|never|disallow|prevent|block|deny|allow|agents?|the|a|an|to|from|that|which|any|before)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const words = (cleaned || "New policy").split(/\s+/).slice(0, 7);
  const title = words.join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function policyCategory(input: string, name: string, rule: string) {
  const provided = input.trim();
  if (provided) return provided;
  const text = `${name} ${rule}`.toLowerCase();
  if (
    /credential|secret|token|private key|api key|\.env|kubeconfig|password|cookie|npmrc/.test(
      text,
    )
  )
    return "Secrets and credentials";
  if (
    /personal|pii|customer|employee|passport|ssn|credit card|regulated|external|upload|source code|exfiltrat|unknown url|third-party/.test(
      text,
    )
  )
    return "Data protection";
  if (
    /git|branch|commit|push|rebase|repository|repo|history|worktree/.test(text)
  )
    return "Source control";
  if (
    /database|drop table|drop database|truncate|delete from|update statement|sql/.test(
      text,
    )
  )
    return "Databases";
  if (
    /terraform|kubernetes|kubectl|cloud|s3|gcp|aws|azure|namespace|vm|dns|helm|infrastructure/.test(
      text,
    )
  )
    return "Infrastructure";
  if (
    /package|dependency|lockfile|npm|pnpm|yarn|pip|gem|cargo|go install|supply-chain/.test(
      text,
    )
  )
    return "Supply chain";
  if (
    /rm -rf|delete|destructive|format|chmod|chown|filesystem|disk|volume/.test(
      text,
    )
  )
    return "System safety";
  return "General";
}

function policyInventorySql(organizationWhere = "") {
  const organizationFilter = organizationWhere
    ? `and ${organizationWhere}`
    : "";
  return `
    select p.*,
           coalesce(stats.trigger_count, 0)::int as trigger_count,
           coalesce(stats.deny_count, 0)::int as deny_count,
           coalesce(stats.question_count, 0)::int as question_count,
           stats.last_triggered_at,
           stats.last_agent_name,
           stats.last_project_path
    from policies p
    left join lateral (
      select count(*) filter (where pr.status in ('failed', 'needs_question'))::int as trigger_count,
             count(*) filter (where pr.status = 'failed')::int as deny_count,
             count(*) filter (where pr.status = 'needs_question')::int as question_count,
             max(pr.created_at) filter (where pr.status in ('failed', 'needs_question')) as last_triggered_at,
             (array_agg(ar.display_name order by pr.created_at desc) filter (where pr.status in ('failed', 'needs_question')))[1] as last_agent_name,
             (array_agg(ce.project_path order by pr.created_at desc) filter (where pr.status in ('failed', 'needs_question')))[1] as last_project_path
      from policy_results pr
      join evaluations e on e.id = pr.evaluation_id
      join conversation_events ce on ce.id = e.conversation_event_id
      left join agent_runtimes ar on ar.id = ce.agent_runtime_id
      left join users u on u.id = e.user_id
      where (pr.policy_id = p.id or pr.policy_name = p.name)
        ${organizationFilter}
    ) stats on true
    where p.organization_id = $1
    order by p.category asc, p.created_at asc`;
}

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) return next(error);
    const statusCode = statusCodeForError(error);
    const message =
      error instanceof Error ? error.message : "Leash API error";
    res.status(statusCode).json({ success: false, error: message, message });
  },
);

export async function prepareOpenLeashApi(
  options: PrepareOpenLeashApiOptions = {},
) {
  const runningApp = options.app ?? app;
  const surface = options.surface ?? apiSurface;
  if (surface !== "client") {
    throw new Error("Leash no longer exposes a dashboard API surface");
  }
  configureAuditExportProvider(options.auditExportProvider);
  configureRuntimePolicyProvider(options.runtimePolicyProvider);
  await ensureDevToken();
  for (const extension of options.extensions ?? []) {
    await extension({ app: runningApp, surface });
  }
  return runningApp;
}

export async function startOpenLeashApi(
  options: StartOpenLeashApiOptions = {},
) {
  const runningApp = await prepareOpenLeashApi(options);
  const surface = options.surface ?? apiSurface;
  const port = Number(options.port ?? process.env.OPENLEASH_API_PORT ?? 9318);
  return runningApp.listen(port, () => {
    console.log(`Leash Engine listening on http://localhost:${port}`);
  });
}

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isEntrypoint) {
  await startOpenLeashApi();
}
