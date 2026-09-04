import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { bundledFirstPartyPlugins } from "./plugin-catalog.js";

const renderer = readFileSync(path.join(__dirname, "window.html"), "utf8");
const islandRenderer = readFileSync(path.join(__dirname, "notice.html"), "utf8");
const desktopMain = readFileSync(path.join(__dirname, "main.ts"), "utf8");
const preload = readFileSync(path.join(__dirname, "preload.ts"), "utf8");
const copyAssets = readFileSync(path.join(__dirname, "copy-assets.mjs"), "utf8");
const installer = readFileSync(path.join(__dirname, "../../../scripts/install-openleash-personal.sh"), "utf8");
const canonicalPresentations = JSON.parse(
  readFileSync(path.join(__dirname, "../../../packages/shared/feature-presentations.json"), "utf8"),
) as Array<{ id: string; slug: string; name: string; description: string }>;
const mobilePresentationsPath = path.join(
  __dirname,
  "../../mobile-client/lib/feature_presentations.g.dart",
);
const mobilePresentations = existsSync(mobilePresentationsPath)
  ? readFileSync(mobilePresentationsPath, "utf8")
  : null;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("one canonical presentation supplies every built-in Feature surface", () => {
  assert.equal(canonicalPresentations.length, 8);
  assert.equal(new Set(canonicalPresentations.map((feature) => feature.id)).size, 8);
  assert.equal(new Set(canonicalPresentations.map((feature) => feature.name)).size, 8);
  assert.deepEqual(canonicalPresentations.map((feature) => feature.name), [
    "Destructive Protection",
    "Code Protection",
    "Private Data Protection",
    "Secret Protection",
    "Prompt Injection Protection",
    "Tool Protection",
    "Rules Protection",
    "Token Saver",
  ]);
  assert.equal(canonicalPresentations.some((feature) => /^Leash\b/.test(feature.name)), false);
  if (mobilePresentations) {
    for (const feature of canonicalPresentations) {
      assert.match(mobilePresentations, new RegExp(escapeRegExp(feature.name)));
      assert.match(mobilePresentations, new RegExp(escapeRegExp(feature.description)));
    }
  }
  assert.match(renderer, /__LEASH_FEATURE_PRESENTATIONS__/);
  assert.match(copyAssets, /feature-presentations\.json/);
  assert.match(copyAssets, /replace\(\s*"__LEASH_FEATURE_PRESENTATIONS__"/);
  assert.match(copyAssets, /copyWorkspaceRuntimeDependencies\(\)/);
  assert.match(copyAssets, /"@openleash", "shared"/);
});

test("setup showcases Features without installation controls", () => {
  const setupCards = renderer.slice(
    renderer.indexOf("function setupFeatureShowcaseCards()"),
    renderer.indexOf("function setupPluginInstallCards()", renderer.indexOf("function setupFeatureShowcaseCards()")),
  );
  assert.match(setupCards, /setupFeatureGrid/);
  assert.match(setupCards, /setupFeatureCard/);
  assert.match(setupCards, /<strong>\$\{escapeHtml\(pluginName\(plugin\)\)\}<\/strong>/);
  assert.match(setupCards, /On automatically/);
  assert.doesNotMatch(setupCards, /<input|checkbox|data-plugin-install|\bEnable\b|\bDisable\b/);
  assert.match(renderer, /\.setupFeatureGrid\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test("desktop groups built-in Features into plain-language Safety and Cost control sections", () => {
  assert.match(renderer, /\{ id: "protection", label: "Safety"/);
  assert.match(renderer, /\{ id: "cost", label: "Cost control"/);
  assert.doesNotMatch(renderer, /\{ id: "security", label: "Security"/);
});

test("desktop exposes goal-aware and strict interruption modes with plain-language copy", () => {
  for (const pluginId of ["openleash.dlp", "openleash.sensitive-access", "openleash.blast-radius"]) {
    const plugin = bundledFirstPartyPlugins.find((item) => item.id === pluginId);
    assert.ok(plugin, pluginId);
    assert.equal(plugin.defaultConfig?.contextMode, "goal-aware", pluginId);
    const properties = plugin.configSchema?.properties as Record<string, { enum?: string[] }> | undefined;
    assert.deepEqual(properties?.contextMode?.enum, ["goal-aware", "strict"], pluginId);
  }
  assert.match(renderer, /Goal-aware: Ask only when Leash cannot confirm the action is needed for your current task\./);
  assert.match(renderer, /Strict: Ask every time this protection matches\./);
});

test("macOS tray keeps the original colored Leash icon with stable placement", () => {
  assert.match(copyAssets, /openleash-icon\.png/);
  assert.match(copyAssets, /tray-icon\.png/);
  assert.match(copyAssets, /const trayIconCornerRadius = 14/);
  assert.match(desktopMain, /image\.setTemplateImage\(false\)/);
  assert.doesNotMatch(desktopMain, /image\.setTemplateImage\(true\)/);
  assert.match(desktopMain, /new Tray\(image, MAC_TRAY_GUID\)/);
});

test("desktop navigation remains reachable in short windows", () => {
  assert.match(renderer, /--sidebar-width: clamp\(280px, 25vw, 340px\)/);
  assert.match(renderer, /grid-template-columns: var\(--sidebar-width\) minmax\(0, 1fr\)/);
  assert.match(renderer, /nav\s*\{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;[\s\S]*?overflow-y: auto;/);
  assert.match(renderer, /overscroll-behavior: contain/);
  assert.match(renderer, /button, input, label, nav, main, aside,[\s\S]*?-webkit-app-region: no-drag/);
  assert.match(renderer, /nav button\.navPlugin \.navLabel\s*\{[\s\S]*?white-space: normal;/);
  assert.match(renderer, /id="sidebarExpand"/);
  assert.match(renderer, /appShell\.classList\.toggle\("sidebar-expanded", sidebarExpanded\)/);
  assert.match(renderer, /\.app\.sidebar-expanded nav button \.navLabel[\s\S]*?white-space: normal/);
  assert.match(renderer, /\.foot\s*\{[\s\S]*?flex: 0 0 auto;/);
});

test("Settings can exclude a project from local monitoring without weakening other projects", () => {
  assert.match(renderer, /Projects Leash leaves alone/);
  assert.match(renderer, /id="addExcludedProject">Choose folder<\/button>/);
  assert.match(renderer, /data-remove-excluded-project/);
  assert.match(renderer, /window\.openleash\.chooseExcludedProject\(\)/);
  assert.match(renderer, /window\.openleash\.removeExcludedProject/);
  assert.match(preload, /chooseExcludedProject: \(\) => ipcRenderer\.invoke\("openleash:choose-excluded-project"\)/);
  assert.match(desktopMain, /localServer\.addExcludedProjectPath/);
  assert.match(desktopMain, /localServer\.removeExcludedProjectPath/);
});

test("the Island exposes permanent protection scope for every live project", () => {
  assert.match(islandRenderer, /Protected right now/);
  assert.match(islandRenderer, /Deselect a project to let it run outside Leash/);
  assert.match(islandRenderer, /sessionProjectProtectionToggle\(session\)/);
  assert.match(islandRenderer, /bridge\.setProjectProtection\(\{ projectPath, protected: protectedNow \}\)/);
  assert.match(preload, /setProjectProtection: \(payload: unknown\) => ipcRenderer\.invoke\("openleash:set-project-protection", payload\)/);
  assert.match(desktopMain, /canSetProjectProtection: Boolean\(session\.projectPath\)/);
  assert.match(desktopMain, /projectProtected: !localServer\.isProjectExcluded\(session\.projectPath\)/);
  assert.match(desktopMain, /ipcMain\.handle\("openleash:set-project-protection"/);
  assert.match(desktopMain, /function setProjectProtection\(payload: unknown\)/);
});

test("Settings can fully disconnect this Mac and return to setup", () => {
  assert.match(renderer, /id="disconnectClient">Disconnect this Mac<\/button>/);
  assert.match(renderer, /window\.openleash\.disconnectClient\(\)/);
  assert.match(preload, /disconnectClient: \(\) => ipcRenderer\.invoke\("openleash:disconnect-client"\)/);
  const disconnectHandler = desktopMain.slice(
    desktopMain.indexOf('ipcMain.handle("openleash:disconnect-client"'),
    desktopMain.indexOf('ipcMain.handle("openleash:delete-data-and-settings"'),
  );
  assert.match(disconnectHandler, /await removeDesktopMonitoring\(\)/);
  assert.match(disconnectHandler, /localServer\.clearSettings\(\)/);
  assert.match(disconnectHandler, /desktopAuthSession = undefined/);
  assert.match(disconnectHandler, /relaunchOpenLeash\(\)/);
  assert.match(desktopMain, /openAtLogin: localServer\.setupComplete/);
});

test("Settings can completely uninstall Leash and its local runtime on macOS", () => {
  assert.match(renderer, /id="uninstallApplication">Uninstall Leash<\/button>/);
  assert.match(renderer, /window\.openleash\.uninstallApplication\(\)/);
  assert.match(preload, /uninstallApplication: \(\) => ipcRenderer\.invoke\("openleash:uninstall-application"\)/);
  const uninstallHandler = desktopMain.slice(
    desktopMain.indexOf('ipcMain.handle("openleash:uninstall-application"'),
    desktopMain.indexOf('ipcMain.handle("openleash:delete-data-and-settings"'),
  );
  assert.match(uninstallHandler, /await cleanupDesktopIntegrations\(\)/);
  assert.match(uninstallHandler, /startCompleteMacUninstall\(runtimeDir\)/);
  assert.match(desktopMain, /\[helper, "--uninstall", "--target", installDirectory, "--quiet"\]/);
  assert.match(desktopMain, /setTimeout\(quitOpenLeash, 100\)/);
  assert.match(installer, /uninstallAllAgentProtections\(\)/);
  assert.match(installer, /uninstallLocalProxy\(\)/);
  assert.match(installer, /compose down -v --remove-orphans/);
  assert.match(installer, /docker image rm -f/);
  assert.match(installer, /Application Support\/Leash/);
  assert.match(installer, /Preferences\/com\.openleash\.personal\.plist/);
  assert.match(installer, /HTTPStorages\/com\.openleash\.personal/);
});

test("Settings disclosures stay open across background state refreshes", () => {
  assert.match(renderer, /const openSettingsDisclosureIds = new Set\(\)/);
  assert.match(renderer, /details\.settingsDisclosure\[id\]/);
  assert.match(renderer, /id="dangerDisclosure" \$\{openSettingsDisclosureIds\.has\("dangerDisclosure"\) \? "open" : ""\}/);
  assert.match(renderer, /details\.ontoggle = \(\) =>/);
});

test("desktop Overview focuses on monitored activity and Agents owns enablement", () => {
  assert.match(renderer, /function overviewActivitySummary\(inventory\)/);
  assert.match(renderer, /function overviewActivitySnapshotHtml\(summary, inventory\)/);
  assert.match(renderer, /Actions monitored/);
  assert.match(renderer, /Threats blocked/);
  assert.match(renderer, /Passed safely/);
  assert.match(renderer, /Approved by you/);
  assert.doesNotMatch(renderer, /Automatically approved/);
  assert.match(renderer, /Threats and sensitive actions/);
  assert.match(renderer, /Agents by kind/);
  assert.match(renderer, /\{ view: "agents", label: "Agents" \}/);
  assert.match(renderer, /class="card overviewAgentsHead"/);
  assert.match(renderer, /function overviewDeviceHtml\(\)/);
  assert.match(renderer, /<img src="devices\/\$\{device\.image\}"/);
  assert.match(renderer, /Synced \$\{escapeHtml\(synced\)\}/);
  assert.match(renderer, /agent \? agentIcon\(agent\)/);
  const overview = renderer.slice(renderer.indexOf("function renderOverview()"), renderer.indexOf("function cloudTrialBannerHtml()"));
  assert.match(overview, /overviewDeviceRow/);
  assert.match(overview, /overviewDeviceHtml\(\)/);
  assert.doesNotMatch(overview, /overviewAgentGrid|data-overview-agent/);
  const agents = renderer.slice(renderer.indexOf("function renderAgents()"), renderer.indexOf("function renderUsage()"));
  assert.match(agents, /overviewAgentGrid/);
  assert.doesNotMatch(agents, /overviewDeviceHtml\(\)/);
  assert.match(agents, /bindAgentMonitoringSwitches\(renderAgents\)/);
  assert.match(renderer, /id="backOverview">Agents<\/button>/);
  assert.match(copyAssets, /copyDeviceImages\(\)/);
  assert.match(copyAssets, /windows-desktop\.png/);
});

test("Feature details use a consistent status switch, Summary, and audit history", () => {
  const detail = renderer.slice(renderer.indexOf("function renderPluginDetail()"), renderer.indexOf("function renderPluginRuleImport()"));
  assert.match(detail, /role="switch" aria-checked=/);
  assert.match(detail, /data-feature-state/);
  assert.match(detail, />Summary<\/button>/);
  assert.match(detail, /Protection activity/);
  assert.match(detail, /Actions monitored/);
  assert.match(detail, /Passed safely/);
  assert.match(detail, /pluginAuditColumns/);
  assert.match(detail, /Protection history/);
  assert.match(detail, /pluginSettingsSurface/);
  assert.doesNotMatch(detail, /At a glance|Built into Leash/);
});

test("setup explains Features in consumer language", () => {
  assert.match(renderer, /\{ id: "features", title: "Your protection"/);
  assert.match(renderer, /const currentId = current\.id \|\| current\.title\.toLowerCase\(\)/);
  assert.match(renderer, /Your protection/);
  assert.match(renderer, /Meet the built-in Features Leash turns on automatically/);
  assert.match(renderer, /Protection, already switched on/);
  assert.match(renderer, /Leash is the antivirus for AI/);
  assert.match(renderer, /Leash starts protecting you right away/);
  assert.match(renderer, /When should Leash warn you\?/);
  assert.match(renderer, /Most code changes/);
  assert.doesNotMatch(renderer, /Minimum Code Characters|Notification Risk Threshold/);
});

test("Feature settings keep technical controls behind a plain Advanced layer", () => {
  assert.match(renderer, /<summary>Advanced settings<\/summary>/);
  assert.match(renderer, /The recommended values are safe to keep/);
  assert.match(renderer, /Exact warning score \(0–100\)/);
  assert.match(renderer, /Evaluation model override/);
  assert.match(renderer, /const advancedOnlySettingKeys = new Set/);
  assert.match(renderer, /const advancedExactSettingKeys = new Set/);
});
