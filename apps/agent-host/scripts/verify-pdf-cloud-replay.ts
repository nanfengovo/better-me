/** Replays the frozen local 2B answers at the cloud HTTP boundary. This cannot send a real request
 * and deliberately cannot demonstrate improved English. Inputs are pinned, original fixtures. */
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {PDF_CLOUD_BACKEND,PDF_CLOUD_ORIGIN,pdfCloudModel} from "@better-me/agent-contracts";
import {AgentTaskKernel} from "../src/kernel/service.js";
import {LearningPaths} from "../src/growth/learning-service.js";
import {createPdf2zhEngine} from "../src/growth/pdf2zh-engine.js";

const root=fileURLToPath(new URL("../../../",import.meta.url)), sha=(x:Uint8Array|string)=>createHash("sha256").update(x).digest("hex");
const fixture=await fs.readFile(path.join(root,"apps/agent-host/tests/fixtures/learning/checkpoint-notes-v1.pdf"));
assert.equal(sha(fixture),"1bb01c208dcf6f5ca0f1111d1b66da4a100d3d60150cf4f648465abed5d348f2");
const trace=await fs.readFile(path.join(root,"output/translation-real/model-trace-1794624169566.ndjson"));
assert.equal(sha(trace),"5b3717baa419ffa471dc9306ab466f657ea0f170c4edd9aafb4c8e7c8ea105d6");
const records=trace.toString().trim().split("\n").slice(-9).map(line=>{
  const {prompt,result}=JSON.parse(line);return {hash:sha(prompt),result:String(result)};});
const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"betterme-pdf-replay-"))),key="SYNTHETIC_ONLY_NEVER_A_PROVIDER_KEY";
const model=pdfCloudModel("deepseek-v4-pro"),engine=createPdf2zhEngine({python:path.resolve(root,"../.betterme-pdf2zh-runtime/venv/bin/python"),assets:path.resolve(root,"../.betterme-pdf2zh-runtime/assets")})!;
const nativeFetch=globalThis.fetch;let sends=0;const hashes:string[]=[];
globalThis.fetch=async(url,init)=>{
  assert.equal(String(url),PDF_CLOUD_ORIGIN+"/chat/completions");assert.equal(init?.redirect,"error");
  assert.equal(new Headers(init?.headers).get("Authorization"),"Bearer "+key);
  const body=JSON.parse(String(init?.body));assert.equal(body.model,model.name);const h=sha(body.messages[0].content);
  const result=records[sends]?.hash===h?records[sends]?.result:undefined;
  sends++;hashes.push(h);if(!result)throw Error("unmatched_original_fixture_request");
  return Response.json({model:model.name,choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:result}}]});
}; // no fall-through, including localhost: Ollama must not be needed on the cloud route
const kernel=new AgentTaskKernel({ownerId:"synthetic-pdf-replay",directory:path.join(dir,"tasks")});
const service=new LearningPaths({ownerId:"synthetic-pdf-replay",directory:path.join(dir,"learning"),kernel,translationEngine:{
  abortSettles:true,backend:async channel=>({...await engine.backend(channel),simulation:true}),run:input=>engine.run(input)}});
const access={session:"pdf-replay-session",valid:async()=>true};
try{
  const m=await service.importMaterial({requestId:"original",consent:true,name:"原创三页讲义.pdf",mediaType:"application/pdf",base64:fixture.toString("base64")},access);
  const req={requestId:"cloud-wire-frozen-local-replay",consent:true,materialId:m.id,materialHash:m.hash,materialRevision:m.revision,
    backendId:PDF_CLOUD_BACKEND,model,sourceLanguage:"zh",targetLanguage:"en",bilingual:true,
    glossary:[["回执","receipt"],["断点","checkpoint"],["结果未知","unknown outcome"],["预算上限","budget cap"],["已保存步骤","saved steps"],["后续验证步骤","subsequent verification steps"]].map(([source,target])=>({source,target})),
    cloudGrant:{recipientOrigin:PDF_CLOUD_ORIGIN,model:model.name,materialHash:m.hash,scope:"document_text_and_glossary",maxCalls:12}};
  let job=await service.translations.create(req,access,key);const id=job.id;
  for(let i=0;i<900&&["running","queued"].includes(job.state);i++){await delay(400);job=await service.translations.get(id,access);}
  console.log(JSON.stringify({directory:dir,state:job.state,issue:job.issue,calls:sends,hashes,realCloudCalls:0}));
  assert.equal(job.state,"review_required");assert.equal(sends,9);assert.equal(job.usage.modelCalls,9);
  for(const artifact of job.artifacts){
    const {bytes}=await service.translations.bytes(id,artifact.kind,access);
    assert.equal(sha(bytes),artifact.hash);await fs.writeFile(path.join(dir,"NOT-CLOUD-QUALITY-replay-"+artifact.kind+".pdf"),bytes,{flag:"wx",mode:0o600});
    assert.equal(artifact.pages,artifact.kind==="mono"?3:6);
  }
  await fs.writeFile(path.join(dir,"simulation-receipt.json"),JSON.stringify(job,null,2),{flag:"wx",mode:0o600});
  console.log(JSON.stringify({output:dir,simulation:true,qualityAccepted:false,artifacts:job.artifacts}));
}finally{await service.close();await kernel.close();globalThis.fetch=nativeFetch;}
