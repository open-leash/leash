import type {
  EvaluationRequest,
  PluginCapabilities,
  PluginConversationContext,
  PluginConversationRecentRequest,
  PluginInstructionFile,
  PluginLlmJsonRequest,
  PluginLlmJsonResult,
  PluginLogRecord,
  PluginLogLevel,
  PluginLogRequest,
  PluginPermission,
  PluginSignalKind,
  PluginSignalRecord,
  PluginSignalRequest,
  PluginStorageGetRequest,
  PluginStorageListRequest,
  PluginStorageScope,
  PluginUsageKind,
  PluginUsageRecord,
  PluginUsageRecordRequest
} from "@openleash/shared";
import OpenAI from "openai";
import { pool } from "../db.js";
import type { TenantModelKey } from "../model-keys.js";
import { clearIslandContribution, publishIslandContribution } from "./island-contributions.js";

// Request-path plugin classification should use a fast model by default. The
// heavyweight policy model remains independently configurable via
// OPENAI_EVAL_MODEL, while operators can explicitly override this value.
const pluginLlmModel = process.env.OPENLEASH_PLUGIN_LLM_MODEL ?? "gpt-4.1-mini";
const pluginLlmTimeoutMs = Math.max(
  1000,
  Number(process.env.OPENLEASH_PLUGIN_LLM_TIMEOUT_MS ?? 8000),
);
const pluginAnthropicModel = process.env.ANTHROPIC_EVAL_MODEL ?? "claude-3-5-sonnet-latest";
const pluginDeepseekModel = process.env.DEEPSEEK_EVAL_MODEL ?? "deepseek-chat";

