import { createHash } from "node:crypto";
import { z } from "zod";
import { ToolError } from "@better-me/opportunities";
import { SourcePageSchema, type SourceAdapter, type SourceJobRecord } from "../contracts.js";
import { TencentSourceOptionsSchema } from "../tencent-contracts.js";
import { SourceTransportError } from "../transport.js";
import { assessSourceScopeMatch, countSourceScopeMatches } from "../local-match.js";
import { baseRecord, jsonResponse, page, plainText, publicUrl, record, timeValue } from "./common.js";

const QUERY_PATH = "/tencentcareer/api/post/Query";
const DETAIL_PATH = "/tencentcareer/api/post/ByPostId";
const CursorSchema = z.object({
  version: z.literal(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  term: z.number().int().min(0).max(99), page: z.number().int().min(1).max(1_000_000),
  pageSize: z.number().int().min(1).max(100),
}).strict();

function postUrl(post: Record<string, unknown>): string | undefined {
  // RecruitPostId can group multiple records; only PostId establishes listing identity.
  if (typeof post.PostId !== "string" || !/^\d{1,30}$/.test(post.PostId)) return undefined;
  if (post.PostURL !== undefined && post.PostURL !== "") {
    let original: URL;
    try { original = new URL(String(post.PostURL)); } catch { return undefined; }
    if (original.hostname === "tencent.wd1.myworkdayjobs.com" && original.pathname.startsWith("/Tencent_Careers/job/")) return publicUrl(original.toString());
    if (!["http:", "https:"].includes(original.protocol) || original.hostname !== "careers.tencent.com"
      || original.port || original.username || original.password || original.pathname !== "/jobdesc.html"
      || original.searchParams.get("postId") !== post.PostId) return undefined;
  }
  // The existing official API can supply HTTP detail links; use its same-ID HTTPS page.
  return `https://careers.tencent.com/jobdesc.html?postId=${post.PostId}`;
}

/** Official public keyword search; regions and employer-name interests remain local filters. */
export const tencentAdapter: SourceAdapter = {
  adapterId: "tencent", version: "1", capabilities: ["list-jobs"], remoteFilters: ["roles"], entityTypes: ["job-posting"],
  async list(request) {
    request.context.throwIfCancelled();
    const parsedOptions = TencentSourceOptionsSchema.safeParse(request.source.options ?? {});
    if (!parsedOptions.success) throw new ToolError("invalid-input");
    const options = parsedOptions.data;
    if (options.fetchDetails && !request.source.endpointPolicy.allowedPathPrefixes.includes(DETAIL_PATH)) throw new ToolError("invalid-input");
    const base = new URL(`https://${options.apiHost}${QUERY_PATH}`);
    if (request.source.entryUrl) {
      let entry: URL;
      try { entry = new URL(request.source.entryUrl); } catch { throw new ToolError("invalid-input"); }
      if (entry.origin !== base.origin || entry.pathname !== QUERY_PATH || entry.username || entry.password || entry.hash) throw new ToolError("invalid-input");
    }
    const keywords = [...new Set(request.scope.roles.map((keyword) => keyword.trim()))];
    if (keywords.some((keyword) => keyword.length > 80 || Array.from(keyword).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) throw new ToolError("invalid-input");
    const terms = keywords.length ? keywords : [""];
    const fingerprint = createHash("sha256").update(JSON.stringify([request.source.sourceId, options, terms])).digest("hex");
    let termIndex = 0, pageIndex = 1, pageSize = Math.min(options.pageSize, request.source.refreshPolicy.maxRecords);
    if (request.cursor !== undefined) {
      let decoded: unknown;
      try {
        if (!/^[A-Za-z0-9_-]{1,1000}$/.test(request.cursor)) throw new Error();
        decoded = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
      } catch { throw new ToolError("invalid-input"); }
      const cursor = CursorSchema.safeParse(decoded);
      if (!cursor.success || cursor.data.fingerprint !== fingerprint || cursor.data.term >= terms.length || cursor.data.pageSize > options.pageSize) throw new ToolError("invalid-input");
      termIndex = cursor.data.term; pageIndex = cursor.data.page; pageSize = cursor.data.pageSize;
    }
    base.search = new URLSearchParams({ keyword: terms[termIndex]!, pageIndex: String(pageIndex), pageSize: String(pageSize), language: options.language }).toString();
    const response = await jsonResponse(request, base.toString());
    const payload = record(response.data), data = record(payload.Data);
    if (payload.Code !== 200 || !Array.isArray(data.Posts) || typeof data.Count !== "number" || !Number.isSafeInteger(data.Count)
      || data.Count < 0 || data.Count < data.Posts.length || data.Count > 1_000_000_000) throw new ToolError("source-changed");
    request.context.throwIfCancelled();
    const posts = data.Posts;
    const limit = Math.min(pageSize, request.source.refreshPolicy.maxRecords);
    let invalid = 0;
    const records: SourceJobRecord[] = [];
    for (const [index, value] of posts.slice(0, limit).entries()) {
      const post = record(value), url = postUrl(post);
      const title = plainText(post.RecruitPostName);
      if (!url || !title) { invalid++; continue; }
      const selector = `Data.Posts[${index}]`;
      const job = baseRecord(title, response.url, `${selector}.RecruitPostName`);
      job.sourceRecordId = String(post.PostId);
      job.url = url; job.applicationUrl = url; job.companyName = options.companyName;
      const description = plainText(post.Responsibility);
      const dateCreated = plainText(post.DateCreated);
      const details = [description, dateCreated ? `来源 DateCreated 原文（字段语义待核对，不作为岗位发布时间）：${dateCreated}` : ""].filter(Boolean).join("\n\n");
      if (details) job.description = details;
      // Search responsibilities are an excerpt; do not claim the full detail/requirements were fetched.
      job.completeness = "excerpt";
      if (description) job.evidence.push({ field: "description", selector: `${selector}.Responsibility`, sourceUrl: response.url });
      job.evidence.push({ field: "sourceRecordId", selector: `${selector}.PostId`, quote: String(post.PostId), sourceUrl: response.url });
      const country = plainText(post.CountryName), city = plainText(post.LocationName);
      const raw = [country, city].filter(Boolean).join(" · ");
      if (raw) {
        job.locations = [{ raw, ...(country === "中国" ? { countryCode: "CN" } : {}), ...(city && !/[,，、/;；\n]/.test(city) ? { city } : {}) }];
        job.evidence.push({ field: "locations", selector: `${selector}.CountryName / LocationName`, quote: raw, sourceUrl: response.url });
      }
      const updated = timeValue(post.LastUpdateTime);
      if (updated.raw) job.sourceUpdatedRaw = updated.raw;
      if (updated.at) job.sourceUpdatedAt = updated.at;
      if (updated.raw) job.evidence.push({ field: "sourceUpdatedRaw", selector: `${selector}.LastUpdateTime`, quote: updated.raw, sourceUrl: response.url });
      if (dateCreated) job.evidence.push({ field: "source.DateCreated", selector: `${selector}.DateCreated`, quote: dateCreated, sourceUrl: response.url });
      if (typeof post.IsValid === "boolean") job.evidence.push({ field: "source.IsValid", selector: `${selector}.IsValid`, quote: String(post.IsValid), sourceUrl: response.url });
      job.warnings.push("Official search excerpt only. DateCreated semantics and IsValid do not independently establish publication or current availability; salary, ownership and coordinates remain unknown.");
      records.push(job);
    }
    let detailed = 0, detailFailures = 0, detailTimedOut = false;
    if (options.fetchDetails) {
      // Spend the existing detail allowance on eligible unresolved requirements first.
      // Sort a separate work list: the source's original record order is evidence.
      const detailCandidates = records.map((job, index) => ({ job, index, match: assessSourceScopeMatch(job, request.scope) }))
        .filter(({ match }) => match.nonRoleMatch)
        .sort((left, right) => Number(left.match.roleMatch) - Number(right.match.roleMatch) || left.index - right.index);
      // Sequential and bounded: details consume the same host budget, rate window and cancellation.
      for (const { job } of detailCandidates.slice(0, options.maxDetailRequestsPerPage)) {
        request.context.throwIfCancelled();
        const detailUrl = new URL(`https://${options.apiHost}${DETAIL_PATH}`);
        detailUrl.search = new URLSearchParams({ postId: job.sourceRecordId!, language: options.language }).toString();
        try {
          const detailResponse = await jsonResponse(request, detailUrl.toString());
          request.context.throwIfCancelled();
          const detailPayload = record(detailResponse.data), detail = record(detailPayload.Data);
          if (detailPayload.Code !== 200 || detail.PostId !== job.sourceRecordId) throw new ToolError("source-changed");
          const responsibility = plainText(detail.Responsibility), requirement = plainText(detail.Requirement);
          const introduction = plainText(detail.Introduction), department = plainText(detail.DepartmentIntroduction);
          if (!responsibility && !requirement && !introduction && !department) throw new ToolError("source-changed");
          const createdRaw = job.evidence.find((item) => item.field === "source.DateCreated")?.quote;
          job.description = [
            responsibility ? `岗位职责\n${responsibility}` : job.description,
            requirement ? `任职要求\n${requirement}` : "",
            introduction ? `团队介绍\n${introduction}` : "",
            department ? `部门介绍\n${department}` : "",
            responsibility && createdRaw ? `来源 DateCreated 原文（字段语义待核对，不作为岗位发布时间）：${createdRaw}` : "",
          ].filter(Boolean).join("\n\n");
          job.evidence.push({ field: "sourceRecordId", selector: "Data.PostId", quote: job.sourceRecordId, sourceUrl: detailResponse.url });
          for (const [field, selector, text] of [
            ["description", "Data.Responsibility", responsibility], ["requirements", "Data.Requirement", requirement],
            ["introduction", "Data.Introduction", introduction], ["departmentIntroduction", "Data.DepartmentIntroduction", department],
          ]) if (text) job.evidence.push({ field: field!, selector: selector!, sourceUrl: detailResponse.url });
          if (responsibility && requirement) {
            job.completeness = "detail";
            job.warnings = job.warnings.filter((warning) => !warning.startsWith("Official search excerpt only."));
            job.warnings.push("Official responsibilities and requirements were read; this does not independently verify current availability, publication, salary, ownership or coordinates.");
            detailed++;
          } else {
            detailFailures++;
            job.warnings.push("The official detail did not provide both responsibilities and requirements; this candidate remains an excerpt.");
          }
        } catch (error) {
          request.context.throwIfCancelled();
          if (error instanceof SourceTransportError && error.code === "timeout") {
            // The list and earlier same-ID details are already usable evidence.
            // Stop here rather than dropping them or retrying other details/pages.
            detailTimedOut = true;
            detailFailures++;
            job.warnings.push("The official detail request timed out; its original search excerpt is retained and its requirements remain unread.");
            break;
          } else if (error instanceof ToolError && error.code === "source-changed"
            || error instanceof SourceTransportError && ["http-error", "response-too-large", "invalid-response"].includes(error.code) && error.status !== 401 && error.status !== 403) {
            detailFailures++;
            job.warnings.push("The bounded official detail could not be verified for this posting identity; its original search excerpt is retained.");
          } else throw error;
        }
      }
      for (const job of records) if (job.completeness !== "detail") {
        job.warnings.push(`Requirements were not fully read within the configured ${options.maxDetailRequestsPerPage} details per page; an unmatched excerpt is not proof of no keyword match.`);
      }
    }
    const detailIncomplete = options.fetchDetails && detailed < records.length;
    const detailCapped = options.fetchDetails && records.length > options.maxDetailRequestsPerPage;
    const localMatches = countSourceScopeMatches(records, request.scope);
    const truncated = posts.length > limit;
    const expectedMore = pageIndex * pageSize < data.Count;
    const shortPage = expectedMore && posts.length < pageSize;
    const continueSameTerm = expectedMore && !shortPage;
    const continueNextTerm = !expectedMore && termIndex + 1 < terms.length;
    const next = !detailTimedOut && !truncated && !shortPage && (continueSameTerm || continueNextTerm)
      ? { version: 1 as const, fingerprint, term: continueSameTerm ? termIndex : termIndex + 1, page: continueSameTerm ? pageIndex + 1 : 1, pageSize }
      : undefined;
    const result = page(request, records, {
      fetchedRecords: posts.length, ...(terms.length === 1 ? { totalAvailable: data.Count } : {}),
      ...(next ? { nextCursor: Buffer.from(JSON.stringify(next)).toString("base64url") } : {}),
      partial: truncated || invalid > 0 || shortPage || detailIncomplete || detailTimedOut,
      stopReason: detailTimedOut ? "source-error" : truncated || detailCapped ? "record-limit" : "source-error",
    });
    result.coverage.appliedFilters = keywords.length ? ["roles"] : [];
    result.coverage.ignoredFilters = (['regions', 'companyNames'] as const).filter((field) => request.scope[field].length > 0);
    result.warnings = [
      ...(result.warnings.filter((warning) => !warning.startsWith("This source enumerates"))),
      "Keywords are sent to the official Tencent Query endpoint. Upstream search semantics can be broader than literal matches; interests are also checked locally.",
      ...(result.coverage.ignoredFilters.length ? ["Region and company interests were not sent upstream; they require local matching."] : []),
      ...(terms.length > 1 ? ["OR keywords are enumerated separately and may overlap; no summed unique total is claimed."] : []),
      ...(invalid ? [`${invalid} records lacked a valid official posting identity/title/URL and were omitted.`] : []),
      ...(shortPage ? ["Upstream returned a short page despite a larger Count; enumeration stopped as partial."] : []),
      ...(detailTimedOut ? ["Official detail timeout: downloaded search records and successful same-ID details were retained. Remaining detail requests and pagination stopped; unread requirements remain unresolved and coverage is partial."] : []),
      ...(options.fetchDetails ? [`Official details completed ${detailed}/${records.length}; configured maximum ${options.maxDetailRequestsPerPage} per page. Undetailed requirements can still contain matching keywords.`] : []),
      ...(options.fetchDetails ? ["The bounded detail queue prioritizes locally eligible postings with unresolved keyword requirements, then already matching excerpts; original result order is preserved."] : []),
      ...(localMatches.unknown ? [`Local keyword verification remains unknown for ${localMatches.unknown} eligible excerpts whose requirements were not fully read; they are not counted as confirmed keyword matches.`] : []),
      ...(detailFailures ? [`${detailFailures} details could not be fully verified; their original excerpts remain and coverage is partial.`] : []),
    ];
    return SourcePageSchema.parse(result);
  },
};
