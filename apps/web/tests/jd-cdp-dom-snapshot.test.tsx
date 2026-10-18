import assert from "node:assert/strict";
import test from "node:test";
import { NativeDomSnapshotError, NATIVE_SNAPSHOT_STYLES, NATIVE_ROOT_SCROLL_STYLES, NATIVE_LIEPIN_PARAGRAPH_STYLES, projectNativeDomSnapshot, type NativeDomSnapshotCode } from "../server/jd-cdp-dom-snapshot";
import { validateBrowserSnapshot } from "../server/jd-browser-snapshot";
import { extractPublicJobHtml } from "../server/jd-extractor";
import { isLiepinDescriptionHeading } from "../server/jd-liepin-description";
import { isObservedLiepinVerification } from "../server/jd-browser";

const source = "https://www.liepin.com/job/123456789.shtml";
const frame = { id: "main-frame", url: source };
const load = { readyState: "complete" } as const;
const description = "岗位职责：负责设备通信平台的设计开发、问题定位及交付，维护接口文档并完成自动化回归。任职要求：掌握 C#、SQL Server、异步编程与单元测试，能够独立分析需求并与产品团队协作。";
type Box = [number, number, number, number];
type Options = { text?: string; styles?: Record<string, string>; attrs?: Record<string, string>; bounds?: Box; hiddenLayout?: boolean };

/** Protocol-shaped synthetic data only; no browser or network is involved. */
function fixture() {
  const strings: string[] = [];
  const str = (value: string) => { const index = strings.indexOf(value); if (index >= 0) return index; strings.push(value); return strings.length - 1; };
  const nodes = { nodeType: [] as number[], parentIndex: [] as number[], nodeName: [] as number[], nodeValue: [] as number[], backendNodeId: [] as number[], attributes: [] as number[][] };
  const layout = { nodeIndex: [] as number[], styles: [] as number[][], bounds: [] as Box[], text: [] as number[], textColorOpacities: [] as number[] };
  const textBoxes = { layoutIndex: [] as number[], bounds: [] as Box[], start: [] as number[], length: [] as number[] };
  const defaults: Record<string, string> = { display: "block", visibility: "visible", opacity: "1", "content-visibility": "visible", "overflow-x": "visible", "overflow-y": "visible", "text-overflow": "clip", "-webkit-line-clamp": "none", clip: "auto", "clip-path": "none", transform: "none", filter: "none", "mask-image": "none", "-webkit-mask-image": "none", color: "rgb(0, 0, 0)" };
  const add = (name: string, parent: number, options: Options = {}) => {
    const index = nodes.nodeType.length; const type = name === "#document" ? 9 : name === "#text" ? 3 : 1;
    nodes.nodeType.push(type); nodes.parentIndex.push(parent); nodes.nodeName.push(str(name)); nodes.nodeValue.push(type === 3 ? str(options.text ?? "") : -1); nodes.backendNodeId.push(index + 1);
    nodes.attributes.push(Object.entries(options.attrs ?? {}).flatMap(([name, value]) => [str(name), str(value)]));
    if (!options.hiddenLayout && name !== "#document" && name !== "HEAD" && name !== "TITLE" && name !== "LINK" && name !== "SCRIPT") {
      const at = layout.nodeIndex.length; const bounds = options.bounds ?? [0, 0, 1000, 1000];
      layout.nodeIndex.push(index); layout.bounds.push(bounds); layout.text.push(type === 3 ? str(options.text ?? "") : -1);
      layout.styles.push(type === 3 ? [] : NATIVE_SNAPSHOT_STYLES.map(name => str({ ...defaults, ...options.styles }[name]))); layout.textColorOpacities.push(1);
      if (type === 3 && options.text?.length) { textBoxes.layoutIndex.push(at); textBoxes.bounds.push(bounds); textBoxes.start.push(0); textBoxes.length.push(options.text.length); }
    }
    return index;
  };
  const root = add("#document", -1); const html = add("HTML", root); const head = add("HEAD", html); const body = add("BODY", html);
  const doc = { frameId: str(frame.id), documentURL: str(source), title: str("设备软件工程师"), nodes, layout, textBoxes };
  const snapshot = { strings, documents: [doc] };
  const layoutIndex = (node: number) => layout.nodeIndex.indexOf(node);
  const style = (node: number, name: string, value: string) => { layout.styles[layoutIndex(node)][NATIVE_SNAPSHOT_STYLES.indexOf(name as typeof NATIVE_SNAPSHOT_STYLES[number])] = str(value); };
  const appendLayout = (node: number, options: { text?: string; styles?: Record<string, string>; bounds?: Box; opacity?: number } = {}) => {
    const first = layoutIndex(node);
    const at = layout.nodeIndex.length;
    const styles = [...layout.styles[first]];
    for (const [name, value] of Object.entries(options.styles ?? {})) styles[NATIVE_SNAPSHOT_STYLES.indexOf(name as typeof NATIVE_SNAPSHOT_STYLES[number])] = str(value);
    layout.nodeIndex.push(node); layout.styles.push(styles);
    layout.bounds.push(options.bounds ?? [...layout.bounds[first]] as Box);
    layout.text.push(options.text === undefined ? layout.text[first] : str(options.text));
    layout.textColorOpacities.push(options.opacity ?? layout.textColorOpacities[first]);
    return at;
  };
  const textBox = (at: number, start: number, length: number, bounds: Box = [0, 20, 1000, 20]) => {
    textBoxes.layoutIndex.push(at); textBoxes.bounds.push(bounds); textBoxes.start.push(start); textBoxes.length.push(length);
  };
  const paragraph = (text = description, parent = body, options: Options = {}) => { const block = add("DIV", parent, { attrs: { class: "job-intro-content" }, ...options }); const textNode = add("#text", block, { text }); return { block, textNode }; };
  return { snapshot, strings, str, add, nodes, layout, textBoxes, doc, html, head, body, paragraph, layoutIndex, style, appendLayout, textBox };
}
const fails = (code: NativeDomSnapshotCode) => (error: unknown) => error instanceof NativeDomSnapshotError && error.code === code && error.message === code && !error.cause;

const job51Source = "https://jobs.51job.com/shanghai/166509900.html";
const job51Frame = { id: frame.id, url: job51Source };
function job51Fixture(sourceUrl = job51Source) {
  const f = fixture();
  f.doc.documentURL = f.str(sourceUrl);
  f.paragraph(description, f.body, { attrs: { class: "job_msg" } });
  f.add("LINK", f.head, { attrs: { rel: "canonical", href: sourceUrl } });
  return f;
}

test("51JOB WAF emits only a fixed marker and gate ahead of clipped text without retaining challenge metadata", () => {
  for (const name of ["aliyun_waf", "aliyun_waf_token", "ALIYUN_WAF_PRIVATE_SUFFIX"]) {
    const f = job51Fixture();
    f.add("META", f.head, { attrs: { name, content: "PRIVATE_CHALLENGE_VALUE", "data-secret": "PRIVATE_ATTRIBUTE" }, hiddenLayout: true });
    f.style(f.body, "overflow-y", "hidden");
    const result = projectNativeDomSnapshot(f.snapshot, job51Frame, load, { detect51JobWaf: true });
    assert.equal(result.gate, "verification_required");
    assert.equal(result.html, '<html><head><meta name="aliyun_waf"></head><body></body></html>');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|岗位职责/);
    assert.throws(() => extractPublicJobHtml(result.html, "51JOB", job51Source, { requireVisibleDescription: true }));
  }
});

test("51JOB WAF detection is opt-in, official-source-bound and ignores body or inert-template lookalikes", () => {
  for (const name of ["aliyun_wafake", "xaliyun_waf_token", "aliyun_waf-token"]) {
    const f = job51Fixture(); f.add("META", f.head, { attrs: { name, content: "PRIVATE_VALUE" }, hiddenLayout: true });
    assert.equal(projectNativeDomSnapshot(f.snapshot, job51Frame, load, { detect51JobWaf: true }).gate, undefined);
  }
  for (const place of ["body", "template"] as const) {
    const f = job51Fixture(); const parent = place === "body" ? f.body : f.add("TEMPLATE", f.head, { hiddenLayout: true });
    f.add("META", parent, { attrs: { name: "aliyun_waf_token", content: "PRIVATE_VALUE" }, hiddenLayout: true });
    assert.equal(projectNativeDomSnapshot(f.snapshot, job51Frame, load, { detect51JobWaf: true }).gate, undefined);
  }
  const plain = job51Fixture(); plain.add("META", plain.head, { attrs: { name: "aliyun_waf_token", content: "PRIVATE_VALUE" }, hiddenLayout: true });
  assert.equal(projectNativeDomSnapshot(plain.snapshot, job51Frame, load).gate, undefined);
  const foreign = fixture(); foreign.paragraph(); foreign.add("META", foreign.head, { attrs: { name: "aliyun_waf_token", content: "PRIVATE_VALUE" }, hiddenLayout: true });
  assert.equal(projectNativeDomSnapshot(foreign.snapshot, frame, load, { detect51JobWaf: true }).gate, undefined);
});

test("51JOB uses generic visible projection with exact source metadata and rejects hidden duties and conflicting canonical", () => {
  for (const sourceUrl of [job51Source, "https://msearch.51job.com/jobs/all/166761768.html"]) {
    const f = job51Fixture(sourceUrl);
    const projected = projectNativeDomSnapshot(f.snapshot, { id: frame.id, url: sourceUrl }, load, { detect51JobWaf: true });
    const extracted = extractPublicJobHtml(projected.html, "51JOB", sourceUrl, { requireVisibleDescription: true });
    assert.ok(extracted.text.includes(description)); assert.equal(projected.gate, undefined);
  }
  const hidden = job51Fixture(); hidden.style(hidden.body, "display", "none");
  const absent = projectNativeDomSnapshot(hidden.snapshot, job51Frame, load, { detect51JobWaf: true });
  assert.doesNotMatch(absent.html, /岗位职责/);
  assert.throws(() => extractPublicJobHtml(absent.html, "51JOB", job51Source, { requireVisibleDescription: true }));
  const wrong = job51Fixture();
  const canonicalIndex = wrong.nodes.nodeName.findIndex(name => wrong.strings[name] === "LINK");
  wrong.nodes.attributes[canonicalIndex] = [wrong.str("rel"), wrong.str("canonical"), wrong.str("href"), wrong.str(job51Source.replace("166509900", "166509901"))];
  assert.throws(() => extractPublicJobHtml(projectNativeDomSnapshot(wrong.snapshot, job51Frame, load, { detect51JobWaf: true }).html, "51JOB", job51Source, { requireVisibleDescription: true }));
});

test("native projection produces the same public description through the existing extractor", () => {
  const f = fixture(); f.paragraph();
  const title = f.add("TITLE", f.head); f.add("#text", title, { text: "设备软件工程师", hiddenLayout: true });
  f.add("LINK", f.head, { attrs: { rel: "canonical", href: source } });
  const result = projectNativeDomSnapshot(f.snapshot, frame, load);
  assert.equal(result.pageLoad?.content, "visible_text");
  assert.equal(result.pageLoad?.readyState, "complete");
  assert.equal(validateBrowserSnapshot(result, { url: source, navigation: 1 }, { url: source, navigation: 1 }).state, "ready");
  const extracted = extractPublicJobHtml(result.html, "猎聘", source, { requireVisibleDescription: true });
  assert.ok(extracted.text.includes(description));
  assert.equal(extracted.title, "设备软件工程师");
});

test("only the identified main document contributes content or metadata", () => {
  const f = fixture(); f.paragraph();
  const other = fixture(); other.paragraph("CHILD_FRAME_SECRET"); other.doc.frameId = other.str("child-frame");
  // The child tables are irrelevant; frameId is the only child field the projection reads.
  f.snapshot.documents.push({ ...other.doc, frameId: f.str("child-frame"), nodes: null } as unknown as typeof f.doc);
  const result = projectNativeDomSnapshot(f.snapshot, frame, load);
  assert.ok(result.html.includes(description)); assert.ok(!result.html.includes("CHILD_FRAME_SECRET"));
  assert.throws(() => projectNativeDomSnapshot(f.snapshot, { ...frame, id: "different-frame" }, load), fails("main_document_count"));
  f.snapshot.documents.push(f.doc);
  assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load), fails("main_document_count"));
});

test("canonical and JSON-LD cannot manufacture visible description or conceal a conflicting source", () => {
  const f = fixture(); f.paragraph();
  f.add("LINK", f.head, { attrs: { rel: "CANONICAL", href: "https://www.liepin.com/job/987654321.shtml" } });
  const result = projectNativeDomSnapshot(f.snapshot, frame, load);
  assert.throws(() => extractPublicJobHtml(result.html, "猎聘", source, { requireVisibleDescription: true }));
  const empty = fixture();
  const script = empty.add("SCRIPT", empty.head, { attrs: { type: "application/ld+json" } });
  empty.add("#text", script, { text: JSON.stringify({ "@type": "JobPosting", description }), hiddenLayout: true });
  const onlyMetadata = projectNativeDomSnapshot(empty.snapshot, frame, load);
  assert.equal(onlyMetadata.pageLoad?.content, "empty");
  assert.throws(() => extractPublicJobHtml(onlyMetadata.html, "猎聘", source, { requireVisibleDescription: true }));
});

test("hidden ancestors, zero text opacity, recommendation ancestors and editable fields do not leak", () => {
  const f = fixture(); f.paragraph();
  for (const options of [
    { attrs: { hidden: "" } }, { attrs: { "aria-hidden": "true" } }, { styles: { display: "none" } },
    { styles: { visibility: "hidden" } }, { styles: { opacity: "0" } }, { styles: { "content-visibility": "hidden" } },
    { attrs: { class: "card job-recommend-list" } },
  ]) { const parent = f.add("DIV", f.body, options); f.paragraph("HIDDEN_SECRET", parent); }
  for (const tag of ["FORM", "TEXTAREA", "INPUT", "SELECT", "IFRAME", "ASIDE", "FOOTER"]) {
    const parent = f.add(tag, f.body, { attrs: { value: "ATTRIBUTE_SECRET" } }); f.add("#text", parent, { text: "FIELD_SECRET" });
  }
  const transparent = f.paragraph("ALPHA_SECRET"); f.layout.textColorOpacities[f.layoutIndex(transparent.textNode)] = 0;
  const color = f.paragraph("COLOR_SECRET"); f.style(color.block, "color", "rgba(1, 2, 3, 0)");
  Object.assign(f.nodes, { inputValue: { index: [1], value: [f.str("INPUT_VALUE_SECRET")] }, textValue: { index: [2], value: [f.str("TEXT_VALUE_SECRET")] } });
  const result = projectNativeDomSnapshot(f.snapshot, frame, load);
  assert.ok(result.html.includes(description)); assert.doesNotMatch(result.html, /SECRET/);
});

test("display:contents ancestors retain structure without inventing a layout box", () => {
  const f = fixture(); const parent = f.add("DIV", f.body, { attrs: { class: "job-intro-content" }, hiddenLayout: true });
  f.add("#text", parent, { text: description });
  const result = projectNativeDomSnapshot(f.snapshot, frame, load);
  assert.ok(result.html.includes(`<div class="job-intro-content">${description}</div>`));
});

test("form-contained gate takes priority over an empty public body and unsupported visual effects", () => {
  const f = fixture(); const dialog = f.add("DIV", f.body, { attrs: { role: "dialog" }, styles: { transform: "matrix(1, 0, 0, 1, 10, 20)" } });
  const formNode = f.add("FORM", dialog); const button = f.add("BUTTON", formNode); f.add("#text", button, { text: "请完成安全验证" });
  const result = projectNativeDomSnapshot(f.snapshot, frame, { readyState: "unknown" });
  assert.equal(result.gate, "verification_required"); assert.equal(result.pageLoad?.readyState, "unknown");
  assert.doesNotMatch(result.html, /安全验证/);
  const login = fixture(); const loginDialog = login.add("DIALOG", login.body, { attrs: { open: "" } }); login.add("#text", loginDialog, { text: "请先登录" });
  assert.equal(projectNativeDomSnapshot(login.snapshot, frame, load).gate, "login_required");
});

test("hidden dialog and input values cannot invent a gate", () => {
  const f = fixture(); f.paragraph(); const hidden = f.add("DIV", f.body, { attrs: { role: "dialog", hidden: "" } }); f.add("#text", hidden, { text: "安全验证" });
  const dialog = f.add("DIV", f.body, { attrs: { role: "dialog" } }); const input = f.add("INPUT", dialog); f.add("#text", input, { text: "安全验证" });
  assert.equal(projectNativeDomSnapshot(f.snapshot, frame, load).gate, undefined);
});

