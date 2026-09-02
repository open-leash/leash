import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCAL_PROXY_URL = "http://127.0.0.1:9320";
function agentProxyUrl(kind: string, openAi = false) {
  return `${LOCAL_PROXY_URL}/agent/${kind}${openAi ? "/v1" : ""}`;
}
const PROXY_STATE_DIR = process.env.OPENLEASH_LOCAL_PROXY_STATE_DIR ||
  path.join(os.homedir(), ".openleash", "local-proxy");
const PROXY_PID_FILE = path.join(PROXY_STATE_DIR, "proxy.pid");
const PROXY_LOG_FILE = path.join(PROXY_STATE_DIR, "proxy.log");
const LEGACY_CONTAINER_NAME = "openleash-local-proxy";

export type ProxyAgentKind = "claude-code" | "codex" | "nanoclaw" | "opencode";
export const PROXY_AGENT_SUPPORT = {
  "claude-code": {
    mode: "automatic",
    surfaces: ["Claude CLI", "Claude Code VS Code"],
  },
  codex: { mode: "automatic", surfaces: ["Codex CLI", "Codex VS Code"] },
  nanoclaw: { mode: "automatic", surfaces: ["NanoClaw"] },
  opencode: {
    mode: "automatic",
    surfaces: ["OpenCode CLI", "OpenCode desktop"],
  },
  cursor: {
    mode: "manual",
    surfaces: ["Cursor editor", "Cursor CLI"],
    instructions: `Set the OpenAI override URL to ${LOCAL_PROXY_URL}/v1 and Anthropic base URL to ${LOCAL_PROXY_URL} in Cursor Settings > Models.`,
  },
  cline: {
    mode: "manual",
    surfaces: ["Cline VS Code"],
    instructions: `Choose OpenAI Compatible in Cline provider settings and set Base URL to ${LOCAL_PROXY_URL}/v1.`,
  },
  "github-copilot": {
    mode: "hooks",
    surfaces: ["Copilot CLI", "Copilot VS Code"],
    instructions:
      "Copilot remains protected by Leash hooks. BYOK proxy routing requires a launch environment and is not persisted by Copilot.",
  },
  openclaw: {
    mode: "hooks",
    surfaces: ["OpenClaw"],
    instructions:
      "OpenClaw remains protected by its Leash hook pack; gateway proxying requires an OpenClaw runtime extension.",
  },
} as const;
export type LocalProxyStatus = {
  runtimeAvailable: boolean;
  installed: boolean;
  running: boolean;
  healthy: boolean;
  url: string;
  binary: string;
  configuredAgents: ProxyAgentKind[];
  error?: string;
};

export async function localProxyStatus(): Promise<LocalProxyStatus> {
  const binary = findLocalProxyBinary();
  const pid = readProxyPid();
  const processRunning = pid !== undefined && processExists(pid);
  const healthy = await proxyIsHealthy();
  if (pid !== undefined && !processRunning) clearProxyPid();
  const configured = configuredAgents();
  return baseStatus({
    runtimeAvailable: Boolean(binary),
    installed: processRunning || healthy || configured.length > 0,
    running: processRunning || healthy,
    healthy,
    binary: binary ?? "",
    configuredAgents: configured,
    ...(!binary ? { error: "The Leash proxy binary is missing from this desktop build." } : {}),
  });
}

