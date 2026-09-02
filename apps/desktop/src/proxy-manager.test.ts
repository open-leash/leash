import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  configureAgentProxy,
  LOCAL_PROXY_URL,
  localProxyEnvironment,
  localProxyBinaryCandidates,
} from "./proxy-manager.js";
import { hookApiUrl, proxyClientApiUrl } from "./cli/config.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "openleash-proxy-test-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

test("released desktop resolves the bundled native proxy without Docker", () => {
  const macResourcesPath = "/Applications/Leash.app/Contents/Resources";
  assert.deepEqual(
    localProxyBinaryCandidates({
      platform: "darwin",
      resourcesPath: macResourcesPath,
      moduleDir: `${macResourcesPath}/app.asar/apps/desktop/dist`,
      override: "",
    }).slice(0, 1),
    [path.join(macResourcesPath, "local-proxy", "openleash-local-proxy")],
  );
  assert.equal(
    localProxyBinaryCandidates({
      platform: "win32",
      resourcesPath: "C:\\Program Files\\Leash\\resources",
      moduleDir: "C:\\Program Files\\Leash\\resources\\app.asar\\dist",
      override: "",
    })[0].endsWith("openleash-local-proxy.exe"),
    true,
  );
});

test("proxy traffic and hooks use the availability-aware desktop edge", () => {
  const config = {
    apiUrl: "http://127.0.0.1:9317/",
    remoteApiUrl: "https://api.openleash.com/",
  };
  assert.equal(proxyClientApiUrl(config), "http://127.0.0.1:9317");
  assert.equal(hookApiUrl(config), "http://127.0.0.1:9317");
});

test("only managed proxy installs enable the classified availability fallback", () => {
  const env = localProxyEnvironment(
    { clientApiUrl: "http://127.0.0.1:9317", token: "test" },
    {},
  );
  assert.equal(env.OPENLEASH_PROXY_FAIL_OPEN, "false");
  assert.equal(env.OPENLEASH_CLIENT_API, "http://127.0.0.1:9317");
  assert.equal(
    localProxyEnvironment(
      {
        clientApiUrl: "http://127.0.0.1:9317",
        token: "test",
        failOpen: true,
      },
      {},
    ).OPENLEASH_PROXY_FAIL_OPEN,
    "true",
  );
});

test("Claude proxy configuration is reversible", () => {
  const file = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"env":{"EXISTING":"yes"},"theme":"dark"}\n');
  configureAgentProxy("claude-code", true);
  const configured = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(configured.env.ANTHROPIC_BASE_URL, `${LOCAL_PROXY_URL}/agent/claude-code`);
  assert.equal(configured.env.EXISTING, "yes");
  configureAgentProxy("claude-code", false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { env: { EXISTING: "yes" }, theme: "dark" });
});

test("Codex proxy configuration is idempotent and reversible", () => {
  const file = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = 'model = "gpt-5"\n\n[projects."/tmp"]\ntrust_level = "trusted"\n';
  fs.writeFileSync(file, original);
  configureAgentProxy("codex", true);
  fs.appendFileSync(
    file,
    '\n[features]\nhooks = true\n\n[hooks.state."openleash-test"]\ntrusted_hash = "sha256:test"\n',
  );
  configureAgentProxy("codex", true);
  const configured = fs.readFileSync(file, "utf8");
  assert.equal((configured.match(/Managed by OpenLeash/g) ?? []).length, 1);
  assert.match(configured, new RegExp(`base_url = "${LOCAL_PROXY_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/agent/codex/v1"`));
  assert.match(configured, /\[projects\."\/tmp"\]/);
  assert.match(configured, /\[features\]\nhooks = true/);
  assert.match(configured, /\[hooks\.state\."openleash-test"\]/);
  configureAgentProxy("codex", false);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("Codex ChatGPT authentication selects the ChatGPT proxy upstream", () => {
  const dir = path.join(home, ".codex");
  const file = path.join(dir, "config.toml");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "auth.json"), '{"auth_mode":"chatgpt"}\n');
  fs.writeFileSync(file, 'model = "gpt-5"\n');
  fs.rmSync(`${file}.openleash-proxy-backup`, { force: true });
  configureAgentProxy("codex", true);
  const configured = fs.readFileSync(file, "utf8");
  assert.match(
    configured,
    /http_headers = \{ "x-openleash-codex-auth-mode" = "chatgpt" \}/,
  );
  configureAgentProxy("codex", false);
});

