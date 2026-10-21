import { createHash } from "node:crypto";
import { z } from "zod";
import { ToolError } from "@better-me/opportunities";
import { SourceJobRecordSchema, SourcePageSchema, type SourceAdapter, type SourceAdapterDetailRequest, type SourceAdapterRequest, type SourceJobRecord } from "../contracts.js";
import { validateJobPostingJsonLdSource } from "../jobposting-jsonld-contracts.js";
import { enumerateJobPostingUrls } from "../jobposting-enumeration.js";
import { readJobPostingJsonLd } from "../jobposting-jsonld-reader.js";
import { SourceTransportError } from "../transport.js";
import { page } from "./common.js";

const MAX_MANIFEST_URLS = 10_000;
const CursorSchema = z.object({
  version: z.literal(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  manifest: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(1).max(MAX_MANIFEST_URLS),
}).strict();

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}
function hash(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }

async function readText(request: Pick<SourceAdapterRequest, "source" | "context" | "transport">, url: string, accept: string): Promise<string> {
  request.context.throwIfCancelled();
  const expected = new URL(url).toString();
  const response = await request.transport.request({ url: expected, source: request.source, context: request.context, headers: { accept } });
  request.context.throwIfCancelled();
  if (response.status < 200 || response.status >= 300) throw new SourceTransportError(response.status === 429 ? "rate-limited" : "http-error", response.status);
  // Redirects and another posting's structured data cannot silently replace the reviewed identity.
  if (response.url !== expected) throw new ToolError("source-changed");
  return response.text;
}

