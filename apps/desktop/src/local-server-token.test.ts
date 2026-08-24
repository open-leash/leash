import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalOpenLeashServer } from "./local-server";

test("the configured local service token survives setup and install resets", async () => {
  const previousToken = process.env.OPENLEASH_DEV_TOKEN;
  const configuredToken = "openleash-local-token-test";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openleash-local-token-"));
  process.env.OPENLEASH_DEV_TOKEN = configuredToken;

  const server = new LocalOpenLeashServer(dataDir, { apiPort: 0, legacyAuthPort: 0 });
  try {
    assert.equal(server.token, configuredToken);

    server.resetSetup();
    assert.equal(server.token, configuredToken);

    assert.equal(server.islandActivityOnly, false, "the Island should stay visible by default");
    assert.equal(server.islandVisibility, "always");
    server.updateSettings("openai", undefined, undefined, undefined, "notifications");
    assert.equal(server.islandVisibility, "notifications");
    server.updateSettings("openai", undefined, undefined, undefined, "off");
    assert.equal(server.islandVisibility, "off");
    server.updateSettings("openai", undefined, undefined, true);
    assert.equal(server.islandActivityOnly, true);
    assert.equal(server.islandVisibility, "activity");
    server.addExcludedProjectPath("/Users/max/Code/OL2");
    assert.deepEqual(server.excludedProjectPaths, ["/Users/max/Code/OL2"]);
    assert.equal(server.isProjectExcluded("/Users/max/Code/OL2/leash"), true);
    server.resetSetup();
    assert.equal(server.islandActivityOnly, true, "setup reset should preserve the Island visibility preference");
    assert.equal(server.islandVisibility, "activity");
    assert.deepEqual(server.excludedProjectPaths, ["/Users/max/Code/OL2"], "setup reset should preserve project exclusions");

    server.completeSetup(server.policies, {
      clientMode: "cloud",
      remoteApiUrl: "https://api.openleash.test",
      remoteToken: "enrolled-client-token",
      remoteOrganization: "Test workspace",
      remoteUser: "test@example.com",
    });
    assert.equal(server.setupComplete, true);
    assert.equal(server.remoteApiUrl, "https://api.openleash.test");
    assert.equal(server.effectiveToken, "enrolled-client-token");
    server.clearSettings();
    assert.equal(server.setupComplete, false, "disconnect should return the app to setup");
    assert.equal(server.remoteApiUrl, undefined);
    assert.equal(server.remoteOrganization, undefined);
    assert.equal(server.effectiveToken, configuredToken, "disconnect should remove the enrolled client token");

    server.resetAllLocalState();
    assert.equal(server.token, configuredToken);
    assert.equal(server.islandActivityOnly, false, "a full settings reset should restore always-on Island visibility");
    assert.equal(server.islandVisibility, "always");
    assert.deepEqual(server.excludedProjectPaths, [], "a full settings reset should clear project exclusions");
  } finally {
    await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env.OPENLEASH_DEV_TOKEN;
    else process.env.OPENLEASH_DEV_TOKEN = previousToken;
  }
});
