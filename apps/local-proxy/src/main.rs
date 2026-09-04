use axum::{
    body::{to_bytes, Body},
    extract::State,
    extract::{
        ws::{Message as AxMessage, WebSocketUpgrade},
        FromRequestParts,
    },
    http::{HeaderMap, Request, Response, StatusCode},
    routing::{any, get},
    Json, Router,
};
use bytes::Bytes;
use clap::Parser;
use futures_util::SinkExt;
use futures_util::StreamExt;
use reqwest::{Client, Proxy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{net::SocketAddr, sync::Arc, time::Duration};

#[derive(Parser, Clone)]
#[command(name = "openleash-local-proxy")]
struct Config {
    #[arg(long, env = "OPENLEASH_PROXY_LISTEN", default_value = "127.0.0.1:9320")]
    listen: SocketAddr,
    #[arg(
        long,
        env = "OPENLEASH_PROXY_UPSTREAM",
        default_value = "https://api.anthropic.com"
    )]
    upstream: String,
    #[arg(
        long,
        env = "OPENLEASH_ANTHROPIC_UPSTREAM",
        default_value = "https://api.anthropic.com"
    )]
    anthropic_upstream: String,
    #[arg(
        long,
        env = "OPENLEASH_OPENAI_UPSTREAM",
        default_value = "https://api.openai.com"
    )]
    openai_upstream: String,
    #[arg(
        long,
        env = "OPENLEASH_CHATGPT_UPSTREAM",
        default_value = "https://chatgpt.com/backend-api/codex"
    )]
    chatgpt_upstream: String,
    #[arg(
        long,
        env = "OPENLEASH_VERTEX_UPSTREAM",
        default_value = "https://us-central1-aiplatform.googleapis.com"
    )]
    vertex_upstream: String,
    #[arg(
        long,
        env = "OPENLEASH_CLIENT_API",
        default_value = "http://127.0.0.1:9318"
    )]
    client_api: String,
    #[arg(long, env = "OPENLEASH_TOKEN")]
    token: String,
    #[arg(long, env = "OPENLEASH_CORPORATE_PROXY")]
    corporate_proxy: Option<String>,
    #[arg(long, env = "OPENLEASH_PROXY_FAIL_OPEN", default_value_t = false)]
    fail_open: bool,
    #[arg(
        long,
        env = "OPENLEASH_PROXY_MAX_BODY_BYTES",
        default_value_t = 16_777_216
    )]
    max_body_bytes: usize,
    #[arg(
        long,
        env = "OPENLEASH_PROXY_CAPTURE_BYTES",
        default_value_t = 4_194_304
    )]
    capture_bytes: usize,
    #[arg(
        long,
        env = "OPENLEASH_PROXY_MAX_GATED_RESPONSE_BYTES",
        default_value_t = 8_388_608
    )]
    max_gated_response_bytes: usize,
    #[arg(
        long,
        env = "OPENLEASH_PROXY_MAX_CONCURRENT_GATES",
        default_value_t = 8
    )]
    max_concurrent_gates: usize,
    #[arg(
        long,
        env = "OPENLEASH_PROXY_MAX_CONCURRENT_REQUEST_EVALUATIONS",
        default_value_t = 8
    )]
    max_concurrent_request_evaluations: usize,
    #[arg(
        long,
        env = "OPENLEASH_PROXY_EVALUATION_TIMEOUT_SECONDS",
        default_value_t = 660
    )]
    evaluation_timeout_seconds: u64,
    #[arg(
        long,
        env = "OPENLEASH_PROXY_CONNECT_TIMEOUT_SECONDS",
        default_value_t = 10
    )]
    connect_timeout_seconds: u64,
    #[arg(
        long,
        env = "OPENLEASH_PROXY_UPSTREAM_TIMEOUT_SECONDS",
        default_value_t = 600
    )]
    upstream_timeout_seconds: u64,
}

#[derive(Clone)]
struct App {
    config: Config,
    client: Client,
    requests: Arc<AtomicU64>,
    upstream_errors: Arc<AtomicU64>,
    gate_slots: Arc<tokio::sync::Semaphore>,
    request_evaluation_slots: Arc<tokio::sync::Semaphore>,
    gated_responses: Arc<AtomicU64>,
    gate_denials: Arc<AtomicU64>,
    gate_timeouts: Arc<AtomicU64>,
    availability_bypasses: Arc<AtomicU64>,
}

#[derive(Deserialize)]
struct Decision {
    decision: String,
    #[serde(rename = "finalPrompt")]
    final_prompt: Option<String>,
}
#[derive(Deserialize)]
struct TransformDecision {
    #[serde(rename = "requestBody")]
    request_body: Value,
    #[serde(rename = "appliedPluginIds", default)]
    applied_plugin_ids: Vec<String>,
    #[serde(default)]
    runs: Vec<Value>,
    #[serde(rename = "monitoringPaused", default)]
    monitoring_paused: bool,
}
#[derive(Serialize)]
struct Health {
    ok: bool,
    service: &'static str,
    upstream: String,
    client_api: String,
}

#[tokio::main]
async fn main() {
    let config = Config::parse();
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(config.connect_timeout_seconds))
        .timeout(Duration::from_secs(config.upstream_timeout_seconds))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(url) = &config.corporate_proxy {
        builder = builder.proxy(Proxy::all(url).expect("invalid corporate proxy URL"));
    }
    let state = App {
        config: config.clone(),
        client: builder.build().expect("HTTP client"),
        requests: Arc::new(AtomicU64::new(0)),
        upstream_errors: Arc::new(AtomicU64::new(0)),
        gate_slots: Arc::new(tokio::sync::Semaphore::new(
            config.max_concurrent_gates.max(1),
        )),
        request_evaluation_slots: Arc::new(tokio::sync::Semaphore::new(
            config.max_concurrent_request_evaluations.max(1),
        )),
        gated_responses: Arc::new(AtomicU64::new(0)),
        gate_denials: Arc::new(AtomicU64::new(0)),
        gate_timeouts: Arc::new(AtomicU64::new(0)),
        availability_bypasses: Arc::new(AtomicU64::new(0)),
    };
    let app = build_router(Arc::new(state));
    let listener = tokio::net::TcpListener::bind(config.listen)
        .await
        .expect("bind proxy");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("serve proxy");
}

fn build_router(state: Arc<App>) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/healthz/upstream", get(health_upstream))
        .route("/metrics", get(metrics))
        .route("/*path", any(forward))
        .with_state(state)
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn health(State(app): State<Arc<App>>) -> Json<Health> {
    Json(Health {
        ok: true,
        service: "openleash-local-proxy",
        upstream: app.config.upstream.clone(),
        client_api: app.config.client_api.clone(),
    })
}

async fn health_upstream(
    State(app): State<Arc<App>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    match app.client.get(&app.config.upstream).send().await {
        Ok(response) if response.status().is_server_error() => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"ok":false,"status":response.status().as_u16()})),
        )),
        Ok(response) => Ok(Json(json!({"ok":true,"status":response.status().as_u16()}))),
        Err(error) => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"ok":false,"error":error.to_string()})),
        )),
    }
}

fn availability_bypass_allowed(config: &Config, error: &reqwest::Error) -> bool {
    if !config.fail_open {
        return false;
    }
    if error.is_connect() {
        return true;
    }
    error
        .status()
        .is_some_and(|status| is_availability_status(status.as_u16()))
}

fn is_availability_status(status: u16) -> bool {
    // 429 is an explicit rate/cost boundary and must not become fail-open.
    matches!(status, 408 | 425 | 500..=599)
}

#[cfg(test)]
mod availability_tests {
    use super::is_availability_status;

    #[test]
    fn retries_only_true_availability_statuses() {
        for status in [408, 425, 500, 502, 503, 504] {
            assert!(is_availability_status(status), "status {status}");
        }
        for status in [400, 401, 403, 404, 409, 422, 429] {
            assert!(!is_availability_status(status), "status {status}");
        }
    }
}

