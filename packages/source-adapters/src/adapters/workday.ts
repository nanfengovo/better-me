import { createHash } from "node:crypto";
import { z } from "zod";
import { CountryCodeSchema, includesSearchText, ToolError } from "@better-me/opportunities";
import { SourceJobRecordSchema, SourcePageSchema, type SourceAdapter, type SourceAdapterDetailRequest, type SourceAdapterRequest, type SourceJobRecord } from "../contracts.js";
import { WorkdaySourceOptionsSchema } from "../workday-contracts.js";
import { SourceTransportError } from "../transport.js";
import { assessSourceScopeMatch } from "../local-match.js";
import { baseRecord, jsonResponse, page, plainText, record } from "./common.js";

const CursorSchema = z.object({ version: z.literal(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), termIndex: z.number().int().min(0).max(12), offset: z.number().int().min(0).max(1_000_000) }).strict();
const MAX_TERMS = 12, MAX_TERM_LENGTH = 80;
type WorkdayRequest = Pick<SourceAdapterRequest, "source" | "context" | "transport">;
// Workday requisition IDs use several tenant-specific prefixes (for example
// REQ-, JR-, or R-). Keep the accepted value path-safe without assuming one tenant.
function isRequisitionId(value: unknown): value is string {
  return typeof value === "string" && /^_?(?:REQ|JR|R)[A-Za-z0-9_-]{1,80}$/i.test(value);
}

