import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { enrichHookBodyWithTranscript } from "./local-server.js";

test("desktop forwards bounded local Claude goal context with hook actions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leash-transcript-"));
  try {
    const transcriptPath = path.join(root, "session.jsonl");
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Deploy the website using its project environment." } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "I will inspect the project configuration." }] } }),
    ].join("\n"));
    const result = enrichHookBodyWithTranscript({ transcript_path: transcriptPath }, root) as { transcript?: Array<{ role: string; content: string }> };
    assert.deepEqual(result.transcript, [
      { role: "user", content: "Deploy the website using its project environment.", at: "2026-01-01T00:00:00Z" },
      { role: "assistant", content: "I will inspect the project configuration.", at: "2026-01-01T00:00:01Z" },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop refuses transcript paths outside the approved Claude project root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leash-transcript-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "leash-transcript-outside-"));
  try {
    const transcriptPath = path.join(outside, "session.jsonl");
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { role: "user", content: "private" } }));
    const body = { transcript_path: transcriptPath };
    assert.equal(enrichHookBodyWithTranscript(body, root), body);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
