import { LEASH_FEATURE_PRESENTATIONS, firstPartyFeature, type OpenLeashPluginManifest } from "@openleash/shared";

export const blastRadiusManifest: OpenLeashPluginManifest = {
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
  ordering: {
    priority: 220,
    before: ["openleash.rules-enforcer", "openleash.mcp-scanner"]
  },
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
};
