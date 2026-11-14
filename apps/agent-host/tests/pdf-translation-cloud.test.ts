import assert from "node:assert/strict";
import test from "node:test";
import { pdfCloudModel, PDF_CLOUD_ORIGIN } from "@better-me/agent-contracts";
import { sendPdfCloudText } from "../src/growth/pdf2zh-cloud.js";

test("the PDF transport sends text on the approved route once, without files, tools, redirects or credential echoes",async()=>{
  const sent:unknown[]=[];const key="synthetic-pdf-secret", model=pdfCloudModel("deepseek-v4-pro");
  const wire:typeof fetch=async(url,init)=>{
    assert.equal(String(url),PDF_CLOUD_ORIGIN+"/chat/completions");
    assert.equal(init?.redirect,"error");assert.equal(new Headers(init?.headers).get("Authorization"),"Bearer "+key);
    assert.equal(init?.method,"POST");const body=JSON.parse(String(init?.body));sent.push(body);
    assert.equal(body.model,model.name);assert.ok(body.max_tokens<=4096);assert.equal(body.stream,false);
    assert.deepEqual(body.messages,[{role:"user",content:"总步数 = 已保存步数 + 后续验证步数"}]);
    assert.ok(!("tools" in body));assert.ok(!JSON.stringify(body).includes(key));
    return Response.json({model:model.name,choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:"Total steps = saved steps + subsequent verification steps"}}]});
  };
  const args={prompt:"总步数 = 已保存步数 + 后续验证步数",key,model,signal:new AbortController().signal};
  assert.match(await sendPdfCloudText(args,wire),/saved steps/);assert.equal(sent.length,1);
  let calls=0;await assert.rejects(sendPdfCloudText(args,async()=>{calls++;return new Response("untrusted "+key,{status:429});}),/^Error: translation_cloud_request_failed$/);
  assert.equal(calls,1);
  await assert.rejects(sendPdfCloudText({...args,prompt:"sk-FAKEVERYSECRETINCONTENT000"},wire),/translation_cloud_sensitive_text/);
  assert.equal(sent.length,1);
});

test("a different returned model, incomplete output, tools and a key echo never enter layout",async()=>{
  const model=pdfCloudModel("deepseek-v4-pro"),key="synthetic-key-01";
  const args={model,key,prompt:"checkpoint",signal:new AbortController().signal};
  for(const [reported,reason,content,extra] of [
    ["deepseek-flash","stop","checkpoint",{}],[model.name,"length","partial",{}],
    [model.name,"stop","checkpoint",{tool_calls:[{}]}],[model.name,"stop",key,{}],
  ] as const){
    let sent=0;await assert.rejects(sendPdfCloudText(args,async()=>{sent++;return Response.json({model:reported,
      choices:[{index:0,finish_reason:reason,message:{role:"assistant",content,...extra}}]});}),/^Error: translation_cloud_request_failed$/);
    assert.equal(sent,1);
  }
  const stopped=new AbortController();stopped.abort();let sends=0;
  await assert.rejects(sendPdfCloudText({...args,signal:stopped.signal},async()=>{sends++;return new Response();}));assert.equal(sends,0);
});