function configured(request: WorkdayRequest) {
  const options = WorkdaySourceOptionsSchema.safeParse(request.source.options ?? {});
  if (!options.success || !request.source.entryUrl) throw new ToolError("invalid-input");
  let siteUrl: URL;
  try { siteUrl = new URL(request.source.entryUrl); } catch { throw new ToolError("invalid-input"); }
  // Workday's public career URL is /{site}; the tenant appears in the CXS API route.
  const expectedPath = `/${options.data.site}`;
  if (siteUrl.protocol !== "https:" || siteUrl.username || siteUrl.password || siteUrl.port || siteUrl.pathname !== expectedPath || siteUrl.search || siteUrl.hash
    || request.source.endpointPolicy.allowedHosts.length !== 1 || request.source.endpointPolicy.allowedHosts[0] !== siteUrl.hostname
    || !request.source.endpointPolicy.requireHttps || request.source.endpointPolicy.allowedPathPrefixes.length !== 1 || request.source.endpointPolicy.allowedPathPrefixes[0] !== `/wday/cxs/${options.data.tenant}/${options.data.site}`
    || request.source.endpointPolicy.allowRedirects || request.source.endpointPolicy.maxRedirects !== 0 || !request.source.remoteFilters.includes("roles")) throw new ToolError("invalid-input");
  return { ...options.data, origin: siteUrl.origin };
}
function endpoint(options: { tenant: string; site: string; origin: string }, suffix: string) { return `${options.origin}/wday/cxs/${options.tenant}/${options.site}${suffix}`; }
function canonicalPostingUrl(externalPath: unknown, options: { tenant: string; site: string; origin: string }): string | undefined {
  if (typeof externalPath !== "string" || /[\\%\s\p{Cc}\p{Cs}]/u.test(externalPath)) return undefined;
  try {
    const prefix = `/${options.site}/job/`;
    let url: URL;
    if (/^https:\/\//i.test(externalPath)) {
      const authority = /^https:\/\/([^/]+)/i.exec(externalPath)?.[1];
      if (!authority || authority.toLowerCase() !== new URL(options.origin).host.toLowerCase()) return undefined;
      url = new URL(externalPath);
    }
    else {
      if (!externalPath.startsWith("/job/")) return undefined;
      url = new URL(`/${options.site}${externalPath}`, options.origin);
    }
    if (url.origin !== options.origin || url.username || url.password || url.port || url.search || url.hash || !url.pathname.startsWith(prefix)
      || !/^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(url.pathname.slice(prefix.length))) return undefined;
    return url.toString();
  } catch { return undefined; }
}
function text(value: unknown, maximum = 20_000): string { return plainText(value).slice(0, maximum); }
function available(job: SourceJobRecord, posted: unknown, canApply: unknown, sourceUrl: string) {
  if (typeof posted === "boolean") job.evidence.push({ field: "source.posted", selector: "jobPostingInfo.posted", quote: String(posted), sourceUrl });
  if (typeof canApply === "boolean") job.evidence.push({ field: "source.canApply", selector: "jobPostingInfo.canApply", quote: String(canApply), sourceUrl });
  if (posted === true && canApply === true) { job.availability = "open"; job.availabilityBasis = "detail-explicit"; }
  else if (posted === false || canApply === false) job.warnings.push("Workday does not currently mark this posting as both posted and applicable; availability remains unknown.");
}
function applyDetail(job: SourceJobRecord, payload: unknown, responseUrl: string, options: { tenant: string; reqId: string; site: string; postingUrl: string }) {
  const root = record(payload), detail = record(root.jobPostingInfo), reqId = detail.jobReqId;
  if (reqId !== options.reqId || typeof detail.jobPostingId !== "string" || !detail.jobPostingId.endsWith(`_${options.reqId}`)
    || detail.jobPostingSiteId !== options.site || canonicalPostingUrl(detail.externalUrl, { tenant: options.tenant, site: options.site, origin: new URL(options.postingUrl).origin }) !== options.postingUrl) throw new ToolError("source-changed");
  const title = text(detail.title, 1000), description = text(detail.jobDescription, 2_000_000);
  if (!title) throw new ToolError("source-changed");
  job.title = title; job.evidence.push({ field: "title", selector: "jobPostingInfo.title", quote: title, sourceUrl: responseUrl });
  job.evidence.push({ field: "sourceRecordId", selector: "jobPostingInfo.jobReqId", quote: options.reqId, sourceUrl: responseUrl },
    { field: "sourceRecordId", selector: "jobPostingInfo.jobPostingId", quote: detail.jobPostingId, sourceUrl: responseUrl },
    { field: "url", selector: "jobPostingInfo.externalUrl", quote: options.postingUrl, sourceUrl: responseUrl });
  if (description) {
    job.description = description; job.completeness = "detail";
    job.evidence.push({ field: "description", selector: "jobPostingInfo.jobDescription", sourceUrl: responseUrl });
  }
  const location = text(detail.location, 1000) || text(detail.jobRequisitionLocation && record(detail.jobRequisitionLocation).descriptor, 1000);
  if (location) {
    const alpha2Code = CountryCodeSchema.safeParse(record(detail.country).alpha2Code);
    job.locations = [{ raw: location, ...(alpha2Code.success ? { countryCode: alpha2Code.data } : {}) }];
    job.evidence.push({ field: "locations", selector: "jobPostingInfo.location", quote: location, sourceUrl: responseUrl });
    if (alpha2Code.success) job.evidence.push({ field: "locations.countryCode", selector: "jobPostingInfo.country.alpha2Code", quote: alpha2Code.data, sourceUrl: responseUrl });
  }
  if (detail.remoteType === "On-site") job.workMode = "on-site";
  else if (detail.remoteType === "Hybrid") job.workMode = "hybrid";
  else if (detail.remoteType === "Remote") job.workMode = "remote";
  if (typeof detail.remoteType === "string") job.evidence.push({ field: "workMode", selector: "jobPostingInfo.remoteType", quote: detail.remoteType, sourceUrl: responseUrl });
  const posted = text(detail.postedOn, 1000);
  if (posted) { job.sourcePublishedRaw = posted; job.evidence.push({ field: "sourcePublishedRaw", selector: "jobPostingInfo.postedOn", quote: posted, sourceUrl: responseUrl }); }
  available(job, detail.posted, detail.canApply, responseUrl);
  for (const [key, value] of [["canApply", detail.canApply], ["endDate", detail.endDate], ["timeType", detail.timeType]] as const) if (typeof value === "string" || typeof value === "boolean") {
    job.evidence.push({ field: `source.${key}`, selector: `jobPostingInfo.${key}`, quote: String(value).slice(0, 1000), sourceUrl: responseUrl });
  }
  const employer = text(record(root.hiringOrganization).name, 500);
  if (employer) { job.companyName = employer; job.evidence.push({ field: "companyName", selector: "hiringOrganization.name", quote: employer, sourceUrl: responseUrl }); }
}
async function readExact(request: SourceAdapterDetailRequest): Promise<SourceJobRecord> {
  request.context.throwIfCancelled();
  const options = configured(request);
  if (!isRequisitionId(request.sourceRecordId)) throw new ToolError("invalid-input");
  const canonical = canonicalPostingUrl(request.url, options);
  if (!canonical || canonical !== request.url) throw new ToolError("invalid-input");
  const detailUrl = endpoint(options, `/job/${new URL(canonical).pathname.split("/job/")[1]}`);
  const response = await jsonResponse(request, detailUrl);
  if (response.url !== detailUrl) throw new ToolError("source-changed");
  const root = record(response.data), info = record(root.jobPostingInfo);
  if (info.jobReqId !== request.sourceRecordId || info.jobPostingSiteId !== options.site || canonicalPostingUrl(info.externalUrl, options) !== canonical) throw new ToolError("source-changed");
  const title = text(info.title, 1000); if (!title) throw new ToolError("source-changed");
  const job = baseRecord(title, response.url, "jobPostingInfo.title");
  job.sourceRecordId = request.sourceRecordId; job.url = canonical; job.applicationUrl = canonical;
  applyDetail(job, response.data, response.url, { tenant: options.tenant, reqId: request.sourceRecordId, site: options.site, postingUrl: canonical });
  const parsed = SourceJobRecordSchema.safeParse(job);
  request.context.throwIfCancelled();
  if (!parsed.success || parsed.data.url !== canonical || parsed.data.sourceRecordId !== request.sourceRecordId) throw new ToolError("source-changed");
  return parsed.data;
}

