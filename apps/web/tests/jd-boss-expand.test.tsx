import assert from "node:assert/strict";
import test from "node:test";
import { planBossDescriptionExpansion } from "../server/jd-boss-expand";
import { NativeDomSnapshotError, NATIVE_SNAPSHOT_STYLES, projectNativeDomSnapshot } from "../server/jd-cdp-dom-snapshot";

const source = "https://m.zhipin.com/mpa/html/weijd/weijd-job/originalJob?fromSource=2";
const frame = { id: "owned-main-frame", url: source };
type Rect = [number, number, number, number];
const labelBounds: Rect = [60, 730, 112, 40];
const description = "岗位职责：负责设备通信平台和业务系统开发，维护技术文档，完善交付及自动化测试。任职要求：熟悉C#和SQL，具备独立分析与解决问题的能力。";

/** Protocol-shaped fixtures with document coordinates at 2x CSS scale. */
type Region = "outside-rec" | "inside-description" | "address" | "nested-rec" | "recommend" | "form" | "button";
function fixture(options: { wrapped?: boolean; region?: Region; innerWrapper?: boolean } = {}) {
  const strings: string[] = [];
  const str = (value: string) => { const found = strings.indexOf(value); if (found >= 0) return found; strings.push(value); return strings.length - 1; };
  const nodes = { nodeType: [] as number[], nodeName: [] as number[], parentIndex: [] as number[], nodeValue: [] as number[], backendNodeId: [] as number[], attributes: [] as number[][] };
  const layout = { nodeIndex: [] as number[], styles: [] as number[][], bounds: [] as Rect[], text: [] as number[], textColorOpacities: [] as number[], offsetRects: [] as (Rect | [])[], clientRects: [] as (Rect | [])[], scrollRects: [] as (Rect | [])[] };
  const textBoxes = { layoutIndex: [] as number[], bounds: [] as Rect[], start: [] as number[], length: [] as number[] };
  const defaults: Record<string, string> = { display: "block", visibility: "visible", opacity: "1", "content-visibility": "visible", "overflow-x": "visible", "overflow-y": "visible", "text-overflow": "clip", "-webkit-line-clamp": "none", clip: "auto", "clip-path": "none", transform: "none", filter: "none", "mask-image": "none", "-webkit-mask-image": "none", color: "rgb(0, 0, 0)" };
  const attrs = (node: number, value: Record<string, string>) => { nodes.attributes[node] = Object.entries(value).flatMap(([key, text]) => [str(key), str(text)]); };
  const add = (name: string, parent: number, options: { text?: string; attrs?: Record<string, string>; bounds?: Rect; styles?: Record<string, string>; noLayout?: boolean } = {}) => {
    const index = nodes.nodeType.length; const type = name === "#document" ? 9 : name === "#text" ? 3 : 1;
    nodes.nodeType.push(type); nodes.nodeName.push(str(name)); nodes.parentIndex.push(parent); nodes.nodeValue.push(type === 3 ? str(options.text ?? "") : -1); nodes.backendNodeId.push(100 + index); attrs(index, options.attrs ?? {});
    if (type !== 9 && !options.noLayout) {
      const bounds = options.bounds ?? [0, 0, 2000, 3000]; const at = layout.nodeIndex.length;
      layout.nodeIndex.push(index); layout.styles.push(type === 3 ? [] : NATIVE_SNAPSHOT_STYLES.map(name => str({ ...defaults, ...options.styles }[name]))); layout.bounds.push(bounds); layout.text.push(type === 3 ? str(options.text ?? "") : -1); layout.textColorOpacities.push(1);
      layout.offsetRects.push(type === 3 ? [] : [0, 0, bounds[2] / 2, bounds[3] / 2]); layout.clientRects.push(type === 3 ? [] : [0, 0, bounds[2] / 2, bounds[3] / 2]); layout.scrollRects.push(type === 3 ? [] : [0, 0, bounds[2] / 2, bounds[3] / 2]);
      if (type === 3 && options.text) { textBoxes.layoutIndex.push(at); textBoxes.bounds.push(bounds); textBoxes.start.push(0); textBoxes.length.push(options.text.length); }
    }
    return index;
  };
  const root = add("#document", -1), html = add("HTML", root), head = add("HEAD", html, { noLayout: true }), body = add("BODY", html);
  const share = add("DIV", body, { attrs: { class: "share-position" }, bounds: [0, 100, 2000, 2700] });
  const rec = add("DIV", share, { attrs: { class: "rec-detail" }, bounds: [40, 400, 1800, 2300] });
  const candidate = add("DIV", rec, { attrs: { class: "detail-text show-switch four-lines", id: "original-description" }, bounds: [60, 500, 1760, 224], styles: { display: "flow-root", "overflow-x": "hidden", "overflow-y": "hidden", "-webkit-line-clamp": "4" } });
  const descriptionText = add("#text", candidate, { text: description, bounds: [60, 500, 1760, 224] });
  const candidateAt = layout.nodeIndex.indexOf(candidate); layout.scrollRects[candidateAt] = [0, 0, 880, 1120];
  let controlParent = rec;
  if (options.region === "outside-rec") controlParent = share;
  else if (options.region === "inside-description") controlParent = options.innerWrapper ? add("DIV", candidate, { bounds: [60, 500, 1760, 224] }) : candidate;
  else if (options.region) controlParent = add(options.region === "form" ? "FORM" : options.region === "button" ? "BUTTON" : "DIV", rec, { bounds: [40, 400, 1800, 2300], attrs: { class: options.region === "nested-rec" ? "rec-detail" : options.region === "address" ? "address" : options.region === "recommend" ? "job-recommend-list" : "" } });
  const control = add("A", controlParent, { attrs: { class: "link-all" }, bounds: labelBounds });
  const span = options.wrapped ? add("SPAN", control, { bounds: labelBounds }) : undefined;
  const label = add("#text", span ?? control, { text: "查看全部", bounds: labelBounds });
  const doc = { frameId: str(frame.id), documentURL: str(source), title: str("原岗位工程师"), contentWidth: 2000, contentHeight: 3000, nodes, layout, textBoxes };
  const snapshot = { strings, documents: [doc] };
  const at = (node: number) => layout.nodeIndex.indexOf(node);
  const style = (node: number, name: string, value: string) => { layout.styles[at(node)][NATIVE_SNAPSHOT_STYLES.indexOf(name as typeof NATIVE_SNAPSHOT_STYLES[number])] = str(value); };
  const rename = (node: number, name: string) => { nodes.nodeName[node] = str(name); };
  const plan = () => planBossDescriptionExpansion(snapshot, frame, source);
  return { snapshot, nodes, layout, textBoxes, doc, strings, str, add, attrs, at, style, rename, html, head, body, share, rec, candidate, descriptionText, controlParent, control, span, label, plan };
}

