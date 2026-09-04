import OpenAI from "openai";
export type CompressionLevel = "light" | "standard" | "maximum";
export type DlpCategory = "pii" | "phi" | "tokens" | "keys" | "credentials";
export type DlpAction = "allow" | "ask" | "block" | "mask";

export type PromptTransformConfig = {
  compression: {
    enabled: boolean;
    level: CompressionLevel;
    conciseResponse: boolean;
    model: string;
  };
  dlp: {
    enabled: boolean;
    action: DlpAction;
    categories: DlpCategory[];
    model: string;
    contextMode?: "goal-aware" | "strict";
  };
};

export type PromptTransformResult = {
  finalPrompt: string;
  blocked: boolean;
  requiresApproval?: boolean;
  summary: string;
  model: string;
  compression?: {
    enabled: boolean;
    originalLength: number;
    compressedLength: number;
    ratio: number;
  };
  dlp?: {
    enabled: boolean;
    action: DlpAction;
    matched: boolean;
    categories: DlpCategory[];
    findings: Array<{ category: DlpCategory; quote: string; reason: string }>;
    masked: boolean;
  };
};

export const defaultPromptTransformConfig: PromptTransformConfig = {
  compression: {
    enabled: true,
    level: "standard",
    conciseResponse: false,
    model: process.env.OPENLEASH_PROMPT_TRANSFORM_MODEL ?? "gpt-4.1-nano"
  },
  dlp: {
    enabled: true,
    action: "ask",
    categories: ["pii", "phi", "tokens", "keys", "credentials"],
    model: process.env.OPENLEASH_PROMPT_TRANSFORM_MODEL ?? "gpt-4.1-nano",
    contextMode: "goal-aware"
  }
};

export function normalizePromptTransformConfig(value: unknown): PromptTransformConfig {
  const input = value && typeof value === "object" ? value as Partial<PromptTransformConfig> : {};
  const compression = input.compression && typeof input.compression === "object" ? input.compression as Partial<PromptTransformConfig["compression"]> : {};
  const dlp = input.dlp && typeof input.dlp === "object" ? input.dlp as Partial<PromptTransformConfig["dlp"]> : {};
  return {
    compression: {
      enabled: Boolean(compression.enabled),
      level: isCompressionLevel(compression.level) ? compression.level : defaultPromptTransformConfig.compression.level,
      conciseResponse: Boolean(compression.conciseResponse),
      model: cleanModel(compression.model) ?? defaultPromptTransformConfig.compression.model
    },
    dlp: {
      enabled: Boolean(dlp.enabled),
      action: isDlpAction(dlp.action) ? dlp.action : defaultPromptTransformConfig.dlp.action,
      categories: Array.isArray(dlp.categories) ? dlp.categories.filter(isDlpCategory) : defaultPromptTransformConfig.dlp.categories,
      model: cleanModel(dlp.model) ?? defaultPromptTransformConfig.dlp.model,
      contextMode: dlp.contextMode === "strict" ? "strict" : "goal-aware"
    }
  };
}

export function promptTransformsEnabled(config: PromptTransformConfig) {
  return config.compression.enabled || config.dlp.enabled;
}

export async function transformPrompt({
  prompt,
  config,
  apiKey
}: {
  prompt: string;
  config: PromptTransformConfig;
  apiKey?: string;
}): Promise<PromptTransformResult> {
  let current = prompt;
  const models = new Set<string>();
  let compression: PromptTransformResult["compression"];
  let dlp: PromptTransformResult["dlp"];

  if (config.compression.enabled) {
    const compressed = await compressPrompt({ prompt: current, config, apiKey });
    models.add(compressed.model);
    current = compressed.text;
    if (config.compression.conciseResponse) {
      current = `${current.trim()}\n\nRespond concisely. Be short, direct, and avoid filler.`;
    }
    compression = {
      enabled: true,
      originalLength: prompt.length,
      compressedLength: current.length,
      ratio: prompt.length > 0 ? current.length / prompt.length : 1
    };
  }

  if (config.dlp.enabled) {
    const checked = await checkDlp({ prompt: current, config, apiKey });
    models.add(checked.model);
    dlp = {
      enabled: true,
      action: config.dlp.action,
      matched: checked.matched,
      categories: checked.categories,
      findings: checked.findings,
      masked: checked.masked
    };
    if (checked.blocked) {
      return {
        finalPrompt: current,
        blocked: true,
        summary: `DLP blocked prompt submission: ${checked.categories.join(", ") || "sensitive data"}.`,
        model: [...models].join(", ") || "heuristic",
        compression,
        dlp
      };
    }
    if (checked.requiresApproval) {
      return {
        finalPrompt: current,
        blocked: false,
        requiresApproval: true,
        summary: `Leash is asking before sharing ${checked.categories.join(", ") || "sensitive data"}.`,
        model: [...models].join(", ") || "heuristic",
        compression,
        dlp
      };
    }
    current = checked.text;
  }

  return {
    finalPrompt: current,
    blocked: false,
    summary: summaryFor(prompt, current, compression, dlp),
    model: [...models].join(", ") || "none",
    compression,
    dlp
  };
}

