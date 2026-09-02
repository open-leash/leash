import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const mainSource = fs.readFileSync(path.join(process.cwd(), "src", "main.ts"), "utf8");

test("agent hook configuration uses only the loopback credential", () => {
  const configureBlock = mainSource.match(
    /async function configureLocalAgent\(\) \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(configureBlock, "configureLocalAgent is present");
  assert.match(configureBlock, /token:\s*localServer\.token/);
  assert.doesNotMatch(configureBlock, /token:\s*localServer\.effectiveToken/);
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

test("cloud skill decisions are applied to the matching local skill file", () => {
  assert.match(mainSource, /skillPathFromPendingDecision\(pending\)/);
  assert.match(mainSource, /skillPathFromDecisionResponse\(responsePayload\)/);
  assert.match(mainSource, /localServer\.resolveObservedSkill\([\s\S]*pendingSkillPath,[\s\S]*resolution/);
});