export async function installLocalProxy(options: {
  clientApiUrl: string;
  token: string;
  agents?: string[];
  corporateProxy?: string;
  failOpen?: boolean;
}) {
  const binary = findLocalProxyBinary();
  if (!binary)
    throw new Error("The Leash proxy binary is missing. Reinstall or update Leash, then try again.");
  if (!options.token.trim())
    throw new Error(
      "Leash backend token is required before installing the proxy.",
    );
  const agents = options.agents ?? [];
  for (const agent of agents) configureAgentProxy(agent, false);
  await stopManagedProxy();
  removeLegacyProxyContainer();
  fs.mkdirSync(PROXY_STATE_DIR, { recursive: true, mode: 0o700 });
  const log = fs.openSync(PROXY_LOG_FILE, "a", 0o600);
  const env = localProxyEnvironment(options);
  const child = spawn(binary, [], {
    detached: true,
    env,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  fs.closeSync(log);
  if (!child.pid) throw new Error("Could not start the bundled Leash proxy.");
  child.unref();
  fs.writeFileSync(PROXY_PID_FILE, `${child.pid}\n`, { mode: 0o600 });
  await waitForHealthyProxy();
  for (const agent of agents) configureAgentProxy(agent, true);
  return localProxyStatus();
}

export function localProxyEnvironment(
  options: {
    clientApiUrl: string;
    token: string;
    corporateProxy?: string;
    failOpen?: boolean;
  },
  base: NodeJS.ProcessEnv = process.env,
) {
  return {
    ...base,
    OPENLEASH_PROXY_LISTEN: "127.0.0.1:9320",
    OPENLEASH_CLIENT_API: options.clientApiUrl.replace(/\/$/, ""),
    OPENLEASH_TOKEN: options.token,
    // The desktop edge classifies Cloud failures. This final native fallback
    // keeps providers reachable if the desktop edge itself disappears, while
    // the proxy still enforces every valid allow/deny response and non-retryable
    // 4xx error.
    OPENLEASH_PROXY_FAIL_OPEN: options.failOpen === true ? "true" : "false",
    OPENLEASH_ANTHROPIC_UPSTREAM: "https://api.anthropic.com",
    OPENLEASH_OPENAI_UPSTREAM: "https://api.openai.com",
    OPENLEASH_CHATGPT_UPSTREAM: "https://chatgpt.com/backend-api/codex",
    ...(options.corporateProxy?.trim()
      ? { OPENLEASH_CORPORATE_PROXY: options.corporateProxy.trim() }
      : {}),
  };
}

export async function uninstallLocalProxy() {
  for (const agent of ["claude-code", "codex", "nanoclaw", "opencode"] as const)
    configureAgentProxy(agent, false);
  await stopManagedProxy();
  removeLegacyProxyContainer();
  return localProxyStatus();
}

export function configureAgentProxy(kind: string, enabled: boolean) {
  if (kind === "claude-code") return configureClaude(enabled);
  if (kind === "codex") return configureCodex(enabled);
  if (kind === "nanoclaw")
    return configureClaudeCompatible(
      path.join(os.homedir(), ".nanoclaw", "settings.json"),
      enabled,
    );
  if (kind === "opencode") return configureOpenCode(enabled);
  const support = PROXY_AGENT_SUPPORT[kind as keyof typeof PROXY_AGENT_SUPPORT];
  if (support && "instructions" in support)
    throw new Error(support.instructions);
  throw new Error(
    `${kind} does not expose a stable supported model API base URL configuration.`,
  );
}

function configureClaude(enabled: boolean) {
  return configureClaudeCompatible(
    path.join(os.homedir(), ".claude", "settings.json"),
    enabled,
  );
}

function configureClaudeCompatible(file: string, enabled: boolean) {
  const backup = `${file}.openleash-proxy-backup`;
  if (!enabled)
    return restoreBackupOrClean(file, backup, () => {
      if (!fs.existsSync(file)) return;
      const settings = readJson(file);
      const env = settings.env && typeof settings.env === "object"
        ? settings.env as Record<string, unknown>
        : undefined;
      const kind = file.includes(`${path.sep}.nanoclaw${path.sep}`)
        ? "nanoclaw"
        : "claude-code";
      if (env?.ANTHROPIC_BASE_URL === agentProxyUrl(kind))
        delete env.ANTHROPIC_BASE_URL;
      if (env && Object.keys(env).length === 0) delete settings.env;
      writeJson(file, settings);
    });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(backup))
    fs.writeFileSync(
      backup,
      fs.existsSync(file) ? fs.readFileSync(file) : "{}\n",
    );
  const settings = readJson(file);
  const env =
    settings.env && typeof settings.env === "object"
      ? (settings.env as Record<string, unknown>)
      : {};
  const kind = file.includes(`${path.sep}.nanoclaw${path.sep}`)
    ? "nanoclaw"
    : "claude-code";
  settings.env = { ...env, ANTHROPIC_BASE_URL: agentProxyUrl(kind) };
  writeJson(file, settings);
}

function configureOpenCode(enabled: boolean) {
  const file = path.join(os.homedir(), ".config", "opencode", "opencode.json");
  const backup = `${file}.openleash-proxy-backup`;
  if (!enabled)
    return restoreBackupOrClean(file, backup, () => {
      if (!fs.existsSync(file)) return;
      const config = readJson(file);
      const providers = config.provider && typeof config.provider === "object"
        ? config.provider as Record<string, unknown>
        : undefined;
      removeManagedProviderBaseUrl(
        providers?.anthropic,
        agentProxyUrl("opencode"),
      );
      removeManagedProviderBaseUrl(
        providers?.openai,
        agentProxyUrl("opencode", true),
      );
      writeJson(file, config);
    });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(backup)) {
    const original = fs.existsSync(file)
      ? fs.readFileSync(file)
      : Buffer.from("{}\n");
    // Never replace an existing JSON/JSONC-looking configuration with an empty
    // object. OpenCode supports JSONC, but safely editing comments requires a
    // syntax-aware editor; those users receive an actionable manual path.
    if (fs.existsSync(file)) parseJsonOrThrow(file, original.toString("utf8"));
    fs.writeFileSync(backup, original);
  }
  const config = parseJsonOrThrow(backup, fs.readFileSync(backup, "utf8"));
  const providers =
    config.provider && typeof config.provider === "object"
      ? (config.provider as Record<string, unknown>)
      : {};
  config.provider = {
    ...providers,
    anthropic: mergeProviderBaseUrl(
      providers.anthropic,
      agentProxyUrl("opencode"),
    ),
    openai: mergeProviderBaseUrl(
      providers.openai,
      agentProxyUrl("opencode", true),
    ),
  };
  writeJson(file, config);
}

