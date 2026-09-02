import fs from "node:fs/promises";
import { openLeashConfigPath, openLeashDir } from "./paths.js";
import { OPENLEASH_DESKTOP_API_URL, OPENLEASH_PUBLIC_CLOUD_API_URL } from "../public-config.js";

export type LocalConfig = {
  apiUrl: string;
  token: string;
  mode?: "community" | "cloud" | "enterprise" | "personal" | "private";
  tenantUrl?: string;
  remoteApiUrl?: string;
  enrolledAt?: string;
  clientVersion?: string;
  user?: {
    email?: string;
    displayName?: string;
  };
  computer?: {
    id?: string;
    hostname?: string;
  };
};

export const defaultDesktopApiUrl = OPENLEASH_DESKTOP_API_URL;
export const defaultCloudApiUrl = OPENLEASH_PUBLIC_CLOUD_API_URL;

export function hookApiUrl(config: Pick<LocalConfig, "apiUrl" | "remoteApiUrl">) {
  // Hooks stay on the desktop edge. It forwards to the managed API and can
  // enter/recover from degraded mode without rewriting every agent config.
  return config.apiUrl.replace(/\/+$/, "");
}

export function proxyClientApiUrl(config: Pick<LocalConfig, "apiUrl">) {
  return config.apiUrl.replace(/\/+$/, "");
}

export function availabilityFailOpen(config: Pick<LocalConfig, "mode">) {
  // Only Leash-managed Cloud has the local edge's bounded availability
  // bypass. Custom/private backends fail closed because Leash cannot attest
  // to their control plane or entitlement semantics.
  return config.mode === "cloud";
}

export function isAvailabilityTransportError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: string;
    code?: string;
    cause?: { code?: string };
  };
  if (["AbortError", "TimeoutError"].includes(String(candidate.name))) return true;
  const code = String(candidate.cause?.code ?? candidate.code ?? "");
  return [
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOENT",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ].includes(code);
}

export async function readConfig(): Promise<LocalConfig> {
  const raw = await fs.readFile(openLeashConfigPath, "utf8");
  return JSON.parse(raw) as LocalConfig;
}

export async function writeConfig(config: LocalConfig) {
  await fs.mkdir(openLeashDir, { recursive: true });
  await fs.writeFile(openLeashConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}
