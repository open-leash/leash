#!/usr/bin/env node
import { Command } from "commander";
import crypto from "node:crypto";
import { canonicalPluginSlug } from "../plugin-slug.js";
import os from "node:os";
import { apiVersionHeaders } from "./api-contract.js";
import { defaultCloudApiUrl, defaultDesktopApiUrl, hookApiUrl, proxyClientApiUrl, readConfig, writeConfig } from "./config.js";
import { discoverAgents } from "./discovery.js";
import {
  installClaudeHooks,
  installCodexHooks,
  installCopilotHooks,
  installCursorHooks,
  installGeminiHooks,
  installNanoClawHooks,
  installOpenCodeHooks,
  installOpenClawHooks,
  uninstallClaudeHooks,
  uninstallCodexHooks,
  uninstallCopilotHooks,
  uninstallCursorHooks,
  uninstallGeminiHooks,
  uninstallNanoClawHooks,
  uninstallOpenCodeHooks,
  uninstallOpenClawHooks
} from "./install.js";
import { runHook } from "./hook.js";
import { configureAgentProxy, installLocalProxy, localProxyStatus, uninstallLocalProxy } from "../proxy-manager.js";

const program = new Command();

type PluginListing = {
  id: string;
  slug?: string;
  name?: string;
  publisher?: string;
  shortDescription?: string;
  installed?: boolean;
  mandatory?: boolean;
  installable?: boolean;
  settings?: { enabled?: boolean };
  organizationPolicy?: { mandatory?: boolean };
};

program.name("openleash").description("Leash Desktop Client CLI and hook installer");

program
  .command("configure")
  .requiredOption("--token <token>", "Leash user token")
  .option("--api-url <url>", "Leash desktop local API URL used by local-only desktop commands", defaultDesktopApiUrl)
  .option("--remote-api-url <url>", "Leash Cloud or Private Cloud client API URL used by installed agent hooks", defaultCloudApiUrl)
  .option("--mode <mode>", "community, cloud, or enterprise", "community")
  .option("--email <email>", "User email")
  .option("--display-name <name>", "Display name")
  .action(async (options) => {
    const installIdentity = crypto.randomUUID();
    await writeConfig({
      token: options.token,
      apiUrl: options.apiUrl,
      remoteApiUrl: options.remoteApiUrl,
      mode: options.mode,
      enrolledAt: new Date().toISOString(),
      clientVersion: "0.1.0",
      user: options.email || options.displayName ? { email: options.email, displayName: options.displayName } : undefined,
      computer: { id: installIdentity, hostname: os.hostname() }
    });
    console.log("Leash Client config saved.");
  });