test("visible frame count is measured from owner boxes and frame content is not adopted", () => {
  const f = fixture(); const visible = f.add("IFRAME", f.body); f.add("#text", visible, { text: "CHILD_SECRET" });
  f.add("IFRAME", f.body, { attrs: { hidden: "" } }); f.add("IFRAME", f.body, { bounds: [0, 0, 0, 0] });
  const result = projectNativeDomSnapshot(f.snapshot, frame, load);
  assert.equal(result.pageLoad?.visibleFrames, 1); assert.equal(result.pageLoad?.content, "embedded_content"); assert.doesNotMatch(result.html, /CHILD_SECRET/);
});

test("rendered UTF-16 ranges preserve multilingual characters and reject omitted meaningful suffixes", () => {
  const f = fixture(); const text = "中文😀 العربية English"; const item = f.paragraph(text);
  const at = f.layoutIndex(item.textNode); const box = f.textBoxes.layoutIndex.indexOf(at);
  f.textBoxes.length[box] = 4;
  f.textBoxes.layoutIndex.push(at); f.textBoxes.bounds.push([0, 20, 100, 20]); f.textBoxes.start.push(4); f.textBoxes.length.push(text.length - 4);
  assert.ok(projectNativeDomSnapshot(f.snapshot, frame, load).html.includes(text));
  f.textBoxes.length.pop(); f.textBoxes.start.pop(); f.textBoxes.bounds.pop(); f.textBoxes.layoutIndex.pop();
  assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load), (error: unknown) => error instanceof NativeDomSnapshotError && error.code === "snapshot_visibility_unsupported" && error.detail === "text_range_gap");
});

test("overlapping text boxes are merged once and ignored whitespace is not manufactured into words", () => {
  const f = fixture(); const item = f.paragraph("  中文😀 English  "); const at = f.layoutIndex(item.textNode);
  const box = f.textBoxes.layoutIndex.indexOf(at); f.textBoxes.start[box] = 2; f.textBoxes.length[box] -= 4;
  f.textBoxes.layoutIndex.push(at); f.textBoxes.bounds.push([0, 20, 100, 20]); f.textBoxes.start.push(2); f.textBoxes.length.push(4);
  const result = projectNativeDomSnapshot(f.snapshot, frame, load);
  assert.ok(result.html.includes(">中文😀 English</div>")); assert.equal(result.html.match(/中文/g)?.length, 1);
});

test("visible whitespace between inline words remains once even when its text node has duplicate layouts", () => {
  for (const duplicateSpaceLayout of [false, true]) {
    const f = fixture(); const block = f.add("DIV", f.body, { attrs: { class: "job-intro-content" } });
    const first = f.add("SPAN", block); f.add("#text", first, { text: "Senior" });
    const space = f.add("#text", block, { text: " " });
    if (duplicateSpaceLayout) { const second = f.appendLayout(space); f.textBox(second, 0, 1); }
    const last = f.add("SPAN", block); f.add("#text", last, { text: "Engineer" });
    const result = projectNativeDomSnapshot(f.snapshot, frame, load);
    assert.ok(result.html.includes('<div class="job-intro-content"><span>Senior</span> <span>Engineer</span></div>'), `duplicateSpaceLayout=${duplicateSpaceLayout}`);
    assert.equal(result.html.replace(/<[^>]+>/g, ""), "Senior Engineer");
  }
});

test("one text node's equal-text layout fragments cover the complete multilingual text once, including overlaps", () => {
  for (const overlap of [false, true]) {
    const f = fixture(); const text = `中文😀 العربية English ${description}`; const item = f.paragraph(text);
    const first = f.layoutIndex(item.textNode); const firstBox = f.textBoxes.layoutIndex.indexOf(first);
    const split = 12;
    f.textBoxes.length[firstBox] = split + (overlap ? 5 : 0);
    const second = f.appendLayout(item.textNode, { bounds: [0, 20, 1000, 1000] });
    f.textBox(second, split, text.length - split);
    const result = projectNativeDomSnapshot(f.snapshot, frame, load);
    assert.equal(result.pageLoad?.content, "visible_text");
    assert.ok(result.html.includes(`<div class="job-intro-content">${text}</div>`));
    assert.equal(result.html.split(text).length - 1, 1, "layout rows represent one DOM text node, not repeated facts");
    assert.ok(extractPublicJobHtml(result.html, "猎聘", source, { requireVisibleDescription: true }).text.includes(description));
  }
});

test("one text node's unequal layout strings are rejected instead of guessed, ordered or concatenated", () => {
  const f = fixture(); const item = f.paragraph();
  const secondText = "不同布局片段_PRIVATE_FRAGMENT";
  const second = f.appendLayout(item.textNode, { text: secondText });
  f.textBox(second, 0, secondText.length);
  assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load), (error: unknown) => {
    assert.ok(error instanceof NativeDomSnapshotError);
    assert.equal(error.code, "snapshot_visibility_unsupported");
    assert.equal(error.detail, "text_fragment_mapping");
    assert.doesNotMatch(error.message, /PRIVATE_FRAGMENT|不同布局|职责/);
    return true;
  });
});

test("transparent text layout boxes cannot complete a visible fragment, while a complete visible layout is adopted once", () => {
  for (const transparentFirst of [false, true]) {
    for (const visibleComplete of [false, true]) {
      const f = fixture(); const item = f.paragraph();
      const first = f.layoutIndex(item.textNode); const firstBox = f.textBoxes.layoutIndex.indexOf(first);
      const second = f.appendLayout(item.textNode, { opacity: transparentFirst ? 1 : 0 });
      f.layout.textColorOpacities[first] = transparentFirst ? 0 : 1;
      const split = Math.floor(description.length / 2);
      if (!transparentFirst && !visibleComplete) f.textBoxes.length[firstBox] = split;
      f.textBox(second, transparentFirst && !visibleComplete ? split : 0, transparentFirst && !visibleComplete ? description.length - split : description.length);
      if (!visibleComplete) {
        assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load), (error: unknown) => error instanceof NativeDomSnapshotError && error.code === "snapshot_visibility_unsupported" && error.detail === "text_range_gap");
      } else {
        const result = projectNativeDomSnapshot(f.snapshot, frame, load);
        assert.ok(result.html.includes(description));
        assert.equal(result.html.split(description).length - 1, 1);
      }
    }
  }
});

test("conflicting protection styles across an ancestor's layout rows are rejected in either row order", () => {
  const effects: Record<string, Record<string, string>> = {
    clipping: { "overflow-y": "hidden" }, transform: { transform: "matrix(1, 0, 0, 1, 1, 1)" },
    display: { display: "none" }, visibility: { visibility: "hidden" }, opacity: { opacity: "0" },
    transparent: { color: "rgba(0, 0, 0, 0)" },
  };
  for (const [name, styles] of Object.entries(effects)) {
    for (const protectedFirst of [false, true]) {
      const f = fixture(); const item = f.paragraph();
      const baseline = [...f.layout.styles[f.layoutIndex(item.block)]];
      const second = f.appendLayout(item.block, { styles });
      if (protectedFirst) {
        f.layout.styles[f.layoutIndex(item.block)] = f.layout.styles[second];
        f.layout.styles[second] = baseline;
      }
      assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load), (error: unknown) => {
        assert.ok(error instanceof NativeDomSnapshotError, `${name}, protectedFirst=${protectedFirst}`);
        assert.equal(error.code, "snapshot_visibility_unsupported");
        assert.equal(error.detail, "layout_style_conflict");
        return true;
      });
    }
  }
});

test("a text node's empty and complete protection styles conflict in either row order, including hidden or transparent first", () => {
  for (const [name, value] of [["opacity", "0"], ["color", "rgba(0, 0, 0, 0)"]] as const) {
    for (const protectedFirst of [false, true]) {
      const f = fixture(); const item = f.paragraph();
      const first = f.layoutIndex(item.textNode); const second = f.appendLayout(item.textNode);
      const protectedStyles = [...f.layout.styles[f.layoutIndex(item.block)]];
      protectedStyles[NATIVE_SNAPSHOT_STYLES.indexOf(name)] = f.str(value);
      f.layout.styles[protectedFirst ? first : second] = protectedStyles;
      f.textBox(second, 0, description.length);
      assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load), (error: unknown) => {
        assert.ok(error instanceof NativeDomSnapshotError, `${name}, protectedFirst=${protectedFirst}`);
        assert.equal(error.code, "snapshot_visibility_unsupported");
        assert.equal(error.detail, "layout_style_conflict");
        return true;
      });
    }
  }
});

test("a type-1 pseudo layout's own generated text is rejected even without any child text node", () => {
  const f = fixture(); const pseudo = f.add("SPAN", f.body);
  const at = f.layoutIndex(pseudo); const text = "GENERATED_PRIVATE_TEXT";
  f.layout.text[at] = f.str(text); f.textBox(at, 0, text.length);
  Object.assign(f.nodes, { pseudoType: { index: [pseudo], value: [f.str("before")] } });
  assert.equal(f.nodes.nodeType.filter(type => type === 3).length, 0, "generated content lives only in the element LayoutObject");
  assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load), (error: unknown) => error instanceof NativeDomSnapshotError && error.code === "snapshot_visibility_unsupported" && error.detail === "shadow_or_pseudo" && !error.message.includes(text));
});

test("one iframe with several layout rows counts once and never adopts its content", () => {
  const f = fixture(); const iframe = f.add("IFRAME", f.body);
  f.appendLayout(iframe, { bounds: [0, 40, 900, 400] });
  f.add("#text", iframe, { text: "FRAME_PRIVATE_TEXT" });
  const result = projectNativeDomSnapshot(f.snapshot, frame, load);
  assert.equal(result.pageLoad?.visibleFrames, 1);
  assert.equal(result.pageLoad?.content, "embedded_content");
  assert.doesNotMatch(result.html, /FRAME_PRIVATE_TEXT/);
});

test("duplicate element layouts without their own text preserve a single semantic wrapper and child text", () => {
  const f = fixture(); const item = f.paragraph();
  f.appendLayout(item.block, { bounds: [0, 40, 900, 400] });
  const result = projectNativeDomSnapshot(f.snapshot, frame, load);
  assert.ok(result.html.includes(`<div class="job-intro-content">${description}</div>`));
  assert.equal(result.html.match(/class="job-intro-content"/g)?.length, 1);
  assert.equal(result.html.split(description).length - 1, 1);
});

test("projection is pure for a deeply frozen protocol response", () => {
  const f = fixture(); f.paragraph();
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  };
  freeze(f.snapshot);
  assert.ok(projectNativeDomSnapshot(f.snapshot, frame, load).html.includes(description));
});

for (const [name, effect] of Object.entries({
  "line clamp": { "-webkit-line-clamp": "3" }, "overflow clipping": { "overflow-y": "hidden" }, "scroll container": { "overflow-x": "auto" },
  "ellipsis": { "text-overflow": "ellipsis" }, "clip path": { "clip-path": "inset(0 0 50% 0)" }, "legacy clip": { clip: "rect(0px, 10px, 10px, 0px)" },
  "transformed text": { transform: "matrix(1, 0, 0, 1, 5, 5)" }, "filter": { filter: "opacity(0)" }, "mask": { "mask-image": "linear-gradient(black, transparent)" },
})) test(`known unsupported visibility: ${name} fails instead of exporting hidden text`, () => {
  const f = fixture(); f.paragraph(description, f.body, { styles: effect });
  const details: Record<string, string> = { "line clamp": "line_clamp", "overflow clipping": "overflow_clip_or_scroll", "scroll container": "overflow_clip_or_scroll", ellipsis: "text_ellipsis", "clip path": "clip_path", "legacy clip": "legacy_clip", "transformed text": "transform", filter: "filter", mask: "mask" };
  assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load), (error: unknown) => {
    assert.ok(error instanceof NativeDomSnapshotError);
    assert.equal(error.code, "snapshot_visibility_unsupported");
    assert.equal(error.detail, details[name]);
    assert.doesNotMatch(error.message, /职责|matrix|linear-gradient|https:/);
    return true;
  });
});

test("shadow and pseudo text are rejected until their projection is supported", () => {
  for (const key of ["shadowRootType", "pseudoType"]) {
    const f = fixture(); const item = f.paragraph(); Object.assign(f.nodes, { [key]: { index: [item.block], value: [f.str("open")] } });
    assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load), fails("snapshot_visibility_unsupported"));
  }
});

test("JSON-LD closing script is escaped case insensitively and metadata is not placed in the body", () => {
  const f = fixture(); f.paragraph(); const script = f.add("SCRIPT", f.head, { attrs: { type: "application/ld+json" } });
  f.add("#text", script, { text: '{"description":"</ScRiPt><img src=x onerror=x>"}', hiddenLayout: true });
  const result = projectNativeDomSnapshot(f.snapshot, frame, load);
  assert.ok(result.html.includes("<\\/script><img")); assert.equal(result.html.match(/<script/g)?.length, 1);
  assert.doesNotMatch(result.html.slice(result.html.indexOf("<body")), /onerror|script/);
});

test("malformed schema and indices produce fixed errors without embedding source data", () => {
  const cases: [NativeDomSnapshotCode, (f: ReturnType<typeof fixture>) => void][] = [
    ["document_url", f => { f.doc.documentURL = f.str("https://private.invalid/?token=SECRET"); }],
    ["node_arrays", f => { f.nodes.nodeValue.pop(); }], ["node_parent", f => { f.nodes.parentIndex[f.body] = f.body; }],
    ["attributes", f => { f.nodes.attributes[f.body] = [f.str("odd")]; }], ["snapshot_string", f => { f.nodes.nodeName[f.body] = -2; }],
    ["layout_arrays", f => { f.layout.text.pop(); }], ["layout_entry", f => { f.layout.styles[0].pop(); }],
    ["text_box_arrays", f => { f.textBoxes.start.pop(); }], ["text_box_entry", f => { f.textBoxes.bounds[0] = [0, 0, -1, 20]; }],
    ["text_box_range", f => { f.textBoxes.length[0] += 1; }],
  ];
  for (const [code, mutate] of cases) { const f = fixture(); f.paragraph(); mutate(f); assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load), fails(code)); }
  for (const value of [null, false, [], { strings: [], documents: [null] }]) assert.throws(() => projectNativeDomSnapshot(value, frame, load), fails("snapshot_shape"));
});

const invalidLayouts: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ["node_index", f => { f.layout.nodeIndex[0] = f.nodes.nodeType.length; }],
  ["style_count", f => { f.layout.styles[0].pop(); }],
  ["text_opacity", f => { f.layout.textColorOpacities[0] = 2; }],
  ["computed_style", f => { f.layout.styles[0][NATIVE_SNAPSHOT_STYLES.indexOf("opacity")] = f.str("PRIVATE_INVALID_STYLE"); }],
  ["bounds", f => { f.layout.bounds[0] = [0, 0, -1, 20]; }],
];
for (const [detail, mutate] of invalidLayouts) test(`malformed layout reports the fixed ${detail} diagnostic without source data`, () => {
  const f = fixture(); f.paragraph(); mutate(f);
  assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load), (error: unknown) => {
    assert.ok(error instanceof NativeDomSnapshotError);
    assert.equal(error.code, "layout_entry");
    assert.equal(error.detail, detail);
    assert.equal(error.message, "layout_entry");
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message, /PRIVATE_INVALID_STYLE|职责|https:/);
    return true;
  });
});

test("missing BODY has a fixed waiting-compatible code, while an empty BODY remains empty", () => {
  const f = fixture(); const result = projectNativeDomSnapshot(f.snapshot, frame, { readyState: "loading" });
  assert.equal(result.pageLoad?.content, "empty"); assert.equal(result.pageLoad?.readyState, "loading");
  f.nodes.nodeName[f.body] = f.str("DIV");
  assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, { readyState: "unknown" }), fails("document_body_missing"));
});

test("node depth, count, reused strings and final escaped UTF-8 output are bounded", () => {
  const deep = fixture(); let parent = deep.body; for (let i = 0; i < 513; i++) parent = deep.add("DIV", parent, { hiddenLayout: true });
  assert.throws(() => projectNativeDomSnapshot(deep.snapshot, frame, load), fails("projection_depth_limit"));
  const many = fixture(); for (let i = 0; i < 25_000; i++) many.add("DIV", many.body, { hiddenLayout: true });
  assert.throws(() => projectNativeDomSnapshot(many.snapshot, frame, load), fails("snapshot_limit_exceeded"));
  const reused = fixture(); const largeText = "x".repeat(700_000); for (let i = 0; i < 13; i++) reused.add("#text", reused.body, { text: largeText, hiddenLayout: true });
  assert.throws(() => projectNativeDomSnapshot(reused.snapshot, frame, load), fails("snapshot_limit_exceeded"));
  const escaped = fixture(); escaped.paragraph("&".repeat(450_000));
  assert.throws(() => projectNativeDomSnapshot(escaped.snapshot, frame, load), fails("snapshot_limit_exceeded"));
  const utf8 = fixture(); utf8.paragraph("中".repeat(700_000));
  assert.throws(() => projectNativeDomSnapshot(utf8.snapshot, frame, load), fails("snapshot_limit_exceeded"));
});

