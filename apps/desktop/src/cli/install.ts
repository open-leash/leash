import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import {
  enableCodexHooksFeature,
  probeCodexHooks,
} from "../codex-config.js";
import { apiVersionHeaders } from "./api-contract.js";
import { availabilityFailOpen, hookApiUrl, readConfig } from "./config.js";
import {
  claudeSettingsPath,
  codexConfigPath,
  codexHooksPath,
  copilotOpenLeashHooksPath,
  cursorHooksPath,
  geminiSettingsPath,
  openCodePluginPath,
  nanoClawSettingsPath,
  openClawOpenLeashHookDir
} from "./paths.js";

const HOOK_TIMEOUT_SECONDS = 600;
const HOOK_TIMEOUT_MS = HOOK_TIMEOUT_SECONDS * 1000;

type HookAgent = "claude" | "codex" | "copilot" | "cursor" | "gemini" | "opencode" | "openclaw" | "nanoclaw";
type HookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

async function hookCommand(agent: HookAgent, event: HookEventName) {
  const { config, args } = await localHookCurlArgs(agent, event);
  const failOpen = availabilityFailOpen(config)
    ? '; if [ "$hook_status" -eq 7 ] || [ "$hook_status" -eq 28 ]; then exit 0; fi'
    : "";
  return `curl ${args.map(shellQuote).join(" ")}; hook_status=$?${failOpen}; exit "$hook_status"`;
}

async function localHookCurlArgs(agent: HookAgent, event: HookEventName) {
  const config = await readConfig();
  const endpoint = new URL(`/v1/hooks/${agent}/${event}`, hookApiUrl(config));
  endpoint.searchParams.set("hostname", config.computer?.hostname ?? os.hostname());
  endpoint.searchParams.set("platform", os.platform());
  endpoint.searchParams.set("os_release", os.release());
  if (config.clientVersion) endpoint.searchParams.set("client_version", config.clientVersion);
  const contract = apiVersionHeaders("localHookEvaluate");
  const headerArgs = Object.entries(contract).flatMap(([key, value]) => ["-H", `${key}: ${value}`]);
  const args = [
    "-sS",
    "--fail-with-body",
    "--connect-timeout",
    "1",
    "--max-time",
    String(HOOK_TIMEOUT_SECONDS + 10),
    "-X",
    "POST",
    endpoint.toString(),
    "-H",
    "content-type: application/json",
    "-H",
    `authorization: Bearer ${config.token}`,
    ...headerArgs,
    "--data-binary",
    "@-"
  ];
  return { config, args };
}

export async function installClaudeHooks() {
  await installClaudeCompatibleHooks(claudeSettingsPath, "claude");
}

export async function uninstallClaudeHooks() {
  await uninstallClaudeCompatibleHooks(claudeSettingsPath, "claude");
}

export async function installNanoClawHooks() {
  await installClaudeCompatibleHooks(nanoClawSettingsPath, "nanoclaw");
}

export async function uninstallNanoClawHooks() {
  await uninstallClaudeCompatibleHooks(nanoClawSettingsPath, "nanoclaw");
}

