import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, afterEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {setTimeout as delay} from "node:timers/promises";
import {once} from "node:events";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import {createAgentServer} from "../../agent-host/src/server";
import {MemorySaver} from "../../agent-host/tests/fixtures/checkpointer";
import {registerTestIdentity} from "../../agent-host/tests/fixtures/identity";
import {activatePrincipal} from "../src/lib/identity";
import {ocrImage,ocrText} from "../../agent-host/tests/fixtures/jd-ocr";
import type {TaskImage,CareerTaskModelOutput} from "../../agent-host/src/kernel/model-protocol";
import { Window } from "happy-dom";
import {
  createDefaultResumeView,
  createDemoFactBase,
  projectResume,
  type JdMatchReport,
  type LlmConfig,
  type ProjectedResume,
} from "@better-me/core";

// Real React modal/default task client -> private authenticated Host/kernel.
// The sole reasoner is scripted; browser traffic can only reach local tasks.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const dom = new Window({ url: "http://127.0.0.1:5199" });
const globals = {
  window: dom, document: dom.document, navigator: dom.navigator,
  localStorage: dom.localStorage, HTMLElement: dom.HTMLElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true,
  FileReader:dom.FileReader,
};
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { JdMatchModal } = await import("../src/components/JdMatchModal.tsx");
const originalFetch = globalThis.fetch;
const clipboardDescriptor = Object.getOwnPropertyDescriptor(dom.navigator, "clipboard");
const config: LlmConfig = {
  provider: "openai-compatible", baseUrl: "https://ai-fixture.invalid/v1",
  apiKey: "fixture-secret-only", model: "fixture-model", temperature: 0.3,
};
const jdText = "岗位职责：开发设备告警接口，维护输入校验与自动化回归。任职要求：熟悉 C#、接口设计和测试。";
const originalClaim = "为设备告警接口编写输入校验，并补充自动化回归测试。";
const demoBase = createDemoFactBase("2000-01-01T00:00:00.000Z");
const demoResume = projectResume(demoBase, createDefaultResumeView(demoBase));
// Deliberately keep the default display name and sample IDs. The substantive
// evidence, rather than a cosmetic name or ID, must determine readiness.
const personalResume: ProjectedResume = {
  locale: "zh", templateId: "zh-classic",
  profile: { displayName: "你的名字", links: [], targetRoles: [], traits: [] },
  experiences: [{
    id: "exp-sample-1", type: "work", org: "合成案例设备研发部", title: "软件工程师",
    start: "2025-01", end: null, techStack: ["C#"],
    claims: [{ id: "claim-sample-1", kind: "action", text: originalClaim, tags: [] }],
  }],
};
const emptyResume: ProjectedResume = { ...personalResume, experiences: [] };
const validSuggestion = {
  claimId: "claim-sample-1", currentText: originalClaim,
  suggestedText: "为设备告警接口补充输入校验与自动化回归测试，覆盖异常输入处理。",
  reason: "合成候选表达；异常输入覆盖范围仍需本人核对。",
};
const report = (summary = "合成材料参考结果", extra: Partial<JdMatchReport> = {}): JdMatchReport => ({
  matchScore: 73, scoreSummary: summary, matchingStrengths: ["当前材料提及接口校验和自动化回归。"],
  missingGaps: ["当前材料未提供其他岗位条件的依据，需本人确认。"],
  tailoredSuggestions: [validSuggestion], unverifiedSuggestionCount: 0,
  interviewDefenseTips: ["请说明测试覆盖的异常输入类型。"], ...extra,
});
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), {
  status: 200, headers: { "content-type": "application/json" },
});
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
type Request = { prompt:string;url: string; init: RequestInit | undefined };
let root: ReturnType<typeof createRoot> | undefined;
let host:http.Server|undefined,fixtureDirectory:string|undefined,activeModelCalls:Request[]=[];
let readFixtureTasks:(()=>Promise<{tasks:{status:string}[]}>)|undefined;
async function drainFixture(){
  if(!readFixtureTasks)return;
  for(let i=0;i<500;i++){
    const current=await readFixtureTasks();
    if(current.tasks.every(task=>task.status!=="running"))return;
    await act(async()=>{await delay(10);});
  }
  assert.fail("live synthetic Host task did not finish; temporary data must not be deleted");
}

