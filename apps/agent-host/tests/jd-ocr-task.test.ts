import assert from "node:assert/strict";
import test,{type TestContext} from "node:test";
import os from "node:os";
import path from "node:path";
import {mkdtemp,rm,readFile,stat,chmod,symlink,rename} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {JdOcrTaskSchema,JdOcrRequestSchema,parseJdOcrResult,type JdOcrTask} from "@better-me/agent-contracts";
import {AgentTaskKernel,type CareerTaskRuntime} from "../src/kernel/service.js";
import {readPrivateJson,writePrivateJson} from "../src/identity/private-json.js";
import {ocrImage,ocrBinding,ocrInput,ocrCommand,ocrUpload,ocrText} from "./fixtures/jd-ocr.js";

const access={session:"synthetic-ocr-lease",valid:async()=>true};
async function settled(kernel:AgentTaskKernel,id:string){for(let i=0;i<300;i++){const task=JdOcrTaskSchema.parse(await kernel.readTask(id));if(task.status!=="running")return task;await delay(5);}throw Error("OCR did not settle");}
async function fixture(t:TestContext){const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-ocr-kernel-")),kernel=new AgentTaskKernel({ownerId:"synthetic-ocr-owner",directory});t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});return {directory,kernel};}
async function upload(kernel:AgentTaskKernel,task:JdOcrTask,images:ReturnType<typeof ocrImage>[]){for(const image of images)task=JdOcrTaskSchema.parse(await kernel.uploadOcrImage(task.id,image.image.id,ocrUpload(task,image.dataUrl),access));return task;}
const runtime=(reasoner:CareerTaskRuntime["reasoner"]):CareerTaskRuntime=>({runtimeFingerprint:"synthetic-same-runtime",supportsImages:true,reasoner});

test("OCR retains six images and the entire 24 MiB of original bytes outside task JSON, same root and one charge",async t=>{
  const {kernel,directory}=await fixture(t),images=[10,10,1,1,1,1].map((mib,index)=>ocrImage(index,mib*1024*1024));let calls=0;
  const root=await kernel.createTask({kind:"free_chat",workspaceKey:"synthetic-root-chat",rootScopeKey:"synthetic-ocr-scope",objective:"合成根",conversation:{messages:[{id:"u1",role:"user",content:"先建立合成聊天根"}]},runtimeBinding:ocrBinding,budget:{maxModelCalls:2,maxToolCalls:1,maxActiveMs:60000},consent:true,idempotencyKey:"synthetic-ocr-root"},access);
  await kernel.run(root.id,"start",{expectedRevision:root.revision,sourceFingerprint:root.sourceFingerprint,runtimeBinding:root.runtimeBinding,consent:true},runtime(async()=>{calls++;return JSON.stringify({kind:"reply",content:"合成根已建立"});}),access);
  for(let i=0;i<300&&(await kernel.readTask(root.id)).status==="running";i++)await delay(5);
  let task=await kernel.createTask(ocrInput(images.map(item=>item.image)),access);assert.equal(task.rootTaskId,root.id);assert.equal(task.parentTaskId,root.id);
  await assert.rejects(kernel.run(task.id,"start",ocrCommand(task),runtime(async()=>"never"),access),/task_images_not_ready/);
  task=await upload(kernel,task,images);assert.equal(task.usage.modelCalls,0);
  const duplicate=await kernel.uploadOcrImage(task.id,images[0]!.image.id,ocrUpload(task,images[0]!.dataUrl),access);assert.equal(duplicate.revision,task.revision);
  assert.ok((await stat(path.join(directory,`${task.id}.json`))).size<16000);
  await kernel.run(task.id,"start",ocrCommand(task),runtime(async(prompt,_signal,phase,received)=>{
    calls++;assert.equal(phase,"jd_ocr");assert.deepEqual(received?.map(image=>image.dataUrl),images.map(image=>image.dataUrl));assert.ok(prompt.includes(JSON.stringify(task.request)));
    return JSON.stringify({kind:"ocr",text:ocrText});
  }),access);
  task=await settled(kernel,task.id);assert.equal(task.status,"completed",task.error);assert.equal(task.result?.text,ocrText);assert.equal(task.usage.modelCalls,1);assert.equal(task.rootLedger?.usage.modelCalls,2);assert.equal(calls,2);
  for(const image of images){assert.equal((await kernel.readOcrImage(task.id,image.image.id,access)).dataUrl,image.dataUrl);const file=path.join(directory,"image-inputs",task.id,`${image.image.id}.json`);if(process.platform!=="win32")assert.equal((await stat(file)).mode&0o777,0o600);}
  assert.equal((await kernel.createTask(ocrInput(images.map(item=>item.image)),access)).id,task.id);await kernel.readTask(task.id);assert.equal(calls,2);
  await assert.rejects(kernel.createTask(ocrInput([images[0]!.image],"synthetic-over-root-budget"),access),/model_call_budget/);
  await assert.rejects(kernel.fact(task.id,task.revision,"不得自动采用",["imaginary"],access),/task_kind_not_supported/);
});

test("OCR manifests reject over-capacity, duplicates and altered bytes before charging, and do not accept arbitrary uploads",async t=>{
  const {kernel}=await fixture(t),image=ocrImage(0),other=ocrImage(1);let task=await kernel.createTask(ocrInput([image.image]),access);
  assert.throws(()=>JdOcrRequestSchema.parse({images:[image.image,image.image]}),/duplicate/);
  assert.throws(()=>JdOcrRequestSchema.parse({images:Array.from({length:7},(_,index)=>({...image.image,id:`img_${String(index).padStart(32,"0")}`}))}));
  assert.throws(()=>JdOcrRequestSchema.parse({images:[0,1,2].map(index=>({...image.image,id:`img_${String(index).padStart(32,"0")}`,byteLength:10*1024*1024}))}),/24 MiB/);
  assert.throws(()=>JdOcrRequestSchema.parse({images:[{...image.image,byteLength:10*1024*1024+1}]}));
  await assert.rejects(kernel.uploadOcrImage(task.id,other.image.id,ocrUpload(task,other.dataUrl),access),/task_image_not_found/);
  await assert.rejects(kernel.uploadOcrImage(task.id,image.image.id,ocrUpload(task,other.dataUrl),access),/task_image_manifest_mismatch/);
  await assert.rejects(kernel.uploadOcrImage(task.id,image.image.id,{...ocrUpload(task,image.dataUrl),sourceFingerprint:"changed"},access),/source_changed/);
  await assert.rejects(kernel.uploadOcrImage(task.id,image.image.id,ocrUpload(task,image.dataUrl),{session:"wrong",valid:async()=>false}),/interaction_lease_invalid/);
  task=await upload(kernel,task,[image]);assert.equal(task.usage.modelCalls,0);
  await assert.rejects(kernel.run(task.id,"start",ocrCommand(task),{runtimeFingerprint:"unsupported",supportsImages:false,reasoner:async()=>{throw Error("must never execute");}},access),/task_images_not_supported/);
  assert.equal((await kernel.readTask(task.id)).usage.modelCalls,0);
});

test("OCR private inputs are reverified on every send, reject unsafe paths and never silently replace corrupt content",async t=>{
  const {kernel,directory}=await fixture(t),image=ocrImage(2);let task=await kernel.createTask(ocrInput([image.image]),access);task=await upload(kernel,task,[image]);
  const file=path.join(directory,"image-inputs",task.id,`${image.image.id}.json`),stored=await readPrivateJson(file) as {dataUrl:string};
  await writePrivateJson(file,{...stored,dataUrl:ocrImage(3).dataUrl});let calls=0;
  await kernel.run(task.id,"start",ocrCommand(task),runtime(async()=>{calls++;return "never";}),access);task=await settled(kernel,task.id);assert.equal(task.error,"task_image_manifest_mismatch");assert.equal(calls,0);assert.equal(task.usage.modelCalls,0);
  await assert.rejects(kernel.readOcrImage(task.id,image.image.id,access),/task_image_manifest_mismatch/);
  await writePrivateJson(file,stored);if(process.platform!=="win32"){
    await chmod(file,0o644);await assert.rejects(kernel.readOcrImage(task.id,image.image.id,access),/unsafe_private_file/);await chmod(file,0o600);
    const saved=file+".saved";await rename(file,saved);await symlink(saved,file);await assert.rejects(kernel.readOcrImage(task.id,image.image.id,access),/unsafe_private_file/);
  }
  assert.ok((await readFile(path.join(directory,`${task.id}.json`),"utf8")).includes(image.image.hash));
});

test("OCR incomplete output is full, manual resume reuses original images and ledger, repairs are charged",async t=>{
  const {kernel,directory}=await fixture(t),image=ocrImage(4);let task=await upload(kernel,await kernel.createTask(ocrInput([image.image]),access),[image]),calls=0;
  const partial="  完整部分输出\r\n".repeat(200)+"TAIL",invalid=JSON.stringify({kind:"ocr",text:"不足"});
  const selected=runtime(async(prompt,_signal,phase,images)=>{calls++;assert.equal(phase,"jd_ocr");assert.equal(images?.[0]?.dataUrl,image.dataUrl);if(calls===1)return {text:partial,finishReason:"length"};if(calls===2)return invalid;assert.ok(prompt.includes(invalid.replaceAll('"','\\"')));return JSON.stringify({kind:"ocr",text:ocrText});});
  await kernel.run(task.id,"start",ocrCommand(task),selected,access);task=await settled(kernel,task.id);assert.equal(task.status,"paused");assert.equal(task.partialOutput?.text,partial);assert.equal(task.result,undefined);
  await kernel.readTask(task.id);await kernel.readOcrImage(task.id,image.image.id,access);assert.equal(calls,1);
  await assert.rejects(kernel.run(task.id,"resume",ocrCommand(task),{...selected,runtimeFingerprint:"changed"},access),/runtime_authorization_changed/);
  await kernel.run(task.id,"resume",ocrCommand(task),selected,access);task=await settled(kernel,task.id);assert.equal(task.status,"completed",task.error);assert.equal(task.usage.modelCalls,3);assert.equal(task.result?.text,ocrText);
  const store=await readPrivateJson(path.join(directory,`${task.id}.json`)) as {recent:{output?:string}[]};assert.ok(store.recent.some(item=>item.output===partial));assert.ok(store.recent.some(item=>item.output===invalid));
  assert.equal(parseJdOcrResult(JSON.stringify({kind:"ocr",text:ocrText})).text,ocrText);
});

test("OCR oversized output is a complete private artifact; stop fences late OCR results",async t=>{
  const {kernel}=await fixture(t),image=ocrImage(5);let task=await upload(kernel,await kernel.createTask(ocrInput([image.image]),access),[image]);
  const output="完整🚧\r\n".repeat(200000)+"TAIL";assert.ok(output.length>1_000_000);
  await kernel.run(task.id,"start",ocrCommand(task),runtime(async()=>output),access);task=await settled(kernel,task.id);assert.equal(task.error,"decision_output_budget");assert.equal((await kernel.readOutput(task.id,task.outputArtifacts![0]!.id)).text,output);
  const entered=Promise.withResolvers<void>(),late=Promise.withResolvers<string>();let stopped=await upload(kernel,await kernel.createTask(ocrInput([image.image],"synthetic-ocr-stop"),access),[image]);
  await kernel.run(stopped.id,"start",ocrCommand(stopped),runtime(async()=>{entered.resolve();return late.promise;}),access);await entered.promise;
  stopped=JdOcrTaskSchema.parse(await kernel.readTask(stopped.id));await assert.rejects(kernel.uploadOcrImage(stopped.id,image.image.id,ocrUpload(stopped,image.dataUrl),access),/task_image_upload_not_allowed/);
  await kernel.stop(stopped.id,stopped.revision,false,access);late.resolve(JSON.stringify({kind:"ocr",text:ocrText}));await delay(10);
  stopped=JdOcrTaskSchema.parse(await kernel.readTask(stopped.id));assert.equal(stopped.status,"paused");assert.equal(stopped.result,undefined);assert.equal(stopped.usage.modelCalls,1);
});

test("Host restart keeps original private image inputs and paused usage without replaying or reuploading",async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-ocr-restart-")),ownerId="synthetic-restart-owner",image=ocrImage(30);let kernel=new AgentTaskKernel({ownerId,directory}),calls=0;
  try{
    let task=await upload(kernel,await kernel.createTask(ocrInput([image.image]),access),[image]);
    const selected=runtime(async()=>{calls++;return {text:JSON.stringify({kind:"ocr",text:ocrText}),finishReason:"length"};});
    await kernel.run(task.id,"start",ocrCommand(task),selected,access);task=await settled(kernel,task.id);assert.equal(task.status,"paused");const previous=structuredClone(task);
    await kernel.close();kernel=new AgentTaskKernel({ownerId,directory});const restored=JdOcrTaskSchema.parse(await kernel.readTask(task.id));assert.deepEqual(restored,previous);assert.equal(calls,1);assert.equal((await kernel.readOcrImage(task.id,image.image.id,access)).dataUrl,image.dataUrl);
    await kernel.run(task.id,"resume",ocrCommand(restored),runtime(async(_prompt,_signal,_phase,images)=>{calls++;assert.equal(images?.[0]?.dataUrl,image.dataUrl);return JSON.stringify({kind:"ocr",text:ocrText});}),access);
    task=await settled(kernel,task.id);assert.equal(task.status,"completed");assert.equal(task.id,previous.id);assert.equal(task.usage.modelCalls,2);assert.equal(calls,2);
  }finally{await kernel.close();await rm(directory,{recursive:true,force:true});}
});
