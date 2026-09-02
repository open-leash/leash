import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalOpenLeashServer } from "./local-server";

test("desktop edge fails open only for availability failures", async () => {
  const previousThreshold = process.env.OPENLEASH_AVAILABILITY_FAILURE_THRESHOLD;
  // Keep this classification matrix on one edge without allowing the first
  // simulated 503 to short-circuit the later auth and contract assertions.
  process.env.OPENLEASH_AVAILABILITY_FAILURE_THRESHOLD = "20";
  let status = 503;
  let responseBody: unknown = { error: "temporarily unavailable" };
  let rawResponse: string | undefined;
  const cloud = http.createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(rawResponse ?? JSON.stringify(responseBody));
  });
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  const address = cloud.address();
  assert.ok(address && typeof address === "object");

  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "openleash-availability-edge-"),
  );
  const edge = new LocalOpenLeashServer(dataDir, {
    apiPort: 0,
    legacyAuthPort: 0,
  });
  edge.completeSetup([], {
    clientMode: "cloud",
    remoteApiUrl: `http://127.0.0.1:${address.port}`,
    remoteToken: "test-token",
  });
  await edge.start();

  const evaluate = async () => {
    const response = await fetch(
      new URL("/v1/hooks/codex/PreToolUse", edge.apiUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${edge.token}`,
          "x-openleash-api-function": "localHookEvaluate",
          "x-openleash-api-version":
            "2026-05-22.local-hook-evaluate.v1",
        },
        body: JSON.stringify({
          session_id: "availability-test",
          tool_name: "exec_command",
          tool_input: { cmd: "pwd" },
        }),
      },
    );
    assert.equal(response.status, 200);
    return (await response.json()) as {
      decision?: string;
      reason?: string;
    };
  };

  try {
    const unavailable = await evaluate();
    assert.equal(unavailable.decision, "allow");
    const tray = await fetch(new URL("/admin/tray-status", edge.apiUrl), {
      headers: { authorization: `Bearer ${edge.token}` },
    }).then(
      (response) => response.json() as Promise<{
        availability?: { degraded?: boolean };
      }>,
    );
    assert.equal(tray.availability?.degraded, true);

    status = 401;
    responseBody = { error: "invalid token" };
    const unauthorized = await evaluate();
    assert.equal(unauthorized.decision, "block");
    assert.match(unauthorized.reason ?? "", /sign in again/i);

    status = 429;
    responseBody = { error: "tenant rate limit exceeded" };
    const rateLimited = await evaluate();
    assert.equal(rateLimited.decision, "block");
    assert.match(rateLimited.reason ?? "", /rejected this request/i);

    status = 200;
    responseBody = { decision: "block", reason: "Organization policy denied it." };
    const explicitDeny = await evaluate();
    assert.equal(explicitDeny.decision, "block");
    assert.equal(explicitDeny.reason, "Organization policy denied it.");

    rawResponse = "not-json";
    const malformedPolicyResponse = await evaluate();
    assert.equal(malformedPolicyResponse.decision, "block");
    assert.match(malformedPolicyResponse.reason ?? "", /invalid policy response/i);
  } finally {
    await edge.stop();
    await new Promise<void>((resolve) => cloud.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousThreshold === undefined)
      delete process.env.OPENLEASH_AVAILABILITY_FAILURE_THRESHOLD;
    else
      process.env.OPENLEASH_AVAILABILITY_FAILURE_THRESHOLD = previousThreshold;
  }
});

test("one confirmed Cloud outage opens the desktop edge circuit", async () => {
  const previousThreshold = process.env.OPENLEASH_AVAILABILITY_FAILURE_THRESHOLD;
  delete process.env.OPENLEASH_AVAILABILITY_FAILURE_THRESHOLD;
  let cloudRequests = 0;
  const cloud = http.createServer((_req, res) => {
    cloudRequests += 1;
    res.statusCode = 503;
    res.end('{"error":"temporarily unavailable"}');
  });
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  const address = cloud.address();
  assert.ok(address && typeof address === "object");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openleash-open-circuit-"));
  const edge = new LocalOpenLeashServer(dataDir, { apiPort: 0, legacyAuthPort: 0 });
  edge.completeSetup([], {
    clientMode: "cloud",
    remoteApiUrl: `http://127.0.0.1:${address.port}`,
    remoteToken: "test-token",
  });
  await edge.start();
  const evaluate = () => fetch(new URL("/v1/hooks/codex/PreToolUse", edge.apiUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${edge.token}`,
      "x-openleash-api-function": "localHookEvaluate",
      "x-openleash-api-version": "2026-05-22.local-hook-evaluate.v1",
    },
    body: JSON.stringify({
      session_id: "open-circuit-test",
      tool_name: "exec_command",
      tool_input: { cmd: "pwd" },
    }),
  });
  try {
    const first = await evaluate();
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { decision?: string }).decision, "allow");
    const afterFirst = cloudRequests;
    assert.ok(afterFirst >= 1);
    const tray = await fetch(new URL("/admin/tray-status", edge.apiUrl), {
      headers: { authorization: `Bearer ${edge.token}` },
    }).then(
      (response) => response.json() as Promise<{ availability?: { state?: string } }>,
    );
    assert.equal(tray.availability?.state, "open");

    const startedAt = Date.now();
    const second = await evaluate();
    assert.equal((await second.json() as { decision?: string }).decision, "allow");
    assert.ok(Date.now() - startedAt < 250, "an open circuit should release later actions immediately");
    assert.equal(cloudRequests, afterFirst, "an open circuit must not retry every agent action");
  } finally {
    await edge.stop();
    await new Promise<void>((resolve) => cloud.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousThreshold === undefined)
      delete process.env.OPENLEASH_AVAILABILITY_FAILURE_THRESHOLD;
    else
      process.env.OPENLEASH_AVAILABILITY_FAILURE_THRESHOLD = previousThreshold;
  }
});

test("a pending Cloud evaluation is released when readiness disappears", async () => {
  const previous = {
    grace: process.env.OPENLEASH_REMOTE_READINESS_GRACE_MS,
    interval: process.env.OPENLEASH_REMOTE_READINESS_INTERVAL_MS,
    timeout: process.env.OPENLEASH_REMOTE_READINESS_TIMEOUT_MS,
  };
  process.env.OPENLEASH_REMOTE_READINESS_GRACE_MS = "50";
  process.env.OPENLEASH_REMOTE_READINESS_INTERVAL_MS = "50";
  process.env.OPENLEASH_REMOTE_READINESS_TIMEOUT_MS = "50";
  const cloud = http.createServer((req, res) => {
    if (req.url === "/cloud/readiness") {
      res.statusCode = 503;
      res.end('{"ok":false}');
      return;
    }
    // Simulate an accepted hook request whose worker disappeared without
    // completing the response. The Desktop readiness watchdog must abort it.
    req.once("aborted", () => res.destroy());
  });
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  const address = cloud.address();
  assert.ok(address && typeof address === "object");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openleash-readiness-edge-"));
  const edge = new LocalOpenLeashServer(dataDir, { apiPort: 0, legacyAuthPort: 0 });
  edge.completeSetup([], {
    clientMode: "cloud",
    remoteApiUrl: `http://127.0.0.1:${address.port}`,
    remoteToken: "test-token",
  });
  await edge.start();
  try {
    const startedAt = Date.now();
    const response = await fetch(new URL("/v1/hooks/codex/PreToolUse", edge.apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${edge.token}`,
        "x-openleash-api-function": "localHookEvaluate",
        "x-openleash-api-version": "2026-05-22.local-hook-evaluate.v1",
      },
      body: JSON.stringify({
        session_id: "readiness-test",
        tool_name: "exec_command",
        tool_input: { cmd: "pwd" },
      }),
    });
    const decision = (await response.json()) as { decision?: string };
    assert.equal(decision.decision, "allow");
    assert.ok(Date.now() - startedAt < 2_000, "readiness fail-open should not strand the agent");
  } finally {
    await edge.stop();
    await new Promise<void>((resolve) => cloud.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previous.grace === undefined) delete process.env.OPENLEASH_REMOTE_READINESS_GRACE_MS;
    else process.env.OPENLEASH_REMOTE_READINESS_GRACE_MS = previous.grace;
    if (previous.interval === undefined) delete process.env.OPENLEASH_REMOTE_READINESS_INTERVAL_MS;
    else process.env.OPENLEASH_REMOTE_READINESS_INTERVAL_MS = previous.interval;
    if (previous.timeout === undefined) delete process.env.OPENLEASH_REMOTE_READINESS_TIMEOUT_MS;
    else process.env.OPENLEASH_REMOTE_READINESS_TIMEOUT_MS = previous.timeout;
  }
});

test("legacy custom backends fail closed instead of using the Cloud outage bypass", async () => {
  const cloud = http.createServer((_req, res) => {
    res.statusCode = 503;
    res.end('{"error":"temporarily unavailable"}');
  });
  await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
  const address = cloud.address();
  assert.ok(address && typeof address === "object");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openleash-custom-edge-"));
  const edge = new LocalOpenLeashServer(dataDir, { apiPort: 0, legacyAuthPort: 0 });
  edge.completeSetup([], {
    clientMode: "custom",
    remoteApiUrl: `http://127.0.0.1:${address.port}`,
    remoteToken: "test-token",
  });
  await edge.start();
  try {
    const response = await fetch(new URL("/v1/hooks/codex/PreToolUse", edge.apiUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${edge.token}`,
        "x-openleash-api-function": "localHookEvaluate",
        "x-openleash-api-version": "2026-05-22.local-hook-evaluate.v1",
      },
      body: JSON.stringify({
        session_id: "custom-fail-closed-test",
        tool_name: "exec_command",
        tool_input: { cmd: "pwd" },
      }),
    });
    const decision = (await response.json()) as { decision?: string };
    assert.equal(decision.decision, "block");
  } finally {
    await edge.stop();
    await new Promise<void>((resolve) => cloud.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
