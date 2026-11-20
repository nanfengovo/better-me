import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDefaultResumeView, createDemoFactBase, projectResume, type CareerTaskResumeReceipt } from "@better-me/core";

const hooks = registerHooks({ load(url, context, next) {
  return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context);
} });
const { ResumeReplacementEditor } = await import("../src/components/ResumeReplacementEditor");
after(() => hooks.deregister());

const facts = createDemoFactBase();
const source = createDefaultResumeView(facts);
const H = "a".repeat(64);
const receipt: CareerTaskResumeReceipt = {
  id:"resume-receipt:replace-one-demo", taskId:"replace-one-demo", resumeId:"edition", sourceResumeId:source.id,
  sourceFingerprint:H, approvalHash:H, contentHash:H, snapshotHash:H, job:{title:"测试岗位"}, savedAt:"2026-11-20T00:00:00Z",
};
const edition = {...source, id:receipt.resumeId, isolatedFactBase:facts, careerTaskReceipt:receipt};
const props = {view:edition, facts, projected:projectResume(facts,edition), workspaceKey:"example", onSave:async () => { throw Error("unexpected_write"); },
  config:{ provider:"ollama" as const, model:"local", baseUrl:"http://localhost", apiKey:"", temperature:0 } };

test("a newly mounted edition stays pending until the saving parent confirms its receipt", () => {
  for (const phase of ["saving","unknown","checking","absent","changed"] as const) {
    const html = renderToStaticMarkup(createElement(ResumeReplacementEditor,{...props,readback:{editionId:edition.id,phase,message:"测试：核对正式记录"}}));
    assert.match(html,/核对正式记录/);
    assert.doesNotMatch(html,/已保存岗位版|导出岗位版 MD/);
    assert.equal(html.includes("重新核对保存记录"), phase === "unknown");
  }
  const confirmed = renderToStaticMarkup(createElement(ResumeReplacementEditor,props));
  assert.match(confirmed,/已保存岗位版/);
  assert.match(confirmed,/导出岗位版 MD/);
});

test("an acknowledged write still has a verified-file download when the source editor stayed open", () => {
  const html = renderToStaticMarkup(createElement(ResumeReplacementEditor,{...props,view:source,
    readback:{phase:"confirmed",editionId:edition.id,message:"确认",verifiedFile:{projected:props.projected,name:"岗位版"}}}));
  assert.match(html,/导出已核对岗位版 MD/);
  assert.doesNotMatch(html,/重新核对保存记录/);
});
