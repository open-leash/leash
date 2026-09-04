import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalOpenLeashServer } from "./local-server";

test("Codex provider control hooks are allowed locally without entering policy evaluation", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openleash-background-control-"));
  const server = new LocalOpenLeashServer(dataDir, { apiPort: 0, legacyAuthPort: 0 });
  try {
    await server.start();
    const response = await fetch(new URL("/v1/hooks/codex/UserPromptSubmit", server.apiUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
        "x-openleash-api-function": "localHookEvaluate",
        "x-openleash-api-version": "2026-05-22.local-hook-evaluate.v1",
      },
      body: JSON.stringify({
        session_id: "codex-ambient-suggestions",
        prompt: "You are an expert at upholding safety and compliance standards for Codex ambient suggestions. # Ambient suggestion candidates Here are the candidates. Return suggestions to exclude. You must not output any other text.",
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { decision?: string; reason?: string };
    assert.equal(result.decision, "allow");
    assert.equal(result.reason, "Leash approved this action.");
    assert.equal(server.history.length, 0);
  } finally {
    await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
