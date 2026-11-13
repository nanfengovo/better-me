import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { setImmediate as next, setTimeout as delay } from "node:timers/promises";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";
import type { CareerArchitectureLabProps } from "../src/components/CareerArchitectureLab";
import {
  applyArchitectureCommand, architectureDocumentFingerprint, cloneArchitectureDocument, createArchitectureDocument, newArchitectureNode, simulateArchitectureFault,
  type ArchitectureBinding, type ArchitectureDocument, type ArchitectureInterviewerAdapter, type ArchitectureStorageAdapter,
} from "../src/lib/architecture-lab";

const cssHook = registerHooks({ load(url, context, step) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : step(url, context); } });
const win = new Window({ url: "https://architecture-fixture.invalid" });
const React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>();
let attemptedNetwork = 0;
for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement,
  SVGElement: win.SVGElement, HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLInputElement: win.HTMLInputElement, Element: win.Element,
  Node: win.Node, React, IS_REACT_ACT_ENVIRONMENT: true, fetch: async () => { attemptedNetwork++; throw Error("No network in isolated UI fixtures"); } })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { default: Lab } = await import("../src/components/CareerArchitectureLab");
const binding: ArchitectureBinding = { ownerId: "synthetic-ui-owner", sessionGeneration: 1, projectId: "synthetic-ui-project", revision: "1", contentHash: "synthetic-authorized-snapshot" };
const evidence = [{ id: "ev1", label: "已授权合成证据", excerpt: "PRIVATE_SYNTHETIC_EXCERPT", path: "/private/synthetic/implementation.ts", startLine: 4, endLine: 9 }];
let root: ReturnType<typeof createRoot> | undefined;
let currentBinding = binding;
const props: CareerArchitectureLabProps = { binding, evidence, getCurrentBinding: () => currentBinding };
function graph() {
  let document = createArchitectureDocument(binding, evidence);
  for (const [id, kind, x] of [["client", "client", 50], ["service", "service", 350], ["db", "store", 650]] as const) {
    const node = newArchitectureNode(id, kind, x, 100); node.label = id === "client" ? "入口" : id === "service" ? "业务服务" : "本地数据库"; node.evidenceIds = ["ev1"];
    document = applyArchitectureCommand(document, { type: "add-node", node });
  }
  return document;
}
async function settle(action = () => {}) { await React.act(async () => { action(); await next(); await next(); }); }
async function mount(changes: Partial<CareerArchitectureLabProps> = {}) {
  if (!root) { const host = win.document.createElement("div"); win.document.body.append(host); root = createRoot(host as unknown as HTMLElement); }
  await settle(() => root!.render(React.createElement(Lab, { ...props, ...changes })));
  const canvas = win.document.querySelector("[data-architecture-canvas]");
  if (canvas) canvas.getBoundingClientRect = () => new win.DOMRect(0, 0, 1200, 760);
}
afterEach(async () => { await settle(() => { root?.unmount(); root = undefined; }); win.document.body.replaceChildren(); currentBinding = binding; assert.equal(attemptedNetwork, 0); });
after(async () => { cssHook.deregister(); await win.happyDOM.abort(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
function button(pattern: RegExp) { const element = [...win.document.querySelectorAll("button")].find(item => pattern.test(item.textContent ?? "")); assert.ok(element, `missing button ${pattern}`); return element; }
async function click(pattern: RegExp) { await settle(() => button(pattern).click()); }
async function fill(pattern: RegExp, value: string) {
  const label = [...win.document.querySelectorAll("label")].find(item => pattern.test(item.firstChild?.textContent ?? "") && item.querySelector("textarea,input:not([type=checkbox])"));
  const element = label?.querySelector("textarea,input:not([type=checkbox])"); assert.ok(element, `missing field ${pattern}`);
  await settle(() => { const prototype = element.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value); element.dispatchEvent(new win.Event("input", { bubbles: true })); });
}
async function check(pattern: RegExp) { const label = [...win.document.querySelectorAll("label")].find(item => pattern.test(item.textContent ?? "") && item.querySelector("input[type=checkbox]")); assert.ok(label); await settle(() => label.querySelector("input")!.click()); }
async function select(pattern: RegExp, value: string) { const label = [...win.document.querySelectorAll("label")].find(item => pattern.test(item.textContent ?? "") && item.querySelector("select")); const element = label?.querySelector("select"); assert.ok(element); await settle(() => { element.value = value; element.dispatchEvent(new win.Event("change", { bubbles: true })); }); }
function pointer(element: { dispatchEvent(event: InstanceType<typeof win.PointerEvent>): boolean }, type: string, x: number, y: number, id = 1) { element.dispatchEvent(new win.PointerEvent(type, { bubbles: true, pointerId: id, button: 0, clientX: x, clientY: y })); }
function interviewer(overrides: Partial<ArchitectureInterviewerAdapter> = {}): ArchitectureInterviewerAdapter {
  return { label: "合成本地面试官", location: "local", ask: async context => ({ requestId: context.requestId, binding: context.binding, graphFingerprint: context.graphFingerprint,
    value: { id: "q1", text: "在模型返回中途切换账号，哪个位置必须校验会话代次？", evidenceIds: ["ev1"], unknowns: ["是否实际上线未知"] } }),
  review: async context => ({ requestId: context.requestId, binding: context.binding, graphFingerprint: context.graphFingerprint,
    value: { support: "partial", summary: "已区分读授权与写入授权，原子提交仍需证据。", strengths: ["指出会话代次边界"], gaps: ["未核对写入前CAS"], followUps: ["磁盘满时回执如何处理？"], evidenceIds: ["ev1"] } }), ...overrides };
}

test("empty state is honest; normal clear-and-type inputs, annotations and keyboard movement edit actual graph data", async () => {
  await mount();
  assert.match(win.document.body.textContent!, /没有预置架构或虚构事实/);
  assert.equal(button(/^保存会话$/).disabled, true); assert.equal(button(/^基于当前图提问$/).disabled, true);
  await click(/^服务$/); await fill(/^节点名称$/, ""); await fill(/^节点名称$/, "证据路由与回执服务"); await fill(/^节点说明$/, "先核对会话，再进行原子提交。");
  const node = win.document.querySelector("[data-node-id]")!;
  assert.match(node.getAttribute("aria-label")!, /证据路由与回执服务/);
  await settle(() => node.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })));
  assert.equal(node.getAttribute("transform"), "translate(68 60)");
  await click(/^标注$/); await fill(/^标注内容$/, "这项防护尚未核对，不应升级为Fact。");
  assert.match(win.document.querySelector("[data-annotation-id]")?.textContent ?? "", /这项防护尚未核对/);
  assert.equal(win.document.querySelector("[data-architecture-canvas]")?.getAttribute("role"), "group");
});

