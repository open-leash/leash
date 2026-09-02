import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalOpenLeashServer } from "./local-server";

test("the loopback control plane requires its per-install bearer and never exposes it", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openleash-local-auth-"));
  const server = new LocalOpenLeashServer(dataDir, { apiPort: 0, legacyAuthPort: 0 });
  server.completeSetup([], {
    clientMode: "cloud",
    remoteApiUrl: "https://api.example.test",
    remoteToken: "remote-cloud-token",
  });
  await server.start();
  try {
    const health = await fetch(new URL("/health", server.apiUrl));
    assert.equal(health.status, 200);
    assert.equal(health.headers.has("access-control-allow-origin"), false);

    for (const request of [
      new Request(new URL("/personal/state", server.apiUrl)),
      new Request(new URL("/admin/tray-status", server.apiUrl)),
      new Request(new URL("/personal/policies", server.apiUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"policies":[]}',
      }),
      new Request(new URL("/v1/evaluate", server.apiUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ]) {
      const response = await fetch(request);
      assert.equal(response.status, 401);
      assert.equal(response.headers.has("access-control-allow-origin"), false);
    }

    const remoteCredential = await fetch(new URL("/personal/state", server.apiUrl), {
      headers: { authorization: "Bearer remote-cloud-token" },
    });
    assert.equal(remoteCredential.status, 401, "a Cloud credential must not authenticate to the local edge");

    const stateResponse = await fetch(new URL("/personal/state", server.apiUrl), {
      headers: { authorization: `Bearer ${server.token}` },
    });
    assert.equal(stateResponse.status, 200);
    assert.equal(stateResponse.headers.has("access-control-allow-origin"), false);
    const state = await stateResponse.json() as Record<string, unknown>;
    assert.equal("token" in state, false, "local state must never serialize its bearer credential");

    const tray = await fetch(new URL("/admin/tray-status", server.apiUrl), {
      headers: { authorization: `Bearer ${server.token}` },
    });
    assert.equal(tray.status, 200);
  } finally {
    await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
