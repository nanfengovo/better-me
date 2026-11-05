import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";

// This is an allowlist, not a redacted DOM/HAR dump. Never add free-form page
// text, URLs, errors, headers, cookies, input values or account identifiers.
const Observation = z.object({
  page: z.number().int().min(1).max(50),
  phase: z.enum(["initial", "pagination", "scroll", "request"]),
  readyState: z.enum(["loading", "interactive", "complete", "unavailable"]).default("unavailable"),
  route: z.enum(["search", "login", "verification", "browser_error", "blank", "other", "unavailable"]).default("unavailable"),
  httpStatus: z.number().int().min(100).max(999).optional(),
  failure: z.enum(["timeout", "network", "http", "platform_limit", "login", "verification", "layout", "pagination", "cancelled", "unknown"]),
  candidateLinks: z.number().int().min(0).max(10000).default(0),
  listRoots: z.number().int().min(0).max(10000).default(0),
  loadingIndicators: z.number().int().min(0).max(10000).default(0),
  verifiedCards: z.number().int().min(0).max(3000).default(0),
  pendingRequests: z.number().int().min(0).max(10000).default(0),
  failedRequests: z.number().int().min(0).max(10000).default(0),
  failedDocuments: z.number().int().min(0).max(10000).default(0),
  failedScripts: z.number().int().min(0).max(10000).default(0),
  failedDataRequests: z.number().int().min(0).max(10000).default(0),
  limitedDataResponses: z.number().int().min(0).max(10000).default(0),
  navigationAttempts: z.number().int().min(0).max(2).optional(),
  navigationCommandFailed: z.boolean().optional(),
  recovered: z.boolean().default(false),
  attempted: z.boolean().default(true),
  pageMarker: z.number().int().min(1).max(10000).optional(),
  nextControls: z.number().int().min(0).max(10000).default(0),
  disabledNextControls: z.number().int().min(0).max(10000).default(0),
  pageUrlChanged: z.boolean().optional(),
  pageMarkerChanged: z.boolean().optional(),
}).strip();
export const HarvestDiagnosticSchema = z.object({
  provider: z.enum(["liepin", "51job", "boss", "linkedin", "seek", "indeed", "gradconnection"]),
  observations: z.array(Observation).max(100),
}).strip();
export type HarvestDiagnostic = z.input<typeof HarvestDiagnosticSchema>;

export function classifyHarvestFailure(error: unknown, status?: number): z.infer<typeof Observation>["failure"] {
  if (status === 401) return "login";
  if (status === 403 || status === 429 || status === 999) return "platform_limit";
  if (status) return "http";
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (/timeout|timed out|超时/i.test(name + " " + message)) return "timeout";
  if (name === "AbortError") return "cancelled";
  if (error instanceof Error) return "network";
  return "unknown";
}

export async function retainHarvestDiagnostic(input: HarvestDiagnostic, directory = fileURLToPath(new URL("../../../output/harvest-diagnostics/", import.meta.url))): Promise<string | undefined> {
  try {
    const safe = HarvestDiagnosticSchema.parse(input);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Do not delete earlier evidence, and do not permit unbounded retention.
    if ((await readdir(directory)).filter(name => name.endsWith(".json")).length >= 200) return undefined;
    const id = randomUUID();
    await writeFile(join(directory, `${id}.json`), JSON.stringify({ id, capturedAt: new Date().toISOString(), ...safe }, null, 2), { mode: 0o600, flag: "wx" });
    return id;
  } catch { return undefined; } // Diagnostics must never discard valid jobs.
}

// Runs only in the collector's owned page. Only fixed labels and counts cross
// the boundary; even a logged-in page cannot contribute personal page content.
export const HARVEST_PAGE_OBSERVATION = `(() => {
  const text = (document.body?.innerText || '').slice(0, 100000);
  const path = location.pathname;
  const verification = /验证码|安全验证|访问异常|操作频繁|人机验证|captcha|security check|unusual traffic/i.test(text) || /verify|security-check|captcha/i.test(path);
  const login = /请先登录|登录后查看|sign in to continue/i.test(text) || /\\/login|passport|\\/web\\/user/i.test(path);
  const limited = /访问受限|请求过于频繁|access denied|too many requests/i.test(text);
  const count = selector => Math.min(10000, document.querySelectorAll(selector).length);
  const visible = element => {
    for (let node = element; node; node = node.parentElement) {
      if (node.hidden) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  };
  const active = document.querySelector('.ant-pagination-item-active,.el-pager li.active,[aria-current="page"]');
  const marker = Number((active?.textContent || '').trim());
  return {readyState: document.readyState, route: verification ? 'verification' : login ? 'login' : location.protocol === 'chrome-error:' ? 'browser_error' : location.protocol === 'about:' ? 'blank' : /search|zhaopin|jobs|job_list|jobs-list/i.test(path) ? 'search' : 'other',
    failure: verification ? 'verification' : login ? 'login' : limited ? 'platform_limit' : 'unknown',
    candidateLinks: count('a[href*="/job/"],a[href*="jobs.51job.com/"],a[href*="/job_detail/"],a[href*="/jobs/view/"],a[href*="/a/"]'),
    listRoots: count('.job-list-box,.job-list,.joblist,.job-list-item,.job-card-wrapper,.job-card-box,.j_joblist,.base-search-card'),
    loadingIndicators: Math.min(10000, [...document.querySelectorAll('[aria-busy="true"],.loading,.skeleton,.job-list-loading')].filter(visible).length),
    nextControls: count('.ant-pagination-next,.btn-next,.pagination-next,a[aria-label="下一页"]'),
    disabledNextControls: count('.ant-pagination-next.ant-pagination-disabled,.btn-next.disabled,.btn-next[disabled],.pagination-next.disabled'),
    ...(Number.isInteger(marker) && marker > 0 && marker <= 10000 ? {pageMarker: marker} : {})};
})()`;
