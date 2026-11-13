import test from "node:test";
import assert from "node:assert/strict";
import {createAgentRoutingClient,AgentRoutingClientError} from "../src/services/agent-routing-client";
import {generateWritingReply} from "../src/lib/resume-copilot";

test("legacy routing execution refuses before fetch but policy reads and updates remain available",async()=>{
  const calls:{url:string;method:string}[]=[],policy={revision:0,mode:"manual" as const,preferred:"codex",backups:[],allowApiBackups:false};
  const client=createAgentRoutingClient({baseUrl:"https://synthetic.invalid",fetch:async(url,init)=>{calls.push({url:String(url),method:init?.method??"GET"});return Response.json({policy});}});
  await assert.rejects(client.respond({id:"synthetic",expectedRevision:0,instructions:"完整原文",messages:[{role:"user",content:"  不得发送😀  "}]},new AbortController().signal),error=>error instanceof AgentRoutingClientError&&error.code==="routing_response_moved_to_tasks");
  assert.equal(calls.length,0);assert.deepEqual((await client.status()).policy,policy);await client.update(policy);
  assert.deepEqual(calls.map(row=>row.method),["GET","PUT"]);assert.ok(calls.every(row=>!row.url.endsWith("/respond")));
});

test("browser writing has no default model transport; only explicit synthetic protocol adapters can run",async()=>{
  const source={targetRef:{kind:"profile_headline" as const,locale:"zh" as const},label:"合成字段",text:"负责接口测试。"};
  await assert.rejects(generateWritingReply({provider:"ollama",baseUrl:"http://127.0.0.1:1/v1",model:"never-call",apiKey:""},source,"完整本人补充",new AbortController().signal),/旧浏览器写作执行器已退役/);
});