test("pointer drag moves the node, ignores a second pointer, and is one undoable graph edit", async () => {
  await mount({ initialDocument: graph() });
  const node = win.document.querySelector('[data-node-id="service"]')!, canvas = win.document.querySelector("[data-architecture-canvas]")!;
  await settle(() => pointer(node, "pointerdown", 360, 110));
  await settle(() => pointer(canvas, "pointermove", 460, 210));
  assert.equal(node.getAttribute("transform"), "translate(450 200)");
  await settle(() => pointer(canvas, "pointermove", 700, 500, 2));
  assert.equal(node.getAttribute("transform"), "translate(450 200)");
  await settle(() => pointer(canvas, "pointerup", 460, 210));
  await click(/^撤销$/); assert.equal(node.getAttribute("transform"), "translate(350 100)");
  await click(/^重做$/); assert.equal(node.getAttribute("transform"), "translate(450 200)");
});

test("real port drag and keyboard endpoint selection create SVG edges, with no phantom connection after pointer click", async () => {
  await mount({ initialDocument: graph() });
  const output = win.document.querySelector('[data-port="output"][data-port-node="service"]')!;
  const input = win.document.querySelector('[data-port="input"][data-port-node="db"]')!;
  const canvas = win.document.querySelector("[data-architecture-canvas]")!;
  await settle(() => pointer(output, "pointerdown", 530, 142));
  await settle(() => pointer(canvas, "pointermove", 650, 142));
  await settle(() => pointer(canvas, "pointerup", 650, 142));
  assert.equal(win.document.querySelectorAll("[data-edge-id]").length, 1);
  await settle(() => output.dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 1 })));
  assert.equal(win.document.querySelector(".cal-connecting"), null);
  await settle(() => output.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
  await settle(() => input.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
  assert.equal(win.document.querySelectorAll("[data-edge-id]").length, 2);
  await fill(/^连线说明$/, "写入前验证会话代次");
  assert.match(win.document.querySelector(".cal-edge-label")?.textContent ?? "", /写入前验证会话代次/);
});