export function createPluginCapabilities({
  tenantModelKey,
  organizationId,
  pluginId,
  request,
  conversationEventId,
  userId,
  computerId,
  runtimeId,
  permissions = [],
}: {
  tenantModelKey?: TenantModelKey;
  organizationId?: string;
  pluginId: string;
  request?: EvaluationRequest;
  conversationEventId?: string;
  userId?: string;
  computerId?: string;
  runtimeId?: string;
  permissions?: PluginPermission[];
}): PluginCapabilities {
  const storage: PluginCapabilities["storage"] = {
    async get<T = unknown>({ key, scope }: PluginStorageGetRequest) {
      requirePermission(permissions, "storage:read");
      if (!organizationId) return undefined;
      const stateKey = normalizedStateKey(key);
      const result = await pool.query<{ value: unknown; updated_at: string; expires_at: string | null }>(
        `select state_key, value, updated_at, expires_at
         from plugin_state
         where organization_id = $1
           and plugin_id = $2
           and scope_key = $3
           and state_key = $4
           and (expires_at is null or expires_at > now())`,
        [organizationId, pluginId, scopeKey(scope, request, userId), stateKey]
      );
      const row = result.rows[0];
      return row ? { key: stateKey, scope, value: row.value as T, updatedAt: row.updated_at, expiresAt: row.expires_at } : undefined;
    },
    async set({ key, value, scope, ttlSeconds }) {
      requirePermission(permissions, "storage:write");
      const stateKey = normalizedStateKey(key);
      const serializedValue = serializedPluginState(value);
      if (!organizationId) {
        return { key: stateKey, scope, value, updatedAt: new Date().toISOString(), expiresAt: null };
      }
      const result = await pool.query<{ value: unknown; updated_at: string; expires_at: string | null }>(
        `insert into plugin_state (organization_id, plugin_id, scope_key, state_key, value, expires_at, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, case when $6::int is null then null else now() + ($6::int * interval '1 second') end, now())
         on conflict (organization_id, plugin_id, scope_key, state_key) do update set
           value = excluded.value,
           expires_at = excluded.expires_at,
           updated_at = now()
         returning value, updated_at, expires_at`,
        [organizationId, pluginId, scopeKey(scope, request, userId), stateKey, serializedValue, normalizedTtl(ttlSeconds)]
      );
      const row = result.rows[0];
      return { key: stateKey, scope, value: row.value, updatedAt: row.updated_at, expiresAt: row.expires_at };
    },
    async list<T = unknown>({ keyPrefix, scope, limit }: PluginStorageListRequest = {}) {
      requirePermission(permissions, "storage:read");
      if (!organizationId) return [];
      const result = await pool.query<{ state_key: string; value: unknown; updated_at: string; expires_at: string | null }>(
        `select state_key, value, updated_at, expires_at
         from plugin_state
         where organization_id = $1
           and plugin_id = $2
           and scope_key = $3
           and ($4::text is null or state_key like $4::text || '%')
           and (expires_at is null or expires_at > now())
         order by updated_at desc
         limit $5`,
        [organizationId, pluginId, scopeKey(scope, request, userId), cleanPrefix(keyPrefix), normalizedLimit(limit)]
      );
      return result.rows.map((row) => ({
        key: row.state_key,
        scope,
        value: row.value as T,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at
      }));
    },
    async delete({ key, scope }) {
      requirePermission(permissions, "storage:write");
      if (!organizationId) return;
      const stateKey = normalizedStateKey(key);
      await pool.query(
        `delete from plugin_state
         where organization_id = $1 and plugin_id = $2 and scope_key = $3 and state_key = $4`,
        [organizationId, pluginId, scopeKey(scope, request, userId), stateKey]
      );
    }
  };

  return {
    context: {
      instructions: {
        async list({ agent, scope } = {}) {
          requirePermission(permissions, "instructions:read");
          const rawFiles = Array.isArray((request?.event.raw as { instructionFiles?: unknown })?.instructionFiles)
            ? (request?.event.raw as { instructionFiles: unknown[] }).instructionFiles
            : [];
          return rawFiles
            .map(normalizeInstructionFile)
            .filter((file): file is NonNullable<ReturnType<typeof normalizeInstructionFile>> => Boolean(file))
            .filter((file) => !agent || file.agent.toLowerCase() === agent.toLowerCase())
            .filter((file) => !scope || file.scope === scope);
        }
      },
      conversation: {
        async recent(recentRequest: PluginConversationRecentRequest = {}) {
          requirePermission(permissions, "conversation:read");
          return recentConversationContext({
            userId,
            request,
            limit: recentRequest.limit,
          });
        }
      }
    },
    llm: {
      evaluateJson(request) {
        requirePermission(permissions, "model:invoke");
        return evaluatePluginJson(request, tenantModelKey);
      }
    },
    storage,
    notification: {
      async send(notification) {
        requirePermission(permissions, "notification:send");
        const dedupeKey = notification.dedupeKey?.trim();
        if (!dedupeKey || !organizationId) {
          return { sent: true, deduped: false };
        }
        const key = normalizedStateKey(`notification:${dedupeKey}`);
        const existing = await pool.query<{ updated_at: string }>(
          `select updated_at
           from plugin_state
           where organization_id = $1
             and plugin_id = $2
             and scope_key = $3
             and state_key = $4
             and (expires_at is null or expires_at > now())`,
          [
            organizationId,
            pluginId,
            scopeKey(notification.scope, request, userId),
            key,
          ],
        );
        if (existing.rows[0] && notification.minIntervalSeconds) {
          const ageMs =
            Date.now() - new Date(existing.rows[0].updated_at).getTime();
          if (ageMs < notification.minIntervalSeconds * 1000) return { sent: false, deduped: true };
        }
        await pool.query(
          `insert into plugin_state
           (organization_id, plugin_id, scope_key, state_key, value, expires_at, updated_at)
           values ($1, $2, $3, $4, $5::jsonb,
             case when $6::int is null then null else now() + ($6::int * interval '1 second') end,
             now())
           on conflict (organization_id, plugin_id, scope_key, state_key) do update set
             value = excluded.value,
             expires_at = excluded.expires_at,
             updated_at = now()`,
          [
            organizationId,
            pluginId,
            scopeKey(notification.scope, request, userId),
            key,
            serializedPluginState({
              level: notification.level,
              title: notification.title,
              summary: notification.summary,
            }),
            normalizedTtl(notification.minIntervalSeconds),
          ],
        );
        return { sent: true, deduped: false };
      }
    },
    island: {
      async annotateSession(annotation) {
        requirePermission(permissions, "island:publish");
        return await publishIslandContribution(
          { organizationId, userId, pluginId, agentId: runtimeId ?? request?.agent.instanceId, request },
          { kind: "annotation", ...annotation },
        );
      },
      async reportActivity(activity) {
        requirePermission(permissions, "island:publish");
        return await publishIslandContribution(
          { organizationId, userId, pluginId, agentId: runtimeId ?? request?.agent.instanceId, request },
          { kind: "activity", ...activity },
        );
      },
      async publishStatus(status) {
        requirePermission(permissions, "island:publish");
        return await publishIslandContribution(
          { organizationId, userId, pluginId, agentId: runtimeId ?? request?.agent.instanceId, request },
          { kind: "status", ...status },
        );
      },
      async clear(clearRequest) {
        requirePermission(permissions, "island:publish");
        return await clearIslandContribution(
          { organizationId, userId, pluginId, agentId: runtimeId ?? request?.agent.instanceId, request },
          clearRequest,
        );
      },
    },
    log: {
      async emit(log) {
        requirePermission(permissions, "log:write");
        return emitPluginLog({
          organizationId,
          pluginId,
          conversationEventId,
          userId,
          computerId,
          runtimeId,
          request,
          log
        });
      }
    },
    signals: {
      async emit(signal) {
        requirePermission(permissions, "signal:write");
        return emitPluginSignal({
          organizationId,
          pluginId,
          conversationEventId,
          userId,
          computerId,
          runtimeId,
          request,
          signal
        });
      }
    },
    usage: {
      async record(usage) {
        requirePermission(permissions, "usage:write");
        return recordPluginUsage({
          organizationId,
          pluginId,
          conversationEventId,
          userId,
          computerId,
          runtimeId,
          request,
          usage
        });
      }
    }
  };
}

