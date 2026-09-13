import {
  HOOK_AGENT_METADATA,
  LEASH_CONTROL_CENTER_CONTRACT_VERSION,
  type AgentEventCapabilities,
  type DecisionVerb,
  type EvaluationRequest,
  type HookAgentSlug,
  type HookEventName,
  type LeashCapability,
  type LeashConformanceReport,
  type LeashConnector,
  type LeashDecision,
  type OpenLeashEvent,
} from "@openleash/shared";
import { nativeHookDecision } from "./hook-decisions.js";

export const DECLARED_HOOK_CONNECTORS_FLAG = "OPENLEASH_DECLARED_HOOK_CONNECTORS_ENABLED";

type Shape = { prompt: boolean; response: boolean; toolRequest: boolean; toolResult: boolean; preInference: boolean; preTool: boolean; approval: boolean; max: "ask" | "deny"; friction: 1 | 2 };
const SHAPES: Record<HookAgentSlug, Shape> = {
  claude: { prompt:true,response:true,toolRequest:true,toolResult:true,preInference:true,preTool:true,approval:true,max:"ask",friction:2 },
  nanoclaw: { prompt:true,response:true,toolRequest:true,toolResult:true,preInference:true,preTool:true,approval:true,max:"ask",friction:2 },
  codex: { prompt:true,response:true,toolRequest:true,toolResult:true,preInference:true,preTool:true,approval:true,max:"ask",friction:2 },
  cursor: { prompt:true,response:true,toolRequest:true,toolResult:true,preInference:true,preTool:true,approval:true,max:"ask",friction:2 },
  copilot: { prompt:true,response:true,toolRequest:true,toolResult:true,preInference:true,preTool:true,approval:true,max:"ask",friction:2 },
  gemini: { prompt:true,response:true,toolRequest:true,toolResult:true,preInference:true,preTool:true,approval:true,max:"ask",friction:2 },
  opencode: { prompt:false,response:true,toolRequest:true,toolResult:true,preInference:false,preTool:true,approval:true,max:"ask",friction:2 },
  openclaw: { prompt:true,response:false,toolRequest:false,toolResult:false,preInference:true,preTool:false,approval:false,max:"deny",friction:1 },
};

class DeclaredHookConnector implements LeashConnector<EvaluationRequest, unknown> {
  constructor(readonly agent: HookAgentSlug) {}
  capability(): LeashCapability { return hookCapability(this.agent); }
  async ingest(raw: EvaluationRequest): Promise<OpenLeashEvent[]> { return [raw.event]; }
  async render(decision: LeashDecision, event: OpenLeashEvent) { return nativeHookDecision(this.agent, event.eventName as HookEventName, decision); }
  resolve(decision: LeashDecision): DecisionVerb { return decision.decision === "allow" ? "record" : decision.decision; }
  async selfTest(): Promise<LeashConformanceReport> {
    return { report_id:`fixture-unverified:${this.agent}`, contract_version:LEASH_CONTROL_CENTER_CONTRACT_VERSION, connector_id:this.capability().connector_id, connector_version:"1", implementation_commit:"runtime", vendor_version:"unverified-live", surface:"local", generated_at:new Date().toISOString(), verification:this.capability().verification ?? [] };
  }
}

export const DECLARED_HOOK_CONNECTORS = Object.fromEntries((Object.keys(SHAPES) as HookAgentSlug[]).map((agent) => [agent, new DeclaredHookConnector(agent)])) as Record<HookAgentSlug, DeclaredHookConnector>;

export function hookCapability(agent: HookAgentSlug): LeashCapability {
  const shape = SHAPES[agent];
  const can = {
    see_prompt:shape.prompt, see_response:shape.response, see_tool_request:shape.toolRequest, see_tool_result:shape.toolResult,
    see_local_context:true, block_pre_inference:shape.preInference, block_pre_tool:shape.preTool,
    replace_prompt:false, replace_tool_input:false, replace_response:false, human_approval:shape.approval,
    model_routing:false, cost_data:false, sees_cloud_activity:false, enforces_in_cloud_sessions:false,
  };
  return {
    contract_version:LEASH_CONTROL_CENTER_CONTRACT_VERSION, connector_id:`hook.${HOOK_AGENT_METADATA[agent].kind}.local`, connector_class:"interactive",
    install_friction:shape.friction, max_decision:shape.max, latency_budget_ms:300, can,
    verification:(Object.keys(can) as Array<keyof typeof can>).filter((capability) => can[capability]).map((capability) => ({ capability, surface:"local", status:"unverified", verified_against:"fixture-only; live agent run required" })),
  };
}

export function hookAgentForKind(kind: string): HookAgentSlug | undefined {
  return (Object.entries(HOOK_AGENT_METADATA) as Array<[HookAgentSlug, { kind: string }]>).find(([, metadata]) => metadata.kind === kind)?.[0];
}

export function hookEventCapabilities(agent: HookAgentSlug): AgentEventCapabilities {
  const capability = hookCapability(agent);
  return { observe:true, block:capability.can.block_pre_inference || capability.can.block_pre_tool, rewritePrompt:capability.can.replace_prompt, rewriteToolInput:capability.can.replace_tool_input, rewriteResponse:capability.can.replace_response };
}