async fn metrics(State(app): State<Arc<App>>) -> String {
    let gate_capacity = app.config.max_concurrent_gates.max(1);
    let gate_inflight = gate_capacity.saturating_sub(app.gate_slots.available_permits());
    format!(
        "# TYPE openleash_proxy_requests_total counter\nopenleash_proxy_requests_total {}\n# TYPE openleash_proxy_upstream_errors_total counter\nopenleash_proxy_upstream_errors_total {}\n# TYPE openleash_proxy_gated_responses_total counter\nopenleash_proxy_gated_responses_total {}\n# TYPE openleash_proxy_gate_denials_total counter\nopenleash_proxy_gate_denials_total {}\n# TYPE openleash_proxy_gate_timeouts_total counter\nopenleash_proxy_gate_timeouts_total {}\n# TYPE openleash_proxy_availability_bypasses_total counter\nopenleash_proxy_availability_bypasses_total {}\n# TYPE openleash_proxy_gate_inflight gauge\nopenleash_proxy_gate_inflight {}\n# TYPE openleash_proxy_gate_capacity gauge\nopenleash_proxy_gate_capacity {}\n",
        app.requests.load(Ordering::Relaxed),
        app.upstream_errors.load(Ordering::Relaxed),
        app.gated_responses.load(Ordering::Relaxed),
        app.gate_denials.load(Ordering::Relaxed),
        app.gate_timeouts.load(Ordering::Relaxed),
        app.availability_bypasses.load(Ordering::Relaxed),
        gate_inflight,
        gate_capacity,
    )
}

async fn forward(
    State(app): State<Arc<App>>,
    request: Request<Body>,
) -> Result<Response<Body>, (StatusCode, String)> {
    let (mut parts, body) = request.into_parts();
    app.requests.fetch_add(1, Ordering::Relaxed);
    let request_id = parts
        .headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (agent_kind, normalized_uri) = extract_agent_uri(&parts.uri);
    parts.uri = normalized_uri;
    if is_websocket(&parts.headers) {
        let ws = WebSocketUpgrade::from_request_parts(&mut parts, &())
            .await
            .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
        let upstream = websocket_url(
            upstream_for(
                &app.config,
                parts.uri.path(),
                &Value::Null,
                &parts.headers,
                &agent_kind,
            ),
            &upstream_request_uri(&parts.uri.to_string(), &parts.headers, &agent_kind),
        );
        let headers = parts.headers.clone();
        return Ok(ws.on_upgrade(move |socket| async move {
            let _ = websocket_pump(socket, upstream, headers).await;
        }));
    }
    let intercept = parts.method == axum::http::Method::POST
        && is_json(&parts.headers)
        && is_llm_path(parts.uri.path());
    let request_evaluation_permit = if intercept {
        Some(
            app.request_evaluation_slots
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| {
                    (
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Leash request evaluator is shutting down".to_owned(),
                    )
                })?,
        )
    } else {
        None
    };
    if intercept
        && parts
            .headers
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok())
            .is_some_and(|length| length > app.config.max_body_bytes)
    {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("request body exceeds {} bytes", app.config.max_body_bytes),
        ));
    }
    let (mut value, outbound_body, original_bytes) = if intercept {
        let bytes = to_bytes(body, app.config.max_body_bytes)
            .await
            .map_err(|error| (StatusCode::PAYLOAD_TOO_LARGE, error.to_string()))?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
            (
                StatusCode::BAD_REQUEST,
                format!("invalid JSON request: {error}"),
            )
        })?;
        (value, None, Some(bytes))
    } else {
        (
            Value::Null,
            Some(reqwest::Body::wrap_stream(body.into_data_stream())),
            None,
        )
    };
    let mut transformed = false;
    let mut applied_plugin_ids = Vec::new();
    let mut container_plugin_runs = Vec::new();
    let mut monitoring_paused = false;
    let session_id = if intercept {
        provider_session_id(&value).unwrap_or_else(|| "proxy".to_owned())
    } else {
        "proxy".to_owned()
    };
    let background_control_request =
        intercept && is_background_control_request(&agent_kind, &value);
    // Background control requests are private provider UI traffic rather than
    // a user-authored agent turn. They may still be transformed on the way to
    // the provider, but must never create activity, a DLP approval, or response
    // telemetry in Leash.
    if intercept {
        let transformation = tokio::time::timeout(
            Duration::from_secs(app.config.evaluation_timeout_seconds),
            transform_request(&app, &parts.uri.to_string(), &value, &agent_kind),
        )
        .await;
        match transformation {
            Ok(Ok(result)) => {
                if result.request_body != value {
                    value = result.request_body;
                    transformed = true;
                }
                applied_plugin_ids = result.applied_plugin_ids;
                container_plugin_runs = result.runs;
                monitoring_paused = result.monitoring_paused;
            }
            Ok(Err(error)) if !availability_bypass_allowed(&app.config, &error) => {
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!("Leash Feature runtime unavailable: {error}"),
                ));
            }
            Ok(Err(_)) => {
                app.availability_bypasses.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) if !app.config.fail_open => {
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Leash Feature transformation timed out".to_owned(),
                ));
            }
            Err(_) => {
                app.availability_bypasses.fetch_add(1, Ordering::Relaxed);
            }
        }
        if !monitoring_paused && !background_control_request {
            let evaluation = tokio::time::timeout(
                Duration::from_secs(app.config.evaluation_timeout_seconds),
                evaluate(
                    &app,
                    &parts.uri.to_string(),
                    &value,
                    &agent_kind,
                    &applied_plugin_ids,
                    &container_plugin_runs,
                    background_control_request,
                ),
            )
            .await;
            match evaluation {
                Ok(Ok(decision)) if decision.decision == "deny" => {
                    return Err((
                        StatusCode::FORBIDDEN,
                        "Leash blocked this model request".into(),
                    ))
                }
                Ok(Ok(decision)) => {
                    if let Some(prompt) = decision.final_prompt {
                        if latest_prompt(&value).as_deref() != Some(prompt.as_str()) {
                            replace_latest_prompt(&mut value, &prompt);
                            transformed = true;
                        }
                    }
                }
                Ok(Err(error)) if !availability_bypass_allowed(&app.config, &error) => {
                    return Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        format!("Leash backend unavailable: {error}"),
                    ))
                }
                Ok(Err(_)) => {
                    app.availability_bypasses.fetch_add(1, Ordering::Relaxed);
                }
                Err(_) if !app.config.fail_open => {
                    return Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Leash request evaluation timed out".to_owned(),
                    ))
                }
                Err(_) => {
                    app.availability_bypasses.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }
    drop(request_evaluation_permit);
    let upstream_base = upstream_for(
        &app.config,
        &parts.uri.to_string(),
        &value,
        &parts.headers,
        &agent_kind,
    );
    let upstream_uri = upstream_request_uri(&parts.uri.to_string(), &parts.headers, &agent_kind);
    let url = join_upstream_url(upstream_base, &upstream_uri)
        .map_err(|error| (StatusCode::BAD_GATEWAY, error))?;
    let mut outbound = app
        .client
        .request(parts.method, url)
        .body(match outbound_body {
            Some(body) => body,
            None if transformed => {
                reqwest::Body::from(serde_json::to_vec(&value).map_err(internal)?)
            }
            None => reqwest::Body::from(original_bytes.expect("intercepted request bytes")),
        });
    outbound = outbound.header("x-request-id", request_id.clone());
    outbound = copy_headers(outbound, &parts.headers);
    let upstream = outbound.send().await.map_err(|error| {
        app.upstream_errors.fetch_add(1, Ordering::Relaxed);
        internal(error)
    })?;
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let content_type = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    if intercept
        && !monitoring_paused
        && !background_control_request
        && status.is_success()
        && request_may_produce_tools(&value, &agent_kind)
    {
        let _gate_permit = app.gate_slots.acquire().await.map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Leash tool gate is shutting down".to_owned(),
            )
        })?;
        app.gated_responses.fetch_add(1, Ordering::Relaxed);
        let bytes =
            collect_gated_response(upstream.bytes_stream(), app.config.max_gated_response_bytes)
                .await?;
        let observation = response_observation_for_content_type(&content_type, &bytes);
        if let Some(tool) = observation.tool.as_ref() {
            let evaluation = tokio::time::timeout(
                Duration::from_secs(app.config.evaluation_timeout_seconds),
                evaluate_tool_call(
                    &app,
                    &parts.uri.to_string(),
                    &agent_kind,
                    tool,
                    &observation.text,
                    &session_id,
                ),
            )
            .await;
            match evaluation {
                Ok(Ok(decision)) if decision.decision == "allow" => {}
                Ok(Ok(decision)) => {
                    app.gate_denials.fetch_add(1, Ordering::Relaxed);
                    return Err((
                        StatusCode::FORBIDDEN,
                        format!("Leash blocked this tool call: {}", decision.decision),
                    ));
                }
                Ok(Err(error)) if !availability_bypass_allowed(&app.config, &error) => {
                    return Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        format!("Leash tool evaluation unavailable: {error}"),
                    ))
                }
                Ok(Err(_)) => {
                    app.availability_bypasses.fetch_add(1, Ordering::Relaxed);
                }
                Err(_) if !app.config.fail_open => {
                    app.gate_timeouts.fetch_add(1, Ordering::Relaxed);
                    return Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Leash tool evaluation timed out".to_owned(),
                    ));
                }
                Err(_) => {
                    app.gate_timeouts.fetch_add(1, Ordering::Relaxed);
                    app.availability_bypasses.fetch_add(1, Ordering::Relaxed);
                }
            }
        } else {
            let report_app = app.clone();
            let report_path = parts.uri.to_string();
            let report_agent = agent_kind.clone();
            let report_content_type = content_type.clone();
            let report_bytes = bytes.clone();
            tokio::spawn(async move {
                let _ = report_response(
                    &report_app,
                    &report_path,
                    &report_content_type,
                    &report_bytes,
                    &report_agent,
                    &session_id,
                )
                .await;
            });
        }
        return response_with_body(status, &headers, &request_id, Body::from(bytes));
    }
    let mut stream = upstream.bytes_stream();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, reqwest::Error>>(16);
    let report_app = app.clone();
    let report_path = parts.uri.to_string();
    let report_agent = agent_kind.clone();
    let report_agent_response = intercept && !monitoring_paused && !background_control_request;
    let report_session = session_id.clone();
    tokio::spawn(async move {
        let mut captured = Vec::new();
        while let Some(chunk) = stream.next().await {
            if let Ok(bytes) = &chunk {
                if captured.len() < report_app.config.capture_bytes {
                    let remaining = report_app.config.capture_bytes - captured.len();
                    captured.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
                }
            }
            if tx.send(chunk).await.is_err() {
                return;
            }
        }
        if report_agent_response && !captured.is_empty() {
            let _ = report_response(
                &report_app,
                &report_path,
                &content_type,
                &captured,
                &report_agent,
                &report_session,
            )
            .await;
        }
    });
    response_with_body(
        status,
        &headers,
        &request_id,
        Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)),
    )
}