async function flush(action: () => void | Promise<void> = () => undefined) {
  await act(async () => { await action(); await nextTurn(); await nextTurn(); });
}
function button(label: string) {
  const found = [...dom.document.querySelectorAll("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label);
  assert.ok(found, `missing button: ${label}`);
  return found;
}
async function click(label: string) {
  const target = button(label);
  assert.equal(target.disabled, false, `disabled button: ${label}`);
  const before=activeModelCalls.length;
  await flush(() => target.click());
  if(label==="授权当前简历并生成报告")await waitUntil(()=>activeModelCalls.length>before||!!dom.document.querySelector('[role="alert"]')||!text().includes("AI 深度诊断中"));
}
async function waitUntil(condition:()=>boolean){for(let i=0;i<500;i++){await flush();if(condition())return;await act(async()=>{await delay(10);});}assert.fail("synthetic kernel/UI did not settle");}
function jdField() {
  const field = dom.document.getElementById("jd-text");
  assert.ok(field instanceof dom.HTMLTextAreaElement, "missing JD editor");
  return field;
}
async function editJd(text: string) {
  await flush(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(jdField(), text);
    jdField().dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
}
const text = () => dom.document.body.textContent ?? "";
const readinessText = () => dom.document.querySelector('[role="status"][aria-label="简历分析准备状态"]')?.textContent ?? "";

async function mount(
  initialResume: ProjectedResume = demoResume,
  policy: (request: Request, index: number) => Response | Promise<Response> = () => response(report()),
  ocrPolicy?:(prompt:string,images:TaskImage[])=>CareerTaskModelOutput|Promise<CareerTaskModelOutput>,
) {
  const calls: Request[] = [];
  activeModelCalls=calls;
  const wire:{path:string;method:string;body?:Record<string,unknown>}[]=[];
  const saved: { text: string; provenance: unknown }[] = [];
  const copied: string[] = [];
  const callbacks = { imported: 0, edited: 0, closed: 0 };
  let currentResume = initialResume;
  dom.localStorage.clear();
  Object.defineProperty(dom.navigator, "clipboard", { configurable: true, value: { async writeText(value: string) { copied.push(value); } } });
  fixtureDirectory=await mkdtemp(path.join(os.tmpdir(),"betterme-jd-modal-http-"));
  const token="synthetic-modal-only";
  host=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[],runtimeDefinitions:[],
    identityDirectory:path.join(fixtureDirectory,"identity"),runsDirectory:path.join(fixtureDirectory,"runs"),understandingDirectory:path.join(fixtureDirectory,"understanding"),checkpointer:new MemorySaver() as never,
    careerTaskReasoner:async()=>async(prompt,_signal,phase,images)=>{
      if(phase==="jd_ocr"){
        assert.ok(ocrPolicy,"OCR requires an explicit scripted fixture, never an external model");calls.push({prompt,url:"kernel:jd_ocr",init:undefined});return ocrPolicy(prompt,images??[]);
      }
      assert.equal(phase,"jd_match");const request={prompt,url:"kernel:jd_match",init:undefined};calls.push(request);
      const answer=await (await policy(request,calls.length-1)).json();
      const data=JSON.parse(prompt.split("\n\n").at(-1)!),source=data.evidence.find((item:{sourceId:string})=>item.sourceId==="claim:claim-sample-1");
      assert.ok(source,"the actual Host mounted the original claim");
      return JSON.stringify({kind:"match",proposals:data.requiredItems.map((jdItem:string)=>({jdItem,evidenceType:"claimed",profileEntryId:"claim-sample-1",suggestion:originalClaim,rationale:"合成自述，仍需本人核对。",evidenceIds:[source.id]})),report:JSON.parse(answer.choices[0].message.content)});
    }});
  await once(host,"listening");const address=host.address();assert.ok(address&&typeof address!=="string");const origin=`http://127.0.0.1:${address.port}`;
  const identity=await registerTestIdentity(origin,token);activatePrincipal(identity.principal);
  readFixtureTasks=async()=>{const result=await originalFetch(origin+"/api/v1/agent/tasks",{headers:{Authorization:`Bearer ${token}`,...identity.headers}});assert.equal(result.status,200);return result.json();};
  globalThis.fetch = async (url, init) => {
    const pathname=new URL(String(url),origin).pathname;assert.ok(pathname.startsWith("/api/v1/agent/tasks"),"browser generation has no provider fallback");
    wire.push({path:pathname,method:init?.method??"GET",...(typeof init?.body==="string"?{body:JSON.parse(init.body)}:{})});
    const headers=new Headers(init?.headers);headers.set("Authorization",`Bearer ${token}`);for(const [key,value] of Object.entries(identity.headers))headers.set(key,value);
    return originalFetch(origin+pathname,{...init,headers});
  };
  dom.document.body.innerHTML = '<main id="fixture"></main>';
  root = createRoot(dom.document.getElementById("fixture")! as unknown as Element);
  const render = async (nextResume = currentResume, isOpen = true) => {
    currentResume = nextResume;
    await flush(() => root!.render(createElement(JdMatchModal, {
      isOpen, workspaceKey:"synthetic-modal",resume: currentResume, llmConfig: config, initialText: jdText,
      onClose() { callbacks.closed += 1; }, onOpenConfig() {}, onOpenNetworkSettings() {},
      onImportResume() { callbacks.imported += 1; }, onEditResume() { callbacks.edited += 1; },
      onSaveOpportunity(draft) { saved.push(draft); },
    })));
  };
  await render();
  return { calls,wire, saved, copied, callbacks, render };
}

afterEach(async () => {
  await flush(() => { root?.unmount(); root = undefined; });
  await drainFixture();readFixtureTasks=undefined;
  globalThis.fetch = originalFetch;
  activatePrincipal(undefined);
  if(host){const current=host;host=undefined;current.closeIdleConnections();await new Promise<void>((resolve,reject)=>current.close(error=>error?reject(error):resolve()));}
  if(fixtureDirectory){await rm(fixtureDirectory,{recursive:true,force:true});fixtureDirectory=undefined;}
  dom.localStorage.clear();
  if (clipboardDescriptor) Object.defineProperty(dom.navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(dom.navigator, "clipboard");
});
after(async () => {
  css.deregister();
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("actual screenshot button keeps original bytes, pauses, restores originals after unmount and manually resumes without adopting JD",async()=>{
  const original=ocrImage(20,2*1024*1024);let sends=0;
  const {calls,wire,saved,render}=await mount(demoResume,undefined,async(_prompt,images)=>{
    sends++;assert.equal(images.length,1);assert.equal(images[0]!.dataUrl,original.dataUrl);
    return {text:JSON.stringify({kind:"ocr",text:ocrText}),finishReason:sends===1?"length":"stop"};
  });
  await click("截图识别");const input=dom.document.querySelector('input[type="file"]');assert.ok(input);
  const file=new dom.File([Buffer.from(original.dataUrl.split(",")[1]!,"base64")],original.image.name,{type:"image/png"});
  await flush(()=>{Object.defineProperty(input,"files",{configurable:true,value:[file]});input.dispatchEvent(new dom.Event("change",{bubbles:true}));});
  await waitUntil(()=>[...dom.document.querySelectorAll("button")].some(button=>button.textContent?.trim()==="授权并识别截图文字"&&!button.disabled));
  assert.equal(dom.document.querySelector('img[alt="岗位截图 1"]')?.getAttribute("src"),original.dataUrl);assert.equal(calls.length,0);
  await click("授权并识别截图文字");await waitUntil(()=>text().includes("恢复原截图任务")&&text().includes("paused"));
  assert.equal(calls.length,1);assert.equal(jdField().value,jdText);assert.equal(saved.length,0);
  const posts=wire.filter(row=>row.method==="POST").length;
  await flush(()=>root!.unmount());root=createRoot(dom.document.getElementById("fixture")! as unknown as Element);await render();await click("截图识别");
  await click("读取上次截图任务与原图（不重新识别）");await waitUntil(()=>text().includes("恢复原截图任务")&&!button("读取上次截图任务与原图（不重新识别）").disabled);
  const section=dom.document.querySelector('section[aria-label="截图任务记录"]');assert.ok(section);
  const grant=section.querySelector('input[type="checkbox"]');assert.ok(grant instanceof dom.HTMLInputElement);assert.equal(grant.checked,false);assert.equal(button("恢复原截图任务").disabled,true);
  assert.equal(dom.document.querySelector('img[alt="岗位截图 1"]')?.getAttribute("src"),original.dataUrl);assert.equal(calls.length,1);assert.equal(wire.filter(row=>row.method==="POST").length,posts);
  await flush(()=>grant.click());await click("恢复原截图任务");await waitUntil(()=>!!dom.document.getElementById("jd-extracted"));
  assert.equal(calls.length,2);const candidate=dom.document.getElementById("jd-extracted");assert.ok(candidate instanceof dom.HTMLTextAreaElement);assert.equal(candidate.value,ocrText);assert.equal(jdField().value,jdText);assert.equal(saved.length,0);
  const completePosts=wire.filter(row=>row.method==="POST").length;await render(demoResume,false);await render(demoResume,true);
  await click("读取上次截图任务与原图（不重新识别）");await waitUntil(()=>!!dom.document.getElementById("jd-extracted"));assert.equal(calls.length,2);assert.equal(wire.filter(row=>row.method==="POST").length,completePosts);
  assert.ok(wire.every(row=>row.path.startsWith("/api/v1/agent/tasks")));assert.ok(!JSON.stringify(wire.filter(row=>row.path.endsWith("/tasks"))).includes("data:image"));
});

test("removing a screenshot fences a late OCR candidate without starting another model",async()=>{
  const late=deferred<CareerTaskModelOutput>(),original=ocrImage(21);
  const {calls,saved}=await mount(demoResume,undefined,()=>late.promise);await click("截图识别");
  const input=dom.document.querySelector('input[type="file"]');assert.ok(input);
  const file=new dom.File([Buffer.from(original.dataUrl.split(",")[1]!,"base64")],original.image.name,{type:"image/png"});
  await flush(()=>{Object.defineProperty(input,"files",{configurable:true,value:[file]});input.dispatchEvent(new dom.Event("change",{bubbles:true}));});await waitUntil(()=>[...dom.document.querySelectorAll("button")].some(button=>button.textContent?.trim()==="授权并识别截图文字"&&!button.disabled));
  await click("授权并识别截图文字");await waitUntil(()=>calls.length===1);await click("移除截图 1");
  await flush(()=>late.resolve({text:JSON.stringify({kind:"ocr",text:ocrText}),finishReason:"stop"}));await drainFixture();await flush();
  assert.equal(dom.document.getElementById("jd-extracted"),null);assert.equal(jdField().value,jdText);assert.equal(calls.length,1);assert.equal(saved.length,0);
});

test("演示简历明确提示示例并禁用分析，点击不会发送 AI 请求", async () => {
  const { calls } = await mount();
  assert.match(readinessText(), /示例/);
  assert.equal(button("授权当前简历并生成报告").disabled, true);
  await flush(() => button("授权当前简历并生成报告").click());
  assert.equal(calls.length, 0);
  assert.doesNotMatch(text(), /AI 文本参考评分/);
});

test("缺少经历的空简历不能分析，也不触发网络请求", async () => {
  const { calls } = await mount(emptyResume);
  assert.match(readinessText(), /经历|依据|补充/);
  assert.equal(button("授权当前简历并生成报告").disabled, true);
  await flush(() => button("授权当前简历并生成报告").click());
  assert.equal(calls.length, 0);
});

test("准备状态的两个入口调用导入和填写回调，保持零 AI 请求", async () => {
  const { calls, callbacks } = await mount();
  await click("导入我的简历");
  assert.equal(callbacks.imported, 1);
  assert.equal(callbacks.edited, 0);
  await click("填写真实经历");
  assert.equal(callbacks.edited, 1);
  assert.equal(calls.length, 0);
});

test("示例阻挡个人分析期间仍能编辑和收藏 JD，切换简历不丢岗位正文", async () => {
  const { calls, saved, render } = await mount();
  const edited = `${jdText}\n补充要求：维护设备接口文档。`;
  assert.equal(jdField().disabled, false);
  await editJd(edited);
  assert.equal(jdField().value, edited);
  await click("收藏到机会库");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.text, edited);
  assert.equal(calls.length, 0);
  assert.equal(button("授权当前简历并生成报告").disabled, true);
  await render(personalResume);
  assert.equal(jdField().value, edited);
  assert.equal(button("授权当前简历并生成报告").disabled, false);
});

test("一段本人材料和一个要点即可分析，默认姓名与 sample IDs 不会被误拦", async () => {
  const { calls,wire } = await mount(personalResume);
  assert.equal(readinessText(), "");
  assert.match(text(), /依据当前简历内容/);
  assert.equal(button("授权当前简历并生成报告").disabled, false);
  await click("授权当前简历并生成报告");
  await waitUntil(()=>text().includes("合成材料参考结果"));
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0]!.prompt.split("\n\n").at(-1)!);
  assert.equal(body.rawJd,jdText);assert.ok(body.evidence.some((item:{excerpt:string})=>item.excerpt===originalClaim));
  const create=wire.find(row=>row.method==="POST"&&row.path.endsWith("/tasks"))!.body!;
  assert.equal((create.matching as {reportRequested:boolean}).reportRequested,true);
  assert.equal(create.rootScopeKey,"synthetic-modal");
  assert.ok(!JSON.stringify(create).includes("你的名字"),"contact/display-name fields are not implicitly shared");
  assert.ok(wire.every(row=>row.path.startsWith("/api/v1/agent/tasks")));
  assert.match(text(), /合成材料参考结果/);
  assert.match(text(), /AI 文本参考评分/);
  assert.match(text(), /73\s*\/\s*100/);
  assert.doesNotMatch(text(), /73\s*%/);
  assert.match(text(), /不是能力认证或录用概率/);
});

test("返回示例简历立即清除旧报告与复制入口，不再显示个人匹配结论", async () => {
  const { calls, render } = await mount(personalResume);
  await click("授权当前简历并生成报告");
  await waitUntil(()=>text().includes("合成材料参考结果"));
  assert.match(text(), /合成材料参考结果/);
  assert.ok([...dom.document.querySelectorAll("button")].some(item => item.textContent?.trim() === "复制诊断结果"));
  await render(demoResume);
  assert.match(readinessText(), /示例/);
  assert.doesNotMatch(text(), /合成材料参考结果|AI 文本参考评分/);
  assert.equal([...dom.document.querySelectorAll("button")].some(item => item.textContent?.trim() === "复制诊断结果"), false);
  assert.equal(button("授权当前简历并生成报告").disabled, true);
  assert.equal(calls.length, 1);
});

test("关闭重开按完整资料只读恢复既有报告，不恢复发送授权或新增调用",async()=>{
  const {calls,wire,render}=await mount(personalResume);
  await click("授权当前简历并生成报告");await waitUntil(()=>text().includes("合成材料参考结果"));
  const writes=wire.filter(row=>row.method==="POST").length;assert.equal(calls.length,1);
  await render(personalResume,false);await render(personalResume,true);
  await waitUntil(()=>text().includes("已读取本机已有报告"));
  assert.match(text(),/合成材料参考结果/);assert.equal(calls.length,1);
  assert.equal(wire.filter(row=>row.method==="POST").length,writes,"restoring never creates, starts or reviews a task");
});

test("切回示例期间到达的旧响应不能重新显示报告", async () => {
  const old = deferred<Response>();
  const { calls, render } = await mount(personalResume, () => old.promise);
  await click("授权当前简历并生成报告");
  await render(demoResume);
  await flush(() => old.resolve(response(report("示例期间迟到结果"))));
  await drainFixture();await flush();
  assert.equal(calls.length, 1);
  assert.equal(button("授权当前简历并生成报告").disabled, true);
  assert.match(readinessText(), /示例/);
  assert.doesNotMatch(text(), /示例期间迟到结果|AI 文本参考评分/);
});

test("切换真实资料拒绝覆盖冻结任务，迟到的旧响应不能变成新材料报告或清账", async () => {
  const old = deferred<Response>();
  const { calls, render } = await mount(personalResume, (_request, index) => index === 0 ? old.promise : response(report("当前合成材料结果")));
  await click("授权当前简历并生成报告");
  assert.equal(calls.length, 1);
  await render(demoResume);
  assert.equal(button("授权当前简历并生成报告").disabled, true);
  assert.doesNotMatch(text(), /AI 文本参考评分/);
  const changed=structuredClone(personalResume);changed.experiences[0]!.claims[0]!.text+=" 本次纠正：只做测试。";
  await render(changed);
  await click("授权当前简历并生成报告");
  await waitUntil(()=>text().includes("共享范围已变化"));
  assert.equal(calls.length, 1);
  await flush(() => old.resolve(response(report("迟到旧材料结果"))));
  await drainFixture();await flush();
  assert.match(text(), /共享范围已变化/);
  assert.doesNotMatch(text(), /迟到旧材料结果|当前合成材料结果|AI 文本参考评分/);
});

test("引用未知或原句不符的改写被排除，界面和复制报告都保留待核实边界与来源 ID", async () => {
  const { calls, copied } = await mount(personalResume, () => response(report("引用过滤合成结果", {
    unverifiedSuggestionCount: 999,
    tailoredSuggestions: [
      validSuggestion,
      { ...validSuggestion, claimId: "unknown-fixture-claim", suggestedText: "未知来源改写不能出现" },
      { ...validSuggestion, currentText: "模型概括了原句而非逐字引用。", suggestedText: "错误原句改写不能出现" },
    ],
  })));
  await click("授权当前简历并生成报告");
  await waitUntil(()=>text().includes("引用过滤合成结果"));
  assert.equal(calls.length, 1);
  assert.match(text(), /原文已定位，改写待核实/);
  assert.match(text(), /已排除\s*2\s*条/);
  assert.match(text(), /claim-sample-1/);
  assert.ok(text().includes(validSuggestion.suggestedText));
  assert.doesNotMatch(text(), /未知来源改写不能出现|错误原句改写不能出现|绝不造假|999/);
  await click("复制诊断结果");
  assert.equal(copied.length, 1);
  assert.match(copied[0]!, /AI 文本参考评分：73\s*\/\s*100/);
  assert.match(copied[0]!, /不是能力认证或录用概率/);
  assert.match(copied[0]!, /原文已定位，改写待核实/);
  assert.match(copied[0]!, /引用要点：claim-sample-1/);
  assert.match(copied[0]!, /逐项核实后再使用/);
  assert.match(copied[0]!, /已排除\s*2\s*条/);
  assert.ok(copied[0]!.includes(originalClaim));
  assert.doesNotMatch(copied[0]!, /未知来源改写不能出现|错误原句改写不能出现|绝不造假|73\s*%|999/);
});