function validateHeldPosting(request: SourceAdapterDetailRequest): void {
  const options = validateJobPostingJsonLdSource(request.source);
  // Use the same reviewed URL syntax/path constraints as manifest candidates, but
  // never enumerate a manifest to rediscover an already-held posting.
  const value = request.url;
  if (value.length > 4096 || value !== value.trim() || /[\\#\s\p{Cc}\p{Cs}]/u.test(value)
    || /%(?:2f|5c|2e)/i.test(value.split(/[?#]/, 1)[0]!)) throw new ToolError("invalid-input");
  let url: URL, path: string;
  try { url = new URL(value); path = decodeURIComponent(url.pathname); } catch { throw new ToolError("invalid-input"); }
  if (url.toString() !== value || url.protocol !== "https:" || url.origin !== new URL(options.enumerationUrls[0]!).origin
    || url.username || url.password || url.port || url.hash || /[\\%\p{Cc}\p{Cs}]/u.test(path)
    || !options.postingPathPrefixes.some(prefix => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) {
    throw new ToolError("invalid-input");
  }
}

function recoverableDetailError(error: unknown): boolean {
  return error instanceof ToolError && error.code === "source-changed"
    || error instanceof SourceTransportError && ["http-error", "response-too-large", "invalid-response"].includes(error.code)
      && error.status !== 401 && error.status !== 403;
}

/** Enumerates only explicitly reviewed static manifests, then reads their own JobPosting pages.
 * No crawler, sitemap-index traversal, endpoint guessing or automatic pagination is performed. */
export const jobPostingJsonLdAdapter: SourceAdapter = {
  adapterId: "jobposting-jsonld", version: "1", capabilities: ["list-jobs"], remoteFilters: [], entityTypes: ["job-posting"],
  async readDetail(request) {
    request.context.throwIfCancelled();
    validateHeldPosting(request);
    const text = await readText(request, request.url, "text/html, application/xhtml+xml;q=0.9");
    const result = readJobPostingJsonLd(text, request.url);
    request.context.throwIfCancelled();
    const parsed = SourceJobRecordSchema.safeParse(result.record);
    if (!parsed.success || parsed.data.entityType !== "job-posting" || parsed.data.url !== request.url
      || parsed.data.sourceRecordId !== request.sourceRecordId) throw new ToolError("source-changed");
    return parsed.data;
  },
  async list(request) {
    request.context.throwIfCancelled();
    const options = validateJobPostingJsonLdSource(request.source);
    const { maxRecords: _remainingRecords, ...fixedRefreshPolicy } = request.source.refreshPolicy;
    const fingerprint = hash({ sourceId: request.source.sourceId, adapterId: request.source.adapterId,
      adapterVersion: request.source.adapterVersion, entryUrl: request.source.entryUrl,
      options, endpointPolicy: request.source.endpointPolicy, scope: request.scope,
      runtime: request.source.runtime, capabilities: request.source.capabilities, remoteFilters: request.source.remoteFilters,
      entityType: request.source.entityType, refreshPolicy: fixedRefreshPolicy });
    let cursor: z.infer<typeof CursorSchema> | undefined;
    if (request.cursor !== undefined) {
      let value: unknown;
      try {
        if (!/^[A-Za-z0-9_-]{1,1000}$/.test(request.cursor)) throw new Error();
        value = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
      } catch { throw new ToolError("invalid-input"); }
      const parsed = CursorSchema.safeParse(value);
      if (!parsed.success || parsed.data.fingerprint !== fingerprint) throw new ToolError("invalid-input");
      cursor = parsed.data;
    }

    const urls: string[] = [], seen = new Set<string>(), warnings: string[] = [];
    let truncated = false, emptyManifest = false;
    for (const url of options.enumerationUrls) {
      const text = await readText(request, url, options.enumerationKind === "sitemap-urlset"
        ? "application/xml, text/xml;q=0.9" : "text/html, application/xhtml+xml;q=0.9");
      const result = enumerateJobPostingUrls(text, url, options);
      request.context.throwIfCancelled();
      truncated ||= result.truncated;
      emptyManifest ||= result.urls.length === 0;
      warnings.push(...result.warnings);
      for (const posting of result.urls) {
        if (seen.has(posting)) continue;
        if (urls.length < MAX_MANIFEST_URLS) { seen.add(posting); urls.push(posting); } else truncated = true;
      }
    }
    const priority = (options.priorityPostingUrls ?? []).map((url) => new URL(url).toString());
    const listed = new Set(urls), prioritized = priority.filter((url) => listed.has(url));
    if (prioritized.length !== priority.length) warnings.push("Priority URLs absent from the reviewed manifests were not requested or treated as postings.");
    const prioritySet = new Set(prioritized), queue = [...prioritized, ...urls.filter((url) => !prioritySet.has(url))];
    const manifest = hash(queue);
    if (cursor && (cursor.manifest !== manifest || cursor.offset >= queue.length)) throw new ToolError("source-changed");

    const offset = cursor?.offset ?? 0, limit = Math.min(options.pageSize, request.source.refreshPolicy.maxRecords);
    const records: SourceJobRecord[] = [];
    let attempted = 0, failed = 0, timedOut = false;
    for (const url of queue.slice(offset, offset + limit)) {
      request.context.throwIfCancelled();
      attempted++;
      try {
        const text = await readText(request, url, "text/html, application/xhtml+xml;q=0.9");
        const result = readJobPostingJsonLd(text, url);
        request.context.throwIfCancelled();
        warnings.push(...result.warnings);
        const parsed = SourceJobRecordSchema.safeParse(result.record);
        if (!parsed.success || parsed.data.entityType !== "job-posting" || parsed.data.url !== url) {
          failed++;
          continue;
        }
        records.push(parsed.data);
      } catch (error) {
        request.context.throwIfCancelled();
        if (error instanceof SourceTransportError && error.code === "timeout") {
          failed++; timedOut = true;
          break;
        }
        if (recoverableDetailError(error)) failed++; else throw error;
      }
    }
    request.context.throwIfCancelled();
    const nextOffset = offset + attempted;
    const next = !timedOut && nextOffset < queue.length
      ? Buffer.from(JSON.stringify({ version: 1, fingerprint, manifest, offset: nextOffset })).toString("base64url") : undefined;
    const result = page(request, records, {
      fetchedRecords: attempted,
      ...(next ? { nextCursor: next } : {}),
      partial: truncated || emptyManifest || queue.length === 0 || failed > 0 || timedOut,
      stopReason: truncated ? "record-limit" : "source-error",
    });
    if (timedOut) result.retryCurrentPage = true;
    result.warnings = [...new Set([
      "This reads only reviewed static manifests and their same-origin JobPosting pages; it does not search all employers or the whole market.",
      "Manifest links are candidate page URLs, not verified vacancies or a total job count. Source availability, office coordinates and controlling ownership are not independently verified.",
      `Reviewed manifests exposed ${queue.length} unique candidate URLs within the collection bound; this page attempted ${attempted} details and returned ${records.length} source records.`,
      ...(truncated ? ["Manifest enumeration reached a configured parser or 10000-URL collection bound; coverage remains partial."] : []),
      ...(emptyManifest || queue.length === 0 ? ["A reviewed manifest contained no readable in-scope posting links; dynamic content, a challenge or no published links cannot establish that there are no vacancies."] : []),
      ...(failed ? [`${failed} attempted detail pages lacked verifiable same-page JobPosting data or could not be read; prior successful records were retained and coverage is partial.`] : []),
      ...(timedOut ? ["A detail request timed out; subsequent detail requests and pagination stopped, retaining previously downloaded records."] : []),
      ...result.warnings,
      ...warnings,
    ])].slice(0, 100).map((warning) => warning.slice(0, 2000));
    return SourcePageSchema.parse(result);
  },
};
