import assert from "node:assert/strict";
import test from "node:test";
import {once} from "node:events";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {JdOcrTask} from "@better-me/agent-contracts";
import {createAgentServer} from "../../agent-host/src/server";
import {MemorySaver} from "../../agent-host/tests/fixtures/checkpointer";
import {registerTestIdentity} from "../../agent-host/tests/fixtures/identity";
import {ocrImage,ocrText} from "../../agent-host/tests/fixtures/jd-ocr";
import {activatePrincipal} from "../src/lib/identity";
import {createFreeChatTaskClient} from "../src/services/free-chat-task-client";
import {createJdOcrTaskClient} from "../src/services/jd-ocr-task-client";

test("production OCR uploads original 24 MiB through authenticated tasks, reconciles unknown upload and manually resumes same root",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-ocr-http-")),token="synthetic-ocr-http";let calls=0,builds=0,dropUpload=true,pauseOnce=true;
  const originals=[10,10,1,1,1,1].map((mib,index)=>ocrImage(index,mib*1024*1024)),wire:{path:string;method:string;bytes:number}[]=[];
  const server=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
    careerTaskReasoner:async()=>{builds++;return async(prompt,_signal,phase,images)=>{
      calls++;if(phase==="free_chat")return JSON.stringify({kind:"reply",content:"合成聊天根"});assert.equal(phase,"jd_ocr");assert.deepEqual(images?.map(image=>image.dataUrl),originals.map(image=>image.dataUrl));assert.ok(prompt.includes(originals[5]!.image.name));
      const text=JSON.stringify({kind:"ocr",text:ocrText});if(pauseOnce){pauseOnce=false;return {text,finishReason:"length"};}return text;
    };}});
  try{
    await once(server,"listening");const address=server.address();assert.ok(address&&typeof address!=="string");const baseUrl=`http://127.0.0.1:${address.port}`,identity=await registerTestIdentity(baseUrl,token,"synthetic-ocr-http-owner");activatePrincipal(identity.principal);
    const fetcher:typeof fetch=async(url,init)=>{
      const pathname=new URL(String(url)).pathname;assert.ok(pathname.startsWith("/api/v1/agent/tasks"));wire.push({path:pathname,method:init?.method??"GET",bytes:Buffer.byteLength(String(init?.body??""))});
      const headers=new Headers(init?.headers);for(const [key,value] of Object.entries(identity.headers))headers.set(key,value);headers.set("Authorization",`Bearer ${token}`);
      const response=await fetch(url,{...init,headers});
      if(dropUpload&&pathname.includes("/images/")&&init?.method==="POST"){dropUpload=false;assert.equal(response.status,200);await response.json();throw new Error("synthetic observer lost response after committed upload");}
      return response;
    };
    const options={baseUrl,fetch:fetcher,pollMs:5},client=createJdOcrTaskClient(options),chat=createFreeChatTaskClient(options),runtime={kind:"model" as const,modelSettings:{provider:"ollama" as const,model:"synthetic-vision",baseUrl:"http://127.0.0.1:1/v1",apiKey:"SYNTHETIC-NOT-A-REAL-KEY"}},rootScopeKey="synthetic-ocr-account-scope";
    const root=await chat.send({workspaceKey:"companion:ocr",rootScopeKey,runtime,messages:[{id:"u1",role:"user",content:"合成聊天根"}]});
    const params={workspaceKey:"ocr-workspace",rootScopeKey,runtime,consent:true as const,images:originals.map(({image,dataUrl})=>({name:image.name,size:image.byteLength,dataUrl}))};let current:JdOcrTask|undefined;
    await assert.rejects(client.generate({...params,onTask:task=>{current=task;}}),/无法连接|确认|响应|request/i);assert.equal(calls,1,"unknown upload outcome never starts a model");
    const firstId=current!.id,uploaded=await client.get(firstId);assert.equal(uploaded.uploadedImageIds.length,1);assert.equal(uploaded.usage.modelCalls,0);
    await assert.rejects(client.generate({...params,onTask:task=>{current=task;}}),/输出未完成/);assert.equal(current!.id,firstId);assert.equal(current!.status,"paused");assert.equal(calls,2);assert.equal(builds,1);
    const uploadPosts=wire.filter(row=>row.path.includes("/images/")&&row.method==="POST");assert.equal(uploadPosts.length,6,"committed first image was not resent");assert.ok(uploadPosts.every(row=>row.bytes<16*1024*1024));assert.ok(uploadPosts.some(row=>row.bytes>10*1024*1024));
    const postCount=wire.filter(row=>row.method==="POST").length;await assert.rejects(client.generate(params),/输出未完成/);await client.get(firstId);assert.equal(calls,2);assert.equal(wire.filter(row=>row.method==="POST").length,postCount);
    const resumed=await client.generate({...params,resumeTaskId:firstId});assert.equal(resumed.id,firstId);assert.equal(resumed.result?.text,ocrText);assert.equal(resumed.usage.modelCalls,2);assert.equal(resumed.rootTaskId,root.meta!.taskId);assert.equal(resumed.rootLedger?.usage.modelCalls,3);assert.equal(calls,3);
    const restored=await Promise.all(resumed.request.images.map(image=>client.getImage(resumed,image.id)));assert.deepEqual(restored.map(image=>image.dataUrl),originals.map(image=>image.dataUrl));
    const completePosts=wire.filter(row=>row.method==="POST").length;assert.deepEqual(await client.generate(params),resumed);await client.list(params.workspaceKey);assert.equal(calls,3);assert.equal(wire.filter(row=>row.method==="POST").length,completePosts);
    await assert.rejects(client.generate({...params,resumeTaskId:firstId,images:[...params.images].reverse()}),/原任务|图片顺序/);assert.equal(calls,3);
    await assert.rejects(client.generate({...params,runtime:{...runtime,modelSettings:{...runtime.modelSettings,model:"changed"}}}),/底座已变化/);assert.equal(calls,3);
    const other=await registerTestIdentity(baseUrl,token,"synthetic-ocr-other");for(const method of ["GET","POST"]){const response=await fetch(`${baseUrl}/api/v1/agent/tasks/${firstId}/images/${resumed.request.images[0]!.id}`,{method,headers:{...other.headers,Authorization:`Bearer ${token}`,"Content-Type":"application/json"},...(method==="POST"?{body:JSON.stringify({expectedRevision:resumed.revision,sourceFingerprint:resumed.sourceFingerprint,consent:true,dataUrl:originals[0]!.dataUrl})}:{})});assert.equal(response.status,404);}
    const source=await readFile(new URL("../src/lib/jd-import.ts",import.meta.url),"utf8");assert.doesNotMatch(source,/fetchChatCompletion|jsonObjectOptions/);
    activatePrincipal(undefined);await assert.rejects(client.get(firstId),/请先登录/);assert.equal(calls,3);
  }finally{activatePrincipal(undefined);server.closeIdleConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});