async function compressPrompt({ prompt, config, apiKey }: { prompt: string; config: PromptTransformConfig; apiKey?: string }) {
  if (!apiKey) return { text: heuristicCompress(prompt, config.compression.level), model: "heuristic-compression" };
  try {
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: config.compression.model,
      input: [
        { role: "system", content: compressionInstruction(config.compression.level) },
        { role: "user", content: JSON.stringify({ text: prompt }) }
      ],
      temperature: 0,
      text: {
        format: {
          type: "json_schema",
          name: "openleash_compressed_prompt",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["compressed"],
            properties: { compressed: { type: "string" } }
          }
        }
      }
    });
    const parsed = JSON.parse(response.output_text) as { compressed?: string };
    return { text: parsed.compressed?.trim() || prompt, model: config.compression.model };
  } catch {
    return { text: heuristicCompress(prompt, config.compression.level), model: "heuristic-compression" };
  }
}

async function checkDlp({ prompt, config, apiKey }: { prompt: string; config: PromptTransformConfig; apiKey?: string }) {
  const heuristic = heuristicDlp(prompt, config);
  if (!apiKey) return { ...heuristic, model: "heuristic-dlp" };
  try {
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: config.dlp.model,
      input: [
        {
          role: "system",
          content: [
            "You are OpenLeash DLP. Inspect text for only the configured categories.",
            config.dlp.action === "block"
              ? "If any configured sensitive data is present, return blocked true."
              : config.dlp.action === "mask"
                ? "If configured sensitive data is present, mask it and return the masked text."
                : "Detect configured sensitive data and leave the text unchanged.",
            "Return concise JSON only."
          ].join("\n")
        },
        { role: "user", content: JSON.stringify({ categories: config.dlp.categories, action: config.dlp.action, text: prompt }) }
      ],
      temperature: 0,
      text: {
        format: {
          type: "json_schema",
          name: "openleash_dlp_result",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["matched", "blocked", "maskedText", "categories", "findings"],
            properties: {
              matched: { type: "boolean" },
              blocked: { type: "boolean" },
              maskedText: { type: "string" },
              categories: { type: "array", items: { type: "string", enum: ["pii", "phi", "tokens", "keys", "credentials"] } },
              findings: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["category", "quote", "reason"],
                  properties: {
                    category: { type: "string", enum: ["pii", "phi", "tokens", "keys", "credentials"] },
                    quote: { type: "string" },
                    reason: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    });
    const parsed = JSON.parse(response.output_text) as {
      matched: boolean;
      blocked: boolean;
      maskedText: string;
      categories: DlpCategory[];
      findings: Array<{ category: DlpCategory; quote: string; reason: string }>;
    };
    return {
      matched: parsed.matched,
      blocked: config.dlp.action === "block" && parsed.matched,
      requiresApproval: config.dlp.action === "ask" && parsed.matched,
      masked: config.dlp.action === "mask" && parsed.matched && parsed.maskedText !== prompt,
      text: config.dlp.action === "mask" ? parsed.maskedText || prompt : prompt,
      categories: parsed.categories.filter(isDlpCategory),
      findings: parsed.findings.filter((item) => isDlpCategory(item.category)),
      model: config.dlp.model
    };
  } catch {
    return { ...heuristic, model: "heuristic-dlp" };
  }
}

function heuristicCompress(prompt: string, level: CompressionLevel) {
  const normalized = prompt.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (level === "light") return normalized;
  const limit = level === "maximum" ? 1800 : 3600;
  return normalized.length > limit ? `${normalized.slice(0, limit).trim()}\n\n[OpenLeash compressed remaining repetitive context.]` : normalized;
}

function heuristicDlp(prompt: string, config: PromptTransformConfig) {
  let text = prompt;
  const findings: Array<{ category: DlpCategory; quote: string; reason: string }> = [];
  const add = (category: DlpCategory, regex: RegExp, replacement: string | ((match: string) => string), reason: string) => {
    if (!config.dlp.categories.includes(category)) return;
    text = text.replace(regex, (match) => {
      findings.push({ category, quote: String(match).slice(0, 120), reason });
      return typeof replacement === "function" ? replacement(String(match)) : replacement;
    });
  };
  add("pii", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL_MASKED]", "Email address detected.");
  add("pii", /\b\d{3}-\d{2}-\d{4}\b/g, "[SSN_MASKED]", "US SSN-like value detected.");
  add("tokens", /\b(?:sk|pk|ol|ghp|github_pat)_[A-Za-z0-9_=-]{12,}\b/g, "[TOKEN_MASKED]", "Token-like value detected.");
  add("tokens", /\b(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "[TOKEN_MASKED]", "Provider token-like value detected.");
  add("keys", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g, "[PRIVATE_KEY_MASKED]", "Private key block detected.");
  add("credentials", /\b(password|secret|api[_-]?key)\s*[:=]\s*['"]?[^'"\s]{8,}/gi, (match) => `${match.split(/[:=]/)[0].trim()}=[SECRET_MASKED]`, "Credential assignment detected.");
  add("credentials", /\b(password|secret|api[_-]?key)\s+(?:is\s+|as\s+)?['"]?[^'"\s]{8,}/gi, (match) => `${match.split(/\s+/).slice(0, 2).join(" ")} [SECRET_MASKED]`, "Credential value detected.");
  add("phi", /\b(patient|diagnosis|medical record|mrn)\b[^\n]{0,120}/gi, "[PHI_MASKED]", "Health-data context detected.");
  const categories = [...new Set(findings.map((item) => item.category))];
  const matched = findings.length > 0;
  return {
    matched,
    blocked: config.dlp.action === "block" && matched,
    requiresApproval: config.dlp.action === "ask" && matched,
    masked: config.dlp.action === "mask" && text !== prompt,
    text: config.dlp.action === "mask" ? text : prompt,
    categories,
    findings
  };
}

function compressionInstruction(level: CompressionLevel) {
  if (level === "light") return "Compress this prompt lightly. Remove obvious repetition while preserving all intent, constraints, code names, file paths, and facts. Return JSON {\"compressed\":\"...\"}.";
  if (level === "maximum") return "Compress this prompt as aggressively as possible while preserving task intent, hard constraints, identifiers, code names, file paths, security-sensitive details, and user requirements. Return JSON {\"compressed\":\"...\"}.";
  return "Compress this prompt to reduce tokens while preserving task intent, hard constraints, identifiers, code names, file paths, and important context. Return JSON {\"compressed\":\"...\"}.";
}

function summaryFor(original: string, finalPrompt: string, compression?: PromptTransformResult["compression"], dlp?: PromptTransformResult["dlp"]) {
  const parts = [];
  if (compression?.enabled) parts.push(`compressed ${original.length} to ${finalPrompt.length} chars`);
  if (dlp?.enabled) parts.push(dlp.matched ? `DLP ${dlp.action}${dlp.masked ? "ed" : ""}: ${dlp.categories.join(", ")}` : "DLP passed");
  return parts.length ? `Prompt transformed (${parts.join("; ")}).` : "Prompt transform checked with no changes.";
}

function isCompressionLevel(value: unknown): value is CompressionLevel {
  return value === "light" || value === "standard" || value === "maximum";
}

function isDlpCategory(value: unknown): value is DlpCategory {
  return value === "pii" || value === "phi" || value === "tokens" || value === "keys" || value === "credentials";
}

function isDlpAction(value: unknown): value is DlpAction {
  return value === "allow" || value === "ask" || value === "block" || value === "mask";
}

function cleanModel(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}
