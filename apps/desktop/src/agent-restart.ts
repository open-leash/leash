import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RestartProcess = {
  pid: number;
  ppid: number;
  command: string;
  cwd?: string;
};

export type RestartProject = {
  name: string;
  path?: string;
};

export type RunningAgentRestartTarget = {
  id: string;
  application: string;
  applicationKind: "vscode" | "cursor" | "windsurf" | "terminal";
  icon: string;
  agentKinds: string[];
  agentNames: string[];
  processIds: number[];
  projects: RestartProject[];
};

type RestartResult = {
  ok: boolean;
  restarted: string[];
  errors: string[];
};

const AGENT_PATTERNS: Record<string, RegExp> = {
  "claude-code": /(?:^|[\\/\s])claude(?:\.exe)?(?:[\s.-]|$)/i,
  claude: /(?:^|[\\/\s])claude(?:\.exe)?(?:[\s.-]|$)/i,
  codex: /(?:^|[\\/\s])codex(?:\.exe)?(?:[\s.-]|$)/i,
  gemini: /(?:^|[\\/\s])gemini(?:\.exe)?(?:[\s.-]|$)/i,
  opencode: /(?:^|[\\/\s])opencode(?:\.exe)?(?:[\s.-]|$)/i,
  cline: /(?:[\\/])(?:cline|claude-dev|saoudrizwan)(?:[\\/.-]|$)/i,
  continue: /(?:[\\/])continue(?:[\\/.-]|$)/i,
  "github-copilot": /(?:github[\\/.-])?copilot(?:[\\/.-]|$)/i,
  copilot: /(?:github[\\/.-])?copilot(?:[\\/.-]|$)/i,
  openclaw: /(?:^|[\\/\s])openclaw(?:\.exe)?(?:[\s.-]|$)/i,
  nanoclaw: /(?:^|[\\/\s])nanoclaw(?:\.exe)?(?:[\s.-]|$)/i,
};

const AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  claude: "Claude Code",
  codex: "OpenAI Codex",
  gemini: "Google Gemini CLI",
  opencode: "OpenCode",
  cline: "Cline",
  continue: "Continue",
  "github-copilot": "GitHub Copilot",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  windsurf: "Windsurf",
  openclaw: "OpenClaw",
  nanoclaw: "NanoClaw",
};

const CLI_COMMANDS: Record<string, string> = {
  "claude-code": "claude",
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
  openclaw: "openclaw",
  nanoclaw: "nanoclaw",
};

export function parseRestartProcessTree(value: string): RestartProcess[] {
  return value.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return match
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }]
      : [];
  });
}

export function parseIdeProjects(value: string): RestartProject[] {
  const names = value.split(/\r?\n/).flatMap((line) => {
    const folder = line.match(/^\s*\|\s+Folder \((.+?)\)(?::|$)/);
    if (folder) return [folder[1].trim()];
    const window = line.match(/^\s*\d*\s*\|?\s*window(?:\s+\[\d+\])?\s+\((.+?)\)\s*$/i);
    if (!window) return [];
    const name = window[1].replace(/^(?:Welcome|Browser)\s+-\s+/i, "").trim();
    return name && name.toLowerCase() !== "welcome" ? [name] : [];
  });
  return [...new Set(names)].map((name) => ({ name }));
}

