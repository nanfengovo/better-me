import { ToolError, type SourceDefinition } from "@better-me/opportunities";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { z } from "zod";
import type { SourceAdapter, SourceAdapterContext, SourceAdapterRequest, SourceJobRecord, SourceTransport } from "../contracts.js";
import { discoveryRegion, mapDiscoveryItems } from "../official-discovery-coverage.js";
import { readJobPostingJsonLd } from "../jobposting-jsonld-reader.js";
import { resolveSourceCountryCode } from "../source-country.js";
import { allocateDownloadedRecordQuota } from "./bounded-records.js";
import { baseRecord, page } from "./common.js";

// Both the board and its regional office pages are published on the employer's own domains.
const host = "apply.careers.microsoft.com";
const origin = "https://" + host;
const officeHost = "careers.microsoft.com";
const officePath = "/v2/global/en/locations/";
const searchPath = "/api/pcsx/search";
export const microsoftPcsBoard: SourceDefinition = {
  sourceId: "microsoft-eightfold-pcs", adapterId: "eightfold-pcs", adapterVersion: "1",
  name: "Microsoft Careers", capabilities: ["list-jobs"], entityType: "job-posting", runtime: ["local-service"],
  enabled: false, status: "needs-review", entryUrl: origin + searchPath + "?domain=microsoft.com", remoteFilters: [],
  endpointPolicy: { allowedHosts: [host, officeHost], allowedPathPrefixes: [searchPath, "/careers/job/", officePath], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Microsoft Careers", homepageUrl: origin + "/careers", usage: "link-only", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 300, maxPages: 3, maxRecords: 50, requestsPerMinute: 30 },
};
type ReadRequest = { source: SourceDefinition; context: SourceAdapterContext; transport: SourceTransport };
const position = z.object({
  id: z.union([z.number().int().positive().safe(), z.string().regex(/^\d{1,16}$/)]),
  positionUrl: z.string().max(250), name: z.string().trim().min(1).max(1000),
  standardizedLocations: z.array(z.string().min(1).max(500)).max(150).optional(),
});
const positions = z.object({ status: z.literal(200), data: z.object({ positions: z.array(z.unknown()).max(100), count: z.number().int().nonnegative() }) });
type Listing = { id: string; url: string; name?: string; locations?: SourceJobRecord["locations"] };
type SearchPage = { rows: Listing[]; fetched: number; total?: number; evidenceUrl: string; limited: boolean };
function detailUrl(id: string) { return origin + "/careers/job/" + id + "?hl=en"; }
async function read(url: string, type: string, access: ReadRequest) {
  access.context.throwIfCancelled();
  const result = await access.transport.request({ url, source: access.source, context: access.context, headers: { accept: type } });
  access.context.throwIfCancelled();
  if (result.status !== 200 || result.url !== url || !result.headers["content-type"]?.toLowerCase().includes(type)) throw new ToolError("source-changed");
  return result.text;
}
function locationRecord(raw: string) {
  const fields = raw.split(",").map(field => field.trim());
  // standardizedLocations lists city, optional subregion, then the ISO country. Do not guess from surrounding text.
  const countryCode = fields.length > 1 ? resolveSourceCountryCode(fields.at(-1)!) : undefined;
  return { raw, ...(countryCode ? { city: fields[0], countryCode } : {}) };
}
async function search(term: string, region: string | undefined, offset: number, access: ReadRequest): Promise<SearchPage> {
  const url = new URL(microsoftPcsBoard.entryUrl!);
  if (term) url.searchParams.set("query", term);
  if (region) url.searchParams.set("location", discoveryRegion(region).english ?? region);
  if (offset) url.searchParams.set("start", String(offset));
  const list = positions.parse(JSON.parse(await read(url.href, "application/json", access))).data;
  const rows: Listing[] = [];
  for (const item of list.positions) {
    const match = position.safeParse(item);
    if (!match.success) continue;
    const { id, name, positionUrl, standardizedLocations } = match.data;
    if (positionUrl !== "/careers/job/" + id) continue;
    rows.push({ id: String(id), name, url: detailUrl(String(id)), locations: standardizedLocations?.map(locationRecord) });
  }
  return { rows, evidenceUrl: url.href, fetched: list.positions.length, total: list.count, limited: rows.length !== list.positions.length };
}
const offices = ["shanghai", "suzhou", "beijing"] as const;
function office(region?: string) {
  const { city, country, english } = discoveryRegion(region);
  if (country !== "CN") return undefined;
  if (!city) return offices[0];
  return offices.find(name => english?.split(",")[0]?.trim().toLowerCase() === name);
}
async function officeListings(city: string, access: ReadRequest): Promise<SearchPage> {
  const url = "https://" + officeHost + officePath + city + ".html";
  const html = await read(url, "text/html", access);
  if (Buffer.byteLength(html) > 1024 * 1024) throw new ToolError("budget-exceeded");
  const pending: DefaultTreeAdapterTypes.Node[] = [parse(html)];
  const links = new Map<string, Listing>();
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node && node.tagName === "a") {
      const link = node.attrs.find(attribute => attribute.name === "href")?.value;
      const id = link?.match(/^https:\/\/apply\.careers\.microsoft\.com\/careers\/job\/(\d{1,16})(?:\?hl=en)?$/)?.[1];
      if (id) links.set(id, { id, url: detailUrl(id) });
    }
    if ("childNodes" in node) for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]!);
  }
  if (!links.size) throw new ToolError("source-changed");
  return { rows: [...links.values()].slice(0, 3), fetched: links.size, evidenceUrl: url, limited: true };
}
export async function eightfoldListings(term: string, region: string | undefined, offset: number, access: ReadRequest): Promise<SearchPage> {
  const fallbackRegion = access.source.options?.fallbackRegion;
  const city = !offset && office(region ?? (typeof fallbackRegion === "string" ? fallbackRegion : undefined));
  try {
    const listed = await search(term, region, offset, access);
    if (listed.rows.length || !city) return listed;
  } catch (error) {
    access.context.throwIfCancelled();
    if (!city) throw error;
  }
  return officeListings(city, access);
}
export async function eightfoldDetail(listing: Listing, evidenceUrl: string, access: ReadRequest): Promise<SourceJobRecord | undefined> {
  const html = await read(listing.url, "text/html", access);
  const document = readJobPostingJsonLd(html, listing.url).record;
  if (!document?.description || document.companyName !== "Microsoft" || listing.name && document.title !== listing.name) return;
  const rawExpiry = document.evidence.find(value => value.field === "source.validThrough")?.quote;
  if (rawExpiry && (!Number.isFinite(Date.parse(rawExpiry)) || Date.parse(rawExpiry) <= Date.parse(access.context.observedAt))) return;
  document.sourceRecordId = listing.id;
  document.availability = "open";
  document.availabilityBasis = "source-explicit";
  document.evidence.push({ field: "availability", selector: "employer-current-postings", quote: document.title, sourceUrl: evidenceUrl });
  return document;
}
export const eightfoldPcsAdapter: SourceAdapter = {
  adapterId: "eightfold-pcs", version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"],
  async list(request: SourceAdapterRequest) {
    if (request.source.entryUrl !== microsoftPcsBoard.entryUrl || request.cursor && !/^[1-9]\d{0,5}$/.test(request.cursor)) throw new ToolError("invalid-input");
    const offset = Number(request.cursor ?? 0);
    const region = request.scope.regions.length === 1 ? request.scope.regions[0] : undefined;
    const term = request.scope.roles.length === 1 ? request.scope.roles[0]! : "";
    const listed = await eightfoldListings(term, region, offset, request);
    const downloaded = await mapDiscoveryItems(listed.rows, 2, async row => {
      if (!row.name) return eightfoldDetail(row, listed.evidenceUrl, request);
      const result = baseRecord(row.name, listed.evidenceUrl, "data.positions[].name");
      result.companyName = "Microsoft"; result.url = row.url; result.sourceRecordId = row.id;
      result.locations = row.locations ?? [];
      result.evidence.push({ field: "companyName", selector: "employer-careers-domain", quote: host, sourceUrl: listed.evidenceUrl });
      return result;
    });
    const limit = request.source.refreshPolicy.maxRecords;
    const selected = allocateDownloadedRecordQuota(downloaded.filter((row): row is SourceJobRecord => !!row), request, limit);
    const next = offset + listed.fetched;
    const nextCursor = listed.total !== undefined && listed.fetched && next < listed.total ? String(next) : undefined;
    return page(request, selected.records, { nextCursor, totalAvailable: listed.total, fetchedRecords: listed.fetched,
      partial: listed.limited || selected.invalidRecords > 0 || downloaded.length > limit || downloaded.includes(undefined) || (!listed.fetched && offset < (listed.total ?? 0)),
      ...(listed.limited ? { warning: "微软招聘目录仅返回部分可核对职位，请查看本次职位的实际工作地点。" } : {}) });
  },
};