fn response_with_body(
    status: StatusCode,
    headers: &HeaderMap,
    request_id: &str,
    body: Body,
) -> Result<Response<Body>, (StatusCode, String)> {
    let mut response = Response::builder().status(status);
    response = response.header("x-request-id", request_id);
    let response_connection_headers = connection_header_names(headers);
    for (name, value) in headers.iter() {
        let lower = name.as_str().to_ascii_lowercase();
        if lower != "content-length"
            && !is_hop_by_hop(&lower)
            && !response_connection_headers.contains(&lower)
            && lower != "x-request-id"
        {
            response = response.header(name, value);
        }
    }
    response.body(body).map_err(internal)
}

async fn collect_gated_response(
    mut stream: impl futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
    limit: usize,
) -> Result<Bytes, (StatusCode, String)> {
    let mut collected = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(internal)?;
        if collected.len().saturating_add(chunk.len()) > limit {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("gated model response exceeds {limit} bytes"),
            ));
        }
        collected.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(collected))
}

async fn websocket_pump(
    client: axum::extract::ws::WebSocket,
    upstream: String,
    headers: HeaderMap,
) -> Result<(), String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = upstream
        .into_client_request()
        .map_err(|error| error.to_string())?;
    for (name, value) in &headers {
        let lower = name.as_str().to_ascii_lowercase();
        if !matches!(
            lower.as_str(),
            "host"
                | "connection"
                | "upgrade"
                | "sec-websocket-key"
                | "sec-websocket-version"
                | "sec-websocket-extensions"
                | "content-length"
        ) && !lower.starts_with("x-openleash-")
        {
            request.headers_mut().append(name, value.clone());
        }
    }
    let (upstream, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|error| error.to_string())?;
    let (mut client_tx, mut client_rx) = client.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();
    loop {
        tokio::select! {
            incoming = client_rx.next() => match incoming {
                Some(Ok(message)) => { if upstream_tx.send(ax_to_tg(message)).await.is_err() { break; } }
                _ => break,
            },
            outgoing = upstream_rx.next() => match outgoing {
                Some(Ok(message)) => { if let Some(message) = tg_to_ax(message) { if client_tx.send(message).await.is_err() { break; } } }
                _ => break,
            }
        }
    }
    Ok(())
}

fn ax_to_tg(message: AxMessage) -> tokio_tungstenite::tungstenite::Message {
    use tokio_tungstenite::tungstenite::Message;
    match message {
        AxMessage::Text(v) => Message::Text(v),
        AxMessage::Binary(v) => Message::Binary(v),
        AxMessage::Ping(v) => Message::Ping(v),
        AxMessage::Pong(v) => Message::Pong(v),
        AxMessage::Close(_) => Message::Close(None),
    }
}
fn tg_to_ax(message: tokio_tungstenite::tungstenite::Message) -> Option<AxMessage> {
    use tokio_tungstenite::tungstenite::Message;
    match message {
        Message::Text(v) => Some(AxMessage::Text(v)),
        Message::Binary(v) => Some(AxMessage::Binary(v)),
        Message::Ping(v) => Some(AxMessage::Ping(v)),
        Message::Pong(v) => Some(AxMessage::Pong(v)),
        Message::Close(_) => Some(AxMessage::Close(None)),
        Message::Frame(_) => None,
    }
}
fn is_websocket(headers: &HeaderMap) -> bool {
    headers
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}
fn websocket_url(base: &str, path: &str) -> String {
    join_upstream_url(base, path)
        .unwrap_or_else(|_| format!("{}{}", base.trim_end_matches('/'), path))
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1)
}