const bossSource = "https://m.zhipin.com/mpa/html/weijd/weijd-job/anonymousJob?fromSource=2";
const bossFrame = { id: frame.id, url: bossSource };
const bossScope = { scope: "boss-share", sourceUrl: bossSource } as const;
function bossFixture(options: { candidateStyles?: Record<string, string>; parentStyles?: Record<string, string>; withCandidate?: boolean; withBanner?: boolean; withHeading?: boolean } = {}) {
  const f = fixture(); f.doc.documentURL = f.str(bossSource);
  const outer = f.add("MAIN", f.body);
  const wrapper = f.add("DIV", outer, { attrs: { id: "wrapper", class: "share-position share-extra" }, styles: options.parentStyles });
  let heading = -1;
  if (options.withHeading !== false) { heading = f.add("H1", wrapper, { attrs: { class: "position-title" } }); f.add("#text", heading, { text: "原岗位工程师" }); }
  let banner = -1;
  if (options.withBanner !== false) { banner = f.add("DIV", wrapper, { attrs: { class: "share-banner" }, styles: { "overflow-x": "hidden", transform: "matrix(1,0,0,1,2,0)" } }); f.add("#text", banner, { text: "BANNER_PRIVATE_UNADOPTED" }); }
  const rec = f.add("DIV", wrapper, { attrs: { class: "rec-detail extra" } });
  const address = f.add("P", rec, { attrs: { class: "detail-text address" }, styles: { "overflow-x": "hidden", "text-overflow": "ellipsis" } }); f.add("#text", address, { text: "ADDRESS_PRIVATE_UNADOPTED" });
  let candidate = -1; let textNode = -1;
  if (options.withCandidate !== false) { candidate = f.add("DIV", rec, { attrs: { class: "detail-text show-switch" }, styles: options.candidateStyles }); textNode = f.add("#text", candidate, { text: description }); }
  return { ...f, outer, wrapper, heading, banner, rec, address, candidate, textNode };
}
const scoped = (f: ReturnType<typeof bossFixture>) => projectNativeDomSnapshot(f.snapshot, bossFrame, load, bossScope);
const visibilityFails = (detail: string) => (error: unknown) => error instanceof NativeDomSnapshotError && error.code === "snapshot_visibility_unsupported" && error.detail === detail;

/** The observed folded description has CSSOM client 112 / scroll 1120 at scale two. */
function foldedBossFixture() {
  const f = bossFixture({ candidateStyles: { display: "-webkit-box", "overflow-x": "hidden", "overflow-y": "hidden", "-webkit-line-clamp": "4" } });
  f.nodes.attributes[f.candidate] = [f.str("class"), f.str("detail-text show-switch four-lines")];
  const at = f.layoutIndex(f.candidate);
  const geometry = {
    offsetRects: f.layout.nodeIndex.map(() => [] as Box | []),
    clientRects: f.layout.nodeIndex.map(() => [] as Box | []),
    scrollRects: f.layout.nodeIndex.map(() => [] as Box | []),
  };
  geometry.offsetRects[at] = [0, 292, 982, 112];
  geometry.clientRects[at] = [0, 0, 982, 112];
  geometry.scrollRects[at] = [0, 0, 982, 1120];
  f.layout.bounds[at] = [32, 1180, 1964, 224];
  const layout = Object.assign(f.layout, geometry);
  const syncGeometry = () => { for (const column of Object.values(geometry)) while (column.length < f.layout.nodeIndex.length) column.push([]); };
  return { ...f, layout, at, syncGeometry };
}

test("boss-share scope preserves original candidate structure and first visible H1 while omitting clipped unrelated siblings", () => {
  const f = bossFixture();
  assert.throws(() => projectNativeDomSnapshot(f.snapshot, bossFrame, load), visibilityFails("overflow_clip_or_scroll"));
  const result = scoped(f);
  assert.ok(result.html.includes(description));
  assert.match(result.html, /<main><div class="share-position share-extra" id="wrapper">/);
  assert.match(result.html, /<div class="rec-detail extra"><div class="detail-text show-switch">/);
  assert.equal((result.html.match(/<h1\b/g) ?? []).length, 1); assert.ok(result.html.includes("原岗位工程师"));
  assert.doesNotMatch(result.html, /BANNER_PRIVATE|ADDRESS_PRIVATE|share-banner|class="detail-text address"/);
  assert.equal(result.url, bossSource); assert.equal(result.pageLoad?.content, "visible_text");
});

test("boss-share is opt-in and source-bound to exact official original share job identity", () => {
  for (const [url, sourceUrl] of [
    [bossSource, undefined], [bossSource, bossSource.replace("anonymousJob", "otherJob")],
    [bossSource.replace("m.zhipin.com", "www.zhipin.com"), bossSource],
    [bossSource.replace("m.zhipin.com", "m.zhipin.com.outside.invalid"), bossSource],
    [bossSource.replace("https:", "http:"), bossSource],
    [bossSource.replace("m.zhipin.com", "user@m.zhipin.com"), bossSource],
    [bossSource.replace("m.zhipin.com", "m.zhipin.com:444"), bossSource],
    [bossSource.replace("anonymousJob", "anonymousJob/extra"), bossSource],
  ] as const) {
    const f = bossFixture(); f.doc.documentURL = f.str(url);
    assert.throws(() => projectNativeDomSnapshot(f.snapshot, { ...bossFrame, url }, load, { scope: "boss-share", sourceUrl }), visibilityFails("overflow_clip_or_scroll"));
  }
  const f = bossFixture(); const url = bossSource.replace("fromSource=2", "fromSource=other&sid=kept"); f.doc.documentURL = f.str(url);
  assert.ok(projectNativeDomSnapshot(f.snapshot, { ...bossFrame, url }, load, bossScope).html.includes(description));
});

test("boss-share has no heuristic fallback when matching candidates are hidden or empty", () => {
  for (const mode of ["hidden", "empty"] as const) {
    const f = bossFixture();
    if (mode === "hidden") f.nodes.attributes[f.candidate].push(f.str("hidden"), f.str(""));
    else { const at = f.layoutIndex(f.textNode); f.layout.text[at] = f.str(""); f.nodes.nodeValue[f.textNode] = f.str(""); const box = f.textBoxes.layoutIndex.indexOf(at); f.textBoxes.length[box] = 0; }
    const result = scoped(f); assert.doesNotMatch(result.html, /BANNER_PRIVATE|ADDRESS_PRIVATE/); assert.ok(!result.html.includes(description));
  }
});

test("boss-share missing or structurally similar candidates conservatively retain full-page validation", () => {
  for (const mode of ["missing", "wrong-wrapper-token", "wrong-parent-token", "nested-child", "P-address-only"] as const) {
    const f = bossFixture({ withCandidate: mode !== "missing" && mode !== "P-address-only" });
    if (mode === "wrong-wrapper-token") f.nodes.attributes[f.wrapper] = [f.str("class"), f.str("share-position-other")];
    if (mode === "wrong-parent-token") f.nodes.attributes[f.rec] = [f.str("class"), f.str("rec-detail-other")];
    if (mode === "nested-child") { f.nodes.nodeName[f.rec] = f.str("SECTION"); }
    assert.throws(() => scoped(f), visibilityFails("overflow_clip_or_scroll"));
  }
});

