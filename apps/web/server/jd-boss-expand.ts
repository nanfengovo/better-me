import { NativeDomSnapshotError, NATIVE_SNAPSHOT_STYLES, projectNativeDomSnapshot } from "./jd-cdp-dom-snapshot";

export type BossExpandPlan = {
  controlBackendNodeId: number;
  descriptionBackendNodeId: number;
  hitBackendNodeIds: number[];
};

type Rect = [number, number, number, number];
type Row = { bounds: Rect; styles: string[]; text: string; opacity: number | undefined; offset?: Rect; client?: Rect; scroll?: Rect; boxes: { bounds: Rect; start: number; end: number }[] };
type Node = { type: number; name: string; parent: number; id: number; attrs: Map<string, string>; children: number[]; rows: Row[]; special: boolean };
type Table = {
  strings: string[];
  documents: {
    frameId: number; documentURL: number; contentWidth?: number; contentHeight?: number;
    nodes: { nodeType: number[]; parentIndex: number[]; nodeName: number[]; backendNodeId: number[]; attributes: number[][]; shadowRootType?: { index: number[] }; pseudoType?: { index: number[] } };
    layout: { nodeIndex: number[]; styles: number[][]; bounds: Rect[]; text: number[]; textColorOpacities?: number[]; offsetRects?: (Rect | [])[]; clientRects?: (Rect | [])[]; scrollRects?: (Rect | [])[] };
    textBoxes: { layoutIndex: number[]; bounds: Rect[]; start: number[]; length: number[] };
  }[];
};

const ordinaryChildren = new Set(["SPAN", "B", "STRONG", "I", "EM", "SMALL"]);
const excludedTags = new Set(["FORM", "INPUT", "TEXTAREA", "SELECT", "OPTION", "NAV", "ASIDE", "FOOTER", "BUTTON", "LABEL", "DIALOG", "DETAILS", "SUMMARY", "IFRAME", "FRAME", "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "SVG", "MATH", "CANVAS", "OBJECT", "EMBED", "VIDEO", "AUDIO"]);
const excludedClass = /(?:^|[-_])(?:recommend(?:ation)?s?|related(?:-jobs)?|address|app|login|signin|signup|register|verify|verification|captcha|security|download)(?:$|[-_])/i;
const hasClass = (node: Node, value: string) => (node.attrs.get("class") ?? "").split(/\s+/).includes(value);
const bossIdentity = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "m.zhipin.com" || url.username || url.password || (url.port && url.port !== "443")) return undefined;
    return url.pathname.match(/^\/mpa\/html\/weijd\/weijd-job\/([a-z\d_-]+)\/?$/i)?.[1];
  } catch { return undefined; }
};
const finitePositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 10_000_000;
const opaqueColor = (value: string) => /^rgb\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*\)$/i.test(value)
  || /^rgba\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*1(?:\.0+)?\s*\)$/i.test(value);

/**
 * Identifies one ordinary expand link, never text to adopt or coordinates to click.
 * The caller must independently recheck source/loader, scroll, obtain CSS geometry
 * and hit-test this same owned control before dispatching any normal input.
 */
