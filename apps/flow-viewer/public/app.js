import { canonicalPluginSlug, canonicalPluginText } from "./plugin-slug.js";

const state = {
  events: [],
  agent: "all",
  selected: null,
  paused: false,
  search: "",
  openPayloads: new Set(),
};
const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

async function refresh() {
  if (state.paused) return;
  try {
    const payload = await fetch("/api/events", { cache: "no-store" }).then(
      (response) => response.json(),
    );
    state.events = payload.events || [];
    $("#connection").textContent = "Live";
    $("#updated").textContent = new Date().toLocaleTimeString();
    render();
  } catch {
    $("#connection").textContent = "Disconnected";
  }
}

function conversations() {
  const groups = new Map();
  let activeKey = null;
  for (const event of state.events) {
    if (event.stage === "pipeline.plugins" && !event.agent) {
      if (activeKey && groups.has(activeKey)) {
        const group = groups.get(activeKey);
        const inheritedSource = [...group.sources].at(-1);
        group.events.push({ ...event, source: inheritedSource });
      }
      continue;
    }
    const agent =
      event.agent || event.envelope?.request?.agent?.kind || "system";
    const session =
      event.sessionId ||
      event.envelope?.request?.event?.sessionId ||
      event.traceId ||
      "unknown";
    const key = `${agent}:${session}`;
    activeKey = key;
    if (!groups.has(key))
      groups.set(key, {
        key,
        agent,
        session,
        events: [],
        last: event.timestamp,
        prompt: "",
        decision: "pending",
        sources: new Set(),
      });
    const group = groups.get(key);
    if (event.source) group.sources.add(event.source);
    group.events.push(event);
    group.last = event.timestamp || group.last;
    group.prompt ||=
      event.payload?.request?.event?.prompt ||
      event.envelope?.request?.event?.prompt ||
      event.payload?.prompt ||
      "";
    if (event.decision) group.decision = event.decision;
  }
  return [...groups.values()].sort((a, b) =>
    String(b.last).localeCompare(String(a.last)),
  );
}

