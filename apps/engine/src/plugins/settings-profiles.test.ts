import assert from "node:assert/strict";
import test from "node:test";
import { normalizePluginSettingProfiles, resolvePluginSettingProfiles } from "./settings-profiles.js";

test("normalizes bounded agent-scoped plugin profiles", () => {
  assert.deepEqual(normalizePluginSettingProfiles([{
    id: " Codex Strict ",
    name: "Codex strict",
    agentKinds: ["codex", "codex", "not-an-agent"],
    enabled: true,
    priority: 20.9,
    config: { level: "maximum" },
  }]), [{
    id: "codex-strict",
    name: "Codex strict",
    agentKinds: ["codex"],
    enabled: true,
    priority: 20,
    config: { level: "maximum" },
  }]);
});

test("merges matching organization then user profiles deterministically", () => {
  const resolved = resolvePluginSettingProfiles({
    enabled: false,
    config: { level: "light", keep: true },
    organizationProfiles: [{ id: "org", name: "Org", agentKinds: ["codex"], enabled: true, config: { level: "standard" } }],
    userProfiles: [
      { id: "claude", name: "Claude", agentKinds: ["claude-code"], config: { level: "light" } },
      { id: "codex", name: "Codex", agentKinds: ["codex"], config: { level: "maximum" }, priority: 10 },
    ],
    agentKind: "codex",
  });
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.config, { level: "maximum", keep: true });
  assert.deepEqual(resolved.effectiveProfileIds, ["organization:org", "user:codex"]);
});

test("applies centrally managed employee and IdP group profiles", () => {
  const profiles = normalizePluginSettingProfiles([
    { id: "engineering-monitor", name: "Engineering", agentKinds: [], groupIds: ["group-engineering"], config: { protectionMode: "monitor" } },
    { id: "alice-active", name: "Alice", agentKinds: [], userIds: ["user-alice"], config: { protectionMode: "active" }, priority: 100 },
  ]);
  assert.equal(resolvePluginSettingProfiles({
    enabled: true,
    config: { protectionMode: "active" },
    organizationProfiles: profiles,
    userId: "user-bob",
    groupIds: ["group-engineering"],
  }).config.protectionMode, "monitor");
  assert.equal(resolvePluginSettingProfiles({
    enabled: true,
    config: { protectionMode: "active" },
    organizationProfiles: profiles,
    userId: "user-alice",
    groupIds: ["group-engineering"],
  }).config.protectionMode, "active");
});

test("locked organization settings ignore user profiles", () => {
  const resolved = resolvePluginSettingProfiles({
    enabled: true,
    config: { action: "block" },
    userProfiles: [{ id: "relax", name: "Relax", agentKinds: [], enabled: false, config: { action: "ask" } }],
    agentKind: "codex",
    configLocked: true,
  });
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.config, { action: "block" });
  assert.deepEqual(resolved.effectiveProfileIds, []);
});

test("personal and locked CISO profiles resolve contextual approval mode correctly", () => {
  const personal = resolvePluginSettingProfiles({
    enabled: true,
    config: { contextMode: "goal-aware" },
    userProfiles: [{ id: "strict", name: "Strict", agentKinds: ["codex"], config: { contextMode: "strict" } }],
    agentKind: "codex",
  });
  assert.equal(personal.config.contextMode, "strict");

  const cisoLocked = resolvePluginSettingProfiles({
    enabled: true,
    config: { contextMode: "strict" },
    userProfiles: [{ id: "relax", name: "Relax", agentKinds: ["codex"], config: { contextMode: "goal-aware" } }],
    agentKind: "codex",
    configLocked: true,
  });
  assert.equal(cisoLocked.config.contextMode, "strict");
  assert.deepEqual(cisoLocked.effectiveProfileIds, []);
});

