import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Window } from "happy-dom";
registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context); } });
const dom = new Window({ url: "http://career-trust-panel.synthetic.invalid" });
const React = await import("react");
const globals = { React, window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true };
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const { CareerTrustPanel } = await import("../src/components/CareerTrustPanel.tsx");
const digest = "e".repeat(64), model = { model: "synthetic-local", modelDigest: digest }, h = "a".repeat(64), expiry = new Date(Date.now() + 60_000).toISOString(), token = "A".repeat(43);
let root: ReturnType<typeof createRoot> | undefined;
after(async () => { if (root) await React.act(async () => root!.unmount()); dom.happyDOM.abort(); });
async function flush(action: () => void = () => {}) { await React.act(async () => { action(); await nextTurn(); await nextTurn(); }); }
async function mount(request: (route: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>, contextId = "context-1") { if (root) await flush(() => root!.unmount()); dom.document.body.innerHTML = '<main id="fixture"></main>'; root = createRoot(dom.document.getElementById("fixture")! as unknown as HTMLElement); await flush(() => root!.render(React.createElement(CareerTrustPanel, { contextId, runtime: model, request }))); }
function button(text: string) { const found = [...dom.document.querySelectorAll("button")].find(item => item.textContent?.trim() === text); assert.ok(found, `button ${text} exists`); return found as unknown as HTMLButtonElement; }
function input(label: string) { const found = [...dom.document.querySelectorAll("label")].find(item => item.textContent?.startsWith(label))?.querySelector("input,select,textarea"); assert.ok(found, `field ${label} exists`); return found as unknown as HTMLInputElement; }
async function click(text: string) { await flush(() => button(text).click()); }
async function check(label: string) { await flush(() => input(label).click()); }
async function type(label: string, value: string) { await flush(() => { const field = input(label); const proto = field.tagName === "SELECT" ? dom.HTMLSelectElement.prototype : field.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value); field.dispatchEvent(new dom.Event(field.tagName === "SELECT" ? "change" : "input", { bubbles: true }) as unknown as Event); }); }
const fact = { id: "fact-1", revision: "v1", status: "verified", disclosure: "publishable", statement: "可公开的合成 CAS 实践", limitations: "本人明确自述，不是独立认证。" };
const capsule = { id: "capsule-1", hash: h, displayName: "合成候选人", workspaceRevision: 3, selectedFields: ["statement", "limitations"], facts: [{ id: "fact-1", revision: "v1", verificationReceiptHash: h, fields: { statement: "预览中的精确公开摘要", limitations: "仅限合成引用范围。" } }], expiresAt: expiry, limitations: ["已下载副本无法收回。"] };
const localBinding = { id: "local", version: "v1", location: "local", endpointFingerprint: h, model: model.model, modelDigest: digest }, cloudBinding = { id: "cloud", version: "v1", location: "cloud", recipientOrigin: "https://synthetic-cloud.invalid", endpointFingerprint: h, model: "synthetic-frontier" }, budget = { revision: 1, maxLocalCalls: 3, maxCloudCalls: 1, maxInputBytes: 100_000, maxOutputBytes: 16_000, maxActiveMs: 5000 };
const metadata = (cloud = true) => ({ taskRevision: 7, sourceSnapshotHash: h, allowedFields: ["evidence"], budget, runtime: { local: localBinding, ...(cloud ? { cloud: cloudBinding } : {}) }, localRuntimeFingerprint: h, recipientFingerprint: h, cloudAvailable: cloud, localOnlySourceCount: 2 });
const prepared = (cloud = true) => ({ operationId: "privacy-1", draft: { id: "draft-1", hash: h, fields: [{ name: "evidence", text: "只允许发送这一句合成摘要。", sourceIds: ["fact-1"] }], requestedFields: ["evidence"], expiresAt: expiry, sources: [{ id: "fact-1", revision: "v1", hash: h }], repairs: [], redactions: [] }, runtime: metadata(cloud).runtime, recipientFingerprint: h, localRuntimeFingerprint: h, budget, cloudAvailable: cloud });

