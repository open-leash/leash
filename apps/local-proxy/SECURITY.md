# Security and resource model

The local proxy is a policy enforcement boundary. This document states the assumptions that should be reviewed before a release.

## Enforcement behavior

- The default listen address is loopback-only. Do not expose the proxy on an untrusted network without a separate authenticated ingress.
- Leash credentials and `x-openleash-*` headers are stripped before provider forwarding. Hop-by-hop and connection-nominated headers are stripped in both directions.
- Protected evaluation fails closed by default. Prompt requests are not sent upstream after a deny or evaluation failure. Complete HTTP/JSON/SSE tool responses are held until `client-api` returns `allow`; deny, evaluator error, or timeout releases none of the provider tool bytes.
- `OPENLEASH_PROXY_FAIL_OPEN=true` permits bypass only for transport errors,
  timeouts, HTTP 408/425, and server-side 5xx responses. Valid deny
  decisions, authentication/entitlement 4xx responses, and malformed responses
  remain fail-closed. Managed Desktop enables this availability fallback and
  surfaces degraded state; standalone deployments remain fail-closed by
  default.
- WebSocket traffic is transport passthrough and is not synchronously tool-gated. Do not claim enforcement for provider tool calls carried exclusively over WebSockets.

## CPU, memory, and concurrency

Tokio waits are asynchronous. A request awaiting evaluation suspends its future; it does not busy-wait or reserve an operating-system thread. Other requests continue on the runtime.

Three independent bounds prevent unbounded accumulation:

- `OPENLEASH_PROXY_MAX_BODY_BYTES` bounds intercepted request JSON (16 MiB default), while `OPENLEASH_PROXY_MAX_CONCURRENT_REQUEST_EVALUATIONS` limits simultaneous held/evaluating requests (8 default).
- `OPENLEASH_PROXY_MAX_GATED_RESPONSE_BYTES` bounds each held tool-capable response (8 MiB default).
- `OPENLEASH_PROXY_MAX_CONCURRENT_GATES` bounds held/evaluating responses (8 default). Later gates wait on an async semaphore and exert upstream TCP backpressure.

The default raw gated-response ceiling is therefore 64 MiB and the default raw intercepted-request ceiling is 128 MiB, with additional bounded allocation for parsed JSON/SSE state and the HTTP runtime. SSE events are parsed one at a time rather than retained as a second full event tree. `OPENLEASH_PROXY_EVALUATION_TIMEOUT_SECONDS` bounds both prompt and tool decision wait time (120 seconds default).

Metrics expose gate count, denial count, timeout count, capacity, and current in-flight gates for production alerting.

## Audit checklist

- Run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` in `apps/local-proxy`.
- Run `node scripts/test-local-proxy.mjs` for byte preservation, normalization, header filtering, streaming, denial, timeout, failure, response limits, and concurrency behavior.
- Run `node scripts/test-installed-agents-through-proxy.mjs` where supported agents are installed.
- Build the release container and scan the image and Rust dependency lockfile in the release pipeline.
- Treat changes to routing, header copying, fail-open behavior, response parsing, or gate limits as security-sensitive.