test("unsupported agents fail without changing files", () => {
  assert.throws(() => configureAgentProxy("cursor", true), /Cursor Settings/);
});

test("NanoClaw shares the reversible Claude-compatible adapter", () => {
  const file = path.join(home, ".nanoclaw", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"env":{"KEEP":"yes"}}\n');
  configureAgentProxy("nanoclaw", true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).env.ANTHROPIC_BASE_URL, `${LOCAL_PROXY_URL}/agent/nanoclaw`);
  configureAgentProxy("nanoclaw", false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { env: { KEEP: "yes" } });
});

test("OpenCode provider overrides preserve provider configuration and restore", () => {
  const file = path.join(home, ".config", "opencode", "opencode.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = { model: "anthropic/claude", provider: { anthropic: { options: { apiKey: "{env:ANTHROPIC_API_KEY}" }, models: { custom: {} } }, custom: { npm: "x" } } };
  fs.writeFileSync(file, `${JSON.stringify(original)}\n`);
  configureAgentProxy("opencode", true);
  const configured = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(configured.provider.anthropic.options.baseURL, `${LOCAL_PROXY_URL}/agent/opencode`);
  assert.equal(configured.provider.openai.options.baseURL, `${LOCAL_PROXY_URL}/agent/opencode/v1`);
  assert.equal(configured.provider.anthropic.models.custom instanceof Object, true);
  assert.equal(configured.provider.custom.npm, "x");
  configureAgentProxy("opencode", false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), original);
});

test("proxy cleanup removes stale managed values even when backup files are missing", () => {
  const claudeFile = path.join(home, ".claude", "settings.json");
  fs.writeFileSync(
    claudeFile,
    `${JSON.stringify({
      env: {
        EXISTING: "yes",
        ANTHROPIC_BASE_URL: `${LOCAL_PROXY_URL}/agent/claude-code`,
      },
      theme: "dark",
    })}\n`,
  );
  fs.rmSync(`${claudeFile}.openleash-proxy-backup`, { force: true });
  configureAgentProxy("claude-code", false);
  assert.deepEqual(JSON.parse(fs.readFileSync(claudeFile, "utf8")), {
    env: { EXISTING: "yes" },
    theme: "dark",
  });

  const codexFile = path.join(home, ".codex", "config.toml");
  fs.writeFileSync(
    codexFile,
    [
      "# Managed by OpenLeash local proxy",
      'model_provider = "openleash"',
      "",
      'model = "gpt-5"',
      "",
      "[model_providers.openleash]",
      'name = "Leash local proxy"',
      `base_url = "${LOCAL_PROXY_URL}/agent/codex/v1"`,
      'wire_api = "responses"',
      "",
    ].join("\n"),
  );
  fs.rmSync(`${codexFile}.openleash-proxy-backup`, { force: true });
  configureAgentProxy("codex", false);
  const codexClean = fs.readFileSync(codexFile, "utf8");
  assert.match(codexClean, /model = "gpt-5"/);
  assert.doesNotMatch(codexClean, /OpenLeash|model_provider/);

  const openCodeFile = path.join(home, ".config", "opencode", "opencode.json");
  fs.mkdirSync(path.dirname(openCodeFile), { recursive: true });
  fs.writeFileSync(
    openCodeFile,
    `${JSON.stringify({
      provider: {
        anthropic: { options: { apiKey: "keep", baseURL: `${LOCAL_PROXY_URL}/agent/opencode` } },
        openai: { options: { baseURL: `${LOCAL_PROXY_URL}/agent/opencode/v1` } },
        custom: { npm: "keep" },
      },
    })}\n`,
  );
  fs.rmSync(`${openCodeFile}.openleash-proxy-backup`, { force: true });
  configureAgentProxy("opencode", false);
  assert.deepEqual(JSON.parse(fs.readFileSync(openCodeFile, "utf8")), {
    provider: {
      anthropic: { options: { apiKey: "keep" } },
      openai: {},
      custom: { npm: "keep" },
    },
  });
});

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