test("trust publication requires selected eligible facts, exact preview, separate publication and read/ask capability consent", async () => {
  const calls: { route: string; body: any }[] = [];
  await mount(async (route, body) => { calls.push({ route, body }); if (route === "/publication/list") return { revision: 3, facts: [fact, { ...fact, id: "private", disclosure: "local_only", statement: "不允许公开的资料" }] }; if (route === "/twin/preview") return { id: "preview-1", capsule, previewHash: h, expiresAt: expiry, redactions: [] }; if (route === "/twin/publish") return capsule; if (route === "/twin/token-issue") return { token, tokenId: h, expiresAt: expiry, scopes: ["capsule:read", "capsule:ask"], maxCalls: 50, capabilityUrl: `http://127.0.0.1:9999/api/v1/agent/career-studio/public/tag/twin/capsule-1#access_token=${token}` }; if (route === "/twin/token-revoke") return { revoked: true }; throw Error("unexpected route"); });
  assert.equal(calls.length, 0); await click("刷新可公开事实"); assert.equal(dom.document.body.textContent?.includes("不允许公开的资料"), false); assert.equal(button("生成公开字段预览").disabled, true);
  await check("可公开的合成 CAS 实践"); await type("公开显示名称", "合成候选人"); await click("生成公开字段预览"); assert.equal(calls.some(call => call.route === "/twin/publish"), false); assert.match(dom.document.body.textContent!, /预览中的精确公开摘要/); assert.equal(button("明确发布此快照").disabled, true);
  await check("我确认只发布上述冻结字段"); await click("明确发布此快照"); assert.equal(calls.find(call => call.route === "/twin/publish")!.body.expectedPreviewHash, h); assert.equal(button("签发只读链接").disabled, true);
  await check("除只读外，另外允许"); await check("我确认向持有访问令牌"); await click("签发只读链接"); assert.deepEqual(calls.find(call => call.route === "/twin/token-issue")!.body.scopes, ["capsule:read", "capsule:ask"]); const link = dom.document.querySelector('.ctr-link a')! as unknown as HTMLAnchorElement; assert.ok(link.href.includes("#access_token=")); assert.equal(link.rel, "noreferrer noopener"); assert.match(dom.document.body.textContent!, /在本机编码，未调用外部二维码服务/); const qr = dom.document.querySelector("img[alt=只读胶囊访问二维码]")!; assert.match(qr.getAttribute("src")!, /^data:image\/svg\+xml/); const svg = decodeURIComponent(qr.getAttribute("src")!.split(",")[1]!); assert.match(svg, /<svg/); assert.match(svg, /<path/); assert.equal(svg.includes(token), false);
  await click("撤销此访问权限"); assert.equal(dom.document.querySelector('.ctr-link a'), null);
});

test("trust MCP empty host configuration cannot claim a usable connection or expose a JSON command editor", async () => {
  await mount(async route => { assert.equal(route, "/mcp-client/servers"); return { servers: [], warning: "No configured servers." }; }); await click("MCP 连接"); await click("读取已配置服务器"); assert.match(dom.document.body.textContent!, /当前没有 Host 已审查的 MCP 服务器/); assert.equal([...dom.document.querySelectorAll("button")].some(item => item.textContent === "确认清单并连接"), false);
});

