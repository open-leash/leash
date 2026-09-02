import os from "node:os";
import { apiVersionHeaders } from "./api-contract.js";
import {
  availabilityFailOpen,
  hookApiUrl,
  isAvailabilityTransportError,
  readConfig,
} from "./config.js";

type HookAgent = "claude" | "codex" | "copilot" | "cursor" | "gemini" | "opencode" | "openclaw" | "nanoclaw";
type HookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "SubagentStart" | "SubagentStop" | "Notification" | "SessionEnd" | "Stop";

export async function runHook(agent: HookAgent, eventName: HookEventName) {
  const raw = await readStdin();
  const config = await readConfig();
  const endpoint = new URL(`/v1/hooks/${agent}/${eventName}`, hookApiUrl(config));
  endpoint.searchParams.set("hostname", config.computer?.hostname ?? os.hostname());
  endpoint.searchParams.set("platform", os.platform());
  endpoint.searchParams.set("os_release", os.release());
  if (config.clientVersion) endpoint.searchParams.set("client_version", config.clientVersion);
  const body = raw || "{}";
  // Keep malformed local input outside the transport exception path.
  JSON.parse(body);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
        ...apiVersionHeaders("localHookEvaluate")
      },
      body,
      signal: AbortSignal.timeout(610_000),
    });
  } catch (error) {
    if (availabilityFailOpen(config) && isAvailabilityTransportError(error)) {
      process.stderr.write(
        "Leash desktop is unavailable; continuing temporarily in degraded mode.\n",
      );
      return;
    }
    throw error;
  }

  if (!response.ok) {
    process.stderr.write(`Leash could not evaluate this action (${response.status}).\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(await response.text());
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}
