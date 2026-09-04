import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBuiltinFeatureRegistry,
  latestProviderPrompt,
  replaceLatestProviderPrompt,
  verifyBuiltinFeatureRegistry,
} from "./feature-runtime.js";
import { firstPartyPluginManifests } from "./registry.js";

test("every shipped Feature has a reviewed in-process handler", () => {
  assert.doesNotThrow(assertBuiltinFeatureRegistry);
  const results = verifyBuiltinFeatureRegistry(firstPartyPluginManifests.map((feature) => ({
    ...feature,
    settings: { enabled: true, config: feature.defaultConfig ?? {} },
  })));
  assert.ok(results.length > 0);
  assert.ok(results.every((result) => result.healthy && result.protocolVerified));
});

test("every built-in Feature starts enabled for a new user", () => {
  assert.ok(firstPartyPluginManifests.length > 0);
  for (const feature of firstPartyPluginManifests) {
    assert.equal(feature.defaultConfig?.enabled, true, feature.id);
  }
});

test("Token Saver declares every capability used by its in-process handler", () => {
  const tokenSaver = firstPartyPluginManifests.find((plugin) => plugin.id === "openleash.prompt-compression");
  assert.ok(tokenSaver);
  assert.ok(tokenSaver.permissions.includes("model:invoke"));
  assert.ok(tokenSaver.permissions.includes("prompt:write"));
  assert.ok(tokenSaver.permissions.includes("usage:write"));
  assert.ok(tokenSaver.permissions.includes("island:publish"));
});

test("interrupting protections default to goal-aware context and expose strict mode", () => {
  for (const pluginId of ["openleash.dlp", "openleash.sensitive-access", "openleash.blast-radius"]) {
    const plugin = firstPartyPluginManifests.find((item) => item.id === pluginId);
    assert.ok(plugin, pluginId);
    assert.equal(plugin.defaultConfig?.contextMode, "goal-aware", pluginId);
    const properties = plugin.configSchema?.properties as Record<string, { enum?: string[] }> | undefined;
    assert.deepEqual(properties?.contextMode?.enum, ["goal-aware", "strict"], pluginId);
    assert.ok(plugin.permissions.includes("model:invoke"), pluginId);
    if (pluginId !== "openleash.dlp") assert.ok(plugin.permissions.includes("conversation:read"), pluginId);
  }
});

test("provider prompt helpers support OpenAI and Anthropic request shapes", () => {
  const responses = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "old" }] }] };
  assert.equal(latestProviderPrompt(responses), "old");
  replaceLatestProviderPrompt(responses, "new");
  assert.equal(latestProviderPrompt(responses), "new");

  const messages = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
  assert.equal(latestProviderPrompt(messages), "hello");
  replaceLatestProviderPrompt(messages, "safe");
  assert.equal(latestProviderPrompt(messages), "safe");
});