export function groupRunningAgentProcesses(
  processes: RestartProcess[],
  monitoredKinds: string[],
  projectsByApplication: Partial<Record<RunningAgentRestartTarget["applicationKind"], RestartProject[]>> = {},
) {
  const normalizedKinds = [...new Set(monitoredKinds.map(normalizeAgentKind).filter(Boolean))];
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  const groups = new Map<string, RunningAgentRestartTarget>();

  for (const item of processes) {
    const matchingKinds = normalizedKinds.filter((kind) => processMatchesKind(item.command, kind));
    const directHostKind = applicationKindForCommand(item.command);
    if (directHostKind === "cursor" && normalizedKinds.includes("cursor")) matchingKinds.push("cursor");
    if (directHostKind === "windsurf" && normalizedKinds.includes("windsurf")) matchingKinds.push("windsurf");
    if (matchingKinds.length === 0) continue;

    const host = findApplicationHost(item, byPid);
    if (host) {
      const id = `application:${host.kind}`;
      const current = groups.get(id) ?? {
        id,
        application: applicationName(host.kind),
        applicationKind: host.kind,
        icon: applicationIcon(host.kind),
        agentKinds: [],
        agentNames: [],
        processIds: [],
        projects: projectsByApplication[host.kind] ?? [],
      };
      current.agentKinds.push(...matchingKinds);
      current.processIds.push(item.pid);
      groups.set(id, current);
      continue;
    }

    for (const kind of matchingKinds.filter((candidate) => CLI_COMMANDS[candidate])) {
      const id = `terminal:${kind}:${item.pid}`;
      const projectPath = usefulProjectPath(item.cwd);
      if (!projectPath) continue;
      groups.set(id, {
        id,
        application: `${AGENT_NAMES[kind] ?? kind} terminal`,
        applicationKind: "terminal",
        icon: agentIcon(kind),
        agentKinds: [kind],
        agentNames: [AGENT_NAMES[kind] ?? kind],
        processIds: [item.pid],
        projects: projectPath ? [{ name: path.basename(projectPath), path: projectPath }] : [],
      });
    }
  }

  return [...groups.values()].map((target) => ({
    ...target,
    agentKinds: [...new Set(target.agentKinds)],
    agentNames: [...new Set(target.agentKinds.map((kind) => AGENT_NAMES[kind] ?? kind))],
    processIds: [...new Set(target.processIds)],
    projects: uniqueProjects(target.projects),
  })).sort((left, right) => left.application.localeCompare(right.application));
}

export function detectRunningAgentRestartTargets(monitoredKinds: string[]) {
  const processes: RestartProcess[] = process.platform === "win32"
    ? windowsProcesses()
    : parseRestartProcessTree(commandOutput("/bin/ps", ["-axo", "pid=,ppid=,command="]));
  const normalizedKinds = monitoredKinds.map(normalizeAgentKind);
  for (const item of processes) {
    const directHost = applicationKindForCommand(item.command);
    if (
      normalizedKinds.some((kind) => processMatchesKind(item.command, kind)) ||
      (directHost === "cursor" && normalizedKinds.includes("cursor")) ||
      (directHost === "windsurf" && normalizedKinds.includes("windsurf"))
    ) item.cwd = cwdForPid(item.pid);
  }
  const runningApplications = new Set(processes.map((item) => applicationKindForCommand(item.command)).filter(Boolean));
  const projectsByApplication = {
    vscode: runningApplications.has("vscode") ? ideProjects("vscode") : [],
    cursor: runningApplications.has("cursor") ? ideProjects("cursor") : [],
    windsurf: runningApplications.has("windsurf") ? ideProjects("windsurf") : [],
  };
  return groupRunningAgentProcesses(processes, monitoredKinds, projectsByApplication);
}

export async function restartRunningAgentTargets(
  targetIds: string[],
  monitoredKinds: string[],
): Promise<RestartResult> {
  const requested = new Set(targetIds.map(String));
  const targets = detectRunningAgentRestartTargets(monitoredKinds)
    .filter((target) => requested.has(target.id));
  const restarted: string[] = [];
  const errors: string[] = [];
  for (const target of targets) {
    const result = process.platform === "win32"
      ? await restartWindowsTarget(target)
      : process.platform === "darwin"
        ? await restartMacTarget(target)
        : { ok: false, error: "Automatic agent restart is supported on macOS and Windows." };
    if (result.ok) restarted.push(target.application);
    else errors.push(`${target.application}: ${result.error}`);
  }
  return { ok: errors.length === 0, restarted, errors };
}

function findApplicationHost(item: RestartProcess, byPid: Map<number, RestartProcess>) {
  let current: RestartProcess | undefined = item;
  const visited = new Set<number>();
  while (current && !visited.has(current.pid)) {
    visited.add(current.pid);
    const kind = applicationKindForCommand(current.command);
    if (kind) return { kind, process: current };
    current = byPid.get(current.ppid);
  }
  return undefined;
}

function applicationKindForCommand(command: string): "vscode" | "cursor" | "windsurf" | undefined {
  const value = command.toLowerCase();
  if (value.includes("/visual studio code.app/") || value.includes("\\microsoft vs code\\") || value.includes("\\code.exe")) return "vscode";
  if (value.includes("/cursor.app/") || value.includes("\\cursor\\") || value.includes("\\cursor.exe")) return "cursor";
  if (value.includes("/windsurf.app/") || value.includes("\\windsurf\\") || value.includes("\\windsurf.exe")) return "windsurf";
  return undefined;
}