function requirePermission(permissions: PluginPermission[], permission: PluginPermission) {
  if (!permissions.includes(permission)) {
    throw new Error(`plugin capability requires ${permission}`);
  }
}

async function recentConversationContext({
  userId,
  request,
  limit,
}: {
  userId?: string;
  request?: EvaluationRequest;
  limit?: number;
}): Promise<PluginConversationContext> {
  const sessionId = request?.event.sessionId ?? "";
  const boundedLimit = normalizedConversationLimit(limit);
  const candidates = [normalizeConversationTurns(request?.event.transcript)];

  if (userId && sessionId) {
    const result = await pool.query<{ payload: unknown }>(
      `select ce.payload
       from conversation_events ce
       where ce.user_id = $1
         and ce.session_id = $2
       order by ce.occurred_at desc, ce.created_at desc
       limit 20`,
      [userId, sessionId],
    );
    candidates.push(
      ...result.rows.map((row) => {
        if (!row.payload || typeof row.payload !== "object") return [];
        return normalizeConversationTurns(
          (row.payload as { transcript?: unknown }).transcript,
        );
      }),
    );
    const promptTurns = result.rows.slice().reverse().flatMap((row) => {
      if (!row.payload || typeof row.payload !== "object") return [];
      const payload = row.payload as { eventName?: unknown; prompt?: unknown };
      if (payload.eventName !== "UserPromptSubmit" || typeof payload.prompt !== "string" || !payload.prompt.trim()) return [];
      return [{ role: "user" as const, content: payload.prompt.trim().slice(0, 4_000) }];
    });
    if (promptTurns.length > 0) candidates.push(promptTurns);
  }

  const turns = candidates.reduce(
    (longest, candidate) =>
      candidate.length > longest.length ? candidate : longest,
    [] as PluginConversationContext["turns"],
  );
  return {
    sessionId,
    turns: turns.slice(-boundedLimit),
    truncated: turns.length > boundedLimit,
  };
}

function normalizeConversationTurns(
  value: unknown,
): PluginConversationContext["turns"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (
        turn,
      ): turn is { role?: unknown; content?: unknown; at?: unknown } =>
        Boolean(turn && typeof turn === "object"),
    )
    .flatMap((turn) => {
      const role = turn.role;
      const content =
        typeof turn.content === "string" ? turn.content.trim() : "";
      if (
        !content ||
        (role !== "user" &&
          role !== "assistant" &&
          role !== "tool" &&
          role !== "system")
      ) {
        return [];
      }
      return [{
        role: role as PluginConversationContext["turns"][number]["role"],
        content: content.slice(0, 50_000),
        ...(typeof turn.at === "string" ? { at: turn.at } : {}),
      }];
    });
}

function normalizedConversationLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(100, Math.floor(Number(value))));
}