test("trust persisted capsules reload without fact regeneration and retain readonly token/revocation management", async () => {
  const calls: { route: string; body: any }[] = [];
  await mount(async (route, body) => { calls.push({ route, body }); if (route === "/capsules/list") return { capsules: [{ ownerId: "owner-1", capsule }, { ownerId: "owner-1", capsule: { ...capsule, id: "old-revoked" }, revokedAt: new Date().toISOString() }] }; if (route === "/twin/token-issue") return { token, tokenId: h, expiresAt: expiry, scopes: ["capsule:read"], maxCalls: 50, capabilityUrl: `http://127.0.0.1:9999/public/twin/capsule-1#access_token=${token}` }; if (route === "/twin/revoke") return { revoked: true }; throw Error(route); });
  await click("刷新已发布胶囊"); assert.deepEqual(calls.map(call => call.route), ["/capsules/list"]); assert.match(dom.document.body.textContent!, /预览中的精确公开摘要/);
  await check("我确认向持有访问令牌"); await click("签发只读链接"); assert.deepEqual(calls.find(call => call.route === "/twin/token-issue")!.body.scopes, ["capsule:read"]);
  await check("撤销当前胶囊的所有线上访问"); await click("撤销当前胶囊"); assert.deepEqual(calls.find(call => call.route === "/twin/revoke")!.body, { capsuleId: "capsule-1", expectedHash: h }); assert.equal(button("签发只读链接").disabled, true);
  await type("管理已发布胶囊", "old-revoked"); assert.equal(button("签发只读链接").disabled, true); assert.match(dom.document.body.textContent!, /此胶囊已撤销/);
});

test("trust MCP uses ordinary typed tool forms and two exact approvals, then prevents replay", async () => {
  const calls: { route: string; body: any }[] = [], schema = { type: "object", properties: { topic: { type: "string", description: "合成主题" } }, required: ["topic"] };
  await mount(async (route, body) => { calls.push({ route, body }); if (route === "/mcp-client/servers") return { servers: [{ id: "server-1", label: "已审查合成服务", transport: "streamable-http", endpoint: "https://synthetic-mcp.invalid/mcp", allowedTools: ["public_evidence"], allowedResources: [] }], warning: "untrusted" }; if (route === "/mcp-client/manifest-preview") return { previewId: "manifest-1", manifest: { id: "server-1", version: "v1", transport: { kind: "streamable-http", endpoint: "https://synthetic-mcp.invalid/mcp" }, allowedTools: ["public_evidence"], allowedResources: [], maxInputBytes: 16000, maxOutputBytes: 16000, maxActiveMs: 5000 }, manifestHash: h, expiresAt: expiry, warning: "untrusted" }; if (route === "/mcp-client/connect") return { connectionId: "connection-1", manifestHash: h, toolsetHash: h, tools: [{ name: "public_evidence", description: "只读合成资料", inputSchema: schema }], selectedResources: [], expiresAt: expiry, remainingCalls: 10, trust: "untrusted_external_data", warning: "untrusted" }; if (route === "/mcp-client/call-preview") return { previewId: "call-1", connectionId: "connection-1", kind: "tool", name: "public_evidence", args: { topic: "CAS" }, inputHash: h, toolsetHash: h, manifestHash: h, expiresAt: expiry, warning: "untrusted" }; if (route === "/mcp-client/call") return { callId: "call-1", adopted: false, result: { trust: "untrusted_external_data", manifestHash: h, toolsetHash: h, operationId: "call-1", data: { content: [{ type: "text", text: "来自远程工具的合成证据。" }] } } }; throw Error(route); });
  await click("MCP 连接"); await click("读取已配置服务器"); await type("1 · 选择已审查服务器", "server-1"); await check("工具：public_evidence"); await click("预览服务器权限清单"); assert.equal(calls.some(call => call.route === "/mcp-client/connect"), false); assert.equal(button("确认清单并连接").disabled, true); await check("同意连接此精确清单"); await click("确认清单并连接"); await type("已批准工具", "public_evidence"); assert.equal(button("预览一次精确调用").disabled, true); await type("topic（必填）", "CAS"); await click("预览一次精确调用"); assert.deepEqual(calls.find(call => call.route === "/mcp-client/call-preview")!.body.args, { topic: "CAS" }); assert.equal(calls.some(call => call.route === "/mcp-client/call"), false); await check("仅派送上述调用一次"); await click("确认并调用一次"); assert.match(dom.document.body.textContent!, /来自远程工具的合成证据/); assert.equal(button("确认并调用一次").disabled, true); assert.equal(calls.filter(call => call.route === "/mcp-client/call").length, 1); assert.equal(dom.document.querySelector('#ctr-mcp-panel textarea'), null);
});

