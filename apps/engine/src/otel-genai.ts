import type { EvaluationRequest, OpenLeashEvent } from "@openleash/shared";

export const OTEL_CONNECTOR_FLAG = "OPENLEASH_OTEL_CONNECTOR_ENABLED";

type OtlpAttribute = { key?:string; value?:{stringValue?:string;intValue?:string|number;boolValue?:boolean} };

export function normalizeOtlpGenAi(payload: unknown): EvaluationRequest[] {
  const records = collectRecords(payload);
  return records.map((record, index) => {
    const attributes = attributeMap(record.attributes);
    const prompt = text(attributes["gen_ai.prompt"] ?? attributes["gen_ai.input.messages"] ?? record.body?.stringValue);
    const response = text(attributes["gen_ai.completion"] ?? attributes["gen_ai.output.messages"]);
    const event: OpenLeashEvent = {
      eventName:"Stop", occurredAt:nanosToIso(record.timeUnixNano) ?? new Date().toISOString(),
      agentKind:text(attributes["gen_ai.system"] ?? attributes["gen_ai.provider.name"] ?? "external") as EvaluationRequest["agent"]["kind"],
      sessionId:text(attributes["gen_ai.conversation.id"] ?? attributes["session.id"] ?? `otel-${index}`),
      prompt:prompt || undefined, raw:response ? { otelCompletion:response } : undefined,
      transportEvidence:{ operation:text(attributes["gen_ai.operation.name"] ?? "chat") },
    };
    return { computer:{hostname:"otel",platform:"cloud"}, agent:{kind:event.agentKind,displayName:text(attributes["gen_ai.agent.name"] ?? event.agentKind)}, event };
  }).filter((request) => Boolean(request.event.prompt || (request.event.raw as {otelCompletion?:string}|undefined)?.otelCompletion));
}

export function canonicalEventToOtlp(request: EvaluationRequest, decision?: string) {
  const attributes = [
    attr("gen_ai.system", request.agent.kind), attr("gen_ai.agent.name", request.agent.displayName),
    attr("gen_ai.operation.name", request.event.eventName), attr("gen_ai.conversation.id", request.event.sessionId),
    ...(request.event.prompt ? [attr("gen_ai.prompt", request.event.prompt)] : []),
    ...((request.event.raw as {otelCompletion?:string}|undefined)?.otelCompletion ? [attr("gen_ai.completion", (request.event.raw as {otelCompletion:string}).otelCompletion)] : []),
    ...(decision ? [attr("openleash.decision", decision)] : []),
  ];
  return { resourceLogs:[{scopeLogs:[{scope:{name:"openleash.engine"},logRecords:[{timeUnixNano:String(BigInt(Date.now())*1_000_000n),severityText:"INFO",body:{stringValue:"OpenLeash canonical agent event"},attributes}]}]}] };
}

export async function exportCanonicalEventToOtel(request: EvaluationRequest, decision?:string, fetcher:typeof fetch=fetch) {
  const endpoint=String(process.env.OPENLEASH_OTEL_EXPORT_URL??"").trim();
  if (!endpoint || process.env[OTEL_CONNECTOR_FLAG] !== "1") return { exported:false };
  const response=await fetcher(endpoint,{method:"POST",headers:{"content-type":"application/json",...(process.env.OPENLEASH_OTEL_EXPORT_TOKEN?{authorization:`Bearer ${process.env.OPENLEASH_OTEL_EXPORT_TOKEN}`}:{})},body:JSON.stringify(canonicalEventToOtlp(request,decision)),signal:AbortSignal.timeout(800)});
  if(!response.ok) throw new Error(`OTel export returned ${response.status}`);
  return { exported:true };
}

function collectRecords(payload:unknown):Array<{attributes?:OtlpAttribute[];body?:{stringValue?:string};timeUnixNano?:string|number}>{
  const root=payload as any; const result:any[]=[];
  for(const resource of root?.resourceLogs??[])for(const scope of resource?.scopeLogs??[])result.push(...(scope?.logRecords??[]));
  for(const resource of root?.resourceSpans??[])for(const scope of resource?.scopeSpans??[])result.push(...(scope?.spans??[]));
  return result;
}
function attributeMap(values?:OtlpAttribute[]){return Object.fromEntries((values??[]).map((item)=>[item.key??"",item.value?.stringValue??item.value?.intValue??item.value?.boolValue]));}
function text(value:unknown){return typeof value==="string"?value:String(value??"");}
function nanosToIso(value?:string|number){try{return new Date(Number(BigInt(value??0)/1_000_000n)).toISOString();}catch{return undefined;}}
function attr(key:string,value:string){return {key,value:{stringValue:value}};}
