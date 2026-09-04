import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  excludedProjectPathsCovering,
  normalizeExcludedProjectPath,
  normalizeExcludedProjectPaths,
  projectPathIsExcluded,
} from "./project-exclusions";
import { LocalOpenLeashServer } from "./local-server";

test("normalizes and de-duplicates explicit project exclusions", () => {
  assert.deepEqual(
    normalizeExcludedProjectPaths([
      " /Users/max/Code/OL2/ ",
      "/Users/max/Code/OL2",
      "/Users/max/Code/Other/../OL2",
      "relative/project",
      "/",
    ]),
    ["/Users/max/Code/OL2"],
  );
  assert.equal(normalizeExcludedProjectPath("C:\\Code\\OL2\\"), "C:/Code/OL2");
  assert.equal(normalizeExcludedProjectPath("\\\\server\\repos\\OL2"), "//server/repos/OL2");
});

test("an excluded project also excludes nested repositories but not siblings", () => {
  const exclusions = ["/Users/max/Code/OL2"];
  assert.equal(projectPathIsExcluded("/Users/max/Code/OL2", exclusions), true);
  assert.equal(projectPathIsExcluded("/Users/max/Code/OL2/leash/apps/desktop", exclusions), true);
  assert.equal(projectPathIsExcluded("/Users/max/Code/OL2-copy", exclusions), false);
  assert.equal(projectPathIsExcluded("/Users/max/Code/Other", exclusions), false);
  assert.equal(projectPathIsExcluded(undefined, exclusions), false);
  assert.deepEqual(
    excludedProjectPathsCovering("/Users/max/Code/OL2/leash", [
      "/Users/max/Code/OL2",
      "/Users/max/Code/Other",
    ]),
    ["/Users/max/Code/OL2"],
  );
});

test("the desktop edge bypasses monitoring and transformation for excluded projects", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openleash-project-exclusion-"));
  const server = new LocalOpenLeashServer(dataDir, { apiPort: 0, legacyAuthPort: 0 });
  try {
    server.addExcludedProjectPath("/Users/max/Code/OL2");
    await server.start();

    const transform = await fetch(new URL("/v1/plugin-runtime/transform", server.apiUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
        "x-openleash-api-function": "containerPluginTransform",
        "x-openleash-api-version": "2026-06-03.container-plugin-transform.v1",
      },
      body: JSON.stringify({
        agentKind: "codex",
        sessionId: "excluded-session",
        projectPath: "/Users/max/Code/OL2/leash",
        requestBody: { input: "leave this unchanged" },
      }),
    });
    assert.equal(transform.status, 200);
    const transformed = await transform.json() as Record<string, unknown>;
    assert.equal(transformed.monitoringPaused, true);
    assert.equal(transformed.projectExcluded, true);
    assert.deepEqual(transformed.requestBody, { input: "leave this unchanged" });

    const compactTransform = await fetch(new URL("/v1/plugin-runtime/transform", server.apiUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentKind: "codex",
        sessionId: "excluded-session",
        projectPath: "/Users/max/Code/OL2/leash",
        prompt: "leave this compact prompt unchanged",
        transcript: [{ role: "user", content: "build a website" }],
      }),
    });
    assert.equal(compactTransform.status, 200);
    const compactResult = await compactTransform.json() as Record<string, unknown>;
    assert.equal(compactResult.finalPrompt, "leave this compact prompt unchanged");
    assert.equal(compactResult.requestBody, undefined);
    assert.equal(compactResult.monitoringPaused, true);

    const hook = await fetch(new URL("/v1/hooks/codex/PreToolUse", server.apiUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
        "x-openleash-api-function": "localHookEvaluate",
        "x-openleash-api-version": "2026-05-22.local-hook-evaluate.v1",
      },
      body: JSON.stringify({
        cwd: "/Users/max/Code/OL2/main-web",
        session_id: "hook-correlated-session",
        tool_name: "exec_command",
      }),
    });
    assert.equal(hook.status, 200);
    assert.equal((await hook.json() as { decision?: string }).decision, "allow");

    const correlatedTransform = await fetch(new URL("/v1/plugin-runtime/transform", server.apiUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentKind: "codex",
        sessionId: "hook-correlated-session",
        requestBody: { input: "provider request without an explicit cwd" },
      }),
    });
    assert.equal(correlatedTransform.status, 200);
    assert.equal((await correlatedTransform.json() as { projectExcluded?: boolean }).projectExcluded, true);
    assert.equal(server.history.length, 0);
  } finally {
    await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
