import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hasManagedCodexProxy,
  installAgentProtection,
  openClawHandlerSource,
  openCodePluginSource,
  uninstallAllAgentProtections,
} from "./agent-registry";
import { enableCodexHooksFeature } from "./codex-config";

const context = {
  apiUrl: "https://api.openleash.test",
  token: "test-token",
  clientVersion: "test-version",
};

test("generated hooks authenticate locally without putting tokens in URLs", () => {
  const openCode = openCodePluginSource(context);
  assert.match(openCode, /authorization.*Bearer test-token/i);
  assert.match(openCode, /AbortError/);
  assert.match(openCode, /TimeoutError/);
  assert.match(openCode, /UND_ERR_SOCKET/);
  assert.doesNotMatch(openCode, /[?&](?:user_)?token=/i);

  const openClaw = openClawHandlerSource({
    ...context,
    availabilityFailOpen: true,
  });
  assert.match(openClaw, /authorization: Bearer test-token/i);
  assert.match(openClaw, /\[7, 28\]/);
  assert.match(openClaw, /event\.cancel = true/);
  assert.doesNotMatch(openClaw, /[?&](?:user_)?token=/i);
});

test("CLI OpenClaw builds curl argv directly and keeps non-availability failures closed", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src", "cli", "install.ts"),
    "utf8",
  );
  assert.match(source, /authorization: `Bearer \$\{config\.token\}`/);
  assert.match(source, /localHookCurlArgs\("openclaw", "UserPromptSubmit"\)/);
  assert.doesNotMatch(source, /command\.match\(/);
  assert.match(source, /event\.cancel = true/);
  assert.match(source, /AbortError/);
  assert.match(source, /TimeoutError/);
  assert.match(source, /UND_ERR_SOCKET/);
});

test("Codex monitoring re-enables hooks after an earlier uninstall", () => {
  const config = [
    'model = "gpt-5.6-sol"',
    "",
    "[features]",
    "hooks = false",
    'other_feature = "preserved"',
    "",
    "[mcp_servers.docs]",
    'url = "https://example.test/mcp"',
    "",
  ].join("\n");

  const enabled = enableCodexHooksFeature(config);
  assert.match(enabled, /\[features\]\nhooks = true\n/);
  assert.doesNotMatch(enabled, /hooks = false/);
  assert.match(enabled, /other_feature = "preserved"/);
  assert.match(enabled, /\[mcp_servers\.docs\]/);
  assert.equal(enableCodexHooksFeature(enabled), enabled);
});

test("Codex monitoring adds the hooks feature when no features table exists", () => {
  const enabled = enableCodexHooksFeature('model = "gpt-5.6-sol"\n');
  assert.match(enabled, /\[features\]\nhooks = true\n$/);
});

test("Codex monitoring recognizes the OpenLeash-managed local proxy", () => {
  const configured = [
    "# Managed by OpenLeash local proxy",
    'model_provider = "openleash"',
    "",
    "[model_providers.openleash]",
    'name = "Leash local proxy"',
    'base_url = "http://127.0.0.1:9320/agent/codex/v1"',
    'wire_api = "responses"',
  ].join("\n");
  assert.equal(hasManagedCodexProxy(configured), true);
  assert.equal(hasManagedCodexProxy(configured.replace("# Managed by OpenLeash local proxy\n", "")), false);
  assert.equal(hasManagedCodexProxy(configured.replace("/agent/codex/v1", "/v1")), false);
});

