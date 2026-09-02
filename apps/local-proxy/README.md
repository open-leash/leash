<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:14B8A6,45:2563EB,100:111827&height=220&section=header&text=Local%20Proxy&fontSize=54&fontColor=ffffff&fontAlignY=38&desc=The%20real-time%20policy%20gate%20for%20local%20AI%20agents.&descSize=18&descAlignY=58" width="100%" />

<p>
  <a href="https://openleash.com"><img src="https://img.shields.io/badge/Leash-openleash.com-14B8A6?style=for-the-badge&logo=googlechrome&logoColor=white" /></a>
  <a href="https://docs.openleash.com"><img src="https://img.shields.io/badge/Docs-docs.openleash.com-2563EB?style=for-the-badge&logo=readthedocs&logoColor=white" /></a>
  <img src="https://img.shields.io/badge/License-MIT-111827?style=for-the-badge&logo=opensourceinitiative&logoColor=white" />
</p>

<p>
  <img src="https://img.shields.io/badge/Rust-stable-000000?style=for-the-badge&logo=rust&logoColor=white" />
  <img src="https://img.shields.io/badge/Providers-Anthropic%20%2B%20OpenAI-2563EB?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Enforcement-synchronous-14B8A6?style=for-the-badge" />
</p>

<h3>🐾 Observe every model exchange. Hold only what policy must decide.</h3>

</div>

---

## ✨ What this app is

`local-proxy` is Leash's cross-platform reverse proxy and enforcement relay for
local AI agents. It understands Anthropic Messages, OpenAI Chat Completions,
and OpenAI Responses traffic, reconstructs prompts and tool calls, sends
normalized events to Leash Engine, and applies decisions before protected
traffic continues.

```text
Claude Code / Codex / Cursor / OpenCode / other agents
                         │
                         ▼
                   local-proxy
                  raw → parsed
                         │
                         ▼
               Engine Feature pipeline
                         │
                   allow / replace / deny
                         │
                         ▼
                 model provider API
```

The proxy complements provider-specific API hooks. The proxy is authoritative for model traffic it can observe; hooks remain useful for agent lifecycle events and last-mile enforcement surfaces that do not traverse a model API.

---

## 🔥 What it handles

- Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses requests
- JSON and SSE response reconstruction, including split and multi-line events
- User prompts, assistant responses, tool calls, and tool results
- Claude session metadata and agent attribution headers
- Prompt replacement returned by policy plugins before provider forwarding
- Synchronous tool-call gating before any gated response bytes are released
- Asynchronous text-response telemetry when no pre-execution decision is required
- HTTP streaming, redirects, WebSockets, corporate proxy chaining, and hop-by-hop header sanitation
- Bounded bodies, concurrency limits, timeouts, and TCP backpressure
- Exact-session, time-bounded monitoring pauses authorized by Engine; unrelated conversations remain fully protected

---

## 🛡 Enforcement model

Protected request and tool-call evaluations suspend only their asynchronous request task; they do not occupy a CPU thread while waiting. Unrelated traffic continues normally.

The standalone proxy fails closed by default. The managed Desktop Client starts
it with classified availability fallback enabled: transport errors, timeouts,
HTTP 408/425, and server-side 5xx responses may bypass evaluation, while a
valid deny, authentication/entitlement 4xx, or malformed decision remains
enforced. This keeps an unavailable Leash edge from stranding the provider
without converting policy or account failures into an allow.

Default limits include 16 MiB intercepted requests, eight simultaneous request evaluations, 8 MiB gated responses, and eight simultaneous response gates. These limits are configurable and apply backpressure instead of allowing unbounded memory growth.

---

## 🛠 Run locally

Requirements: a stable Rust toolchain and a running Leash Engine.

```bash
cargo run
```

Configure the agent's provider base URL to point at the proxy and set:

```bash
export OPENLEASH_PROXY_UPSTREAM="https://api.anthropic.com"
export OPENLEASH_CLIENT_API="http://127.0.0.1:9318"
export OPENLEASH_TOKEN="your-engine-token"
cargo run --release
```

For an OpenAI-compatible agent, use its OpenAI upstream instead. The desktop client normally installs and configures this automatically for monitored agents.

---

## ⚙️ Configuration

| Variable | Purpose |
| --- | --- |
| `OPENLEASH_PROXY_UPSTREAM` | Provider API origin receiving allowed traffic. |
| `OPENLEASH_CLIENT_API` | Leash evaluation API URL. |
| `OPENLEASH_TOKEN` | Authentication token for Engine. |
| `OPENLEASH_CORPORATE_PROXY` | Optional existing organization proxy to chain through. |
| `OPENLEASH_PROXY_FAIL_OPEN` | Allow only classified availability failures to bypass evaluation. Valid denies and non-retryable 4xx responses remain enforced. Defaults to `false`; managed Desktop enables it. |
| `OPENLEASH_PROXY_MAX_BODY_BYTES` | Maximum intercepted request size. |
| `OPENLEASH_PROXY_MAX_CONCURRENT_REQUEST_EVALUATIONS` | Concurrent protected request evaluations. |
| `OPENLEASH_PROXY_MAX_GATED_RESPONSE_BYTES` | Maximum held response size per gate. |
| `OPENLEASH_PROXY_MAX_CONCURRENT_GATES` | Concurrent gated provider responses. |
| `OPENLEASH_PROXY_EVALUATION_TIMEOUT_SECONDS` | Maximum synchronous evaluation wait. |

---

## ✅ Verify

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The test suite covers provider URL construction, header filtering, Anthropic and OpenAI prompt rewrites, tool-call normalization, Claude metadata, and fragmented SSE parsing.

---

## 🔐 Security

Please report vulnerabilities according to [SECURITY.md](SECURITY.md). Never include live provider keys, Leash tokens, or captured prompt contents in a public issue.

<div align="center">

### Fast in the common path. Firm at the decision boundary.

</div>
