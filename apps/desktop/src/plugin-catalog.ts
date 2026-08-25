import { LEASH_FEATURE_PRESENTATIONS } from "@openleash/shared";

export type BundledPluginManifest = {
  id: string;
  slug?: string;
  name: string;
  description: string;
  repositoryUrl?: string;
  version: string;
  publisher: string;
  runtime: "builtin" | "container";
  execution?: {
    type: "in-process";
    handler: string;
    failureMode?: "open" | "closed";
  } | {
    type: "container";
    placement: "edge" | "server" | "either";
    protocol: "openleash-container-plugin.v1";
    image: string;
    digest?: string;
    eventPath?: string;
    timeoutMs?: number;
    failureMode?: "open" | "closed";
  };
  entrypoint: string;
  events: string[];
  permissions: string[];
  effects: string[];
  ordering?: { priority?: number; before?: string[]; after?: string[] };
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  tags?: string[];
};

export type PluginSettingState = {
  enabled: boolean;
  config: Record<string, unknown>;
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
  inheritedProfiles?: PluginSettingState["profiles"];
  effectiveProfileIds?: string[];
  runtimeAvailable?: boolean;
  runtimeError?: string;
  orderingPriority?: number | null;
  installedVersion?: string;
  availableVersion?: string;
  updateAvailable?: boolean;
  updatePolicy?: "manual" | "patch" | "minor" | "locked";
  updatedAt?: string;
};

export type PluginCatalogItem = BundledPluginManifest & {
  settings: PluginSettingState;
  organizationPolicy?: {
    mandatory?: boolean;
    defaultEnabled?: boolean;
    userInstallAllowed?: boolean;
    configLocked?: boolean;
  };
};

function bundledFeature(slug: string, _version: string): NonNullable<BundledPluginManifest["execution"]> {
  return {
    type: "in-process",
    handler: slug,
    failureMode: "closed",
  };
}

export const bundledFirstPartyPlugins: BundledPluginManifest[] = [
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
    events: ["provider.request.beforeSend", "plugin.tool.execute", "prompt.beforeSubmit"],
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
    defaultConfig: { enabled: true, level: "standard", conciseResponse: false, minimumChars: 1200, protectRecent: 2, ccrEnabled: false, ccrTtlSeconds: 3600 },
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
    execution: bundledFeature("skill-scanner", "1.0.2"),
    entrypoint: "client-api",
    events: ["openleash.startup", "agent.detected", "skill.detected", "skill.changed"],
    permissions: ["event:read", "filesystem:read", "decision:write", "model:invoke", "audit:write", "notification:send"],
    effects: ["observe", "ask", "inventory"],
    ordering: { priority: 150 },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        suspiciousRiskThreshold: { type: "number" }
      }
    },
    defaultConfig: { enabled: true, suspiciousRiskThreshold: 50 },
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
    execution: bundledFeature("data-leakage-prevention", "1.0.0"),
    entrypoint: "client-api",
    events: ["prompt.beforeSubmit"],
    permissions: ["event:read", "prompt:read", "prompt:write", "decision:write", "model:invoke", "audit:write"],
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
    defaultConfig: { enabled: true, action: "ask", categories: ["pii", "phi", "tokens", "keys", "credentials"] },
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
    execution: bundledFeature("sensitive-access", "1.0.0"),
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
    defaultConfig: { enabled: true, secretFileAction: "ask", envDumpAction: "ask", exfiltrationAction: "block" },
    tags: ["security", "secrets", "credentials", "privacy"]
  },
  {
    id: "openleash.blast-radius",
    slug: "blast-radius",
    name: LEASH_FEATURE_PRESENTATIONS["blast-radius"].name,
    description: LEASH_FEATURE_PRESENTATIONS["blast-radius"].description,
    repositoryUrl: "https://github.com/open-leash/plugin-blast-radius",
    version: "1.0.2",
    publisher: "openleash",
    runtime: "builtin",
    execution: bundledFeature("blast-radius", "1.0.2"),
    entrypoint: "client-api",
    events: ["tool.beforeUse"],
    permissions: ["event:read", "tool:read", "decision:write", "audit:write", "log:write", "signal:write", "island:publish"],
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
    defaultConfig: { enabled: true, destructiveAction: "ask", databaseMutationAction: "ask", broadFilesystemAction: "ask" },
    tags: ["security", "destructive", "database", "tools"]
  },
  {
    id: "openleash.code-scanner",
    slug: "code-scanner",
    name: LEASH_FEATURE_PRESENTATIONS["code-scanner"].name,
    description: LEASH_FEATURE_PRESENTATIONS["code-scanner"].description,
    repositoryUrl: "https://github.com/open-leash/plugin-code-scanner",
    version: "1.0.0",
    publisher: "openleash",
    runtime: "builtin",
    execution: bundledFeature("code-scanner", "1.0.0"),
    entrypoint: "client-api",
    events: ["agent.response", "tool.beforeUse"],
    permissions: ["event:read", "tool:read", "model:invoke", "audit:write", "log:write", "signal:write", "notification:send"],
    effects: ["observe", "notify"],
    ordering: { priority: 260, before: ["openleash.rules-enforcer"] },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        notificationRiskThreshold: { type: "number", minimum: 0, maximum: 100 },
        minimumCodeCharacters: { type: "number", minimum: 40, maximum: 4000 }
      }
    },
    defaultConfig: { enabled: true, notificationRiskThreshold: 70, minimumCodeCharacters: 80 },
    tags: ["security", "code", "vulnerabilities", "vibe-coding", "notifications"]
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
    execution: bundledFeature("rules-enforcer", "1.0.0"),
    entrypoint: "client-api",
    events: ["prompt.beforeSubmit", "agent.response", "tool.beforeUse", "tool.afterUse"],
    permissions: ["event:read", "prompt:read", "tool:read", "decision:write", "model:invoke", "audit:write", "notification:send"],
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
    defaultConfig: { enabled: true, rules: [] },
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
    execution: bundledFeature("mcp-scanner", "1.0.0"),
    entrypoint: "client-api",
    events: ["tool.beforeUse", "tool.afterUse"],
    permissions: ["event:read", "tool:read", "audit:write"],
    effects: ["observe", "inventory"],
    ordering: { priority: 400, after: ["openleash.rules-enforcer"] },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        redactSecrets: { type: "boolean" }
      }
    },
    defaultConfig: { enabled: true, redactSecrets: true },
    tags: ["security", "mcp", "inventory", "audit"]
  }
];

export function bundledPluginCatalog(): PluginCatalogItem[] {
  return bundledFirstPartyPlugins.map((plugin) => ({
    ...plugin,
    settings: {
      enabled: plugin.defaultConfig?.enabled !== false,
      config: plugin.defaultConfig ?? {},
      orderingPriority: plugin.ordering?.priority ?? null
    }
  }));
}