async fn report_response(
    app: &App,
    path: &str,
    content_type: &str,
    bytes: &[u8],
    agent_kind: &str,
    session_id: &str,
) -> Result<(), reqwest::Error> {
    let response = response_observation_for_content_type(content_type, bytes);
    if response.text.trim().is_empty() && response.tool.is_none() {
        return Ok(());
    }
    let event_name = if response.tool.is_some() {
        "PreToolUse"
    } else {
        "Stop"
    };
    let occurred_at = chrono::Utc::now().to_rfc3339();
    let envelope = json!({
      "source":"local_proxy", "provider":provider(path, &Value::Null),
      "correlationId":session_id,
      "request":{"computer":{"hostname":"local-proxy","platform":std::env::consts::OS},
        "agent":{"kind":agent_kind,"displayName":agent_display_name(agent_kind)},
        "event":{"eventName":event_name,"agentKind":agent_kind,"sessionId":session_id,"prompt":response.text,
          "tool":response.tool,"transcript":[{"role":"assistant","content":response.text}],"raw":{"proxyPath":path,"response":true},"occurredAt":occurred_at}}
    });
    app.client
        .post(format!(
            "{}/v1/agent-events",
            app.config.client_api.trim_end_matches('/')
        ))
        .bearer_auth(&app.config.token)
        .json(&envelope)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

fn response_observation_for_content_type(content_type: &str, bytes: &[u8]) -> ResponseObservation {
    let prefix = bytes
        .iter()
        .copied()
        .skip_while(|byte| byte.is_ascii_whitespace())
        .take(6)
        .collect::<Vec<_>>();
    if content_type.contains("text/event-stream")
        || prefix.starts_with(b"event:")
        || prefix.starts_with(b"data:")
    {
        sse_observation(bytes)
    } else {
        serde_json::from_slice::<Value>(bytes)
            .ok()
            .map(|value| response_observation(&value))
            .unwrap_or_default()
    }
}

async fn evaluate_tool_call(
    app: &App,
    path: &str,
    agent_kind: &str,
    tool: &Value,
    response_text: &str,
    session_id: &str,
) -> Result<Decision, reqwest::Error> {
    let occurred_at = chrono::Utc::now().to_rfc3339();
    let envelope = json!({
      "source":"local_proxy", "provider":provider(path, &Value::Null),
      "correlationId":session_id,
      "request":{"computer":{"hostname":"local-proxy","platform":std::env::consts::OS},
        "agent":{"kind":agent_kind,"displayName":agent_display_name(agent_kind)},
        "event":{"eventName":"PreToolUse","agentKind":agent_kind,"sessionId":session_id,"prompt":response_text,
          "tool":tool,"transcript":[{"role":"assistant","content":response_text}],"raw":{"proxyPath":path,"response":true,"gated":true},"occurredAt":occurred_at}}
    });
    app.client
        .post(format!(
            "{}/v1/agent-events",
            app.config.client_api.trim_end_matches('/')
        ))
        .bearer_auth(&app.config.token)
        .json(&envelope)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
}

#[derive(Default)]
struct ResponseObservation {
    text: String,
    tool: Option<Value>,
}

fn sse_observation(bytes: &[u8]) -> ResponseObservation {
    let normalized = String::from_utf8_lossy(bytes).replace("\r\n", "\n");
    let mut observation = ResponseObservation::default();
    let mut streamed_text = String::new();
    let mut completed_text = String::new();
    let mut streamed_tool_name: Option<String> = None;
    let mut streamed_tool_arguments = String::new();
    for event in normalized.split("\n\n") {
        let data = event
            .lines()
            .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if let Some(delta) = sse_response_text_delta(&value) {
            streamed_text.push_str(&delta);
        } else if !is_streamed_tool_input_event(event_type) {
            completed_text.push_str(&response_text(&value));
        }
        if let Some(block) = value.get("content_block") {
            if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                streamed_tool_name = block.get("name").and_then(Value::as_str).map(str::to_owned);
                if let Some(input) = block.get("input").filter(|input| {
                    !input.is_null() && input.as_object().is_none_or(|object| !object.is_empty())
                }) {
                    streamed_tool_arguments = input.to_string();
                }
            }
        }
        if let Some(partial) = value
            .get("delta")
            .and_then(|delta| delta.get("partial_json"))
            .and_then(Value::as_str)
        {
            streamed_tool_arguments.push_str(partial);
        }
        if event_type.contains("function_call_arguments.delta")
            || event_type.contains("custom_tool_call_input.delta")
        {
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                streamed_tool_arguments.push_str(delta);
            }
        }
        if event_type.contains("custom_tool_call_input.done") {
            if let Some(input) = value.get("input").and_then(Value::as_str) {
                streamed_tool_arguments = input.to_owned();
            }
        }
        if let Some(function) = value
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("delta"))
            .and_then(|delta| delta.get("tool_calls"))
            .and_then(Value::as_array)
            .and_then(|calls| calls.first())
            .and_then(|call| call.get("function"))
        {
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                streamed_tool_name = Some(name.to_owned());
            }
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                streamed_tool_arguments.push_str(arguments);
            }
        }
        if let Some(item) = value.get("item") {
            if item
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| {
                    matches!(
                        kind,
                        "function_call" | "computer_call" | "local_shell_call" | "custom_tool_call"
                    )
                })
            {
                streamed_tool_name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("type").and_then(Value::as_str))
                    .map(str::to_owned);
                if let Some(arguments) = item.get("arguments").or_else(|| item.get("input")) {
                    let arguments = arguments
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| arguments.to_string());
                    if event_type.ends_with(".done") || streamed_tool_arguments.is_empty() {
                        streamed_tool_arguments = arguments;
                    }
                }
            }
        }
        if observation.tool.is_none() {
            observation.tool = response_tool(&value);
        }
    }
    if let Some(name) = streamed_tool_name {
        let input = serde_json::from_str::<Value>(&streamed_tool_arguments)
            .unwrap_or(Value::String(streamed_tool_arguments));
        observation.tool = Some(normalize_response_tool(&name, input));
    }
    observation.text = if streamed_text.is_empty() {
        completed_text
    } else {
        streamed_text
    };
    observation
}

fn is_streamed_tool_input_event(event_type: &str) -> bool {
    event_type.contains("function_call_arguments") || event_type.contains("custom_tool_call_input")
}

fn sse_response_text_delta(value: &Value) -> Option<String> {
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    if is_streamed_tool_input_event(event_type) {
        return None;
    }
    if event_type == "response.output_text.delta" {
        return value
            .get("delta")
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    if event_type == "content_block_delta"
        && value
            .get("delta")
            .and_then(|delta| delta.get("type"))
            .and_then(Value::as_str)
            == Some("text_delta")
    {
        return value
            .get("delta")
            .and_then(|delta| delta.get("text"))
            .and_then(Value::as_str)
            .map(str::to_owned);
    }
    if let Some(text) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("delta"))
        .and_then(|delta| delta.get("content"))
        .and_then(Value::as_str)
    {
        return Some(text.to_owned());
    }
    if event_type.is_empty() {
        if let Some(text) = value.get("delta").and_then(Value::as_str) {
            return Some(text.to_owned());
        }
        if let Some(text) = value
            .get("delta")
            .and_then(|delta| delta.get("text"))
            .and_then(Value::as_str)
        {
            return Some(text.to_owned());
        }
    }
    None
}

fn response_observation(value: &Value) -> ResponseObservation {
    ResponseObservation {
        text: response_text(value),
        tool: response_tool(value),
    }
}

fn response_tool(value: &Value) -> Option<Value> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let candidate = if is_tool_response_item_kind(kind) {
        value
    } else if matches!(
        kind,
        "response.output_item.added" | "response.output_item.done"
    ) {
        value.get("item").filter(|item| {
            item.get("type")
                .and_then(Value::as_str)
                .is_some_and(is_tool_response_item_kind)
        })?
    } else if let Some(tool) = value
        .get("content")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("type").and_then(Value::as_str) == Some("tool_use"))
        })
    {
        tool
    } else if let Some(tool) = value
        .get("output")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| {
                        matches!(
                            kind,
                            "function_call"
                                | "computer_call"
                                | "local_shell_call"
                                | "custom_tool_call"
                        )
                    })
            })
        })
    {
        tool
    } else if let Some(tool) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message").or_else(|| choice.get("delta")))
        .and_then(|message| message.get("tool_calls"))
        .and_then(Value::as_array)
        .and_then(|calls| calls.first())
    {
        tool
    } else {
        return None;
    };
    let function = candidate.get("function").unwrap_or(candidate);
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| candidate.get("type").and_then(Value::as_str))
        .unwrap_or("tool");
    let input = function
        .get("arguments")
        .or_else(|| candidate.get("input"))
        .or_else(|| candidate.get("action"))
        .or_else(|| candidate.get("command"))
        .cloned()
        .unwrap_or(Value::Null);
    Some(normalize_response_tool(name, input))
}

