import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { findDockerExecutable } from "./docker-executable";

test("finds Docker outside the minimal PATH inherited by a macOS GUI app", () => {
  const expected = "/usr/local/bin/docker";
  assert.equal(
    findDockerExecutable({
      envPath: "/usr/bin:/bin",
      platform: "darwin",
      home: "/Users/example",
      isExecutable: (candidate) => candidate === expected,
    }),
    expected,
  );
});

test("falls back to the Docker Desktop application CLI", () => {
  const expected = "/Applications/Docker.app/Contents/Resources/bin/docker";
  assert.equal(
    findDockerExecutable({
      envPath: "/usr/bin:/bin",
      platform: "darwin",
      home: "/Users/example",
      isExecutable: (candidate) => candidate === expected,
    }),
    expected,
  );
});

test("the desktop runtime isolates public image pulls from personal credential helpers", () => {
  const source = readFileSync(path.join(__dirname, "main.ts"), "utf8");
  const installer = readFileSync(path.join(__dirname, "../../../scripts/install-openleash-personal.sh"), "utf8");
  assert.match(source, /DOCKER_CONFIG: configDir/);
  assert.match(source, /Docker\.app\/Contents\/Resources\/cli-plugins/);
  assert.match(source, /spawnSync\(dockerExecutable, \[\.\.\.compose, "pull"\][\s\S]*?env: dockerEnv/);
  assert.match(source, /apps\/client-api\/dist\/migrate\.js/);
  assert.match(source, /apps\/client-api\/dist\/bootstrap-personal\.js/);
  assert.doesNotMatch(source, /apps\/engine\/dist\/(?:migrate|bootstrap-personal)\.js/);
  assert.match(installer, /apps\/client-api\/dist\/migrate\.js/);
  assert.match(installer, /apps\/client-api\/dist\/bootstrap-personal\.js/);
  assert.doesNotMatch(installer, /apps\/engine\/dist\/(?:migrate|bootstrap-personal)\.js/);
});