test("boss-share keeps every distinct description candidate in DOM order and never relabels them", () => {
  const f = bossFixture();
  const other = f.add("DIV", f.rec, { attrs: { class: "detail-text another-candidate" } }); f.add("#text", other, { text: "SECOND_DIFFERENT_FULL_JOB_" + description });
  const result = scoped(f);
  assert.equal((result.html.match(/class="detail-text/g) ?? []).length, 2);
  assert.ok(result.html.indexOf(description) < result.html.indexOf("SECOND_DIFFERENT_FULL_JOB_"));
  assert.doesNotMatch(result.html, /job-sec-text/);
});

test("boss-share preserves full metadata and refuses a conflicting canonical through the existing extractor", () => {
  const f = bossFixture();
  const title = f.add("TITLE", f.head); f.add("#text", title, { text: "原岗位工程师", hiddenLayout: true });
  const canonical = bossSource.replace("anonymousJob", "anotherJob"); f.add("LINK", f.head, { attrs: { rel: "canonical", href: canonical } });
  const posting = f.add("SCRIPT", f.head, { attrs: { type: "application/ld+json" } }); f.add("#text", posting, { hiddenLayout: true, text: JSON.stringify({ "@type": "JobPosting", title: "原岗位工程师", url: bossSource, description }) });
  const result = scoped(f); assert.ok(result.html.includes(canonical)); assert.ok(result.html.includes('type="application/ld+json"')); assert.ok(result.html.includes("原岗位工程师"));
  assert.throws(() => extractPublicJobHtml(result.html, "BOSS直聘", bossSource, { requireVisibleDescription: true, allowValidatedBossShareDescription: true }), (error: unknown) => !!error && typeof error === "object" && "failure" in error && (error as { failure: { code: string } }).failure.code === "job_mismatch");
});

test("boss-share all adopted ancestors and candidate keep original clipping, transform and fragment protections", () => {
  const cases = [
    ["candidate", "-webkit-line-clamp", "4", "line_clamp"], ["candidate", "overflow-y", "hidden", "overflow_clip_or_scroll"],
    ["candidate", "transform", "matrix(1,0,0,1,2,0)", "transform"], ["rec", "overflow-x", "auto", "overflow_clip_or_scroll"],
    ["wrapper", "overflow-y", "hidden", "overflow_clip_or_scroll"], ["outer", "transform", "matrix(1,0,0,1,1,0)", "transform"],
    ["body", "text-overflow", "ellipsis", "text_ellipsis"], ["html", "clip-path", "inset(1px)", "clip_path"],
  ] as const;
  for (const [target, style, value, detail] of cases) { const f = bossFixture(); f.style(f[target], style, value); assert.throws(() => scoped(f), visibilityFails(detail)); }
  const f = bossFixture(); const at = f.layoutIndex(f.textNode); f.textBoxes.length[f.textBoxes.layoutIndex.indexOf(at)] -= 3;
  assert.throws(() => scoped(f), visibilityFails("text_range_gap"));
});

test("boss-share collapsed four-lines content never exports the hidden tail and expanded content retains all UTF-16", () => {
  const f = bossFixture({ candidateStyles: { "overflow-y": "hidden", "-webkit-line-clamp": "4" } });
  f.nodes.attributes[f.candidate] = [f.str("class"), f.str("detail-text show-switch four-lines")];
  assert.throws(() => scoped(f), visibilityFails("overflow_clip_or_scroll"));
  f.style(f.candidate, "overflow-y", "visible"); f.style(f.candidate, "-webkit-line-clamp", "none");
  const multilingual = description + "🧪中文café e\u0301结尾完整"; const at = f.layoutIndex(f.textNode); f.layout.text[at] = f.str(multilingual); f.nodes.nodeValue[f.textNode] = f.str(multilingual); f.textBoxes.length[f.textBoxes.layoutIndex.indexOf(at)] = multilingual.length;
  assert.ok(scoped(f).html.includes(multilingual));
});

test("boss-share diagnoses the observed four-line description fold without exporting any hidden suffix", () => {
  const f = foldedBossFixture();
  const flowRoot = foldedBossFixture(); flowRoot.style(flowRoot.candidate, "display", "flow-root");
  assert.throws(() => scoped(flowRoot), visibilityFails("boss_description_collapsed"), "current Edge computes a clamped webkit box as flow-root");
  assert.throws(() => scoped(f), (error: unknown) => {
    assert.ok(error instanceof NativeDomSnapshotError);
    assert.equal(error.code, "snapshot_visibility_unsupported"); assert.equal(error.detail, "boss_description_collapsed");
    assert.equal(error.cause, undefined); assert.doesNotMatch(JSON.stringify(error), /岗位职责|detail-text|1120/);
    return true;
  });
  f.style(f.candidate, "overflow-x", "visible"); f.style(f.candidate, "overflow-y", "visible"); f.style(f.candidate, "-webkit-line-clamp", "none");
  f.nodes.attributes[f.candidate] = [f.str("class"), f.str("detail-text show-switch")];
  f.layout.clientRects[f.at] = [0, 0, 982, 1120]; f.layout.offsetRects[f.at] = [0, 292, 982, 1120]; f.layout.bounds[f.at] = [32, 1180, 1964, 2240];
  assert.ok(scoped(f).html.includes(description), "expanded text must still pass the normal complete projection");
});

test("boss-share fold diagnosis requires exact original scope, observed classes and clamp", () => {
  for (const options of [{}, { scope: "boss-share" as const }, { ...bossScope, sourceUrl: bossSource.replace("anonymousJob", "anotherJob") }]) {
    const f = foldedBossFixture();
    assert.throws(() => projectNativeDomSnapshot(f.snapshot, bossFrame, load, options), visibilityFails("overflow_clip_or_scroll"));
  }
  for (const classes of ["detail-text four-lines", "detail-text show-switch four-lines-extra", "detail-text show-switch"]) {
    const f = foldedBossFixture(); f.nodes.attributes[f.candidate] = [f.str("class"), f.str(classes)];
    assert.throws(() => scoped(f), visibilityFails("overflow_clip_or_scroll"));
  }
  for (const [name, value] of [["display", "block"], ["-webkit-line-clamp", "3"]] as const) {
    const f = foldedBossFixture(); f.style(f.candidate, name, value);
    assert.throws(() => scoped(f), visibilityFails("overflow_clip_or_scroll"));
  }
  const visibleOverflow = foldedBossFixture(); visibleOverflow.style(visibleOverflow.candidate, "overflow-x", "visible"); visibleOverflow.style(visibleOverflow.candidate, "overflow-y", "visible");
  assert.throws(() => scoped(visibleOverflow), visibilityFails("line_clamp"));
});

test("boss-share fold diagnosis recognizes the exact direct-text style copy reported by Edge", () => {
  for (const display of ["-webkit-box", "flow-root"]) {
    const f = foldedBossFixture(); f.style(f.candidate, "display", display);
    f.layout.styles[f.layoutIndex(f.textNode)] = [...f.layout.styles[f.at]];
    assert.throws(() => scoped(f), visibilityFails("boss_description_collapsed"));
  }
  const changed = foldedBossFixture(); changed.layout.styles[changed.layoutIndex(changed.textNode)] = [...changed.layout.styles[changed.at]];
  changed.style(changed.textNode, "overflow-x", "auto");
  assert.throws(() => scoped(changed), visibilityFails("overflow_clip_or_scroll"), "different child-box effects remain unsupported");
});

test("boss-share fold diagnosis requires observed positive and genuinely overflowing CSSOM geometry", () => {
  for (const change of [
    (f: ReturnType<typeof foldedBossFixture>) => { f.layout.clientRects[f.at] = []; },
    (f: ReturnType<typeof foldedBossFixture>) => { f.layout.scrollRects[f.at] = []; },
    (f: ReturnType<typeof foldedBossFixture>) => { f.layout.offsetRects[f.at] = []; },
    (f: ReturnType<typeof foldedBossFixture>) => { f.layout.clientRects[f.at] = [0, 0, 982, 0]; },
    (f: ReturnType<typeof foldedBossFixture>) => { f.layout.scrollRects[f.at] = [0, 0, 982, 112]; },
    (f: ReturnType<typeof foldedBossFixture>) => { f.layout.scrollRects[f.at] = [0, 0, 981, 1120]; },
    (f: ReturnType<typeof foldedBossFixture>) => { f.layout.scrollRects[f.at] = [0, 20, 982, 1120]; },
    (f: ReturnType<typeof foldedBossFixture>) => { f.layout.clientRects[f.at] = [0, 0, 982, 114]; },
  ]) {
    const f = foldedBossFixture(); change(f);
    assert.throws(() => scoped(f), visibilityFails("overflow_clip_or_scroll"));
  }
});

test("boss-share fold diagnosis never labels address, recommended, hidden or multiple description roots", () => {
  const address = foldedBossFixture(); address.nodes.nodeName[address.candidate] = address.str("P");
  assert.throws(() => scoped(address), visibilityFails("overflow_clip_or_scroll"));
  for (const hidden of [false, true]) {
    const f = foldedBossFixture();
    if (hidden) f.nodes.attributes[f.candidate].push(f.str("hidden"), f.str(""));
    else f.nodes.attributes[f.rec] = [f.str("class"), f.str("rec-detail recommend")];
    assert.doesNotMatch(scoped(f).html, /岗位职责/, "excluded folded text cannot become a success description");
  }
  for (const desktop of [false, true]) {
    const f = foldedBossFixture(); const other = f.add("DIV", f.rec, { attrs: { class: desktop ? "job-sec-text" : "detail-text show-switch" } });
    f.add("#text", other, { text: "另一个独立岗位职责，不应选择第一个候选折叠状态。" }); f.syncGeometry();
    assert.throws(() => scoped(f), visibilityFails("overflow_clip_or_scroll"));
  }
});

test("boss-share fold diagnosis keeps unrelated clipping outside the adopted description", () => {
  const f = bossFixture();
  f.nodes.attributes[f.banner] = [f.str("class"), f.str("share-banner detail-text show-switch four-lines")];
  f.style(f.banner, "-webkit-line-clamp", "4");
  assert.ok(scoped(f).html.includes(description));
});

test("boss-share unrelated or additional layout failures take priority over an observed fold", () => {
  for (const [target, name, value, detail] of [
    ["candidate", "transform", "matrix(1,0,0,1,2,0)", "transform"],
    ["rec", "overflow-y", "hidden", "overflow_clip_or_scroll"],
    ["wrapper", "mask-image", "url(mask.svg)", "mask"],
  ] as const) {
    const f = foldedBossFixture(); f.style(f[target], name, value);
    assert.throws(() => scoped(f), visibilityFails(detail));
  }
  const conflict = foldedBossFixture(); conflict.appendLayout(conflict.banner, { styles: { visibility: "hidden" } }); conflict.syncGeometry();
  assert.throws(() => scoped(conflict), visibilityFails("layout_style_conflict"));
  const range = foldedBossFixture(); const at = range.layoutIndex(range.banner + 1); range.textBoxes.length[range.textBoxes.layoutIndex.indexOf(at)] -= 1;
  assert.throws(() => scoped(range), visibilityFails("text_range_gap"));
  const candidateRange = foldedBossFixture(); candidateRange.textBoxes.length[candidateRange.textBoxes.layoutIndex.indexOf(candidateRange.layoutIndex(candidateRange.textNode))] -= 1;
  assert.throws(() => scoped(candidateRange), visibilityFails("boss_description_collapsed"));
  const malformed = foldedBossFixture(); malformed.nodes.backendNodeId[malformed.candidate] = malformed.nodes.backendNodeId[malformed.rec];
  assert.throws(() => scoped(malformed), fails("node_arrays"));
});

test("boss-share login and verification gates take priority over an observed fold", () => {
  const modal = foldedBossFixture(); const dialog = modal.add("DIV", modal.body, { attrs: { role: "dialog" } });
  modal.add("#text", dialog, { text: "请完成安全验证" }); modal.syncGeometry();
  assert.equal(scoped(modal).gate, "verification_required"); assert.doesNotMatch(scoped(modal).html, /岗位职责/);
  const title = foldedBossFixture(); title.doc.title = title.str("登录 | BOSS直聘");
  assert.equal(scoped(title).gate, "login_required");
});

test("boss-share retains global layout conflicts and candidate pseudo-text protection", () => {
  const f = bossFixture(); f.appendLayout(f.banner, { styles: { visibility: "hidden" } });
  assert.throws(() => scoped(f), visibilityFails("layout_style_conflict"));
  const conflict = bossFixture(); conflict.appendLayout(conflict.candidate, { styles: { visibility: "hidden" } }); assert.throws(() => scoped(conflict), visibilityFails("layout_style_conflict"));
  const pseudo = bossFixture(); const generated = pseudo.add("SPAN", pseudo.candidate); pseudo.appendLayout(generated, { text: "Not " }); pseudo.textBox(pseudo.layout.nodeIndex.length - 1, 0, 4); Object.assign(pseudo.nodes, { pseudoType: { index: [generated], value: [pseudo.str("before")] } });
  assert.throws(() => scoped(pseudo), visibilityFails("shadow_or_pseudo"));
});

test("boss-share full-page modal and non-dialog body prefix gates precede scoped candidate adoption", () => {
  const modal = bossFixture(); const dialog = modal.add("DIV", modal.body, { attrs: { role: "dialog" } }); const form = modal.add("FORM", dialog); modal.add("#text", form, { text: "请完成安全验证 验证码" });
  const result = scoped(modal); assert.equal(result.gate, "verification_required"); assert.ok(!result.html.includes(description));
  for (const [message, gate] of [["请先登录后查看完整岗位", "login_required"], ["请完成访问验证", "verification_required"]] as const) {
    const f = fixture(); f.doc.documentURL = f.str(bossSource); const prefix = f.add("DIV", f.body); f.add("#text", prefix, { text: message });
    const wrapper = f.add("DIV", f.body, { attrs: { class: "share-position" } }); const rec = f.add("DIV", wrapper, { attrs: { class: "rec-detail" } }); const candidate = f.add("DIV", rec, { attrs: { class: "detail-text" } }); f.add("#text", candidate, { text: description });
    assert.equal(projectNativeDomSnapshot(f.snapshot, bossFrame, load, bossScope).gate, gate);
  }
});

test("boss-share preserves title/H1 gate evidence and full-page visible BOSS login labels", () => {
  for (const [target, text, gate] of [["title", "安全验证 - BOSS直聘", "verification_required"], ["heading", "登录 - BOSS直聘", "login_required"]] as const) {
    const f = bossFixture(); if (target === "title") f.doc.title = f.str(text); else f.layout.text[f.layoutIndex(f.heading + 1)] = f.str(text);
    if (target === "heading") { f.nodes.nodeValue[f.heading + 1] = f.str(text); f.textBoxes.length[f.textBoxes.layoutIndex.indexOf(f.layoutIndex(f.heading + 1))] = text.length; }
    assert.equal(scoped(f).gate, gate);
  }
  const f = bossFixture(); f.doc.title = f.str("【BOSS直聘注册登录】boss直聘在线注册登录-BOSS直聘"); const label = f.add("DIV", f.body); f.add("#text", label, { text: "手机号 验证码 短信登录" });
  assert.equal(scoped(f).gate, "login_required");
});

test("boss-share first visible H1 is retained and an unsupported first heading cannot be skipped", () => {
  const f = bossFixture({ withHeading: false });
  const hidden = f.add("H1", f.wrapper, { attrs: { hidden: "" } }); f.add("#text", hidden, { text: "HIDDEN_HEADING" });
  const first = f.add("H1", f.wrapper); f.add("#text", first, { text: "FIRST_VISIBLE_HEADING" });
  const second = f.add("H1", f.wrapper); f.add("#text", second, { text: "SECOND_VISIBLE_HEADING" });
  const result = scoped(f); assert.ok(result.html.includes("FIRST_VISIBLE_HEADING")); assert.doesNotMatch(result.html, /HIDDEN_HEADING|SECOND_VISIBLE_HEADING/);
  f.style(first, "transform", "matrix(1,0,0,1,2,0)"); assert.throws(() => scoped(f), visibilityFails("transform"));
});

test("boss-share does not discard conflicting full-page modal visibility evidence", () => {
  const f = bossFixture(); const modal = f.add("DIV", f.body, { attrs: { role: "dialog" } }); f.add("#text", modal, { text: "验证码" }); f.appendLayout(modal, { styles: { visibility: "hidden" } });
  assert.throws(() => scoped(f), visibilityFails("layout_style_conflict"));
});

test("boss-share keeps schema/range checks global even for omitted banner data", () => {
  const f = bossFixture(); const at = f.layoutIndex(f.banner); f.layout.nodeIndex[at] = 999999;
  assert.throws(() => scoped(f), fails("layout_entry"));
  const range = bossFixture(); const bannerText = range.banner + 1; const bannerAt = range.layoutIndex(bannerText); const box = range.textBoxes.layoutIndex.indexOf(bannerAt); range.textBoxes.length[box] += 1;
  assert.throws(() => scoped(range), fails("text_box_range"));
});

test("boss-share mixed mobile and pre-existing desktop description roots remain ambiguous", () => {
  const f = bossFixture();
  const desktop = f.add("SECTION", f.body, { attrs: { class: "job-sec-text" } }); f.add("#text", desktop, { text: "SECOND_INDEPENDENT_DESCRIPTION_" + description.replace("设备通信平台", "财务结算系统") });
  const result = scoped(f); assert.ok(result.html.includes('class="job-sec-text"')); assert.ok(result.html.includes("SECOND_INDEPENDENT_DESCRIPTION_")); assert.ok(result.html.includes(description));
  assert.throws(() => extractPublicJobHtml(result.html, "BOSS直聘", bossSource, { requireVisibleDescription: true, allowValidatedBossShareDescription: true }), (error: unknown) => !!error && typeof error === "object" && "failure" in error && (error as { failure: { code: string } }).failure.code === "ambiguous_jobs");
  f.style(desktop, "overflow-y", "hidden"); assert.throws(() => scoped(f), visibilityFails("overflow_clip_or_scroll"));
});

test("boss-share hidden or recommended pre-existing roots retain their previous exclusion semantics", () => {
  for (const mode of ["hidden", "recommend"] as const) {
    const f = bossFixture(); const region = f.add("DIV", f.body, { attrs: mode === "hidden" ? { hidden: "" } : { class: "recommend" } }); const desktop = f.add("DIV", region, { attrs: { class: "job-sec-text" }, styles: { "overflow-y": "hidden" } }); f.add("#text", desktop, { text: "UNADOPTED_DESKTOP_RECOMMENDATION" });
    const result = scoped(f); assert.ok(result.html.includes(description)); assert.doesNotMatch(result.html, /UNADOPTED_DESKTOP_RECOMMENDATION/);
  }
});

test("boss-share full-page non-dialog login prefix and login labels cannot be erased by conflicting hidden rows", () => {
  for (const mode of ["prefix", "boss-label"] as const) {
    const f = fixture(); f.doc.documentURL = f.str(bossSource);
    if (mode === "boss-label") f.doc.title = f.str("【BOSS直聘注册登录】boss直聘在线注册登录-BOSS直聘");
    const prompt = f.add("DIV", f.body); f.add("#text", prompt, { text: mode === "prefix" ? "请先登录后查看" : "手机号 验证码 短信登录" }); f.appendLayout(prompt, { styles: { visibility: "hidden" } });
    const wrapper = f.add("DIV", f.body, { attrs: { class: "share-position" } }); const rec = f.add("DIV", wrapper, { attrs: { class: "rec-detail" } }); const candidate = f.add("DIV", rec, { attrs: { class: "detail-text" } }); f.add("#text", candidate, { text: description });
    assert.throws(() => projectNativeDomSnapshot(f.snapshot, bossFrame, load, bossScope), visibilityFails("layout_style_conflict"));
  }
});

test("boss-share actual first head TITLE gate cannot be lost when protocol document title differs", () => {
  const f = bossFixture(); const title = f.add("TITLE", f.head); f.add("#text", title, { text: "请先登录", hiddenLayout: true });
  // The extractor's title rule matches 登录, not 请先登录; make its exact existing rule explicit.
  f.nodes.nodeValue[title + 1] = f.str("登录 - BOSS直聘");
  assert.equal(scoped(f).gate, "login_required");
});

test("boss-share complete JSON-LD never manufactures hidden or partial candidate description", () => {
  for (const mode of ["hidden", "partial"] as const) {
    const f = bossFixture(); const posting = f.add("SCRIPT", f.head, { attrs: { type: "application/ld+json" } }); f.add("#text", posting, { hiddenLayout: true, text: JSON.stringify({ "@type": "JobPosting", title: "原岗位工程师", url: bossSource, description }) });
    if (mode === "hidden") {
      f.nodes.attributes[f.candidate].push(f.str("hidden"), f.str("")); const result = scoped(f); assert.ok(result.html.includes('type="application/ld+json"')); assert.ok(!result.html.includes(`<div class="detail-text show-switch">${description}`));
      assert.throws(() => extractPublicJobHtml(result.html, "BOSS直聘", bossSource, { requireVisibleDescription: true, allowValidatedBossShareDescription: true }));
    } else {
      const at = f.layoutIndex(f.textNode); f.textBoxes.length[f.textBoxes.layoutIndex.indexOf(at)] = 10;
      assert.throws(() => scoped(f), visibilityFails("text_range_gap"));
    }
  }
});
test("boss-share global non-dialog prefix fragments and omitted UTF-16 gaps cannot erase gate evidence", () => {
  for (const mode of ["different-fragments", "range-gap"] as const) {
    const f = fixture(); f.doc.documentURL = f.str(bossSource);
    const prefix = f.add("DIV", f.body); const prompt = f.add("#text", prefix, { text: mode === "different-fragments" ? "请先" : "请先登录" }); const at = f.layoutIndex(prompt);
    if (mode === "different-fragments") { const fragment = f.appendLayout(prompt, { text: "登录" }); f.textBox(fragment, 0, 2); }
    else { const box = f.textBoxes.layoutIndex.indexOf(at); f.textBoxes.length[box] = 2; f.textBox(at, 3, 1); }
    const wrapper = f.add("DIV", f.body, { attrs: { class: "share-position" } }); const rec = f.add("DIV", wrapper, { attrs: { class: "rec-detail" } }); const candidate = f.add("DIV", rec, { attrs: { class: "detail-text" } }); f.add("#text", candidate, { text: description });
    assert.throws(() => projectNativeDomSnapshot(f.snapshot, bossFrame, load, bossScope), visibilityFails(mode === "different-fragments" ? "text_fragment_mapping" : "text_range_gap"));
  }
});

test("boss-share unadopted banner still retains global pseudo and generated-text safeguards", () => {
  for (const special of [false, true]) {
    const f = bossFixture(); const generated = f.add("SPAN", f.banner); const row = f.appendLayout(generated, { text: "Not " }); f.textBox(row, 0, 4);
    if (special) Object.assign(f.nodes, { pseudoType: { index: [generated], value: [f.str("before")] } });
    assert.throws(() => scoped(f), visibilityFails(special ? "shadow_or_pseudo" : "text_fragment_mapping"));
  }
});

type RootFixtureOptions = { scale?: number; x?: number; y?: number; width?: number; height?: number; clientWidth?: number; clientHeight?: number };
const rootDocument = { nodeType: 9, backendNodeId: 1, frameId: frame.id, documentURL: source, compatibilityMode: "NoQuirksMode" } as const;
const rootScope = { rootScroll: "liepin", sourceUrl: source, rootDocument } as const;
const rootTail = "全文结尾🧪中文café e\u0301 العربية";

/** Synthetic root-flow data follows the two unit spaces in the saved local Edge evidence. */
function rootFixture({ scale = 2, x = 0, y = 0, width = 1014, height = 1642, clientWidth = 1014, clientHeight = 842 }: RootFixtureOptions = {}) {
  const f = fixture();
  const first = f.paragraph(description);
  const last = f.paragraph(rootTail, first.block, { attrs: {} });
  const firstAt = f.layoutIndex(first.textNode), lastAt = f.layoutIndex(last.textNode);
  const firstBox = f.textBoxes.layoutIndex.indexOf(firstAt), lastBox = f.textBoxes.layoutIndex.indexOf(lastAt);
  const setBox = (row: number, box: number, bounds: Box) => { f.layout.bounds[row] = [...bounds]; f.textBoxes.bounds[box] = [...bounds]; };
  setBox(firstAt, firstBox, [10 * scale, 80 * scale, 900 * scale, 20 * scale]);
  setBox(lastAt, lastBox, [10 * scale, (height - 60) * scale, 700 * scale, 20 * scale]);
  for (let row = 0; row < f.layout.nodeIndex.length; row++) {
    if (f.nodes.nodeType[f.layout.nodeIndex[row]] === 1) f.layout.styles[row].push(...["1", "ltr", "horizontal-tb", "static", "none"].map(f.str));
  }
  const rootAt = f.layoutIndex(f.html), bodyAt = f.layoutIndex(f.body);
  const geometry = {
    offsetRects: f.layout.nodeIndex.map(() => [] as Box | []),
    clientRects: f.layout.nodeIndex.map(() => [] as Box | []),
    scrollRects: f.layout.nodeIndex.map(() => [] as Box | []),
  };
  geometry.offsetRects[rootAt] = [0, 0, width, height];
  geometry.clientRects[rootAt] = [0, 0, clientWidth, clientHeight];
  geometry.scrollRects[rootAt] = [x, y, width, height];
  // BODY's CSSOM offset origin is intentionally not its document-space bounds origin.
  geometry.offsetRects[bodyAt] = [0, 0, width, height - 60];
  geometry.clientRects[bodyAt] = [0, 0, width, height - 60];
  geometry.scrollRects[bodyAt] = [0, 0, width, height - 60];
  f.layout.bounds[rootAt] = [0, 0, width * scale, height * scale];
  f.layout.bounds[bodyAt] = [0, 60 * scale, width * scale, (height - 60) * scale];
  const layout = Object.assign(f.layout, geometry);
  const doc = Object.assign(f.doc, { contentWidth: width * scale, contentHeight: height * scale, scrollOffsetX: x * scale, scrollOffsetY: y * scale });
  const setStyle = (node: number, name: typeof NATIVE_ROOT_SCROLL_STYLES[number], value: string) => {
    f.layout.styles[f.layoutIndex(node)][NATIVE_ROOT_SCROLL_STYLES.indexOf(name)] = f.str(value);
  };
  setStyle(f.html, "overflow-y", "auto");
  return { ...f, layout, doc, rootAt, bodyAt, first, last, firstAt, lastAt, firstBox, lastBox, setStyle, setBox };
}
const projectRoot = (f: ReturnType<typeof rootFixture>) => projectNativeDomSnapshot(f.snapshot, frame, load, rootScope);

test("liepin root scroll preserves the complete tail at initial, middle and final root offsets", () => {
  let expected: string | undefined;
  for (const y of [0, 400, 800]) {
    const f = rootFixture({ y }); const result = projectRoot(f);
    assert.ok(result.html.includes(description)); assert.ok(result.html.includes(rootTail));
    assert.equal(result.pageLoad?.content, "visible_text");
    assert.equal(validateBrowserSnapshot(result, { url: source, navigation: 1 }, { url: source, navigation: 1 }).state, "ready");
    if (expected) assert.equal(result.html, expected, "root scrolling never subtracts the current offset from document text boxes");
    expected = result.html;
    assert.ok(extractPublicJobHtml(result.html, "猎聘", source, { requireVisibleDescription: true }).text.includes(rootTail));
  }
});

test("liepin root scale is inferred from consistent geometry rather than hardcoded to observed scale two", () => {
  for (const scale of [.25, .5, 1, 1.25, 1.5, 2, 3, 8]) {
    const f = rootFixture({ scale, y: 400 });
    assert.ok(projectRoot(f).html.includes(rootTail), `scale=${scale}`);
  }
});

test("liepin ordinary root supports both scroll axes while preserving document coordinate boxes", () => {
  const f = rootFixture({ x: 214, y: 800, clientWidth: 800 });
  f.setStyle(f.html, "overflow-x", "scroll");
  assert.ok(projectRoot(f).html.includes(rootTail));
  f.setStyle(f.html, "overflow-y", "scroll");
  assert.ok(projectRoot(f).html.includes(rootTail));
});

test("liepin root branch needs the explicit option and original official source job identity", () => {
  const f = rootFixture();
  for (const options of [{}, { rootScroll: "liepin" as const }, { sourceUrl: source },
    { ...rootScope, sourceUrl: source.replace("123456789", "987654321") },
    { ...rootScope, sourceUrl: source.replace("www.liepin.com", "liepin.com.attacker.invalid") },
    { ...rootScope, sourceUrl: source.replace("https:", "http:") },
    { ...rootScope, sourceUrl: source.replace("www.liepin.com", "user@www.liepin.com") },
    { ...rootScope, sourceUrl: source.replace("www.liepin.com", "www.liepin.com:8443") },
  ]) assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load, options), fails("layout_entry"));
  for (const host of ["liepin.com", "m.liepin.com", "www.liepin.com"]) {
    assert.ok(projectNativeDomSnapshot(f.snapshot, frame, load, { ...rootScope, sourceUrl: source.replace("www.liepin.com", host) + "?share=1" }).html.includes(rootTail));
  }
});

test("liepin root compatibility never treats absent extra computed styles as defaults", () => {
  for (const target of ["all", "root", "body", "ancestor"] as const) {
    const f = rootFixture();
    for (let row = 0; row < f.layout.nodeIndex.length; row++) {
      if (target === "all" || (target === "root" && row === f.rootAt) || (target === "body" && row === f.bodyAt) || (target === "ancestor" && row === f.layoutIndex(f.last.block))) f.layout.styles[row] = f.layout.styles[row].slice(0, NATIVE_SNAPSHOT_STYLES.length);
    }
    assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll"), target);
  }
});

test("liepin root proof requires each root and BODY CSSOM rectangle with exact row alignment", () => {
  for (const column of ["offsetRects", "clientRects", "scrollRects"] as const) {
    for (const target of ["column", "root", "body"] as const) {
      const f = rootFixture();
      if (target === "column") delete (f.layout as Partial<typeof f.layout>)[column];
      else f.layout[column][target === "root" ? f.rootAt : f.bodyAt] = [];
      assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll"), `${column}:${target}`);
    }
    const f = rootFixture(); f.layout[column].pop();
    assert.throws(() => projectRoot(f), fails("layout_arrays"), column);
  }
});

test("liepin root geometry rejects malformed, negative dimensions and nonfinite protocol rectangles", () => {
  for (const bad of [[0, 0, 1000], [0, 0, -1, 1000], [0, 0, 1000, Infinity], [NaN, 0, 1000, 1000], null]) {
    const f = rootFixture(); (f.layout.offsetRects as unknown[])[f.rootAt] = bad;
    assert.throws(() => projectRoot(f), fails("layout_entry"));
  }
});

test("liepin root proof refuses ambiguous root or BODY layout objects without overwriting rows", () => {
  for (const node of ["html", "body"] as const) {
    const f = rootFixture(); f.appendLayout(f[node]);
    for (const column of ["offsetRects", "clientRects", "scrollRects"] as const) f.layout[column].push([...f.layout[column][node === "html" ? f.rootAt : f.bodyAt]] as Box);
    assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll"));
  }
});

test("liepin root height scale, document content extents and document offsets must cross-check", () => {
  for (const mutate of [
    (f: ReturnType<typeof rootFixture>) => { f.layout.bounds[f.rootAt][3] += 20; },
    (f: ReturnType<typeof rootFixture>) => { f.doc.contentWidth += 20; },
    (f: ReturnType<typeof rootFixture>) => { f.doc.contentHeight += 20; },
    (f: ReturnType<typeof rootFixture>) => { f.doc.scrollOffsetX += 20; },
    (f: ReturnType<typeof rootFixture>) => { f.doc.scrollOffsetY += 20; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.bounds[f.bodyAt][2] += 20; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.bounds[f.bodyAt][3] += 20; },
  ]) { const f = rootFixture({ y: 400 }); mutate(f); assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll")); }
});

test("liepin geometry permits only one CSS pixel rounding and no proportional large-document tolerance", () => {
  const f = rootFixture({ y: 400 }); f.doc.scrollOffsetY += 2; f.doc.contentHeight += 2;
  assert.ok(projectRoot(f).html.includes(rootTail));
  f.doc.contentHeight += .01;
  assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll"));
  const long = rootFixture({ height: 100_000 }); long.doc.contentHeight += 10;
  assert.throws(() => projectRoot(long), visibilityFails("overflow_clip_or_scroll"));
});

test("liepin root offsets stay within nonnegative scroll-client ranges on both axes", () => {
  for (const values of [{ x: -1 }, { y: -1 }, { x: 2 }, { y: 802 }, { clientWidth: 1015 }, { clientHeight: 1643 }]) {
    const f = rootFixture(values);
    assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll"), JSON.stringify(values));
  }
});

test("liepin root requires substantial positive CSSOM dimensions and a bounded positive scale", () => {
  for (const mutation of [
    (f: ReturnType<typeof rootFixture>) => { f.layout.offsetRects[f.rootAt][2] = 0; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.clientRects[f.rootAt][3] = 1; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.offsetRects[f.bodyAt][2] = 1; },
    (f: ReturnType<typeof rootFixture>) => { f.doc.contentWidth = 0; },
    (f: ReturnType<typeof rootFixture>) => { f.doc.contentHeight = Infinity; },
  ]) { const f = rootFixture(); mutation(f); assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll")); }
  for (const scale of [.24, 8.01]) assert.throws(() => projectRoot(rootFixture({ scale })), visibilityFails("overflow_clip_or_scroll"));
});

test("liepin hidden or clip on either HTML or BODY axis stays unsupported even if script-scrollable", () => {
  for (const target of ["html", "body"] as const) for (const axis of ["overflow-x", "overflow-y"] as const) for (const value of ["hidden", "clip"]) {
    const f = rootFixture({ y: 400 }); f.setStyle(f[target], axis, value);
    assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll"), `${target}:${axis}:${value}`);
  }
});

test("liepin BODY overflow propagation and local scrolling remain unsupported", () => {
  for (const target of ["body", "first", "last"] as const) for (const value of ["auto", "scroll", "hidden", "clip"]) {
    const f = rootFixture(); f.setStyle(target === "body" ? f.body : f[target].block, "overflow-y", value);
    assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll"), `${target}:${value}`);
  }
});

test("liepin root refuses CSS zoom, RTL and vertical writing on every relevant element chain", () => {
  for (const target of ["html", "body", "first", "last"] as const) for (const [name, value] of [["zoom", "1.01"], ["zoom", "normal"], ["direction", "rtl"], ["writing-mode", "vertical-rl"]] as const) {
    const f = rootFixture(); f.setStyle(target === "html" || target === "body" ? f[target] : f[target].block, name, value);
    assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll"), `${target}:${name}:${value}`);
  }
});

test("liepin fixed or sticky text cannot claim root-scroll reachability inside document extent", () => {
  for (const target of ["first", "last"] as const) for (const value of ["fixed", "sticky"]) {
    const f = rootFixture(); f.setStyle(f[target].block, "position", value);
    assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll"), `${target}:${value}`);
  }
  for (const value of ["static", "relative", "absolute"]) { const f = rootFixture(); f.setStyle(f.last.block, "position", value); assert.ok(projectRoot(f).html.includes(rootTail)); }
});

test("liepin root top-left border, nonzero bounds origin and root/BODY positioning stay unsupported", () => {
  for (const mutate of [
    (f: ReturnType<typeof rootFixture>) => { f.layout.bounds[f.rootAt][0] = 1; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.bounds[f.rootAt][1] = 1; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.offsetRects[f.rootAt][0] = 1; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.offsetRects[f.rootAt][1] = 1; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.clientRects[f.rootAt][0] = 1; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.clientRects[f.rootAt][1] = 1; },
    (f: ReturnType<typeof rootFixture>) => { f.setStyle(f.html, "position", "relative"); },
    (f: ReturnType<typeof rootFixture>) => { f.setStyle(f.body, "position", "absolute"); },
  ]) { const f = rootFixture(); mutate(f); assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll")); }
});

test("liepin root rejects negative-side or beyond-content boxes with equal client/scroll extents", () => {
  for (const bounds of [[-1, 80, 100, 20], [0, -1, 100, 20], [2000, 80, 100, 20], [0, 3280, 100, 20]] as Box[]) {
    const f = rootFixture({ clientHeight: 1642 }); f.setBox(f.lastAt, f.lastBox, bounds);
    assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll"));
  }
  const f = rootFixture(); f.setBox(f.lastAt, f.lastBox, [0, 3264, 2028, 20]); assert.ok(projectRoot(f).html.includes(rootTail));
});

test("liepin root still rejects incomplete UTF-16 tails and conflicting fragment mapping", () => {
  const gap = rootFixture(); gap.textBoxes.length[gap.lastBox] -= 1;
  assert.throws(() => projectRoot(gap), visibilityFails("text_range_gap"));
  const conflict = rootFixture(); const row = conflict.appendLayout(conflict.last.textNode, { text: "DIFFERENT_FRAGMENT" }); conflict.textBox(row, 0, 18);
  for (const column of ["offsetRects", "clientRects", "scrollRects"] as const) conflict.layout[column].push([]);
  assert.throws(() => projectRoot(conflict), visibilityFails("text_fragment_mapping"));
});

test("liepin root branch retains all existing clip, clamp, transform, filter, mask and pseudo checks", () => {
  for (const [name, value, detail] of [
    ["text-overflow", "ellipsis", "text_ellipsis"], ["-webkit-line-clamp", "4", "line_clamp"], ["clip", "rect(0px, 1px, 1px, 0px)", "legacy_clip"],
    ["clip-path", "inset(1px)", "clip_path"], ["transform", "matrix(1,0,0,1,1,0)", "transform"], ["filter", "blur(1px)", "filter"], ["mask-image", "linear-gradient(black,transparent)", "mask"],
  ] as const) {
    const f = rootFixture(); f.setStyle(f.last.block, name, value);
    assert.throws(() => projectRoot(f), visibilityFails(detail), name);
  }
  const f = rootFixture(); Object.assign(f.nodes, { pseudoType: { index: [f.last.textNode], value: [f.str("before")] } });
  assert.throws(() => projectRoot(f), visibilityFails("shadow_or_pseudo"));
});

test("liepin root keeps real dialog gates ahead of unsupported geometry and excludes private form fields", () => {
  const f = rootFixture(); f.layout.offsetRects[f.rootAt] = [];
  const dialog = f.add("DIV", f.body, { attrs: { role: "dialog" } }); const form = f.add("FORM", dialog); f.add("#text", form, { text: "请完成安全验证 验证码" });
  for (const column of ["offsetRects", "clientRects", "scrollRects"] as const) while (f.layout[column].length < f.layout.nodeIndex.length) f.layout[column].push([]);
  const result = projectRoot(f);
  assert.equal(result.gate, "verification_required"); assert.doesNotMatch(result.html, /验证码|全文结尾/);
});

test("liepin root requires actual contain evidence and refuses paint containment or auto content visibility", () => {
  for (const target of ["html", "body", "first", "last"] as const) {
    for (const value of ["paint", "content", "strict", "layout paint", "style paint", "size", "layout", "style"]) {
      const f = rootFixture(); f.setStyle(target === "html" || target === "body" ? f[target] : f[target].block, "contain", value);
      assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll"), `${target}:${value}`);
    }
    const auto = rootFixture(); auto.setStyle(target === "html" || target === "body" ? auto[target] : auto[target].block, "content-visibility", "auto");
    assert.throws(() => projectRoot(auto), visibilityFails("overflow_clip_or_scroll"), `${target}:content-visibility-auto`);
    const missing = rootFixture(); missing.layout.styles[missing.layoutIndex(target === "html" || target === "body" ? missing[target] : missing[target].block)].pop();
    assert.throws(() => projectRoot(missing), fails("layout_entry"), `${target}:missing-contain`);
  }
});

test("liepin root and BODY client/scroll rectangles require nonzero, consistent nonlocal dimensions", () => {
  for (const mutate of [
    (f: ReturnType<typeof rootFixture>) => { f.layout.clientRects[f.bodyAt][2] = 0; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.clientRects[f.bodyAt][3] = 0; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.scrollRects[f.bodyAt][2] = 0; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.scrollRects[f.bodyAt][3] = 0; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.scrollRects[f.bodyAt][0] = 1; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.scrollRects[f.bodyAt][1] = 1; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.clientRects[f.bodyAt][2] = 1200; },
    (f: ReturnType<typeof rootFixture>) => { f.layout.scrollRects[f.bodyAt][2] = 1000; },
  ]) { const f = rootFixture(); mutate(f); assert.throws(() => projectRoot(f), visibilityFails("overflow_clip_or_scroll")); }
});

test("liepin short HTML offset box can fit inside a larger root viewport client box", () => {
  const f = rootFixture({ height: 442 });
  f.layout.scrollRects[f.rootAt][3] = 842; f.doc.contentHeight = 842 * 2;
  assert.ok(projectRoot(f).html.includes(rootTail));
});

test("liepin root requires browser document mode bound to the captured main document backend identity", () => {
  const f = rootFixture();
  const { frameId: _frameId, ...withoutOptionalFrameId } = rootDocument;
  assert.ok(projectNativeDomSnapshot(f.snapshot, frame, load, { ...rootScope, rootDocument: withoutOptionalFrameId }).html.includes(rootTail));
  for (const evidence of [undefined, null, [], {}, { ...rootDocument, compatibilityMode: undefined },
    { ...rootDocument, compatibilityMode: "QuirksMode" }, { ...rootDocument, compatibilityMode: "LimitedQuirksMode" },
    { ...rootDocument, backendNodeId: 2 }, { ...rootDocument, frameId: "old-frame" },
    { ...rootDocument, documentURL: source.replace("123456789", "987654321") }, { ...rootDocument, nodeType: 1 },
  ]) assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load, { ...rootScope, rootDocument: evidence }), visibilityFails("overflow_clip_or_scroll"));
  // Merely adding a modern doctype to a quirks document cannot manufacture mode evidence.
  const at = f.nodes.nodeType.length;
  f.nodes.nodeType.push(10); f.nodes.parentIndex.push(0); f.nodes.nodeName.push(f.str("html")); f.nodes.nodeValue.push(-1); f.nodes.backendNodeId.push(at + 1); f.nodes.attributes.push([]);
  assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load, { ...rootScope, rootDocument: { ...rootDocument, compatibilityMode: "QuirksMode" } }), visibilityFails("overflow_clip_or_scroll"));
});