async function loadOpenCodePlugin() {
  const source = openCodePluginSource(context);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Math.random()}`;
  const nativeImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<unknown>;
  return (await nativeImport(moduleUrl)) as {
    OpenLeash: (input: Record<string, unknown>) => Promise<Record<string, any>>;
  };
}

test("OpenCode native questions are answered through the island response", async () => {
  const originalFetch = globalThis.fetch;
  const hookRequests: Array<Record<string, any>> = [];
  const replies: Array<Record<string, any>> = [];
  globalThis.fetch = async (_input, init) => {
    hookRequests.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        decision: "allow",
        response: { answers: { "Which deployment target?": "Staging" } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const { OpenLeash } = await loadOpenCodePlugin();
    const hooks = await OpenLeash({
      directory: "/tmp/project",
      serverUrl: new URL("http://127.0.0.1:4096"),
      client: {
        question: {
          reply: async (input: Record<string, any>) => replies.push(input),
        },
      },
    });
    await hooks.event({
      event: {
        type: "question.asked",
        properties: {
          id: "question-1",
          sessionID: "session-1",
          questions: [
            {
              question: "Which deployment target?",
              header: "Target",
              options: [
                { label: "Production", description: "Deploy publicly" },
                { label: "Staging", description: "Deploy for testing" },
              ],
            },
          ],
        },
      },
    });
    assert.equal(hookRequests[0].tool_name, "AskUserQuestion");
    assert.equal(hookRequests[0].session_id, "session-1");
    assert.deepEqual(replies, [
      {
        requestID: "question-1",
        directory: "/tmp/project",
        answers: [["Staging"]],
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenCode uses its event stream for completion and its permission hook for policy", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    const body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        decision: body.tool_name === "filesystem" ? "block" : "allow",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const { OpenLeash } = await loadOpenCodePlugin();
    const hooks = await OpenLeash({
      directory: "/tmp/project",
      serverUrl: new URL("http://127.0.0.1:4096"),
      client: {},
    });
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "session-2" } },
    });
    const output = { status: "ask" };
    await hooks["permission.ask"](
      {
        permission: "filesystem",
        patterns: ["/tmp/project/**"],
        metadata: {},
        sessionID: "session-2",
      },
      output,
    );
    assert.match(urls[0], /\/v1\/hooks\/opencode\/Stop/);
    assert.match(urls[1], /\/v1\/hooks\/opencode\/PreToolUse/);
    assert.equal(output.status, "deny");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("agent hook reinstall starts clean and uninstall restores the exact user config", async () => {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openleash-hook-lifecycle-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const settingsPath = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "user-security-check" }] }],
      },
      permissions: { defaultMode: "default" },
      theme: "dark",
    };
    fs.writeFileSync(settingsPath, `${JSON.stringify(original, null, 2)}\n`);

    await installAgentProtection("claude-code", context);
    await installAgentProtection("claude-code", { ...context, token: "replacement-token" });
    const installed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const installedHooks = JSON.stringify(installed.hooks);
    assert.match(installedHooks, /replacement-token/);
    assert.match(installedHooks, /--connect-timeout/);
    assert.match(installedHooks, /hook_status/);
    assert.doesNotMatch(JSON.stringify(installed.__openleash), /\/v1\/hooks\/claude\//);

    await uninstallAllAgentProtections();
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), original);

    const codexDir = path.join(home, ".codex");
    const codexConfigPath = path.join(codexDir, "config.toml");
    const codexHooksPath = path.join(codexDir, "hooks.json");
    fs.mkdirSync(codexDir, { recursive: true });
    const originalCodexConfig = [
      'model = "gpt-5"',
      "",
      "[features]",
      "other_feature = true",
      "",
      "[mcp_servers.docs]",
      'url = "https://example.test/mcp"',
      "",
    ].join("\n");
    const originalCodexHooks = {
      version: 1,
      hooks: {
        PreToolUse: [{ hooks: [{ command: "user-security-check" }] }],
        CustomEvent: [{ hooks: [{ command: "keep-custom-event" }] }],
      },
    };
    fs.writeFileSync(codexConfigPath, originalCodexConfig);
    fs.writeFileSync(codexHooksPath, `${JSON.stringify(originalCodexHooks, null, 2)}\n`);

    await installAgentProtection("codex", context);
    await installAgentProtection("codex", { ...context, token: "replacement-token" });
    await uninstallAllAgentProtections();
    assert.equal(fs.readFileSync(codexConfigPath, "utf8"), originalCodexConfig);
    assert.deepEqual(JSON.parse(fs.readFileSync(codexHooksPath, "utf8")), originalCodexHooks);
    assert.equal(fs.existsSync(`${codexHooksPath}.openleash-metadata.json`), false);
    for (const file of [
      path.join(home, ".gemini", "settings.json"),
      path.join(home, ".cursor", "hooks.json"),
      path.join(home, ".config", "opencode", "plugins", "openleash.js"),
    ]) assert.equal(fs.existsSync(file), false, `cleanup created ${file}`);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("metadata-free cleanup removes only stale OpenLeash hooks", async () => {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openleash-stale-hook-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const settingsPath = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ command: "curl https://api.example/v1/hooks/claude/UserPromptSubmit" }] }],
        PreToolUse: [{ hooks: [{ command: "user-security-check" }] }],
      },
      permissions: { defaultMode: "bypassPermissions", keep: true },
      skipDangerousModePermissionPrompt: true,
    })}\n`);

    await uninstallAllAgentProtections();
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), {
      hooks: {
        PreToolUse: [{ hooks: [{ command: "user-security-check" }] }],
      },
      permissions: { keep: true },
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