test("trust privacy no-cloud mode generates local draft but disables approval and dispatch", async () => {
  const calls: string[] = [];
  await mount(async route => { calls.push(route); if (route === "/privacy/context") return metadata(false); if (route === "/privacy/prepare") return prepared(false); throw Error(route); });
  await click("隐私流水线"); await click("检查隐私与模型配置"); await check("工程证据摘要"); await click("仅本地生成披露草稿"); assert.match(dom.document.body.textContent!, /云端未配置/); assert.match(dom.document.body.textContent!, /只允许发送这一句合成摘要/); assert.equal(button("批准此精确披露草稿").disabled, true); assert.deepEqual(calls, ["/privacy/context", "/privacy/prepare"]);
});

test("trust privacy requires per-field review, a separate send consent and unknown-state readback before any retry", async () => {
  const calls: { route: string; body: any }[] = [];
  await mount(async (route, body) => { calls.push({ route, body }); if (route === "/privacy/context") return metadata(); if (route === "/privacy/prepare") return prepared(); if (route === "/privacy/approve") return { operationId: "privacy-1", approval: { id: "approval-1", draftHash: h, recipientFingerprint: h, budgetHash: h, approvedFields: ["evidence"] } }; if (route === "/privacy/dispatch") throw Error("synthetic disconnected unknown"); if (route === "/privacy/read") return { continuation: "unknown_dispatch_no_replay", cloudAvailable: true, operation: { id: "privacy-1", phase: "stopped", dispatchClaim: { status: "unknown" } } }; throw Error(route); });
  await click("隐私流水线"); await click("检查隐私与模型配置"); await check("工程证据摘要"); await click("仅本地生成披露草稿"); assert.equal(calls.find(call => call.route === "/privacy/prepare")!.body.expectedTaskRevision, 7); assert.equal(button("批准此精确披露草稿").disabled, true); await check("我已核对“工程证据摘要”"); await click("批准此精确披露草稿"); assert.equal(button("发送已批准摘要一次").disabled, true); await check("现在向上述固定接收方发送一次"); await click("发送已批准摘要一次"); assert.equal(button("发送已批准摘要一次").disabled, true); await click("查询派送与未知状态"); assert.match(dom.document.body.textContent!, /外部派送结果未知，禁止自动重试/); assert.equal(calls.filter(call => call.route === "/privacy/dispatch").length, 1);
});

test("trust unknown protocol and invalid runtime never produce successful availability claims", async () => {
  await mount(async () => ({ cloudAvailable: true })); await click("隐私流水线"); await click("检查隐私与模型配置"); assert.match(dom.document.body.textContent!, /响应不符合协议/); assert.equal([...dom.document.querySelectorAll("button")].some(item => item.textContent === "仅本地生成披露草稿"), false);
});

test("trust context change aborts in-flight work and suppresses a late private draft", async () => {
  let resolve!: (value: unknown) => void, signal: AbortSignal | undefined;
  const request = async (route: string, _body?: unknown, inputSignal?: AbortSignal) => { if (route === "/privacy/context") return metadata(); if (route === "/privacy/prepare") { signal = inputSignal; return new Promise<unknown>(done => { resolve = done; }); } throw Error(route); };
  await mount(request); await click("隐私流水线"); await click("检查隐私与模型配置"); await check("工程证据摘要"); await click("仅本地生成披露草稿"); await flush(() => root!.render(React.createElement(CareerTrustPanel, { contextId: "different-context", runtime: model, request }))); assert.equal(signal?.aborted, true); await flush(() => resolve(prepared())); assert.equal(dom.document.body.textContent?.includes("只允许发送这一句合成摘要"), false);
});