/** Fixed public Workday CXS tenant adapter. POST is limited to anonymous JSON search/list requests. */
export const workdayAdapter: SourceAdapter = {
  adapterId: "workday-cxs", version: "1", capabilities: ["list-jobs"], remoteFilters: ["roles"], entityTypes: ["job-posting"],
  readDetail: readExact,
  async list(request) {
    const options = configured(request);
    const roles = [...new Set(request.scope.roles.map(value => value.trim()).filter(Boolean))];
    if (roles.length > MAX_TERMS || roles.some(value => value.length > MAX_TERM_LENGTH || /[\p{Cc}\p{Cs}]/u.test(value))) throw new ToolError("invalid-input");
    let offset = 0;
    const terms = roles.length ? roles : [""];
    // The job service narrows refreshPolicy.maxRecords to the remaining run quota
    // before each page. Cursor identity must cover persisted source configuration,
    // not that temporary host budget, or page two would always look stale.
    const refreshPolicy = Object.fromEntries(Object.entries(request.source.refreshPolicy).filter(([key]) => key !== "maxRecords"));
    const fingerprint = createHash("sha256").update(JSON.stringify({
      sourceId: request.source.sourceId, adapterId: request.source.adapterId, adapterVersion: request.source.adapterVersion,
      entryUrl: request.source.entryUrl, options: request.source.options, endpointPolicy: request.source.endpointPolicy,
      refreshPolicy, remoteFilters: request.source.remoteFilters, scope: request.scope, terms,
    })).digest("hex");
    let termIndex = 0;
    if (request.cursor) {
      let parsed: z.infer<typeof CursorSchema>;
      try { parsed = CursorSchema.parse(JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"))); } catch { throw new ToolError("invalid-input"); }
      if (parsed.fingerprint !== fingerprint || parsed.termIndex >= terms.length) throw new ToolError("invalid-input");
      offset = parsed.offset; termIndex = parsed.termIndex;
    }
    const term = terms[termIndex]!;
    const limit = Math.min(options.pageSize, request.source.refreshPolicy.maxRecords);
    const body = JSON.stringify({ appliedFacets: {}, limit, offset, searchText: term });
    const listUrl = endpoint(options, "/jobs");
    const response = await jsonResponse(request, listUrl, { method: "POST", jsonBody: body });
    if (response.url !== listUrl) throw new ToolError("source-changed");
    const payload = record(response.data), rows = payload.jobPostings;
    if (!Array.isArray(rows) || typeof payload.total !== "number" || !Number.isSafeInteger(payload.total) || payload.total < rows.length || payload.total > 1_000_000_000) throw new ToolError("source-changed");
    if (typeof payload.searchText === "string" && payload.searchText !== term) throw new ToolError("source-changed");
    const total = payload.total, jobs: SourceJobRecord[] = [], invalidReqIds = new Set<string>(), seenReqIds = new Set<string>();
    for (const [index, rowValue] of rows.slice(0, limit).entries()) {
      request.context.throwIfCancelled();
      const row = record(rowValue), req = Array.isArray(row.bulletFields) ? row.bulletFields.find(isRequisitionId) : undefined;
      const reqId = req ?? (isRequisitionId(row.jobReqId) ? row.jobReqId : undefined);
      const url = canonicalPostingUrl(row.externalPath, options), title = text(row.title, 1000);
      if (!reqId || !url || !title || seenReqIds.has(reqId)) { invalidReqIds.add(String(index)); continue; }
      seenReqIds.add(reqId);
      const job = baseRecord(title, response.url, `jobPostings[${index}].title`);
      job.sourceRecordId = reqId; job.url = url; job.applicationUrl = url;
      job.evidence.push(
        { field: "sourceRecordId", selector: `jobPostings[${index}].bulletFields`, quote: reqId, sourceUrl: response.url },
        { field: "url", selector: `jobPostings[${index}].externalPath`, quote: url, sourceUrl: response.url },
      );
      const location = text(row.locationsText, 1000);
      if (location) {
        job.locations = [{ raw: location }];
        job.evidence.push({ field: "locations", selector: `jobPostings[${index}].locationsText`, quote: location, sourceUrl: response.url });
      }
      const posted = text(row.postedOn, 1000);
      if (posted) { job.sourcePublishedRaw = posted; job.evidence.push({ field: "sourcePublishedRaw", selector: `jobPostings[${index}].postedOn`, quote: posted, sourceUrl: response.url }); }
      const workType = text(row.remoteType, 100);
      if (workType === "On-site") job.workMode = "on-site"; else if (workType === "Hybrid") job.workMode = "hybrid"; else if (workType === "Remote") job.workMode = "remote";
      if (workType) job.evidence.push({ field: "workMode", selector: `jobPostings[${index}].remoteType`, quote: workType, sourceUrl: response.url });
      jobs.push(job);
    }
    let detailed = 0, failures = 0, timedOut = false, stoppedOnProviderLimit = false;
    const candidates = jobs.map((job, index) => ({ job, index, match: assessSourceScopeMatch(job, request.scope) }))
      .filter(({ job }) => {
        // Company and country/city are frequently absent from Workday list rows.
        // Keep such records eligible for the bounded exact-detail allowance; the
        // job service still applies the strict shared scope match after enrichment.
        const companyMatches = !job.companyName || !request.scope.companyNames.length
          || request.scope.companyNames.some(term => includesSearchText(job.companyName!, term));
        const knownCountries = job.locations.flatMap(location => location.countryCode ? [location.countryCode] : []);
        const countryMatches = !knownCountries.length || !request.scope.countryCodes?.length
          || knownCountries.some(country => request.scope.countryCodes!.includes(country));
        const hasLocationText = job.locations.length > 0;
        const regionMatches = !hasLocationText || !request.scope.regions.length
          || request.scope.regions.some(term => CountryCodeSchema.safeParse(term).success
            ? job.locations.some(location => location.countryCode === term)
            : includesSearchText(job.locations.map(location => [location.raw, location.region, location.city].filter(Boolean).join(" ")).join(" "), term));
        const locationMatches = countryMatches && regionMatches;
        return companyMatches && locationMatches;
      }).sort((a, b) => Number(a.match.roleMatch) - Number(b.match.roleMatch) || a.index - b.index);
    let detailAttempted = 0;
    for (const { job } of candidates.slice(0, options.maxDetailRequestsPerPage)) {
      request.context.throwIfCancelled();
      try {
        const detailUrl = endpoint(options, `/job/${new URL(job.url!).pathname.split(`/job/`)[1]}`);
        const detailResponse = await jsonResponse(request, detailUrl);
        if (detailResponse.url !== detailUrl) throw new ToolError("source-changed");
        applyDetail(job, detailResponse.data, detailResponse.url, { tenant: options.tenant, reqId: job.sourceRecordId!, site: options.site, postingUrl: job.url! }); detailed++; detailAttempted++;
      }
      catch (error) {
        detailAttempted++;
        request.context.throwIfCancelled();
        if (error instanceof SourceTransportError && error.code === "timeout") { timedOut = true; failures++; break; }
        if (error instanceof SourceTransportError && ["rate-limited", "response-too-large"].includes(error.code)) { stoppedOnProviderLimit = true; failures++; break; }
        if (error instanceof ToolError && error.code === "source-changed"
          || error instanceof SourceTransportError && ["http-error", "response-too-large", "invalid-response"].includes(error.code) && error.status !== 401 && error.status !== 403) { failures++; continue; }
        throw error;
      }
    }
    const linked = jobs.filter(job => !!job.url);
    const invalid = invalidReqIds.size + jobs.length - linked.length;
    const expectedMore = offset + rows.length < total, nextOffset = offset + rows.length;
    const inconsistentPage = rows.length < limit && expectedMore, oversizedPage = rows.length > limit;
    const nextTermIndex = expectedMore ? termIndex : termIndex + 1;
    const nextCursor = !oversizedPage && !inconsistentPage && !timedOut && !stoppedOnProviderLimit && (expectedMore || nextTermIndex < terms.length)
      ? Buffer.from(JSON.stringify({ version: 1, fingerprint, termIndex: nextTermIndex, offset: expectedMore ? nextOffset : 0 })).toString("base64url") : undefined;
    const incompleteDetails = detailAttempted < candidates.length;
    const continuation = timedOut ? undefined : nextCursor;
    const result = page(request, linked, { totalAvailable: roles.length === 1 ? total : undefined, fetchedRecords: rows.length, ...(continuation ? { nextCursor: continuation } : {}),
      partial: oversizedPage || inconsistentPage || invalid > 0 || failures > 0 || incompleteDetails || timedOut || stoppedOnProviderLimit || expectedMore || nextTermIndex < terms.length, stopReason: timedOut || stoppedOnProviderLimit || failures > 0 || invalid ? "source-error" : oversizedPage || inconsistentPage || expectedMore || nextTermIndex < terms.length || incompleteDetails ? "record-limit" : undefined });
    result.coverage.appliedFilters = roles.length ? ["roles"] : [];
    result.coverage.ignoredFilters = ("regions companyNames".split(" ") as ("regions" | "companyNames")[]).filter(key => request.scope[key].length > 0);
    result.warnings = [
      "This is a bounded enumeration of one configured Workday tenant and site, not a search of every employer or the whole market.",
      "Search text is a source query; region and employer interests are checked against returned evidence locally.",
      "Location and publication labels remain source text; no salary, office address, coordinate or controlling-owner origin was inferred.",
      ...(roles.length > 1 ? [`This page covers role term ${termIndex + 1}/${roles.length}; continuation runs each remaining term separately and may return duplicate requisition IDs.`] : []),
      ...(invalid ? [`${invalid} malformed or unlinked list records were omitted; coverage is partial.`] : []),
      ...(failures ? [`${failures} official detail reads failed; listing data remains an excerpt.`] : []),
      ...(options.maxDetailRequestsPerPage < candidates.length ? [`Official details read ${detailed}/${candidates.length} eligible records; per-page ceiling is ${options.maxDetailRequestsPerPage}.`] : []),
      ...(timedOut ? ["Official detail timed out; the page remains partial and continuation is stopped."] : []),
      ...(stoppedOnProviderLimit ? ["Official detail hit a rate or response-size limit; listing data was retained and continuation is stopped."] : []),
      ...(oversizedPage ? ["The source returned more records than the requested page limit; excess records were omitted and continuation stopped."] : []),
      ...(inconsistentPage ? ["The source returned fewer records than its requested page while reporting more results; continuation stopped because its offset is not reliable."] : []),
      ...result.warnings.filter(warning => !warning.startsWith("This source enumerates")),
    ];
    return SourcePageSchema.parse(result);
  },
};