function mergeProviderBaseUrl(value: unknown, baseURL: string) {
  const provider =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const options =
    provider.options && typeof provider.options === "object"
      ? (provider.options as Record<string, unknown>)
      : {};
  return { ...provider, options: { ...options, baseURL } };
}

function removeManagedProviderBaseUrl(value: unknown, expected: string) {
  if (!value || typeof value !== "object") return;
  const provider = value as Record<string, unknown>;
  if (!provider.options || typeof provider.options !== "object") return;
  const options = provider.options as Record<string, unknown>;
  if (options.baseURL === expected) delete options.baseURL;
  if (Object.keys(options).length === 0) delete provider.options;
}

function configureCodex(enabled: boolean) {
  const file = path.join(os.homedir(), ".codex", "config.toml");
  const backup = `${file}.openleash-proxy-backup`;
  if (!enabled)
    return restoreBackupOrClean(file, backup, () => {
      if (!fs.existsSync(file)) return;
      const clean = stripManagedCodexProxy(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, clean ? `${clean}\n` : "");
    });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(backup))
    fs.writeFileSync(backup, fs.existsSync(file) ? fs.readFileSync(file) : "");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const source = stripManagedCodexProxy(current);
  const chatGptHeader =
    codexAuthMode() === "chatgpt"
      ? '\nhttp_headers = { "x-openleash-codex-auth-mode" = "chatgpt" }'
      : "";
  const block = `# Managed by OpenLeash local proxy\nmodel_provider = "openleash"\n\n${source}\n\n[model_providers.openleash]\nname = "Leash local proxy"\nbase_url = "${agentProxyUrl("codex", true)}"\nwire_api = "responses"\nrequires_openai_auth = true${chatGptHeader}\n`;
  fs.writeFileSync(
    file,
    block.replace(`\n\n${source}\n\n`, source ? `\n\n${source}\n\n` : "\n\n"),
  );
}