test("keyboard Delete cascades edges; fault simulation uses actual node strategies and becomes stale after edits", async () => {
  await mount({ initialDocument: graph() });
  await click(/^运行离线推演$/);
  assert.match(win.document.querySelector(".cal-outcomes")?.textContent ?? "", /本地数据库 · 注入点不可用/);
  assert.match(win.document.body.textContent!, /没有触碰真实磁盘/);
  const node = win.document.querySelector('[data-node-id="service"]')!;
  await settle(() => node.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })));
  assert.equal(win.document.querySelector(".cal-outcomes"), null);
  assert.match(win.document.body.textContent!, /1 次故障/);
  await select(/^故障类型/, "session-switch"); await click(/^运行离线推演$/);
  assert.match(win.document.querySelector(".cal-outcomes")?.textContent ?? "", /未知/);
  await settle(() => node.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, key: "Delete" })));
  assert.equal(win.document.querySelector('[data-node-id="service"]'), null);
});

test("model calls require per-operation consent and do not send past conversations", async () => {
  let calls = 0;
  await mount({ initialDocument: graph(), interviewer: interviewer({ ask: async context => {
    calls++; assert.equal(context.document.turns.length, 0); assert.equal(context.document.evidence[0]?.excerpt, evidence[0]?.excerpt);
    return interviewer().ask(context, new AbortController().signal);
  } }) });
  assert.equal(calls, 0); assert.equal(button(/^基于当前图提问$/).disabled, true);
  await check(/仅用于本次提问/); await click(/^基于当前图提问$/);
  assert.equal(calls, 1); assert.match(win.document.body.textContent!, /哪个位置必须校验会话代次/);
  assert.equal(button(/^基于当前图提问$/).disabled, true);
  assert.match(win.document.querySelector(".cal-unknown")?.textContent ?? "", /是否实际上线未知/);
});

test("answer drafts, completed reviews and original turns survive save with exact CAS receipts", async () => {
  let saved: ArchitectureDocument | undefined, expected: string | null | undefined;
  const storage: ArchitectureStorageAdapter = { load: async () => null, save: async request => { saved = cloneArchitectureDocument(request.document); expected = request.expectedVersion;
    return { status: "saved", binding, documentId: request.document.id, documentRevision: request.document.revision, fingerprint: request.fingerprint, storageVersion: "stored-1" }; } };
  await mount({ initialDocument: graph(), interviewer: interviewer(), storage });
  await check(/仅用于本次提问/); await click(/^基于当前图提问$/);
  await fill(/^你的架构答复$/, "在事务提交前重新核对会话代次，并以CAS绑定原版本。");
  await click(/^保存会话$/);
  assert.equal(saved?.turns[0]?.draftAnswer, "在事务提交前重新核对会话代次，并以CAS绑定原版本。"); assert.equal(expected, null);
  assert.equal(button(/^提交答复并复盘$/).disabled, true);
  await check(/仅用于本次复盘/); await click(/^提交答复并复盘$/);
  assert.match(win.document.querySelector(".cal-review")?.textContent ?? "", /部分支持/);
  await click(/^保存会话$/);
  assert.equal(expected, "stored-1"); assert.equal(saved?.turns.length, 2);
  assert.equal(saved?.turns[0]?.answer, undefined); assert.match(saved?.turns[1]?.answer ?? "", /CAS/);
  assert.match(win.document.body.textContent!, /已核对保存版本/);
});

test("a changed answer or graph invalidates late model output instead of attaching it to another input", async () => {
  let resolveAsk!: (value: Awaited<ReturnType<ArchitectureInterviewerAdapter["ask"]>>) => void;
  let request!: Parameters<ArchitectureInterviewerAdapter["ask"]>[0];
  await mount({ initialDocument: graph(), interviewer: interviewer({ ask: async context => { request = context; return new Promise(resolve => { resolveAsk = resolve; }); } }) });
  await check(/仅用于本次提问/); await click(/^基于当前图提问$/);
  await settle(() => win.document.querySelector('[data-node-id="service"]')!.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })));
  await settle(() => resolveAsk({ requestId: request.requestId, binding, graphFingerprint: request.graphFingerprint, value: { id: "late", text: "不应显示的迟到问题", evidenceIds: ["ev1"], unknowns: [] } }));
  assert.equal(win.document.body.textContent!.includes("不应显示的迟到问题"), false);
  assert.match(win.document.body.textContent!, /本次结果失效/);
});

