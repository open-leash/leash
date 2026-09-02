# OpenLeash Pipeline Plugins

OpenLeash features run as ordered, isolated container plugins. A plugin is described by a versioned manifest and publishes an OCI image implementing the language-independent container protocol. There is no in-process plugin runtime or fallback.

- `manifest.ts` - metadata, events, permissions, effects, ordering, and config schema.
- The implementation can use any language or framework as long as its container implements the protocol.

Current first-party plugins:

- `token-saver` runs as a Headroom-powered container on `provider.request.beforeSend` and may safely patch provider messages or input before the request leaves the machine.
- `data-leakage-prevention` runs after token-saver on `prompt.beforeSubmit` and may mask or block.
- `sensitive-access` reviews env-file reads, secret exposure, env dumps, and exfiltration attempts.
- `blast-radius` guards destructive tools and broad data operations.
- `rules-enforcer` evaluates active policies for prompts, agent responses, and tool actions.
- `mcp-scanner` observes MCP tool calls and records inventory.
- `skill-scanner` observes skill changes and can create a review finding.

## Ordering

Plugin order is declared in the manifest:

```ts
ordering: {
  priority: 100,
  before: ["openleash.dlp"],
  after: ["openleash.prompt-compression"]
}
```

`before` and `after` are resolved first. `priority` is the stable fallback when no dependency exists.

For prompts, ordering matters:

```text
token-saver -> data-leakage-prevention -> sensitive-access
```

`token-saver` runs first so `data-leakage-prevention` checks the final prompt that would be sent to the model.

For tool events:

```text
sensitive-access -> blast-radius -> rules-enforcer -> mcp-scanner
```

Sensitive-access and blast-radius catch specialized risks before rules-enforcer applies general policy. The MCP scanner then records inventory with the resulting decision context.

## Permissions

Permissions are declarative and should match what the implementation actually needs:

- `prompt:read` / `prompt:write`
- `tool:read`
- `decision:write`
- `model:invoke`
- `instructions:read`
- `conversation:read`
- `filesystem:read` / `filesystem:write` only for reviewed first-party or explicitly approved plugins
- `storage:read` / `storage:write`
- `audit:write`
- `log:write`
- `signal:write`
- `usage:write`
- `notification:send`
- `island:publish`

The container runtime validates the declared event, limits mutation to approved provider-payload roots, signs every invocation, and applies the manifest failure mode. Permissions still remain part of review and policy; they are not a substitute for the container sandbox.

## Container Runtime v1

Container plugins use `openleash-container-plugin.v1`. The local proxy never calls a plugin container. It sends the structured provider request to the local `client-api` edge, which invokes enabled containers over loopback. Hosted `client-api` instances invoke an already-warm service pool through the same envelope.

The required endpoints are:

- `GET /healthz`
- `POST /v1/events` for subscribed normalized pipeline events
- `POST /v1/transform`
- `POST /v1/tools/execute` when the manifest advertises tool execution

Requests carry a correlation ID, exact plugin ID/version, tenant/user/session scope, config, and payload. They are HMAC-signed with a runtime secret. Responses must echo the protocol and correlation ID. Transform responses return constrained JSON Patch operations; containers never receive database credentials, provider credentials, a Docker socket, or direct OpenLeash internals. Desktop containers without `network:access` live on an internal Docker network with no default route. A loopback-only allow-list gateway forwards signed requests only to installed plugin IDs, so the plugins remain reachable without receiving general network access.

Every plugin image must declare an OCI `HEALTHCHECK` in addition to serving `GET /healthz`. OpenLeash stages and verifies that check inside the isolated network before replacing a working container.

Generic event execution is a bounded multi-round exchange. A completed response uses:

```json
{
  "protocol": "openleash-container-plugin.v1",
  "requestId": "same-as-request",
  "status": "completed",
  "output": { "results": [], "run": {} }
}
```