fn is_tool_response_item_kind(kind: &str) -> bool {
    matches!(
        kind,
        "tool_use" | "function_call" | "computer_call" | "local_shell_call" | "custom_tool_call"
    )
}

fn normalize_response_tool(name: &str, input: Value) -> Value {
    if name == "exec" {
        if let Some(code) = input.as_str() {
            if let Some((nested_name, nested_input)) = nested_codex_tool_call(code) {
                return json!({"name":nested_name,"input":nested_input});
            }
        }
    }
    json!({"name":name,"input":input})
}

fn nested_codex_tool_call(code: &str) -> Option<(String, Value)> {
    let tools_offset = code.find("tools.")? + "tools.".len();
    let tail = &code[tools_offset..];
    let open_paren = tail.find('(')?;
    let name = tail[..open_paren].trim();
    if name.is_empty()
        || !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return None;
    }
    let arguments = tail[open_paren + 1..].trim_start();
    if !arguments.starts_with('{') {
        return None;
    }
    let mut depth = 0_u32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, character) in arguments.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    let input = serde_json::from_str::<Value>(&arguments[..=offset]).ok()?;
                    return Some((name.to_owned(), input));
                }
            }
            _ => {}
        }
    }
    None
}

fn response_text(value: &Value) -> String {
    if let Some(delta) = value.get("delta").and_then(Value::as_str) {
        return delta.to_owned();
    }
    if let Some(text) = value
        .get("delta")
        .and_then(|d| d.get("text"))
        .and_then(Value::as_str)
    {
        return text.to_owned();
    }
    if let Some(text) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|c| c.get("delta"))
        .and_then(|d| d.get("content"))
        .and_then(Value::as_str)
    {
        return text.to_owned();
    }
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return text.to_owned();
    }
    if let Some(text) = value.get("output_text").and_then(Value::as_str) {
        return text.to_owned();
    }
    if let Some(content) = value.get("content") {
        return content_text(content);
    }
    if let Some(output) = value.get("output").and_then(Value::as_array) {
        return output
            .iter()
            .map(response_text)
            .collect::<Vec<_>>()
            .join("");
    }
    if let Some(arguments) = value.get("arguments").and_then(Value::as_str) {
        return format!("[tool arguments] {arguments}");
    }
    String::new()
}

async fn evaluate(
    app: &App,
    path: &str,
    body: &Value,
    agent_kind: &str,
    applied_plugin_ids: &[String],
    container_plugin_runs: &[Value],
    background_control_request: bool,
) -> Result<Decision, reqwest::Error> {
    let prompt = latest_prompt(body).unwrap_or_default();
    let (event_name, tool) = request_event(body);
    let session = provider_session_id(body).unwrap_or_else(|| "proxy".to_owned());
    let project_path = provider_project_path(body);
    let occurred_at = body
        .get("openleash_occurred_at")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let transcript = normalized_transcript(body);
    let event = with_optional_project_path(
        json!({"eventName":event_name,"agentKind":agent_kind,"sessionId":session,"prompt":prompt,"tool":tool,"transcript":transcript,
          "raw":{"proxyPath":path,"containerPluginApplied":applied_plugin_ids,"containerPluginRuns":container_plugin_runs,
            "backgroundControl":background_control_request},"occurredAt":occurred_at}),
        project_path,
    );
    let envelope = json!({
      "source":"local_proxy", "provider": provider(path, body),
      "correlationId": session,
      "request": { "computer": {"hostname":"local-proxy","platform":std::env::consts::OS},
        "agent":{"kind":agent_kind,"displayName":agent_display_name(agent_kind)},
        "event":event}
    });
    app.client
        .post(format!(
            "{}/v1/agent-events",
            app.config.client_api.trim_end_matches('/')
        ))
        .bearer_auth(&app.config.token)
        .json(&envelope)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
}

fn with_optional_project_path(mut event: Value, project_path: Option<String>) -> Value {
    if let (Some(fields), Some(project_path)) = (event.as_object_mut(), project_path) {
        fields.insert("projectPath".to_owned(), Value::String(project_path));
    }
    event
}

async fn transform_request(
    app: &App,
    path: &str,
    body: &Value,
    agent_kind: &str,
) -> Result<TransformDecision, reqwest::Error> {
    let session_id = provider_session_id(body).unwrap_or_else(|| "proxy".to_owned());
    let project_path = provider_project_path(body);
    app.client
        .post(format!(
            "{}/v1/plugin-runtime/transform",
            app.config.client_api.trim_end_matches('/')
        ))
        .bearer_auth(&app.config.token)
        .json(&json!({
            "provider": provider(path, body),
            "agentKind": agent_kind,
            "sessionId": session_id,
            "projectPath": project_path,
            "requestBody": body,
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
}

fn provider_session_id(body: &Value) -> Option<String> {
    let direct = body
        .get("conversation_id")
        .or_else(|| body.get("session_id"))
        .or_else(|| body.get("prompt_cache_key"))
        .and_then(Value::as_str);
    if let Some(value) = direct.filter(|value| !value.trim().is_empty()) {
        return Some(value.to_owned());
    }
    let metadata = body
        .get("metadata")
        .and_then(|metadata| metadata.get("user_id"))
        .and_then(Value::as_str)?;
    serde_json::from_str::<Value>(metadata)
        .ok()
        .and_then(|value| {
            value
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .or_else(|| (!metadata.trim().is_empty()).then(|| metadata.to_owned()))
}

fn provider_project_path(body: &Value) -> Option<String> {
    let direct = body
        .get("project_path")
        .or_else(|| body.get("projectPath"))
        .or_else(|| body.get("cwd"))
        .or_else(|| body.get("workspace"))
        .and_then(Value::as_str);
    if let Some(value) = direct.filter(|value| !value.trim().is_empty()) {
        return Some(value.to_owned());
    }
    body.get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| {
            metadata
                .get("project_path")
                .or_else(|| metadata.get("projectPath"))
                .or_else(|| metadata.get("cwd"))
                .or_else(|| metadata.get("workspace"))
        })
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}

fn request_event(body: &Value) -> (&'static str, Option<Value>) {
    let last_message = body
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|items| items.last());
    if let Some(message) = last_message {
        if message.get("role").and_then(Value::as_str) == Some("tool") {
            return (
                "PostToolUse",
                Some(
                    json!({"name":message.get("name").and_then(Value::as_str).unwrap_or("tool"),"output":message.get("content").cloned().unwrap_or(Value::Null)}),
                ),
            );
        }
        if let Some(result) = message
            .get("content")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().rev().find(|item| {
                    item.get("type")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| matches!(kind, "tool_result" | "function_call_output"))
                })
            })
        {
            return (
                "PostToolUse",
                Some(
                    json!({"name":result.get("name").and_then(Value::as_str).unwrap_or("tool"),"output":result.get("content").or_else(|| result.get("output")).cloned().unwrap_or(Value::Null)}),
                ),
            );
        }
    }
    if let Some(item) = body
        .get("input")
        .and_then(Value::as_array)
        .and_then(|items| items.last())
    {
        if item
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind.contains("output"))
        {
            return (
                "PostToolUse",
                Some(
                    json!({"name":item.get("name").and_then(Value::as_str).unwrap_or("tool"),"output":item.get("output").or_else(|| item.get("content")).cloned().unwrap_or(Value::Null)}),
                ),
            );
        }
    }
    ("UserPromptSubmit", None)
}

