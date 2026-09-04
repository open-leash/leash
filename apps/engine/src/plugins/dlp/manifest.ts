import { LEASH_FEATURE_PRESENTATIONS, firstPartyFeature, type OpenLeashPluginManifest } from "@openleash/shared";

export const dlpManifest: OpenLeashPluginManifest = {
  id: "openleash.dlp",
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
  ordering: {
    priority: 200,
    after: ["openleash.prompt-compression"]
  },
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
};