function normalizeInstructionFile(value: unknown): PluginInstructionFile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const content = typeof record.content === "string" ? record.content : "";
  if (!content) return undefined;
  const scope: PluginInstructionFile["scope"] = record.scope === "global" || record.scope === "project" ? record.scope : "project";
  const parsedLines = Array.isArray(record.parsedLines)
    ? record.parsedLines.filter((line): line is string => typeof line === "string" && line.trim().length > 0).map((line) => line.trim())
    : undefined;
  return {
    agent: typeof record.agent === "string" && record.agent.trim() ? record.agent.trim() : "unknown",
    scope,
    label: typeof record.label === "string" ? record.label : undefined,
    path: typeof record.path === "string" ? record.path : undefined,
    content,
    parsedLines
  };
}

async function evaluatePluginJson<T = unknown>(
  request: PluginLlmJsonRequest,
  tenantModelKey?: TenantModelKey
): Promise<PluginLlmJsonResult<T> | undefined> {
  const config = pluginModelConfig(tenantModelKey);
  if (!config) return undefined;
  const prompt = String(request.prompt ?? "").trim();
  if (!prompt) return undefined;

  if (config.provider === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      signal: AbortSignal.timeout(pluginLlmTimeoutMs),
      body: JSON.stringify({
        model: pluginAnthropicModel,
        max_tokens: normalizedMaxTokens(request.maxOutputTokens),
        system: request.system ?? "Return only valid JSON.",
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!response.ok) throw new Error(`Plugin LLM evaluation failed (${response.status})`);
    const body = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    const text = body.content?.find((item) => item.type === "text" && item.text)?.text ?? "";
    return {
      json: JSON.parse(text) as T,
      model: pluginAnthropicModel,
      provider: config.provider,
      source: config.source
    };
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    timeout: pluginLlmTimeoutMs,
    maxRetries: 0,
    ...(config.baseURL ? { baseURL: config.baseURL } : {})
  });
  if (config.provider === "deepseek") {
    const response = await client.chat.completions.create({
      model: pluginDeepseekModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: request.system ?? "Return only valid JSON." },
        { role: "user", content: prompt }
      ],
      temperature: normalizedTemperature(request.temperature)
    });
    return {
      json: JSON.parse(response.choices[0]?.message?.content ?? "{}") as T,
      model: pluginDeepseekModel,
      provider: config.provider,
      source: config.source
    };
  }

  const response = await client.responses.create({
    model: pluginLlmModel,
    input: [
      { role: "system", content: request.system ?? "Return only valid JSON." },
      { role: "user", content: prompt }
    ],
    text: request.schema
      ? {
          format: {
            type: "json_schema",
            name: "openleash_plugin_json",
            strict: true,
            schema: request.schema
          }
        }
      : { format: { type: "json_object" } },
    temperature: normalizedTemperature(request.temperature),
    max_output_tokens: normalizedMaxTokens(request.maxOutputTokens)
  });
  return {
    json: JSON.parse(response.output_text) as T,
    model: pluginLlmModel,
    provider: config.provider,
    source: config.source
  };
}

export function pluginModelConfig(
  tenantModelKey?: TenantModelKey,
  env: NodeJS.ProcessEnv = process.env,
):
  | { provider: "openai" | "anthropic" | "deepseek"; apiKey: string; baseURL?: string; source: "tenant-byok" | "openleash-managed" }
  | undefined {
  if (tenantModelKey?.apiKey) {
    if (tenantModelKey.provider === "deepseek") {
      return { provider: "deepseek", apiKey: tenantModelKey.apiKey, baseURL: "https://api.deepseek.com", source: "tenant-byok" };
    }
    return { provider: tenantModelKey.provider, apiKey: tenantModelKey.apiKey, source: "tenant-byok" };
  }
  if (tenantModelKey?.managedFallback === false) return undefined;
  // OPENAI_API_KEY commonly belongs to the coding agent or shell that
  // launched OpenLeash. Treating that ambient credential as the OpenLeash
  // evaluation key can unexpectedly consume the user's provider allowance and turns a
  // provider error into a failed hook. Managed evaluation must be configured
  // explicitly, while Individual Open Source uses its saved tenant BYOK key.
  const apiKey = env.OPENLEASH_OPENAI_API_KEY;
  return apiKey ? { provider: "openai", apiKey, source: "openleash-managed" } : undefined;
}

function normalizedMaxTokens(value: unknown) {
  const parsed = Number(value ?? 500);
  if (!Number.isFinite(parsed)) return 500;
  return Math.max(80, Math.min(2000, Math.round(parsed)));
}