fn normalized_transcript(body: &Value) -> Vec<Value> {
    let mut turns = Vec::new();
    if let Some(system) = body.get("system") {
        let text = content_text(system);
        if !text.is_empty() {
            turns.push(json!({"role":"system","content":text}));
        }
    }
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        for message in messages {
            let role = match message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user")
            {
                "assistant" => "assistant",
                "system" => "system",
                "tool" => "tool",
                _ => "user",
            };
            let text = content_text(message.get("content").unwrap_or(&Value::Null));
            if !text.is_empty() {
                turns.push(json!({"role":role,"content":text}));
            }
        }
    } else if let Some(input) = body.get("input") {
        if let Some(items) = input.as_array() {
            for item in items {
                let kind = item
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("message");
                let role = item.get("role").and_then(Value::as_str).unwrap_or(
                    if kind.contains("output") {
                        "tool"
                    } else {
                        "user"
                    },
                );
                let text = response_item_text(item);
                if !text.is_empty() {
                    turns.push(json!({"role":role,"content":text}));
                }
            }
        } else {
            let text = content_text(input);
            if !text.is_empty() {
                turns.push(json!({"role":"user","content":text}));
            }
        }
    }
    turns
}

fn response_item_text(item: &Value) -> String {
    let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "message" {
        return content_text(item.get("content").unwrap_or(&Value::Null));
    }
    if matches!(
        kind,
        "function_call" | "computer_call" | "local_shell_call" | "custom_tool_call"
    ) {
        let name = item.get("name").and_then(Value::as_str).unwrap_or(kind);
        let arguments = item
            .get("arguments")
            .or_else(|| item.get("action"))
            .or_else(|| item.get("command"))
            .unwrap_or(&Value::Null);
        return format!("[tool call: {name}] {arguments}");
    }
    if kind.contains("output") {
        return format!(
            "[tool result] {}",
            item.get("output")
                .or_else(|| item.get("content"))
                .unwrap_or(&Value::Null)
        );
    }
    content_text(item)
}

fn content_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    let Some(items) = value.as_array() else {
        return String::new();
    };
    items
        .iter()
        .filter_map(|item| {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                return Some(text.to_owned());
            }
            let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
            if matches!(kind, "tool_use" | "function_call") {
                let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
                let input = item
                    .get("input")
                    .or_else(|| item.get("arguments"))
                    .unwrap_or(&Value::Null);
                return Some(format!("[tool call: {name}] {input}"));
            }
            if matches!(kind, "tool_result" | "function_call_output") {
                return Some(format!(
                    "[tool result] {}",
                    item.get("content")
                        .or_else(|| item.get("output"))
                        .unwrap_or(&Value::Null)
                ));
            }
            None
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn latest_prompt(body: &Value) -> Option<String> {
    if let Some(input) = body.get("input").and_then(Value::as_str) {
        return Some(input.into());
    }
    if let Some(input) = body.get("input").and_then(Value::as_array) {
        return input
            .iter()
            .rev()
            .find(|item| {
                item.get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("message")
                    == "message"
                    && item.get("role").and_then(Value::as_str).unwrap_or("user") == "user"
            })
            .map(response_item_text)
            .filter(|text| !text.is_empty());
    }
    let messages = body.get("messages")?.as_array()?;
    let content = messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(Value::as_str) == Some("user"))?
        .get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.into());
    }
    content
        .as_array()?
        .iter()
        .rev()
        .find_map(|b| b.get("text").and_then(Value::as_str))
        .map(str::to_owned)
}

fn is_background_control_request(agent_kind: &str, body: &Value) -> bool {
    let Some(prompt) = latest_prompt(body) else {
        return false;
    };
    let normalized = prompt.to_ascii_lowercase();
    match agent_kind {
        "claude-code" => {
            !request_can_produce_tools(body)
                && normalized.contains("<session>")
                && normalized.contains("</session>")
                && normalized.contains("write the title in the predominant language of the session")
                && normalized.contains("ignore the language of the examples above")
        }
        "codex" => {
            let task_title = normalized.contains("you will be presented with a user prompt")
                && normalized.contains(
                    "provide a short title for a task that will be created from that prompt",
                )
                && normalized.contains("generate a concise ui title")
                && normalized.contains("fill the structured title field with plain text");
            let project_suggestions = normalized.contains(
                "generate 0 to 3 hyperpersonalized suggestions for what this user can do with codex",
            ) && normalized.contains("in this local project")
                && normalized.contains(
                    "get an understanding of the user's intent and goals",
                );
            let ambient_suggestion_review = normalized.contains(
                "you are an expert at upholding safety and compliance standards for codex ambient suggestions",
            ) && normalized.contains("# ambient suggestion candidates")
                && normalized.contains("suggestions to exclude")
                && normalized.contains("you must not output any other text");
            task_title || project_suggestions || ambient_suggestion_review
        }
        _ => false,
    }
}

fn replace_latest_prompt(body: &mut Value, replacement: &str) {
    if body.get("input").and_then(Value::as_str).is_some() {
        body["input"] = Value::String(replacement.into());
        return;
    }
    if let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) {
        if let Some(item) = input.iter_mut().rev().find(|item| {
            item.get("type")
                .and_then(Value::as_str)
                .unwrap_or("message")
                == "message"
                && item.get("role").and_then(Value::as_str).unwrap_or("user") == "user"
        }) {
            if item.get("content").and_then(Value::as_str).is_some() {
                item["content"] = Value::String(replacement.into());
            } else if let Some(blocks) = item.get_mut("content").and_then(Value::as_array_mut) {
                if let Some(block) = blocks
                    .iter_mut()
                    .rev()
                    .find(|block| block.get("text").is_some() || block.get("input_text").is_some())
                {
                    if block.get("input_text").is_some() {
                        block["input_text"] = Value::String(replacement.into());
                    } else {
                        block["text"] = Value::String(replacement.into());
                    }
                }
            }
        }
        return;
    }
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        if let Some(message) = messages
            .iter_mut()
            .rev()
            .find(|m| m.get("role").and_then(Value::as_str) == Some("user"))
        {
            if message.get("content").and_then(Value::as_str).is_some() {
                message["content"] = Value::String(replacement.into());
            } else if let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) {
                if let Some(block) = blocks.iter_mut().rev().find(|b| b.get("text").is_some()) {
                    block["text"] = Value::String(replacement.into());
                }
            }
        }
    }
}

fn provider(path: &str, body: &Value) -> &'static str {
    if path.contains("/publishers/")
        || path.contains(":rawPredict")
        || path.contains(":streamRawPredict")
    {
        "google-vertex-ai"
    } else if path.contains("messages") || body.get("anthropic_version").is_some() {
        "anthropic"
    } else if path.contains("responses") {
        "openai-responses"
    } else {
        "openai"
    }
}
fn upstream_for<'a>(
    config: &'a Config,
    path: &str,
    body: &Value,
    headers: &HeaderMap,
    agent_kind: &str,
) -> &'a str {
    if is_codex_chatgpt_request(headers, agent_kind) {
        return &config.chatgpt_upstream;
    }
    if path.contains("aiplatform.googleapis.com")
        || path.contains("/publishers/")
        || path.contains(":rawPredict")
        || path.contains(":streamRawPredict")
    {
        return &config.vertex_upstream;
    }
    match provider(path, body) {
        "anthropic" => &config.anthropic_upstream,
        "openai" | "openai-responses" => &config.openai_upstream,
        _ => &config.upstream,
    }
}

fn is_codex_chatgpt_request(headers: &HeaderMap, agent_kind: &str) -> bool {
    let explicitly_marked = headers
        .get("x-openleash-codex-auth-mode")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("chatgpt"));
    if explicitly_marked {
        return true;
    }
    if agent_kind != "codex" {
        return false;
    }
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| token.starts_with("eyJ") && token.matches('.').count() == 2)
}