When a plugin needs a privileged primitive, it returns `status: "capability_required"` with one or more stable calls such as `{ "id": "llm.evaluateJson:0", "capability": "llm.evaluateJson", "request": {} }`. The host checks the manifest permission, executes the primitive, and invokes the same event again with results keyed by call ID. Plugins must produce stable call IDs across retries. The host caps the exchange at 32 rounds and applies the manifest failure mode. This allows arbitrary languages to use model evaluation, recent current-conversation context, optional scoped storage, instructions, notifications, island UI, logs, signals, and usage accounting without receiving the underlying credentials.

See `examples/container-plugin` for a runnable implementation, Dockerfile,
development PostgreSQL service, manifest, signature validation, and build
commands.

Desktop lifecycle is desired-state reconciliation: login/catalog sync installs enabled edge images, health-checks a candidate, switches versions with a rollback container retained until success, and removes disabled containers. Published community images require an immutable digest. Cloud runs explicitly reviewed shared plugins in a warm autoscaled pool; plugins that need stronger isolation declare `user-dedicated`, `tenant-dedicated`, or `customer-hosted` isolation instead. An edge-completed event carries correlated container-run evidence to the hosted API, which records that run and does not execute the same plugin again. Events originating in SaaS or provider-hosted agents have no edge evidence, so the hosted API executes the subscribed cloud worker.

### Build and container checklist

A plugin image is built and published by its developer. OpenLeash pulls the
immutable image; it never builds third-party source code while processing an
event.

```bash
cd examples/container-plugin
npm install
npm run smoke
```

In an Individual Open Source desktop, choose **Plugins → Add/reload local
folder** and select the plugin directory. OpenLeash validates the JSON manifest,
enables the plugin, starts the manifest-tagged image, and reports container
health failures. `smoke` performs the syntax and manifest checks, builds the
image, and exercises the signed protocol. Use `npm run check` for a fast
no-Docker check. After an edit:

```text
edit → npm run check → npm run image → Add/reload local folder → trigger event
```

Omit `execution.digest` while developing locally. Add the immutable digest only
after pushing the release image:

```bash
docker push ghcr.io/acme/history-aware:1.0.0
docker inspect --format='{{index .RepoDigests 0}}' \
  ghcr.io/acme/history-aware:1.0.0
```

The production Dockerfile should:

- use a small pinned runtime base;
- run as a non-root user;
- listen on `0.0.0.0:8080`;
- expose `GET /healthz` and declare an OCI `HEALTHCHECK`;
- keep the root filesystem read-only and write only to `/tmp` or `/data`;
- validate the HMAC timestamp and signature before parsing an invocation;
- return the exact protocol and `requestId`;
- shut down cleanly on `SIGTERM`;
- never include OpenLeash, provider, or database credentials in the image.

### Isolation is a trust decision

`tenant.userId` in the protocol is context, not a safe database boundary for
unreviewed code. A malicious or buggy shared plugin could ignore it. OpenLeash
therefore uses the following execution classes:

| Isolation | Intended use | Durable state boundary |
| --- | --- | --- |
| `shared-trusted` | First-party or explicitly security-reviewed stateless workers | Host-mediated organization/user-scoped capabilities |
| `user-dedicated` | Community/private plugins with embedded databases or direct database credentials | One authenticated user + plugin + version workload, volume, and database role |
| `tenant-dedicated` | Organization-wide private plugins whose owner is trusted by that organization | One organization-bound workload and database boundary |
| `customer-hosted` | Private Cloud workloads operated entirely by the customer | Customer infrastructure and policy |

Community code is never made `shared-trusted` automatically. For a
`user-dedicated` cloud plugin, the runtime controller provisions the workload
when the user enables it and routes to it by trusted authenticated identity.
The image is already built and digest-pinned. Install/enable creates the route,
secret, persistent volume, and running pod. Login or desktop presence prewarms
enabled plugins before agent traffic. A live event normally only routes to an
already-ready pod; event-triggered startup is a bounded recovery path when a
pod disappeared unexpectedly.