function applicationName(kind: "vscode" | "cursor" | "windsurf") {
  if (kind === "vscode") return "Visual Studio Code";
  if (kind === "cursor") return "Cursor";
  return "Windsurf";
}

function applicationIcon(kind: "vscode" | "cursor" | "windsurf") {
  return `agent-icons/${kind}.${kind === "vscode" ? "png" : "svg"}`;
}

function agentIcon(kind: string) {
  if (["claude", "claude-code"].includes(kind)) return "agent-icons/claude.svg";
  if (kind === "codex") return "agent-icons/openai.svg";
  if (kind === "github-copilot" || kind === "copilot") return "agent-icons/copilot.svg";
  return `agent-icons/${kind}.svg`;
}

function processMatchesKind(command: string, kind: string) {
  return Boolean(AGENT_PATTERNS[kind]?.test(command));
}

function normalizeAgentKind(kind: string) {
  const normalized = String(kind ?? "").trim().toLowerCase();
  if (normalized === "claude") return "claude-code";
  if (normalized === "copilot") return "github-copilot";
  return normalized;
}

function usefulProjectPath(value?: string) {
  if (!value || !path.isAbsolute(value)) return undefined;
  const resolved = path.resolve(value);
  if ([path.parse(resolved).root, os.homedir()].includes(resolved)) return undefined;
  if (resolved.includes(".app/Contents/")) return undefined;
  return resolved;
}