function render() {
  const all = conversations();
  const counts = all.reduce(
    (map, item) => map.set(item.agent, (map.get(item.agent) || 0) + 1),
    new Map(),
  );
  $("#allCount").textContent = all.length;
  $("#agents").innerHTML = [...counts.entries()]
    .sort()
    .map(
      ([agent, count]) =>
        `<button class="agent ${state.agent === agent ? "active" : ""}" data-agent="${esc(agent)}"><span>${esc(displayAgent(agent))}</span><b>${count}</b></button>`,
    )
    .join("");
  document.querySelectorAll(".agent").forEach(
    (button) =>
      (button.onclick = () => {
        state.agent = button.dataset.agent;
        state.selected = null;
        render();
      }),
  );
  const outcomes = new Set(
    [...document.querySelectorAll("[data-outcome]:checked")].map(
      (input) => input.value,
    ),
  );
  const sources = new Set(
    [...document.querySelectorAll("[data-source]:checked")].map(
      (input) => input.value,
    ),
  );
  const query = state.search.toLowerCase();
  const filtered = all.filter(
    (item) =>
      (state.agent === "all" || item.agent === state.agent) &&
      outcomes.has(item.decision) &&
      [...item.sources].some((source) => sources.has(source)) &&
      (!query || JSON.stringify(item).toLowerCase().includes(query)),
  );
  $("#conversationCount").textContent = `${filtered.length} shown`;
  $("#stats").innerHTML =
    stat("Conversations", all.length) +
    stat("Events", state.events.length) +
    stat("Blocked", all.filter((x) => x.decision === "deny").length) +
    stat("Agents", counts.size);
  $("#conversationList").innerHTML = filtered.length
    ? filtered.map(card).join("")
    : `<div class="empty"><p>No matching traffic yet.</p></div>`;
  document.querySelectorAll("[data-conversation]").forEach(
    (cardEl) =>
      (cardEl.onclick = () => {
        state.selected = cardEl.dataset.conversation;
        renderDetails(all.find((x) => x.key === state.selected));
        render();
      }),
  );
  if (state.selected) renderDetails(all.find((x) => x.key === state.selected));
}
function stat(label, value) {
  return `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
}
function card(item) {
  return `<article class="conversation ${state.selected === item.key ? "active" : ""}" data-conversation="${esc(item.key)}"><div class="conversation-top"><span class="agent-name">${esc(displayAgent(item.agent))}</span><span class="time">${formatTime(item.last)}</span></div><div class="chips">${[...item.sources].map(sourceChip).join("")}</div><div class="prompt">${esc(item.prompt || "No text payload")}</div><div class="chips"><span class="chip">${item.events.length} stages</span><span class="chip ${item.decision}">${esc(item.decision)}</span><span class="chip">${esc(short(item.session, 12))}</span></div></article>`;
}
function renderDetails(item) {
  const details = $("#details");
  if (!item) {
    state.selected = null;
    details.innerHTML =
      `<div class="empty"><h2>Conversation unavailable</h2></div>`;
    return;
  }
  const scrollTop = details.scrollTop;
  details.innerHTML =
    `<div class="detail-head"><small>${esc(displayAgent(item.agent))} · ${esc(item.session)}</small><h2>${esc(item.prompt || "Agent activity")}</h2><div class="chips">${[...item.sources].map(sourceChip).join("")}</div><p>${item.events.length} recorded stages · final outcome ${esc(item.decision)}</p></div><div class="timeline">${item.events.map((event, index) => stage(item, event, index)).join("")}</div>`;
  details.querySelectorAll("details.payload").forEach((payload) => {
    payload.ontoggle = () => {
      const key = payload.dataset.payloadKey;
      if (!key) return;
      if (payload.open) state.openPayloads.add(key);
      else state.openPayloads.delete(key);
    };
  });
  details.scrollTop = scrollTop;
}
function stage(item, event, index) {
  const kind = event.stage?.includes("final")
    ? event.decision === "deny"
      ? "deny"
      : "final"
    : event.stage === "pipeline.plugins"
      ? "plugin"
      : "";
  const plugins = (event.runs || [])
    .map(
      (run) =>
        `<div class="plugin-row"><strong>${esc(canonicalPluginSlug(run.pluginId || run.pluginName))}</strong><small>${esc(run.status)}</small><div>${esc(canonicalPluginText(run.summary || ""))}</div></div>`,
    )
    .join("");
  const payloadKey = [
    item.key,
    event.traceId || event.id || "event",
    event.stage || "stage",
    event.timestamp || index,
    index,
  ].join("|");
  const open = state.openPayloads.has(payloadKey) ? " open" : "";
  return `<div class="stage ${kind}"><i class="dot"></i><div class="stage-title"><span class="stage-label"><span>${esc(stageName(event.stage))}</span>${event.source ? originBadge(event.source) : ""}</span><time>${formatTime(event.timestamp)}</time></div><div class="summary">${esc(stageSummary(event))}</div>${plugins}<details class="payload" data-payload-key="${esc(payloadKey)}"${open}><summary>Inspect complete payload</summary><pre>${esc(JSON.stringify(event, null, 2))}</pre></details></div>`;
}
function sourceInfo(source) {
  return (
    {
      local_proxy: ["🛡️", "local-proxy", "proxy"],
      api_hook: ["🪝", "API hook", "hook"],
      provider_puller: ["☁️", "Provider puller", "puller"],
    }[source] || ["📨", source || "Unknown", "unknown"]
  );
}
function sourceChip(source) {
  const [emoji, label, kind] = sourceInfo(source);
  return `<span class="chip source ${kind}" title="Origin: ${esc(source)}">${emoji} ${esc(label)}</span>`;
}
function originBadge(source) {
  const [emoji, label, kind] = sourceInfo(source);
  return `<span class="origin ${kind}" title="Message origin: ${esc(source)}">${emoji} ${esc(label)}</span>`;
}
function stageName(stage) {
  if (stage?.startsWith("ingress.raw")) return "Raw agent message";
  if (stage?.includes("normalized")) return "Normalized pipeline event";
  if (stage === "pipeline.plugins") return "Plugin evaluation";
  if (stage?.includes("deduplicated")) return "Duplicate merged";
  if (stage?.includes("deferred_to_local_proxy"))
    return "Handed off to local-proxy";
  if (stage?.includes("final")) return "Final outcome";
  return stage || "Event";
}
function stageSummary(event) {
  if (event.transportOutcome)
    return `${event.decision}: ${event.transportOutcome.replaceAll("_", " ")}`;
  if (event.runs?.length)
    return event.runs
      .map((run) => `${canonicalPluginSlug(run.pluginId || run.pluginName)}: ${run.status}`)
      .join(" · ");
  if (event.event) return `${event.event} from ${displayAgent(event.agent)}`;
  return "Recorded pipeline stage";
}
function displayAgent(agent) {
  return (
    {
      "claude-code": "Claude Code",
      codex: "Codex",
      opencode: "OpenCode",
      cline: "Cline",
      cursor: "Cursor",
      system: "Pipeline",
    }[agent] || agent
  );
}
function formatTime(value) {
  return value
    ? new Date(value).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "-";
}
function short(value, n) {
  value = String(value || "");
  return value.length > n ? `${value.slice(0, n)}…` : value;
}

$("#search").oninput = (event) => {
  state.search = event.target.value;
  render();
};
$("#pause").onclick = () => {
  state.paused = !state.paused;
  $("#pause").textContent = state.paused ? "Resume" : "Pause";
};
$("#clear").onclick = async () => {
  if (!window.confirm("Clear all conversations from the local Flow Viewer history?"))
    return;
  const button = $("#clear");
  button.disabled = true;
  try {
    const response = await fetch("/api/events/clear", {
      method: "POST",
      headers: { "x-openleash-flow-viewer": "clear" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.events = [];
    state.selected = null;
    state.openPayloads.clear();
    render();
    $("#details").innerHTML =
      `<div class="empty"><div class="empty-icon">↗</div><h2>Select a conversation</h2><p>Inspect messages, normalization, plugins, decisions, and complete payloads.</p></div>`;
  } catch {
    window.alert("Could not clear the Flow Viewer history.");
  } finally {
    button.disabled = false;
  }
};
document
  .querySelectorAll(".check input")
  .forEach((input) => (input.onchange = render));
refresh();
setInterval(refresh, 1000);