When the user has no connected desktop and the plugin has been idle for the
operator-defined grace period, the pod may stop while the volume remains. The
next desktop presence starts it again. An always-warm policy is valid when the
user accepts the additional compute cost.

Pod isolation must also include a dedicated service account, no Kubernetes API
token, a read-only root filesystem, resource limits, network policy, and
user/plugin-scoped secrets. A plugin still cannot be trusted with unrestricted
egress merely because it has its own pod.

### PostgreSQL plugins

OpenLeash permits a user-dedicated plugin image to bundle its application and a
private PostgreSQL server as one stateful container appliance. PostgreSQL must
listen on loopback only, keep `PGDATA` under `/data`, run without root, and stop
cleanly before the container exits. OpenLeash mounts one user/plugin-specific
single-writer volume and never exposes the database port. The workload runs one
replica; it is not horizontally autoscaled.

The developer may instead use a separate Compose PostgreSQL service locally or
operator-managed PostgreSQL in hosted products. Managed PostgreSQL is preferable
when the plugin needs high availability, large data, replicas, point-in-time
recovery, or independent database upgrades, but it is not required for a small
user-dedicated store.

In both designs the workload and volume/database are already bound to one
authenticated user. The plugin should not implement its security boundary by
adding a caller-provided `user_id` to SQL.

There is no safe generic synchronization for arbitrary PostgreSQL, SQLite, or
MongoDB databases. Local agent events execute locally and cloud-agent events
execute in the cloud; OpenLeash does not reroute either one just to preserve a
plugin database. If the same plugin runs in both places, each `/data` volume is
private to that runtime.

The example includes both supported development shapes:

- `docker-compose.dev.yml` runs the application and PostgreSQL separately.
- `Dockerfile.bundled-postgres` and
  `docker-compose.bundled-postgres.yml` run one user-dedicated stateful
  appliance with PostgreSQL stored under `/data/postgres`.

Neither shape is built on an agent request. The developer publishes the image;
the runtime pulls it and provisions persistent storage when the plugin is
enabled.

## Capability Boundary

Plugins must not import OpenLeash internals such as evaluators, database modules, prompt transforms, server handlers, or model-key readers. Those files are implementation details and can change without becoming a plugin breaking change.

Instead, plugin code receives stable primitive capabilities from the runtime. Product logic belongs in the plugin. For example, a DLP plugin owns its detectors, prompt, schema, masking rules, and parser; OpenLeash only supplies the configured evaluator LLM and trusted sinks.

```ts
const review = await capabilities.llm.evaluateJson({
  purpose: "acme-risk-review",
  system: "You are the Acme risk plugin. Return JSON only.",
  prompt: JSON.stringify({ text: event.prompt, rules: config.rules }),
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["risk", "reason"],
    properties: {
      risk: { type: "string", enum: ["low", "medium", "high"] },
      reason: { type: "string" }
    }
  }
});
const instructionFiles = await capabilities.context.instructions.list({ scope: "project" });
const conversation = await capabilities.context.conversation.recent({ limit: 20 });
await capabilities.log.emit({ level: "security", message: "Custom evaluator flagged a risky action." });
await capabilities.signals.emit({ kind: "security.finding", severity: "high", title: "Risky action blocked." });
await capabilities.usage.record({ kind: "llm.tokens", inputTokens: 8000, savedTokens: 2400 });
await capabilities.island.annotateSession({
  key: "risk",
  label: "Destructive operation",
  value: "critical",
  tone: "danger"
});
```

If a Feature needs a new privileged operation, add a narrow capability to the shared contract first, declare the matching permission in the manifest, and let the Leash runtime adapt that capability to internal providers. Broad domain capabilities make Features thin wrappers over core internals. SIEM is deliberately outside this system: organization runtimes consume the dedicated audit-export provider contract, while personal runtimes use its disabled implementation.

