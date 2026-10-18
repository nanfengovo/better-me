import { createHash } from "node:crypto";
import { z } from "zod";
import { CountryCodeSchema, ToolError } from "@better-me/opportunities";
import { SourceJobRecordSchema, SourcePageSchema, type SourceAdapter, type SourceAdapterRequest, type SourceJobRecord } from "../contracts.js";
import { SmartRecruitersSourceOptionsSchema } from "../smartrecruiters-contracts.js";
import { SourceTransportError } from "../transport.js";
import { assessSourceScopeMatch, countSourceScopeMatches } from "../local-match.js";
import { baseRecord, jsonResponse, page, plainText, publicUrl, record, timeValue } from "./common.js";

const API_ORIGIN = "https://api.smartrecruiters.com";
const PUBLIC_ORIGIN = "https://jobs.smartrecruiters.com";
const CursorSchema = z.object({
  version: z.literal(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  term: z.number().int().min(0).max(99), offset: z.number().int().min(0).max(1_000_000_000),
  pageSize: z.number().int().min(1).max(100),
}).strict();

function isApiIdentity(value: unknown, expected: string): boolean {
  if (value === undefined || value === "") return true;
  return publicUrl(value) === expected;
}

/** A source-supplied public link must identify this tenant and posting, never another tenant. */
function postingUrl(value: unknown, tenant: string, id: string): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const candidate = publicUrl(value);
  if (!candidate) return undefined;
  const url = new URL(candidate), prefix = `/${tenant}/${id}`;
  if (url.origin !== PUBLIC_ORIGIN || url.hash || !(url.pathname === prefix || url.pathname.startsWith(`${prefix}-`))) return undefined;
  // Posting URL slugs cannot introduce further route segments.
  return url.pathname.slice(prefix.length).includes("/") ? undefined : candidate;
}

async function readJson(request: SourceAdapterRequest, url: string) {
  const response = await jsonResponse(request, url);
  request.context.throwIfCancelled();
  if (response.url !== url) throw new ToolError("source-changed");
  return response;
}

function locationFor(job: SourceJobRecord, value: unknown, selector: string, sourceUrl: string): void {
  const location = record(value);
  const full = plainText(location.fullLocation), address = plainText(location.address);
  const city = plainText(location.city), region = plainText(location.region), country = plainText(location.country);
  const original = full || [city, region, country].filter(Boolean).join(", ");
  const raw = [original, address && address !== original ? address : ""].filter(Boolean).join(" · ");
  if (raw) {
    const code = CountryCodeSchema.safeParse(country.toUpperCase());
    job.locations = [{ raw, ...(code.success ? { countryCode: code.data } : {}),
      ...(region ? { region } : {}), ...(city && !/[,，、/;；\n]/.test(city) ? { city } : {}) }];
    job.evidence.push({ field: "locations", selector, quote: raw.slice(0, 20_000), sourceUrl });
  }
  if (location.remote === true && location.hybrid !== true) job.workMode = "remote";
  else if (location.hybrid === true && location.remote !== true) job.workMode = "hybrid";
  for (const key of ["remote", "hybrid"] as const) if (typeof location[key] === "boolean") {
    job.evidence.push({ field: "source.location", selector: `${selector}.${key}`, quote: String(location[key]), sourceUrl });
  }
  if (location.remote === true && location.hybrid === true) job.warnings.push("Conflicting remote/hybrid flags were retained as evidence; work mode remains unknown.");
  // Provider coordinates are often city centroids. They never establish an office or remote eligibility.
}

function publicationFor(job: SourceJobRecord, value: unknown, selector: string, sourceUrl: string): void {
  const published = timeValue(value);
  if (published.raw) {
    job.sourcePublishedRaw = published.raw;
    job.evidence.push({ field: "sourcePublishedRaw", selector, quote: published.raw, sourceUrl });
  }
  if (published.at) job.sourcePublishedAt = published.at;
}

function statusEvidence(job: SourceJobRecord, value: Record<string, unknown>, prefix: string, sourceUrl: string): void {
  for (const key of ["active", "visibility"] as const) if (["boolean", "string"].includes(typeof value[key])) {
    job.evidence.push({ field: `source.${key}`, selector: `${prefix}${key}`, quote: String(value[key]), sourceUrl });
  }
}