test("trust tabs provide keyboard arrows, roving focus and matching panel semantics", async () => {
  await mount(async () => { throw Error("no automatic request"); });
  const first = dom.document.getElementById("ctr-publication-tab")!;
  await flush(() => first.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  assert.equal(dom.document.getElementById("ctr-mcp-tab")!.getAttribute("aria-selected"), "true");
  assert.equal(dom.document.getElementById("ctr-mcp-tab")!.getAttribute("tabindex"), "0");
  assert.equal(dom.document.activeElement?.id, "ctr-mcp-tab");
  assert.equal(dom.document.getElementById("ctr-mcp-panel")!.hasAttribute("hidden"), false);
  await flush(() => dom.document.getElementById("ctr-mcp-tab")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "End", bubbles: true })));
  assert.equal(dom.document.getElementById("ctr-privacy-tab")!.getAttribute("aria-selected"), "true");
});

const diagramSource = { id: "resume-1", revision: 2, hash: h, title: "合成设计 · 非生产", nodes: [{ id: "private-node-1", label: "InternalFixture API" }, { id: "private-node-2", label: "SQLite" }],
  edges: [{ id: "private-edge-1", from: "private-node-1", to: "private-node-2", label: "设计写入" }] };
const diagramCatalog = { source: diagramSource, publications: [{ id: "fact-1", hash: h, statement: fact.statement }], limitations: ["只有明确保存的本次白板。"] };
const diagramPreview = { previewId: "diagram-preview-1", previewHash: h, expiresAt: expiry, source: { id: diagramSource.id, revision: 2, hash: h },
  publicContent: { design: "已审阅设计声明，不证明实现。", limitations: "未上线，作者归属未知。", diagram: { nodes: [{ id: "node-1", label: "[内部名称] API" }, { id: "node-2", label: "SQLite" }], edges: [{ from: "node-1", to: "node-2", label: "" }] } }, redactions: [{ category: "private_term", count: 1 }] };

test("public diagram needs exact saved source, explicit node/edge fields, preview and separate confirmation; it never publishes", async () => {
  const calls: { route: string; body: any }[] = [];
  await mount(async (route, body) => { calls.push({ route, body });
    if (route === "/architecture/publication/catalog") return diagramCatalog;
    if (route === "/architecture/publication/preview") return diagramPreview;
    if (route === "/architecture/publication/confirm") return { publication: { id: "derived-1", hash: h, revision: 1 }, adopted: false, published: false };
    if (route === "/publication/list") return { revision: 4, facts: [fact] };
    throw Error(route);
  });
  assert.equal(calls.length, 0); await click("读取本次可公开图示与关联陈述");
  assert.equal(button("预览所选图示的公开字段").disabled, true); assert.equal(input("连线：").disabled, true);
  await type("关联本次已审阅陈述", "fact-1"); await check("节点：InternalFixture API"); await check("节点：SQLite"); await check("连线：");
  await type("图示需脱敏的内部名称", "InternalFixture"); await click("预览所选图示的公开字段");
  const prepared = calls.find(call => call.route === "/architecture/publication/preview")!.body;
  assert.deepEqual(prepared.source, { id: diagramSource.id, revision: 2, hash: h }); assert.equal(prepared.expectedPublicationHash, h);
  assert.deepEqual(prepared.nodeIds, ["private-node-1", "private-node-2"]); assert.deepEqual(prepared.edgeIds, ["private-edge-1"]);
  assert.deepEqual(prepared.fields, ["node.label"]); assert.deepEqual(prepared.privateTerms, ["InternalFixture"]);
  assert.match(dom.document.body.textContent!, /\[内部名称\] API/); assert.equal(button("确认冻结这些公开图示字段").disabled, true);
  assert.equal(calls.some(call => call.route === "/architecture/publication/confirm"), false);
  await check("我已核对上述脱敏节点"); await click("确认冻结这些公开图示字段");
  const confirmed = calls.find(call => call.route === "/architecture/publication/confirm")!.body;
  assert.equal(confirmed.expectedPreviewHash, h); assert.equal(confirmed.confirmed, true); assert.equal(confirmed.contextId, "context-1");
  assert.match(dom.document.body.textContent!, /尚未公开或签发访问/); assert.equal(calls.some(call => call.route.startsWith("/twin/")), false);
  assert.equal(calls.filter(call => call.route === "/publication/list").length, 1);
});