const liepinScope = { ...rootScope, scope: "liepin-job" } as const;
function liepinFixture(options: { label?: string; withHeading?: boolean; withCandidate?: boolean; prefix?: string; sectionTag?: string; sectionClass?: string; dlTag?: string; dlClass?: string; indirectDl?: boolean; indirectDt?: boolean; dtOptions?: Options; ddOptions?: Options } = {}) {
  const f = fixture();
  if (options.prefix) { const prefix = f.add("DIV", f.body); f.add("#text", prefix, { text: options.prefix }); }
  const outer = f.add("MAIN", f.body, { attrs: { id: "original-job" } });
  let heading = -1;
  if (options.withHeading !== false) { heading = f.add("H1", outer); f.add("#text", heading, { text: "原岗位软件工程师" }); }
  const banner = f.add("DIV", outer, { attrs: { class: "top-card" }, styles: { "overflow-x": "hidden", transform: "matrix(1,0,0,1,2,0)" } }); f.add("#text", banner, { text: "UNADOPTED_TOP_CARD" });
  const section = f.add(options.sectionTag ?? "SECTION", outer, { attrs: { class: options.sectionClass ?? "job-intro-container extra" } });
  let candidate = -1, dt = -1, dtText = -1, dd = -1, textNode = -1;
  if (options.withCandidate !== false) {
    const parent = options.indirectDl ? f.add("DIV", section) : section;
    candidate = f.add(options.dlTag ?? "DL", parent, { attrs: { class: options.dlClass ?? "paragraph extra" } });
    const dtParent = options.indirectDt ? f.add("DIV", candidate) : candidate;
    dt = f.add("DT", dtParent, options.dtOptions); dtText = f.add("#text", dt, { text: options.label ?? "职位描述：" });
    dd = f.add("DD", candidate, options.ddOptions); textNode = f.add("#text", dd, { text: description + rootTail });
  }
  const address = f.add("DL", section, { attrs: { class: "paragraph address" } });
  const addressDt = f.add("DT", address); f.add("#text", addressDt, { text: "工作地址：" });
  const addressDd = f.add("DD", address, { attrs: { class: "ellipsis-1" }, styles: { "overflow-x": "hidden", "text-overflow": "ellipsis" } }); f.add("#text", addressDd, { text: "UNADOPTED_WORK_ADDRESS" });
  const geometry = { offsetRects: [] as (Box | [])[], clientRects: [] as (Box | [])[], scrollRects: [] as (Box | [])[] };
  const completeStyles = () => {
    for (let row = 0; row < f.layout.nodeIndex.length; row++) {
      if (f.nodes.nodeType[f.layout.nodeIndex[row]] === 1 && f.layout.styles[row].length === NATIVE_SNAPSHOT_STYLES.length) f.layout.styles[row].push(...["1", "ltr", "horizontal-tb", "static", "none"].map(f.str));
    }
    for (const column of Object.values(geometry)) while (column.length < f.layout.nodeIndex.length) column.push([]);
  };
  completeStyles();
  const layout = Object.assign(f.layout, geometry);
  const rootAt = f.layoutIndex(f.html), bodyAt = f.layoutIndex(f.body);
  layout.bounds[rootAt] = [0, 0, 2000, 2000]; layout.offsetRects[rootAt] = [0, 0, 1000, 1000]; layout.clientRects[rootAt] = [0, 0, 1000, 1000]; layout.scrollRects[rootAt] = [0, 0, 1000, 5000];
  layout.bounds[bodyAt] = [0, 0, 2000, 10000]; layout.offsetRects[bodyAt] = [0, 0, 1000, 5000]; layout.clientRects[bodyAt] = [0, 0, 1000, 5000]; layout.scrollRects[bodyAt] = [0, 0, 1000, 5000];
  const doc = Object.assign(f.doc, { contentWidth: 2000, contentHeight: 10000, scrollOffsetX: 0, scrollOffsetY: 0 });
  const appendLayout = (...args: Parameters<typeof f.appendLayout>) => { const row = f.appendLayout(...args); completeStyles(); return row; };
  const setStyle = (node: number, name: typeof NATIVE_ROOT_SCROLL_STYLES[number], value: string) => { f.layout.styles[f.layoutIndex(node)][NATIVE_ROOT_SCROLL_STYLES.indexOf(name)] = f.str(value); };
  return { ...f, layout, doc, rootAt, bodyAt, appendLayout, outer, heading, banner, section, candidate, dt, dtText, dd, textNode, address, addressDt, addressDd, completeStyles, setStyle };
}
const projectLiepin = (f: ReturnType<typeof liepinFixture>) => projectNativeDomSnapshot(f.snapshot, frame, load, liepinScope);