function normalizedTemperature(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

async function emitPluginLog({
  organizationId,
  pluginId,
  conversationEventId,
  userId,
  computerId,
  runtimeId,
  request,
  log
}: {
  organizationId?: string;
  pluginId: string;
  conversationEventId?: string;
  userId?: string;
  computerId?: string;
  runtimeId?: string;
  request?: EvaluationRequest;
  log: PluginLogRequest;
}) {
  const level = normalizeLogLevel(log.level);
  const category = normalizeLogCategory(log.category);
  const message = String(log.message ?? "").trim().slice(0, 4000) || "Plugin log event.";
  const code = typeof log.code === "string" && log.code.trim() ? log.code.trim().slice(0, 120) : undefined;
  const scope = log.scope ?? {
    agentKind: request?.agent.kind,
    sessionId: request?.event.sessionId,
    projectPath: request?.event.projectPath
  };
  const data = sanitizeLogData(log.data);
  const createdAt = new Date().toISOString();

  if (!organizationId) {
    return { pluginId, level, message, code, category, data, scope, createdAt };
  }

  const result = await pool.query<{ id: string; created_at: string }>(
    `insert into plugin_log_events
     (organization_id, plugin_id, conversation_event_id, user_id, computer_id, agent_runtime_id, level, category, code, message, scope, data)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
     returning id, created_at`,
    [
      organizationId,
      pluginId,
      conversationEventId ?? null,
      userId ?? null,
      computerId ?? null,
      runtimeId ?? null,
      level,
      category,
      code ?? null,
      message,
      JSON.stringify(scope ?? {}),
      JSON.stringify(data)
    ]
  );
  return {
    id: result.rows[0]?.id,
    pluginId,
    level,
    message,
    code,
    category,
    data,
    scope,
    createdAt: result.rows[0]?.created_at ?? createdAt
  };
}

async function emitPluginSignal({
  organizationId,
  pluginId,
  conversationEventId,
  userId,
  computerId,
  runtimeId,
  request,
  signal
}: {
  organizationId?: string;
  pluginId: string;
  conversationEventId?: string;
  userId?: string;
  computerId?: string;
  runtimeId?: string;
  request?: EvaluationRequest;
  signal: PluginSignalRequest;
}): Promise<PluginSignalRecord> {
  const kind = normalizeSignalKind(signal.kind);
  const severity = normalizeSignalSeverity(signal.severity);
  const title = cleanText(signal.title, 240) || "Plugin signal";
  const summary = cleanText(signal.summary, 2000);
  const decision = normalizeSignalDecision(signal.decision);
  const status = cleanText(signal.status, 80);
  const target = sanitizeTarget(signal.target);
  const evidence = sanitizeEvidence(signal.evidence);
  const details = sanitizeLogData(signal.details);
  const correlationKeys = normalizeCorrelationKeys(signal.correlationKeys, request, userId, computerId, runtimeId);
  const occurredAt = normalizeTimestamp(signal.occurredAt);
  const createdAt = new Date().toISOString();

  if (!organizationId) {
    return signalRecord({
      pluginId,
      kind,
      severity,
      title,
      summary,
      decision,
      status,
      target,
      evidence,
      details,
      correlationKeys,
      occurredAt,
      createdAt,
      request
    });
  }

  const result = await pool.query<{ id: string; created_at: string; occurred_at: string }>(
    `insert into plugin_signals
     (organization_id, plugin_id, conversation_event_id, user_id, computer_id, agent_runtime_id, kind, severity, title, summary, decision, status, target, evidence, details, correlation_keys, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::text[], $17)
     returning id, created_at, occurred_at`,
    [
      organizationId,
      pluginId,
      conversationEventId ?? null,
      userId ?? null,
      computerId ?? null,
      runtimeId ?? null,
      kind,
      severity,
      title,
      summary ?? null,
      decision ?? null,
      status ?? null,
      JSON.stringify(target),
      JSON.stringify(evidence),
      JSON.stringify(details),
      correlationKeys,
      occurredAt
    ]
  );

  return signalRecord({
    id: result.rows[0]?.id,
    organizationId,
    conversationEventId,
    userId,
    computerId,
    agentRuntimeId: runtimeId,
    pluginId,
    kind,
    severity,
    title,
    summary,
    decision,
    status,
    target,
    evidence,
    details,
    correlationKeys,
    occurredAt: result.rows[0]?.occurred_at ?? occurredAt,
    createdAt: result.rows[0]?.created_at ?? createdAt,
    request
  });
}

async function recordPluginUsage({
  organizationId,
  pluginId,
  conversationEventId,
  userId,
  computerId,
  runtimeId,
  request,
  usage
}: {
  organizationId?: string;
  pluginId: string;
  conversationEventId?: string;
  userId?: string;
  computerId?: string;
  runtimeId?: string;
  request?: EvaluationRequest;
  usage: PluginUsageRecordRequest;
}): Promise<PluginUsageRecord> {
  const kind = normalizeUsageKind(usage.kind);
  const provider = cleanText(usage.provider, 80);
  const model = cleanText(usage.model, 160);
  const quantity = finiteNumber(usage.quantity);
  const unit = cleanText(usage.unit, 40);
  const inputTokens = finiteInteger(usage.inputTokens);
  const outputTokens = finiteInteger(usage.outputTokens);
  const savedTokens = finiteInteger(usage.savedTokens);
  const estimatedCostCents = Math.max(0, Math.round(finiteNumber(usage.estimatedCostUsd) * 100));
  const details = sanitizeLogData(usage.details);
  const occurredAt = normalizeTimestamp(usage.occurredAt);
  const createdAt = new Date().toISOString();

  if (!organizationId) {
    return usageRecord({
      pluginId,
      kind,
      provider,
      model,
      quantity,
      unit,
      inputTokens,
      outputTokens,
      savedTokens,
      estimatedCostUsd: estimatedCostCents / 100,
      details,
      occurredAt,
      createdAt,
      request
    });
  }

  const result = await pool.query<{ id: string; created_at: string; occurred_at: string }>(
    `insert into plugin_usage_records
     (organization_id, plugin_id, conversation_event_id, user_id, computer_id, agent_runtime_id, kind, provider, model, quantity, unit, input_tokens, output_tokens, saved_tokens, estimated_cost_cents, details, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17)
     returning id, created_at, occurred_at`,
    [
      organizationId,
      pluginId,
      conversationEventId ?? null,
      userId ?? null,
      computerId ?? null,
      runtimeId ?? null,
      kind,
      provider ?? null,
      model ?? null,
      quantity,
      unit ?? null,
      inputTokens,
      outputTokens,
      savedTokens,
      estimatedCostCents,
      JSON.stringify(details),
      occurredAt
    ]
  );

  return usageRecord({
    id: result.rows[0]?.id,
    organizationId,
    conversationEventId,
    userId,
    computerId,
    agentRuntimeId: runtimeId,
    pluginId,
    kind,
    provider,
    model,
    quantity,
    unit,
    inputTokens,
    outputTokens,
    savedTokens,
    estimatedCostUsd: estimatedCostCents / 100,
    details,
    occurredAt: result.rows[0]?.occurred_at ?? occurredAt,
    createdAt: result.rows[0]?.created_at ?? createdAt,
    request
  });
}

function scopeKey(
  scope: PluginStorageScope | undefined,
  request: EvaluationRequest | undefined,
  authenticatedUserId?: string,
) {
  const merged = {
    agentKind: scope?.agentKind ?? request?.agent.kind,
    sessionId: scope?.sessionId ?? request?.event.sessionId,
    conversationId: scope?.conversationId,
    projectPath: scope?.projectPath ?? request?.event.projectPath,
    // The authenticated runtime owns user scope. A plugin cannot select another
    // employee by putting a user id in its request.
    userId: authenticatedUserId ?? scope?.userId,
    key: scope?.key
  };
  const entries = Object.entries(merged)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? JSON.stringify(Object.fromEntries(entries)) : "global";
}

function normalizedTtl(value: number | undefined) {
  if (!Number.isFinite(value)) return null;
  return Math.max(1, Math.min(60 * 60 * 24 * 365, Math.floor(Number(value))));
}

function normalizedLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(500, Math.floor(Number(value))));
}

