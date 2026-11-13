import assert from "node:assert/strict";
import test,{afterEach} from "node:test";
import {createHash} from "node:crypto";
import {activatePrincipal,IdentityBoundaryError} from "../src/lib/identity";
import {createTaskOutputClient,type TaskOutputSource} from "../src/services/task-output-client";
const alice={id:"11111111-1111-4111-8111-111111111111",username:"alice",displayName:"Synthetic Alice"},bob={...alice,id:"22222222-2222-4222-8222-222222222222",username:"bob"};
const outputId="out_"+"b".repeat(32),text="\ufeff  原始全文😀\r\n<script>不执行</script>\r\n"+"完整保留。".repeat(40000)+"END  ",buffer=new TextEncoder().encode(text);
function task(bytes:Uint8Array=buffer):TaskOutputSource{return {id:"ct_"+"a".repeat(32),ownerId:alice.id,outputArtifacts:[{id:outputId,bytes:bytes.byteLength,hash:createHash("sha256").update(bytes).digest("hex"),createdAt:"2026-11-12T00:00:00Z"}]};}
const raw=(bytes:Uint8Array=buffer)=>new Response(bytes,{headers:{"Content-Type":"text/plain; charset=utf-8"}});
afterEach(()=>activatePrincipal(undefined));

test("authenticated task output is byte/hash checked, preserves BOM CRLF Unicode and tail, GET only without retry",async()=>{
  activatePrincipal(alice);let reads=0;
  const source=task(),client=createTaskOutputClient({baseUrl:"http://fixture.invalid",fetch:async(url,init)=>{
    reads++;assert.equal(String(url),`http://fixture.invalid/api/v1/agent/tasks/${source.id}/outputs/${outputId}`);assert.equal(init?.method,"GET");assert.equal(init?.body,undefined);
    assert.equal(new Headers(init?.headers).get("x-betterme-owner"),alice.id);assert.equal(init?.credentials,"include");assert.equal(init?.cache,"no-store");return raw();
  }});
  const result=await client.read(source,outputId);assert.equal(result.text,text);assert.deepEqual(result.artifact,source.outputArtifacts![0]);assert.equal(reads,1);
});

test("foreign owner, unknown output, bad IDs and no active identity stop before I/O",async()=>{
  let reads=0;const client=createTaskOutputClient({fetch:async()=>{reads++;return raw();}}),source=task();
  await assert.rejects(client.read(source,outputId),IdentityBoundaryError);activatePrincipal(bob);await assert.rejects(client.read(source,outputId),IdentityBoundaryError);activatePrincipal(alice);
  await assert.rejects(client.read(source,"out_"+"c".repeat(32)),{code:"task_output_not_found"});
  await assert.rejects(client.read({...source,id:"../escape"},outputId),{code:"task_output_not_found"});
  await assert.rejects(client.read({...source,outputArtifacts:[{...source.outputArtifacts![0]!,hash:"invalid"}]},outputId),{code:"task_output_not_found"});assert.equal(reads,0);
});

test("short or same-size changed responses are never returned as partial success",async()=>{
  activatePrincipal(alice);
  const short=createTaskOutputClient({fetch:async()=>raw(buffer.subarray(0,-1))});await assert.rejects(short.read(task(),outputId),{code:"task_output_size_mismatch"});
  const changed=buffer.slice();changed[changed.length-2]^=1;
  await assert.rejects(createTaskOutputClient({fetch:async()=>raw(changed)}).read(task(),outputId),{code:"task_output_hash_mismatch"});
});

test("wrong media type or invalid UTF-8 cannot become displayed replacement text",async()=>{
  activatePrincipal(alice);await assert.rejects(createTaskOutputClient({fetch:async()=>Response.json({secret:"not output"})}).read(task(),outputId),{code:"invalid_task_output_type"});
  const invalid=new Uint8Array([0xc3,0x28]);await assert.rejects(createTaskOutputClient({fetch:async()=>raw(invalid)}).read(task(invalid),outputId),{code:"invalid_task_output_encoding"});
});

test("denied, interrupted or failed reads make one attempt and expose no provider/path payload",async()=>{
  activatePrincipal(alice);let calls=0;
  await assert.rejects(createTaskOutputClient({fetch:async()=>{calls++;return Response.json({error:"task_output_changed",detail:"PRIVATE PATH"},{status:409});}}).read(task(),outputId),error=>{assert.equal((error as {code:string}).code,"task_output_changed");assert.ok(!String(error).includes("PRIVATE PATH"));return true;});
  assert.equal(calls,1);
  const broken=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(buffer.subarray(0,3));controller.error(Error("SECRET STREAM"));}});
  await assert.rejects(createTaskOutputClient({fetch:async()=>new Response(broken,{headers:{"Content-Type":"text/plain"}})}).read(task(),outputId),{code:"task_output_incomplete"});
  await assert.rejects(createTaskOutputClient({fetch:async()=>{throw Error("SECRET NETWORK");}}).read(task(),outputId),{code:"task_output_read_failed"});
});

test("switch during headers or delayed body rejects the old owner's complete bytes",async()=>{
  activatePrincipal(alice);
  await assert.rejects(createTaskOutputClient({fetch:async()=>{activatePrincipal(bob);return raw();}}).read(task(),outputId),IdentityBoundaryError);
  activatePrincipal(alice);let finish!:(value:Uint8Array)=>void;
  const body=new ReadableStream<Uint8Array>({start(controller){finish=value=>{controller.enqueue(value);controller.close();};}});
  const pending=createTaskOutputClient({fetch:async()=>new Response(body,{headers:{"Content-Type":"text/plain"}})}).read(task(),outputId);
  await new Promise(resolve=>setImmediate(resolve));activatePrincipal(bob);finish(buffer);await assert.rejects(pending,IdentityBoundaryError);
});

test("explicit cancellation rejects even a transport that ignores abort",async()=>{
  activatePrincipal(alice);const controller=new AbortController(),done=Promise.withResolvers<Response>();let calls=0;
  const pending=createTaskOutputClient({fetch:async()=>{calls++;return done.promise;}}).read(task(),outputId,controller.signal);
  controller.abort();done.resolve(raw());await assert.rejects(pending,{name:"AbortError"});assert.equal(calls,1);
});