/** Actual public structure/geometry observed in diagnostic 36, without its job text. */
function observedFoldFixture(wrapped = false, innerWrapper = false) {
  const f = fixture({ region: "inside-description", wrapped, innerWrapper });
  const geometry = (node: number, bounds: Rect, offset: Rect, client: Rect, scroll = client) => {
    const at = f.at(node); f.layout.bounds[at] = bounds; f.layout.offsetRects[at] = offset; f.layout.clientRects[at] = client; f.layout.scrollRects[at] = scroll;
  };
  f.doc.contentWidth = 2058; f.doc.contentHeight = 3540;
  geometry(f.html, [0, 0, 2028, 1654], [0, 0, 1014, 827], [0, 0, 1014, 827], [0, 0, 1029, 1770]);
  geometry(f.body, [0, 0, 2028, 3540.125], [0, 0, 1014, 1770], [0, 0, 1014, 1770], [0, 0, 1029, 1770]);
  geometry(f.share, [0, 252.4375, 2028, 3239.6875], [0, 126, 1014, 1620], [0, 0, 1014, 1620]);
  geometry(f.rec, [32, 1180.171875, 1964, 288], [0, 292, 982, 144], [0, 0, 982, 144]);
  const folded: Rect = [32, 1180.171875, 1964, 224];
  geometry(f.candidate, folded, [0, 292, 982, 112], [0, 0, 982, 112], [0, 0, 982, 1120]);
  if (innerWrapper) geometry(f.controlParent, folded, [0, 0, 982, 112], [0, 0, 982, 112]);
  f.layout.bounds[f.at(f.descriptionText)] = folded; f.textBoxes.bounds[f.textBoxes.layoutIndex.indexOf(f.at(f.descriptionText))] = folded;
  const control: Rect = [1869.59375, 1348.171875, 122.40625, 56];
  geometry(f.control, control, [919, 84, 61, 28], [0, 0, 61, 28]);
  if (f.span !== undefined) geometry(f.span, control, [0, 0, 61, 28], [0, 0, 61, 28]);
  const label: Rect = [1869.59375, 1359.171875, 122.40625, 33];
  f.layout.bounds[f.at(f.label)] = label; f.textBoxes.bounds[f.textBoxes.layoutIndex.indexOf(f.at(f.label))] = label;
  f.attrs(f.control, { class: "link-all", href: "javascript:;" });
  return f;
}

