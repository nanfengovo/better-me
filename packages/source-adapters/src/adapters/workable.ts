import { SourceDefinitionSchema, ToolError, deriveEntityId, type SourceDefinition } from "@better-me/opportunities";
import type { SourceAdapter, SourceJobRecord } from "../contracts.js";
import { resolveSourceCountryCode } from "../source-country.js";
import { allocateDownloadedRecordQuota } from "./bounded-records.js";
import { baseRecord, idValue, jsonResponse, page, plainText, publicUrl, record, timeValue, workMode } from "./common.js";

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const cursorToken = /^[A-Za-z0-9+/=_-]{1,1800}$/;
const endpoint = (id: string) => `https://jobs.workable.com/api/v1/companies/${id}`;
function boardLink(value: unknown, path: string): string | undefined {
  const url = publicUrl(value);
  if (!url) return;
  const parsed = new URL(url);
  return parsed.hostname === "jobs.workable.com" && parsed.pathname.startsWith(path) && parsed.pathname.length > path.length && !parsed.username && !parsed.password ? url : undefined;
}

/** Called after a Workable detail confirms its publishing tenant and public company board. */
export async function workableCompanyBoard(companyId: string, companyName: string, boardUrl: string, sources: readonly SourceDefinition[] = []): Promise<{ sourceId?: string; sourceProposal?: SourceDefinition }> {
  if (!uuid.test(companyId) || !companyName.trim() || !boardLink(boardUrl, "/company/")) return {};
  const url = endpoint(companyId);
  const prior = sources.find(source => source.adapterId === "workable" && source.entryUrl === url);
  if (prior) return { sourceId: prior.sourceId };
  const label = (companyName + " · Workable").slice(0, 240);
  return { sourceProposal: SourceDefinitionSchema.parse({
    sourceId: await deriveEntityId("source", ["workable", companyId]), name: label, adapterId: "workable", adapterVersion: "1",
    capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: false, status: "needs-review", entryUrl: url,
    options: { companyId, companyName }, remoteFilters: [], endpointPolicy: { allowedHosts: ["jobs.workable.com"], allowedPathPrefixes: [new URL(url).pathname], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label, homepageUrl: boardUrl, usage: "link-only", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 300, maxRecords: 100, maxPages: 5, requestsPerMinute: 20 },
  }) };
}
export const workableAdapter: SourceAdapter = {
  adapterId: "workable", version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"],
  async list(request) {
    const companyId = request.source.options?.companyId;
    if (typeof companyId !== "string" || !uuid.test(companyId) || request.source.entryUrl !== endpoint(companyId)) throw new ToolError("invalid-input");
    if (request.cursor && !cursorToken.test(request.cursor)) throw new ToolError("invalid-input");
    const url = new URL(endpoint(companyId));
    if (request.cursor) url.searchParams.set("pageToken", request.cursor);
    const response = await jsonResponse(request, url.href), data = record(response.data);
    if (data.id !== companyId || data.workableUid !== companyId || !Array.isArray(data.jobs) || typeof data.title !== "string" || data.isHidden === true) throw new ToolError("source-changed");
    const downloaded: SourceJobRecord[] = [];
    let skipped = 0;
    for (const [index, item] of data.jobs.entries()) {
      const job = record(item), org = record(job.company);
      const url = boardLink(job.url, "/view/"), title = plainText(job.title), id = idValue(job.id);
      if (!url || !title || !id || org.id !== companyId || job.state !== "published" || job.linkoutUrl) { skipped++; continue; }
      const selector = `jobs[${index}]`;
      const result = baseRecord(title, response.url, selector + ".title");
      result.companyName = data.title;
      result.sourceRecordId = id; result.url = url; result.workMode = workMode(job.workplace);
      const description = [job.description, job.requirementsSection].map(plainText).filter(Boolean).join("\n\n");
      if (description) { result.description = description; result.completeness = "detail"; result.evidence.push({ field: "description", selector: selector + ".description,requirementsSection", quote: description.slice(0, 20_000), sourceUrl: response.url }); }
      const place = record(job.location);
      const raw = [place.city, place.subregion, place.countryName].filter((location): location is string => typeof location === "string" && !!location.trim()).join(", ");
      if (raw) result.locations.push({ raw, ...(typeof place.city === "string" && place.city ? { city: place.city } : {}),
        ...(typeof place.countryName === "string" ? { countryCode: resolveSourceCountryCode(place.countryName) } : {}) });
      const updated = timeValue(job.updated);
      if (updated.at) { result.sourceUpdatedAt = updated.at; result.sourceUpdatedRaw = updated.raw; }
      result.evidence.push({ field: "companyName", selector: "title", quote: data.title.slice(0, 500), sourceUrl: response.url });
      downloaded.push(result);
    }
    const nextCursor = typeof data.nextPageToken === "string" && data.nextPageToken ? data.nextPageToken : undefined;
    if (nextCursor && (!cursorToken.test(nextCursor) || nextCursor === request.cursor)) throw new ToolError("source-changed");
    const limit = request.source.refreshPolicy.maxRecords;
    const selected = allocateDownloadedRecordQuota(downloaded, request, limit);
    const partial = skipped > 0 || selected.invalidRecords > 0 || downloaded.length > limit;
    return page(request, selected.records, { nextCursor, partial, fetchedRecords: data.jobs.length,
      ...(typeof data.totalSize === "number" && Number.isSafeInteger(data.totalSize) && data.totalSize >= 0 ? { totalAvailable: data.totalSize } : {}),
      ...(partial ? { warning: "部分职位缺少本企业发布依据、条目无效或已达读取上限。" } : {}) });
  },
};