program
  .command("enroll")
  .requiredOption("--tenant <host>", "Leash tenant host, for example openleash.company.com")
  .requiredOption("--token <token>", "Leash deployment token")
  .option("--api-url <url>", "Leash API URL. Defaults to https://<tenant>")
  .option("--email <email>", "User email for unmanaged enrollment")
  .option("--display-name <name>", "Display name for unmanaged enrollment")
  .option("--mode <mode>", "cloud or enterprise", "cloud")
  .action(async (options) => {
    const apiUrl = options.apiUrl ?? tenantToApiUrl(options.tenant);
    const installIdentity = crypto.randomUUID();
    const response = await fetch(`${apiUrl}/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", ...apiVersionHeaders("tenantEnroll") },
      body: JSON.stringify({
        deploymentToken: options.token,
        email: options.email,
        displayName: options.displayName ?? os.userInfo().username,
        installIdentity,
        hostname: os.hostname(),
        platform: os.platform(),
        osRelease: os.release(),
        mode: options.mode
      })
    });
    const body = await response.json();
    if (!response.ok) {
      console.error(`Leash enrollment failed: ${body.error ?? response.statusText}`);
      process.exitCode = 1;
      return;
    }
    await writeConfig({
      apiUrl: defaultDesktopApiUrl,
      token: body.token,
      mode: body.mode === "enterprise" || body.mode === "private" ? "enterprise" : "cloud",
      tenantUrl: body.tenantUrl ?? options.tenant,
      remoteApiUrl: body.apiUrl ?? apiUrl,
      enrolledAt: new Date().toISOString(),
      clientVersion: "0.1.0",
      user: body.user ? { email: body.user.email, displayName: body.user.display_name } : undefined,
      computer: { ...body.computer, id: installIdentity }
    });
    console.log(`Leash Client enrolled ${os.hostname()} with ${body.tenantUrl ?? options.tenant}.`);
  });

program.command("discover").action(async () => {
  console.table(await discoverAgents());
});

program
  .command("install-hooks")
  .option("--claude", "install Claude Code hooks")
  .option("--codex", "install Codex hooks")
  .option("--copilot", "install GitHub Copilot hooks")
  .option("--gemini", "install Gemini CLI hooks")
  .option("--opencode", "install OpenCode hooks")
  .option("--cursor", "install Cursor hooks")
  .option("--openclaw", "install OpenClaw hooks")
  .option("--nanoclaw", "install NanoClaw hooks")
  .option("--all", "install every production-ready hook")
  .action(async (options) => {
    const all = options.all || noHookAgentSelected(options);
    if (all || options.claude) await reinstallHook(uninstallClaudeHooks, installClaudeHooks);
    if (all || options.codex) await reinstallHook(uninstallCodexHooks, installCodexHooks);
    if (all || options.copilot) await reinstallHook(uninstallCopilotHooks, installCopilotHooks);
    if (all || options.gemini) await reinstallHook(uninstallGeminiHooks, installGeminiHooks);
    if (all || options.opencode) await reinstallHook(uninstallOpenCodeHooks, installOpenCodeHooks);
    if (all || options.cursor) await reinstallHook(uninstallCursorHooks, installCursorHooks);
    if (all || options.openclaw) await reinstallHook(uninstallOpenClawHooks, installOpenClawHooks);
    if (all || options.nanoclaw) await reinstallHook(uninstallNanoClawHooks, installNanoClawHooks);
    console.log("Leash hooks installed.");
  });

program
  .command("uninstall-hooks")
  .option("--claude", "remove Claude Code hooks")
  .option("--codex", "remove Codex hooks")
  .option("--copilot", "remove GitHub Copilot hooks")
  .option("--gemini", "remove Gemini CLI hooks")
  .option("--opencode", "remove OpenCode hooks")
  .option("--cursor", "remove Cursor hooks")
  .option("--openclaw", "remove OpenClaw hooks")
  .option("--nanoclaw", "remove NanoClaw hooks")
  .option("--all", "remove every reversible hook")
  .action(async (options) => {
    const all = options.all || noHookAgentSelected(options);
    if (all || options.claude) await uninstallClaudeHooks();
    if (all || options.codex) await uninstallCodexHooks();
    if (all || options.copilot) await uninstallCopilotHooks();
    if (all || options.gemini) await uninstallGeminiHooks();
    if (all || options.opencode) await uninstallOpenCodeHooks();
    if (all || options.cursor) await uninstallCursorHooks();
    if (all || options.openclaw) await uninstallOpenClawHooks();
    if (all || options.nanoclaw) await uninstallNanoClawHooks();
    console.log("Leash hooks removed.");
  });

program
  .command("hook")
  .requiredOption("--agent <agent>", "claude, codex, copilot, gemini, opencode, cursor, openclaw, or nanoclaw")
  .requiredOption("--event <event>", "hook event name")
  .action(async (options) => {
    await runHook(options.agent, options.event);
  });

program.command("desktop").action(() => {
  console.log("Run `npm run desktop-client` from the Leash repo to start the desktop app.");
});

const plugins = program.command("features").alias("plugins").description("List, enable, and disable built-in Leash Features");

plugins
  .command("list")
  .description("List Features available to this user")
  .option("--search <query>", "filter Features by name or description")
  .option("--json", "print raw JSON")
  .action(async (options) => {
    try {
      const config = await readConfig();
      const listings = await fetchPluginListings(config, options.search);
      if (options.json) {
        console.log(JSON.stringify(listings, null, 2));
        return;
      }
      printPluginListings(listings);
    } catch (error) {
      console.error(`Leash Features list failed: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  });

plugins
  .command("enable")
  .alias("install")
  .description("Enable one or more built-in Features")
  .argument("<plugins...>", "Feature slugs or ids, for example token-saver rules-enforcer")
  .option("--json", "print raw JSON results")
  .action(async (pluginInputs: string[], options) => {
    await mutatePlugins("install", pluginInputs, options);
  });

plugins
  .command("disable")
  .alias("uninstall")
  .description("Disable one or more optional built-in Features")
  .argument("<plugins...>", "Feature slugs or ids, for example token-saver rules-enforcer")
  .option("--json", "print raw JSON results")
  .action(async (pluginInputs: string[], options) => {
    await mutatePlugins("uninstall", pluginInputs, options);
  });

program.command("status").action(async () => {
  try {
    const config = await readConfig();
    const api = hookApiUrl(config);
    const response = await fetch(`${api}/health`, { headers: apiVersionHeaders("health") }).catch(() => undefined);
    console.table({
      mode: config.mode ?? "cloud",
      apiUrl: config.apiUrl,
      hookApiUrl: api,
      tenantUrl: config.tenantUrl ?? "",
      enrolledAt: config.enrolledAt ?? "",
      user: config.user?.email ?? "",
      computer: config.computer?.hostname ?? os.hostname(),
      apiReachable: response?.ok ? "yes" : "no"
    });
  } catch (error) {
    console.error(`Leash is not configured: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
});

const proxy = program.command("proxy").description("Manage full-conversation local LLM proxy interception");
proxy.command("status").option("--json", "print JSON").action(async (options) => {
  const status = await localProxyStatus();
  if (options.json) console.log(JSON.stringify(status, null, 2));
  else console.table(status);
});
proxy.command("install")
  .option("--agents <agents>", "comma-separated supported agents", "claude-code,codex")
  .option("--corporate-proxy <url>", "chain provider traffic through an existing organization proxy")
  .action(async (options) => {
    try {
      const config = await readConfig();
      const status = await installLocalProxy({
        // Proxy traffic must enter the desktop edge so local container plugins
        // run before the normalized event is relayed to the managed backend.
        // Installed hooks intentionally use hookApiUrl(config) instead.
        clientApiUrl: proxyClientApiUrl(config),
        token: config.token,
        agents: String(options.agents).split(",").map((item) => item.trim()).filter(Boolean),
        corporateProxy: options.corporateProxy,
        failOpen: Boolean(config.remoteApiUrl),
      });
      console.table(status);
    } catch (error) {
      console.error(`Leash proxy install failed: ${errorMessage(error)}`);
      process.exitCode = 1;
    }
  });
proxy.command("uninstall").action(async () => {
  try { console.table(await uninstallLocalProxy()); }
  catch (error) { console.error(`Leash proxy uninstall failed: ${errorMessage(error)}`); process.exitCode = 1; }
});
proxy.command("configure-agent")
  .argument("<agent>", "claude-code or codex")
  .option("--remove", "restore the pre-Leash configuration")
  .action((agent, options) => {
    try { configureAgentProxy(agent, !options.remove); console.log(`Leash proxy configuration ${options.remove ? "removed from" : "installed for"} ${agent}.`); }
    catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
  });

program
  .command("update")
  .option("--yes", "install without prompting when supported")
  .action(async (options) => {
    const args = ["-a", "Leash", "--args", "--update"];
    if (options.yes) args.push("--yes");
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("open", args, { stdio: "inherit" });
    if (result.error || result.status !== 0) {
      console.log("Leash updater is available from the tray app. On Windows, run Leash.exe --update.");
      if (result.status) process.exitCode = result.status;
    }
  });

void program.parseAsync();

async function reinstallHook(
  uninstall: () => Promise<void>,
  install: () => Promise<void>,
) {
  await uninstall();
  await install();
}

function configuredRemoteApiUrl(config: { remoteApiUrl?: string; tenantUrl?: string; apiUrl?: string }) {
  const candidate =
    config.remoteApiUrl ??
    config.tenantUrl ??
    (config.apiUrl && !isLocalDesktopApiUrl(config.apiUrl) ? config.apiUrl : defaultCloudApiUrl);
  const apiUrl = /^https?:\/\//i.test(candidate) ? candidate : tenantToApiUrl(candidate);
  return apiUrl.replace(/\/+$/, "");
}

function isLocalDesktopApiUrl(apiUrl: string) {
  try {
    const url = new URL(apiUrl);
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname) && url.port === "9317";
  } catch {
    return false;
  }
}

function authHeaders(config: { token: string }, functionName: "tenantPluginsRead" | "adminPluginsWrite") {
  return {
    authorization: `Bearer ${config.token}`,
    ...apiVersionHeaders(functionName)
  };
}

async function fetchPluginListings(config: { token: string; remoteApiUrl?: string; tenantUrl?: string; apiUrl?: string }, search = "") {
  const baseUrl = configuredRemoteApiUrl(config);
  const localPlugins = await fetchLocalPluginCatalog(config, baseUrl);
  const query = search.trim().toLowerCase();
  return localPlugins
    .map((plugin) => ({ ...plugin, installed: Boolean(plugin.installed ?? plugin.settings?.enabled), installable: true, mandatory: false }))
    .filter((plugin) => !query || pluginSearchText(plugin).includes(query));
}

async function fetchLocalPluginCatalog(config: { token: string }, localApiUrl: string) {
  const response = await fetch(`${localApiUrl}/v1/plugins`, { headers: authHeaders(config, "tenantPluginsRead") });
  const body = await readJsonResponse(response);
  if (!response.ok) throw new Error(apiError(body, response.statusText));
  if (body && typeof body === "object" && "plugins" in body && Array.isArray(body.plugins)) return body.plugins as PluginListing[];
  return [];
}

function pluginSearchText(plugin: PluginListing) {
  return [
    plugin.id,
    plugin.slug,
    plugin.name,
    plugin.shortDescription
  ].filter(Boolean).join(" ").toLowerCase();
}

async function mutatePlugins(action: "install" | "uninstall", pluginInputs: string[], options: { json?: boolean }) {
  try {
    const config = await readConfig();
    const listings = await fetchPluginListings(config);
    const results = [];
    let failed = false;
    for (const input of pluginInputs) {
      try {
        const plugin = resolvePluginInput(input, listings);
        const pluginId = plugin?.id ?? input;
        const result = await mutatePlugin(config, pluginId, action);
        const label = canonicalPluginSlug(plugin?.slug ?? plugin?.id ?? input);
        results.push({ input, plugin: label, ok: true, result });
        if (!options.json) console.log(`${label}: ${action === "install" ? "installed" : "removed"}`);
      } catch (error) {
        failed = true;
        results.push({ input, ok: false, error: errorMessage(error) });
        if (!options.json) console.error(`${input}: ${errorMessage(error)}`);
      }
    }
    if (options.json) console.log(JSON.stringify(results, null, 2));
    if (failed) process.exitCode = 1;
  } catch (error) {
    console.error(`Leash plugins ${action} failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

async function mutatePlugin(
  config: { token: string; remoteApiUrl?: string; tenantUrl?: string; apiUrl?: string },
  pluginId: string,
  action: "install" | "uninstall"
) {
  const baseUrl = configuredRemoteApiUrl(config);
  const response = await fetch(`${baseUrl}/v1/plugins/${encodeURIComponent(pluginId)}/${action}`, {
    method: "POST",
    headers: authHeaders(config, "adminPluginsWrite")
  });
  const body = await readJsonResponse(response);
  if (!response.ok) throw new Error(apiError(body, response.statusText));
  return body;
}

function resolvePluginInput(input: string, listings: PluginListing[]) {
  const normalized = input.trim().toLowerCase();
  const matches = listings.filter((plugin) => {
    return (
      plugin.id.toLowerCase() === normalized ||
      plugin.slug?.toLowerCase() === normalized ||
      plugin.name?.toLowerCase() === normalized
    );
  });
  if (matches.length > 1) {
    throw new Error(`ambiguous plugin "${input}"; use one of ${matches.map((plugin) => plugin.slug ?? plugin.id).join(", ")}`);
  }
  return matches[0];
}

function printPluginListings(listings: PluginListing[]) {
  if (!listings.length) {
    console.log("No Features found.");
    return;
  }
  console.table(
    listings.map((plugin) => ({
      feature: canonicalPluginSlug(plugin.slug ?? plugin.id),
      status: plugin.installed || plugin.settings?.enabled ? "enabled" : "disabled"
    }))
  );
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function apiError(body: unknown, fallback: string) {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  if (typeof body === "string" && body.trim()) return body.trim();
  return fallback;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown error";
}

function tenantToApiUrl(tenant: string) {
  if (/^https?:\/\//i.test(tenant)) return tenant.replace(/\/+$/, "");
  return `https://${tenant.replace(/\/+$/, "")}`;
}

function noHookAgentSelected(options: Record<string, unknown>) {
  return !(
    options.claude ||
    options.codex ||
    options.copilot ||
    options.gemini ||
    options.opencode ||
    options.cursor ||
    options.openclaw ||
    options.nanoclaw
  );
}
