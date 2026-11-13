import type { FinalLayoutExpectedBlock, FinalLayoutExpectedDocument } from "./final-artifact";
import { FINAL_LAYOUT_LIMITS } from "./final-artifact";
import type { PrintPageSpec } from "./types";

/** Reads text/hrefs from the authorized source Template, never final-file
 * geometry. It deliberately does not infer PDF/DOCX page count or completeness. */
export function captureFinalLayoutExpectedDocument(root: HTMLElement, page: PrintPageSpec): FinalLayoutExpectedDocument {
  const view = root.ownerDocument.defaultView;
  if (!view || !root.isConnected) throw new Error("源模板尚未挂载，不能建立最终文件的正文基准。");
  const hidden = (element: Element | null) => {
    for (let current = element; current; current = current.parentElement) {
      const style = view.getComputedStyle(current);
      if (current.hasAttribute("hidden") || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden") return true;
      if (current === root) break;
    }
    return false;
  };
  if (hidden(root)) throw new Error("源模板不可观测；不会从隐藏或空根推断最终文件通过。");
  const renderedText = (element: Element) => {
    const walker = root.ownerDocument.createTreeWalker(element, 4), parts: string[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || hidden(parent) || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(parent.tagName)) continue;
      let text = node.textContent ?? ""; const transform = view.getComputedStyle(parent).textTransform;
      if (transform === "uppercase") text = text.toLocaleUpperCase(root.lang || undefined);
      else if (transform === "lowercase") text = text.toLocaleLowerCase(root.lang || undefined);
      else if (transform === "capitalize") text = text.replace(/(^|\s)(\p{L})/gu, (_all, prefix: string, letter: string) => prefix + letter.toLocaleUpperCase(root.lang || undefined));
      parts.push(text);
    }
    return parts.join("");
  };
  const bodyText = renderedText(root);
  if (!bodyText.trim() || bodyText.length > FINAL_LAYOUT_LIMITS.bodyCharacters) throw new Error("源模板正文为空或超出有界检查范围。");
  const blocks: FinalLayoutExpectedBlock[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("h1,h2,h3,p,li,footer")) {
    if (hidden(element) || element.querySelector("h1,h2,h3,p,li,footer")) continue;
    const text = renderedText(element); if (!text.trim()) continue;
    const anchor = element.closest<HTMLElement>("[data-preview-anchor]")?.dataset.previewAnchor;
    const heading = /^H[1-3]$/.test(element.tagName), claim = anchor?.startsWith("claim:");
    blocks.push({ id: `source-block-${blocks.length + 1}`, ...(anchor ? { anchor } : {}), text, kind: heading ? "heading" : claim ? "claim" : "text",
      ...(heading ? { keepWithNext: true, keepTogether: true } : {}) });
  }
  if (blocks.length > FINAL_LAYOUT_LIMITS.blocks) throw new Error("源文本块超出最终文件检查预算。");
  const links = [...root.querySelectorAll<HTMLAnchorElement>("a[href]")].filter(element => !hidden(element)).map(element => element.href);
  if (links.length > FINAL_LAYOUT_LIMITS.links) throw new Error("源链接超出最终文件检查预算。");
  return { page: JSON.parse(JSON.stringify(page)) as PrintPageSpec, bodyText, blocks, links };
}