test("observed direct-child expand anchor inside the exact folded client box yields a normal plan", () => {
  for (const wrapped of [false, true]) {
    const f = observedFoldFixture(wrapped);
    assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, { readyState: "complete" }, { scope: "boss-share", sourceUrl: source }), (error: unknown) => error instanceof NativeDomSnapshotError && error.detail === "boss_description_collapsed");
    assert.equal(f.nodes.parentIndex[f.control], f.candidate);
    assert.equal(f.plan()?.controlBackendNodeId, 100 + f.control);
    assert.equal(f.plan()?.descriptionBackendNodeId, 100 + f.candidate);
    assert.ok(f.plan()?.hitBackendNodeIds.includes(100 + f.label));
    assert.ok(!f.plan()?.hitBackendNodeIds.includes(100 + f.candidate));
  }
  assert.equal(observedFoldFixture(false, true).plan(), undefined, "a nested wrapper is not the observed direct-child control relationship");
});

test("observed anchor only accepts its exact static empty-statement href, without normalizing other JS", () => {
  for (const href of ["javascript:void(0)", "javascript:alert(1)", "javascript:;alert(1)", "javascript: ;", "JAVASCRIPT:;", "javascript:;;", " javascript:;", "bosszp://job", "https://m.zhipin.com/other", "#other"]) {
    const f = observedFoldFixture(); f.attrs(f.control, { class: "link-all", href }); assert.equal(f.plan(), undefined, href);
  }
  const sibling = fixture(); sibling.attrs(sibling.control, { class: "link-all", href: "javascript:;" });
  assert.ok(sibling.plan(), "the exact observed noop does not invalidate the existing sibling layout");
});

test("observed fold exception rejects clipped labels, hidden controls and any different ancestor effects", () => {
  const cases: Array<(f: ReturnType<typeof observedFoldFixture>) => void> = [
    f => { f.layout.bounds[f.at(f.control)][1] += 8; },
    f => { f.layout.bounds[f.at(f.control)][1] += .25; },
    f => { f.layout.bounds[f.at(f.label)][1] += 40; f.textBoxes.bounds[f.textBoxes.layoutIndex.indexOf(f.at(f.label))][1] += 40; },
    f => { f.layout.clientRects[f.at(f.candidate)] = [0, 0, 982, 90]; },
    f => { f.layout.clientRects[f.at(f.candidate)] = [0, 0, 900, 112]; },
    f => f.attrs(f.control, { class: "link-all", href: "javascript:;", hidden: "" }),
    f => f.attrs(f.candidate, { class: "detail-text show-switch four-lines", inert: "" }),
    f => f.style(f.control, "opacity", "0.5"),
    f => f.style(f.candidate, "opacity", "0.5"),
    f => f.style(f.candidate, "clip-path", "inset(0)"),
    f => f.style(f.candidate, "transform", "matrix(1,0,0,1,1,0)"),
    f => f.style(f.rec, "overflow-y", "hidden"),
    f => f.style(f.candidate, "-webkit-line-clamp", "3"),
    f => { f.textBoxes.length[f.textBoxes.layoutIndex.indexOf(f.at(f.label))] = 3; },
  ];
  for (const mutate of cases) { const f = observedFoldFixture(); mutate(f); assert.equal(f.plan(), undefined); }
});