export function planBossDescriptionExpansion(raw: unknown, frame: { id: string; url: string }, sourceUrl: string): BossExpandPlan | undefined {
  try {
    projectNativeDomSnapshot(raw, frame, { readyState: "complete" }, { scope: "boss-share", sourceUrl });
    return undefined;
  } catch (error) {
    if (!(error instanceof NativeDomSnapshotError) || error.code !== "snapshot_visibility_unsupported" || error.detail !== "boss_description_collapsed") return undefined;
  }
  // The complete decoder above has already validated all table indices, backend
  // identities, strings, geometry, text ranges and full-page gate evidence.
  const table = raw as Table;
  const str = (index: number) => index === -1 ? "" : table.strings[index];
  const doc = table.documents.find(item => str(item.frameId) === frame.id)!;
  const input = doc.nodes;
  const special = new Set([...(input.shadowRootType?.index ?? []), ...(input.pseudoType?.index ?? [])]);
  const nodes: Node[] = input.nodeType.map((type, at) => {
    const pairs = input.attributes[at]; const attrs = new Map<string, string>();
    for (let index = 0; index < pairs.length; index += 2) attrs.set(str(pairs[index]), str(pairs[index + 1]));
    return { type, name: type === 1 ? str(input.nodeName[at]).toUpperCase() : str(input.nodeName[at]), parent: input.parentIndex[at], id: input.backendNodeId[at], attrs, children: [], rows: [], special: special.has(at) };
  });
  nodes.forEach((node, at) => { if (node.parent >= 0) nodes[node.parent].children.push(at); });
  const geometry = (column: (Rect | [])[] | undefined, at: number) => column?.[at]?.length === 4 ? column[at] as Rect : undefined;
  const rows: Row[] = doc.layout.nodeIndex.map((index, at) => {
    const row: Row = { bounds: doc.layout.bounds[at], styles: doc.layout.styles[at].map(str), text: str(doc.layout.text[at]), opacity: doc.layout.textColorOpacities?.[at], offset: geometry(doc.layout.offsetRects, at), client: geometry(doc.layout.clientRects, at), scroll: geometry(doc.layout.scrollRects, at), boxes: [] };
    nodes[index].rows.push(row); return row;
  });
  doc.textBoxes.layoutIndex.forEach((at, index) => {
    const bounds = doc.textBoxes.bounds[index]; const start = doc.textBoxes.start[index]; const end = start + doc.textBoxes.length[index];
    if (bounds[2] > 0 && bounds[3] > 0 && end > start) rows[at].boxes.push({ bounds, start, end });
  });
  const chain = (index: number) => { const result: number[] = []; for (let at = index; at >= 0; at = nodes[at].parent) result.push(at); return result; };
  const inBody = (index: number) => chain(index).some(at => nodes[at].name === "BODY");
  const descriptions = nodes.flatMap((node, at) => node.type === 1 && inBody(at)
    && ((node.name === "DIV" && hasClass(node, "detail-text") && node.parent >= 0 && nodes[node.parent].name === "DIV" && hasClass(nodes[node.parent], "rec-detail") && chain(node.parent).some(parent => hasClass(nodes[parent], "share-position"))) || hasClass(node, "job-sec-text")) ? [at] : []);
  if (descriptions.length !== 1) return undefined;
  const description = descriptions[0]; const descriptionNode = nodes[description]; const rec = descriptionNode.parent;
  if (!["detail-text", "show-switch", "four-lines"].every(value => hasClass(descriptionNode, value))) return undefined;
  const controls = nodes.flatMap((node, at) => node.type === 1 && node.name === "A" && hasClass(node, "link-all") && chain(at).includes(rec) ? [at] : []);
  if (controls.length !== 1) return undefined;
  const control = controls[0]; const controlNode = nodes[control];
  const controlChain = chain(control);
  // The observed share page puts this anchor directly inside its folded
  // description. No other nested clipping container receives this exception.
  const insideFold = controlNode.parent === description;
  if ((!insideFold && controlChain.includes(description)) || controlChain.slice(1, controlChain.indexOf(rec)).some(at => !(insideFold && at === description) && (hasClass(nodes[at], "rec-detail") || hasClass(nodes[at], "detail-text") || hasClass(nodes[at], "share-position")))) return undefined;
  if (controlChain.slice(1).some(at => nodes[at].name === "A" || ["button", "link", "checkbox", "radio", "switch", "textbox"].includes(nodes[at].attrs.get("role") ?? ""))) return undefined;
  // Exact observed static empty statement; do not normalize or execute JS URLs.
  if (controlNode.attrs.has("href") && !["", "#", "javascript:;"].includes(controlNode.attrs.get("href")!)) return undefined;
  if (["target", "download", "ping", "referrerpolicy"].some(name => controlNode.attrs.has(name))) return undefined;
  if (controlNode.attrs.has("role") && !["link", "button"].includes(controlNode.attrs.get("role")!)) return undefined;
  if (["title", "aria-label"].some(name => controlNode.attrs.has(name) && controlNode.attrs.get(name) !== "查看全部")) return undefined;
  if (controlNode.attrs.has("aria-controls") && (!descriptionNode.attrs.get("id") || controlNode.attrs.get("aria-controls") !== descriptionNode.attrs.get("id"))) return undefined;
  // A conflicting canonical must not cause a click before normal extraction has
  // the chance to reject it. No JSON or hidden description is used as a fallback.
  const sourceIdentity = bossIdentity(sourceUrl);
  if (!sourceIdentity || bossIdentity(frame.url) !== sourceIdentity) return undefined;
  for (const node of nodes) if (node.name === "LINK" && (node.attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) {
    if (!node.attrs.has("href") || bossIdentity(node.attrs.get("href")!) !== sourceIdentity) return undefined;
  }
  const htmls = nodes.flatMap((node, at) => node.name === "HTML" && node.parent === 0 ? [at] : []);
  if (htmls.length !== 1 || !controlChain.includes(htmls[0])) return undefined;
  const root = nodes[htmls[0]];
  const rootRow = root.rows.length === 1 ? root.rows[0] : undefined;
  if (!rootRow?.offset || !finitePositive(rootRow.offset[2]) || !finitePositive(doc.contentWidth) || !finitePositive(doc.contentHeight)) return undefined;
  const scale = rootRow.bounds[2] / rootRow.offset[2];
  if (!Number.isFinite(scale) || scale < .25 || scale > 8) return undefined;
  const epsilon = scale + 1e-6;
  const contains = (outer: Rect, inner: Rect, tolerance = epsilon) => inner[0] >= outer[0] - tolerance && inner[1] >= outer[1] - tolerance && inner[0] + inner[2] <= outer[0] + outer[2] + tolerance && inner[1] + inner[3] <= outer[1] + outer[3] + tolerance;
  const ordinaryAttrs = (node: Node) => !node.special && !excludedTags.has(node.name)
    && !(node.attrs.get("class") ?? "").split(/\s+/).some(value => excludedClass.test(value))
    && ![...node.attrs.keys()].some(name => name !== name.toLowerCase() || /^on/i.test(name) || ["hidden", "inert", "disabled", "contenteditable", "autofocus", "popover", "popovertarget"].includes(name.toLowerCase()))
    && !["aria-disabled", "aria-hidden", "aria-modal", "aria-busy"].some(name => node.attrs.has(name) && node.attrs.get(name)?.toLowerCase() !== "false")
    && !["dialog", "alertdialog", "form", "navigation", "menu", "menuitem"].includes(node.attrs.get("role") ?? "");
  const ordinaryStyles = (row: Row, isText = false, foldedParent = false) => (row.styles.length === NATIVE_SNAPSHOT_STYLES.length || (isText && row.styles.length === 0))
    && (isText && row.styles.length === 0 || (row.styles[0] !== "none" && row.styles[1] === "visible" && Number(row.styles[2]) === 1 && row.styles[3] === "visible"
      && (foldedParent
        ? ["-webkit-box", "flow-root"].includes(row.styles[0]) && ["visible", "hidden"].includes(row.styles[4]) && row.styles[5] === "hidden" && row.styles[7] === "4"
        : [row.styles[4], row.styles[5]].every(value => ["visible", "unset", "initial"].includes(value)) && ["none", "0"].includes(row.styles[7]))
      && row.styles[6] === "clip"
      && row.styles[8] === "auto" && row.styles.slice(9, 14).every(value => value === "none") && opaqueColor(row.styles[14])))
    && row.opacity === 1 && finitePositive(row.bounds[2]) && finitePositive(row.bounds[3]);
  const ordinaryElement = (index: number) => {
    const node = nodes[index];
    if (node.type !== 1 || !ordinaryAttrs(node) || node.rows.length !== 1) return false;
    const row = node.rows[0], offset = row.offset, client = row.client, scroll = row.scroll;
    if (!ordinaryStyles(row, false, insideFold && index === description) || row.text || !offset || !client || !scroll || !finitePositive(offset[2]) || !finitePositive(offset[3])) return false;
    if (Math.abs(row.bounds[2] - offset[2] * scale) > epsilon || Math.abs(row.bounds[3] - offset[3] * scale) > epsilon) return false;
    if (client[0] < 0 || client[1] < 0 || client[2] > offset[2] + 1 || client[3] > offset[3] + 1 || scroll[0] < 0 || scroll[1] < 0 || scroll[2] < client[2] || scroll[3] < client[3]) return false;
    if (!["HTML", "BODY"].includes(node.name) && (scroll[0] !== 0 || scroll[1] !== 0)) return false;
    return contains([0, 0, doc.contentWidth!, doc.contentHeight!], row.bounds);
  };
  if (!controlChain.every(at => nodes[at].type === 9 || ordinaryElement(at))) return undefined;
  const controlBounds = controlNode.rows[0].bounds;
  if (!controlChain.filter(at => nodes[at].type === 1).every(at => contains(nodes[at].rows[0].bounds, controlBounds))) return undefined;
  let foldClip: Rect | undefined;
  if (insideFold) {
    const row = descriptionNode.rows[0], client = row.client!, scroll = row.scroll!;
    if (client[0] !== 0 || client[1] !== 0 || !finitePositive(client[2]) || !finitePositive(client[3]) || scroll[0] !== 0 || scroll[1] !== 0 || scroll[3] <= client[3] + 1) return undefined;
    // CSSOM client dimensions are integral. Intersect with the snapshot box so
    // their rounding can never enlarge the proved visible region for input.
    foldClip = [row.bounds[0], row.bounds[1], Math.min(row.bounds[2], client[2] * scale), Math.min(row.bounds[3], client[3] * scale)];
    if (!contains(foldClip, controlBounds, 1e-6)) return undefined;
  }
  const withinFold = (bounds: Rect) => !foldClip || contains(foldClip, bounds, 1e-6);
  const hitIds: number[] = [];
  const rendered: string[] = [];
  const visit = (index: number): boolean => {
    const node = nodes[index];
    if (node.type === 8) return true;
    if (node.type === 1) {
      if (index !== control && (!ordinaryChildren.has(node.name) || (node.attrs.has("role") && node.attrs.get("role") !== "generic") || node.attrs.has("tabindex"))) return false;
      if (!ordinaryElement(index) || !contains(controlBounds, node.rows[0].bounds) || !withinFold(node.rows[0].bounds)) return false;
      hitIds.push(node.id);
      return node.children.every(visit);
    }
    if (node.type !== 3 || node.special || node.rows.length !== 1) return false;
    const row = node.rows[0];
    if (!ordinaryStyles(row, true) || !row.text || !row.boxes.length || !contains(controlBounds, row.bounds) || !withinFold(row.bounds)) return false;
    const ranges = [...row.boxes].sort((a, b) => a.start - b.start);
    let end = 0;
    for (const box of ranges) {
      if (!contains(controlBounds, box.bounds) || !contains(row.bounds, box.bounds) || !withinFold(box.bounds) || row.text.slice(end, box.start).length) return false;
      end = Math.max(end, box.end);
    }
    if (end !== row.text.length) return false;
    rendered.push(row.text); hitIds.push(node.id); return true;
  };
  if (!visit(control) || rendered.join("") !== "查看全部") return undefined;
  return { controlBackendNodeId: controlNode.id, descriptionBackendNodeId: descriptionNode.id, hitBackendNodeIds: hitIds };
}