function uniqueProjects(projects: RestartProject[]) {
  const seen = new Set<string>();
  return projects.filter((project) => {
    const key = project.path || project.name.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ideProjects(kind: "vscode" | "cursor" | "windsurf") {
  const executable = ideExecutable(kind);
  if (!executable) return [];
  const projects = parseIdeProjects(commandOutput(executable, ["--status"], 5_000));
  const workspacePaths = storedWorkspacePaths(kind);
  return projects.map((project) => {
    const matchingPath = workspacePaths.find((candidate) => path.basename(candidate) === project.name);
    return matchingPath ? { ...project, path: matchingPath } : project;
  });
}

function ideExecutable(kind: "vscode" | "cursor" | "windsurf") {
  const macPaths = {
    vscode: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    cursor: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
    windsurf: "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf",
  };
  if (process.platform === "darwin" && fs.existsSync(macPaths[kind])) return macPaths[kind];
  const candidates = kind === "vscode" ? ["code"] : [kind];
  return candidates.find((candidate) => spawnSync(candidate, ["--version"], { stdio: "ignore", timeout: 1_500, windowsHide: true }).status === 0);
}

function storedWorkspacePaths(kind: "vscode" | "cursor" | "windsurf") {
  const product = kind === "vscode" ? "Code" : kind === "cursor" ? "Cursor" : "Windsurf";
  const root = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", product, "User", "workspaceStorage")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA ?? "", product, "User", "workspaceStorage")
      : path.join(os.homedir(), ".config", product, "User", "workspaceStorage");
  try {
    return fs.readdirSync(root).flatMap((entry) => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(root, entry, "workspace.json"), "utf8")) as { folder?: string };
        if (!record.folder) return [];
        const parsed = new URL(record.folder);
        let value = decodeURIComponent(parsed.pathname);
        if (process.platform === "win32" && /^\/[a-z]:/i.test(value)) value = value.slice(1);
        return fs.existsSync(value) ? [value] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function cwdForPid(pid: number) {
  if (process.platform === "darwin") {
    const value = commandOutput("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    return value.split(/\r?\n/).find((line) => line.startsWith("n"))?.slice(1);
  }
  return undefined;
}

function windowsProcesses() {
  const script = "Get-CimInstance Win32_Process | ForEach-Object { [Console]::Out.WriteLine(([string]$_.ProcessId) + \"`t\" + ([string]$_.ParentProcessId) + \"`t\" + ([string]$_.CommandLine)) }";
  return commandOutput("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 4_000)
    .split(/\r?\n/)
    .flatMap((line) => {
      const [pid, ppid, ...command] = line.split("\t");
      return Number(pid) > 0 ? [{ pid: Number(pid), ppid: Number(ppid), command: command.join("\t") }] : [];
    });
}

async function restartMacTarget(target: RunningAgentRestartTarget) {
  const applicationKind = target.applicationKind;
  if (applicationKind === "terminal") {
    const kind = target.agentKinds[0];
    const command = CLI_COMMANDS[kind];
    const projectPath = target.projects[0]?.path;
    if (!command || !projectPath) return { ok: false, error: "The project or restart command could not be resolved." };
    for (const pid of target.processIds) {
      try { process.kill(pid, "SIGTERM"); } catch { /* It may have already exited. */ }
    }
    const child = spawn("/usr/bin/osascript", ["-e", MAC_RESTART_TERMINAL_SCRIPT, projectPath, command], { stdio: "ignore", detached: true });
    child.unref();
    return { ok: true };
  }
  const application = target.application;
  const result = await runCommand("/usr/bin/osascript", ["-e", `tell application ${appleScriptString(application)} to quit`], 20_000);
  if (result.error && result.error.code !== "ETIMEDOUT") {
    return { ok: false, error: result.error.message };
  }
  const exited = await waitUntil(() => !macApplicationRunning(applicationKind), 30_000);
  if (!exited) return { ok: false, error: "Finish the editor's save prompt, then try again." };
  const child = spawn("/usr/bin/open", ["-a", application], { stdio: "ignore", detached: true });
  child.unref();
  return { ok: true };
}

async function restartWindowsTarget(target: RunningAgentRestartTarget) {
  const projects = target.projects.map((project) => project.path).filter(Boolean) as string[];
  const processNames = target.applicationKind === "vscode"
    ? ["Code"]
    : target.applicationKind === "cursor"
      ? ["Cursor"]
      : target.applicationKind === "windsurf"
        ? ["Windsurf"]
        : [];
  const cli = target.applicationKind === "terminal" ? CLI_COMMANDS[target.agentKinds[0]] : undefined;
  const ideCommand = target.applicationKind === "vscode" ? "code" : target.applicationKind;
  const script = target.applicationKind === "terminal"
    ? [
        `$ids = @(${target.processIds.join(",")})`,
        "$ids | ForEach-Object { Stop-Process -Id $_ -ErrorAction SilentlyContinue }",
        `Start-Process -FilePath ${powerShellString(cli ?? "")} -WorkingDirectory ${powerShellString(projects[0] ?? "")}`,
      ].join("; ")
    : [
        `$names = @(${processNames.map(powerShellString).join(",")})`,
        "$processes = Get-Process | Where-Object { $names -contains $_.ProcessName }",
        "$processes | ForEach-Object { [void]$_.CloseMainWindow() }",
        "$processes | ForEach-Object { [void]$_.WaitForExit(30000) }",
        `$command = Get-Command ${powerShellString(ideCommand)} | Select-Object -First 1`,
        "if (-not $command) { exit 1 }",
        "Start-Process -FilePath $command.Source",
      ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 35_000,
    windowsHide: true,
  });
  return result.status === 0 ? { ok: true } : { ok: false, error: String(result.stderr || "The application did not restart.").trim() };
}

function macApplicationRunning(kind: "vscode" | "cursor" | "windsurf") {
  const needle = kind === "vscode" ? "/Visual Studio Code.app/" : kind === "cursor" ? "/Cursor.app/" : "/Windsurf.app/";
  return parseRestartProcessTree(commandOutput("/bin/ps", ["-axo", "pid=,ppid=,command="]))
    .some((item) => item.command.includes(needle));
}

function waitUntil(predicate: () => boolean, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 300);
    timer.unref();
  });
}

function commandOutput(command: string, args: string[], timeout = 2_500) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, windowsHide: true });
  return result.status === 0 ? String(result.stdout ?? "") : "";
}

function runCommand(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ status: number | null; error?: NodeJS.ErrnoException }>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    let settled = false;
    const finish = (result: { status: number | null; error?: NodeJS.ErrnoException }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ status: null, error: Object.assign(new Error("Command timed out."), { code: "ETIMEDOUT" }) });
    }, timeoutMs);
    child.once("error", (error: NodeJS.ErrnoException) => finish({ status: null, error }));
    child.once("exit", (status) => finish({ status }));
  });
}

function appleScriptString(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function powerShellString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

const MAC_RESTART_TERMINAL_SCRIPT = `
on run argv
  set projectPath to item 1 of argv
  set agentCommand to item 2 of argv
  tell application "Terminal"
    activate
    do script "cd " & quoted form of projectPath & " && exec " & quoted form of agentCommand
  end tell
end run`;