const splitDuties = "负责设备通信平台的架构设计、接口开发、问题定位和自动化测试，维护交付文档并与产品团队协作完成项目。";
const splitRequirements = "熟悉 C#、SQL Server 与异步编程，具备独立分析需求和编写测试的能力。REQUIREMENTS_TAIL_SENTINEL";
function liepinSplitFixture(label = "任职要求") {
  const f = liepinFixture({ label: "岗位职责", withHeading: false });
  const at = f.layoutIndex(f.textNode), box = f.textBoxes.layoutIndex.indexOf(at);
  f.nodes.nodeValue[f.textNode] = f.str("RAW_DUTIES_MUST_NOT_BACKFILL"); f.layout.text[at] = f.str(splitDuties); f.textBoxes.length[box] = splitDuties.length;
  const requirements = f.add("DL", f.section, { attrs: { class: "paragraph" } });
  const requirementsDt = f.add("DT", requirements); const requirementsDtText = f.add("#text", requirementsDt, { text: label });
  const requirementsDd = f.add("DD", requirements); const requirementsText = f.add("#text", requirementsDd, { text: splitRequirements });
  f.completeStyles();
  return { ...f, requirements, requirementsDt, requirementsDtText, requirementsDd, requirementsText };
}

test("[46] liepin same-section split duties and explicit requirements survive projection and full extraction", () => {
  for (const label of ["任职要求", "职位要求", " 任职\n要求： "]) {
    const f = liepinSplitFixture(label), projected = projectLiepin(f);
    assert.ok(projected.html.includes(splitDuties)); assert.ok(projected.html.includes(splitRequirements));
    assert.doesNotMatch(projected.html, /RAW_DUTIES|UNADOPTED_/);
    const actual = extractPublicJobHtml(projected.html, "猎聘", source, { requireVisibleDescription: true, allowValidatedLiepinDescription: true });
    assert.ok(actual.text.includes(splitDuties)); assert.ok(actual.text.includes(splitRequirements));
    assert.ok(actual.text.indexOf(splitDuties) < actual.text.indexOf(splitRequirements));
    assert.match(actual.text, /岗位职责\n/); assert.match(actual.text, /任职\s*要求|职位要求/);
  }
});

test("[46] liepin identified requirements DD cannot be hidden, transparent, unlaid-out or empty", () => {
  for (const mode of ["hidden", "aria-hidden", "display", "visibility", "opacity", "color", "text-alpha", "no-boxes", "no-layout", "empty", "nested-hidden", "missing-dd"] as const) {
    const f = liepinSplitFixture();
    if (mode === "hidden") f.nodes.attributes[f.requirementsDd].push(f.str("hidden"), f.str(""));
    if (mode === "aria-hidden") f.nodes.attributes[f.requirementsDd].push(f.str("aria-hidden"), f.str("true"));
    if (mode === "display") f.setStyle(f.requirementsDd, "display", "none");
    if (mode === "visibility") f.setStyle(f.requirementsDd, "visibility", "hidden");
    if (mode === "opacity") f.setStyle(f.requirementsDd, "opacity", "0");
    if (mode === "color") f.setStyle(f.requirementsDd, "color", "rgba(0, 0, 0, 0)");
    if (mode === "text-alpha") f.layout.textColorOpacities[f.layoutIndex(f.requirementsText)] = 0;
    if (mode === "no-boxes") f.textBoxes.length[f.textBoxes.layoutIndex.indexOf(f.layoutIndex(f.requirementsText))] = 0;
    if (mode === "no-layout") f.layout.bounds[f.layoutIndex(f.requirementsText)] = [0, 0, 0, 0];
    if (mode === "empty") { const at = f.layoutIndex(f.requirementsText); f.layout.text[at] = f.str(""); f.textBoxes.length[f.textBoxes.layoutIndex.indexOf(at)] = 0; }
    if (mode === "nested-hidden") { const hidden = f.add("SPAN", f.requirementsDd, { attrs: { hidden: "" } }); f.add("#text", hidden, { text: "HIDDEN_REQUIREMENTS_SUFFIX" }); f.completeStyles(); }
    if (mode === "missing-dd") { f.nodes.nodeName[f.requirementsDd] = f.str("DIV"); }
    assert.throws(() => projectLiepin(f), fails("snapshot_visibility_unsupported"), mode);
  }
});

test("[46] liepin identified requirements retain original CSS and complete text-range rejection", () => {
  for (const mode of ["overflow", "clamp", "transform", "range-gap"] as const) {
    const f = liepinSplitFixture();
    if (mode === "overflow") f.setStyle(f.requirementsDd, "overflow-y", "hidden");
    if (mode === "clamp") f.setStyle(f.requirementsDd, "-webkit-line-clamp", "2");
    if (mode === "transform") f.setStyle(f.requirementsDd, "transform", "matrix(1,0,0,1,2,0)");
    if (mode === "range-gap") f.textBoxes.length[f.textBoxes.layoutIndex.indexOf(f.layoutIndex(f.requirementsText))] -= 1;
    assert.throws(() => projectLiepin(f), visibilityFails(mode === "overflow" ? "overflow_clip_or_scroll" : mode === "clamp" ? "line_clamp" : mode === "transform" ? "transform" : "text_range_gap"), mode);
  }
});

test("[46] liepin requirements do not merge across sections or with two independent duties", () => {
  for (const separateSection of [false, true]) for (const sameDuties of separateSection ? [false] : [false, true]) {
    const f = liepinSplitFixture();
    const section = separateSection ? f.add("SECTION", f.outer, { attrs: { class: "job-intro-container" } }) : f.section;
    const other = f.add("DL", section, { attrs: { class: "paragraph" } }); const dt = f.add("DT", other); f.add("#text", dt, { text: "工作职责" }); const dd = f.add("DD", other); f.add("#text", dd, { text: sameDuties ? splitDuties : "另一独立岗位职责。".repeat(12) });
    f.completeStyles();
    const projected = projectLiepin(f);
    assert.throws(() => extractPublicJobHtml(projected.html, "猎聘", source, { requireVisibleDescription: true, allowValidatedLiepinDescription: true }), (error: unknown) => error instanceof Error && "failure" in error && (error.failure as { code: string }).code === "ambiguous_jobs");
  }
});

test("[46] requirement DD paragraphs preserve proven original LF without using raw DOM suffixes", () => {
  const f = liepinSplitFixture();
  const text = "第一条：掌握 C#。\n第二条：掌握 SQL。\n\nREQUIREMENTS_LF_TAIL";
  for (const row of f.layout.styles) if (row.length === NATIVE_ROOT_SCROLL_STYLES.length) row.push(f.str("normal"));
  f.layout.styles[f.layoutIndex(f.requirementsDd)][NATIVE_ROOT_SCROLL_STYLES.length] = f.str("pre-line");
  const at = f.layoutIndex(f.requirementsText), box = f.textBoxes.layoutIndex.indexOf(at);
  f.layout.text[at] = f.str(text); f.nodes.nodeValue[f.requirementsText] = f.str("PRIVATE_RAW_REQUIREMENTS_MUST_NOT_BACKFILL");
  const first = text.indexOf("\n"), second = text.indexOf("\n", first + 1);
  f.textBoxes.length[box] = first;
  f.textBox(at, first + 1, second - first - 1); f.textBox(at, second + 2, text.length - second - 2);
  const projected = projectLiepin(f);
  assert.ok(projected.html.includes(text)); assert.doesNotMatch(projected.html, /PRIVATE_RAW_REQUIREMENTS/);
  const actual = extractPublicJobHtml(projected.html, "猎聘", source, { requireVisibleDescription: true, allowValidatedLiepinDescription: true });
  assert.ok(actual.text.endsWith(text));
});

test("[46] hidden requirement headings are never inferred from raw DOM or adopted as visible evidence", () => {
  const f = liepinSplitFixture(); f.nodes.attributes[f.requirementsDt].push(f.str("hidden"), f.str(""));
  const projected = projectLiepin(f);
  assert.ok(projected.html.includes(splitDuties)); assert.doesNotMatch(projected.html, /REQUIREMENTS_TAIL_SENTINEL|任职要求/);
});

const paragraphText = "Network & software\n1. Design reliable enterprise systems and document the delivery process.\r\n2. Maintain C# and SQL integrations with 中文😀 العربية.\n\nRequirements\nCommunicate with the team and verify the final café e\u0301 TAIL.";
const expectedParagraphs = "Network & software\n1. Design reliable enterprise systems and document the delivery process.\n2. Maintain C# and SQL integrations with 中文😀 العربية.\n\nRequirements\nCommunicate with the team and verify the final café e\u0301 TAIL.";
function liepinParagraphFixture(whiteSpace = "pre-line") {
  const f = liepinFixture();
  for (let row = 0; row < f.layout.nodeIndex.length; row++) {
    if (f.layout.styles[row].length === NATIVE_ROOT_SCROLL_STYLES.length) f.layout.styles[row].push(f.str("normal"));
  }
  const whitespaceAt = NATIVE_ROOT_SCROLL_STYLES.length;
  f.layout.styles[f.layoutIndex(f.dd)][whitespaceAt] = f.str(whiteSpace);
  f.layout.text[f.layoutIndex(f.textNode)] = f.str(paragraphText);
  // Deliberately different from the layout text: DOM data cannot fill the gaps.
  f.nodes.nodeValue[f.textNode] = f.str("RAW_NODE_PRIVATE_SUFFIX_MUST_NOT_APPEAR");
  const setRanges = (node: number, text: string) => {
    const at = f.layoutIndex(node);
    f.layout.text[at] = f.str(text);
    for (let box = f.textBoxes.layoutIndex.length - 1; box >= 0; box--) {
      if (f.textBoxes.layoutIndex[box] !== at) continue;
      f.textBoxes.layoutIndex.splice(box, 1); f.textBoxes.bounds.splice(box, 1); f.textBoxes.start.splice(box, 1); f.textBoxes.length.splice(box, 1);
    }
    // Positive boxes omit whitespace, and their Y positions also include soft
    // wrapping. Only LF in the source layout gaps can be a paragraph boundary.
    for (const token of text.matchAll(/\S+/gu)) {
      const start = token.index!;
      f.textBox(at, start, token[0].length, [10, 100 + Math.floor(start / 40) * 20, 100, 20]);
    }
  };
  setRanges(f.textNode, paragraphText);
  const setWhiteSpace = (node: number, value: string) => { f.layout.styles[f.layoutIndex(node)][whitespaceAt] = f.str(value); };
  return { ...f, setRanges, setWhiteSpace };
}
const extractLiepinParagraphs = (f: ReturnType<typeof liepinParagraphFixture>) => extractPublicJobHtml(projectLiepin(f).html, "猎聘", source, { requireVisibleDescription: true, allowValidatedLiepinDescription: true }).text;

