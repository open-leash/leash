import assert from "node:assert/strict";
import test from "node:test";
import { DECLARED_HOOK_CONNECTORS, hookCapability, hookEventCapabilities } from "./hook-connectors.js";

test("every installed hook agent has its own honest descriptor", () => {
  assert.deepEqual(Object.keys(DECLARED_HOOK_CONNECTORS).sort(), ["claude","codex","copilot","cursor","gemini","nanoclaw","openclaw","opencode"].sort());
  for (const connector of Object.values(DECLARED_HOOK_CONNECTORS)) {
    const descriptor = connector.capability();
    assert.equal(descriptor.connector_class, "interactive");
    assert.equal(descriptor.latency_budget_ms, 300);
    assert.equal(descriptor.can.replace_tool_input, false);
    assert.equal(descriptor.verified_at, undefined);
    assert.ok(descriptor.verification?.every((item) => item.status === "unverified" && !item.verified_at));
  }
});

test("OpenCode and OpenClaw do not inherit events their installers cannot see", () => {
  assert.equal(hookCapability("opencode").can.see_prompt, false);
  assert.equal(hookCapability("opencode").can.block_pre_inference, false);
  assert.equal(hookCapability("openclaw").can.see_tool_request, false);
  assert.equal(hookCapability("openclaw").can.human_approval, false);
});

test("source capabilities are derived per agent without a global rewrite claim", () => {
  assert.deepEqual(hookEventCapabilities("codex"), { observe:true, block:true, rewritePrompt:false, rewriteToolInput:false, rewriteResponse:false });
});

test("fixture self tests remain unverified until a live agent surface passes", async () => {
  const report = await DECLARED_HOOK_CONNECTORS.claude.selfTest();
  assert.match(report.report_id, /fixture-unverified/);
  assert.ok(report.verification.every((item) => item.status === "unverified"));
});
