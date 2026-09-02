import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enableCodexHooksFeature,
  probeCodexHooks,
} from "./codex-config.js";

export type LocalAgentProtection = {
  kind: string;
  displayName: string;
  installed: boolean;
  protected: boolean;
  detail: string;
  executablePath?: string;
  icon?: string;
  supportsInstall: boolean;
  approvalHandoff?: boolean;
};

export type AgentProtectionWatchTarget = {
  kind: string;
  displayName: string;
  paths: string[];
};

type DetectionContext = {
  appVersion: string;
};

type InstallContext = {
  apiUrl: string;
  token: string;
  clientVersion: string;
  apiFunction?: string;
  apiVersion?: string;
  availabilityFailOpen?: boolean;
};

type AgentDefinition = {
  kind: string;
  displayName: string;
  icon?: string;
  detect: (context: DetectionContext) => LocalAgentProtection;
  install?: (context: InstallContext) => Promise<void> | void;
  uninstall?: () => Promise<void> | void;
};

const genericAgents = [
  {
    kind: "gemini",
    displayName: "Google Gemini CLI",
    icon: "gemini",
    binaries: ["gemini"],
    configPaths: [".gemini"],
    install: installGeminiProtection,
    uninstall: uninstallGeminiProtection,
    protected: detectGeminiProtected,
  },
  {
    kind: "cline",
    displayName: "Cline",
    icon: "cline",
    extensionNeedles: ["cline", "claude-dev", "saoudrizwan"],
  },
  {
    kind: "opencode",
    displayName: "OpenCode",
    icon: "opencode",
    binaries: ["opencode"],
    configPaths: [".config/opencode"],
    install: installOpenCodeProtection,
    uninstall: uninstallOpenCodeProtection,
    protected: detectOpenCodeProtected,
  },
  {
    kind: "continue",
    displayName: "Continue",
    icon: "continue",
    extensionNeedles: ["continue"],
  },
  {
    kind: "cursor",
    displayName: "Cursor",
    icon: "cursor",
    appPaths: ["/Applications/Cursor.app"],
    install: installCursorProtection,
    uninstall: uninstallCursorProtection,
    protected: detectCursorProtected,
  },
  {
    kind: "github-copilot",
    displayName: "GitHub Copilot",
    icon: "copilot",
    binaries: ["copilot"],
    configPaths: [".copilot"],
    install: installCopilotProtection,
    uninstall: uninstallCopilotProtection,
    protected: detectCopilotProtected,
  },
  {
    kind: "windsurf",
    displayName: "Windsurf",
    icon: "windsurf",
    appPaths: ["/Applications/Windsurf.app"],
  },
] satisfies Array<{
  kind: string;
  displayName: string;
  icon: string;
  binaries?: string[];
  configPaths?: string[];
  appPaths?: string[];
  extensionNeedles?: string[];
  install?: (context: InstallContext) => Promise<void> | void;
  uninstall?: () => Promise<void> | void;
  protected?: () => boolean;
}>;

const agentDefinitions: AgentDefinition[] = [
  {
    kind: "claude-code",
    displayName: "Claude Code",
    icon: "claude",
    detect: detectClaudeProtection,
    install: installClaudeProtection,
    uninstall: uninstallClaudeProtection,
  },
  {
    kind: "openclaw",
    displayName: "OpenClaw",
    detect: detectOpenClawProtection,
    install: installOpenClawProtection,
    uninstall: uninstallOpenClawProtection,
  },
  {
    kind: "nanoclaw",
    displayName: "NanoClaw",
    detect: detectNanoClawProtection,
    install: installNanoClawProtection,
    uninstall: uninstallNanoClawProtection,
  },
  {
    kind: "codex",
    displayName: "OpenAI Codex",
    icon: "openai",
    detect: detectCodexProtection,
    install: installCodexProtection,
    uninstall: uninstallCodexProtection,
  },
  ...genericAgents.map(genericAgentDefinition),
];

export function detectLocalAgentProtections(context: DetectionContext) {
  return agentDefinitions
    .map((definition) => definition.detect(context))
    .filter((agent) => agent.installed)
    .sort(compareLocalAgentProtection);
}

export async function installAgentProtection(
  kind: string,
  context: InstallContext,
) {
  const definition = agentDefinitions.find((agent) => agent.kind === kind);
  if (!definition?.install) return false;
  // Never preserve an older OpenLeash hook as the user's original config.
  // Reinstalls always remove our previous integration before writing a fresh
  // endpoint and token.
  await definition.uninstall?.();
  await definition.install(context);
  return true;
}

export async function uninstallAgentProtection(kind: string) {
  const definition = agentDefinitions.find((agent) => agent.kind === kind);
  if (!definition?.uninstall) return false;
  await definition.uninstall();
  return true;
}