fn upstream_request_uri(request_path_query: &str, headers: &HeaderMap, agent_kind: &str) -> String {
    if !is_codex_chatgpt_request(headers, agent_kind) {
        return request_path_query.to_owned();
    }
    request_path_query
        .strip_prefix("/v1/")
        .map(|suffix| format!("/{suffix}"))
        .unwrap_or_else(|| request_path_query.to_owned())
}
fn copy_headers(
    mut request: reqwest::RequestBuilder,
    headers: &HeaderMap,
) -> reqwest::RequestBuilder {
    let connection_headers = connection_header_names(headers);
    for (name, value) in headers {
        let lower = name.as_str().to_ascii_lowercase();
        if lower != "host"
            && lower != "content-length"
            && !is_hop_by_hop(&lower)
            && !connection_headers.contains(&lower)
            && !lower.starts_with("x-openleash-")
        {
            request = request.header(name, value);
        }
    }
    request
}
fn connection_header_names(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all("connection")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .collect()
}
fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
    )
}
fn join_upstream_url(base: &str, request_path_query: &str) -> Result<String, String> {
    let mut url =
        url::Url::parse(base).map_err(|error| format!("invalid upstream URL: {error}"))?;
    let (request_path, query) = request_path_query
        .split_once('?')
        .map(|(p, q)| (p, Some(q)))
        .unwrap_or((request_path_query, None));
    let base_path = url.path().trim_end_matches('/');
    let path = if base_path.is_empty() || base_path == "/" || request_path.starts_with(base_path) {
        request_path.to_owned()
    } else {
        format!("{base_path}/{}", request_path.trim_start_matches('/'))
    };
    url.set_path(&path);
    url.set_query(query);
    Ok(url.to_string())
}
fn extract_agent_uri(uri: &axum::http::Uri) -> (String, axum::http::Uri) {
    let path = uri.path();
    let Some(rest) = path.strip_prefix("/agent/") else {
        return ("unknown".into(), uri.clone());
    };
    let Some((agent, suffix)) = rest.split_once('/') else {
        return ("unknown".into(), uri.clone());
    };
    if agent.is_empty()
        || !agent
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return ("unknown".into(), uri.clone());
    }
    let normalized = format!(
        "/{}{}",
        suffix,
        uri.query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default()
    );
    match normalized.parse() {
        Ok(uri) => (agent.to_owned(), uri),
        Err(_) => ("unknown".into(), uri.clone()),
    }
}
fn agent_display_name(kind: &str) -> &str {
    match kind {
        "claude-code" => "Claude Code",
        "codex" => "OpenAI Codex",
        "opencode" => "OpenCode",
        "nanoclaw" => "NanoClaw",
        "openclaw" => "OpenClaw",
        "github-copilot" => "GitHub Copilot",
        "cursor" => "Cursor",
        "cline" => "Cline",
        "aider" => "Aider",
        "continue" => "Continue",
        "goose" => "Goose",
        "openhands" => "OpenHands",
        "mistral-vibe" => "Mistral Vibe",
        _ => "Local proxied agent",
    }
}
fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("application/json"))
}
fn is_llm_path(path: &str) -> bool {
    path.contains("/messages") || path.contains("/chat/completions") || path.contains("/responses")
}
fn request_can_produce_tools(body: &Value) -> bool {
    body.get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty())
        || body
            .get("input")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("type").and_then(Value::as_str) == Some("additional_tools")
                        && item
                            .get("tools")
                            .and_then(Value::as_array)
                            .is_some_and(|tools| !tools.is_empty())
                })
            })
}

fn request_may_produce_tools(body: &Value, agent_kind: &str) -> bool {
    // Codex can receive provider-defined local shell tools even when the
    // Responses request does not include an explicit top-level `tools` array.
    // Gate its non-background responses so those tool calls are evaluated
    // before the client can execute them.
    agent_kind == "codex" || request_can_produce_tools(body)
}
fn internal(error: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::BAD_GATEWAY, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewrites_openai_prompt() {
        let mut v = json!({"messages":[{"role":"user","content":"old"}]});
        replace_latest_prompt(&mut v, "new");
        assert_eq!(latest_prompt(&v).as_deref(), Some("new"));
    }
    #[test]
    fn rewrites_anthropic_blocks() {
        let mut v = json!({"messages":[{"role":"user","content":[{"type":"text","text":"old"}]}]});
        replace_latest_prompt(&mut v, "new");
        assert_eq!(latest_prompt(&v).as_deref(), Some("new"));
    }
    #[test]
    fn extracts_claude_session_from_metadata_json() {
        let value = json!({"metadata":{"user_id":"{\"device_id\":\"device\",\"session_id\":\"session-123\"}"}});
        assert_eq!(provider_session_id(&value).as_deref(), Some("session-123"));
    }
    #[test]
    fn extracts_project_path_from_provider_context() {
        assert_eq!(
            provider_project_path(&json!({"metadata":{"cwd":"/Users/max/Code/OpenLeash"}}))
                .as_deref(),
            Some("/Users/max/Code/OpenLeash"),
        );
        assert_eq!(
            provider_project_path(&json!({"projectPath":"/workspace/service"})).as_deref(),
            Some("/workspace/service"),
        );
    }

    #[test]
    fn missing_project_path_is_omitted_from_agent_events() {
        let without_path =
            with_optional_project_path(json!({"eventName":"UserPromptSubmit"}), None);
        assert!(!without_path
            .as_object()
            .unwrap()
            .contains_key("projectPath"));
        let with_path = with_optional_project_path(
            json!({"eventName":"UserPromptSubmit"}),
            Some("/workspace/service".to_owned()),
        );
        assert_eq!(with_path["projectPath"], "/workspace/service");
    }
    #[test]
    fn transform_response_can_pause_monitoring_for_one_request_session() {
        let decision: TransformDecision = serde_json::from_value(json!({
            "requestBody": {"prompt_cache_key": "conversation-1"},
            "appliedPluginIds": [],
            "runs": [],
            "monitoringPaused": true
        }))
        .unwrap();
        assert!(decision.monitoring_paused);
        assert_eq!(
            provider_session_id(&decision.request_body).as_deref(),
            Some("conversation-1"),
        );
    }
    #[test]
    fn normalizes_tool_conversation() {
        let v = json!({"messages":[{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"path":"a"}}]},{"role":"user","content":[{"type":"tool_result","content":"ok"}]}]});
        let t = normalized_transcript(&v);
        assert_eq!(t.len(), 2);
        assert!(t[0]["content"].as_str().unwrap().contains("Read"));
    }
    #[test]
    fn parses_split_provider_sse_payloads() {
        let body=b"data: {\"delta\":{\"text\":\"hello \"}}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\ndata: [DONE]\n\n";
        assert_eq!(sse_observation(body).text, "hello world");
    }
    #[test]
    fn codex_sse_uses_deltas_without_repeating_the_completed_text() {
        let body = r#"event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"¡Hola! "}

event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"¿En qué te ayudo?"}

event: response.output_text.done
data: {"type":"response.output_text.done","text":"¡Hola! ¿En qué te ayudo?"}

data: [DONE]

