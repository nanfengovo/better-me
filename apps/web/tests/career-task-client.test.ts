import assert from "node:assert/strict";
import test,{afterEach} from "node:test";
import type { CareerTask, FreeChatTask } from "@better-me/agent-contracts";
import { activatePrincipal, IdentityBoundaryError } from "../src/lib/identity";
import { CareerTaskError, createCareerTaskClient } from "../src/services/career-task-client";
const a="11111111-1111-4111-8111-111111111111",b="22222222-2222-4222-8222-222222222222";
const sign=(id:string)=>activatePrincipal({id,username:"synthetic",displayName:"Synthetic"});
const task:CareerTask={id:"ct_fixture",ownerId:a,workspaceKey:"ws",objective:"Synthetic",revision:1,status:"ready",createdAt:"now",updatedAt:"now",
  job:{title:"Synthetic job",company:"fixture",description:"Synthetic JD"},resume:{id:"src",name:"resume",sourceFingerprint:"fp",fields:[{id:"f",originalText:"sample",targetRef:{kind:"profile_headline",locale:"en"}}]},
  materials:[],directories:[],runtimeBinding:{id:"model:ollama:demo",label:"demo",location:"local"},budget:{maxModelCalls:12,maxToolCalls:30,maxActiveMs:600000},
  usage:{modelCalls:0,toolCalls:0,activeMs:0},events:[],evidence:[],facts:[]};
afterEach(()=>activatePrincipal(undefined));
test("client requires an owner, includes the owned transport guard, and checks owner and task ID on receipt",async()=>{
  let calls=0,reply=task;
  const client=createCareerTaskClient(async (url,init)=>{calls++;assert.match(String(url),/\/api\/v1\/agent\/tasks\/ct_fixture$/);
    assert.equal(init?.credentials,"include");assert.equal(new Headers(init?.headers).get("x-betterme-owner"),a);return Response.json({task:reply});});
  activatePrincipal(undefined);await assert.rejects(client.get(task.id),e=>e instanceof CareerTaskError&&e.status===401);assert.equal(calls,0);
  sign(a);assert.equal((await client.get(task.id)).ownerId,a);reply={...task,ownerId:b};await assert.rejects(client.get(task.id),IdentityBoundaryError);
  reply={...task,id:"wrong"};await assert.rejects(client.get(task.id),e=>e instanceof CareerTaskError&&e.code==="wrong_task");
});
test("unsuccessful or malformed replies never turn into a saved result or a second model dispatch",async()=>{
  sign(a);let calls=0;
  const client=createCareerTaskClient(async()=>{calls++;return calls===1?Response.json({task:{id:task.id,ownerId:a,status:"completed"}}):Response.json({error:"runtime_binding_changed"},{status:409});});
  await assert.rejects(client.get(task.id),e=>e instanceof CareerTaskError&&e.code==="invalid_response");
  await assert.rejects(client.run(task.id,"resume",{expectedRevision:2,sourceFingerprint:"fp",runtimeBinding:task.runtimeBinding,consent:true,runtime:{kind:"native",runtimeId:"fixture"}}),
    e=>e instanceof CareerTaskError&&e.status===409&&e.code==="runtime_binding_changed");
  assert.equal(calls,2);
});
test("changing the account invalidates an in-flight task response, even when the previous request returns 200",async()=>{
  sign(a);let resolve!:(r:Response)=>void;const client=createCareerTaskClient(async()=>new Promise<Response>(r=>{resolve=r;}));
  const pending=client.list();sign(b);resolve(Response.json({tasks:[task]}));await assert.rejects(pending,IdentityBoundaryError);
});
test("a completed label without a verifiable task receipt is not accepted as completion",async()=>{
  sign(a);const client=createCareerTaskClient(async()=>Response.json({task:{...task,status:"completed"}}));
  await assert.rejects(client.get(task.id),e=>e instanceof CareerTaskError&&e.code==="invalid_response");
});
test("the career view filters shared task kinds only after checking every returned owner and business receipt",async()=>{
  sign(a);const chat:FreeChatTask={id:"ct_chat_fixture",ownerId:a,workspaceKey:"chat",objective:"Synthetic conversation",kind:"free_chat",revision:1,status:"ready",createdAt:"now",updatedAt:"now",
    sourceFingerprint:"chat-fp",conversation:{messages:[{id:"m1",role:"user",content:"hello"}]},turn:1,runtimeBinding:task.runtimeBinding,budget:task.budget,usage:task.usage,events:[]};
  let tasks:(CareerTask|FreeChatTask)[]=[task,chat];const client=createCareerTaskClient(async()=>Response.json({tasks}));
  assert.deepEqual((await client.list()).map(item=>item.id),[task.id]);
  tasks=[task,{...chat,ownerId:b}];await assert.rejects(client.list(),IdentityBoundaryError);
  tasks=[{...task,status:"completed"},chat];await assert.rejects(client.list(),error=>error instanceof CareerTaskError&&error.code==="invalid_response");
});