test("save uncertainty blocks retry; explicit load adoption preserves local data until confirmed", async () => {
  let calls = 0;
  const stored = graph(); stored.title = "存储里的图";
  const storage: ArchitectureStorageAdapter = { load: async () => ({ document: stored, storageVersion: "stored-existing" }), save: async () => { calls++; throw new Error("unknown result"); } };
  await mount({ initialDocument: graph(), storage });
  await click(/^保存会话$/); assert.equal(calls, 1); assert.equal(button(/^保存会话$/).disabled, true);
  assert.match(win.document.body.textContent!, /保存结果可能未知/);
  await click(/^加载对账$/);
  const title = [...win.document.querySelectorAll("label")].find(item => item.textContent?.startsWith("图的标题"))!.querySelector("input")!;
  assert.equal(title.value, "项目架构推演"); assert.equal(button(/^采用已加载版本$/).disabled, true);
  await check(/我明确选择用此存储版本/); await click(/^采用已加载版本$/);
  assert.equal(title.value, "存储里的图"); assert.equal(button(/^保存会话$/).disabled, false);
});

test("export is previewed and separately confirmed, without owner, source excerpt or private path", async () => {
  let artifact: { filename: string; mime: string; text: string } | undefined;
  await mount({ initialDocument: graph(), onExport: value => { artifact = value; } });
  await click(/^预览导出$/); assert.equal(button(/^确认下载JSON$/).disabled, true);
  const preview = win.document.querySelector('[aria-label="将导出的JSON"]')!.getAttribute("value") ?? (win.document.querySelector('[aria-label="将导出的JSON"]') as unknown as HTMLTextAreaElement).value;
  assert.equal(preview.includes("PRIVATE_SYNTHETIC_EXCERPT"), false); assert.equal(preview.includes("synthetic-ui-owner"), false); assert.equal(preview.includes("/private/synthetic/implementation.ts"), false);
  await check(/我已检查这份快照/); await click(/^确认下载JSON$/);
  assert.ok(artifact); assert.equal(JSON.parse(artifact.text).document.nodes.length, 3);
  assert.equal(win.document.querySelector('[aria-label="导出预览"]'), null);
});

test("account switch hides the prior graph and late saves cannot show success", async () => {
  let resolve!: (value: Awaited<ReturnType<ArchitectureStorageAdapter["save"]>>) => void;
  let saving!: Parameters<ArchitectureStorageAdapter["save"]>[0];
  await mount({ initialDocument: graph(), storage: { load: async () => null, save: async request => { saving = request; return new Promise(done => { resolve = done; }); } } });
  await click(/^保存会话$/); currentBinding = { ...binding, ownerId: "other-owner", sessionGeneration: 2 };
  await settle(() => resolve({ status: "saved", binding, documentId: saving.document.id, documentRevision: saving.document.revision, fingerprint: saving.fingerprint, storageVersion: "late" }));
  assert.equal(win.document.querySelector("[data-architecture-canvas]"), null);
  assert.equal(win.document.body.textContent!.includes("已核对保存版本"), false);
  assert.match(win.document.body.textContent!, /旧图未展示/);
});

test("timeout exposes unknown save outcome and does not auto-retry", async () => {
  let calls = 0;
  await mount({ initialDocument: graph(), operationTimeoutMs: 15, storage: { load: async () => null, save: async () => { calls++; return new Promise(() => {}); } } });
  await click(/^保存会话$/); await React.act(async () => { await delay(25); });
  assert.equal(calls, 1); assert.equal(button(/^保存会话$/).disabled, true); assert.match(win.document.body.textContent!, /不会自动重试/);
});

