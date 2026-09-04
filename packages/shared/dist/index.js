import { LEASH_FEATURE_PRESENTATIONS } from "./feature-presentations.js";
export { LEASH_FEATURE_PRESENTATIONS, LEASH_FEATURE_SHOWCASE, leashFeaturePresentation, } from "./feature-presentations.js";
export function firstPartyFeature(slug, _version, options = {}) {
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
        version: "1.1.0",
        publisher: "openleash",
        runtime: "builtin",
        execution: firstPartyFeature("data-leakage-prevention", "1.1.0"),
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
                contextMode: { enum: ["goal-aware", "strict"] },
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
            contextMode: "goal-aware",
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
        version: "1.1.0",
        publisher: "openleash",
        runtime: "builtin",
        execution: firstPartyFeature("sensitive-access", "1.1.0"),
        entrypoint: "client-api",
        events: ["prompt.beforeSubmit", "agent.response", "tool.beforeUse", "tool.afterUse"],
        permissions: ["event:read", "prompt:read", "tool:read", "conversation:read", "model:invoke", "decision:write", "audit:write", "log:write", "signal:write"],
        effects: ["observe", "ask", "deny"],
        ordering: { priority: 180, before: ["openleash.dlp", "openleash.blast-radius", "openleash.rules-enforcer"] },
        configSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                enabled: { type: "boolean" },
                contextMode: { enum: ["goal-aware", "strict"] },
                secretFileAction: { enum: ["allow", "ask", "block"] },
                envDumpAction: { enum: ["allow", "ask", "block"] },
                exfiltrationAction: { enum: ["allow", "ask", "block"] }
            }
        },
        defaultConfig: {
            enabled: true,
            contextMode: "goal-aware",
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
        version: "1.1.0",
        publisher: "openleash",
        runtime: "builtin",
        execution: firstPartyFeature("blast-radius", "1.1.0"),
        entrypoint: "client-api",
        events: ["prompt.beforeSubmit", "tool.beforeUse"],
        permissions: ["event:read", "prompt:read", "tool:read", "conversation:read", "model:invoke", "decision:write", "audit:write", "log:write", "signal:write", "island:publish"],
        effects: ["observe", "ask", "deny"],
        ordering: { priority: 220, before: ["openleash.rules-enforcer", "openleash.mcp-scanner"] },
        configSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
                enabled: { type: "boolean" },
                contextMode: { enum: ["goal-aware", "strict"] },
                destructiveAction: { enum: ["allow", "ask", "block"] },
                databaseMutationAction: { enum: ["allow", "ask", "block"] },
                broadFilesystemAction: { enum: ["allow", "ask", "block"] }
            }
        },
        defaultConfig: {
            enabled: true,
            contextMode: "goal-aware",
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
];
export const OPENLEASH_PLUGIN_CATEGORIES = [
    { id: "security", label: "Protections", color: "#0b7968", icon: "shield" },
    { id: "cost", label: "Cost", color: "#5b47e0", icon: "trend" },
    { id: "observability", label: "Visibility", color: "#2a63d8", icon: "eye" },
    { id: "utility", label: "Other", color: "#a15b12", icon: "bolt" }
];
export function pluginPackageId(plugin) {
    return plugin.slug || plugin.marketplace?.slug || String(plugin.id || "").split(".").pop() || plugin.name || plugin.id;
}
export function pluginCategoryId(plugin) {
    const featureId = pluginPackageId(plugin);
    if (["blast-radius", "code-scanner", "data-leakage-prevention", "mcp-scanner", "rules-enforcer", "sensitive-access", "skill-scanner"].includes(featureId))
        return "security";
    if (["prompt-compression", "token-saver"].includes(featureId))
        return "cost";
    const raw = plugin.marketplace?.category || plugin.category || plugin.manifest?.category || "";
    const text = String(raw || `${plugin.id || ""} ${plugin.name || ""} ${plugin.description || ""} ${(plugin.marketplace?.tags || []).join(" ")} ${(plugin.tags || []).join(" ")}`).toLowerCase();
    if (/mcp-scanner|skill-scanner/.test(text))
        return "security";
    if (/security|policy|guard|skill|prompt-injection|risk|approval|dlp|leak|sensitive|secret|credential/.test(text))
        return "security";
    if (/visibility|observability|observe|log|mcp|siem|audit|telemetry|monitor/.test(text))
        return "observability";
    if (/cost|token|compression|usage|budget|spend/.test(text))
        return "cost";
    return "utility";
}
export function buildOpenLeashClientViewModel({ plugins, outcomes, summary, shellSections = ["overview", "agents", "activity", "approvals", "policies", "settings"] }) {
    const outcomesByPlugin = new Map();
    for (const outcome of outcomes) {
        const pluginId = outcome.source?.pluginId || "openleash";
        const list = outcomesByPlugin.get(pluginId) || [];
        list.push(outcome);
        outcomesByPlugin.set(pluginId, list);
    }
    const installed = plugins
        .filter((plugin) => plugin.settings?.enabled === true)
        .map((plugin) => {
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
function clientViewSummary(outcomes, summary) {
    const fallback = {
        totalOutcomes: outcomes.length,
        highSeverity: outcomes.filter((item) => item.severity === "high" || item.severity === "critical").length,
        blocked: outcomes.filter((item) => item.status === "blocked" || item.decision === "blocked" || item.decision === "deny").length,
        needsReview: outcomes.filter((item) => item.status === "needs_review" || item.decision === "ask").length,
        byDomain: outcomes.reduce((acc, item) => {
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
export const HOOK_AGENT_METADATA = {
    claude: { kind: "claude-code", displayName: "Claude Code" },
    codex: { kind: "codex", displayName: "OpenAI Codex" },
    copilot: { kind: "github-copilot", displayName: "GitHub Copilot" },
    cursor: { kind: "cursor", displayName: "Cursor" },
    gemini: { kind: "gemini", displayName: "Google Gemini CLI" },
    opencode: { kind: "opencode", displayName: "OpenCode" },
    openclaw: { kind: "openclaw", displayName: "OpenClaw" },
    nanoclaw: { kind: "nanoclaw", displayName: "NanoClaw" }
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
};
export function apiVersionHeaders(functionName) {
    return {
        [OPENLEASH_API_FUNCTION_HEADER]: functionName,
        [OPENLEASH_API_VERSION_HEADER]: OPENLEASH_API_CONTRACTS[functionName]
    };
}
export function apiContractFor(functionName) {
    return {
        functionName,
        version: OPENLEASH_API_CONTRACTS[functionName]
    };
}
const MCP_TOOL_PATTERNS = [
    /^mcp__([A-Za-z0-9_.-]+)__(.+)$/i,
    /^mcp[:.]([A-Za-z0-9_.-]+)[:.](.+)$/i
];
const SECRET_ARGUMENT_KEY = /(api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|client[_-]?secret|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)/i;
export function parseMcpToolName(toolName) {
    const name = String(toolName ?? "").trim();
    if (!name)
        return undefined;
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
export function mcpToolCallFromEvent(event) {
    const parsed = parseMcpToolName(event.tool?.name) ??
        mcpToolCallFromRaw(event.raw);
    if (!parsed)
        return undefined;
    const args = redactMcpArguments(event.tool?.input ?? rawToolInput(event.raw) ?? {});
    return {
        ...parsed,
        arguments: args,
        argumentSummary: summarizeMcpArguments(args)
    };
}
export function redactMcpArguments(value, depth = 0) {
    if (depth > 8)
        return "[TRUNCATED]";
    if (Array.isArray(value))
        return value.slice(0, 50).map((item) => redactMcpArguments(item, depth + 1));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
            key,
            SECRET_ARGUMENT_KEY.test(key) ? "[REDACTED]" : redactMcpArguments(item, depth + 1)
        ]));
    }
    if (typeof value === "string")
        return value.length > 800 ? `${value.slice(0, 800)}...` : value;
    return value;
}
export function summarizeMcpArguments(value) {
    if (!value || typeof value !== "object")
        return value === undefined ? "" : String(value).slice(0, 180);
    const entries = Object.entries(value).slice(0, 4);
    if (entries.length === 0)
        return "No arguments";
    return entries.map(([key, item]) => `${key}: ${argumentValuePreview(item)}`).join(" · ").slice(0, 240);
}
function argumentValuePreview(value) {
    if (value === "[REDACTED]")
        return "[REDACTED]";
    if (value === null || value === undefined)
        return String(value);
    if (typeof value === "string")
        return value.length > 54 ? `${value.slice(0, 54)}...` : value;
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    if (Array.isArray(value))
        return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
    return "{...}";
}
function normalizeMcpServerName(value) {
    return value.trim().replace(/\s+/g, "-").slice(0, 160);
}
function rawToolInput(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const record = raw;
    const tool = record.tool && typeof record.tool === "object" ? record.tool : undefined;
    return record.tool_input ?? record.toolInput ?? tool?.input ?? record.input;
}
function mcpToolCallFromRaw(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const record = raw;
    const serverName = record.mcp_server ??
        record.mcpServer ??
        record.server_name ??
        record.serverName ??
        (record.tool && typeof record.tool === "object" ? record.tool.serverName : undefined);
    const toolName = record.tool_name ??
        record.toolName ??
        (record.tool && typeof record.tool === "object" ? record.tool.name : undefined);
    if (typeof serverName !== "string" || typeof toolName !== "string")
        return undefined;
    return {
        serverName: normalizeMcpServerName(serverName),
        toolName,
        fullToolName: parseMcpToolName(toolName)?.fullToolName ?? `mcp__${normalizeMcpServerName(serverName)}__${toolName}`
    };
}
