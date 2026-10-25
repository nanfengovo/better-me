import { ToolError } from "@better-me/opportunities";
import { SaxesParser } from "saxes";
import type { SourceAdapter, SourceJobRecord } from "../contracts.js";
import { SourcePageSchema } from "../contracts.js";
import { RssAtomSourceOptionsSchema } from "../rss-atom-contracts.js";
import { allocateDownloadedRecordQuota } from "./bounded-records.js";
import { baseRecord, idValue, page, plainText, publicUrl, stringValue } from "./common.js";

const MAX_ITEMS = 10_000;
const MAX_DEPTH = 64;
const MAX_TEXT = 200_000;
const ROOTS = new Set(["rss", "feed", "rdf"]);

type FeedItem = {
  id?: string;
  title?: string;
  link?: string;
  description?: string;
  published?: string;
  updated?: string;
  company?: string;
};

type Node = { name: string; text: string; href?: string; rel?: string; item?: FeedItem; index?: number };

function localName(value: string): string {
  const separator = value.lastIndexOf(":");
  return (separator >= 0 ? value.slice(separator + 1) : value).toLowerCase();
}

function attributeValue(attributes: Record<string, unknown>, name: string): string | undefined {
  const value = attributes[name] ?? attributes[name.toLowerCase()];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function feedTime(value: string | undefined): { raw?: string; at?: string } {
  const raw = value?.trim();
  if (!raw) return {};
  // RFC 822/2822 feed dates are only converted when an explicit timezone is present.
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2}|\b(?:UT|UTC|GMT|[ECMP][SD]T)\b)$/i.test(raw)
    || /[+-]\d{4}$/.test(raw);
  if (!hasTimezone) return { raw };
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? { raw, at: new Date(parsed).toISOString() } : { raw };
}

function parseFeed(xml: string): { items: FeedItem[]; truncated: boolean; root: string } {
  const items: FeedItem[] = [];
  const stack: Node[] = [];
  let root = "";
  let truncated = false;
  let sawDocumentElement = false;
  const fail = (): never => { throw new ToolError("source-changed"); };
  const parser = new SaxesParser({ xmlns: false, fragment: false });
  parser.on("error", fail);
  parser.on("doctype", fail);
  parser.on("xmldecl", () => undefined);
  parser.on("processinginstruction", fail);
  parser.on("opentag", (tag) => {
    if (stack.length >= MAX_DEPTH) throw new ToolError("budget-exceeded");
    const name = localName(tag.name);
    if (!stack.length) {
      if (sawDocumentElement || !ROOTS.has(name)) fail();
      root = name;
      sawDocumentElement = true;
    }
    const attributes = tag.attributes as Record<string, string>;
    const parent = stack.at(-1);
    const item = (name === "item" || name === "entry") && !parent?.item ? {} : parent?.item;
    const node: Node = { name, text: "", ...(item ? { item } : {}) };
    const href = attributeValue(attributes, "href");
    if (href) node.href = href;
    const rel = attributeValue(attributes, "rel");
    if (rel) node.rel = rel;
    if (item && (name === "item" || name === "entry")) node.index = items.length;
    stack.push(node);
  });
  const append = (value: string) => {
    if (!value) return;
    // Keep descendant text on its field container as well, so Atom XHTML
    // summaries/content remain readable without executing embedded markup.
    for (const node of stack) {
      if (node.text.length + value.length > MAX_TEXT) throw new ToolError("budget-exceeded");
      node.text += value;
    }
  };
  parser.on("text", append);
  parser.on("cdata", append);
  parser.on("closetag", (tag) => {
    const node = stack.pop();
    if (!node) throw new ToolError("source-changed");
    if (localName(tag.name) !== node.name) fail();
    const current = node;
    const value = plainText(current.text);
    const item = current.item;
    if (item) {
      if ((current.name === "item" || current.name === "entry")) {
        if (items.length >= MAX_ITEMS) { truncated = true; return; }
        items.push(item);
      } else if (["title"].includes(current.name) && value) item.title ??= value;
      else if (["description", "summary", "content", "encoded"].includes(current.name) && value) item.description ??= value;
      else if (["pubdate", "published", "issued", "date"].includes(current.name) && value) item.published ??= value;
      else if (["updated", "modified"].includes(current.name) && value) item.updated ??= value;
      else if (["guid", "id"].includes(current.name) && value) item.id ??= value;
      else if (["publisher", "company", "employer", "organization"].includes(current.name) && value) item.company ??= value;
      else if (current.name === "name" && stack.at(-1)?.name === "publisher" && value) item.company ??= value;
      if (current.name === "link" && (current.href || value)) {
        const rel = current.rel?.toLowerCase();
        if (!rel || rel === "alternate") item.link = current.href ?? value;
      }
    }
  });
  try { parser.write(xml).close(); } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("source-changed");
  }
  if (!sawDocumentElement || stack.length) fail();
  return { items, truncated, root };
}