"#
        .as_bytes();
        assert_eq!(sse_observation(body).text, "¡Hola! ¿En qué te ayudo?");
    }
    #[test]
    fn codex_sse_uses_completed_text_when_no_deltas_are_present() {
        let body = br#"event: response.output_text.done
data: {"type":"response.output_text.done","text":"hello"}

data: [DONE]

"#;
        assert_eq!(sse_observation(body).text, "hello");
    }
    #[test]
    fn responses_items_preserve_tools_and_replace_latest_user_text() {
        let mut value = json!({"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"old"}]},{"type":"function_call","name":"shell","arguments":"{\"cmd\":\"ls\"}"},{"type":"function_call_output","output":"ok"}]});
        let transcript = normalized_transcript(&value);
        assert_eq!(transcript.len(), 3);
        assert!(transcript[1]["content"].as_str().unwrap().contains("shell"));
        replace_latest_prompt(&mut value, "new");
        assert_eq!(latest_prompt(&value).as_deref(), Some("new"));
    }
    #[test]
    fn sse_crlf_and_multi_data_lines_are_supported() {
        let body =
            b"event: response.output_text.delta\r\ndata: {\"delta\":\r\ndata: \"hello\"}\r\n\r\n";
        assert_eq!(sse_observation(body).text, "hello");
    }
    #[test]
    fn parses_codex_custom_tool_call_input_deltas() {
        let body = br#"event: response.output_item.added
data: {"type":"response.output_item.added","item":{"type":"custom_tool_call","name":"exec","input":""}}

event: response.custom_tool_call_input.delta
data: {"type":"response.custom_tool_call_input.delta","delta":"const r = await tools.exec_command({\"cmd\":\"rm -- delete-me.txt\"});"}

event: response.custom_tool_call_input.done
data: {"type":"response.custom_tool_call_input.done","input":"const r = await tools.exec_command({\"cmd\":\"rm -- delete-me.txt\"});"}

data: [DONE]

"#;
        let tool = sse_observation(body).tool.expect("Codex custom tool call");
        assert_eq!(tool["name"], "exec_command");
        assert_eq!(tool["input"]["cmd"], "rm -- delete-me.txt");
    }
    #[test]
    fn does_not_classify_responses_message_items_as_tools() {
        let event = json!({
            "type":"response.output_item.added",
            "item":{"type":"message","role":"assistant","content":[]}
        });
        assert!(response_tool(&event).is_none());
    }
    #[test]
    fn sniffs_sse_when_upstream_omits_content_type() {
        let body = br#"event: response.output_item.done
data: {"type":"response.output_item.done","item":{"type":"custom_tool_call","name":"exec","input":"rm -- delete-me.txt"}}

data: [DONE]

"#;
        let observation = response_observation_for_content_type("", body);
        assert_eq!(observation.tool.expect("sniffed SSE")["name"], "exec");
    }
    #[test]
    fn upstream_url_preserves_prefix_query_and_avoids_duplicate_prefix() {
        assert_eq!(
            join_upstream_url("https://example.com/openai", "/v1/responses?api-version=1").unwrap(),
            "https://example.com/openai/v1/responses?api-version=1"
        );
        assert_eq!(
            join_upstream_url("https://example.com/v1", "/v1/messages").unwrap(),
            "https://example.com/v1/messages"
        );
    }

    #[test]
    fn codex_chatgpt_requests_drop_the_standard_v1_prefix() {
        let mut headers = HeaderMap::new();
        headers.insert("x-openleash-codex-auth-mode", "chatgpt".parse().unwrap());
        assert!(is_codex_chatgpt_request(&headers, "codex"));
        assert_eq!(
            upstream_request_uri("/v1/models?client_version=1", &headers, "codex"),
            "/models?client_version=1",
        );
        assert_eq!(
            upstream_request_uri("/v1/responses", &headers, "codex"),
            "/responses",
        );
        assert_eq!(
            join_upstream_url(
                "https://chatgpt.com/backend-api/codex",
                &upstream_request_uri("/v1/responses", &headers, "codex"),
            )
            .unwrap(),
            "https://chatgpt.com/backend-api/codex/responses",
        );
    }

    #[test]
    fn codex_chatgpt_bearer_tokens_select_the_chatgpt_upstream_without_a_marker() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            "Bearer eyJheader.payload.signature".parse().unwrap(),
        );
        assert!(is_codex_chatgpt_request(&headers, "codex"));
        assert!(!is_codex_chatgpt_request(&headers, "claude-code"));
        headers.insert("authorization", "Bearer sk-test".parse().unwrap());
        assert!(!is_codex_chatgpt_request(&headers, "codex"));
    }
    #[test]
    fn hop_by_hop_and_connection_headers_are_identified() {
        let mut headers = HeaderMap::new();
        headers.insert("connection", "x-remove, keep-alive".parse().unwrap());
        assert!(connection_header_names(&headers).contains(&"x-remove".to_owned()));
        assert!(is_hop_by_hop("transfer-encoding"));
        assert!(!is_hop_by_hop("authorization"));
    }
    #[test]
    fn agent_prefix_is_attributed_and_removed_before_upstream() {
        let uri: axum::http::Uri = "/agent/codex/v1/responses?stream=1".parse().unwrap();
        let (agent, normalized) = extract_agent_uri(&uri);
        assert_eq!(agent, "codex");
        assert_eq!(normalized.to_string(), "/v1/responses?stream=1");
    }
    #[test]
    fn classifies_tool_results_and_provider_tool_calls() {
        let request =
            json!({"input":[{"type":"function_call_output","name":"shell","output":"ok"}]});
        let (event, tool) = request_event(&request);
        assert_eq!(event, "PostToolUse");
        assert_eq!(tool.unwrap()["output"], "ok");

        let response = json!({"choices":[{"message":{"tool_calls":[{"function":{"name":"shell","arguments":"{\"cmd\":\"pwd\"}"}}]}}]});
        assert_eq!(response_tool(&response).unwrap()["name"], "shell");
    }
    #[test]
    fn treats_codex_responses_as_tool_capable_without_explicit_tools() {
        let request = json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{"type":"input_text","text":"Delete delete-me.txt"}]
            }]
        });
        assert!(!request_can_produce_tools(&request));
        assert!(request_may_produce_tools(&request, "codex"));
        assert!(!request_may_produce_tools(&request, "claude-code"));
    }
    #[test]
    fn recognizes_claude_session_title_generation_as_background_control_traffic() {
        let request = json!({
            "messages": [{
                "role": "user",
                "content": "<session>\ndelete all the tables in test.db sqlite file\n</session>\n\nWrite the title in the predominant language of the session. A stray word or code token in another language doesn't change it. Ignore the language of the examples above."
            }]
        });
        assert!(is_background_control_request("claude-code", &request));
        assert!(!is_background_control_request("codex", &request));
    }
    #[test]
    fn recognizes_codex_task_title_generation_as_background_control_traffic() {
        let request = json!({
            "tools": [{
                "type": "function",
                "name": "read_only_app_lookup"
            }],
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.\nGenerate a concise UI title (up to 36 characters) for this task.\nFill the structured title field with plain text.\n\nUser prompt:\nSummarize run.py"
                }]
            }]
        });
        assert!(is_background_control_request("codex", &request));
        assert!(!is_background_control_request("claude-code", &request));
    }
    #[test]
    fn recognizes_codex_project_suggestions_as_background_control_traffic() {
        let request = json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "# Overview\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: /Users/max/Documents/New project\nGet an understanding of the user's intent and goals by deeply viewing the project."
                }]
            }]
        });
        assert!(is_background_control_request("codex", &request));
        assert!(!is_background_control_request("claude-code", &request));
    }
    #[test]
    fn recognizes_codex_ambient_suggestion_review_as_background_control_traffic() {
        let request = json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "You are an expert at upholding safety and compliance standards for Codex ambient suggestions.\n# Ambient suggestion candidates\nHere are the candidates.\nReturn suggestions to exclude. You must not output any other text."
                }]
            }]
        });
        assert!(is_background_control_request("codex", &request));
        assert!(!is_background_control_request("claude-code", &request));
    }
    #[test]
    fn does_not_hide_an_ordinary_codex_prompt_without_tools() {
        let request = json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "Summarize run.py in one line"
                }]
            }]
        });
        assert!(!is_background_control_request("codex", &request));
    }
    #[test]
    fn does_not_hide_an_ordinary_session_wrapped_user_prompt() {
        let request = json!({
            "messages": [{
                "role": "user",
                "content": "<session>delete all the tables in test.db sqlite file</session>"
            }]
        });
        assert!(!is_background_control_request("claude-code", &request));
    }
}