The Live Sessions island follows the same boundary. Plugins publish typed annotations, activity, progress, or ambient status through `capabilities.island`; OpenLeash owns the renderer and only exposes a small allowlist of safe navigation actions. Plugins never send HTML, CSS, JavaScript, arbitrary URLs, or custom IPC. See `docs/PLUGIN_ISLAND.md` for the complete developer contract and container emission shape.

## Settings And Agent Scope

Plugin authors define one `configSchema` and consume one resolved `input.config`. They do not implement product-mode, organization-role, employee, or profile-merging logic. OpenLeash resolves those concerns before each invocation:

```text
manifest defaults
  -> organization base settings
  -> matching organization profiles by priority
  -> user base settings, unless locked
  -> matching user profiles by priority, unless locked
```

A profile may target agent kinds such as `claude-code` or `codex`, exact authenticated/enrolled runtime IDs, or both. The runtime envelope includes the resolved configuration, its hash, and the matching profile IDs. A container must treat that configuration as request-scoped data; it must not retain one tenant's settings in global mutable state.

Organization policy controls four separate things: mandatory installation, default enablement, permission to add optional plugins, and permission to customize settings. A mandatory plugin can remain configurable. A plugin developer does not need branches for these combinations: OpenLeash prevents forbidden removal/overrides and supplies the already-resolved effective state.

The same contract is used by Individual Open Source, personal OpenLeash Cloud, organization OpenLeash Cloud, and Private Cloud. Use `executionEnvironment: "cloud-only"` only when the implementation truly depends on OpenLeash-operated infrastructure. OpenLeash surfaces that restriction and refuses activation in Individual Open Source and Private Cloud.

## Host Context And Instruction Files

External plugins do not get general access to the computer running the agent. They should not walk the host filesystem, read arbitrary files, shell out to local tools, or assume they run beside the user's project. OpenLeash owns host discovery and exposes only reviewed context through explicit capabilities or event payloads.

Agent instruction files are the canonical example. Files such as `CLAUDE.md`, `AGENTS.md`, Cursor rules, Cline rules, OpenCode rules, Windsurf rules, and Copilot instructions may be useful to a plugin, but they are still host files. OpenLeash discovers known global and project instruction locations, normalizes the results, and serves them through:

```ts
const files = await capabilities.context.instructions.list();
```

Each item contains:

```ts
{
  agent: "Claude Code",
  scope: "project",
  label: "Project CLAUDE.md",
  path: "/workspace/CLAUDE.md",
  content: "...",
  parsedLines: ["Ask before publishing changes", "..."]
}
```

Plugins may use the raw `content`, use `parsedLines`, or parse the content themselves. The important boundary is that OpenLeash decides which files are discoverable and when they are attached to the plugin context. A plugin that wants one more host-derived data source should request a new narrow capability such as `context.instructions`, not a broad filesystem permission.

## Build A Plugin

Start from the manifest, then write one handler per event. Keep the plugin understandable enough that someone can review its permissions without reading the whole implementation.

1. Pick the narrowest event.
2. Declare only the permissions the plugin needs.
3. Expose settings through `configSchema` and `defaultConfig`.
4. Put plugin-specific model prompts, parsing, prompt transforms, DLP rules, and decisions in the plugin; use runtime capabilities only for primitive services such as conversation context, LLM calls, optional storage, notifications, signals, usage, and audit logs.
5. Return a typed plugin run/result. Do not write directly to OpenLeash product tables.

Minimal manifest:

```ts
export const manifest = {
  id: "acme.prompt-labeler",
  name: "Prompt Labeler",
  version: "1.0.0",
  publisher: "acme",
  runtime: "container",
  entrypoint: "container",
  execution: {
    type: "container",
    placement: "either",
    protocol: "openleash-container-plugin.v1",
    image: "ghcr.io/acme/prompt-labeler:1.0.0",
    eventPath: "/v1/events"
  },
  events: ["prompt.beforeSubmit"],
  permissions: ["event:read", "prompt:read", "conversation:read", "audit:write"],
  effects: ["observe"],
  ordering: {
    priority: 250,
    after: ["openleash.dlp"]
  },
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      label: { type: "string" }
    }
  },
  defaultConfig: {
    enabled: true,
    label: "reviewed"
  }
};
```