function cleanPrefix(value: string | undefined) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 240) : null;
}

function normalizedStateKey(value: unknown) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key || key.length > 240) {
    throw new Error("plugin storage key must contain 1 to 240 characters");
  }
  return key;
}

function serializedPluginState(value: unknown) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("plugin storage value must be JSON-serializable");
  }
  if (serialized === undefined) {
    throw new Error("plugin storage value must be JSON-serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) {
    throw new Error("plugin storage value exceeds the 256 KiB limit");
  }
  return serialized;
}

function normalizeLogLevel(value: unknown): PluginLogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error" || value === "security"
    ? value
    : "info";
}

function normalizeLogCategory(value: unknown): PluginLogRecord["category"] {
  return value === "system" || value === "security" || value === "audit" ? value : "plugin";
}

function sanitizeLogData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([key, entry]) => [key.slice(0, 120), sanitizeLogValue(entry, 0)])
  );
}

function normalizeSignalKind(value: unknown): PluginSignalKind {
  const kinds: PluginSignalKind[] = [
    "security.finding",
    "policy.decision",
    "approval.event",
    "secret.detected",
    "tool.risk",
    "mcp.discovery",
    "identity.risk",
    "audit.event",
    "plugin.health",
    "export.status"
  ];
  return kinds.includes(value as PluginSignalKind) ? value as PluginSignalKind : "audit.event";
}