test("one source-bound folded description yields only the exact associated normal link and hit descendants", () => {
  const f = fixture();
  assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, { readyState: "complete" }, { scope: "boss-share", sourceUrl: source }), (error: unknown) => error instanceof NativeDomSnapshotError && error.detail === "boss_description_collapsed");
  assert.deepEqual(f.plan(), { controlBackendNodeId: 100 + f.control, descriptionBackendNodeId: 100 + f.candidate, hitBackendNodeIds: [100 + f.control, 100 + f.label] });
  const serialized = JSON.stringify(f.plan());
  assert.doesNotMatch(serialized, /岗位职责|任职要求|查看全部|730|originalJob/);
  // An unrelated identical label (including a different anchor) is not an index-based selector.
  const other = f.add("A", f.share, { bounds: [300, 730, 112, 40] }); f.add("#text", other, { text: "查看全部", bounds: [300, 730, 112, 40] });
  assert.equal(f.plan()?.controlBackendNodeId, 100 + f.control);
});

test("ordinary inline descendants and complete split text ranges remain associated to the same anchor", () => {
  const f = fixture({ wrapped: true }); const span = f.span!;
  // Inline clientWidth is often zero; the positive offset and document bounds establish geometry.
  f.layout.clientRects[f.at(f.control)] = [0, 0, 0, 0];
  const box = f.textBoxes.layoutIndex.indexOf(f.at(f.label)); f.textBoxes.length[box] = 2;
  f.textBoxes.layoutIndex.push(f.at(f.label)); f.textBoxes.bounds.push(labelBounds); f.textBoxes.start.push(2); f.textBoxes.length.push(2);
  assert.equal(f.plan()?.controlBackendNodeId, 100 + f.control);
  assert.deepEqual(f.plan()?.hitBackendNodeIds, [100 + f.control, 100 + span, 100 + f.label]);
  assert.ok(!f.plan()?.hitBackendNodeIds.includes(100 + f.rec));
});

test("expanded, differently folded and malformed documents never produce an expansion plan", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.attrs(f.candidate, { class: "detail-text show-switch" }); f.style(f.candidate, "-webkit-line-clamp", "none"); f.style(f.candidate, "overflow-x", "visible"); f.style(f.candidate, "overflow-y", "visible"); },
    (f: ReturnType<typeof fixture>) => f.style(f.candidate, "-webkit-line-clamp", "3"),
    (f: ReturnType<typeof fixture>) => f.attrs(f.candidate, { class: "detail-text four-lines" }),
    (f: ReturnType<typeof fixture>) => { f.nodes.backendNodeId[f.label] = f.nodes.backendNodeId[f.control]; },
    (f: ReturnType<typeof fixture>) => { f.doc.documentURL = f.str(source.replace("originalJob", "differentJob")); },
  ]) { const f = fixture(); mutate(f); assert.equal(f.plan(), undefined); }
  for (const raw of [undefined, null, {}, [], { strings: [], documents: [] }]) assert.equal(planBossDescriptionExpansion(raw, frame, source), undefined);
});