test("changing public diagram selection invalidates approval and removes disconnected selected edges", async () => {
  const calls: { route: string; body: any }[] = [];
  await mount(async (route, body) => { calls.push({ route, body }); return route === "/architecture/publication/catalog" ? diagramCatalog : diagramPreview; });
  await click("读取本次可公开图示与关联陈述"); await type("关联本次已审阅陈述", "fact-1");
  await check("节点：InternalFixture API"); await check("节点：SQLite"); await check("连线："); await click("预览所选图示的公开字段");
  await check("我已核对上述脱敏节点"); await check("节点：SQLite");
  assert.equal([...dom.document.querySelectorAll("button")].some(item => item.textContent === "确认冻结这些公开图示字段"), false);
  assert.equal(input("连线：").disabled, true); assert.equal(input("连线：").checked, false);
  await click("预览所选图示的公开字段"); assert.deepEqual(calls.filter(call => call.route === "/architecture/publication/preview").at(-1)!.body.edgeIds, []);
});

test("missing saved diagram and mismatched preview source never become public diagram success", async () => {
  await mount(async () => ({ source: null, publications: [], limitations: [] })); await click("读取本次可公开图示与关联陈述");
  assert.match(dom.document.body.textContent!, /尚无已保存白板/); assert.equal([...dom.document.querySelectorAll("button")].some(item => item.textContent === "预览所选图示的公开字段"), false);
  await mount(async route => route === "/architecture/publication/catalog" ? diagramCatalog : { ...diagramPreview, source: { ...diagramPreview.source, revision: 3 } });
  await click("读取本次可公开图示与关联陈述"); await type("关联本次已审阅陈述", "fact-1"); await check("节点：SQLite"); await click("预览所选图示的公开字段");
  assert.equal([...dom.document.querySelectorAll("button")].some(item => item.textContent === "确认冻结这些公开图示字段"), false);
});

test("unknown diagram confirmation is not automatically replayed and context changes abort old private previews", async () => {
  let calls = 0;
  await mount(async route => { if (route === "/architecture/publication/catalog") return diagramCatalog; if (route === "/architecture/publication/preview") return diagramPreview; calls++; throw Error("unknown synthetic local response"); });
  await click("读取本次可公开图示与关联陈述"); await type("关联本次已审阅陈述", "fact-1"); await check("节点：SQLite"); await click("预览所选图示的公开字段");
  await check("我已核对上述脱敏节点"); await click("确认冻结这些公开图示字段"); assert.equal(calls, 1); assert.equal(button("确认冻结这些公开图示字段").disabled, true);
  let resolve!: (value: unknown) => void, signal: AbortSignal | undefined;
  const request = async (route: string, _body?: unknown, selectedSignal?: AbortSignal) => route === "/architecture/publication/catalog" ? diagramCatalog : new Promise(done => { resolve = done; signal = selectedSignal; });
  await mount(request); await click("读取本次可公开图示与关联陈述"); await type("关联本次已审阅陈述", "fact-1"); await check("节点：SQLite"); await click("预览所选图示的公开字段");
  await flush(() => root!.render(React.createElement(CareerTrustPanel, { contextId: "other-context", runtime: model, request })));
  assert.equal(signal?.aborted, true); await flush(() => resolve(diagramPreview)); assert.equal(dom.document.body.textContent?.includes("已审阅设计声明，不证明实现。"), false);
});
