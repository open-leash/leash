#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const file = path.resolve(
  process.argv.find((arg) => arg.endsWith(".ndjson")) ??
    "output/openleash-flow.ndjson",
);
const full = process.argv.includes("--full");
let offset = 0;
let remainder = "";

console.log(`Leash flow viewer: ${file}`);
console.log("Waiting for agent traffic. Ctrl+C stops the viewer.\n");

setInterval(() => {
  if (!fs.existsSync(file)) return;
  const size = fs.statSync(file).size;
  if (size < offset) {
    offset = 0;
    remainder = "";
  }
  if (size === offset) return;
  const length = size - offset;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, buffer, 0, length, offset);
  fs.closeSync(fd);
  offset = size;
  const lines = `${remainder}${buffer.toString("utf8")}`.split("\n");
  remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      printRecord(JSON.parse(line));
    } catch {
      console.log(`[invalid trace record] ${line}`);
    }
  }
}, 250).unref();

process.stdin.resume();

function printRecord(record) {
  const label = stageLabel(record.stage);
  const trace = String(
    record.traceId ?? record.conversationEventId ?? "-",
  ).slice(0, 12);
  const identity = [
    record.agent && `agent=${record.agent}`,
    record.event && `event=${record.event}`,
    record.sessionId && `session=${String(record.sessionId).slice(0, 20)}`,
    record.provider && `provider=${record.provider}`,
    record.source && `source=${record.source}`,
    record.decision && `decision=${record.decision}`,
    record.transportOutcome && `transport=${record.transportOutcome}`,
  ]
    .filter(Boolean)
    .join("  ");
  console.log(`\n${label}  trace=${trace}  ${record.timestamp}`);
  if (identity) console.log(identity);
  if (record.runs)
    for (const run of record.runs)
      console.log(
        `  plugin ${run.pluginId}: ${run.status}${run.summary ? `. ${run.summary}` : ""}`,
      );
  if (full) {
    const details = { ...record };
    delete details.timestamp;
    delete details.stage;
    console.log(JSON.stringify(details, null, 2));
  }
}

function stageLabel(stage) {
  if (stage?.startsWith("ingress.raw")) return "1 RAW INGRESS";
  if (stage?.includes("normalized")) return "2 NORMALIZED";
  if (stage === "pipeline.plugins") return "3 PLUGINS";
  if (stage?.includes("deduplicated")) return "4 DEDUPLICATED";
  if (stage?.includes("final")) return "5 FINAL OUTCOME";
  return String(stage ?? "FLOW").toUpperCase();
}