test("mandatory plugins allow employee config freedom without allowing an agent-level disable", () => {
  const resolved = resolvePluginSettingProfiles({
    enabled: true,
    config: { level: "standard" },
    userProfiles: [{
      id: "codex-personal",
      name: "Codex personal",
      agentKinds: ["codex"],
      enabled: false,
      config: { level: "strict" },
    }],
    agentKind: "codex",
    mandatory: true,
  });
  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.config, { level: "strict" });
  assert.deepEqual(resolved.effectiveProfileIds, ["user:codex-personal"]);
});

test("targets one enrolled agent without creating another container", () => {
  const profiles = normalizePluginSettingProfiles([{
    id: "codex-laptop",
    name: "Codex on laptop",
    agentKinds: ["codex"],
    agentIds: ["agent-laptop"],
    config: { level: "aggressive" },
  }]);
  assert.equal(resolvePluginSettingProfiles({
    enabled: true,
    config: { level: "balanced" },
    userProfiles: profiles,
    agentKind: "codex",
    agentId: "agent-laptop",
  }).config.level, "aggressive");
  assert.equal(resolvePluginSettingProfiles({
    enabled: true,
    config: { level: "balanced" },
    userProfiles: profiles,
    agentKind: "codex",
    agentId: "agent-desktop",
  }).config.level, "balanced");
});

test("normalizes project roots and applies project profiles to nested working directories", () => {
  const profiles = normalizePluginSettingProfiles([{
    id: "project-rules",
    name: "Project rules",
    agentKinds: [],
    projectPaths: [" /Users/max/Code/OpenLeash/ ", "\\Users\\max\\Code\\OpenLeash"],
    config: { rules: [{ text: "Ask before changing migrations", action: "ask" }] },
  }]);
  assert.deepEqual(profiles[0]?.projectPaths, ["/Users/max/Code/OpenLeash"]);
  assert.equal(resolvePluginSettingProfiles({
    enabled: true,
    config: { rules: [] },
    userProfiles: profiles,
    projectPath: "/Users/max/Code/OpenLeash/apps/engine",
  }).effectiveProfileIds[0], "user:project-rules");
  assert.deepEqual(resolvePluginSettingProfiles({
    enabled: true,
    config: { rules: [] },
    userProfiles: profiles,
    projectPath: "/Users/max/Code/Other",
  }).config, { rules: [] });
});

test("project matching respects Windows casing and UNC roots", () => {
  const profiles = normalizePluginSettingProfiles([{
    id: "windows-project",
    name: "Windows project",
    agentKinds: [],
    projectPaths: ["\\\\build-server\\repos\\OpenLeash", "C:\\Code\\OpenLeash"],
    config: { strict: true },
  }]);
  assert.deepEqual(profiles[0]?.projectPaths, ["//build-server/repos/OpenLeash", "C:/Code/OpenLeash"]);
  for (const projectPath of ["//BUILD-SERVER/repos/openleash/apps", "c:/code/openleash/packages"]) {
    assert.equal(resolvePluginSettingProfiles({
      enabled: true,
      config: {},
      userProfiles: profiles,
      projectPath,
    }).config.strict, true);
  }
});

test("rules from the base, project, and agent scopes accumulate", () => {
  const resolved = resolvePluginSettingProfiles({
    enabled: true,
    config: { rules: [{ text: "Global rule", action: "ask" }] },
    organizationProfiles: [
      { id: "project", name: "Project", agentKinds: [], projectPaths: ["/repo"], config: { rules: [{ text: "Project rule", action: "block" }] } },
      { id: "agent", name: "Agent", agentKinds: ["codex"], config: { rules: [{ text: "Agent rule", action: "ask" }] } },
    ],
    agentKind: "codex",
    projectPath: "/repo/apps/api",
    mergeArrayKeys: ["rules"],
  });
  assert.deepEqual(resolved.config.rules, [
    { text: "Global rule", action: "ask" },
    { text: "Agent rule", action: "ask" },
    { text: "Project rule", action: "block" },
  ]);
});