Minimal handler:

```ts
export async function run(input, capabilities) {
  if (!input.config.enabled) {
    return {
      status: "skipped",
      summary: "Prompt Labeler is disabled."
    };
  }

  const conversation = await capabilities.context.conversation.recent({
    limit: 20
  });

  return {
    status: "passed",
    summary: `Prompt labeled with ${conversation.turns.length} turns of context.`,
    findings: [{
      title: "Prompt label",
      severity: "info",
      summary: input.config.label
    }]
  };
}
```

External examples should live in their own public GitHub repositories. First-party plugins use one repository per plugin under the `open-leash/plugin-*` pattern and mirror the preinstalled plugins as readable reference implementations.

## Conversation History First

Most plugins do not need a synchronized private database. The normalized event
already carries the current transcript when the agent transport provides it.
When it does not, declare `conversation:read` and request a bounded recent
window:

```json
{
  "status": "capability_required",
  "capabilityRequests": [{
    "id": "context.conversation.recent:0",
    "capability": "context.conversation.recent",
    "request": { "limit": 20 }
  }]
}
```

The host returns turns only from the authenticated current session. The plugin
cannot select another organization, user, or arbitrary session. Local and cloud
runtimes therefore make history-aware decisions from the same OpenLeash
conversation model instead of depending on a private database layout.

JavaScript plugins using the reference runtime can call:

```ts
const conversation = await capabilities.context.conversation.recent({
  limit: 20
});
```

Use the returned transcript for risk classification, deduplication, summaries,
or other session-aware decisions.

## Private Container Data

`/data` is a plugin-private persistent volume by default. A plugin may freely
use SQLite, PostgreSQL, MongoDB, files, models, or indexes there. It is isolated
from other plugins and is never an OpenLeash database mount.

That freedom has one clear boundary: `/data` belongs to one runtime. OpenLeash
does not copy or merge live database files between a laptop and a cloud worker.
Do not make cross-runtime behavior depend on records stored only in a private
database.

For the occasional small plugin-owned value that is not conversation history,
`capabilities.storage` remains available:

```ts
const previous = await capabilities.storage.get({
  key: "notifications/customer-data-risk"
});

if (!previous) {
  await capabilities.storage.set({
    key: "notifications/customer-data-risk",
    value: { shownAt: Date.now() },
    ttlSeconds: 5 * 60 * 60
  });
}
```

Treat it as a bounded plugin document API for preferences, checkpoints, or
deduplication, not as a generic database or as the normal conversation
history path. Values are JSON, each value is capped at 256 KiB, keys are capped
at 240 characters, lists are bounded, and plugins cannot run SQL or join
OpenLeash product tables.

## Putting It Together

Example: a prompt evaluator uses the current conversation and keeps an optional
notification deduplication key:

```ts
const conversation = await capabilities.context.conversation.recent({
  limit: 20
});

const scope = {
  sessionId: input.request.event.sessionId,
  conversationId: input.request.event.raw?.conversation_id
};

const previous = await capabilities.storage.get({
  scope,
  key: "notifications/customer-data-risk"
});

if (!previous) {
  await capabilities.storage.set({
    scope,
    key: "notifications/customer-data-risk",
    value: {
      title: "Risky prompt needs review",
      reason: "Prompt asked the agent to expose customer data.",
      conversationTurns: conversation.turns.length
    },
    ttlSeconds: 5 * 60 * 60
  });

  return pluginRun({
    pluginId: manifest.id,
    event: "prompt.beforeSubmit",
    status: "needs_question",
    summary: "Prompt evaluator found a risk that needs review.",
    startedAt,
    findings: [{
      title: "Risky prompt",
      severity: "high",
      summary: "Prompt asked the agent to expose customer data."
    }]
  });
}
```