async function installClaudeCompatibleHooks(settingsPath: string, agent: "claude" | "nanoclaw") {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const existing = await readJsonObject(settingsPath);
  const hooks = existing.hooks && typeof existing.hooks === "object" ? existing.hooks : {};
  const metadata = openLeashMetadata(existing);
  metadata[agent] = {
    installedAt: new Date().toISOString(),
    hooks: snapshotHookEntries(hooks as Record<string, unknown>),
    permissions: snapshotClaudePermissions(existing)
  };
  existing.__openleash = metadata;
  existing.hooks = {
    ...hooks,
    UserPromptSubmit: [
      {
        hooks: [{ type: "command", command: await hookCommand(agent, "UserPromptSubmit"), timeout: HOOK_TIMEOUT_SECONDS }]
      }
    ],
    PreToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: await hookCommand(agent, "PreToolUse"), timeout: HOOK_TIMEOUT_SECONDS }]
      }
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: await hookCommand(agent, "PostToolUse"), timeout: HOOK_TIMEOUT_SECONDS }]
      }
    ],
    Stop: [
      {
        hooks: [{ type: "command", command: await hookCommand(agent, "Stop"), timeout: HOOK_TIMEOUT_SECONDS }]
      }
    ]
  };
  enableClaudeCompatibleApprovalHandoff(existing);
  await fs.writeFile(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

async function uninstallClaudeCompatibleHooks(settingsPath: string, agent: "claude" | "nanoclaw") {
  if (!(await fileExists(settingsPath))) return;
  const existing = await readJsonObject(settingsPath);
  const metadata = openLeashMetadata(existing);
  const backup = metadata[agent];
  const hooks = existing.hooks && typeof existing.hooks === "object" ? existing.hooks as Record<string, unknown> : {};
  const managedNeedle = `/v1/hooks/${agent}/`;
  const hadManagedHooks = JSON.stringify(hooks).includes(managedNeedle);
  restoreHookEntries(hooks, backup?.hooks, managedNeedle);
  existing.hooks = hooks;
  if (backup?.permissions) restoreClaudePermissions(existing, backup.permissions);
  else if (hadManagedHooks) removeManagedClaudePermissions(existing);
  delete metadata[agent];
  if (Object.keys(metadata).length > 0) existing.__openleash = metadata;
  else delete existing.__openleash;
  await fs.writeFile(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

export async function installOpenClawHooks() {
  await fs.mkdir(openClawOpenLeashHookDir, { recursive: true });
  await fs.writeFile(path.join(openClawOpenLeashHookDir, "HOOK.md"), openClawHookMetadata());
  await fs.writeFile(path.join(openClawOpenLeashHookDir, "handler.ts"), await openClawHandlerSource());
  spawnSync("openclaw", ["hooks", "enable", "openleash"], { stdio: "ignore" });
}

export async function uninstallOpenClawHooks() {
  if (!(await fileExists(openClawOpenLeashHookDir))) return;
  spawnSync("openclaw", ["hooks", "disable", "openleash"], { stdio: "ignore" });
  await fs.rm(openClawOpenLeashHookDir, { recursive: true, force: true });
}

export async function installCodexHooks() {
  await fs.mkdir(path.dirname(codexConfigPath), { recursive: true });
  const metadataPath = `${codexHooksPath}.openleash-metadata.json`;
  let config = "";
  try {
    config = await fs.readFile(codexConfigPath, "utf8");
  } catch {
    config = "";
  }
  const originalConfig = config;
  config = enableCodexHooksFeature(enableCodexApprovalHandoff(config));
  if (!/^\s*hooks\s*=\s*true\s*$/m.test(config)) {
    if (/^\s*\[features\]\s*$/m.test(config)) {
      config = config.replace(/^(\s*\[features\]\s*\n)/m, "$1hooks = true\n");
    } else {
      config += `${config.endsWith("\n") || config.length === 0 ? "" : "\n"}[features]\nhooks = true\n`;
    }
  }
  await fs.writeFile(codexConfigPath, config);
  const existing = await readJsonObject(codexHooksPath);
  const hooks = existing.hooks && typeof existing.hooks === "object"
    ? existing.hooks as Record<string, unknown>
    : {};
  await fs.writeFile(metadataPath, `${JSON.stringify({
    hooksExisted: Object.prototype.hasOwnProperty.call(existing, "hooks"),
    events: snapshotNamedHookEntries(hooks, codexHookEvents()),
    config: snapshotCodexHooksFeature(originalConfig),
  }, null, 2)}\n`);
  existing.hooks = {
    ...hooks,
    PreToolUse: [await codexHookGroup("PreToolUse")],
    PostToolUse: [await codexHookGroup("PostToolUse")],
    UserPromptSubmit: [await codexHookGroup("UserPromptSubmit")],
    Stop: [await codexHookGroup("Stop")]
  };
  await fs.writeFile(codexHooksPath, `${JSON.stringify(existing, null, 2)}\n`);
  await trustCodexHooks();
}

export async function uninstallCodexHooks() {
  const metadataPath = `${codexHooksPath}.openleash-metadata.json`;
  const configExists = await fileExists(codexConfigPath);
  const hooksExist = await fileExists(codexHooksPath);
  const metadataExists = await fileExists(metadataPath);
  if (!configExists && !hooksExist && !metadataExists) return;
  const config = await fs.readFile(codexConfigPath, "utf8").catch(() => "");
  const hookDocument = await readJsonObject(codexHooksPath);
  const hooks = hookDocument.hooks && typeof hookDocument.hooks === "object"
    ? hookDocument.hooks as Record<string, unknown>
    : {};
  const metadata = await readJsonObject(metadataPath) as {
    hooksExisted?: boolean;
    events?: Record<string, { existed?: boolean; value?: unknown }>;
    config?: ReturnType<typeof snapshotCodexHooksFeature>;
  };
  restoreNamedHookEntries(hooks, metadata.events, codexHookEvents(), "/v1/hooks/codex/");
  if (metadata.hooksExisted || Object.keys(hooks).length > 0) hookDocument.hooks = hooks;
  else delete hookDocument.hooks;
  const nextConfig = disableCodexHooksIfNoManagedHooks(
    removeCodexOpenLeashHookTrust(disableCodexApprovalHandoff(config)),
    hookDocument,
  );
  if (configExists) await fs.writeFile(
    codexConfigPath,
    metadata.config ? restoreCodexHooksFeature(
      removeCodexOpenLeashHookTrust(disableCodexApprovalHandoff(config)),
      metadata.config,
    ) : nextConfig,
  );
  if (Object.keys(hookDocument).length > 0)
    await fs.writeFile(codexHooksPath, `${JSON.stringify(hookDocument, null, 2)}\n`);
  else await fs.rm(codexHooksPath, { force: true });
  await fs.rm(metadataPath, { force: true });
}

function codexHookEvents() {
  return ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"];
}

export async function installCopilotHooks() {
  await fs.mkdir(path.dirname(copilotOpenLeashHooksPath), { recursive: true });
  await fs.writeFile(copilotOpenLeashHooksPath, `${JSON.stringify(await copilotHooksConfig(), null, 2)}\n`);
}

export async function uninstallCopilotHooks() {
  await fs.rm(copilotOpenLeashHooksPath, { force: true });
}

export async function installGeminiHooks() {
  await fs.mkdir(path.dirname(geminiSettingsPath), { recursive: true });
  const existing = await readJsonObject(geminiSettingsPath);
  const hooks = existing.hooks && typeof existing.hooks === "object" ? existing.hooks as Record<string, unknown> : {};
  const metadata = openLeashMetadata(existing);
  metadata.gemini = {
    installedAt: new Date().toISOString(),
    hooks: snapshotNamedHookEntries(hooks, ["BeforeAgent", "BeforeTool", "AfterTool", "AfterAgent"])
  };
  existing.__openleash = metadata;
  existing.hooks = {
    ...hooks,
    BeforeAgent: [await geminiHookGroup("UserPromptSubmit")],
    BeforeTool: [await geminiHookGroup("PreToolUse", ".*")],
    AfterTool: [await geminiHookGroup("PostToolUse", ".*")],
    AfterAgent: [await geminiHookGroup("Stop")]
  };
  await fs.writeFile(geminiSettingsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

export async function uninstallGeminiHooks() {
  if (!(await fileExists(geminiSettingsPath))) return;
  const existing = await readJsonObject(geminiSettingsPath);
  const metadata = openLeashMetadata(existing);
  const hooks = existing.hooks && typeof existing.hooks === "object" ? existing.hooks as Record<string, unknown> : {};
  restoreNamedHookEntries(hooks, metadata.gemini?.hooks, ["BeforeAgent", "BeforeTool", "AfterTool", "AfterAgent"], "/v1/hooks/gemini/");
  existing.hooks = hooks;
  delete metadata.gemini;
  if (Object.keys(metadata).length > 0) existing.__openleash = metadata;
  else delete existing.__openleash;
  await fs.writeFile(geminiSettingsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

export async function installCursorHooks() {
  await fs.mkdir(path.dirname(cursorHooksPath), { recursive: true });
  const existing = await readJsonObject(cursorHooksPath);
  const metadata = openLeashMetadata(existing);
  const hookKeys = cursorHookKeys();
  metadata.cursor = {
    installedAt: new Date().toISOString(),
    hooks: snapshotNamedHookEntries(existing, hookKeys)
  };
  existing.__openleash = metadata;
  existing.beforeSubmitPrompt = [await cursorHook("UserPromptSubmit")];
  existing.beforeShellExecution = [await cursorHook("PreToolUse")];
  existing.beforeReadFile = [await cursorHook("PreToolUse")];
  existing.afterFileEdit = [await cursorHook("PostToolUse")];
  existing.afterAgentResponse = [await cursorHook("PostToolUse")];
  existing.beforeMCPExecution = [await cursorHook("PreToolUse")];
  existing.afterMCPExecution = [await cursorHook("PostToolUse")];
  existing.stop = [await cursorHook("Stop")];
  await fs.writeFile(cursorHooksPath, `${JSON.stringify(existing, null, 2)}\n`);
}

export async function uninstallCursorHooks() {
  if (!(await fileExists(cursorHooksPath))) return;
  const existing = await readJsonObject(cursorHooksPath);
  const metadata = openLeashMetadata(existing);
  restoreNamedHookEntries(existing, metadata.cursor?.hooks, cursorHookKeys(), "/v1/hooks/cursor/");
  delete metadata.cursor;
  if (Object.keys(metadata).length > 0) existing.__openleash = metadata;
  else delete existing.__openleash;
  await fs.writeFile(cursorHooksPath, `${JSON.stringify(existing, null, 2)}\n`);
}

export async function installOpenCodeHooks() {
  await fs.mkdir(path.dirname(openCodePluginPath), { recursive: true });
  await fs.writeFile(openCodePluginPath, await openCodePluginSource());
}

export async function uninstallOpenCodeHooks() {
  await fs.rm(openCodePluginPath, { force: true });
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function fileExists(file: string) {
  return fs.access(file).then(() => true, () => false);
}

function openLeashMetadata(settings: Record<string, unknown>) {
  const existing = settings.__openleash;
  return existing && typeof existing === "object" ? existing as Record<string, any> : {};
}

function snapshotHookEntries(hooks: Record<string, unknown>) {
  return Object.fromEntries(["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].map((event) => [event, {
    existed: Object.prototype.hasOwnProperty.call(hooks, event),
    value: hooks[event]
  }]));
}

function restoreHookEntries(
  hooks: Record<string, unknown>,
  backup: Record<string, { existed?: boolean; value?: unknown }> | undefined,
  managedNeedle: string,
) {
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    const item = backup?.[event];
    if (item?.existed) hooks[event] = item.value;
    else if (JSON.stringify(hooks[event] ?? {}).includes(managedNeedle)) delete hooks[event];
  }
}

function snapshotNamedHookEntries(hooks: Record<string, unknown>, events: string[]) {
  return Object.fromEntries(events.map((event) => [event, {
    existed: Object.prototype.hasOwnProperty.call(hooks, event),
    value: hooks[event]
  }]));
}

function restoreNamedHookEntries(
  hooks: Record<string, unknown>,
  backup: Record<string, { existed?: boolean; value?: unknown }> | undefined,
  events: string[],
  managedNeedle: string
) {
  for (const event of events) {
    const item = backup?.[event];
    if (item?.existed) hooks[event] = item.value;
    else if (JSON.stringify(hooks[event] ?? {}).includes(managedNeedle)) delete hooks[event];
  }
}

function snapshotClaudePermissions(settings: Record<string, unknown>) {
  const permissions = settings.permissions && typeof settings.permissions === "object" ? settings.permissions as Record<string, unknown> : undefined;
  return {
    permissionsExisted: Boolean(permissions),
    defaultModeExisted: Boolean(permissions && Object.prototype.hasOwnProperty.call(permissions, "defaultMode")),
    defaultMode: permissions?.defaultMode,
    skipPromptExisted: Object.prototype.hasOwnProperty.call(settings, "skipDangerousModePermissionPrompt"),
    skipPrompt: settings.skipDangerousModePermissionPrompt
  };
}

function enableClaudeCompatibleApprovalHandoff(settings: Record<string, unknown>) {
  const permissions = settings.permissions && typeof settings.permissions === "object" ? settings.permissions as Record<string, unknown> : {};
  permissions.defaultMode = "bypassPermissions";
  settings.permissions = permissions;
  settings.skipDangerousModePermissionPrompt = true;
}

function restoreClaudePermissions(settings: Record<string, unknown>, backup?: ReturnType<typeof snapshotClaudePermissions>) {
  if (!backup) return;
  const permissions = settings.permissions && typeof settings.permissions === "object" ? settings.permissions as Record<string, unknown> : {};
  if (backup.defaultModeExisted) permissions.defaultMode = backup.defaultMode;
  else delete permissions.defaultMode;
  if (backup.permissionsExisted || Object.keys(permissions).length > 0) settings.permissions = permissions;
  else delete settings.permissions;
  if (backup.skipPromptExisted) settings.skipDangerousModePermissionPrompt = backup.skipPrompt;
  else delete settings.skipDangerousModePermissionPrompt;
}

function removeManagedClaudePermissions(settings: Record<string, unknown>) {
  const permissions = settings.permissions && typeof settings.permissions === "object"
    ? settings.permissions as Record<string, unknown>
    : undefined;
  if (permissions?.defaultMode === "bypassPermissions") delete permissions.defaultMode;
  if (permissions && Object.keys(permissions).length === 0) delete settings.permissions;
  if (settings.skipDangerousModePermissionPrompt === true) delete settings.skipDangerousModePermissionPrompt;
}

async function codexHookGroup(event: HookEventName) {
  return {
    hooks: [{ type: "command", command: await hookCommand("codex", event), timeout: HOOK_TIMEOUT_SECONDS }]
  };
}

async function geminiHookGroup(event: HookEventName, matcher?: string) {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command: await hookCommand("gemini", event), name: "Leash", timeout: HOOK_TIMEOUT_MS }]
  };
}

async function cursorHook(event: HookEventName) {
  return { command: await hookCommand("cursor", event), name: "Leash", timeout: HOOK_TIMEOUT_MS };
}

async function copilotHooksConfig() {
  return {
    version: 1,
    hooks: {
      SessionStart: [await copilotCommandHook("SessionStart")],
      UserPromptSubmit: [await copilotCommandHook("UserPromptSubmit")],
      PreToolUse: [await copilotCommandHook("PreToolUse", "*")],
      PostToolUse: [await copilotCommandHook("PostToolUse", "*")],
      Stop: [await copilotCommandHook("Stop")]
    }
  };
}

async function copilotCommandHook(event: HookEventName, matcher?: string) {
  return {
    type: "command",
    ...(matcher ? { matcher } : {}),
    command: await hookCommand("copilot", event),
    timeoutSec: HOOK_TIMEOUT_SECONDS
  };
}

function cursorHookKeys() {
  return [
    "beforeSubmitPrompt",
    "beforeShellExecution",
    "beforeReadFile",
    "afterFileEdit",
    "afterAgentResponse",
    "beforeMCPExecution",
    "afterMCPExecution",
    "stop"
  ];
}

async function openCodePluginSource() {
  const config = await readConfig();
  const preToolUrl = await hookEndpoint("opencode", "PreToolUse");
  const postToolUrl = await hookEndpoint("opencode", "PostToolUse");
  const stopUrl = await hookEndpoint("opencode", "Stop");
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${config.token}`,
    ...apiVersionHeaders("localHookEvaluate")
  };
  return `const headers = ${JSON.stringify(headers, null, 2)};

async function evaluate(url, payload) {
  const body = JSON.stringify({
    ...payload,
    cwd: payload.cwd || process.cwd(),
    session_id: payload.session_id || payload.sessionID || payload.session?.id
  });
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(${HOOK_TIMEOUT_MS})
    });
  } catch (error) {
    const code = error?.cause?.code || error?.code;
    const transportUnavailable = ["AbortError", "TimeoutError"].includes(error?.name)
      || [
        "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOENT", "ENETUNREACH",
        "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"
      ].includes(code);
    if (${availabilityFailOpen(config)} && transportUnavailable) return;
    throw error;
  }
  if (!response.ok)
    throw new Error(\`Leash desktop edge rejected this action (HTTP \${response.status}).\`);
  const decision = await response.json().catch(() => ({}));
  if (decision.decision === "deny" || decision.decision === "block") {
    throw new Error(decision.reason || "Leash denied this action.");
  }
}

export const OpenLeash = async () => ({
  "tool.execute.before": async (input, output) => {
    await evaluate(${JSON.stringify(preToolUrl)}, {
      tool_name: input?.tool,
      tool_input: output?.args || input?.args || input,
      session_id: input?.sessionID || input?.session?.id,
      cwd: input?.cwd
    });
  },
  "tool.execute.after": async (input, output) => {
    await evaluate(${JSON.stringify(postToolUrl)}, {
      tool_name: input?.tool,
      tool_input: input?.args,
      tool_response: output,
      session_id: input?.sessionID || input?.session?.id,
      cwd: input?.cwd
    });
  },
  "session.idle": async (input) => {
    await evaluate(${JSON.stringify(stopUrl)}, {
      session_id: input?.sessionID || input?.session?.id,
      prompt_response: input?.message || input?.summary
    });
  }
});
`;
}

async function hookEndpoint(agent: HookAgent, event: HookEventName) {
  const config = await readConfig();
  const endpoint = new URL(`/v1/hooks/${agent}/${event}`, hookApiUrl(config));
  endpoint.searchParams.set("hostname", config.computer?.hostname ?? os.hostname());
  endpoint.searchParams.set("platform", os.platform());
  endpoint.searchParams.set("os_release", os.release());
  if (config.clientVersion) endpoint.searchParams.set("client_version", config.clientVersion);
  return endpoint.toString();
}

function openClawHookMetadata() {
  return `---
name: openleash
description: "Leash local approval checks for OpenClaw messages and commands"
metadata:
  { "openclaw": { "emoji": "", "events": ["message:received", "message:preprocessed", "command:new", "command"], "requires": { "bins": ["node"] } } }
---

# OpenLeash

Runs OpenLeash local approval checks before risky OpenClaw messages or commands continue.
`;
}

async function openClawHandlerSource() {
  const { config, args: curlArgs } = await localHookCurlArgs("openclaw", "UserPromptSubmit");
  const failOpen = availabilityFailOpen(config);
  return `import { spawnSync } from "node:child_process";

const handler = async (event) => {
  const payload = {
    ...event,
    prompt: event?.context?.bodyForAgent ?? event?.context?.content ?? event?.context?.sessionEntry?.content,
    cwd: event?.context?.workspaceDir
  };
  const result = spawnSync("curl", ${JSON.stringify(curlArgs)}, {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: HOOK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    event?.messages?.push?.("Leash could not evaluate this action.");
    const availabilityFailure = [7, 28].includes(result.status) || result.error?.code === "ETIMEDOUT";
    if (!(${failOpen} && availabilityFailure)) event.cancel = true;
    return;
  }
  try {
    const decision = JSON.parse(result.stdout || "{}");
    if (decision.decision === "block" || decision.decision === "deny") {
      event?.messages?.push?.(decision.reason || "Leash denied this action.");
      event.cancel = true;
    }
  } catch {
    if (result.stdout) event?.messages?.push?.(result.stdout);
    event.cancel = true;
  }
};

export default handler;
`;
}

function isLocalPersonalApi(apiUrl: string) {
  return /^https?:\/\/(127\.0\.0\.1|localhost):9317(?:\/|$)/i.test(apiUrl);
}

const codexHandoffStart = "# >>> OpenLeash approval handoff";
const codexHandoffEnd = "# <<< OpenLeash approval handoff";

function enableCodexApprovalHandoff(config: string) {
  const clean = stripCodexHandoff(config);
  const previousApproval = topLevelTomlValue(clean, "approval_policy");
  const previousSandbox = topLevelTomlValue(clean, "sandbox_mode");
  const withoutManagedKeys = clean
    .replace(/^\s*approval_policy\s*=\s*"[^"]*"\s*$/m, "")
    .replace(/^\s*sandbox_mode\s*=\s*"[^"]*"\s*$/m, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
  const block = [
    codexHandoffStart,
    `# previous_approval_policy=${JSON.stringify(previousApproval)}`,
    `# previous_sandbox_mode=${JSON.stringify(previousSandbox)}`,
    `approval_policy = "never"`,
    `sandbox_mode = "danger-full-access"`,
    codexHandoffEnd,
    ""
  ].join("\n");
  return `${block}${withoutManagedKeys}`;
}

function disableCodexApprovalHandoff(config: string) {
  const match = config.match(new RegExp(`${escapeRegExp(codexHandoffStart)}[\\s\\S]*?${escapeRegExp(codexHandoffEnd)}\\n?`));
  if (!match) return config;
  const previousApproval = match[0].match(/previous_approval_policy=(.*)/)?.[1];
  const previousSandbox = match[0].match(/previous_sandbox_mode=(.*)/)?.[1];
  const restored: string[] = [];
  const approval = previousApproval ? parseCommentJson(previousApproval) : undefined;
  const sandbox = previousSandbox ? parseCommentJson(previousSandbox) : undefined;
  if (typeof approval === "string") restored.push(`approval_policy = ${JSON.stringify(approval)}`);
  if (typeof sandbox === "string") restored.push(`sandbox_mode = ${JSON.stringify(sandbox)}`);
  const clean = config.replace(match[0], "").trimStart();
  return `${restored.length ? `${restored.join("\n")}\n` : ""}${clean}`;
}

function removeCodexOpenLeashHookTrust(config: string) {
  const hookPath = path.resolve(codexHooksPath);
  const escapedHookPath = escapeRegExp(hookPath);
  const withoutHookTables = config.replace(
    new RegExp(`\\n?\\[hooks\\.state\\."${escapedHookPath}:[^"]+"\\]\\ntrusted_hash\\s*=\\s*"[^"]*"\\n?`, "g"),
    "\n"
  );
  return withoutHookTables.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function disableCodexHooksIfNoManagedHooks(config: string, hooks: Record<string, unknown>) {
  const hookText = JSON.stringify(hooks.hooks ?? {});
  const hasHookEntries = hookText !== "{}" && hookText !== "[]";
  if (hasHookEntries && !hookText.includes("/v1/hooks/codex/")) return config;
  const withoutEmptyState = config.replace(/\n?\[hooks\.state\]\s*(?=\n\s*\[|$)/g, "\n");
  if (!/^\s*\[features\]\s*$/m.test(withoutEmptyState)) return withoutEmptyState;
  return withoutEmptyState
    .replace(/(^\s*\[features\]\s*\n(?:[^\[]*\n)*?)^\s*hooks\s*=\s*true\s*$/m, (_match, prefix: string) => `${prefix}hooks = false`)
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

function snapshotCodexHooksFeature(config: string) {
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line));
  if (start < 0) return { featuresExisted: false, hooksExisted: false };
  const endOffset = lines.slice(start + 1).findIndex((line) => /^\s*\[/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  const hooks = lines.slice(start + 1, end).find((line) => /^\s*hooks\s*=\s*(?:true|false)\s*$/.test(line));
  return {
    featuresExisted: true,
    hooksExisted: Boolean(hooks),
    hooksValue: hooks?.match(/=\s*(true|false)/)?.[1],
  };
}

function restoreCodexHooksFeature(
  config: string,
  snapshot: ReturnType<typeof snapshotCodexHooksFeature>,
) {
  let restored = config;
  if (snapshot.hooksExisted) {
    restored = restored.replace(
      /(^\s*\[features\]\s*\n(?:[^\[]*\n)*?)^\s*hooks\s*=\s*(?:true|false)\s*$/m,
      (_match, prefix: string) => `${prefix}hooks = ${snapshot.hooksValue}`,
    );
  } else {
    restored = restored.replace(
      /(^\s*\[features\]\s*\n(?:[^\[]*\n)*?)^\s*hooks\s*=\s*(?:true|false)\s*\n?/m,
      "$1",
    );
  }
  if (!snapshot.featuresExisted)
    restored = restored.replace(/\n?^\s*\[features\]\s*\n(?=\s*(?:\[|$))/m, "\n");
  return restored.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function stripCodexHandoff(config: string) {
  return config.replace(new RegExp(`${escapeRegExp(codexHandoffStart)}[\\s\\S]*?${escapeRegExp(codexHandoffEnd)}\\n?`, "g"), "");
}

function topLevelTomlValue(config: string, key: string) {
  const beforeFirstTable = config.split(/\n\s*\[/, 1)[0] ?? "";
  return beforeFirstTable.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*$`, "m"))?.[1];
}

function parseCommentJson(value: string) {
  try {
    return JSON.parse(value.trim());
  } catch {
    return undefined;
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function trustCodexHooks() {
  const hooks = probeCodexHooks("0.1.0").filter(
    (
      hook,
    ): hook is typeof hook & {
      key: string;
      sourcePath: string;
      currentHash: string;
    } => isHookMetadata(hook),
  );

  const installed = hooks.filter((hook) => path.resolve(hook.sourcePath) === path.resolve(codexHooksPath));
  if (installed.length === 0) return;

  let config = await fs.readFile(codexConfigPath, "utf8").catch(() => "");
  for (const hook of installed) {
    const table = `[hooks.state.${JSON.stringify(hook.key)}]`;
    config = config.replace(new RegExp(`\\n?\\[hooks\\.state\\.${escapeRegExp(JSON.stringify(hook.key))}\\]\\ntrusted_hash\\s*=\\s*"[^"]*"\\n?`, "g"), "\n");
    config += `${config.endsWith("\n") || config.length === 0 ? "" : "\n"}${table}\ntrusted_hash = "${hook.currentHash}"\n`;
  }
  await fs.writeFile(codexConfigPath, config);
}

function isHookMetadata(value: unknown): value is { key: string; sourcePath: string; currentHash: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { key?: unknown }).key === "string" &&
    typeof (value as { sourcePath?: unknown }).sourcePath === "string" &&
    typeof (value as { currentHash?: unknown }).currentHash === "string"
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