function resolveLink(value: string | undefined, responseUrl: string): string | undefined {
  if (!value) return undefined;
  try { return publicUrl(new URL(value, responseUrl).toString()); } catch { return undefined; }
}

function mapItem(item: FeedItem, index: number, responseUrl: string, companyName: string | undefined): SourceJobRecord {
  const title = item.title?.trim() ?? "";
  const result = baseRecord(title, responseUrl, `items[${index}].title`);
  const url = resolveLink(item.link, responseUrl);
  const identity = idValue(item.id) ?? url;
  if (identity) result.sourceRecordId = identity;
  if (url) { result.url = url; result.applicationUrl = url; }
  result.companyName = stringValue(item.company) ?? companyName;
  if (item.description) {
    result.description = plainText(item.description);
    if (result.description) {
      result.completeness = "detail";
      result.evidence.push({ field: "description", selector: `items[${index}].description`, quote: result.description, sourceUrl: responseUrl });
    }
  }
  if (item.published) {
    const published = feedTime(item.published);
    if (published.raw) result.sourcePublishedRaw = published.raw;
    if (published.at) result.sourcePublishedAt = published.at;
    result.evidence.push({ field: "sourcePublishedRaw", selector: `items[${index}].published`, quote: published.raw ?? item.published, sourceUrl: responseUrl });
  }
  if (item.updated) {
    const updated = feedTime(item.updated);
    if (updated.raw) result.sourceUpdatedRaw = updated.raw;
    if (updated.at) result.sourceUpdatedAt = updated.at;
    result.evidence.push({ field: "sourceUpdatedRaw", selector: `items[${index}].updated`, quote: updated.raw ?? item.updated, sourceUrl: responseUrl });
  }
  result.warnings.push("RSS/Atom provides a finite feed window; locations, office coordinates, availability and controlling ownership remain unknown unless independently disclosed by another source.");
  return result;
}

/** Reads an explicitly reviewed RSS/Atom feed without following links or claiming market completeness. */
export const rssAtomAdapter: SourceAdapter = {
  adapterId: "rss-atom", version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"],
  async list(request) {
    if (request.cursor) throw new ToolError("invalid-input");
    const entryUrl = request.source.entryUrl;
    if (!entryUrl) throw new ToolError("invalid-input");
    const options = RssAtomSourceOptionsSchema.safeParse(request.source.options ?? {});
    if (!options.success) throw new ToolError("invalid-input");
    let parsedUrl: URL;
    try { parsedUrl = new URL(entryUrl); } catch { throw new ToolError("invalid-input"); }
    if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.hash) throw new ToolError("invalid-input");
    const response = await request.transport.request({ url: parsedUrl.toString(), source: request.source, context: request.context, headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9" } });
    request.context.throwIfCancelled();
    if (response.status < 200 || response.status >= 300 || response.url !== parsedUrl.toString()) throw new ToolError(response.status === 429 ? "rate-limited" : "source-changed");
    const parsed = parseFeed(response.text);
    const companyName = options.data.companyName;
    const mapped = parsed.items.map((item, index) => mapItem(item, index, response.url, companyName));
    const selected = allocateDownloadedRecordQuota(mapped, request, request.source.refreshPolicy.maxRecords);
    const dropped = mapped.filter((item) => !item.sourceRecordId).length;
    const completeRequested = options.data.enumerationComplete === true;
    const partial = parsed.truncated || mapped.length > selected.records.length || selected.invalidRecords > 0 || dropped > 0 || !completeRequested;
    const stopReason = partial ? (parsed.truncated || mapped.length > selected.records.length ? "record-limit" as const : "page-limit" as const) : undefined;
    return SourcePageSchema.parse(page(request, selected.records, {
      totalAvailable: mapped.length, fetchedRecords: parsed.items.length, ...(stopReason ? { stopReason } : {}),
      partial,
      warning: `RSS/Atom ${parsed.root} feed is bounded and does not provide platform-wide enumeration. ${dropped ? `${dropped} entries lacked a stable ID or public HTTPS link and were omitted. ` : ""}${!completeRequested ? "Set options.enumerationComplete only after reviewing the feed's own completeness claim." : ""}`,
    }));
  },
};
