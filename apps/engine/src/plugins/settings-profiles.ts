import type { AgentKind, PluginSettingProfile } from "@openleash/shared";

const AGENT_KINDS = new Set<AgentKind>([
  "claude-code", "codex", "openclaw", "nanoclaw", "salesforce-agentforce",
  "azure-ai-foundry", "microsoft-copilot-studio", "aws-bedrock-agentcore",
  "google-vertex-ai", "n8n", "zapier-agents", "openai-codex-cloud", "cursor",
  "gemini", "opencode", "cline", "continue", "windsurf", "github-copilot",
  "kiro", "aider", "zed", "unknown",
]);

export function normalizePluginSettingProfiles(value: unknown): PluginSettingProfile[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.slice(0, 64).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const input = raw as Record<string, unknown>;
    let id = String(input.id ?? `profile-${index + 1}`)
      .trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    if (!id) id = `profile-${index + 1}`;
    if (ids.has(id)) return [];
    ids.add(id);
    const name = String(input.name ?? id).trim().slice(0, 80) || id;
    const agentKinds = Array.isArray(input.agentKinds)
      ? [...new Set(input.agentKinds.map(String).filter((kind): kind is AgentKind => AGENT_KINDS.has(kind as AgentKind)))].slice(0, 24)
      : [];
    const agentIds = Array.isArray(input.agentIds)
      ? [...new Set(input.agentIds.map(String).map((id) => id.trim()).filter(Boolean))].slice(0, 64)
      : [];
    const projectPaths = Array.isArray(input.projectPaths)
      ? [...new Set(input.projectPaths.map(String).map(normalizeProjectPath).filter(Boolean))].slice(0, 64)
      : [];
    const userIds = normalizedIds(input.userIds, 500);
    const groupIds = normalizedIds(input.groupIds, 500);
    const config = input.config && typeof input.config === "object" && !Array.isArray(input.config)
      ? input.config as Record<string, unknown>
      : {};
    if (JSON.stringify(config).length > 65_536) return [];
    const priority = Number.isFinite(Number(input.priority))
      ? Math.max(-10_000, Math.min(10_000, Math.trunc(Number(input.priority))))
      : undefined;
    return [{
      id,
      name,
      agentKinds,
      ...(agentIds.length > 0 ? { agentIds } : {}),
      ...(projectPaths.length > 0 ? { projectPaths } : {}),
      ...(userIds.length > 0 ? { userIds } : {}),
      ...(groupIds.length > 0 ? { groupIds } : {}),
      ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
      config,
      ...(priority === undefined ? {} : { priority }),
    }];
  });
}

export function resolvePluginSettingProfiles(input: {
  enabled: boolean;
  config: Record<string, unknown>;
  organizationProfiles?: PluginSettingProfile[];
  userProfiles?: PluginSettingProfile[];
  agentKind?: string;
  agentId?: string;
  projectPath?: string;
  userId?: string;
  groupIds?: string[];
  mergeArrayKeys?: string[];
  configLocked?: boolean;
  mandatory?: boolean;
}) {
  let enabled = input.enabled;
  let config = { ...input.config };
  const effectiveProfileIds: string[] = [];
  if (!input.agentKind && !input.agentId && !input.projectPath && !input.userId && !(input.groupIds?.length)) return { enabled, config, effectiveProfileIds };

  const apply = (
    scope: "organization" | "user",
    profiles: PluginSettingProfile[],
    allowEnabledOverride = true,
  ) => {
    for (const profile of [...profiles].sort(compareProfiles)) {
      if (profile.agentKinds.length > 0 && (!input.agentKind || !profile.agentKinds.includes(input.agentKind as AgentKind))) continue;
      if ((profile.agentIds?.length ?? 0) > 0 && (!input.agentId || !profile.agentIds!.includes(input.agentId))) continue;
      if ((profile.projectPaths?.length ?? 0) > 0 && !profile.projectPaths!.some((projectPath) => projectPathMatches(projectPath, input.projectPath))) continue;
      if ((profile.userIds?.length ?? 0) > 0 && (!input.userId || !profile.userIds!.includes(input.userId))) continue;
      if ((profile.groupIds?.length ?? 0) > 0 && !profile.groupIds!.some((groupId) => input.groupIds?.includes(groupId))) continue;
      if (allowEnabledOverride && typeof profile.enabled === "boolean") enabled = profile.enabled;
      config = mergeProfileConfig(config, profile.config, input.mergeArrayKeys ?? []);
      effectiveProfileIds.push(`${scope}:${profile.id}`);
    }
  };
  apply("organization", input.organizationProfiles ?? []);
  if (!input.configLocked) apply("user", input.userProfiles ?? [], !input.mandatory);
  return { enabled, config, effectiveProfileIds };
}

function normalizedIds(value: unknown, limit: number) {
  return Array.isArray(value)
    ? [...new Set(value.map(String).map((id) => id.trim()).filter(Boolean))].slice(0, limit)
    : [];
}

function mergeProfileConfig(base: Record<string, unknown>, override: Record<string, unknown>, mergeArrayKeys: string[]) {
  const merged = { ...base, ...override };
  for (const key of mergeArrayKeys) {
    if (Array.isArray(base[key]) && Array.isArray(override[key])) merged[key] = [...base[key], ...override[key]];
  }
  return merged;
}

export function normalizeProjectPath(value: string) {
  const slashed = value.trim().replace(/\\/g, "/");
  const uncPrefix = slashed.startsWith("//") ? "//" : "";
  const normalized = uncPrefix + slashed.slice(uncPrefix.length).replace(/\/{2,}/g, "/");
  if (!normalized || normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "").slice(0, 500);
}

export function projectPathMatches(profilePath: string, eventPath?: string) {
  const root = normalizeProjectPath(profilePath);
  const project = normalizeProjectPath(eventPath ?? "");
  if (!root || !project) return false;
  const windowsPath = /^(?:[a-z]:\/|\/\/)/i;
  const comparableRoot = windowsPath.test(root) ? root.toLowerCase() : root;
  const comparableProject = windowsPath.test(project) ? project.toLowerCase() : project;
  return comparableProject === comparableRoot || (comparableRoot !== "/" && comparableProject.startsWith(`${comparableRoot}/`));
}

function compareProfiles(a: PluginSettingProfile, b: PluginSettingProfile) {
  return (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id);
}
