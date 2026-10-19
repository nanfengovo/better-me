import { z } from "zod";
import { SourceDefinitionSchema, ToolError, type SourceDefinition } from "@better-me/opportunities";
import { plainText, publicUrl } from "./adapters/common.js";
import type { CareerWebSearchProvider } from "./career-discovery.js";
import { CareerWebSearchResultSchema, type CareerWebSearchResult } from "./career-discovery-contracts.js";

function searchEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname);
    return Boolean(publicUrl(value)) && !url.username && !url.password && !url.search && !url.hash
      && !url.hostname.endsWith(".") && !/[\\%]/.test(path) && !Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
      && !/(?:^|\.)(?:invalid|test)$/.test(url.hostname);
  } catch { return false; }
}
/** Host configuration only. Tool inputs cannot select providers, endpoints or credentials. */
export const CareerWebSearchConfigSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("duckduckgo-html") }).strict(),
  z.object({ provider: z.literal("searxng"), endpoint: z.string().min(1).max(2048).refine(searchEndpoint, "Use a public HTTPS search endpoint without credentials, query or fragment.") }).strict(),
]);
export type CareerWebSearchConfig = z.infer<typeof CareerWebSearchConfigSchema>;

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
const RESPONSE_LIMIT = 2 * 1024 * 1024;
function policy(endpoint: URL, label: string): SourceDefinition {
  return SourceDefinitionSchema.parse({
    sourceId: "host-career-web-search", name: label, adapterId: "career-web-search", adapterVersion: "1",
    capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active",
    entryUrl: endpoint.toString(), remoteFilters: [],
    endpointPolicy: { allowedHosts: [endpoint.hostname], allowedPathPrefixes: [endpoint.pathname], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label, homepageUrl: endpoint.origin, usage: "link-only", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 20, maxPages: 1, requestsPerMinute: 6 },
  });
}
function decode(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
    const key = entity.toLowerCase();
    if (named[key]) return named[key]!;
    const code = key.startsWith("&#x") ? Number.parseInt(key.slice(3, -1), 16) : Number(key.slice(2, -1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}
function attributes(value: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const expression = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of value.matchAll(expression)) {
    const name = match[1]!.toLowerCase();
    if (Object.hasOwn(result, name)) throw new ToolError("source-changed");
    result[name] = decode(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}
type Anchor = { href: string; classes: string[]; text: string };
/** Inert bounded tokens, with quote-aware tag boundaries and blocked executable subtrees. */
function anchors(html: string): { items: Anchor[]; empty: boolean } {
  const found: Anchor[] = [];
  const frames: { name: string; blocked: boolean; raw: boolean; empty: boolean }[] = [];
  const rawTags = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
  const inertTags = new Set(["template", "object", "svg", "math", "noscript"]);
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  let cursor = 0, tags = 0, empty = false;
  let pending: { attributes: Record<string, string>; text: string } | undefined;
  const text = (value: string) => {
    if (frames.at(-1)?.blocked) return;
    if (pending) pending.text += decode(value);
    if (frames.some(frame => frame.empty) && decode(value).trim()) empty = true;
  };
  while (cursor < html.length) {
    const frame = frames.at(-1);
    if (frame?.raw) {
      if (frame.name === "plaintext") break;
      // A space after </ is literal raw text, not an HTML closing tag. Unsupported
      // malformed endings stay blocked rather than exposing text as result anchors.
      const close = new RegExp(`</${frame.name}\\s*>`, "ig");
      close.lastIndex = cursor;
      const match = close.exec(html);
      if (!match) throw new ToolError("source-changed");
      cursor = close.lastIndex; frames.pop(); continue;
    }
    const start = html.indexOf("<", cursor);
    if (start < 0) { text(html.slice(cursor)); break; }
    text(html.slice(cursor, start));
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      if (end < 0) throw new ToolError("source-changed");
      cursor = end + 3; continue;
    }
    if (++tags > 20_000 || found.length > 2000 || frames.length > 256) throw new ToolError("budget-exceeded");
    let end = start + 1, quote = "";
    for (; end < html.length && end - start <= 8192; end++) {
      const char = html[end]!;
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end >= html.length || end - start > 8192) throw new ToolError("source-changed");
    const tag = html.slice(start + 1, end).match(/^(\/?)([a-z][\w:-]*)([\s\S]*)$/i);
    cursor = end + 1;
    if (!tag) continue;
    const closing = Boolean(tag[1]), name = tag[2]!.toLowerCase();
    if (closing) {
      const index = frames.map(item => item.name).lastIndexOf(name);
      // This bounded reader does not implement browser error recovery. In particular,
      // an outer closing tag inside a template/hidden subtree cannot escape that scope.
      if (index >= 0 && frames.slice(index + 1).some(item => item.blocked)) throw new ToolError("source-changed");
      if (name === "a" && pending && !frames.at(-1)?.blocked) {
        const attr = pending.attributes;
        if (attr.href && attr.class) found.push({ href: attr.href, classes: attr.class.split(/\s+/), text: pending.text.replace(/\s+/g, " ").trim().slice(0, 2000) });
        pending = undefined;
      }
      if (index >= 0) frames.splice(index);
      continue;
    }
    const attr = attributes(tag[3]!);
    const classes = (attr.class ?? "").split(/\s+/);
    const blocked = Boolean(frames.at(-1)?.blocked) || rawTags.has(name) || inertTags.has(name)
      || Object.hasOwn(attr, "hidden") || attr["aria-hidden"]?.toLowerCase() === "true"
      || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/i.test(attr.style ?? "");
    if (name === "a" && !blocked) {
      if (pending) throw new ToolError("source-changed");
      pending = { attributes: attr, text: "" };
    }
    // HTML ignores a self-closing slash on non-void elements, including script,
    // textarea, template and hidden divs. Keep their full contents inside the scope.
    if (!voidTags.has(name)) frames.push({ name, blocked, raw: rawTags.has(name), empty: !blocked && classes.some(value => /^no-results(?:$|__|-)/.test(value)) });
  }
  if (pending) throw new ToolError("source-changed");
  return { items: found, empty };
}
function destination(value: string): string | undefined {
  if (value.includes("\\") || Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return undefined;
  try {
    let url = new URL(value, DDG_ENDPOINT);
    if (["duckduckgo.com", "html.duckduckgo.com"].includes(url.hostname)) {
      if (url.pathname !== "/l/" || !url.searchParams.get("uddg")) return undefined;
      url = new URL(url.searchParams.get("uddg")!);
    }
    if (url.username || url.password || url.hostname.endsWith(".")) return undefined;
    url.hash = "";
    return publicUrl(url.toString());
  } catch { return undefined; }
}
function duckDuckGo(html: string, evidenceUrl: string, limit: number): CareerWebSearchResult {
  if (/(?:anomaly\.js|challenge-form|anomaly-modal|bots use DuckDuckGo too|verify you are (?:a )?human|g-recaptcha|hcaptcha)/i.test(html)) throw new ToolError("needs-auth");
  if (!/<html\b/i.test(html)) throw new ToolError("source-changed");
  const scan = anchors(html), items = scan.items, results: CareerWebSearchResult["results"] = [];
  const seen = new Set<string>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (!item.classes.includes("result__a")) continue;
    const url = destination(item.href);
    if (!url || !item.text.trim() || seen.has(url)) continue;
    seen.add(url);
    let snippet: string | undefined;
    for (let next = index + 1; next < Math.min(items.length, index + 12); next++) {
      const related = items[next]!;
      if (related.classes.includes("result__a")) break;
      if (related.classes.includes("result__snippet") && destination(related.href) === url) { snippet = related.text; break; }
    }
    results.push({ url, title: item.text.slice(0, 500), ...(snippet ? { snippet: snippet.slice(0, 1000) } : {}), evidenceUrl });
    if (results.length >= limit) break;
  }
  // A challenge, changed markup or dropped unsafe results must not masquerade as an empty search.
  if (!results.length && !scan.empty) throw new ToolError("source-changed");
  return { results, partial: true };
}
const SearxResultsSchema = z.object({
  results: z.array(z.object({ url: z.string(), title: z.string().optional(), content: z.string().optional() }).passthrough()).max(1000),
  unresponsive_engines: z.array(z.unknown()).optional(),
}).passthrough();
function searxng(text: string, evidenceUrl: string, limit: number): CareerWebSearchResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ToolError("source-changed"); }
  const parsed = SearxResultsSchema.safeParse(raw);
  if (!parsed.success || (!parsed.data.results.length && parsed.data.unresponsive_engines?.length)) throw new ToolError("source-changed");
  const results: CareerWebSearchResult["results"] = [], seen = new Set<string>();
  for (const item of parsed.data.results) {
    const url = destination(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({ url, ...(item.title ? { title: plainText(item.title).slice(0, 500) } : {}), ...(item.content ? { snippet: plainText(item.content).slice(0, 1000) } : {}), evidenceUrl });
    if (results.length >= limit) break;
  }
  if (parsed.data.results.length && !results.length) throw new ToolError("source-changed");
  return { results, partial: true };
}

/** Each query makes one GET through the existing pinned, bounded public-endpoint transport. */
export function createCareerWebSearchProvider(config: CareerWebSearchConfig): CareerWebSearchProvider {
  const parsed = CareerWebSearchConfigSchema.safeParse(config);
  if (!parsed.success) throw new ToolError("invalid-context");
  const provider = parsed.data;
  const metadata = Object.freeze({ providerId: provider.provider, label: provider.provider === "duckduckgo-html" ? "DuckDuckGo HTML" : "SearXNG" });
  const endpoint = new URL(provider.provider === "duckduckgo-html" ? DDG_ENDPOINT : provider.endpoint);
  const source = policy(endpoint, metadata.label);
  return Object.freeze({ metadata, async search(input) {
    input.context.throwIfCancelled();
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20 || !input.query.trim() || input.query.length > 500) throw new ToolError("invalid-input");
    const url = new URL(endpoint);
    url.searchParams.set("q", input.query);
    if (provider.provider === "searxng") { url.searchParams.set("format", "json"); url.searchParams.set("pageno", "1"); url.searchParams.set("categories", "general"); }
    const response = await input.transport.request({ url: url.toString(), source, context: input.context, headers: { accept: provider.provider === "searxng" ? "application/json" : "text/html,application/xhtml+xml;q=0.9" } });
    input.context.throwIfCancelled();
    if (response.status === 429) throw new ToolError("rate-limited");
    if ([401, 403].includes(response.status)) throw new ToolError("needs-auth");
    if (response.status < 200 || response.status >= 300 || response.url !== url.toString()) throw new ToolError("source-changed");
    if (new TextEncoder().encode(response.text).byteLength > RESPONSE_LIMIT) throw new ToolError("budget-exceeded");
    const type = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (type && !(provider.provider === "searxng" ? ["application/json", "text/json"] : ["text/html", "application/xhtml+xml"]).includes(type)) throw new ToolError("source-changed");
    return CareerWebSearchResultSchema.parse(provider.provider === "duckduckgo-html" ? duckDuckGo(response.text, url.toString(), input.limit) : searxng(response.text, url.toString(), input.limit));
  } });
}