test("changing owner while hashing originals cannot upload the previous owner's images into the new account",async t=>{
  activatePrincipal({id:"11111111-1111-4111-8111-111111111111",username:"ocr-owner-a",displayName:"synthetic A"});
  t.after(()=>activatePrincipal(undefined));const entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>(),originalDigest=crypto.subtle.digest.bind(crypto.subtle);let hashes=0,requests=0;
  t.mock.method(crypto.subtle,"digest",async(...args:Parameters<typeof originalDigest>)=>{hashes++;if(hashes===1){entered.resolve();await gate.promise;}return originalDigest(...args);});
  const image=ocrImage(31),client=createJdOcrTaskClient({fetch:async()=>{requests++;throw Error("must not upload across owners");}});
  const pending=client.generate({workspaceKey:"synthetic-owner-fence",rootScopeKey:"synthetic-owner-fence",runtime:{kind:"model",modelSettings:{provider:"ollama",model:"synthetic-vision",baseUrl:"http://127.0.0.1:1/v1"}},consent:true,images:[{name:image.image.name,size:image.image.byteLength,dataUrl:image.dataUrl}]});
  await entered.promise;activatePrincipal({id:"22222222-2222-4222-8222-222222222222",username:"ocr-owner-b",displayName:"synthetic B"});gate.resolve();
  await assert.rejects(pending,/账号|身份|identity/i);assert.equal(requests,0);
});