test("source identity, frame, conflicting canonical and full-page gates stop the plan", () => {
  const f = fixture();
  for (const original of [source.replace("originalJob", "differentJob"), source.replace("https:", "http:"), source.replace("m.zhipin.com", "outside.invalid"), ""]) assert.equal(planBossDescriptionExpansion(f.snapshot, frame, original), undefined);
  assert.equal(planBossDescriptionExpansion(f.snapshot, { ...frame, id: "another-frame" }, source), undefined);
  const canonical = f.add("LINK", f.head, { noLayout: true, attrs: { rel: "canonical", href: source.replace("originalJob", "differentJob") } });
  assert.equal(f.plan(), undefined);
  f.attrs(canonical, { rel: "canonical", href: source.replace("fromSource=2", "fromSource=other") }); assert.ok(f.plan());
  for (const text of ["请完成安全验证", "请先登录"]) {
    const gate = fixture(); const dialog = gate.add("DIV", gate.body, { attrs: { role: "dialog" } }); gate.add("#text", dialog, { text }); assert.equal(gate.plan(), undefined);
  }
  for (const title of ["安全验证", "登录 | BOSS直聘"]) { const gate = fixture(); gate.doc.title = gate.str(title); assert.equal(gate.plan(), undefined); }
});

test("duplicate matching controls or descriptions are ambiguous even if a control is hidden", () => {
  for (const hidden of [false, true]) {
    const f = fixture(); const duplicate = f.add("A", f.rec, { attrs: { class: "link-all", ...(hidden ? { hidden: "" } : {}) }, bounds: labelBounds }); f.add("#text", duplicate, { text: "查看全部", bounds: labelBounds }); assert.equal(f.plan(), undefined);
  }
  const f = fixture(); const extra = f.add("DIV", f.rec, { attrs: { class: "detail-text" }, bounds: [60, 1000, 1760, 100] }); f.add("#text", extra, { text: description, bounds: [60, 1000, 1760, 100] }); assert.equal(f.plan(), undefined);
});

test("similar labels and controls in other regions are never substituted", () => {
  for (const label of ["打开APP", "查看全部职位", "查 看全部", "查看全部\n打开APP"]) { const f = fixture(); f.layout.text[f.at(f.label)] = f.str(label); f.nodes.nodeValue[f.label] = f.str(label); f.textBoxes.length[f.textBoxes.layoutIndex.indexOf(f.at(f.label))] = label.length; assert.equal(f.plan(), undefined); }
  for (const mode of ["outside-rec", "inside-description", "address", "nested-rec", "recommend", "form", "button"] as const) {
    const f = fixture({ region: mode });
    assert.equal(f.plan(), undefined, mode);
  }
});

test("navigation, inline handlers, disabled/editable controls and hidden ancestors are rejected", () => {
  for (const attrs of [
    { href: "https://m.zhipin.com/" }, { href: "javascript:void(0)" }, { href: "bosszp://job" }, { href: "#description" },
    { target: "_blank" }, { download: "" }, { ping: "https://outside.invalid" }, { onclick: "expand()" }, { onpointerdown: "expand()" },
    { disabled: "" }, { inert: "" }, { hidden: "" }, { contenteditable: "false" }, { "aria-disabled": "true" }, { "aria-hidden": "true" }, { "aria-busy": "true" },
    { "aria-label": "打开APP" }, { title: "登录查看" }, { role: "menuitem" }, { "aria-controls": "other-description" },
  ]) { const f = fixture(); f.attrs(f.control, { class: "link-all", ...attrs }); assert.equal(f.plan(), undefined, JSON.stringify(attrs)); }
  for (const href of [undefined, "", "#"]) { const f = fixture(); f.attrs(f.control, { class: "link-all", ...(href === undefined ? {} : { href }), "aria-controls": "original-description" }); assert.ok(f.plan()); }
  const ancestor = fixture(); ancestor.attrs(ancestor.rec, { class: "rec-detail", inert: "" }); assert.equal(ancestor.plan(), undefined);
  for (const attrs of [{ role: "button" }, { role: "link" }, { onclick: "navigate()" }]) { const f = fixture(); f.attrs(f.rec, { class: "rec-detail", ...attrs }); assert.equal(f.plan(), undefined); }
  for (const attrs of [{ role: "button" }, { tabindex: "0" }, { onclick: "navigate()" }, { "aria-hidden": "true" }]) { const f = fixture({ wrapped: true }); f.attrs(f.span!, attrs); assert.equal(f.plan(), undefined); }
});

