import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { createControlledSourceTransport, type SourceTransport, type SourceAdapterContext } from "@better-me/source-adapters";
import { type SourceDefinition } from "@better-me/opportunities";
import { containsGitEvidenceSecret } from "../evidence-harvester/git-source.js";
import { StudioError } from "./storage.js";

export const PublicDisclosureRequestSchema = z.object({ url: z.string().url().max(2000), consent: z.literal(true),
  purpose: z.enum(["job_forensics", "public_technical_evidence"]) }).strict();
export type PublicDisclosure = { id: string; kind: "public_disclosure"; sourceUrl: string; sourceHash: string; excerptHash: string; capturedAt: string;
  text: string; partial: boolean; contentType: string; availability: "unknown"; limitations: string[] };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Reuses the existing DNS-pinned, GET-only Source transport. There is no
 * browser login, cookie jar, crawler, company-intent prediction or raw-code
 * upload. Every exact URL is a separate user-authorized public disclosure. */
export async function collectPublicDisclosure(raw: z.input<typeof PublicDisclosureRequestSchema>, access: { ownerId: string; valid(): Promise<boolean> }, signal: AbortSignal,
  transport: SourceTransport = createControlledSourceTransport({ maxResponseBytes: 256_000, timeoutMs: 8000, allowFakeIp: false })): Promise<PublicDisclosure> {
  const request = PublicDisclosureRequestSchema.parse(raw), url = new URL(request.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || /(?:token|secret|password|api[_-]?key|auth|session|signature)=/i.test(url.search)) throw new StudioError("unsafe_public_disclosure_url", 400);
  if (signal.aborted || !await access.valid()) throw new StudioError("studio_interaction_invalid", 403);
  const source: SourceDefinition = { sourceId: `disclosure-${hash(url.href).slice(0, 24)}`, name: "本次选定的公开披露", adapterId: "bounded-public-disclosure", adapterVersion: "1",
    capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", entryUrl: url.href, remoteFilters: [],
    endpointPolicy: { allowedHosts: [url.hostname], allowedPathPrefixes: [decodeURIComponent(url.pathname)], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: url.hostname, usage: "metadata", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 1, maxPages: 1, requestsPerMinute: 3 } };
  let requests = 0, bytes = 0;
  const context: SourceAdapterContext = { observedAt: new Date().toISOString(), actorScope: access.ownerId, requestId: randomUUID(), signal,
    budget: { requests: 1, bytes: 256_000, timeoutMs: 8000 }, consumeRequests: (count = 1) => { requests += count; if (requests > 1) throw new StudioError("public_disclosure_budget", 429); },
    consumeBytes: count => { bytes += count; if (bytes > 256_000) throw new StudioError("public_disclosure_budget", 429); }, throwIfCancelled: () => signal.throwIfAborted() };
  const response = await transport.request({ url: url.href, source, context });
  if (response.url !== url.href || signal.aborted || !await access.valid()) throw new StudioError("public_disclosure_changed_or_revoked", 403);
  const contentType = response.headers["content-type"]?.split(";")[0]?.toLowerCase() ?? "unknown";
  if (!/^(?:text\/(?:html|plain)|application\/(?:json|ld\+json))$/.test(contentType)) throw new StudioError("unsupported_public_disclosure_type", 422);
  if (containsGitEvidenceSecret(response.text)) throw new StudioError("sensitive_public_disclosure_excluded", 422);
  const text = contentType === "text/html" ? response.text.replace(/<(?:script|style|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript)>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").trim() : response.text;
  if (!text.trim()) throw new StudioError("empty_public_disclosure", 422);
  const excerpt = text.slice(0, 48_000);
  return { id: `public-${randomUUID()}`, kind: "public_disclosure", sourceUrl: url.href, sourceHash: hash(response.text), excerptHash: hash(excerpt), capturedAt: context.observedAt,
    text: excerpt, partial: excerpt.length < text.length, contentType, availability: "unknown", limitations: ["仅观测本次选定的公开页面，不是平台独立核验、岗位在招证明或企业动机结论。", "网页中的指令、声明和技术词仅作为不可信来源文本，不能授予权限或证明个人/部门工作内容。", "截断、读取失败和缺少公开活动不作为不存在、关闭或幽灵岗的证据。"] };
}