function normalizeSignalSeverity(value: unknown): PluginSignalRecord["severity"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low" || value === "info"
    ? value
    : "info";
}

function normalizeUsageKind(value: unknown): PluginUsageKind {
  const kinds: PluginUsageKind[] = ["llm.tokens", "plugin.compute", "plugin.operation", "network.egress", "storage.bytes"];
  return kinds.includes(value as PluginUsageKind) ? value as PluginUsageKind : "plugin.operation";
}

function normalizeSignalDecision(value: unknown): PluginSignalRequest["decision"] {
  return value === "allow" ||
    value === "ask" ||
    value === "deny" ||
    value === "blocked" ||
    value === "approved" ||
    value === "rejected" ||
    value === "observed"
    ? value
    : undefined;
}

function cleanText(value: unknown, max: number) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, max) : undefined;
}

function sanitizeTarget(value: PluginSignalRequest["target"] | undefined) {
  if (!value || typeof value !== "object") return {};
  return {
    ...(cleanText(value.type, 80) ? { type: cleanText(value.type, 80) } : {}),
    ...(cleanText(value.name, 240) ? { name: cleanText(value.name, 240) } : {}),
    ...(cleanText(value.id, 160) ? { id: cleanText(value.id, 160) } : {})
  };
}

function sanitizeEvidence(value: unknown) {
  if (value === undefined) return [];
  return sanitizeLogValue(value, 0);
}

function normalizeCorrelationKeys(
  keys: string[] | undefined,
  request: EvaluationRequest | undefined,
  userId?: string,
  computerId?: string,
  runtimeId?: string
) {
  const base = [
    userId ? `user:${userId}` : undefined,
    computerId ? `computer:${computerId}` : undefined,
    runtimeId ? `agent-runtime:${runtimeId}` : undefined,
    request?.agent.kind ? `agent:${request.agent.kind}` : undefined,
    request?.event.sessionId ? `session:${request.event.sessionId}` : undefined
  ];
  return [...new Set([...(keys ?? []), ...base]
    .filter((key): key is string => typeof key === "string" && key.trim().length > 0)
    .map((key) => key.trim().slice(0, 200)))]
    .slice(0, 24);
}

function normalizeTimestamp(value: unknown) {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function finiteNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function finiteInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function signalRecord(input: PluginSignalRecord & { request?: EvaluationRequest }): PluginSignalRecord {
  const { request, ...record } = input;
  return {
    ...record,
    agentKind: record.agentKind ?? request?.agent.kind,
    sessionId: record.sessionId ?? request?.event.sessionId,
    projectPath: record.projectPath ?? request?.event.projectPath
  };
}

function usageRecord(input: PluginUsageRecord & { request?: EvaluationRequest }): PluginUsageRecord {
  const { request, ...record } = input;
  return {
    ...record,
    agentKind: record.agentKind ?? request?.agent.kind,
    sessionId: record.sessionId ?? request?.event.sessionId,
    projectPath: record.projectPath ?? request?.event.projectPath
  };
}

function sanitizeLogValue(value: unknown, depth: number): unknown {
  if (depth > 4) return "[Truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 1999)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeLogValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, entry]) => [key.slice(0, 120), sanitizeLogValue(entry, depth + 1)])
    );
  }
  return String(value);
}