test("native Liepin preserves original paragraph LF only with explicit newline-preserving CSS and complete visible ranges", () => {
  assert.equal(NATIVE_SNAPSHOT_STYLES.length, 15); assert.equal(NATIVE_ROOT_SCROLL_STYLES.length, 20); assert.equal(NATIVE_LIEPIN_PARAGRAPH_STYLES.length, 21);
  for (const whiteSpace of ["pre-line", "pre", "pre-wrap", "break-spaces"]) {
    const f = liepinParagraphFixture(whiteSpace); const result = projectLiepin(f);
    const extracted = extractPublicJobHtml(result.html, "猎聘", source, { requireVisibleDescription: true, allowValidatedLiepinDescription: true });
    assert.equal(extracted.text, expectedParagraphs, whiteSpace);
    assert.doesNotMatch(result.html, /RAW_NODE_PRIVATE|UNADOPTED_/);
    assert.equal(extracted.text.replace(/\s/g, ""), paragraphText.replace(/\s/g, ""));
  }
});

test("Liepin normal, nowrap, unknown or absent whitespace evidence keeps gaps as spaces without guessing from distant ancestors", () => {
  for (const whiteSpace of ["normal", "nowrap", "", "preserve-breaks", "inherit"]) {
    const f = liepinParagraphFixture(whiteSpace); f.setWhiteSpace(f.candidate, "pre-line");
    assert.equal(extractLiepinParagraphs(f), paragraphText.replace(/\s+/g, " "), whiteSpace);
    assert.doesNotMatch(projectLiepin(f).html, /software\n|العربية\.\n/);
  }
  const missing = liepinParagraphFixture(); missing.layout.styles[missing.layoutIndex(missing.dd)].pop();
  missing.setWhiteSpace(missing.candidate, "pre-line");
  assert.equal(extractLiepinParagraphs(missing), paragraphText.replace(/\s+/g, " "));
  const legacy = liepinParagraphFixture();
  for (const styles of legacy.layout.styles) if (styles.length === NATIVE_LIEPIN_PARAGRAPH_STYLES.length) styles.pop();
  assert.equal(extractLiepinParagraphs(legacy), paragraphText.replace(/\s+/g, " "), "twenty-column snapshots retain the original output");
});

test("Liepin paragraph restoration stays inside description bodies and preserves the existing gate projection", () => {
  const f = liepinParagraphFixture();
  f.setRanges(f.heading + 1, "Original\nJob"); f.setWhiteSpace(f.heading, "pre-line");
  f.setRanges(f.dtText, "职位\n描述："); f.setWhiteSpace(f.dt, "pre-line");
  const result = projectLiepin(f);
  assert.ok(result.html.includes("<h1>Original Job</h1>")); assert.ok(result.html.includes("<dt>职位 描述：</dt>"));
  assert.ok(result.html.includes("software\n1. Design"));
  const gated = liepinParagraphFixture();
  const dialog = gated.add("DIV", gated.body, { attrs: { role: "dialog" } }); const form = gated.add("FORM", dialog); const text = gated.add("#text", form, { text: "请完成\n安全验证" });
  gated.completeStyles(); gated.setRanges(text, "请完成\n安全验证");
  assert.equal(projectLiepin(gated).gate, "verification_required");
  assert.doesNotMatch(projectLiepin(gated).html, /software|安全验证|RAW_NODE_PRIVATE/);
});

test("Liepin paragraph evidence cannot replace the original twenty styles, root identity, clipping or meaningful-range checks", () => {
  for (const mode of ["base-style", "root-identity", "local-scroll", "clamp", "meaningful-gap", "suffix", "conflicting-fragment"] as const) {
    const f = liepinParagraphFixture();
    if (mode === "base-style") f.layout.styles[f.layoutIndex(f.dd)][15] = f.str("");
    if (mode === "local-scroll") f.setStyle(f.dd, "overflow-y", "auto");
    if (mode === "clamp") f.setStyle(f.dd, "-webkit-line-clamp", "2");
    const at = f.layoutIndex(f.textNode), boxes = f.textBoxes.layoutIndex.flatMap((row, index) => row === at ? [index] : []);
    if (mode === "meaningful-gap") f.textBoxes.length[boxes[2]]--;
    if (mode === "suffix") f.textBoxes.length[boxes.at(-1)!]--;
    if (mode === "conflicting-fragment") { const second = f.appendLayout(f.textNode, { text: "DIFFERENT_FRAGMENT" }); f.textBox(second, 0, 18); }
    const options = mode === "root-identity" ? { ...liepinScope, rootDocument: { ...rootDocument, backendNodeId: 999 } } : liepinScope;
    assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load, options), (error: unknown) => error instanceof NativeDomSnapshotError && error.code === "snapshot_visibility_unsupported", mode);
  }
  const malformed = liepinParagraphFixture(); malformed.layout.styles[malformed.layoutIndex(malformed.dd)].push(malformed.str("extra"));
  assert.throws(() => projectLiepin(malformed), fails("layout_entry"));
});

test("Liepin equal-text fragments and overlapping UTF-16 boxes preserve each original paragraph once without inserting soft-wrap LF", () => {
  const f = liepinParagraphFixture(); const at = f.layoutIndex(f.textNode);
  const emojiStart = paragraphText.indexOf("😀"), emojiBox = f.textBoxes.start.findIndex((start, box) => f.textBoxes.layoutIndex[box] === at && start === emojiStart - 2);
  assert.ok(emojiBox >= 0);
  const originalLength = f.textBoxes.length[emojiBox]; f.textBoxes.length[emojiBox] = 3;
  // The adjacent UTF-16 range crosses the surrogate pair; merging must restore
  // it before slicing, rather than adding a separator within the emoji.
  f.textBox(at, emojiStart + 1, originalLength - 3, [120, 500, 100, 20]);
  const second = f.appendLayout(f.textNode);
  for (let box = 0, count = f.textBoxes.layoutIndex.length; box < count; box++) if (f.textBoxes.layoutIndex[box] === at) f.textBox(second, f.textBoxes.start[box], f.textBoxes.length[box], f.textBoxes.bounds[box]);
  f.textBox(second, 0, 7, [10, 100, 100, 20]);
  const result = projectLiepin(f);
  const extracted = extractPublicJobHtml(result.html, "猎聘", source, { requireVisibleDescription: true, allowValidatedLiepinDescription: true });
  assert.equal(extracted.text, expectedParagraphs);
  assert.equal(extracted.text.match(/😀/gu)?.length, 1);
});

test("liepin heading helper accepts only known complete DT labels after whitespace and one trailing colon", () => {
  for (const label of ["职位描述", "职责描述", "岗位职责", "工作职责", "职位介绍"]) for (const value of [label, ` ${label} `, `\n${label}：\t`, `${label}:`, label.split("").join(" \n")]) assert.equal(isLiepinDescriptionHeading(value), true, value);
  for (const value of ["", "工作地址", "职位要求", "任职要求", "职责", "职位描述::", "职位描述：：", "职位描述及要求", "关于岗位职责", "职位描述详情", "Job description", "岗位职责。", "【职位描述】", "职位介绍::", "职位介绍详情", "推荐职位介绍", "岗位介绍", "工作内容", "职位内容", "岗位描述"]) assert.equal(isLiepinDescriptionHeading(value), false, value);
});

test("liepin scope retains a complete labelled duties DL and omits the sibling address and clipped top card", () => {
  const f = liepinFixture();
  assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load, rootScope), visibilityFails("overflow_clip_or_scroll"));
  const result = projectLiepin(f);
  assert.ok(result.html.includes('<section class="job-intro-container extra"><dl class="paragraph extra"><dt>职位描述：</dt><dd>'));
  assert.ok(result.html.includes(description + rootTail)); assert.ok(result.html.includes("原岗位软件工程师"));
  assert.doesNotMatch(result.html, /UNADOPTED_|ellipsis-1|top-card|class="paragraph address"/);
  assert.equal(result.url, source); assert.equal(result.pageLoad?.content, "visible_text");
});

test("liepin scope requires original source, root mode and same NoQuirks document evidence", () => {
  for (const options of [{ ...liepinScope, sourceUrl: undefined }, { ...liepinScope, sourceUrl: source.replace("123456789", "987654321") },
    { ...liepinScope, sourceUrl: source.replace("www.liepin.com", "www.liepin.com.attacker.invalid") }, { ...liepinScope, rootScroll: undefined },
    { ...liepinScope, rootDocument: undefined }, { ...liepinScope, rootDocument: { ...rootDocument, backendNodeId: 2 } },
    { ...liepinScope, rootDocument: { ...rootDocument, compatibilityMode: "QuirksMode" } }, { ...rootScope, scope: "boss-share" as const },
  ]) { const f = liepinFixture(); assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load, options), (error: unknown) => error instanceof NativeDomSnapshotError); }
});

test("liepin scope preserves each supported heading including inline split labels without guessing alternatives", () => {
  for (const label of ["职位描述", "职责描述", "岗位职责", "工作职责", "职位介绍", " 岗位\n职责： "]) assert.ok(projectLiepin(liepinFixture({ label })).html.includes(rootTail), label);
  const f = liepinFixture(); f.nodes.nodeValue[f.dtText] = f.str(""); f.layout.text[f.layoutIndex(f.dtText)] = f.str(""); f.textBoxes.length[f.textBoxes.layoutIndex.indexOf(f.layoutIndex(f.dtText))] = 0;
  for (const text of ["职", "位", "描述："]) { const span = f.add("SPAN", f.dt); f.add("#text", span, { text }); }
  f.completeStyles(); assert.ok(projectLiepin(f).html.includes(rootTail));
  for (const label of ["工作地址", "职位要求", "职责", "职位描述详情", "职位描述::", "职位介绍详情", "推荐职位介绍", "职位介绍::", "岗位介绍", "工作内容", "职位内容", "岗位描述"]) assert.throws(() => projectLiepin(liepinFixture({ label })), visibilityFails("overflow_clip_or_scroll"), label);
});

test("liepin new duties selector requires exact tag, class tokens and direct SECTION/DL/DT structure", () => {
  for (const options of [{ sectionTag: "DIV" }, { sectionClass: "not-job-intro-container" }, { dlTag: "DIV" }, { dlClass: "paragraph-extra" }, { indirectDl: true }, { indirectDt: true }, { withCandidate: false }]) {
    assert.throws(() => projectLiepin(liepinFixture(options)), visibilityFails("overflow_clip_or_scroll"), JSON.stringify(options));
  }
});

test("liepin scope never drops additional DTs, DDs or nested tail content inside a matched duties DL", () => {
  const f = liepinFixture();
  const dt = f.add("DT", f.candidate); f.add("#text", dt, { text: "补充说明" });
  const dd = f.add("DD", f.candidate, { attrs: { class: "additional-original-content" } }); const list = f.add("UL", dd); const item = f.add("LI", list); f.add("#text", item, { text: "COMPLETE_ADDITIONAL_DD_TAIL" });
  f.completeStyles(); const result = projectLiepin(f);
  assert.ok(result.html.includes("补充说明")); assert.ok(result.html.includes('<dd class="additional-original-content"><ul><li>COMPLETE_ADDITIONAL_DD_TAIL</li></ul></dd>'));
});

test("liepin scope retains every matched duties DL in DOM order and all three legacy classes on any element", () => {
  const f = liepinFixture();
  const next = f.add("DL", f.section, { attrs: { class: "paragraph" } }); const dt = f.add("DT", next); f.add("#text", dt, { text: "工作职责" }); const dd = f.add("DD", next); f.add("#text", dd, { text: "SECOND_INDEPENDENT_DUTIES_" + description });
  for (const [tag, name] of [["ARTICLE", "job-intro-content"], ["SECTION", "job-description"], ["DIV", "job-desc-content"]]) { const old = f.add(tag, f.outer, { attrs: { class: name } }); f.add("#text", old, { text: `LEGACY_${name}_` + description }); }
  f.completeStyles(); const result = projectLiepin(f);
  assert.ok(result.html.indexOf(description + rootTail) < result.html.indexOf("SECOND_INDEPENDENT_DUTIES_"));
  assert.equal((result.html.match(/<dl\b/g) ?? []).length, 2);
  for (const name of ["job-intro-content", "job-description", "job-desc-content"]) assert.ok(result.html.includes(`LEGACY_${name}_`));
});

test("liepin legacy-only candidates can use scoped projection while similarly named classes cannot", () => {
  for (const name of ["job-intro-content", "job-description", "job-desc-content"]) {
    const f = liepinFixture({ withCandidate: false }); const old = f.add("ARTICLE", f.outer, { attrs: { class: `extra ${name}` } }); f.add("#text", old, { text: description }); f.completeStyles();
    assert.ok(projectLiepin(f).html.includes(description));
    f.nodes.attributes[old] = [f.str("class"), f.str(`${name}-other`)];
    assert.throws(() => projectLiepin(f), visibilityFails("overflow_clip_or_scroll"));
  }
});

test("liepin scope does not fall back to unclassified text for hidden or empty matched duties", () => {
  for (const mode of ["hidden", "empty"] as const) {
    const f = liepinFixture();
    if (mode === "hidden") f.nodes.attributes[f.candidate].push(f.str("hidden"), f.str(""));
    else { const at = f.layoutIndex(f.textNode), box = f.textBoxes.layoutIndex.indexOf(at); f.nodes.nodeValue[f.textNode] = f.str(""); f.layout.text[at] = f.str(""); f.textBoxes.length[box] = 0; }
    if (mode === "hidden") assert.throws(() => projectLiepin(f), visibilityFails("overflow_clip_or_scroll"));
    else { const result = projectLiepin(f); assert.ok(!result.html.includes(rootTail)); assert.doesNotMatch(result.html, /UNADOPTED_/); }
  }
});

test("liepin DT label classification cannot use hidden, transparent, input or metadata-only text", () => {
  for (const options of [{ attrs: { hidden: "" } }, { attrs: { "aria-hidden": "true" } }, { styles: { display: "none" } }, { styles: { opacity: "0" } }]) assert.throws(() => projectLiepin(liepinFixture({ dtOptions: options })), visibilityFails("overflow_clip_or_scroll"));
  for (const tag of ["INPUT", "TEXTAREA", "SCRIPT"]) {
    const f = liepinFixture({ label: "职位" }); const node = f.add(tag, f.dt, { attrs: { value: "描述" } }); f.add("#text", node, { text: "描述" }); f.completeStyles();
    assert.throws(() => projectLiepin(f), visibilityFails("overflow_clip_or_scroll"), tag);
  }
});

test("liepin DT gaps, conflicting fragments and pseudo text remain global failures rather than a guessed label", () => {
  for (const mode of ["gap", "fragment", "pseudo"] as const) {
    const f = liepinFixture(); const at = f.layoutIndex(f.dtText), box = f.textBoxes.layoutIndex.indexOf(at);
    if (mode === "gap") f.textBoxes.length[box] -= 1;
    else if (mode === "fragment") {
      f.layout.text[at] = f.str("职位"); f.textBoxes.length[box] = 2;
      const row = f.appendLayout(f.dtText, { text: "描述" }); f.textBox(row, 0, 2);
    }
    else Object.assign(f.nodes, { pseudoType: { index: [f.dtText], value: [f.str("before")] } });
    assert.throws(() => projectLiepin(f), visibilityFails(mode === "gap" ? "text_range_gap" : mode === "fragment" ? "text_fragment_mapping" : "shadow_or_pseudo"), mode);
  }
});

test("liepin adopted DD, DT, section and H1 retain original clipping and visual-effect protections", () => {
  for (const [target, style, value, detail] of [
    ["dd", "overflow-y", "hidden", "overflow_clip_or_scroll"], ["dd", "-webkit-line-clamp", "4", "line_clamp"],
    ["candidate", "overflow-x", "auto", "overflow_clip_or_scroll"], ["section", "transform", "matrix(1,0,0,1,1,0)", "transform"],
    ["dt", "text-overflow", "ellipsis", "text_ellipsis"], ["heading", "clip-path", "inset(1px)", "clip_path"],
    ["outer", "filter", "blur(1px)", "filter"], ["dd", "mask-image", "linear-gradient(black,transparent)", "mask"],
  ] as const) { const f = liepinFixture(); f.setStyle(f[target], style, value); assert.throws(() => projectLiepin(f), visibilityFails(detail), `${target}:${style}`); }
});

test("liepin scope checks all twenty ordinary-flow styles even when HTML overflow is visible", () => {
  for (const target of ["html", "body", "outer", "section", "candidate", "dt", "dd", "heading"] as const) {
    for (const [style, value] of [["zoom", "1.5"], ["direction", "rtl"], ["writing-mode", "vertical-rl"], ["position", "fixed"], ["position", "sticky"], ["contain", "paint"], ["content-visibility", "auto"]] as const) {
      const f = liepinFixture(); f.setStyle(f[target], style, value); assert.throws(() => projectLiepin(f), visibilityFails("overflow_clip_or_scroll"), `${target}:${style}:${value}`);
    }
    const missing = liepinFixture(); const row = missing.layoutIndex(missing[target]); missing.layout.styles[row] = missing.layout.styles[row].slice(0, 15);
    assert.throws(() => projectLiepin(missing), visibilityFails("overflow_clip_or_scroll"), `${target}:missing-styles`);
  }
});

