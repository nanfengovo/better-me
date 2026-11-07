import { parse, type DefaultTreeAdapterMap } from "parse5";
import { SaxesParser } from "saxes";
import { ToolError } from "@better-me/opportunities";
import { JobPostingJsonLdOptionsSchema, type JobPostingJsonLdOptions } from "./jobposting-jsonld-contracts.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_URLS = 10_000;
const MAX_TOKENS = 100_000;
const SITEMAP_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9";
const LIMIT = Symbol("enumeration-limit");
const inertTags = new Set([
  "head", "script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript",
  "object", "template", "svg", "math", "canvas",
]);
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
type Enumeration = { urls: string[]; warnings: string[]; truncated: boolean };
export type SitemapIndexEnumeration = { urls: string[]; warnings: string[]; truncated: boolean; rejectedEntries: number };

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function ensureXmlBudget(text: string): void {
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new ToolError("budget-exceeded");
}

function reviewedSameOriginSitemapUrl(value: string, root: URL): string | undefined {
  if (!value || value.length > 4096 || value !== value.trim() || /[\\#\s]/u.test(value) || containsControl(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== root.origin || url.username || url.password || url.port || url.hash) return undefined;
    const rawPath = /^https:\/\/[^/?#]+([^?#]*)/i.exec(value)?.[1] ?? "";
    if (rawPath.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
    const path = decodeURIComponent(url.pathname);
    if (/[\\%]/u.test(path) || containsControl(path) || path.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
    return url.toString();
  } catch { return undefined; }
}

function hidden(tag: string, attributes: Record<string, string>): boolean {
  if (inertTags.has(tag) || Object.hasOwn(attributes, "hidden") || Object.hasOwn(attributes, "inert")
    || attributes["aria-hidden"]?.trim().toLowerCase() === "true"
    || (tag === "dialog" || tag === "details") && !Object.hasOwn(attributes, "open")) return true;
  const declarations = (attributes.style ?? "").replace(/\/\*[\s\S]*?\*\//g, "").split(";");
  return declarations.some((declaration) => {
    const colon = declaration.indexOf(":"), property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).replace(/\s*!important\s*$/i, "").trim().toLowerCase();
    return colon >= 0 && (property === "display" && value === "none" || property === "visibility" && ["hidden", "collapse"].includes(value)
      || property === "content-visibility" && value === "hidden" || property === "opacity" && /^(?:0+(?:\.0+)?|\.0+)%?$/.test(value));
  });
}

function postingUrl(value: string, baseUrl: string, options: JobPostingJsonLdOptions): string | undefined {
  if (!value || value.length > 4096 || value !== value.trim() || /[\\#\s]/u.test(value) || containsControl(value)
    || /%(?:2f|5c|2e)/i.test(value.split(/[?#]/, 1)[0]!)) return undefined;
  try {
    const url = new URL(value, baseUrl || undefined);
    if (url.protocol !== "https:" || url.origin !== new URL(options.enumerationUrls[0]!).origin || url.username || url.password || url.port || url.hash) return undefined;
    const path = decodeURIComponent(url.pathname);
    if (/[\\%]/u.test(path) || containsControl(path) || !options.postingPathPrefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) return undefined;
    return url.toString();
  } catch { return undefined; }
}

/** Enumerates observed static links only. It never executes data, follows pages, or creates a posting route. */
export function enumerateJobPostingUrls(text: string, url: string, inputOptions: JobPostingJsonLdOptions): Enumeration {
  const parsed = JobPostingJsonLdOptionsSchema.safeParse(inputOptions);
  if (!parsed.success) throw new ToolError("invalid-input");
  const options = parsed.data;
  if (options.enumerationKind === "sitemap-index") throw new ToolError("invalid-input");
  let normalizedUrl: string;
  try { normalizedUrl = new URL(url).toString(); } catch { throw new ToolError("invalid-input"); }
  if (!options.enumerationUrls.some((entry) => new URL(entry).toString() === normalizedUrl)) throw new ToolError("invalid-input");
  ensureXmlBudget(text);
  const result: Enumeration = { urls: [], warnings: [], truncated: false }, seen = new Set<string>();
  const htmlReferences: string[] = [];
  let htmlBase = normalizedUrl, htmlScanIncomplete = false;
  let candidates = 0, tokens = 0;
  const limit = () => { result.truncated = true; throw LIMIT; };
  const token = () => { if (++tokens > MAX_TOKENS) limit(); };
  const accept = (value: string, baseUrl: string) => {
    const candidate = postingUrl(value, baseUrl, options);
    if (candidate && !seen.has(candidate)) { seen.add(candidate); result.urls.push(candidate); }
  };
  const add = (value: string) => { if (++candidates > MAX_URLS) limit(); accept(value, normalizedUrl); };
  try {
    if (options.enumerationKind === "sitemap-urlset") {
      const parser = new SaxesParser({ xmlns: true });
      const stack: Array<{ local: string; uri: string }> = [];
      let namespace: string | undefined, root = false, current: { loc: boolean } | undefined, location = "";
      const changed = (): never => { throw new ToolError("source-changed"); };
      parser.on("error", changed);
      parser.on("doctype", changed);
      parser.on("processinginstruction", changed);
      parser.on("opentag", (tag) => {
        token();
        const depth = stack.length, parent = stack.at(-1);
        if (depth >= 32) limit();
        if (!depth) {
          if (root || tag.local !== "urlset" || !["", SITEMAP_NAMESPACE].includes(tag.uri)) changed();
          namespace = tag.uri; root = true;
        } else if (tag.uri === namespace) {
          if (depth === 1 && parent?.local === "urlset" && tag.local === "url") current = { loc: false };
          else if (depth === 2 && parent?.local === "url" && ["loc", "lastmod", "changefreq", "priority"].includes(tag.local)) {
            if (tag.local === "loc") { if (!current || current.loc) changed(); location = ""; }
          } else changed();
        } else if (depth < 2 || stack.some((node) => node.uri === namespace && ["loc", "lastmod", "changefreq", "priority"].includes(node.local))) changed();
        stack.push({ local: tag.local, uri: tag.uri });
      });
      const content = (value: string) => {
        token();
        const node = stack.at(-1);
        if (node?.local === "loc" && node.uri === namespace) {
          location += value;
          if (location.length > 4096) changed();
        } else if ((!node || node.uri === namespace && ["urlset", "url"].includes(node.local)) && value.trim()) changed();
      };
      parser.on("text", content);
      parser.on("cdata", content);
      parser.on("closetag", (tag) => {
        token();
        if (tag.uri === namespace && tag.local === "loc") {
          const value = location.trim();
          if (!value || !current) changed();
          current!.loc = true;
          // Sitemap loc is an absolute URL; relative references are not valid sitemap entries.
          if (!/^https:\/\//i.test(value)) changed();
          add(value);
        } else if (tag.uri === namespace && tag.local === "url") {
          if (!current?.loc) changed();
          current = undefined;
        }
        stack.pop();
      });
      parser.write(text).close();
      if (!root || stack.length) changed();
    } else {
      const document = parse(text, { scriptingEnabled: true });
      let baseSeen = false;
      const walk = (node: DefaultTreeAdapterMap["node"], depth: number, linksBlocked: boolean, baseBlocked: boolean): void => {
        token();
        if (depth >= 128) limit();
        if ("tagName" in node) {
          const foreign = node.namespaceURI !== HTML_NAMESPACE;
          const attributes = Object.fromEntries(node.attrs.filter((attribute) => !attribute.namespace && !attribute.prefix)
            .map((attribute) => [attribute.name, attribute.value]));
          // Hidden/inert attributes affect visibility, while a real HTML base still affects the document URL.
          if (node.tagName === "base" && !foreign && !baseBlocked && !baseSeen && Object.hasOwn(attributes, "href")) {
            baseSeen = true;
            try { htmlBase = new URL(attributes.href!, normalizedUrl).toString(); } catch { htmlBase = ""; }
          }
          linksBlocked ||= foreign || hidden(node.tagName, attributes);
          baseBlocked ||= foreign || node.tagName !== "head" && inertTags.has(node.tagName);
          if (node.tagName === "a" && !linksBlocked && Object.hasOwn(attributes, "href")) {
            // Continue the bounded walk after the URL allowance, so a later base is not silently missed.
            if (++candidates > MAX_URLS) result.truncated = true;
            else htmlReferences.push(attributes.href!);
          }
          if ("content" in node) walk(node.content, depth + 1, true, true);
        }
        if ("childNodes" in node) for (const child of node.childNodes) walk(child, depth + 1, linksBlocked, baseBlocked);
      };
      walk(document, 0, false, false);
    }
  } catch (error) {
    if (error !== LIMIT) { if (error instanceof ToolError) throw error; throw new ToolError("source-changed"); }
    htmlScanIncomplete = options.enumerationKind === "html-list";
  }
  if (options.enumerationKind === "html-list") {
    for (const reference of htmlReferences) {
      // An unread later base could change any relative reference; absolute HTTPS links remain grounded.
      if (htmlScanIncomplete && !/^https:\/\//i.test(reference)) continue;
      accept(reference, htmlBase);
    }
    result.warnings.push("Only observed static anchors were enumerated; dynamic jobs, linked pages, stylesheets and application scripts were not read.");
  }
  if (result.truncated) result.warnings.push("The enumeration URL, token or nesting limit was reached; additional posting links may be unread.");
  if (!result.urls.length) result.warnings.push("No reviewed static posting URLs were found; this does not establish that the company has no vacancies.");
  return result;
}

/**
 * Reads one explicitly reviewed sitemap index and returns only bounded,
 * same-origin HTTPS child URLs. It never reads a child here and never follows
 * a child sitemap index; the adapter decides whether a child is a leaf.
 */
export function enumerateSitemapIndexUrls(text: string, url: string, inputOptions: JobPostingJsonLdOptions): SitemapIndexEnumeration {
  const parsed = JobPostingJsonLdOptionsSchema.safeParse(inputOptions);
  if (!parsed.success || parsed.data.enumerationKind !== "sitemap-index") throw new ToolError("invalid-input");
  const options = parsed.data;
  let normalizedUrl: string, root: URL;
  try { normalizedUrl = new URL(url).toString(); root = new URL(normalizedUrl); } catch { throw new ToolError("invalid-input"); }
  if (!options.enumerationUrls.some((entry) => new URL(entry).toString() === normalizedUrl)) throw new ToolError("invalid-input");
  ensureXmlBudget(text);
  const result: SitemapIndexEnumeration = { urls: [], warnings: [], truncated: false, rejectedEntries: 0 }, seen = new Set<string>();
  const maxChildren = options.maxChildSitemaps ?? 20;
  let candidates = 0, tokens = 0, rootSeen = false;
  const stack: Array<{ local: string; uri: string }> = [];
  let namespace: string | undefined, current: { loc: boolean } | undefined, location = "";
  const limit = () => { result.truncated = true; throw LIMIT; };
  const token = () => { if (++tokens > MAX_TOKENS) limit(); };
  const changed = (): never => { throw new ToolError("source-changed"); };
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", changed);
  parser.on("doctype", changed);
  parser.on("processinginstruction", changed);
  parser.on("opentag", (tag) => {
    token();
    const depth = stack.length, parent = stack.at(-1);
    if (depth >= 32) limit();
    if (!depth) {
      if (rootSeen || tag.local !== "sitemapindex" || !["", SITEMAP_NAMESPACE].includes(tag.uri)) changed();
      rootSeen = true; namespace = tag.uri;
    } else if (tag.uri === namespace) {
      if (depth === 2 && parent?.local === "sitemap" && tag.local === "loc") {
        if (!current || current.loc) changed();
        location = "";
      } else if (depth === 2 && parent?.local === "sitemap" && tag.local === "lastmod") {
        // The optional timestamp is metadata only; it is not used for job dates.
      } else if (depth === 1 && parent?.local === "sitemapindex" && tag.local === "sitemap") {
        if (current) changed();
        if (++candidates > maxChildren) limit();
        current = { loc: false };
      } else if (depth === 0 && tag.local === "sitemap") {
        // A sitemap child must always be wrapped in <sitemap> at depth 1.
        changed();
      } else changed();
    } else changed();
    stack.push({ local: tag.local, uri: tag.uri });
  });
  const content = (value: string) => {
    token();
    const node = stack.at(-1);
    if (node?.local === "loc" && node.uri === namespace) {
      location += value;
      if (location.length > 4096) changed();
    } else if (node?.local === "lastmod" && node.uri === namespace) {
      // The optional timestamp is metadata only; it is not used for job dates.
    } else if (value.trim()) changed();
  };
  parser.on("text", content);
  parser.on("cdata", content);
  parser.on("closetag", (tag) => {
    token();
    if (tag.uri === namespace && tag.local === "loc") {
      const value = location.trim();
      if (!value || !current || current.loc) changed();
      current!.loc = true;
      const child = reviewedSameOriginSitemapUrl(value, root);
      if (child) {
        if (!seen.has(child)) { seen.add(child); result.urls.push(child); }
      } else {
        result.rejectedEntries++;
        result.warnings.push("A sitemap index entry was not a same-origin HTTPS leaf candidate and was ignored.");
      }
    } else if (tag.uri === namespace && tag.local === "sitemap") {
      if (!current?.loc) changed();
      current = undefined;
    }
    stack.pop();
  });
  let parserTruncated = false;
  try { parser.write(text).close(); }
  catch (error) {
    if (error === LIMIT) parserTruncated = true;
    else { if (error instanceof ToolError) throw error; throw new ToolError("source-changed"); }
  }
  if (!rootSeen || (!parserTruncated && stack.length)) changed();
  result.warnings.push("Only same-origin HTTPS sitemap entries from this reviewed root were considered; child sitemap indexes are not followed.");
  if (result.truncated) result.warnings.push("The configured child sitemap bound or parser limit was reached; additional leaf sitemaps may be unread.");
  if (!result.urls.length) result.warnings.push("The reviewed sitemap index exposed no readable same-origin leaf sitemaps; this does not establish that there are no vacancies.");
  return result;
}
