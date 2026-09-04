#!/usr/bin/env node
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";

if (process.platform !== "darwin") {
  console.log("native macOS island verification skipped on this platform");
  process.exit(0);
}

const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const executable = path.resolve(valueAfter("--executable") ?? "dist/openleash-island");
const html = path.resolve(valueAfter("--html") ?? "dist/notice.html");
await Promise.all([access(executable), access(html)]);

const displayMode = process.argv.includes("--notch") ? "notch" : process.argv.includes("--plain") ? "plain" : undefined;
const child = spawn(executable, [html], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ...(displayMode ? { OPENLEASH_ISLAND_TEST_DISPLAY: displayMode } : {}) },
});
const lines = readline.createInterface({ input: child.stdout });
const messages = [];
const waiters = [];
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const waiterIndex = waiters.findIndex((waiter) => waiter.type === message.type);
  if (waiterIndex >= 0) waiters.splice(waiterIndex, 1)[0].resolve(message);
  else messages.push(message);
});

function waitFor(type, timeoutMs = 5000) {
  const existingIndex = messages.findIndex((message) => message.type === type);
  if (existingIndex >= 0) return Promise.resolve(messages.splice(existingIndex, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { type, resolve };
    waiters.push(waiter);
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`Timed out waiting for native island ${type}`));
    }, timeoutMs);
    waiter.resolve = (message) => { clearTimeout(timer); resolve(message); };
  });
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function inspectAfter(delayMs) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  send({ type: "inspect" });
  return waitFor("state");
}

async function waitForMousePassthrough(point, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    send({ type: "hitTest", ...point });
    result = await waitFor("hitTestResult");
    if (result.ignoresMouseEvents) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return result;
}

