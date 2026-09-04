import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const mainSource = fs.readFileSync(path.join(process.cwd(), "src", "main.ts"), "utf8");
const installerSource = fs.readFileSync(
  path.join(process.cwd(), "..", "..", "scripts", "install-openleash-personal.sh"),
  "utf8",
);

test("agent hook configuration uses only the loopback credential", () => {
  const configureBlock = mainSource.match(
    /async function configureLocalAgent\(\) \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(configureBlock, "configureLocalAgent is present");
  assert.match(configureBlock, /token:\s*localServer\.token/);
  assert.doesNotMatch(configureBlock, /token:\s*localServer\.effectiveToken/);
});

test("the provider proxy authenticates to the loopback edge with only the local credential", () => {
  const helperBlock = mainSource.match(
    /async function installProxyForMonitoredAgents\(agents: string\[\]\) \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(helperBlock, "installProxyForMonitoredAgents is present");
  assert.match(helperBlock, /const token = localServer\.token/);
  assert.doesNotMatch(helperBlock, /localServer\.effectiveToken/);

  const ipcBlock = mainSource.match(
    /"openleash:install-proxy",([\s\S]*?)\r?\n  \},\r?\n\);/,
  )?.[1];
  assert.ok(ipcBlock, "install-proxy IPC handler is present");
  assert.match(ipcBlock, /const token = localServer\.token/);
  assert.doesNotMatch(ipcBlock, /localServer\.effectiveToken/);
});

test("an app update restores every previously protected agent", () => {
  assert.match(
    mainSource,
    /const protectedAgentsToRestore = shouldPreserveSettingsForLaunch\(\)/,
  );
  assert.match(
    mainSource,
    /for \(const agentKind of protectedAgentsToRestore\) \{\s*await installAgentProtection\(agentKind, hookInstallContext\(\)\);/,
  );
});

test("the installer launches first-run flags once and preserves hooks during updates", () => {
  assert.match(
    installerSource,
    /open -na "\$TARGET_APP" --args "\$\{args\[@\]\}"/,
  );
  assert.doesNotMatch(installerSource, /launchctl submit/);
  assert.match(
    installerSource,
    /"\$HAD_EXISTING_LOCAL_STATE" -eq 1 && "\$KEEP_SETTINGS" -eq 0/,
  );
});

test("cloud skill decisions are applied to the matching local skill file", () => {
  assert.match(mainSource, /skillPathFromPendingDecision\(pending\)/);
  assert.match(mainSource, /skillPathFromDecisionResponse\(responsePayload\)/);
  assert.match(mainSource, /localServer\.resolveObservedSkill\([\s\S]*pendingSkillPath,[\s\S]*resolution/);
});

test("nested skill discovery avoids non-repositories and cloud-backed project folders", () => {
  const discoveryBlock = mainSource.match(
    /function findNestedSkillDirs\(root: string\) \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(discoveryBlock, "findNestedSkillDirs is present");
  assert.match(
    discoveryBlock,
    /if \(!fs\.existsSync\(path\.join\(repositoryRoot, "\.git"\)\)\) return \[\]/,
  );
  assert.match(discoveryBlock, /path\.join\(os\.homedir\(\), "Documents"\)/);
  assert.match(discoveryBlock, /path\.join\(os\.homedir\(\), "Library", "CloudStorage"\)/);
  assert.match(discoveryBlock, /inspectedDirectoryCount < 2_000/);
});

test("a configured proxy is started immediately when its process is not running", () => {
  assert.match(
    mainSource,
    /proxyStatus = await localProxyStatus\(\);\s*if \(\s*localServer\.setupComplete &&\s*!proxyStatus\.running &&/,
  );
});
