const PLUGIN_SLUG_ALIASES: Record<string, string> = {
  "blast radius": "blast-radius",
  "prompt-compression": "token-saver",
  "prompt compression": "token-saver",
  "token-compression": "token-saver",
  "token compression": "token-saver",
  "token saver": "token-saver",
  dlp: "data-leakage-prevention",
};

export function canonicalPluginSlug(value: unknown, fallback = "openleash-core") {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  if (raw.toLowerCase() === "openleash.core") return "openleash-core";
  const unscoped = raw.replace(/^openleash\./i, "");
  const lower = unscoped.toLowerCase();
  return PLUGIN_SLUG_ALIASES[lower] ?? lower.replace(/[\s_]+/g, "-");
}

const RESPONSIBILITY_STATUS_PRIORITY: Record<string, number> = {
  blocked: 300,
  failed: 300,
  needs_question: 200,
};

const RESPONSIBILITY_PLUGIN_PRIORITY: Record<string, number> = {
  "data-leakage-prevention": 4,
  "blast-radius": 3,
  "sensitive-access": 2,
  "rules-enforcer": 1,
  "token-saver": 0,
};

const RESPONSIBILITY_SEVERITY_PRIORITY: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function responsiblePluginSlug(
  directPluginId: unknown,
  payload: unknown,
) {
  const runs = payload && typeof payload === "object" && Array.isArray(
    (payload as { openleashPluginRuns?: unknown }).openleashPluginRuns,
  )
    ? (payload as { openleashPluginRuns: Array<Record<string, unknown>> }).openleashPluginRuns
    : [];
  const responsible = runs
    .map((run, index) => {
      const slug = canonicalPluginSlug(run.pluginId ?? run.plugin_id, "");
      const status = String(run.status ?? "").toLowerCase();
      const severity = Array.isArray(run.findings)
        ? run.findings.reduce((highest, finding) => {
            const value = finding && typeof finding === "object"
              ? String((finding as { severity?: unknown }).severity ?? "").toLowerCase()
              : "";
            return Math.max(highest, RESPONSIBILITY_SEVERITY_PRIORITY[value] ?? 0);
          }, 0)
        : 0;
      return {
        slug,
        score:
          (RESPONSIBILITY_STATUS_PRIORITY[status] ?? 0) +
          severity * 10 +
          (RESPONSIBILITY_PLUGIN_PRIORITY[slug] ?? 0),
        index,
      };
    })
    .filter((run) => run.slug && run.score >= 200)
    .sort((left, right) => right.score - left.score || right.index - left.index)[0];
  return responsible?.slug || canonicalPluginSlug(directPluginId);
}