export async function uninstallAllAgentProtections() {
  const failures: string[] = [];
  for (const definition of agentDefinitions) {
    if (!definition.uninstall) continue;
    try {
      await definition.uninstall();
    } catch (error) {
      failures.push(
        `${definition.displayName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length > 0)
    throw new Error(`Could not remove every agent integration. ${failures.join("; ")}`);
}

export function protectionWatchTargets() {
  const home = os.homedir();
  return [
    {
      kind: "claude-code",
      displayName: "Claude Code",
      paths: [path.join(home, ".claude", "settings.json")],
    },
    {
      kind: "nanoclaw",
      displayName: "NanoClaw",
      paths: [path.join(home, ".nanoclaw", "settings.json")],
    },
    {
      kind: "codex",
      displayName: "OpenAI Codex",
      paths: [
        path.join(home, ".codex", "config.toml"),
        path.join(home, ".codex", "hooks.json"),
      ],
    },
    {
      kind: "gemini",
      displayName: "Google Gemini CLI",
      paths: [path.join(home, ".gemini", "settings.json")],
    },
    {
      kind: "opencode",
      displayName: "OpenCode",
      paths: [
        path.join(home, ".config", "opencode", "plugins", "openleash.js"),
      ],
    },
    {
      kind: "cursor",
      displayName: "Cursor",
      paths: [path.join(home, ".cursor", "hooks.json")],
    },
    {
      kind: "github-copilot",
      displayName: "GitHub Copilot",
      paths: [copilotOpenLeashHooksPath()],
    },
    {
      kind: "openclaw",
      displayName: "OpenClaw",
      paths: [
        path.join(home, ".openclaw", "hooks", "openleash", "HOOK.md"),
        path.join(home, ".openclaw", "hooks", "openleash", "handler.ts"),
      ],
    },
  ] satisfies AgentProtectionWatchTarget[];
}

export function agentIconFor(name: string) {
  const text = name.toLowerCase();
  const base = "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons";
  if (text.includes("claude")) return `${base}/claude.svg`;
  if (text.includes("github copilot")) return `${base}/githubcopilot.svg`;
  if (text.includes("salesforce") || text.includes("agentforce"))
    return `${base}/salesforce.svg`;
  if (text.includes("azure") || text.includes("foundry"))
    return `${base}/microsoftazure.svg`;
  if (text.includes("copilot") || text.includes("agent 365"))
    return `${base}/microsoftcopilot.svg`;
  if (
    text.includes("bedrock") ||
    text.includes("agentcore") ||
    text.includes("aws")
  )
    return `${base}/amazonaws.svg`;
  if (text.includes("vertex") || text.includes("gemini enterprise"))
    return `${base}/googlecloud.svg`;
  if (text.includes("n8n")) return `${base}/n8n.svg`;
  if (text.includes("zapier")) return `${base}/zapier.svg`;
  if (text.includes("openclaw") || text.includes("nanoclaw"))
    return `${base}/anthropic.svg`;
  if (text.includes("codex") || text.includes("openai"))
    return `${base}/openai.svg`;
  if (text.includes("cursor")) return `${base}/cursor.svg`;
  if (text.includes("gemini")) return `${base}/googlegemini.svg`;
  if (text.includes("windsurf")) return `${base}/windsurf.svg`;
  if (text.includes("cline")) return `${base}/cline.svg`;
  if (text.includes("opencode")) return `${base}/opencode.svg`;
  return undefined;
}

const canonicalAgentOrder = [
  "claude-code",
  "github-copilot",
  "gemini",
  "opencode",
  "codex",
  "cline",
  "cursor",
  "windsurf",
];

function compareLocalAgentProtection(
  left: LocalAgentProtection,
  right: LocalAgentProtection,
) {
  const leftIndex = canonicalAgentOrder.indexOf(left.kind);
  const rightIndex = canonicalAgentOrder.indexOf(right.kind);
  const normalizedLeft = leftIndex < 0 ? canonicalAgentOrder.length : leftIndex;
  const normalizedRight =
    rightIndex < 0 ? canonicalAgentOrder.length : rightIndex;
  if (normalizedLeft !== normalizedRight)
    return normalizedLeft - normalizedRight;
  return left.displayName.localeCompare(right.displayName);
}

function genericAgentDefinition(
  agent: (typeof genericAgents)[number],
): AgentDefinition {
  return {
    kind: agent.kind,
    displayName: agent.displayName,
    icon: agent.icon,
    detect: () => detectGenericAgent(agent),
    install: agent.install,
    uninstall: agent.uninstall,
  };
}

function detectClaudeProtection(): LocalAgentProtection {
  const executablePath = findOnPath("claude");
  const configDir = path.join(os.homedir(), ".claude");
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const installed =
    Boolean(executablePath) ||
    pathExists(configDir) ||
    fs.existsSync(settingsPath) ||
    extensionInstalled(["anthropic.claude-code"]);
  const settings = readJson(settingsPath);
  const hookText = JSON.stringify(
    (settings as { hooks?: unknown } | undefined)?.hooks ?? {},
  );
  const approvalHandoff = hasClaudeCompatibleApprovalHandoff(settings);
  const protectedEvents = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
  ].filter(
    (event) =>
      hookText.includes(event) &&
      (hookText.includes("hook --agent claude") ||
        hookText.includes(`/v1/hooks/claude/${event}`)),
  );
  return agentStatus({
    kind: "claude-code",
    displayName: "Claude Code",
    installed,
    protected: protectedEvents.length >= 2,
    executablePath,
    icon: "claude",
    supportsInstall: true,
    approvalHandoff,
    detail: installed
      ? protectedEvents.length >= 2
        ? "Active"
        : "Unmonitored"
      : "Not installed",
  });
}

function detectOpenClawProtection(): LocalAgentProtection {
  const executablePath = findOnPath("openclaw");
  const configPath = path.join(os.homedir(), ".openclaw", "config.json");
  const hookDir = path.join(os.homedir(), ".openclaw", "hooks", "openleash");
  const hookMetadataPath = path.join(hookDir, "HOOK.md");
  const handlerPath = path.join(hookDir, "handler.ts");
  const installed =
    Boolean(executablePath) || pathExists(configPath) || pathExists(hookDir);
  const handler = readText(handlerPath);
  const protectedByOpenLeash =
    pathExists(hookMetadataPath) &&
    handler.includes("/v1/hooks/openclaw/UserPromptSubmit");
  return agentStatus({
    kind: "openclaw",
    displayName: "OpenClaw",
    installed,
    protected: protectedByOpenLeash,
    executablePath,
    supportsInstall: true,
    detail: installed
      ? protectedByOpenLeash
        ? "Active"
        : "Unmonitored"
      : "Not installed",
  });
}

function detectNanoClawProtection(): LocalAgentProtection {
  const executablePath = findOnPath("nanoclaw");
  const settingsPath = path.join(os.homedir(), ".nanoclaw", "settings.json");
  const installed =
    Boolean(executablePath) ||
    pathExists(settingsPath) ||
    pathExists("/Applications/NanoClaw.app");
  const settings = readJson(settingsPath);
  const hookText = JSON.stringify(
    (settings as { hooks?: unknown } | undefined)?.hooks ?? {},
  );
  const approvalHandoff = hasClaudeCompatibleApprovalHandoff(settings);
  const protectedEvents = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
  ].filter(
    (event) =>
      hookText.includes(event) &&
      (hookText.includes("hook --agent nanoclaw") ||
        hookText.includes(`/v1/hooks/nanoclaw/${event}`)),
  );
  return agentStatus({
    kind: "nanoclaw",
    displayName: "NanoClaw",
    installed,
    protected: protectedEvents.length >= 2,
    executablePath,
    supportsInstall: true,
    approvalHandoff,
    detail: installed
      ? protectedEvents.length >= 2
        ? "Active"
        : "Unmonitored"
      : "Not installed",
  });
}

function detectCodexProtection(
  context: DetectionContext,
): LocalAgentProtection {
  const executablePath = findOnPath("codex");
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  const hooksPath = path.join(os.homedir(), ".codex", "hooks.json");
  // The official VS Code extension is published as openai.chatgpt and shares
  // ~/.codex with the CLI, so it must be treated as the same agent surface.
  const installed =
    Boolean(executablePath) ||
    fs.existsSync(configPath) ||
    extensionInstalled(["openai.chatgpt"]);
  const hooks = codexHooksStatus(context.appVersion);
  const allTrusted =
    hooks.length >= 4 &&
    ["preToolUse", "postToolUse", "userPromptSubmit", "stop"].every((event) =>
      hooks.some(
        (hook) => hook.eventName === event && hook.trustStatus === "trusted",
      ),
    );
  const hooksFileLooksInstalled = JSON.stringify(
    readJson(hooksPath) ?? {},
  ).includes("hook --agent codex");
  const config = readText(configPath);
  const protectedByProxy = hasManagedCodexProxy(config);
  const protectedByOpenLeash = allTrusted || protectedByProxy;
  const approvalHandoff = codexApprovalHandoff(config);
  return agentStatus({
    kind: "codex",
    displayName: "OpenAI Codex",
    installed,
    protected: protectedByOpenLeash,
    executablePath,
    icon: "openai",
    supportsInstall: true,
    approvalHandoff,
    detail: installed
      ? protectedByOpenLeash
        ? protectedByProxy && !allTrusted
          ? "Active via local proxy"
          : "Active"
        : hooksFileLooksInstalled
          ? "Needs confirmation in Codex"
          : "Unmonitored"
      : "Not installed",
  });
}

export function hasManagedCodexProxy(config: string) {
  return /^\s*# Managed by OpenLeash local proxy\s*$/m.test(config) &&
    /^\s*model_provider\s*=\s*"openleash"\s*$/m.test(config) &&
    /^\s*base_url\s*=\s*"https?:\/\/(?:127\.0\.0\.1|localhost):9320\/agent\/codex\/v1\/?"\s*$/m.test(config);
}

function detectGenericAgent(
  agent: (typeof genericAgents)[number],
): LocalAgentProtection {
  const executablePath = agent.binaries?.map(findOnPath).find(Boolean);
  const installed =
    Boolean(executablePath) ||
    Boolean(
      agent.configPaths?.some((configPath) =>
        pathExists(path.join(os.homedir(), configPath)),
      ),
    ) ||
    Boolean(agent.appPaths?.some(pathExists)) ||
    Boolean(
      agent.extensionNeedles && extensionInstalled(agent.extensionNeedles),
    );
  const protectedByOpenLeash = Boolean(agent.protected?.());
  const supportsInstall = Boolean(agent.install && agent.uninstall);
  return agentStatus({
    kind: agent.kind,
    displayName: agent.displayName,
    installed,
    protected: protectedByOpenLeash,
    detail: installed
      ? protectedByOpenLeash
        ? "Active"
        : supportsInstall
          ? "Unmonitored"
          : "Support coming soon"
      : "Not installed",
    executablePath,
    icon: agent.icon,
    supportsInstall,
  });
}

function agentStatus(status: LocalAgentProtection): LocalAgentProtection {
  return status;
}

function installClaudeProtection(context: InstallContext) {
  installClaudeCompatibleProtection(
    path.join(os.homedir(), ".claude", "settings.json"),
    "claude",
    context,
  );
}

function uninstallClaudeProtection() {
  uninstallClaudeCompatibleProtection(
    path.join(os.homedir(), ".claude", "settings.json"),
    "claude",
  );
}

function installNanoClawProtection(context: InstallContext) {
  installClaudeCompatibleProtection(
    path.join(os.homedir(), ".nanoclaw", "settings.json"),
    "nanoclaw",
    context,
  );
}

function uninstallNanoClawProtection() {
  uninstallClaudeCompatibleProtection(
    path.join(os.homedir(), ".nanoclaw", "settings.json"),
    "nanoclaw",
  );
}

function installClaudeCompatibleProtection(
  settingsPath: string,
  agent: "claude" | "nanoclaw",
  context: InstallContext,
) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const existing = (readJson(settingsPath) as Record<string, unknown>) ?? {};
  const hooks =
    existing.hooks && typeof existing.hooks === "object"
      ? (existing.hooks as Record<string, unknown>)
      : {};
  const metadata = openLeashMetadata(existing);
  metadata[agent] = {
    installedAt: new Date().toISOString(),
    hooks: snapshotHookEntries(hooks),
    permissions: snapshotClaudePermissions(existing),
  };
  existing.__openleash = metadata;
  existing.hooks = {
    ...hooks,
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: hookCommand(context, agent, "UserPromptSubmit"),
            timeout: HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: hookCommand(context, agent, "PreToolUse"),
            timeout: HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: hookCommand(context, agent, "PostToolUse"),
            timeout: HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: hookCommand(context, agent, "Stop"),
            timeout: HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ],
  };
  enableClaudeCompatibleApprovalHandoff(existing);
  fs.writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

function uninstallClaudeCompatibleProtection(
  settingsPath: string,
  agent: "claude" | "nanoclaw",
) {
  if (!fs.existsSync(settingsPath)) return;
  const existing = (readJson(settingsPath) as Record<string, unknown>) ?? {};
  const metadata = openLeashMetadata(existing);
  const backup = metadata[agent];
  const hooks =
    existing.hooks && typeof existing.hooks === "object"
      ? (existing.hooks as Record<string, unknown>)
      : {};
  const managedNeedle = `/v1/hooks/${agent}/`;
  const hadManagedHooks = JSON.stringify(hooks).includes(managedNeedle);
  restoreHookEntries(hooks, backup?.hooks, managedNeedle);
  existing.hooks = hooks;
  if (backup?.permissions) restoreClaudePermissions(existing, backup.permissions);
  else if (hadManagedHooks) removeManagedClaudePermissions(existing);
  delete metadata[agent];
  if (Object.keys(metadata).length > 0) existing.__openleash = metadata;
  else delete existing.__openleash;
  fs.writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

function openLeashMetadata(settings: Record<string, unknown>) {
  const existing = settings.__openleash;
  return existing && typeof existing === "object"
    ? (existing as Record<string, any>)
    : {};
}

function snapshotHookEntries(hooks: Record<string, unknown>) {
  return Object.fromEntries(
    ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].map((event) => [
      event,
      {
        existed: Object.prototype.hasOwnProperty.call(hooks, event),
        value: hooks[event],
      },
    ]),
  );
}

function restoreHookEntries(
  hooks: Record<string, unknown>,
  backup?: Record<string, { existed?: boolean; value?: unknown }>,
  managedNeedle = "Leash",
) {
  for (const event of [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
  ]) {
    const item = backup?.[event];
    if (item?.existed) hooks[event] = item.value;
    else if (JSON.stringify(hooks[event] ?? {}).includes(managedNeedle))
      delete hooks[event];
  }
}

function snapshotClaudePermissions(settings: Record<string, unknown>) {
  const permissions =
    settings.permissions && typeof settings.permissions === "object"
      ? (settings.permissions as Record<string, unknown>)
      : undefined;
  return {
    permissionsExisted: Boolean(permissions),
    defaultModeExisted: Boolean(
      permissions &&
      Object.prototype.hasOwnProperty.call(permissions, "defaultMode"),
    ),
    defaultMode: permissions?.defaultMode,
    skipPromptExisted: Object.prototype.hasOwnProperty.call(
      settings,
      "skipDangerousModePermissionPrompt",
    ),
    skipPrompt: settings.skipDangerousModePermissionPrompt,
  };
}

function enableClaudeCompatibleApprovalHandoff(
  settings: Record<string, unknown>,
) {
  const permissions =
    settings.permissions && typeof settings.permissions === "object"
      ? (settings.permissions as Record<string, unknown>)
      : {};
  permissions.defaultMode = "bypassPermissions";
  settings.permissions = permissions;
  settings.skipDangerousModePermissionPrompt = true;
}

function restoreClaudePermissions(
  settings: Record<string, unknown>,
  backup?: ReturnType<typeof snapshotClaudePermissions>,
) {
  if (!backup) return;
  const permissions =
    settings.permissions && typeof settings.permissions === "object"
      ? (settings.permissions as Record<string, unknown>)
      : {};
  if (backup.defaultModeExisted) permissions.defaultMode = backup.defaultMode;
  else delete permissions.defaultMode;
  if (backup.permissionsExisted || Object.keys(permissions).length > 0)
    settings.permissions = permissions;
  else delete settings.permissions;
  if (backup.skipPromptExisted)
    settings.skipDangerousModePermissionPrompt = backup.skipPrompt;
  else delete settings.skipDangerousModePermissionPrompt;
}

function removeManagedClaudePermissions(settings: Record<string, unknown>) {
  const permissions =
    settings.permissions && typeof settings.permissions === "object"
      ? (settings.permissions as Record<string, unknown>)
      : undefined;
  if (permissions?.defaultMode === "bypassPermissions")
    delete permissions.defaultMode;
  if (permissions && Object.keys(permissions).length === 0)
    delete settings.permissions;
  if (settings.skipDangerousModePermissionPrompt === true)
    delete settings.skipDangerousModePermissionPrompt;
}

function hasClaudeCompatibleApprovalHandoff(settings: unknown) {
  if (!settings || typeof settings !== "object") return false;
  const record = settings as {
    permissions?: { defaultMode?: unknown };
    skipDangerousModePermissionPrompt?: unknown;
  };
  return (
    record.permissions?.defaultMode === "bypassPermissions" &&
    record.skipDangerousModePermissionPrompt === true
  );
}

function installOpenClawProtection(context: InstallContext) {
  const hookDir = path.join(os.homedir(), ".openclaw", "hooks", "openleash");
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, "HOOK.md"), openClawHookMetadata());
  fs.writeFileSync(
    path.join(hookDir, "handler.ts"),
    openClawHandlerSource(context),
  );
  spawnSync("openclaw", ["hooks", "enable", "openleash"], { stdio: "ignore" });
}

function uninstallOpenClawProtection() {
  const hookDir = path.join(os.homedir(), ".openclaw", "hooks", "openleash");
  if (!fs.existsSync(hookDir)) return;
  spawnSync("openclaw", ["hooks", "disable", "openleash"], { stdio: "ignore" });
  fs.rmSync(hookDir, { recursive: true, force: true });
}

function installCodexProtection(context: InstallContext) {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  const hooksPath = path.join(os.homedir(), ".codex", "hooks.json");
  const metadataPath = `${hooksPath}.openleash-metadata.json`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const originalConfig = readText(configPath);
  fs.writeFileSync(
    configPath,
    enableCodexHooksFeature(
      enableCodexApprovalHandoff(originalConfig),
    ),
  );
  const existing = (readJson(hooksPath) as Record<string, unknown>) ?? {};
  const hooks = existing.hooks && typeof existing.hooks === "object"
    ? existing.hooks as Record<string, unknown>
    : {};
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify({
      hooksExisted: Object.prototype.hasOwnProperty.call(existing, "hooks"),
      events: snapshotNamedHookEntries(hooks, codexHookEvents()),
      config: snapshotCodexHooksFeature(originalConfig),
    }, null, 2)}\n`,
  );
  existing.hooks = {
    ...hooks,
    PreToolUse: [codexHookGroup(context, "PreToolUse")],
    PostToolUse: [codexHookGroup(context, "PostToolUse")],
    UserPromptSubmit: [codexHookGroup(context, "UserPromptSubmit")],
    Stop: [codexHookGroup(context, "Stop")],
  };
  fs.writeFileSync(hooksPath, `${JSON.stringify(existing, null, 2)}\n`);
  trustCodexHooks(configPath, hooksPath, context.clientVersion);
}

function uninstallCodexProtection() {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  const hooksPath = path.join(os.homedir(), ".codex", "hooks.json");
  const metadataPath = `${hooksPath}.openleash-metadata.json`;
  const configExists = fs.existsSync(configPath);
  const hooksExist = fs.existsSync(hooksPath);
  const metadataExists = fs.existsSync(metadataPath);
  if (!configExists && !hooksExist && !metadataExists) return;
  const hookDocument = (readJson(hooksPath) as Record<string, unknown>) ?? {};
  const hooks = hookDocument.hooks && typeof hookDocument.hooks === "object"
    ? hookDocument.hooks as Record<string, unknown>
    : {};
  const metadata = (readJson(metadataPath) as {
    hooksExisted?: boolean;
    events?: Record<string, { existed?: boolean; value?: unknown }>;
    config?: ReturnType<typeof snapshotCodexHooksFeature>;
  } | undefined);
  restoreNamedHookEntries(
    hooks,
    metadata?.events,
    codexHookEvents(),
    "/v1/hooks/codex/",
  );
  if (metadata?.hooksExisted || Object.keys(hooks).length > 0)
    hookDocument.hooks = hooks;
  else delete hookDocument.hooks;
  const config = removeCodexOpenLeashHookTrust(
    disableCodexApprovalHandoff(readText(configPath)),
    hooksPath,
  );
  if (configExists)
    fs.writeFileSync(
      configPath,
      metadata?.config
        ? restoreCodexHooksFeature(config, metadata.config)
        : disableCodexHooksIfNoManagedHooks(config, hookDocument),
    );
  if (Object.keys(hookDocument).length > 0)
    fs.writeFileSync(hooksPath, `${JSON.stringify(hookDocument, null, 2)}\n`);
  else fs.rmSync(hooksPath, { force: true });
  fs.rmSync(metadataPath, { force: true });
}

function codexHookEvents() {
  return ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"];
}

function installGeminiProtection(context: InstallContext) {
  const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const existing = (readJson(settingsPath) as Record<string, unknown>) ?? {};
  const hooks =
    existing.hooks && typeof existing.hooks === "object"
      ? (existing.hooks as Record<string, unknown>)
      : {};
  const metadata = openLeashMetadata(existing);
  metadata.gemini = {
    installedAt: new Date().toISOString(),
    hooks: snapshotNamedHookEntries(hooks, [
      "BeforeAgent",
      "BeforeTool",
      "AfterTool",
      "AfterAgent",
    ]),
  };
  existing.__openleash = metadata;
  existing.hooks = {
    ...hooks,
    BeforeAgent: [geminiHookGroup(context, "UserPromptSubmit")],
    BeforeTool: [geminiHookGroup(context, "PreToolUse", ".*")],
    AfterTool: [geminiHookGroup(context, "PostToolUse", ".*")],
    AfterAgent: [geminiHookGroup(context, "Stop")],
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

function uninstallGeminiProtection() {
  const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
  if (!fs.existsSync(settingsPath)) return;
  const existing = (readJson(settingsPath) as Record<string, unknown>) ?? {};
  const metadata = openLeashMetadata(existing);
  const backup = metadata.gemini;
  const hooks =
    existing.hooks && typeof existing.hooks === "object"
      ? (existing.hooks as Record<string, unknown>)
      : {};
  restoreNamedHookEntries(
    hooks,
    backup?.hooks,
    ["BeforeAgent", "BeforeTool", "AfterTool", "AfterAgent"],
    "/v1/hooks/gemini/",
  );
  existing.hooks = hooks;
  delete metadata.gemini;
  if (Object.keys(metadata).length > 0) existing.__openleash = metadata;
  else delete existing.__openleash;
  fs.writeFileSync(settingsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

function detectGeminiProtected() {
  const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
  const hooks = (readJson(settingsPath) as { hooks?: unknown } | undefined)
    ?.hooks;
  return JSON.stringify(hooks ?? {}).includes("/v1/hooks/gemini/");
}

function geminiHookGroup(
  context: InstallContext,
  event: string,
  matcher?: string,
) {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command: hookCommand(context, "gemini", event),
        name: "Leash",
        timeout: HOOK_TIMEOUT_MS,
      },
    ],
  };
}

function installCursorProtection(context: InstallContext) {
  const hooksPath = path.join(os.homedir(), ".cursor", "hooks.json");
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  const existing = (readJson(hooksPath) as Record<string, unknown>) ?? {};
  const metadata = openLeashMetadata(existing);
  const hookKeys = [
    "beforeSubmitPrompt",
    "beforeShellExecution",
    "beforeReadFile",
    "afterFileEdit",
    "afterAgentResponse",
    "beforeMCPExecution",
    "afterMCPExecution",
    "stop",
  ];
  metadata.cursor = {
    installedAt: new Date().toISOString(),
    hooks: snapshotNamedHookEntries(existing, hookKeys),
  };
  existing.__openleash = metadata;
  existing.beforeSubmitPrompt = [cursorHook(context, "UserPromptSubmit")];
  existing.beforeShellExecution = [cursorHook(context, "PreToolUse")];
  existing.beforeReadFile = [cursorHook(context, "PreToolUse")];
  existing.afterFileEdit = [cursorHook(context, "PostToolUse")];
  existing.afterAgentResponse = [cursorHook(context, "PostToolUse")];
  existing.beforeMCPExecution = [cursorHook(context, "PreToolUse")];
  existing.afterMCPExecution = [cursorHook(context, "PostToolUse")];
  existing.stop = [cursorHook(context, "Stop")];
  fs.writeFileSync(hooksPath, `${JSON.stringify(existing, null, 2)}\n`);
}

function uninstallCursorProtection() {
  const hooksPath = path.join(os.homedir(), ".cursor", "hooks.json");
  if (!fs.existsSync(hooksPath)) return;
  const existing = (readJson(hooksPath) as Record<string, unknown>) ?? {};
  const metadata = openLeashMetadata(existing);
  const hookKeys = [
    "beforeSubmitPrompt",
    "beforeShellExecution",
    "beforeReadFile",
    "afterFileEdit",
    "afterAgentResponse",
    "beforeMCPExecution",
    "afterMCPExecution",
    "stop",
  ];
  restoreNamedHookEntries(
    existing,
    metadata.cursor?.hooks,
    hookKeys,
    "/v1/hooks/cursor/",
  );
  delete metadata.cursor;
  if (Object.keys(metadata).length > 0) existing.__openleash = metadata;
  else delete existing.__openleash;
  fs.writeFileSync(hooksPath, `${JSON.stringify(existing, null, 2)}\n`);
}

function detectCursorProtected() {
  const hooksPath = path.join(os.homedir(), ".cursor", "hooks.json");
  return JSON.stringify(readJson(hooksPath) ?? {}).includes(
    "/v1/hooks/cursor/",
  );
}

function cursorHook(context: InstallContext, event: string) {
  return {
    command: hookCommand(context, "cursor", event),
    name: "Leash",
    timeout: HOOK_TIMEOUT_MS,
  };
}

function installCopilotProtection(context: InstallContext) {
  const hooksPath = copilotOpenLeashHooksPath();
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(
    hooksPath,
    `${JSON.stringify(copilotHooksConfig(context), null, 2)}\n`,
  );
}

function uninstallCopilotProtection() {
  fs.rmSync(copilotOpenLeashHooksPath(), { force: true });
}

function detectCopilotProtected() {
  return JSON.stringify(readJson(copilotOpenLeashHooksPath()) ?? {}).includes(
    "/v1/hooks/copilot/",
  );
}

function copilotOpenLeashHooksPath() {
  return path.join(
    process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"),
    "hooks",
    "openleash.json",
  );
}

function copilotHooksConfig(context: InstallContext) {
  return {
    version: 1,
    hooks: {
      SessionStart: [copilotCommandHook(context, "SessionStart")],
      UserPromptSubmit: [copilotCommandHook(context, "UserPromptSubmit")],
      PreToolUse: [copilotCommandHook(context, "PreToolUse", "*")],
      PostToolUse: [copilotCommandHook(context, "PostToolUse", "*")],
      Stop: [copilotCommandHook(context, "Stop")],
    },
  };
}

function copilotCommandHook(
  context: InstallContext,
  event: string,
  matcher?: string,
) {
  return {
    type: "command",
    ...(matcher ? { matcher } : {}),
    command: hookCommand(context, "copilot", event),
    timeoutSec: HOOK_TIMEOUT_SECONDS,
  };
}

function installOpenCodeProtection(context: InstallContext) {
  const pluginDir = path.join(os.homedir(), ".config", "opencode", "plugins");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openleash.js"),
    openCodePluginSource(context),
  );
}

function uninstallOpenCodeProtection() {
  fs.rmSync(
    path.join(os.homedir(), ".config", "opencode", "plugins", "openleash.js"),
    { force: true },
  );
}

function detectOpenCodeProtected() {
  return readText(
    path.join(os.homedir(), ".config", "opencode", "plugins", "openleash.js"),
  ).includes("/v1/hooks/opencode/");
}

export function openCodePluginSource(context: InstallContext) {
  const preToolUrl = hookEndpoint(context, "opencode", "PreToolUse");
  const postToolUrl = hookEndpoint(context, "opencode", "PostToolUse");
  const stopUrl = hookEndpoint(context, "opencode", "Stop");
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${context.token}`,
    "x-openleash-api-function": context.apiFunction ?? "localHookEvaluate",
    "x-openleash-api-version":
      context.apiVersion ?? "2026-05-22.local-hook-evaluate.v1",
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
    // Only managed Cloud accounts may bypass a genuine loopback transport
    // outage. Serialization, policy, auth, and arbitrary application errors
    // remain visible and fail closed.
    const code = error?.cause?.code || error?.code;
    const transportUnavailable = ["AbortError", "TimeoutError"].includes(error?.name)
      || [
        "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOENT", "ENETUNREACH",
        "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"
      ].includes(code);
    if (${context.availabilityFailOpen === true} && transportUnavailable)
      return { decision: "allow", degraded: true };
    throw error;
  }
  if (!response.ok) {
    throw new Error(\`Leash backend unavailable (HTTP \${response.status}).\`);
  }
  return await response.json().catch(() => ({}));
}

function enforce(decision) {
  if (decision.decision === "deny" || decision.decision === "block") {
    throw new Error(decision.reason || "Leash denied this action.");
  }
  return decision;
}

function questionAnswers(questions, decision) {
  const payload = decision.response || decision.updatedInput || {};
  const answers = payload.answers && typeof payload.answers === "object"
    ? payload.answers
    : {};
  return questions.map((question) => {
    const value = answers[question.question];
    if (Array.isArray(value)) return value.map(String);
    return value === undefined || value === null || value === ""
      ? []
      : [String(value)];
  });
}

async function replyToQuestion(client, serverUrl, directory, request, decision) {
  if (decision.decision === "deny" || decision.decision === "block") {
    if (client?.question?.reject) {
      await client.question.reject({ requestID: request.id, directory });
      return;
    }
    await fetch(new URL(\`/question/\${encodeURIComponent(request.id)}/reject?directory=\${encodeURIComponent(directory)}\`, serverUrl), { method: "POST" });
    return;
  }
  const answers = questionAnswers(request.questions || [], decision);
  if (client?.question?.reply) {
    await client.question.reply({ requestID: request.id, directory, answers });
    return;
  }
  await fetch(new URL(\`/question/\${encodeURIComponent(request.id)}/reply?directory=\${encodeURIComponent(directory)}\`, serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers })
  });
}

export const OpenLeash = async ({ client, directory, serverUrl }) => ({
  event: async ({ event }) => {
    if (event?.type === "question.asked") {
      const request = event.properties || {};
      const decision = await evaluate(${JSON.stringify(preToolUrl)}, {
        tool_name: "AskUserQuestion",
        tool_input: { questions: request.questions || [] },
        session_id: request.sessionID,
        cwd: directory
      });
      await replyToQuestion(client, serverUrl, directory, request, decision);
      return;
    }
    if (event?.type === "session.idle") {
      await evaluate(${JSON.stringify(stopUrl)}, {
        session_id: event.properties?.sessionID,
        cwd: directory
      });
    }
  },
  "permission.ask": async (input, output) => {
    const decision = await evaluate(${JSON.stringify(preToolUrl)}, {
      tool_name: input?.permission || "PermissionRequest",
      tool_input: {
        patterns: input?.patterns || [],
        metadata: input?.metadata || {}
      },
      session_id: input?.sessionID,
      cwd: directory
    });
    output.status = decision.decision === "deny" || decision.decision === "block"
      ? "deny"
      : "allow";
  },
  "tool.execute.before": async (input, output) => {
    enforce(await evaluate(${JSON.stringify(preToolUrl)}, {
      tool_name: input?.tool,
      tool_input: output?.args || input?.args || input,
      session_id: input?.sessionID || input?.session?.id,
      cwd: input?.cwd
    }));
  },
  "tool.execute.after": async (input, output) => {
    await evaluate(${JSON.stringify(postToolUrl)}, {
      tool_name: input?.tool,
      tool_input: input?.args,
      tool_response: output,
      session_id: input?.sessionID || input?.session?.id,
      cwd: input?.cwd
    });
  }
});
`;
}

function hookEndpoint(
  context: InstallContext,
  agent: LocalHookAgent,
  event: string,
) {
  const endpoint = new URL(
    `/v1/hooks/${agent}/${event}`,
    context.apiUrl.replace(/\/+$/, ""),
  );
  endpoint.searchParams.set("hostname", os.hostname());
  endpoint.searchParams.set("platform", os.platform());
  endpoint.searchParams.set("os_release", os.release());
  endpoint.searchParams.set("client_version", context.clientVersion);
  return endpoint.toString();
}

function snapshotNamedHookEntries(
  hooks: Record<string, unknown>,
  events: string[],
) {
  return Object.fromEntries(
    events.map((event) => [
      event,
      {
        existed: Object.prototype.hasOwnProperty.call(hooks, event),
        value: hooks[event],
      },
    ]),
  );
}

function restoreNamedHookEntries(
  hooks: Record<string, unknown>,
  backup: Record<string, { existed?: boolean; value?: unknown }> | undefined,
  events: string[],
  managedNeedle: string,
) {
  for (const event of events) {
    const item = backup?.[event];
    if (item?.existed) hooks[event] = item.value;
    else if (JSON.stringify(hooks[event] ?? {}).includes(managedNeedle))
      delete hooks[event];
  }
}

function codexHookGroup(
  context: InstallContext,
  event: "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop",
) {
  return {
    hooks: [
      {
        type: "command",
        command: hookCommand(context, "codex", event),
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ],
  };
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
    "",
  ].join("\n");
  return `${block}${withoutManagedKeys}`;
}

function disableCodexApprovalHandoff(config: string) {
  const match = config.match(
    new RegExp(
      `${escapeRegExp(codexHandoffStart)}[\\s\\S]*?${escapeRegExp(codexHandoffEnd)}\\n?`,
    ),
  );
  if (!match) return config;
  const previousApproval = match[0].match(/previous_approval_policy=(.*)/)?.[1];
  const previousSandbox = match[0].match(/previous_sandbox_mode=(.*)/)?.[1];
  const restored: string[] = [];
  const approval = previousApproval
    ? parseCommentJson(previousApproval)
    : undefined;
  const sandbox = previousSandbox
    ? parseCommentJson(previousSandbox)
    : undefined;
  if (typeof approval === "string")
    restored.push(`approval_policy = ${JSON.stringify(approval)}`);
  if (typeof sandbox === "string")
    restored.push(`sandbox_mode = ${JSON.stringify(sandbox)}`);
  const clean = config.replace(match[0], "").trimStart();
  return `${restored.length ? `${restored.join("\n")}\n` : ""}${clean}`;
}

function removeCodexOpenLeashHookTrust(config: string, hooksPath: string) {
  const escapedHookPath = escapeRegExp(path.resolve(hooksPath));
  const withoutHookTables = config.replace(
    new RegExp(
      `\\n?\\[hooks\\.state\\."${escapedHookPath}:[^"]+"\\]\\ntrusted_hash\\s*=\\s*"[^"]*"\\n?`,
      "g",
    ),
    "\n",
  );
  return withoutHookTables.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function disableCodexHooksIfNoManagedHooks(
  config: string,
  hooks: Record<string, unknown>,
) {
  const hookText = JSON.stringify(hooks.hooks ?? {});
  const hasHookEntries = hookText !== "{}" && hookText !== "[]";
  if (hasHookEntries && !hookText.includes("/v1/hooks/codex/")) return config;
  const withoutEmptyState = config.replace(
    /\n?\[hooks\.state\]\s*(?=\n\s*\[|$)/g,
    "\n",
  );
  if (!/^\s*\[features\]\s*$/m.test(withoutEmptyState))
    return withoutEmptyState;
  return (
    withoutEmptyState
      .replace(
        /(^\s*\[features\]\s*\n(?:[^\[]*\n)*?)^\s*hooks\s*=\s*true\s*$/m,
        (_match, prefix: string) => `${prefix}hooks = false`,
      )
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

function snapshotCodexHooksFeature(config: string) {
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line));
  if (start < 0) return { featuresExisted: false, hooksExisted: false };
  const endOffset = lines.slice(start + 1).findIndex((line) => /^\s*\[/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  const hooks = lines.slice(start + 1, end).find((line) =>
    /^\s*hooks\s*=\s*(?:true|false)\s*$/.test(line)
  );
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
  if (!snapshot.featuresExisted) {
    restored = restored.replace(/\n?^\s*\[features\]\s*\n(?=\s*(?:\[|$))/m, "\n");
  }
  return restored.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function stripCodexHandoff(config: string) {
  return config.replace(
    new RegExp(
      `${escapeRegExp(codexHandoffStart)}[\\s\\S]*?${escapeRegExp(codexHandoffEnd)}\\n?`,
      "g",
    ),
    "",
  );
}

function codexApprovalHandoff(config: string) {
  return (
    config.includes(codexHandoffStart) &&
    /approval_policy\s*=\s*"never"/.test(config) &&
    /sandbox_mode\s*=\s*"danger-full-access"/.test(config)
  );
}

function topLevelTomlValue(config: string, key: string) {
  const beforeFirstTable = config.split(/\n\s*\[/, 1)[0] ?? "";
  return beforeFirstTable.match(
    new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*$`, "m"),
  )?.[1];
}

function parseCommentJson(value: string) {
  try {
    return JSON.parse(value.trim());
  } catch {
    return undefined;
  }
}

function trustCodexHooks(
  configPath: string,
  hooksPath: string,
  appVersion: string,
) {
  const hooks = codexHookMetadata(appVersion).filter(
    (
      hook,
    ): hook is {
      eventName: string;
      trustStatus: string;
      key: string;
      sourcePath: string;
      currentHash: string;
    } =>
      typeof hook.key === "string" &&
      typeof hook.sourcePath === "string" &&
      typeof hook.currentHash === "string" &&
      path.resolve(hook.sourcePath) === path.resolve(hooksPath),
  );
  if (hooks.length === 0) return;
  let config = readText(configPath);
  for (const hook of hooks) {
    const table = `[hooks.state.${JSON.stringify(hook.key)}]`;
    config = config.replace(
      new RegExp(
        `\\n?\\[hooks\\.state\\.${escapeRegExp(JSON.stringify(hook.key))}\\]\\ntrusted_hash\\s*=\\s*"[^"]*"\\n?`,
        "g",
      ),
      "\n",
    );
    config += `${config.endsWith("\n") || config.length === 0 ? "" : "\n"}${table}\ntrusted_hash = "${hook.currentHash}"\n`;
  }
  fs.writeFileSync(configPath, config);
}

type LocalHookAgent =
  | "claude"
  | "codex"
  | "copilot"
  | "gemini"
  | "opencode"
  | "cursor"
  | "openclaw"
  | "nanoclaw";
const HOOK_TIMEOUT_SECONDS = 600;
const HOOK_TIMEOUT_MS = HOOK_TIMEOUT_SECONDS * 1000;

function hookCommand(
  context: InstallContext,
  agent: LocalHookAgent,
  event: string,
) {
  const endpoint = new URL(
    `/v1/hooks/${agent}/${event}`,
    context.apiUrl.replace(/\/+$/, ""),
  );
  endpoint.searchParams.set("hostname", os.hostname());
  endpoint.searchParams.set("platform", os.platform());
  endpoint.searchParams.set("os_release", os.release());
  endpoint.searchParams.set("client_version", context.clientVersion);
  const args = hookCurlArgs(context, endpoint);
  const failOpen = context.availabilityFailOpen === true
    ? '; if [ "$hook_status" -eq 7 ] || [ "$hook_status" -eq 28 ]; then exit 0; fi'
    : "";
  return `curl ${args.map(shellQuote).join(" ")}; hook_status=$?${failOpen}; exit "$hook_status"`;
}

function hookCurlArgs(context: InstallContext, endpoint: URL) {
  return [
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
    `authorization: Bearer ${context.token}`,
    "-H",
    `x-openleash-api-function: ${context.apiFunction ?? "localHookEvaluate"}`,
    "-H",
    `x-openleash-api-version: ${context.apiVersion ?? "2026-05-22.local-hook-evaluate.v1"}`,
    "--data-binary",
    "@-",
  ];
}

function curlArgs(
  context: InstallContext,
  agent: LocalHookAgent,
  event: string,
) {
  const endpoint = new URL(
    `/v1/hooks/${agent}/${event}`,
    context.apiUrl.replace(/\/+$/, ""),
  );
  endpoint.searchParams.set("hostname", os.hostname());
  endpoint.searchParams.set("platform", os.platform());
  endpoint.searchParams.set("os_release", os.release());
  endpoint.searchParams.set("client_version", context.clientVersion);
  return hookCurlArgs(context, endpoint);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
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

export function openClawHandlerSource(context: InstallContext) {
  return `import { spawnSync } from "node:child_process";

const handler = async (event) => {
  const payload = {
    ...event,
    prompt: event?.context?.bodyForAgent ?? event?.context?.content ?? event?.context?.sessionEntry?.content,
    cwd: event?.context?.workspaceDir
  };
  const result = spawnSync("curl", ${JSON.stringify(curlArgs(context, "openclaw", "UserPromptSubmit"))}, {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: HOOK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    event?.messages?.push?.("Leash could not evaluate this action.");
    const availabilityFailure = [7, 28].includes(result.status) || result.error?.code === "ETIMEDOUT";
    if (!(${context.availabilityFailOpen === true} && availabilityFailure)) event.cancel = true;
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

function extensionInstalled(needles: string[]) {
  const extensionDirs = [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".cursor", "extensions"),
    path.join(os.homedir(), ".windsurf", "extensions"),
  ];
  return extensionDirs.some((dir) => {
    try {
      return fs
        .readdirSync(dir)
        .some((entry) =>
          needles.some((needle) => entry.toLowerCase().includes(needle)),
        );
    } catch {
      return false;
    }
  });
}

function codexHooksStatus(
  appVersion: string,
): Array<{ eventName: string; trustStatus: string }> {
  return codexHookMetadata(appVersion);
}

function codexHookMetadata(
  appVersion: string,
): Array<{
  eventName: string;
  trustStatus: string;
  key?: string;
  sourcePath?: string;
  currentHash?: string;
}> {
  if (!findOnPath("codex")) return [];
  return probeCodexHooks(appVersion);
}

function isCodexHookMetadata(
  value: unknown,
): value is {
  eventName: string;
  trustStatus: string;
  key?: string;
  sourcePath?: string;
  currentHash?: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { eventName?: unknown }).eventName === "string" &&
    typeof (value as { trustStatus?: unknown }).trustStatus === "string"
  );
}

function findOnPath(binary: string) {
  const suffixes = os.platform() === "win32" ? [".cmd", ".exe", ""] : [""];
  const home = os.homedir();
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter(Boolean);
  for (const dir of [...new Set(dirs)]) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${binary}${suffix}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function pathExists(value: string) {
  try {
    fs.accessSync(value);
    return true;
  } catch {
    return false;
  }
}

function readJson(file: string) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function readText(file: string) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
