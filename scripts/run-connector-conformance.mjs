import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import crypto from "node:crypto";

const live=process.argv.includes("--live");
const commands=[
  ["npm",["run","build","-w","@openleash/shared"]],
  ["npm",["test","-w","@openleash/client-api"]],
  ["cargo",["test","--manifest-path","apps/local-proxy/Cargo.toml"]],
];
for(const [command,args] of commands){const result=spawnSync(command,args,{stdio:"inherit"});if(result.status!==0)process.exit(result.status??1);}

const generatedAt=new Date().toISOString();
const verification=[];
if(live&&process.env.CURSOR_ADMIN_API_KEY){
  const response=await fetch("https://api.cursor.com/teams/members",{headers:{Authorization:`Basic ${Buffer.from(`${process.env.CURSOR_ADMIN_API_KEY}:`).toString("base64")}`}}).catch(()=>undefined);
  verification.push({connector_id:"cost.cursor.hosted",capability:"sees_cloud_activity",surface:"hosted-admin",status:response?.ok?"verified":"failed",verified_at:response?.ok?generatedAt:undefined,verified_against:"api.cursor.com/teams/members"});
  verification.push({connector_id:"cost.cursor.hosted",capability:"cost_data",surface:"hosted-admin",status:"unverified",verified_against:"live membership validation does not itself prove cost import"});
}
const report={report_id:`conformance-${generatedAt}-${crypto.randomBytes(6).toString("hex")}`,generated_at:generatedAt,live,verification};
writeFileSync("connector-conformance-report.json",JSON.stringify(report,null,2));
if(process.env.CONFORMANCE_PUBLISH_URL&&process.env.CONFORMANCE_PUBLISH_TOKEN){
  const response=await fetch(process.env.CONFORMANCE_PUBLISH_URL,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${process.env.CONFORMANCE_PUBLISH_TOKEN}`},body:JSON.stringify(report)});
  if(!response.ok)throw new Error(`conformance publish failed: ${response.status}`);
}
