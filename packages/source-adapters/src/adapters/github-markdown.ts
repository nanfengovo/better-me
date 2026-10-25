import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { ToolError } from "@better-me/opportunities";
import type { SourceAdapter, SourceJobRecord } from "../contracts.js";
import { GithubMarkdownSourceOptionsSchema } from "../github-markdown-contracts.js";
import { allocateDownloadedRecordQuota } from "./bounded-records.js";
import { baseRecord, plainText, publicUrl, stringValue, timeValue } from "./common.js";
import { page } from "./common.js";

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;

type Cell = { text: string; href?: string };
type Table = { headers: string[]; rows: Cell[][]; kind: "html" | "markdown" };

const MAX_TABLES = 21;
const MAX_ROWS = 10_000;
const MAX_CELL_TEXT = 20_000;
const MAX_COLUMNS = 50;
const IGNORED_TEXT_ELEMENTS = new Set(["script", "style", "template", "noscript"]);

function normalizedHeader(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\u00a0_./:：()（）{}-]+/g, "").replace(/\[|\]/g, "").trim();
}

function textOf(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterTypes.TextNode).value;
  if (node.nodeName === "#comment") return "";
  if (IGNORED_TEXT_ELEMENTS.has(node.nodeName.toLowerCase())) return "";
  const element = node as Partial<Element>;
  if (element.childNodes === undefined) return "";
  return element.childNodes.map(textOf).join(" ");
}

function linkOf(node: Node): string | undefined {
  if (node.nodeName === "a") {
    const element = node as Element;
    return element.attrs.find((attr) => attr.name.toLowerCase() === "href")?.value;
  }
  const element = node as Partial<Element>;
  return element.childNodes?.map(linkOf).find(Boolean);
}

function elementChildren(node: Node, name: string): Element[] {
  const element = node as Partial<Element>;
  return (element.childNodes ?? []).filter((child): child is Element => child.nodeName === name);
}

function descendants(node: Node, name: string): Element[] {
  const result: Element[] = [];
  const walk = (current: Node): void => {
    if (current.nodeName === name) result.push(current as Element);
    const element = current as Partial<Element>;
    for (const child of element.childNodes ?? []) walk(child);
  };
  walk(node);
  return result;
}

function cell(node: Element): Cell {
  return { text: plainText(textOf(node)).slice(0, MAX_CELL_TEXT), ...(linkOf(node) ? { href: linkOf(node) } : {}) };
}

function parseHtmlTables(markdown: string): Table[] {
  const document = parse(markdown);
  return descendants(document, "table").slice(0, MAX_TABLES).map((table) => {
    const rows = descendants(table, "tr").slice(0, MAX_ROWS);
    const cells = rows.map((row) => {
      const values = elementChildren(row, "th").concat(elementChildren(row, "td"));
      if (values.length > MAX_COLUMNS) throw new ToolError("budget-exceeded");
      return values.map(cell);
    });
    const headerRow = cells.findIndex((row) => elementChildren(rows[cells.indexOf(row)]!, "th").length > 0);
    const index = headerRow >= 0 ? headerRow : 0;
    const headers = cells[index]?.map((value) => value.text) ?? [];
    return { headers, rows: cells.slice(index + 1), kind: "html" as const };
  }).filter((table) => table.headers.length > 0 && table.rows.length > 0);
}

function splitPipeRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return undefined;
  const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTrailing = body.endsWith("|") ? body.slice(0, -1) : body;
  const values: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of withoutTrailing) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === "|") { values.push(current.trim()); current = ""; } else current += character;
  }
  values.push(current.trim());
  return values.length > 1 ? values : undefined;
}

function parseMarkdownTables(markdown: string): Table[] {
  const tables: Table[] = [];
  let inFence = false;
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1 && tables.length < MAX_TABLES; index += 1) {
    const line = lines[index]!.trim();
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const headers = splitPipeRow(line);
    const separator = splitPipeRow(lines[index + 1]!);
    if (!headers || !separator || separator.length !== headers.length || !separator.every((value) => /^:?-{3,}:?$/.test(value.replace(/\s/g, "")))) continue;
    const rows: Cell[][] = [];
    index += 2;
    for (; index < lines.length; index += 1) {
      const values = splitPipeRow(lines[index]!);
      if (!values || values.length !== headers.length) { index -= 1; break; }
      if (values.length > MAX_COLUMNS) throw new ToolError("budget-exceeded");
      rows.push(values.map((value) => ({ text: plainText(value).slice(0, MAX_CELL_TEXT) })));
      if (rows.length >= MAX_ROWS) break;
    }
    if (rows.length) tables.push({ headers: headers.map((value) => plainText(value)), rows, kind: "markdown" });
  }
  return tables;
}

function tables(markdown: string): Table[] {
  // HTML tables are listed first because GitHub's rendered table preserves
  // links and is the stronger evidence representation.
  return [...parseHtmlTables(markdown), ...parseMarkdownTables(markdown)].slice(0, MAX_TABLES);
}

type Field = "company" | "title" | "location" | "url" | "published";
const aliases: Record<Field, readonly string[]> = {
  company: ["company", "companyname", "employer", "organization", "organisation"],
  title: ["title", "jobtitle", "position", "role", "opportunity"],
  location: ["location", "locations", "city", "region", "where"],
  url: ["url", "joburl", "posting", "postingurl", "apply", "application", "applicationlink", "link"],
  published: ["published", "publicationdate", "posted", "postdate", "date", "updated", "lastupdated", "age", "postedage"],
};

function findColumn(headers: readonly string[], field: Field, override: string | undefined): number | undefined {
  const wanted = normalizedHeader(override ?? "");
  const candidates = override ? [wanted] : aliases[field];
  return headers.findIndex((header) => candidates.includes(normalizedHeader(header))) >= 0
    ? headers.findIndex((header) => candidates.includes(normalizedHeader(header))) : undefined;
}

