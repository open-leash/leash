import assert from "node:assert/strict";
import test from "node:test";
import { notificationPluginAttribution } from "./notification-plugin-attribution.js";
import { canonicalPluginSlug } from "./plugin-slug.js";

test("canonicalizes plugin aliases and display names to slugs", () => {
  assert.equal(canonicalPluginSlug("Blast Radius"), "blast-radius");
  assert.equal(canonicalPluginSlug("openleash.blast-radius"), "blast-radius");
  assert.equal(canonicalPluginSlug("openleash.prompt-compression"), "token-saver");
  assert.equal(canonicalPluginSlug("token-compression"), "token-saver");
  assert.equal(canonicalPluginSlug("Token Saver"), "token-saver");
  assert.equal(canonicalPluginSlug("openleash.core"), "openleash-core");
});

test("uses a slug for core attribution", () => {
  assert.equal(notificationPluginAttribution({}).plugin_name, "openleash-core");
});

test("attributes recursive deletion to blast-radius instead of the first asking plugin", () => {
  const attribution = notificationPluginAttribution({
    openleashPluginRuns: [
      {
        pluginId: "openleash.sensitive-access",
        status: "needs_question",
        findings: [{ severity: "high" }],
      },
      {
        pluginId: "openleash.blast-radius",
        status: "blocked",
        findings: [{ severity: "critical" }],
      },
    ],
  });

  assert.deepEqual(attribution, {
    plugin_id: "openleash.blast-radius",
    plugin_name: "blast-radius",
  });
});

test("uses severity to break ties between responsible plugins", () => {
  const attribution = notificationPluginAttribution({
    openleashPluginRuns: [
      { pluginId: "openleash.rules-enforcer", status: "blocked", findings: [{ severity: "high" }] },
      { pluginId: "openleash.blast-radius", status: "blocked", findings: [{ severity: "critical" }] },
    ],
  });

  assert.equal(attribution.plugin_name, "blast-radius");
});

test("attributes equal ask-level database destruction to blast-radius", () => {
  const attribution = notificationPluginAttribution({
    openleashPluginRuns: [
      { pluginId: "openleash.sensitive-access", status: "needs_question", findings: [{ severity: "high" }] },
      { pluginId: "openleash.blast-radius", status: "needs_question", findings: [{ severity: "high" }] },
    ],
  });

  assert.equal(attribution.plugin_name, "blast-radius");
});

test("does not let tie priority override a higher-severity sensitive finding", () => {
  const attribution = notificationPluginAttribution({
    openleashPluginRuns: [
      { pluginId: "openleash.sensitive-access", status: "needs_question", findings: [{ severity: "critical" }] },
      { pluginId: "openleash.blast-radius", status: "needs_question", findings: [{ severity: "high" }] },
    ],
  });

  assert.equal(attribution.plugin_name, "sensitive-access");
});

test("attributes a closed DLP failure ahead of a fail-open token-saver failure", () => {
  const attribution = notificationPluginAttribution({
    openleashPluginRuns: [
      { pluginId: "openleash.prompt-compression", status: "failed" },
      { pluginId: "openleash.dlp", status: "failed" },
    ],
  });

  assert.equal(attribution.plugin_name, "data-leakage-prevention");
});