test("responsive, visible focus and reduced-motion CSS contracts exist (not a browser visual acceptance)", () => {
  const css = readFileSync(new URL("../src/components/CareerArchitectureLab.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 700px\)/); assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /:focus-visible/); assert.match(css, /overflow: auto/); assert.match(css, /prefers-reduced-motion/);
  assert.equal(/transition:\s*all/.test(css), false);
  assert.ok(architectureDocumentFingerprint(graph()).length > 0);
});

test("authorized code is never auto-imported: read, inspect and explicitly confirm before updating a graph inventory", async () => {
  let reads = 0, adopted = 0, saved: ArchitectureDocument | undefined;
  const document = graph(); document.faults.push(simulateArchitectureFault(document, { kind: "disk-full", targetNodeId: "db" }, { id: "old-fault" }));
  const fresh = [...evidence, { id: "code-2", label: "已重新核对的合成源码", excerpt: "const syntheticTransaction = true;", path: "transaction.ts", startLine: 1, endLine: 1 }];
  await mount({ initialDocument: document, importEvidence: async () => { reads++; return { receiptId: "receipt-1", evidence: fresh, limitations: ["不是独立作者证明"] }; },
    onEvidenceInventoryChanged: inventory => { adopted++; assert.deepEqual(inventory, fresh); },
    storage: { load: async () => null, save: async request => { saved = request.document; return { status: "saved", binding, documentId: request.document.id, documentRevision: request.document.revision, fingerprint: request.fingerprint, storageVersion: "1" }; } } });
  assert.equal(reads, 0); assert.equal(adopted, 0);
  await click(/^读取已授权源码$/); assert.equal(reads, 1); assert.equal(adopted, 0); assert.equal(button(/^确认更新引用库存$/).disabled, true);
  assert.match(win.document.body.textContent!, /const syntheticTransaction = true/);
  await check(/我已审阅，明确将这些引用用于当前架构图/); await click(/^确认更新引用库存$/);
  assert.equal(adopted, 1); assert.equal(win.document.querySelectorAll("[data-node-id]").length, 3); assert.match(win.document.body.textContent!, /尚未保存，也未写入Fact Base/);
  await click(/^保存会话$/); assert.ok(saved); assert.equal(saved.faults.length, 0); assert.equal(saved.turns.length, 0); assert.deepEqual(saved.evidence, fresh);
  assert.deepEqual(saved.nodes[0]!.evidenceIds, ["ev1"], "new evidence never auto-claims support for existing nodes");
});

test("source-read previews are bound to the exact current graph and cannot overwrite edits or a switched scope", async () => {
  let adopted = 0;
  await mount({ initialDocument: graph(), importEvidence: async () => ({ receiptId: "receipt-1", evidence, limitations: [] }), onEvidenceInventoryChanged: () => { adopted++; } });
  await click(/^读取已授权源码$/); await fill(/^图的标题$/, "读取后用户仍在继续编辑");
  await check(/我已审阅，明确将这些引用用于当前架构图/); await click(/^确认更新引用库存$/);
  assert.equal(adopted, 0); assert.match(win.document.body.textContent!, /读取后图已变化/);
  assert.equal((win.document.querySelector('input[maxlength="120"]') as unknown as HTMLInputElement).value, "读取后用户仍在继续编辑");
});

test("historical graph restoration remains a preview until replacement consent and is visibly an unsaved new-scope draft", async () => {
  const stored = graph(); stored.title = "历史存储图";
  let inventoryUpdates = 0;
  await mount({ storage: { load: async () => ({ document: stored, storageVersion: "7", restoredGraphOnly: true }), save: async () => ({ status: "conflict", detail: "fixture" }) },
    onEvidenceInventoryChanged: () => { inventoryUpdates++; } });
  await click(/^服务$/); await fill(/^节点名称$/, "不能静默丢失的本地草稿");
  await click(/^加载对账$/); assert.match(win.document.querySelector("[data-node-id]")?.getAttribute("aria-label") ?? "", /不能静默丢失/);
  assert.equal(button(/^采用已加载版本$/).disabled, true); assert.match(win.document.body.textContent!, /旧故障和问答已清除/);
  await check(/我明确选择用此存储版本替换当前本地草稿/); await click(/^采用已加载版本$/);
  assert.equal(inventoryUpdates, 1); assert.equal(win.document.querySelectorAll("[data-node-id]").length, 3);
  assert.match(win.document.body.textContent!, /未保存草稿/); assert.equal(win.document.body.textContent!.includes("已核对保存版本 7"), false);
});
