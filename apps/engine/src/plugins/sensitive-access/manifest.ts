import { LEASH_FEATURE_PRESENTATIONS, firstPartyFeature, type OpenLeashPluginManifest } from "@openleash/shared";

export const sensitiveAccessManifest: OpenLeashPluginManifest = {
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
  ordering: {
    priority: 180,
    before: ["openleash.dlp", "openleash.blast-radius", "openleash.rules-enforcer"]
  },
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
};