test("liepin scope keeps UTF-16 coverage, all layout conflicts and protocol validation global", () => {
  const tail = liepinFixture(); tail.textBoxes.length[tail.textBoxes.layoutIndex.indexOf(tail.layoutIndex(tail.textNode))] -= 1;
  assert.throws(() => projectLiepin(tail), visibilityFails("text_range_gap"));
  const bannerGap = liepinFixture(); bannerGap.textBoxes.length[bannerGap.textBoxes.layoutIndex.indexOf(bannerGap.layoutIndex(bannerGap.banner + 1))] -= 1;
  assert.throws(() => projectLiepin(bannerGap), visibilityFails("text_range_gap"));
  const conflict = liepinFixture(); conflict.appendLayout(conflict.banner, { styles: { visibility: "hidden" } }); assert.throws(() => projectLiepin(conflict), visibilityFails("layout_style_conflict"));
  const invalid = liepinFixture(); invalid.layout.nodeIndex[invalid.layoutIndex(invalid.banner)] = 999999; assert.throws(() => projectLiepin(invalid), fails("layout_entry"));
  const pseudo = liepinFixture(); Object.assign(pseudo.nodes, { pseudoType: { index: [pseudo.banner + 1], value: [pseudo.str("before")] } }); assert.throws(() => projectLiepin(pseudo), visibilityFails("shadow_or_pseudo"));
});

test("liepin full-page modal, title, primary H1 and body prefix gates survive scoped output", () => {
  for (const [prefix, gate] of [["请先登录后查看完整岗位", "login_required"], ["请完成安全验证", "verification_required"]] as const) assert.equal(projectLiepin(liepinFixture({ prefix })).gate, gate);
  for (const [title, gate] of [["登录 - 猎聘", "login_required"], ["安全验证 - 猎聘", "verification_required"]] as const) {
    const f = liepinFixture(); f.doc.title = f.str(title); assert.equal(projectLiepin(f).gate, gate);
    const actual = liepinFixture(); const node = actual.add("TITLE", actual.head); actual.add("#text", node, { text: title, hiddenLayout: true }); assert.equal(projectLiepin(actual).gate, gate);
  }
  const f = liepinFixture(); const dialog = f.add("DIV", f.body, { attrs: { role: "dialog" } }); const form = f.add("FORM", dialog); f.add("#text", form, { text: "请完成安全验证" }); f.completeStyles(); assert.equal(projectLiepin(f).gate, "verification_required");
});

test("liepin scoped security notice agrees with the existing exact full-page predicate", () => {
  const notices = [
    "猎聘安全中心发现您的帐号或IP可能存在异常，为了保障您的账号及资源安全，请进行安全验证",
    "行为异常。猎聘安全中心发现您的账号或 IP 可能存在异常；为了保障您的帐号及资源安全：请进行安全验证",
    "猎聘安全中心发现您的帐号或IP可能存在异常，请进行安全验证",
    "为了保障您的帐号及资源安全，请进行安全验证",
    "岗位职责：维护猎聘安全中心系统，开发账号及IP异常与资源安全验证功能。",
  ];
  for (const notice of notices) {
    const f = liepinFixture(); const sibling = f.add("DIV", f.body); f.add("#text", sibling, { text: notice }); f.completeStyles();
    const expected = isObservedLiepinVerification(`<html><body>${notice}</body></html>`, source, "猎聘");
    assert.equal(projectLiepin(f).gate === "verification_required", expected, notice);
  }
  const hidden = liepinFixture(); const sibling = hidden.add("DIV", hidden.body, { attrs: { hidden: "" } }); hidden.add("#text", sibling, { text: notices[0] }); hidden.completeStyles(); assert.equal(projectLiepin(hidden).gate, undefined);
});

test("liepin first visible H1 is retained if present and no heading is invented when absent", () => {
  const f = liepinFixture({ withHeading: false }); assert.doesNotMatch(projectLiepin(f).html, /<h1/);
  const hidden = f.add("H1", f.outer, { attrs: { hidden: "" } }); f.add("#text", hidden, { text: "HIDDEN_H1" });
  const first = f.add("H1", f.outer); f.add("#text", first, { text: "FIRST_H1" }); const second = f.add("H1", f.outer); f.add("#text", second, { text: "SECOND_H1" }); f.completeStyles();
  const result = projectLiepin(f); assert.ok(result.html.includes("FIRST_H1")); assert.doesNotMatch(result.html, /HIDDEN_H1|SECOND_H1/);
  f.setStyle(first, "-webkit-line-clamp", "2"); assert.throws(() => projectLiepin(f), visibilityFails("line_clamp"));
});

test("liepin metadata remains complete and conflicting canonical still rejects", () => {
  const f = liepinFixture(); const other = source.replace("123456789", "987654321"); f.add("LINK", f.head, { attrs: { rel: "canonical", href: other } });
  const script = f.add("SCRIPT", f.head, { attrs: { type: "application/ld+json" } }); f.add("#text", script, { hiddenLayout: true, text: JSON.stringify({ "@type": "JobPosting", title: "原岗位软件工程师", url: source, description }) });
  const result = projectLiepin(f); assert.ok(result.html.includes(other)); assert.ok(result.html.includes('type="application/ld+json"')); assert.ok(result.html.includes(rootTail));
  assert.throws(() => extractPublicJobHtml(result.html, "猎聘", source, { requireVisibleDescription: true }), (error: unknown) => !!error && typeof error === "object" && "failure" in error && (error as { failure: { code: string } }).failure.code === "job_mismatch");
});

test("liepin visible-root scope still requires complete root geometry and document-reachable text boxes", () => {
  for (const [target, column] of [["rootAt", "offsetRects"], ["rootAt", "clientRects"], ["rootAt", "scrollRects"], ["bodyAt", "offsetRects"], ["bodyAt", "clientRects"], ["bodyAt", "scrollRects"]] as const) {
    const f = liepinFixture(); f.layout[column][f[target]] = [];
    assert.throws(() => projectLiepin(f), visibilityFails("overflow_clip_or_scroll"), `${target}:${column}`);
  }
  for (const bounds of [[-1, 10, 100, 20], [0, -1, 100, 20], [1990, 10, 20, 20], [0, 9990, 100, 20]] as Box[]) {
    const f = liepinFixture(); f.setStyle(f.dd, "position", "relative"); f.textBoxes.bounds[f.textBoxes.layoutIndex.indexOf(f.layoutIndex(f.textNode))] = bounds;
    assert.throws(() => projectLiepin(f), visibilityFails("overflow_clip_or_scroll"), JSON.stringify(bounds));
  }
  const consistent = liepinFixture(); consistent.doc.contentHeight += 20;
  assert.throws(() => projectLiepin(consistent), visibilityFails("overflow_clip_or_scroll"));
});

test("liepin visible-root scope accepts saved fractional document-height geometry without percent tolerance", () => {
  const f = liepinFixture({ withHeading: false });
  f.layout.bounds[f.rootAt] = [0, 0, 2696, 1684]; f.layout.offsetRects[f.rootAt] = [0, 0, 1348, 842]; f.layout.clientRects[f.rootAt] = [0, 0, 1348, 842]; f.layout.scrollRects[f.rootAt] = [0, 0, 1348, 3891];
  f.layout.bounds[f.bodyAt] = [0, 0, 2696, 7783.28125]; f.layout.offsetRects[f.bodyAt] = [0, 0, 1348, 3892]; f.layout.clientRects[f.bodyAt] = [0, 0, 1348, 3892]; f.layout.scrollRects[f.bodyAt] = [0, 0, 1348, 3892];
  f.doc.contentWidth = 2696; f.doc.contentHeight = 7783;
  assert.ok(projectLiepin(f).html.includes(rootTail));
});

test("liepin scoped projection reaches the native-only extractor selector and extends metadata summary to the full DD", () => {
  const f = liepinFixture({ withHeading: false }); const result = projectLiepin(f);
  assert.throws(() => extractPublicJobHtml(result.html, "猎聘", source, { requireVisibleDescription: true }));
  const options = { requireVisibleDescription: true, allowValidatedLiepinDescription: true } as const;
  assert.ok(extractPublicJobHtml(result.html, "猎聘", source, options).text.includes(description + rootTail));
  const script = f.add("SCRIPT", f.head, { attrs: { type: "application/ld+json" } }); f.add("#text", script, { hiddenLayout: true, text: JSON.stringify({ "@type": "JobPosting", title: "原岗位软件工程师", url: source, description }) });
  assert.ok(extractPublicJobHtml(projectLiepin(f).html, "猎聘", source, options).text.includes(description + rootTail));
});

test("liepin observed 职位介绍 label reaches full native extraction while keeping clipped duties and missing proof rejected", () => {
  const f = liepinFixture({ label: "职位介绍", withHeading: false });
  const result = projectLiepin(f);
  assert.ok(result.html.includes("<dt>职位介绍</dt>"));
  assert.doesNotMatch(result.html, /UNADOPTED_|ellipsis-1|top-card/);
  for (const options of [{}, { requireVisibleDescription: true }, { allowValidatedLiepinDescription: true }]) {
    assert.throws(() => extractPublicJobHtml(result.html, "猎聘", source, options));
  }
  const options = { requireVisibleDescription: true, allowValidatedLiepinDescription: true } as const;
  assert.ok(extractPublicJobHtml(result.html, "猎聘", source, options).text.includes(description + rootTail));
  const script = f.add("SCRIPT", f.head, { attrs: { type: "application/ld+json" } });
  f.add("#text", script, { hiddenLayout: true, text: JSON.stringify({ "@type": "JobPosting", title: "原岗位软件工程师", url: source, description }) });
  assert.ok(extractPublicJobHtml(projectLiepin(f).html, "猎聘", source, options).text.includes(description + rootTail));
  const clipped = liepinFixture({ label: "职位介绍", ddOptions: { styles: { "overflow-y": "hidden" } } });
  assert.throws(() => projectLiepin(clipped), visibilityFails("overflow_clip_or_scroll"));
  assert.throws(() => projectNativeDomSnapshot(f.snapshot, frame, load, { ...liepinScope, rootDocument: undefined }), visibilityFails("overflow_clip_or_scroll"));
});

test("liepin scoped projection preserves new/new and new/legacy independent candidate ambiguity", () => {
  for (const legacy of [undefined, "job-intro-content", "job-description", "job-desc-content"]) {
    const f = liepinFixture(); let other: number;
    if (legacy) other = f.add("ARTICLE", f.outer, { attrs: { class: legacy } });
    else { const dl = f.add("DL", f.section, { attrs: { class: "paragraph" } }); const dt = f.add("DT", dl); f.add("#text", dt, { text: "工作职责：" }); other = f.add("DD", dl); }
    f.add("#text", other, { text: "SECOND_INDEPENDENT_JOB_" + description.replace("设备通信平台", "财务清算系统") }); f.completeStyles();
    const result = projectLiepin(f); assert.ok(result.html.includes("SECOND_INDEPENDENT_JOB_")); assert.ok(result.html.includes(rootTail));
    assert.throws(() => extractPublicJobHtml(result.html, "猎聘", source, { requireVisibleDescription: true, allowValidatedLiepinDescription: true }), (error: unknown) => !!error && typeof error === "object" && "failure" in error && (error as { failure: { code: string } }).failure.code === "ambiguous_jobs", legacy ?? "new/new");
  }
});

test("liepin scoped projection preserves multiple JobPosting conflicts instead of narrowing metadata to the adopted duties", () => {
  const f = liepinFixture();
  const postings = [{ "@type": "JobPosting", title: "First", url: source, description }, { "@type": "JobPosting", title: "Second", url: source, description: "INDEPENDENT_OTHER_POSTING_" + description }];
  const script = f.add("SCRIPT", f.head, { attrs: { type: "application/ld+json" } }); f.add("#text", script, { hiddenLayout: true, text: JSON.stringify(postings) });
  const result = projectLiepin(f); assert.ok(result.html.includes("INDEPENDENT_OTHER_POSTING_"));
  assert.throws(() => extractPublicJobHtml(result.html, "猎聘", source, { requireVisibleDescription: true, allowValidatedLiepinDescription: true }), (error: unknown) => !!error && typeof error === "object" && "failure" in error && (error as { failure: { code: string } }).failure.code === "ambiguous_jobs");
});

function bossObservedSuffixFixture() {
  const f = foldedBossFixture();
  const text = (" ".repeat(29) + "THE ROLE\n" + "LOCAL SYNTHETIC ENGINEERING RESPONSIBILITIES ".repeat(100)).slice(0, 3230);
  const at=f.layoutIndex(f.textNode), first=f.textBoxes.layoutIndex.indexOf(at);
  f.nodes.nodeValue[f.textNode]=f.str(text);f.layout.text[at]=f.str(text);
  f.layout.styles[at]=[...f.layout.styles[f.at]];
  f.textBoxes.start[first]=29;f.textBoxes.length[first]=8;
  f.textBox(at,38,139);f.textBox(at,177,142);
  return {...f,text,atText:at,firstBox:first};
}
test("observed direct folded text suffix gap produces only collapsed failure",()=>{
  const f=bossObservedSuffixFixture();assert.throws(()=>scoped(f),visibilityFails("boss_description_collapsed"));
});
test("folded prefix and internal meaningful gaps stay strict text-range failures",()=>{
  for(const index of [0,37]){const f=bossObservedSuffixFixture();const text=f.text.slice(0,index)+"X"+f.text.slice(index+1);f.nodes.nodeValue[f.textNode]=f.str(text);f.layout.text[f.atText]=f.str(text);assert.throws(()=>scoped(f),visibilityFails("text_range_gap"));}
});
test("expanded description with the same omitted suffix is never accepted",()=>{
  const f=bossObservedSuffixFixture();f.style(f.candidate,"overflow-x","visible");f.style(f.candidate,"overflow-y","visible");f.style(f.candidate,"-webkit-line-clamp","none");f.layout.styles[f.atText]=[...f.layout.styles[f.at]];assert.throws(()=>scoped(f),visibilityFails("text_range_gap"));
});
test("other node gaps before or after the folded candidate keep global priority",()=>{
  for(const after of [false,true]){const f=bossObservedSuffixFixture();let textNode=f.banner+1;if(after){textNode=f.add("#text",f.wrapper,{text:"UNADOPTED_SUFFIX_GLOBAL_FAILURE"});f.syncGeometry();}const box=f.textBoxes.layoutIndex.indexOf(f.layoutIndex(textNode));f.textBoxes.length[box]-=1;assert.throws(()=>scoped(f),visibilityFails("text_range_gap"));}
});
test("nested or multiply laid out folded text gaps retain original range rejection",()=>{
  const nested=bossObservedSuffixFixture();const span=nested.add("SPAN",nested.candidate);const text=nested.add("#text",span,{text:"NESTED_MEANINGFUL_SUFFIX"});nested.syncGeometry();nested.textBoxes.length[nested.textBoxes.layoutIndex.indexOf(nested.layoutIndex(text))]-=1;assert.throws(()=>scoped(nested),visibilityFails("text_range_gap"));
  const multiple=bossObservedSuffixFixture();const second=multiple.appendLayout(multiple.textNode);multiple.textBox(second,29,8);multiple.syncGeometry();assert.throws(()=>scoped(multiple),visibilityFails("text_range_gap"));
});
test("folded suffix diagnosis cannot hide fragment conflicts pseudo text or additional CSS",()=>{
  const conflict=bossObservedSuffixFixture();const second=conflict.appendLayout(conflict.textNode,{text:"DIFFERENT_FRAGMENT"});conflict.textBox(second,0,18);conflict.syncGeometry();assert.throws(()=>scoped(conflict),visibilityFails("text_fragment_mapping"));
  const pseudo=bossObservedSuffixFixture();Object.assign(pseudo.nodes,{pseudoType:{index:[pseudo.textNode],value:[pseudo.str("before")]}});assert.throws(()=>scoped(pseudo),visibilityFails("shadow_or_pseudo"));
  const transformed=bossObservedSuffixFixture();transformed.style(transformed.candidate,"transform","matrix(1,0,0,1,1,0)");transformed.layout.styles[transformed.atText]=[...transformed.layout.styles[transformed.at]];assert.throws(()=>scoped(transformed),visibilityFails("transform"));
});
