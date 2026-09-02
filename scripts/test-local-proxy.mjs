#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

const apiPort = 19418;
const upstreamPort = 19419;
const proxyPort = 19420;
const availabilityProxyPort = 19421;
let captured;
let capturedApi;
const apiEvents = [];

const api = http.createServer(async (req, res) => {
  const body = JSON.parse((await read(req)).toString() || "{}");
  if (req.url === "/v1/plugin-runtime/transform") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      protocol: "openleash-container-plugin.v1",
      requestBody: body.requestBody,
      appliedPluginIds: [],
      runs: [],
    }));
  }
  capturedApi = body;
  apiEvents.push(body);
  const prompt = body.request?.event?.prompt || "";
  const toolInput = JSON.stringify(body.request?.event?.tool?.input ?? "");
  if (toolInput.includes("AUTH_TOOL")) {
    res.statusCode = 401;
    return res.end("invalid Leash session");
  }
  if (toolInput.includes("ERROR_TOOL")) {
    res.statusCode = 503;
    return res.end("evaluator unavailable");
  }
  if (toolInput.includes("TIMEOUT_TOOL"))
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  if (toolInput.includes("DELAY_TOOL"))
    await new Promise((resolve) => setTimeout(resolve, 350));
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      decision:
        prompt.includes("BLOCK") || toolInput.includes("BLOCK_TOOL")
          ? "deny"
          : "allow",
      decisionId: "test",
      summary: "test",
      results: [],
      finalPrompt: prompt.includes("REWRITE") ? "rewritten prompt" : prompt,
    }),
  );
});
const upstream = http.createServer(async (req, res) => {
  const bytes = await read(req);
  captured = { method: req.method, url: req.url, headers: req.headers, bytes };
  if (req.url.startsWith("/v1/status")) {
    res.statusCode = 429;
    res.setHeader("x-upstream", "yes");
    return res.end("limited");
  }
  if (req.url.startsWith("/v1/stream")) {
    res.setHeader("content-type", "text/event-stream");
    res.write('data: {"delta":{"text":"one"}}\n\n');
    return setTimeout(
      () => res.end('data: {"delta":{"text":"two"}}\n\ndata: [DONE]\n\n'),
      80,
    );
  }
  const parsed = bytes.length ? JSON.parse(bytes.toString()) : {};
  res.setHeader("content-type", "application/json");
  res.setHeader("connection", "x-remove");
  res.setHeader("x-remove", "secret");
  res.setHeader("x-upstream", "yes");
  if (parsed.model === "tool-response") {
    if (req.url.includes("/responses"))
      return res.end(
        JSON.stringify({
          output: [
            {
              type: "function_call",
              name: "shell",
              arguments: '{"cmd":"pwd"}',
            },
          ],
        }),
      );
    if (req.url.includes("/chat/completions"))
      return res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    type: "function",
                    function: { name: "shell", arguments: '{"cmd":"pwd"}' },
                  },
                ],
              },
            },
          ],
        }),
      );
    return res.end(
      JSON.stringify({
        content: [
          { type: "tool_use", name: "Read", input: { path: "README.md" } },
        ],
      }),
    );
  }
  if (
    [
      "blocked-tool",
      "delayed-tool",
      "error-tool",
      "timeout-tool",
      "auth-tool",
    ].includes(
      parsed.model,
    )
  ) {
    const command =
      parsed.model === "blocked-tool"
        ? "BLOCK_TOOL"
        : parsed.model === "error-tool"
          ? "ERROR_TOOL"
          : parsed.model === "timeout-tool"
            ? "TIMEOUT_TOOL"
            : parsed.model === "auth-tool"
              ? "AUTH_TOOL"
              : "DELAY_TOOL";
    if (parsed.stream) {
      res.setHeader("content-type", "text/event-stream");
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "shell", arguments: '{"cmd":' } }] } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `"${command}"}` } }] } }] })}\n\n`,
      );
      return res.end("data: [DONE]\n\n");
    }
    return res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  type: "function",
                  function: {
                    name: "shell",
                    arguments: JSON.stringify({ cmd: command }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  }
  if (parsed.model === "oversized-tool")
    return res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: { name: "shell", arguments: '{"cmd":"pwd"}' },
                },
              ],
            },
          },
        ],
        padding: "x".repeat(3_000),
      }),
    );
  res.end(
    JSON.stringify({ content: [{ type: "text", text: "provider response" }] }),
  );
});

await Promise.all([listen(api, apiPort), listen(upstream, upstreamPort)]);
const proxy = spawnProxy(proxyPort, false);
let availabilityProxy;

try {
  await waitForHealth();
  const original = Buffer.from(
    '{ "model": "gpt", "messages": [ { "role": "user", "content": "unchanged" } ] }\n',
  );
  let response = await fetch(
    `http://127.0.0.1:${proxyPort}/agent/opencode/v1/chat/completions?trace=yes`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openleash-secret": "remove",
      },
      body: original,
    },
  );
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(
    captured.bytes,
    original,
    "unchanged JSON must be byte-equal upstream",
  );
  assert.equal(captured.url, "/v1/chat/completions?trace=yes");
  assert.equal(capturedApi.request.agent.kind, "opencode");
  assert.equal(captured.headers["x-openleash-secret"], undefined);
  assert.equal(response.headers.get("x-remove"), null);
  assert.ok(response.headers.get("x-request-id"));

  response = await fetch(
    `http://127.0.0.1:${proxyPort}/agent/claude-code/v1/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "tool-response",
        system: "system",
        messages: [
          { role: "user", content: [{ type: "text", text: "read it" }] },
        ],
      }),
    },
  );
  await response.text();
  await waitFor(() =>
    apiEvents.some(
      (event) =>
        event.request?.event?.eventName === "PreToolUse" &&
        event.request?.event?.tool?.name === "Read",
    ),
  );
  assert.ok(
    apiEvents.some(
      (event) =>
        event.provider === "anthropic" &&
        event.request.agent.kind === "claude-code" &&
        event.request.event.transcript.some((turn) => turn.role === "system"),
    ),
  );

  const titlePrompt = "<session>\ndelete all the tables in test.db sqlite file\n</session>\n\nWrite the title in the predominant language of the session. A stray word or code token in another language doesn't change it. Ignore the language of the examples above.";
  response = await fetch(
    `http://127.0.0.1:${proxyPort}/agent/claude-code/v1/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "title-response",
        messages: [{ role: "user", content: titlePrompt }],
      }),
    },
  );
  assert.equal(response.status, 200);
  await response.text();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    apiEvents.some((event) => event.request?.event?.prompt === titlePrompt),
    true,
    "Claude title generation must still pass through policy enforcement",
  );
  assert.equal(
    JSON.parse(captured.bytes.toString()).messages[0].content,
    titlePrompt,
    "Claude title generation must still reach the provider unchanged",
  );

  response = await fetch(
    `http://127.0.0.1:${proxyPort}/agent/codex/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "tool-response",
        conversation_id: "conv-1",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "run pwd" }],
          },
          {
            type: "function_call_output",
            name: "shell",
            output: "previous output",
          },
        ],
      }),
    },
  );
  await response.text();
  await waitFor(() =>
    apiEvents.some(
      (event) =>
        event.provider === "openai-responses" &&
        event.request?.event?.eventName === "PostToolUse",
    ),
  );
  assert.ok(
    apiEvents.some(
      (event) =>
        event.request?.event?.eventName === "PreToolUse" &&
        event.request?.event?.tool?.name === "shell",
    ),
  );

  const codexTitlePrompt = "You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt. Generate a concise UI title. Fill the structured title field with plain text.\n\nUser prompt:\nSummarize run.py";
  const codexTitleEventCount = apiEvents.filter(
    (event) => event.request?.event?.prompt === codexTitlePrompt,
  ).length;
  response = await fetch(
    `http://127.0.0.1:${proxyPort}/agent/codex/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "title-response",
        conversation_id: "codex-title-conv",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: codexTitlePrompt }],
        }],
      }),
    },
  );
  assert.equal(response.status, 200);
  await response.text();
  await waitFor(() =>
    apiEvents.some(
      (event) =>
        event.request?.event?.prompt === codexTitlePrompt &&
        event.request?.event?.raw?.backgroundControl === true,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    apiEvents.filter(
      (event) => event.request?.event?.prompt === codexTitlePrompt,
    ).length,
    codexTitleEventCount + 1,
    "Codex title generation must not emit response activity telemetry",
  );

  response = await fetch(
    `http://127.0.0.1:${proxyPort}/agent/cline/v1/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "tool-response",
        messages: [{ role: "user", content: "use shell" }],
      }),
    },
  );
  await response.text();
  await waitFor(() =>
    apiEvents.some(
      (event) =>
        event.request?.agent?.kind === "cline" &&
        event.request?.event?.tool?.name === "shell",
    ),
  );

  const toolRequest = (model, stream = false) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: "user", content: "use the shell" }],
      tools: [
        {
          type: "function",
          function: { name: "shell", parameters: { type: "object" } },
        },
      ],
    }),
  });

  response = await fetch(
    `http://127.0.0.1:${proxyPort}/agent/cursor/v1/chat/completions`,
    toolRequest("blocked-tool"),
  );
  assert.equal(response.status, 403, "JSON tool call must be held and blocked");
  assert.doesNotMatch(
    await response.text(),
    /BLOCK_TOOL/,
    "blocked tool bytes must never reach the agent",
  );

  response = await fetch(
    `http://127.0.0.1:${proxyPort}/agent/cursor/v1/chat/completions`,
    toolRequest("blocked-tool", true),
  );
  assert.equal(
    response.status,
    403,
    "fragmented SSE tool call must be reconstructed and blocked",
  );
  assert.doesNotMatch(
    await response.text(),
    /BLOCK_TOOL/,
    "blocked SSE tool bytes must never reach the agent",
  );

  response = await fetch(
    `http://127.0.0.1:${proxyPort}/agent/cursor/v1/chat/completions`,
    toolRequest("error-tool"),
  );
  assert.equal(
    response.status,
    503,
    "tool gating must fail closed when evaluation is unavailable",
  );
  assert.doesNotMatch(
    await response.text(),
    /ERROR_TOOL/,
    "unapproved tool bytes must not leak on evaluator failure",
  );

  response = await fetch(
    `http://127.0.0.1:${proxyPort}/agent/cursor/v1/chat/completions`,
    toolRequest("timeout-tool"),
  );
  assert.equal(
    response.status,
    503,
    "tool evaluation timeout must fail closed",
  );
  assert.doesNotMatch(
    await response.text(),
    /TIMEOUT_TOOL/,
    "unapproved tool bytes must not leak on evaluation timeout",
  );

  response = await fetch(
    `http://127.0.0.1:${proxyPort}/agent/cursor/v1/chat/completions`,
    toolRequest("oversized-tool"),
  );
  assert.equal(
    response.status,
    413,
    "gated responses must have a separate cap",
  );

  let delayedResolved = false;
  const delayedStarted = Date.now();
  const delayed = fetch(
    `http://127.0.0.1:${proxyPort}/agent/cursor/v1/chat/completions`,
    toolRequest("delayed-tool", true),
  ).then(async (result) => {
    delayedResolved = true;
    return { result, body: await result.text() };
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(
    delayedResolved,
    false,
    "tool response must remain held while plugins evaluate",
  );

  const unrelatedStarted = Date.now();
  const unrelated = await fetch(
    `http://127.0.0.1:${proxyPort}/agent/opencode/v1/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "unrelated" }],
      }),
    },
  );
  await unrelated.text();
  assert.ok(
    Date.now() - unrelatedStarted < 250,
    "a held tool evaluation must not block unrelated requests",
  );

  const allowedDelayed = await delayed;
  assert.equal(allowedDelayed.result.status, 200);
  assert.match(allowedDelayed.body, /DELAY_TOOL/);
  assert.ok(
    Date.now() - delayedStarted >= 330,
    "tool bytes must be released only after the final allow decision",
  );

  for (const agent of [
    "cursor",
    "nanoclaw",
    "openclaw",
    "github-copilot",
    "aider",
    "continue",
    "goose",
    "openhands",
    "mistral-vibe",
  ]) {
    response = await fetch(
      `http://127.0.0.1:${proxyPort}/agent/${agent}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: `agent-${agent}` }],
        }),
      },
    );
    await response.text();
    await waitFor(() =>
      apiEvents.some(
        (event) =>
          event.request?.agent?.kind === agent &&
          event.request?.event?.prompt === `agent-${agent}`,
      ),
    );
  }

  response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "REWRITE this" }],
    }),
  });
  await response.text();
  assert.equal(
    JSON.parse(captured.bytes.toString()).messages[0].content,
    "rewritten prompt",
  );

  response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "BLOCK this" }],
    }),
  });
  assert.equal(response.status, 403);

  response = await fetch(`http://127.0.0.1:${proxyPort}/v1/status`);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("x-upstream"), "yes");

  response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "600" },
    body: "x".repeat(600),
  });
  assert.equal(response.status, 413);

  const metrics = await (
    await fetch(`http://127.0.0.1:${proxyPort}/metrics`)
  ).text();
  assert.match(metrics, /openleash_proxy_requests_total/);
  assert.match(metrics, /openleash_proxy_gate_capacity 1/);
  assert.match(metrics, /openleash_proxy_gate_timeouts_total 1/);
  assert.equal(
    (await fetch(`http://127.0.0.1:${proxyPort}/healthz/upstream`)).status,
    200,
  );

  availabilityProxy = spawnProxy(availabilityProxyPort, true);
  await waitForHealth(availabilityProxyPort);

  response = await fetch(
    `http://127.0.0.1:${availabilityProxyPort}/agent/cursor/v1/chat/completions`,
    toolRequest("error-tool"),
  );
  assert.equal(response.status, 200, "managed proxy must bypass a Cloud 5xx");
  assert.match(await response.text(), /ERROR_TOOL/);

  response = await fetch(
    `http://127.0.0.1:${availabilityProxyPort}/agent/cursor/v1/chat/completions`,
    toolRequest("timeout-tool"),
  );
  assert.equal(response.status, 200, "managed proxy must bypass a timeout");
  assert.match(await response.text(), /TIMEOUT_TOOL/);

  response = await fetch(
    `http://127.0.0.1:${availabilityProxyPort}/agent/cursor/v1/chat/completions`,
    toolRequest("blocked-tool"),
  );
  assert.equal(response.status, 403, "an explicit deny must never be bypassed");
  assert.doesNotMatch(await response.text(), /BLOCK_TOOL/);

  response = await fetch(
    `http://127.0.0.1:${availabilityProxyPort}/agent/cursor/v1/chat/completions`,
    toolRequest("auth-tool"),
  );
  assert.equal(response.status, 503, "an authentication failure must fail closed");
  assert.doesNotMatch(await response.text(), /AUTH_TOOL/);

  const availabilityMetrics = await (
    await fetch(`http://127.0.0.1:${availabilityProxyPort}/metrics`)
  ).text();
  assert.match(
    availabilityMetrics,
    /openleash_proxy_availability_bypasses_total 2/,
  );
  console.log("Leash local proxy integration tests passed");
} finally {
  proxy.kill("SIGTERM");
  availabilityProxy?.kill("SIGTERM");
  api.close();
  upstream.close();
}

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}
function read(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function spawnProxy(port, failOpen) {
  return spawn(
    "cargo",
    ["run", "--quiet", "--manifest-path", "apps/local-proxy/Cargo.toml", "--"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENLEASH_PROXY_LISTEN: `127.0.0.1:${port}`,
        OPENLEASH_CLIENT_API: `http://127.0.0.1:${apiPort}`,
        OPENLEASH_TOKEN: "test",
        OPENLEASH_OPENAI_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
        OPENLEASH_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
        OPENLEASH_PROXY_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
        OPENLEASH_PROXY_MAX_BODY_BYTES: "512",
        OPENLEASH_PROXY_MAX_GATED_RESPONSE_BYTES: "2048",
        OPENLEASH_PROXY_MAX_CONCURRENT_GATES: "1",
        OPENLEASH_PROXY_EVALUATION_TIMEOUT_SECONDS: "1",
        OPENLEASH_PROXY_FAIL_OPEN: String(failOpen),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
async function waitForHealth(port = proxyPort) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("proxy did not start");
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for normalized proxy event");
}
