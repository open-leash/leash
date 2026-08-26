import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const html = fs.readFileSync(path.join(__dirname, "window.html"), "utf8");
const desktopMain = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");

test("desktop setup starts with a Personal or Business choice", () => {
  assert.match(html, /\{ title: "Account", subtitle: "Choose Personal or Business\." \}/);
  assert.match(html, /audienceChoice\("individual", "Personal"/);
  assert.match(html, /audienceChoice\("organization", "Business"/);
});

test("Personal setup offers Cloud and Open Source", () => {
  assert.match(html, /connectionChoice\("cloud", orgCloud \? "Leash Business Cloud" : "Leash Cloud"/);
  assert.match(html, /connectionChoice\("custom", "Personal Open Source"/);
});

test("Personal Open Source requires an AI provider before agents are installed", () => {
  assert.match(html, /\{ title: "AI provider", subtitle: "Connect the AI Leash will use for safety checks\." \}/);
  assert.match(html, /Add your AI provider key before continuing\./);
  assert.match(html, /await saveRemoteModelKey\(\)/);
  assert.match(html, /platform\.openai\.com\/api-keys/);
  assert.match(html, /platform\.claude\.com\/settings\/keys/);
  assert.match(html, /api-docs\.deepseek\.com\/api\/deepseek-api/);
});

test("Cloud skips the provider page while Open Source requires it", () => {
  assert.doesNotMatch(html, /\{ title: "Leash AI"/);
  assert.doesNotMatch(html, /currentId === "leash ai"/);
  assert.match(html, /currentId === "ai provider"/);
  assert.doesNotMatch(html, /name="evaluationPackage"/);
  assert.doesNotMatch(html, /Upgrade to Leash AI<\/a>/);
});

test("Business is preserved and restricted to Leash Cloud", () => {
  assert.match(html, /if \(setupAudience === "organization"\) setupClientMode = "cloud";/);
  assert.doesNotMatch(html, /setupAudience = "individual";\s*if \(setupClientMode === "personal"\)/);
  assert.match(html, /setupAudience === "individual" \? connectionChoice\("custom"/);
});

test("Docker is entered only through explicit Personal Open Source setup", () => {
  assert.match(html, /setupAudience === "individual" && setupClientMode === "custom"/);
  assert.match(html, /if \(startLocalBackend\) startLocalBackend\.onclick = \(\) => startSelfHostedRuntime\(\);/);
  assert.match(html, /currentId === "local backend" && setupAudience === "individual" && setupClientMode === "custom"/);
  assert.doesNotMatch(html, /setupClientMode === "cloud"[^\n]*startSelfHostedRuntime/);
});

test("Cloud headers identify the signed-in person", () => {
  assert.match(html, /function headerIdentityHtml\(\)/);
  assert.match(html, /state\.clientMode === "cloud" \? String\(state\.remoteUser \|\| ""\)\.trim\(\) : ""/);
  assert.match(html, /class="cloudAccountUser"/);
  assert.match(html, /\$\{notificationCenterHtml\(\)\}\$\{headerIdentityHtml\(\)\}/);
});

test("Business membership never turns Desktop into an organization admin console", () => {
  assert.doesNotMatch(html, />Employees</);
  assert.doesNotMatch(html, />Identity sync</);
  assert.doesNotMatch(html, />Costs &amp; usage</);
  assert.doesNotMatch(html, />Admin API keys</);
  assert.doesNotMatch(html, />Organization policy</);
  assert.doesNotMatch(html, />Billing administration</);
});

test("Business sign-in uses a restricted grant while preserving normal endpoint enrollment", () => {
  assert.match(desktopMain, /callback\.searchParams\.get\("enrollment_token"\)/);
  assert.match(desktopMain, /token: enrollmentToken \|\| dashboardToken!/);
  assert.match(desktopMain, /desktopAuthSession\?\.token && remoteToken === desktopAuthSession\.token/);
  assert.match(desktopMain, /body\.desktopEnrollmentToken/);
  assert.match(desktopMain, /desktopEnrollment: true/);
});