/** Public GET Posting API. Upstream q returns candidates; only local evidence establishes a keyword match. */
export const smartRecruitersAdapter: SourceAdapter = {
  adapterId: "smartrecruiters", version: "1", capabilities: ["list-jobs"], remoteFilters: ["roles"], entityTypes: ["job-posting"],
  async list(request) {
    request.context.throwIfCancelled();
    const parsedOptions = SmartRecruitersSourceOptionsSchema.safeParse(request.source.options ?? {});
    if (!parsedOptions.success) throw new ToolError("invalid-input");
    const options = parsedOptions.data, tenant = options.companyIdentifier;
    const basePath = `/v1/companies/${tenant}/postings`, endpoint = `${API_ORIGIN}${basePath}`;
    if (request.source.entryUrl && request.source.entryUrl !== endpoint) throw new ToolError("invalid-input");
    const keywords = [...new Set(request.scope.roles.map((keyword) => keyword.trim()))];
    if (keywords.length > 100 || keywords.some((keyword) => !keyword || keyword.length > 80
      || Array.from(keyword).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) throw new ToolError("invalid-input");
    const terms = keywords.length ? keywords : [""];
    const fingerprint = createHash("sha256").update(JSON.stringify([request.source.sourceId, options, terms,
      request.scope.regions, request.scope.companyNames, request.scope.countryCodes])).digest("hex");
    let term = 0, offset = 0, pageSize = Math.min(options.pageSize, request.source.refreshPolicy.maxRecords);
    if (request.cursor !== undefined) {
      let value: unknown;
      try {
        if (!/^[A-Za-z0-9_-]{1,1000}$/.test(request.cursor)) throw new Error();
        value = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
      } catch { throw new ToolError("invalid-input"); }
      const cursor = CursorSchema.safeParse(value);
      if (!cursor.success || cursor.data.fingerprint !== fingerprint || cursor.data.term >= terms.length || cursor.data.pageSize > options.pageSize
        || cursor.data.offset % cursor.data.pageSize !== 0) throw new ToolError("invalid-input");
      ({ term, offset, pageSize } = cursor.data);
    }
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ limit: String(pageSize), offset: String(offset),
      ...(terms[term] ? { q: terms[term]! } : {}), ...(options.countryCode ? { country: options.countryCode.toLowerCase() } : {}) }).toString();
    const response = await readJson(request, url.toString());
    const payload = record(response.data), posts = payload.content;
    if (!Array.isArray(posts) || payload.offset !== offset || payload.limit !== pageSize || typeof payload.totalFound !== "number"
      || !Number.isSafeInteger(payload.totalFound) || payload.totalFound < posts.length || payload.totalFound > 1_000_000_000) throw new ToolError("source-changed");
    const total = payload.totalFound, limit = Math.min(pageSize, request.source.refreshPolicy.maxRecords);
    const records: SourceJobRecord[] = [], seen = new Set<string>();
    let invalid = 0;
    for (const [index, value] of posts.slice(0, limit).entries()) {
      request.context.throwIfCancelled();
      const post = record(value), company = record(post.company), id = post.id;
      if (typeof id !== "string" || !/^\d{1,30}$/.test(id) || seen.has(id) || company.identifier !== tenant
        || !isApiIdentity(post.ref, `${endpoint}/${id}`)) { invalid++; continue; }
      const originalUrl = postingUrl(post.postingUrl, tenant, id), title = plainText(post.name);
      if (!title || (post.postingUrl !== undefined && post.postingUrl !== "" && !originalUrl)) { invalid++; continue; }
      const selector = `content[${index}]`, job = baseRecord(title, response.url, `${selector}.name`);
      job.sourceRecordId = id;
      if (originalUrl) { job.url = originalUrl; job.applicationUrl = originalUrl; }
      job.companyName = plainText(company.name) || options.companyName;
      job.evidence.push({ field: "sourceRecordId", selector: `${selector}.id`, quote: id, sourceUrl: response.url },
        { field: "companyName", selector: `${selector}.company`, sourceUrl: response.url });
      locationFor(job, post.location, `${selector}.location`, response.url);
      publicationFor(job, post.releasedDate, `${selector}.releasedDate`, response.url);
      statusEvidence(job, post, `${selector}.`, response.url);
      job.warnings.push("Public listing metadata only; requirements have not been read. Upstream q is a broad candidate query, not a confirmed keyword match.",
        "releasedDate is the source posting release time, which may be a re-release; no first-ever publication or independent current availability is established. Office coordinates, controlling ownership, salary and remote eligibility remain unknown.");
      if (!SourceJobRecordSchema.safeParse(job).success) { invalid++; continue; }
      seen.add(id); records.push(job);
    }
    let detailed = 0, detailFailures = 0, detailTimedOut = false;
    if (options.fetchDetails) {
      const candidates = records.map((job, index) => ({ job, index, match: assessSourceScopeMatch(job, request.scope) }))
        .filter(({ match }) => match.nonRoleMatch)
        .sort((left, right) => Number(!right.job.url && right.match.roleMatch) - Number(!left.job.url && left.match.roleMatch)
          || Number(left.match.roleMatch) - Number(right.match.roleMatch) || left.index - right.index);
      for (const { job } of candidates.slice(0, options.maxDetailRequestsPerPage)) {
        request.context.throwIfCancelled();
        try {
          const detailResponse = await readJson(request, `${endpoint}/${job.sourceRecordId}`);
          const detail = record(detailResponse.data), company = record(detail.company);
          const detailUrl = detail.postingUrl === undefined || detail.postingUrl === "" ? undefined : postingUrl(detail.postingUrl, tenant, job.sourceRecordId!);
          if (detail.id !== job.sourceRecordId || company.identifier !== tenant || !isApiIdentity(detail.ref, `${endpoint}/${job.sourceRecordId}`)
            || (detail.postingUrl !== undefined && detail.postingUrl !== "" && !detailUrl)) throw new ToolError("source-changed");
          const sections = record(record(detail.jobAd).sections);
          const order = ["companyDescription", "jobDescription", "qualifications", "additionalInformation"];
          const parts: string[] = [], evidence: SourceJobRecord["evidence"] = [];
          for (const key of order) {
            const section = record(sections[key]), text = plainText(section.text);
            if (!text) continue;
            parts.push(`${plainText(section.title) || key}\n${text}`);
            evidence.push({ field: key === "qualifications" ? "requirements" : "description", selector: `jobAd.sections.${key}.text`, sourceUrl: detailResponse.url });
          }
          const description = parts.join("\n\n");
          if (!description || description.length > 2_000_000) throw new ToolError("source-changed");
          const full = Boolean(plainText(record(sections.jobDescription).text) && plainText(record(sections.qualifications).text))
            && !Object.keys(sections).some((key) => !order.includes(key) && plainText(record(sections[key]).text));
          job.description = description;
          job.evidence.push(...evidence, { field: "sourceRecordId", selector: "id", quote: job.sourceRecordId, sourceUrl: detailResponse.url });
          // The same-ID detail URL is authoritative; never manufacture an application route or follow it.
          if (detailUrl) { job.url = detailUrl; job.applicationUrl = detailUrl; }
          statusEvidence(job, detail, "", detailResponse.url);
          if (full) {
            job.completeness = "detail"; detailed++;
            job.warnings = job.warnings.filter((warning) => !warning.startsWith("Public listing metadata only;"));
            job.warnings.push("Same-tenant, same-ID official responsibilities and qualifications were read without truncation. Apply controls and source active flags are not independent verification of current availability.");
          } else {
            detailFailures++;
            job.warnings.push("Official detail sections are missing or contain unsupported additional sections; the captured text remains an excerpt.");
          }
        } catch (error) {
          request.context.throwIfCancelled();
          if (error instanceof SourceTransportError && error.code === "timeout") {
            detailTimedOut = true; detailFailures++;
            job.warnings.push("Official detail timed out; the original listing was retained, further detail requests and pagination stopped.");
            break;
          }
          if (error instanceof ToolError && error.code === "source-changed"
            || error instanceof SourceTransportError && ["http-error", "response-too-large", "invalid-response"].includes(error.code) && error.status !== 401 && error.status !== 403) {
            detailFailures++;
            job.warnings.push("Official detail identity, sections or response could not be verified; the original listing remains an excerpt.");
          } else throw error;
        }
      }
    }
    // Lists may omit postingUrl. A verified same-ID detail can supply it within the
    // existing detail allowance; unresolved links never become constructed routes.
    const linkedRecords = records.filter((job) => Boolean(job.url));
    invalid += records.length - linkedRecords.length;
    for (const job of linkedRecords) if (job.completeness !== "detail") job.warnings.push("Unread requirements are not proof of no keyword match; this candidate remains unresolved until sufficient source text is read.");
    const expectedMore = offset + posts.length < total;
    const truncated = posts.length > limit;
    const shortPage = expectedMore && posts.length < pageSize;
    const inconsistentTotal = posts.length > 0 && offset + posts.length > total || posts.length === 0 && offset > total;
    const nextTerm = !expectedMore && term + 1 < terms.length;
    const next = !detailTimedOut && !truncated && !shortPage && !inconsistentTotal && (expectedMore || nextTerm)
      ? { version: 1 as const, fingerprint, term: expectedMore ? term : term + 1, offset: expectedMore ? offset + pageSize : 0, pageSize } : undefined;
    const detailIncomplete = options.fetchDetails && detailed < records.length;
    const detailCapped = options.fetchDetails && records.filter((job) => assessSourceScopeMatch(job, request.scope).nonRoleMatch).length > options.maxDetailRequestsPerPage;
    const result = page(request, linkedRecords, {
      fetchedRecords: posts.length, ...(terms.length === 1 ? { totalAvailable: total } : {}),
      ...(next ? { nextCursor: Buffer.from(JSON.stringify(next)).toString("base64url") } : {}),
      partial: truncated || invalid > 0 || shortPage || inconsistentTotal || detailIncomplete || detailTimedOut,
      stopReason: detailTimedOut ? "source-error" : truncated || detailCapped ? "record-limit" : "source-error",
    });
    const local = countSourceScopeMatches(linkedRecords, request.scope);
    result.coverage.appliedFilters = keywords.length ? ["roles"] : [];
    result.coverage.ignoredFilters = (["regions", "companyNames"] as const).filter((key) => request.scope[key].length > 0);
    result.warnings = [
      "This is a bounded enumeration of one configured tenant and query, not a search of every employer or the whole market.",
      "Upstream q is a broad candidate query. Keywords are checked locally against actual source text with the shared matcher; returned counts do not mean confirmed keyword matches.",
      ...(options.countryCode ? [`The configured source requests country=${options.countryCode.toLowerCase()}; requested countries and regions still require local same-location evidence.`] : []),
      ...(result.coverage.ignoredFilters.length ? ["Requested region/company interests were not sent upstream and require local matching."] : []),
      ...(terms.length > 1 ? ["Separate OR keyword requests can overlap; no summed unique total is claimed."] : []),
      ...(invalid ? [`${invalid} malformed, duplicate, wrong-tenant or unlinked records were omitted; source coverage is partial.`] : []),
      ...(shortPage || inconsistentTotal ? ["The page length or count does not support safe continuation; collection stopped as partial."] : []),
      ...(options.fetchDetails ? [`Official details completed ${detailed}/${records.length}; configured maximum ${options.maxDetailRequestsPerPage} attempts per page. Locally eligible unresolved requirements are prioritized while source result order is preserved.`] : []),
      ...(local.unknown ? [`${local.unknown} eligible candidates still have unread requirements and are not counted as confirmed keyword matches.`] : []),
      ...(detailFailures ? [`${detailFailures} detail requests could not establish complete responsibilities and qualifications; listing evidence was retained.`] : []),
      ...(detailTimedOut ? ["Official detail timeout stopped subsequent requests and pagination; downloaded listing evidence remains usable and coverage is partial."] : []),
      ...result.warnings.filter((warning) => !warning.startsWith("This source enumerates")),
    ];
    return SourcePageSchema.parse(result);
  },
};
