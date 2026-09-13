import assert from "node:assert/strict";
import test from "node:test";
import { canonicalEventToOtlp, normalizeOtlpGenAi } from "./otel-genai.js";

test("OTLP GenAI logs normalize at the boundary into canonical events",()=>{
  const requests=normalizeOtlpGenAi({resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:"1700000000000000000",attributes:[{key:"gen_ai.system",value:{stringValue:"anthropic"}},{key:"gen_ai.prompt",value:{stringValue:"hello"}},{key:"gen_ai.conversation.id",value:{stringValue:"s1"}}]}]}]}]});
  assert.equal(requests.length,1); assert.equal(requests[0].event.prompt,"hello"); assert.equal(requests[0].event.sessionId,"s1");
});

test("canonical events export as OTLP without replacing the canonical model",()=>{
  const payload=canonicalEventToOtlp({computer:{hostname:"h",platform:"mac"},agent:{kind:"claude-code",displayName:"Claude"},event:{eventName:"UserPromptSubmit",occurredAt:new Date().toISOString(),agentKind:"claude-code",sessionId:"s",prompt:"hello"}},"allow");
  assert.equal(payload.resourceLogs[0].scopeLogs[0].scope.name,"openleash.engine");
  assert.ok(payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.some((item)=>item.key==="openleash.decision"));
});