function stripManagedCodexProxy(config: string) {
  return config
    .replace(/^\s*# Managed by OpenLeash local proxy\s*\n?/m, "")
    .replace(/^\s*model_provider\s*=\s*"openleash"\s*\n?/m, "")
    .replace(
      /\n?\[model_providers\.openleash\]\s*\n(?:^(?!\s*\[).*(?:\n|$))*/gm,
      "\n",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function codexAuthMode() {
  const auth = readJson(path.join(os.homedir(), ".codex", "auth.json"));
  return typeof auth.auth_mode === "string" ? auth.auth_mode.toLowerCase() : "";
}

function configuredAgents(): ProxyAgentKind[] {
  const result: ProxyAgentKind[] = [];
  const claude = readJson(path.join(os.homedir(), ".claude", "settings.json"));
  if (
    (claude.env as Record<string, unknown> | undefined)?.ANTHROPIC_BASE_URL ===
    agentProxyUrl("claude-code")
  )
    result.push("claude-code");
  try {
    if (
      fs
        .readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8")
        .includes("# Managed by OpenLeash local proxy")
    )
      result.push("codex");
  } catch {
    /* absent */
  }
  const nanoclaw = readJson(
    path.join(os.homedir(), ".nanoclaw", "settings.json"),
  );
  if (
    (nanoclaw.env as Record<string, unknown> | undefined)
      ?.ANTHROPIC_BASE_URL === agentProxyUrl("nanoclaw")
  )
    result.push("nanoclaw");
  const opencode = readJson(
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
  );
  const providers = opencode.provider as
    Record<string, { options?: { baseURL?: string } }> | undefined;
  if (
    providers?.anthropic?.options?.baseURL === agentProxyUrl("opencode") &&
    providers?.openai?.options?.baseURL === agentProxyUrl("opencode", true)
  )
    result.push("opencode");
  return result;
}

async function waitForHealthyProxy() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await localProxyStatus();
    if (status.healthy) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const logs = tailProxyLog();
  throw new Error(
    `The bundled Leash proxy did not become healthy. ${logs}`.trim(),
  );
}

function findLocalProxyBinary() {
  return localProxyBinaryCandidates().find((candidate) => fs.existsSync(candidate));
}

export function localProxyBinaryCandidates(options: {
  platform?: NodeJS.Platform;
  resourcesPath?: string;
  moduleDir?: string;
  override?: string;
} = {}) {
  const platform = options.platform ?? process.platform;
  const executable = platform === "win32" ? "openleash-local-proxy.exe" : "openleash-local-proxy";
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const moduleDir = options.moduleDir ?? __dirname;
  const override = options.override ?? process.env.OPENLEASH_LOCAL_PROXY_BINARY;
  return [
    override,
    resourcesPath ? path.join(resourcesPath, "local-proxy", executable) : undefined,
    path.resolve(moduleDir, "..", "build", "local-proxy", executable),
    path.resolve(moduleDir, "..", "..", "local-proxy", "target", "release", executable),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

async function proxyIsHealthy() {
  try {
    return (
      await fetch(`${LOCAL_PROXY_URL}/healthz`, {
        signal: AbortSignal.timeout(1500),
      })
    ).ok;
  } catch {
    return false;
  }
}

function readProxyPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PROXY_PID_FILE, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function clearProxyPid() {
  fs.rmSync(PROXY_PID_FILE, { force: true });
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopManagedProxy() {
  const pid = readProxyPid();
  if (pid === undefined) return;
  if (processExists(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* process already exited */
    }
    for (let attempt = 0; attempt < 20 && processExists(pid); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
  clearProxyPid();
}

function removeLegacyProxyContainer() {
  // Older Leash releases used Docker for this proxy. Remove that container
  // when Docker happens to be available, but never make Docker a requirement.
  spawnSync("docker", ["rm", "-f", LEGACY_CONTAINER_NAME], {
    encoding: "utf8",
    timeout: 15_000,
  });
}

function tailProxyLog() {
  try {
    return fs.readFileSync(PROXY_LOG_FILE, "utf8").split(/\r?\n/).slice(-30).join("\n");
  } catch {
    return "No proxy log was written.";
  }
}
function baseStatus(overrides: Partial<LocalProxyStatus>): LocalProxyStatus {
  return {
    runtimeAvailable: false,
    installed: false,
    running: false,
    healthy: false,
    url: LOCAL_PROXY_URL,
    binary: "",
    configuredAgents: configuredAgents(),
    ...overrides,
  };
}
function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function parseJsonOrThrow(
  file: string,
  source: string,
): Record<string, unknown> {
  try {
    return JSON.parse(source) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Leash did not modify ${file} because it is not strict JSON. Set provider.anthropic.options.baseURL to ${agentProxyUrl("opencode")} and provider.openai.options.baseURL to ${agentProxyUrl("opencode", true)} manually.`,
    );
  }
}
function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function restoreBackupOrClean(
  file: string,
  backup: string,
  cleanManagedValues: () => void,
) {
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, file);
    fs.rmSync(backup, { force: true });
    return;
  }
  cleanManagedValues();
}