function rawLink(value: Cell | undefined): string | undefined {
  const markdownLink = value?.text.match(/\[[^\]]{1,500}\]\(\s*(https:\/\/[^\s)]+)\s*(?:"[^"]*")?\s*\)/i)?.[1];
  const candidate = value?.href ?? markdownLink ?? value?.text;
  return candidate ? publicUrl(candidate) : undefined;
}

function stableId(link: string): string {
  return `github-markdown-${createHash("sha256").update(link).digest("hex").slice(0, 24)}`;
}

function mapRow(table: Table, row: Cell[], index: number, responseUrl: string, columns: Record<Field, number | undefined>): SourceJobRecord | undefined {
  const title = row[columns.title ?? -1]?.text.trim();
  const url = rawLink(row[columns.url ?? -1]);
  if (!title || !url) return undefined;
  const result = baseRecord(title, responseUrl, `${table.kind}.rows[${index}].title`);
  result.entityType = "discovery-lead";
  result.completeness = "lead";
  result.sourceRecordId = stableId(url);
  result.url = url;
  result.applicationUrl = url;
  const company = stringValue(row[columns.company ?? -1]?.text);
  if (company) result.companyName = company;
  const location = stringValue(row[columns.location ?? -1]?.text);
  if (location) {
    result.locations = [{ raw: location }];
    result.evidence.push({ field: "locations", selector: `${table.kind}.rows[${index}].location`, quote: location, sourceUrl: responseUrl });
  }
  const published = stringValue(row[columns.published ?? -1]?.text);
  if (published) {
    const parsed = timeValue(published);
    result.sourcePublishedRaw = published;
    if (parsed.at) result.sourcePublishedAt = parsed.at;
    result.evidence.push({ field: "sourcePublishedRaw", selector: `${table.kind}.rows[${index}].published`, quote: published, sourceUrl: responseUrl });
  }
  result.evidence.push({ field: "url", selector: `${table.kind}.rows[${index}].url`, quote: url, sourceUrl: responseUrl });
  result.warnings.push("GitHub Markdown is a discovery lead, not proof of a current live job, exact office address, salary or controlling ownership. Follow and review the original posting before confirmation.");
  return result;
}

function rawGithubUrl(value: string): URL {
  if (!/^https:\/\/raw\.githubusercontent\.com\//i.test(value)) throw new ToolError("invalid-input");
  let url: URL;
  try { url = new URL(value); } catch { throw new ToolError("invalid-input"); }
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "raw.githubusercontent.com" || url.port || url.username || url.password || url.search || url.hash || parts.length < 4) throw new ToolError("invalid-input");
  return url;
}

/** Reads a reviewed raw.githubusercontent.com README table as discovery leads. */
export const githubMarkdownAdapter: SourceAdapter = {
  adapterId: "github-markdown", version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["discovery-lead"],
  async list(request) {
    if (request.cursor || !request.source.entryUrl) throw new ToolError("invalid-input");
    const entryUrl = rawGithubUrl(request.source.entryUrl);
    const options = GithubMarkdownSourceOptionsSchema.safeParse(request.source.options ?? {});
    if (!options.success) throw new ToolError("invalid-input");
    const response = await request.transport.request({ url: entryUrl.toString(), source: request.source, context: request.context, headers: { accept: "text/plain, text/markdown;q=0.9" } });
    request.context.throwIfCancelled();
    if (response.status < 200 || response.status >= 300 || response.url !== entryUrl.toString()) throw new ToolError(response.status === 429 ? "rate-limited" : "source-changed");
    const available = tables(response.text);
    const table = available[options.data.tableIndex];
    if (!table) throw new ToolError("source-changed");
    const columns = {
      company: findColumn(table.headers, "company", options.data.companyHeader),
      title: findColumn(table.headers, "title", options.data.titleHeader),
      location: findColumn(table.headers, "location", options.data.locationHeader),
      url: findColumn(table.headers, "url", options.data.urlHeader),
      published: findColumn(table.headers, "published", options.data.publishedHeader),
    } satisfies Record<Field, number | undefined>;
    if (columns.title === undefined || columns.url === undefined) throw new ToolError("source-changed");
    const mapped = table.rows.map((row, index) => mapRow(table, row, index, response.url, columns));
    const seen = new Set<string>();
    const unique = mapped.filter((value): value is SourceJobRecord => {
      if (!value?.url || seen.has(value.url)) return false;
      seen.add(value.url);
      return true;
    });
    const duplicateCount = mapped.filter((value): value is SourceJobRecord => value !== undefined).length - unique.length;
    const selected = allocateDownloadedRecordQuota(unique, request, request.source.refreshPolicy.maxRecords);
    const skipped = mapped.length - selected.records.length - selected.invalidRecords;
    const partial = !options.data.enumerationComplete || skipped > 0 || selected.invalidRecords > 0 || mapped.length > selected.records.length;
    return page(request, selected.records, {
      fetchedRecords: table.rows.length,
      totalAvailable: table.rows.length,
      partial,
      stopReason: partial ? (mapped.length > selected.records.length ? "record-limit" : "page-limit") : undefined,
      warning: [
        "GitHub Raw Markdown was read from one reviewed file; the repository and linked job pages were not crawled.",
        "Rows without a stable HTTPS original posting link were omitted; duplicate original links were collapsed.",
        ...(duplicateCount ? [`${duplicateCount} duplicate original links were collapsed.`] : []),
        ...(!options.data.enumerationComplete ? ["The source does not claim complete or current market enumeration."] : []),
      ].join(" "),
    });
  },
};