That returned finding/`needs_question` is what Leash core turns into the actual approval flow. A Feature does not directly pop a desktop window; Leash core owns desktop, mobile, audit, notification policy, organization audit export, and native hook response delivery.

## Security Signals And CISO Reporting

Logs are useful for operators and organization audit export, while higher-level reporting needs normalized records. Features should report incidents, findings, discoveries, policy decisions, and inventory observations with `capabilities.signals.emit`.

OpenLeash injects trusted context into every signal:

```text
organization_id
plugin_id
conversation_event_id
user_id
computer_id
agent_runtime_id
```

Plugin code can describe what happened, but it cannot choose a different organization, impersonate another user, or write raw dashboard rows. Identity sync stays in OpenLeash core: users and groups come from the configured IdP, endpoint enrollment links devices to users, and the runtime attaches that context to plugin records.

Example rules-enforcer output:

```ts
await capabilities.signals.emit({
  kind: "security.finding",
  severity: "high",
  title: "Destructive shell command blocked",
  summary: "The agent attempted to remove a protected directory.",
  decision: "blocked",
  status: "contained",
  target: { command: "rm -rf ./prod-data" },
  evidence: [{ type: "policy", value: "destructive-command" }],
  details: { policyIds: ["prod-safety"] },
  correlationKeys: ["user:current", "command:rm-rf", "policy:prod-safety"]
});
```

The dashboard reads OpenLeash-owned `plugin_signals`, not plugin databases. It can show:

- latest incidents and findings;
- affected synced employees;
- sources by plugin;
- contained or blocked outcomes;
- cross-plugin correlations by shared user, conversation, device, or explicit `correlationKeys`.

This means a better third-party rules plugin can coexist with the first-party rules-enforcer. Each plugin emits its own signals, OpenLeash stores them with trusted context, and the dashboard correlates normalized data without letting plugins access each other's tables.

## Usage And Cost Reporting

Plugins report cost, token savings, scans, model calls, and other measurable activity with `capabilities.usage.record`. The runtime stamps the same trusted organization, user, device, runtime, and conversation context.

```ts
await capabilities.usage.record({
  kind: "llm.tokens",
  provider: "openleash-evaluator",
  model: "policy-eval",
  inputTokens: 4200,
  outputTokens: 300,
  savedTokens: 1600,
  estimatedCostUsd: 0.018,
  details: { reason: "prompt-compression" }
});
```

The CISO sees usage by plugin and employee in the dashboard. A cost-focused plugin does not need database access to be useful; it only needs `usage:write`.

## Plugin And System Logs

Plugins emit structured logs through `capabilities.log.emit`. The runtime injects the organization, plugin id, user, host, runtime, and conversation event linkage; plugin code cannot write arbitrary audit rows or pretend to be another plugin.

```ts
await capabilities.log.emit({
  level: "security",
  category: "security",
  code: "custom-risk",
  message: "Custom evaluator flagged a risky action.",
  data: { riskScore: 91 }
});
```

Leash core can write its own `openleash.core` system log records for product events such as held approvals or backend failures. Organization audit-export providers receive both core and Feature logs through the typed audit-export contract, without giving Feature code direct network or database access. Personal runtimes do not register an audit-export provider.

Notification capabilities follow the same rule: a plugin can request or dedupe a notification-shaped event, but OpenLeash core owns whether it is sent, suppressed, silenced, rate-limited, or routed elsewhere.

## Events

Use the narrowest event possible:

- `openleash.startup`
- `agent.detected`
- `skill.detected`
- `skill.changed`
- `skill.removed`
- `log.emitted`
- `prompt.beforeSubmit`
- `agent.response`
- `tool.beforeUse`
- `tool.afterUse`
- `session.started`
- `session.ended`

`agent.response` is the post-answer event. Claude-style `Stop`, `Notification`, and subagent completion hooks map here because they represent agent output or completion after work has happened.

## Result Shape

Plugins should return typed findings and plugin run records instead of writing directly to unrelated tables.
The hook pipeline is responsible for merging results, storing audit payloads, and returning native agent hook responses.