test("control, descendants and ancestors require supported opaque unclipped geometry", () => {
  for (const nodeName of ["control", "rec", "share", "body", "html"] as const) {
    for (const [name, value] of [["opacity", "0.5"], ["visibility", "hidden"], ["content-visibility", "auto"], ["overflow-x", "hidden"], ["overflow-y", "auto"], ["text-overflow", "ellipsis"], ["-webkit-line-clamp", "2"], ["clip", "rect(0, 1px, 1px, 0)"], ["clip-path", "inset(0)"], ["transform", "matrix(1, 0, 0, 1, 0, 0)"], ["filter", "blur(0)"], ["mask-image", "url(mask)"], ["color", "rgba(0, 0, 0, 0.5)"]]) {
      const f = fixture(); f.style(f[nodeName], name, value); assert.equal(f.plan(), undefined, `${nodeName}:${name}`);
    }
  }
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.layout.textColorOpacities[f.at(f.label)] = .5; },
    (f: ReturnType<typeof fixture>) => { f.layout.offsetRects[f.at(f.control)] = []; },
    (f: ReturnType<typeof fixture>) => { f.layout.bounds[f.at(f.control)] = [60, 730, 0, 40]; },
    (f: ReturnType<typeof fixture>) => { f.layout.offsetRects[f.at(f.control)] = [0, 0, 112, 20]; },
    (f: ReturnType<typeof fixture>) => { f.layout.bounds[f.at(f.control)] = [1900, 730, 112, 40]; },
    (f: ReturnType<typeof fixture>) => { f.layout.scrollRects[f.at(f.control)] = [0, 1, 56, 20]; },
    (f: ReturnType<typeof fixture>) => { f.doc.contentHeight = 700; },
    (f: ReturnType<typeof fixture>) => { const at = f.at(f.control); for (const key of ["nodeIndex", "styles", "bounds", "text", "textColorOpacities", "offsetRects", "clientRects", "scrollRects"] as const) (f.layout[key] as unknown[]).push(f.layout[key][at]); },
  ]) { const f = fixture(); mutate(f); assert.equal(f.plan(), undefined); }
});

test("meaningful or whitespace text range gaps, generated text and special descendants stop expansion", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.textBoxes.length[f.textBoxes.layoutIndex.indexOf(f.at(f.label))] = 3; },
    (f: ReturnType<typeof fixture>) => { f.layout.text[f.at(f.label)] = f.str("查 看全部"); f.textBoxes.length[f.textBoxes.layoutIndex.indexOf(f.at(f.label))] = 1; f.textBoxes.layoutIndex.push(f.at(f.label)); f.textBoxes.bounds.push(labelBounds); f.textBoxes.start.push(2); f.textBoxes.length.push(3); },
    (f: ReturnType<typeof fixture>) => { f.textBoxes.bounds[f.textBoxes.layoutIndex.indexOf(f.at(f.label))] = [60, 730, 1200, 40]; },
    (f: ReturnType<typeof fixture>) => { f.layout.text[f.at(f.control)] = f.str("GENERATED"); },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.nodes, { pseudoType: { index: [f.label], value: [f.str("after")] } }); },
    (f: ReturnType<typeof fixture>) => { f.rename(f.label, "INPUT"); f.nodes.nodeType[f.label] = 1; },
  ]) { const f = fixture(); mutate(f); assert.equal(f.plan(), undefined); }
});