try {
  await waitFor("ready");
  send({ type: "show", payload: {
    kind: "completed",
    agentName: "Claude Code",
    title: "Claude finished",
    summary: "All tests pass.",
    project: "openleash",
    time: "now",
  } });
  const compact = await inspectAfter(450);
  assert.equal(compact.visible, true);
  assert.equal(compact.layout.backgroundColor, "rgb(0, 0, 0)");
  assert.equal(compact.frame.topInset, 0);
  if (compact.display.hasNotch) assert.ok(compact.frame.width >= 485 && compact.frame.width <= 500, `unexpected notched compact width ${compact.frame.width}`);
  else assert.ok(compact.frame.width >= 300 && compact.frame.width <= 315, `unexpected compact width ${compact.frame.width}`);
  assert.ok(compact.frame.height < (compact.display.hasNotch ? 210 : 175), `unexpected compact height ${compact.frame.height}`);
  assert.equal(compact.layout.contentClearsNotch, true);
  assert.ok(compact.hitTest?.interactiveBounds, "native island did not report its visible hit target");
  const visibleBounds = compact.hitTest.interactiveBounds;
  send({
    type: "hitTest",
    x: visibleBounds.x + visibleBounds.width / 2,
    y: visibleBounds.y + visibleBounds.height / 2,
  });
  const visibleHit = await waitFor("hitTestResult");
  assert.equal(visibleHit.ignoresMouseEvents, false, "the visible island does not accept clicks");
  send({
    type: "hitTest",
    x: visibleBounds.x + visibleBounds.width / 2,
    y: Math.min(compact.frame.height - 1, visibleBounds.y + visibleBounds.height + 20),
  });
  const transparentHit = await waitFor("hitTestResult");
  assert.equal(transparentHit.ignoresMouseEvents, true, "transparent space below the island blocks clicks");
  const visiblePoint = {
    x: visibleBounds.x + visibleBounds.width / 2,
    y: visibleBounds.y + visibleBounds.height / 2,
  };
  const transparentPoint = {
    x: visiblePoint.x,
    y: Math.min(compact.frame.height - 1, visibleBounds.y + visibleBounds.height + 20),
  };
  send({ type: "pointerSequence", active: true, ...transparentPoint });
  const pointerDown = await waitFor("pointerSequenceResult");
  assert.equal(pointerDown.ignoresMouseEvents, false, "the island released hit testing during mouse down");
  send({ type: "hitTest", ...transparentPoint });
  const draggedOutside = await waitFor("hitTestResult");
  assert.equal(draggedOutside.ignoresMouseEvents, false, "the island released a click after its bounds changed");
  send({ type: "pointerSequence", active: false, ...transparentPoint });
  const pointerUp = await waitFor("pointerSequenceResult");
  assert.equal(pointerUp.ignoresMouseEvents, false, "the island released hit testing on mouse up");
  send({ type: "hitTest", ...transparentPoint });
  const releaseGrace = await waitFor("hitTestResult");
  assert.equal(releaseGrace.ignoresMouseEvents, false, "the island did not absorb the end of the click sequence");
  const passthroughRestored = await waitForMousePassthrough(transparentPoint);
  assert.equal(passthroughRestored.ignoresMouseEvents, true, "transparent-space passthrough did not resume after the click");
  if (compact.display.hasNotch) {
    assert.ok(compact.display.safeTop > 0, "notched display did not report a safe top inset");
    assert.ok(compact.layout.contentTop >= compact.display.safeTop, `compact content overlaps notch: ${compact.layout.contentTop} < ${compact.display.safeTop}`);
  }

  send({ type: "show", payload: {
    kind: "install_success",
    agentName: "OpenLeash",
    title: "Installation complete",
    project: "ready",
  } });
  const installed = await inspectAfter(900);
  assert.equal(installed.visible, true);
  assert.equal(installed.layout.fireworksRendered, true, "installation popup did not render the fireworks SVG");
  assert.equal(installed.layout.installNextVisible, true, "installation popup did not offer the next onboarding step");
  assert.equal(installed.layout.socialFollowVisible, false, "social follow step appeared before installation confirmation");
  send({ type: "advanceInstallSuccess" });
  const socialFollow = await inspectAfter(350);
  assert.equal(socialFollow.layout.expanded, true, "social follow step did not remain in the expanded island");
  assert.equal(socialFollow.layout.socialFollowVisible, true, "social follow step did not appear after installation confirmation");
  assert.equal(socialFollow.layout.socialCardCount, 2, "social follow step did not show both social destinations");
  assert.equal(socialFollow.layout.socialLogoCount, 2, "social follow cards did not render their official logos");
  assert.equal(socialFollow.layout.socialHeading, "Stay protected and informed", "social follow step did not explain its safety value");
  assert.equal(socialFollow.layout.socialDescription, "Follow Leash for security alerts, new protections and agent updates.", "social follow step did not describe the updates users will receive");
  send({ type: "clickSocialX" });
  const socialAction = await waitFor("action");
  assert.equal(socialAction.action, "island-command", "social follow card did not use the island command bridge");
  assert.equal(socialAction.command, "social-x", "X card did not request the fixed OpenLeash X destination");
  send({ type: "clickSocialLinkedIn" });
  const linkedInAction = await waitFor("action");
  assert.equal(linkedInAction.action, "island-command", "LinkedIn card did not use the island command bridge");
  assert.equal(linkedInAction.command, "social-linkedin", "LinkedIn card did not request the fixed OpenLeash LinkedIn destination");

  send({ type: "show", payload: {
    kind: "install_success",
    agentName: "OpenLeash",
    title: "Installation complete",
    project: "ready",
    restartTargets: [
      { id: "application:vscode", application: "Visual Studio Code", icon: "agent-icons/vscode.png", agentNames: ["OpenAI Codex"], projects: [{ name: "OL2", path: "/Users/max/Code/OL2" }] },
      { id: "application:cursor", application: "Cursor", icon: "agent-icons/cursor.svg", agentNames: ["Cursor"], projects: [{ name: "Website", path: "/Users/max/Code/Website" }] },
    ],
  } });
  await inspectAfter(350);
  send({ type: "advanceInstallSuccess" });
  const restartAgents = await inspectAfter(350);
  assert.equal(restartAgents.layout.restartAgentsVisible, true, "running-agent restart step did not appear after installation confirmation");
  assert.equal(restartAgents.layout.restartTargetCount, 2, "running-agent restart step did not show every detected application");
  assert.equal(restartAgents.layout.restartSelectedCount, 2, "running-agent restart targets were not selected by default");
  assert.equal(restartAgents.layout.restartButtonVisible, true, "running-agent restart step did not offer a restart button");

  send({ type: "show", payload: {
    kind: "activity",
    agentName: "OpenLeash",
    title: "3 agents working",
    project: "3 active sessions",
    sessions: [
      { id: "claude", sessionId: "claude-session", sourceSessionIds: ["claude-session"], agentKind: "claude-code", agentName: "Claude Code", visualState: "running", project: "client-api", title: "Test Claude", latestAction: "Running tests", eventCount: 3, canPauseMonitoring: true },
      { id: "codex", sessionId: "codex-session", agentKind: "codex", agentName: "OpenAI Codex", visualState: "processing", project: "desktop", title: "Test Codex", latestAction: "Editing files", eventCount: 5, contributions: [{ pluginId: "openleash.blast-radius", pluginName: "blast-radius", pluginIcon: "💥", kind: "annotation", label: "Destructive operation", tone: "danger" }, { pluginId: "openleash.prompt-compression", pluginName: "token-saver", pluginIcon: "✂️", kind: "annotation", label: "token-saver", value: "42% saved", tone: "success" }] },
      { id: "gemini", agentKind: "gemini", agentName: "Gemini CLI", visualState: "processing", project: "docs", title: "Test Gemini", latestAction: "Reading docs", eventCount: 2 },
    ],
    tokenSaver: { pluginId: "openleash.prompt-compression", pluginName: "token-saver", value: "42% saved", tone: "success" },
    contributions: [{ pluginId: "community.tests", pluginName: "test-progress", kind: "status", title: "Tests running", tone: "info", progress: { current: 3, total: 5 } }],
  } });
  const activity = await inspectAfter(650);
  assert.equal(activity.visible, true);
  assert.equal(activity.layout.sessionCount, 3, "activity island did not render every active session");
  assert.equal(activity.layout.activityDetailVisible, false, "multi-session activity opened a detail without selection");
  assert.equal(activity.layout.historyButtonVisible, true, "activity island did not offer optional history");
  assert.equal(activity.layout.pauseMonitoringButtonVisible, true, "selected conversation did not offer a temporary monitoring pause");
  assert.equal(activity.layout.monitoringButtonInsideSessionCard, true, "monitoring pause is not inside the conversation card");
  send({ type: "clickPauseMonitoring" });
  const pauseMonitoring = await waitFor("action");
  assert.equal(pauseMonitoring.action, "session-monitoring", "conversation pause did not use the native island bridge");
  assert.equal(pauseMonitoring.payload?.paused, true, "conversation pause did not request the paused state");
  assert.equal(pauseMonitoring.payload?.session?.sessionId, "claude-session", "conversation pause lost the exact session identifier");
  assert.ok(activity.layout.contributionCount >= 2, "activity island did not render plugin contributions");
  assert.equal(activity.layout.notchAgentCount, 3, "notch rail did not render active agent icons");
  assert.equal(activity.layout.capAgentCount, 3, "plain-display compact pill did not render active agent icons");
  assert.ok(activity.layout.animatedAgentCount >= 6, "agent icons did not receive the animated avatar treatment");
  assert.ok(activity.layout.mascotCount >= 4, "Claude and Codex did not render their pixel mascots");
  assert.equal(activity.layout.sessionMascotJumpCount, 3, "session mascots are not clickable jump targets");
  assert.ok(activity.layout.mascotStates.includes("running") && activity.layout.mascotStates.includes("processing"), "mascots did not receive state-specific animation modes");
  assert.match(activity.layout.notchTokenSaving, /42% saved/, "notch rail did not render token savings");
  assert.match(activity.layout.capTokenSaving, /42% saved/, "compact header did not retain token savings for displays without a notch");
  assert.equal(activity.layout.compactProgressVisible, true, "compact island did not expose plugin progress");
  assert.ok(
    activity.layout.compactProgressPercent >= 58 && activity.layout.compactProgressPercent <= 62,
    `compact plugin progress is not 3 of 5: ${activity.layout.compactProgressPercent}%`,
  );
  assert.equal(activity.layout.backgroundColor, "rgb(0, 0, 0)", "activity island background is not black");
  assert.equal(activity.layout.islandWidth, activity.layout.activityCompactWidth, "collapsed activity island did not use its measured content width");
  if (activity.display.hasNotch) {
    assert.ok(
      activity.layout.notchAgentLeftGap <= 14,
      `agent icon is not left-aligned: ${activity.layout.notchAgentLeftGap}px`,
    );
    assert.equal(activity.layout.islandHeight, activity.display.safeTop, "notched compact activity grew below the hardware notch");
    assert.ok(activity.layout.islandWidth < 430, `notched compact activity retained the oversized fixed width: ${activity.layout.islandWidth}`);
    assert.ok(activity.layout.islandWidth >= activity.display.notchWidth, "notched compact activity is narrower than the hardware notch");
    assert.equal(activity.layout.islandBorderRadius, "0px 0px 18px 18px", "notched compact activity does not have rounded lower corners");
  } else {
    assert.ok(activity.layout.islandHeight >= 42 && activity.layout.islandHeight <= 55, `plain compact activity height is not one line: ${activity.layout.islandHeight}`);
    assert.ok(activity.layout.islandWidth >= 112 && activity.layout.islandWidth <= 360, `plain compact activity escaped its content-fit bounds: ${activity.layout.islandWidth}`);
    assert.notEqual(activity.layout.islandBorderRadius, "0px", "plain compact activity has square corners");
  }
  send({ type: "expandActivity" });
  const expandedActivity = await inspectAfter(450);
  assert.equal(expandedActivity.layout.expanded, true, "compact activity rail did not expand");
  assert.ok(expandedActivity.layout.islandHeight > activity.layout.islandHeight, "expanded activity did not reveal its details");
  assert.ok(expandedActivity.layout.islandWidth > activity.layout.islandWidth, "expanded activity did not grow wider than its compact content");
  if (expandedActivity.display.hasNotch) {
    assert.ok(
      expandedActivity.layout.notchAgentLeftGap <= 14,
      `expanded agent icon is not left-aligned: ${expandedActivity.layout.notchAgentLeftGap}px`,
    );
    assert.ok(
      expandedActivity.layout.notchTokenRightGap <= 14,
      `token-saver metric is not right-aligned: ${expandedActivity.layout.notchTokenRightGap}px`,
    );
  }
  send({ type: "pointerInside" });
  const pointerInside = await waitFor("pointerInsideResult");
  assert.equal(pointerInside.applied, true, "hover verification command was not applied by the island renderer");
  assert.equal(pointerInside.inside, true, "hover verification command applied the wrong pointer state");
  send({ type: "show", payload: {
    kind: "activity",
    agentName: "OpenLeash",
    title: "3 agents working",
    project: "3 active sessions",
    sessions: [
      { id: "claude", agentKind: "claude-code", agentName: "Claude Code", visualState: "completed", project: "client-api", title: "Test Claude", latestAction: "Tests finished", eventCount: 4 },
      { id: "codex", sessionId: "codex-session", agentKind: "codex", agentName: "OpenAI Codex", visualState: "completed", project: "desktop", title: "Test Codex", latestAction: "Edits finished", eventCount: 5 },
      { id: "gemini", agentKind: "gemini", agentName: "Gemini CLI", visualState: "completed", project: "docs", title: "Test Gemini", latestAction: "Review finished", eventCount: 2 },
    ],
    tokenSaver: { pluginId: "openleash.prompt-compression", pluginName: "token-saver", value: "42% saved", tone: "success" },
  } });
  const hoveredUpdate = await inspectAfter(450);
  assert.equal(hoveredUpdate.layout.pointerInsideIsland, true, "hover verification did not reach the island renderer");
  assert.equal(hoveredUpdate.layout.expanded, true, "a completion refresh collapsed the island while the pointer was inside");
  send({ type: "pointerOutside" });
  const pointerOutside = await waitFor("pointerInsideResult");
  assert.equal(pointerOutside.applied, true, "pointer-leave verification command was not applied by the island renderer");
  assert.equal(pointerOutside.inside, false, "pointer-leave verification command applied the wrong pointer state");
  send({ type: "clickSessionMascot" });
  const jump = await waitFor("action");
  assert.equal(jump.action, "jump", "clicking a mascot did not request a session jump");
  assert.equal(jump.payload?.session?.id, "claude", "mascot jump did not preserve the exact selected session");
  const mascotJumpCollapsed = await inspectAfter(350);
  assert.equal(mascotJumpCollapsed.visible, true, "jumping to an agent hid the persistent island");
  assert.equal(mascotJumpCollapsed.layout.expanded, false, "jumping to an agent did not collapse the island");
  send({ type: "expandActivity" });
  await inspectAfter(350);
  send({ type: "openMenu" });
  const activityMenu = await inspectAfter(350);
  assert.equal(activityMenu.layout.menuOpen, true, "island controls menu did not open");
  assert.equal(activityMenu.layout.menuItemCount, 7, "island controls menu is missing tray actions");
  assert.equal(activityMenu.layout.menuFitsIsland, true, "island controls menu was clipped by the panel");
  send({ type: "openMenu" });
  send({ type: "expandActivity" });
  const collapsedActivity = await inspectAfter(450);
  assert.equal(collapsedActivity.layout.expanded, false, "expanded activity did not collapse again");
  assert.equal(collapsedActivity.layout.islandWidth, collapsedActivity.layout.activityCompactWidth, "collapsed activity did not return to its measured content width");

  send({ type: "show", payload: {
    kind: "activity",
    agentName: "OpenLeash",
    title: "Agent working",
    project: "1 active session",
    sessions: [
      { id: "claude-only", agentKind: "claude-code", agentName: "Claude Code", project: "client-api", title: "Test Claude", latestAction: "Running tests", eventCount: 3 },
    ],
  } });
  const singleAgentActivity = await inspectAfter(650);
  assert.equal(singleAgentActivity.layout.sessionCount, 1, "single-agent compact fixture did not render");
  assert.ok(singleAgentActivity.layout.islandWidth < activity.layout.islandWidth, `compact island did not shrink with less content: ${singleAgentActivity.layout.islandWidth} >= ${activity.layout.islandWidth}`);

  send({ type: "show", payload: {
    kind: "completed",
    agentName: "Claude Code",
    agentKind: "claude-code",
    title: "Claude Code finished",
    summary: "The latest turn completed.",
    project: "client-api",
    visualState: "completed",
    canJump: true,
  } });
  const completed = await inspectAfter(500);
  assert.equal(completed.visible, true, "completed state hid the persistent island");
  assert.equal(completed.layout.expanded, false, "completed state opened a large panel over the finished agent");
  assert.ok(completed.layout.mascotStates.includes("completed"), "completed state did not use the agent mascot");
  assert.equal(completed.layout.capAgentCount, 1, "completed state did not render in the compact island");

  send({ type: "show", payload: {
    kind: "activity",
    agentName: "OpenLeash",
    title: "Agent finished",
    project: "1 recent session",
    sessions: [{
      id: "claude-recent",
      agentKind: "claude-code",
      agentName: "Claude Code",
      visualState: "completed",
      project: "MyProj",
      title: "hey man",
      latestAction: "Hey! What are you working on today?",
      eventCount: 2,
    }],
  } });
  const recentCompleted = await inspectAfter(500);
  assert.equal(recentCompleted.visible, true, "recent completed session hid the persistent island");
  assert.equal(recentCompleted.layout.sessionCount, 1, "recent completed session disappeared from the island");
  assert.ok(recentCompleted.layout.mascotStates.includes("completed"), "recent session did not keep the completed Claude mascot");
  send({ type: "expandActivity" });
  const expandedRecentCompleted = await inspectAfter(400);
  assert.equal(expandedRecentCompleted.layout.sessionSectionLabel, "Recent sessions", "completed session was mislabeled as live");
  assert.equal(expandedRecentCompleted.layout.firstSessionTitle, "MyProj · hey man", "completed session lost the user prompt");
  assert.equal(expandedRecentCompleted.layout.firstSessionAction, "Hey! What are you working on today?", "completed session lost the assistant response");
  assert.equal(expandedRecentCompleted.layout.firstSessionStatus, "Done", "completed session still appears active");

  send({ type: "show", payload: {
    kind: "activity",
    agentName: "OpenLeash",
    title: "OpenLeash",
    project: "Watching your agents",
    sessions: [],
    contributions: [],
  } });
  const idle = await inspectAfter(500);
  assert.equal(idle.visible, true, "always-on idle island disappeared");
  assert.equal(idle.layout.sessionCount, 0, "idle island rendered a fake active session");
  assert.equal(idle.layout.expanded, false, "idle island remained expanded after the agent finished");
  assert.equal(idle.layout.notchAgentCount, 1, "idle island did not keep its OpenLeash glyph");
  assert.equal(idle.layout.capAgentCount, 1, "plain idle island did not keep its OpenLeash glyph");
  assert.equal(idle.layout.idleAnimatedPartCount, 0, "idle OpenLeash glyph still looks like an active agent");

  const approvalPayload = {
    kind: "activity",
    agentName: "OpenLeash",
    title: "1 approval waiting",
    project: "Claude Code needs your attention",
    sessions: [{ id: "claude-approval", agentKind: "claude-code", agentName: "Claude Code", visualState: "waiting", project: "openleash", title: "Update authentication", latestAction: "Waiting for approval", eventCount: 4 }],
    contributions: [],
    pendingCount: 1,
    attention: {
      kind: "ask",
      id: "verification",
      intentKey: "claude-code|openleash|database-mutation|sqlite",
      agentKind: "claude-code",
      agentName: "Claude Code",
      visualState: "waiting",
      title: "Permission request",
      summary: "Claude wants to edit authentication middleware.",
      evidence: "Edit src/auth/middleware.ts",
      project: "openleash",
      supportsGuidance: true,
      interaction: { type: "approval" },
    },
  };
  send({ type: "show", payload: { ...approvalPayload, autoExpand: false } });
  const smartSuppressed = await inspectAfter(550);
  assert.equal(smartSuppressed.visible, true, "smart suppression hid the persistent island");
  assert.equal(smartSuppressed.layout.expanded, false, "smart suppression expanded over the already focused agent");

  send({ type: "show", payload: { ...approvalPayload, autoExpand: true } });
  const expanded = await inspectAfter(700);
  assert.equal(expanded.visible, true);
  assert.equal(expanded.layout.backgroundColor, "rgb(0, 0, 0)");
  assert.equal(expanded.frame.topInset, 0);
  assert.ok(expanded.frame.width >= 730 && expanded.frame.width <= 740, `unexpected expanded width ${expanded.frame.width}`);
  assert.ok(expanded.frame.height > 300, `unexpected expanded height ${expanded.frame.height}`);
  assert.equal(expanded.layout.attentionVisible, true, "approval was not embedded in the activity island");
  assert.equal(expanded.layout.attentionActionCount, 2, "embedded approval is missing deny/approve controls");
  assert.equal(expanded.layout.contentClearsNotch, true);
  if (expanded.display.hasNotch) {
    assert.ok(expanded.layout.contentTop >= expanded.display.safeTop, `expanded content overlaps notch: ${expanded.layout.contentTop} < ${expanded.display.safeTop}`);
  }

  send({ type: "show", payload: {
    ...approvalPayload,
    autoExpand: false,
    sessions: approvalPayload.sessions.map((session) => ({ ...session, eventCount: session.eventCount + 1, latestAction: "Still waiting for approval" })),
    attention: { ...approvalPayload.attention, id: "verification-proxy-copy" },
  } });
  const stableApproval = await inspectAfter(60);
  assert.equal(stableApproval.layout.expanded, true, "refreshing the same unresolved approval collapsed the island");
  assert.equal(stableApproval.layout.attentionVisible, true, "refreshing the same unresolved approval hid its controls");

  send({ type: "dismiss" });
  const dismissed = await inspectAfter(300);
  assert.equal(dismissed.visible, false);
  console.log(`native macOS island click-through, top-anchor, persistent idle state, unified approvals, animated agents, notch-safe content, fireworks, compact, expansion, and dismissal ok (notch=${compact.display.hasNotch}, safeTop=${compact.display.safeTop})`);
} finally {
  send({ type: "quit" });
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
}
