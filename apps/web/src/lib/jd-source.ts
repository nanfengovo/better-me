import { z } from "zod";

// Keep this Vite server boundary independent of workspace package runtime resolution.
const SourceTimestampSchema = z.string().datetime({ offset: true }).max(64);

export type JobPlatform = "LinkedIn" | "猎聘" | "51JOB" | "BOSS直聘";

const HOSTS: Record<string, JobPlatform> = {
  "linkedin.com": "LinkedIn", "www.linkedin.com": "LinkedIn",
  "cn.linkedin.com": "LinkedIn", "m.linkedin.com": "LinkedIn",
  "uk.linkedin.com": "LinkedIn", "de.linkedin.com": "LinkedIn", "fr.linkedin.com": "LinkedIn",
  "au.linkedin.com": "LinkedIn", "ca.linkedin.com": "LinkedIn", "sg.linkedin.com": "LinkedIn",
  "hk.linkedin.com": "LinkedIn", "jp.linkedin.com": "LinkedIn", "in.linkedin.com": "LinkedIn",
  "nl.linkedin.com": "LinkedIn", "tw.linkedin.com": "LinkedIn", "ae.linkedin.com": "LinkedIn",
  "nz.linkedin.com": "LinkedIn", "ie.linkedin.com": "LinkedIn", "lnkd.in": "LinkedIn",
  "liepin.com": "猎聘", "www.liepin.com": "猎聘", "m.liepin.com": "猎聘",
  "51job.com": "51JOB", "www.51job.com": "51JOB", "jobs.51job.com": "51JOB",
  "m.51job.com": "51JOB", "msearch.51job.com": "51JOB", "we.51job.com": "51JOB", "q.51job.com": "51JOB",
  "zhipin.com": "BOSS直聘", "www.zhipin.com": "BOSS直聘", "m.zhipin.com": "BOSS直聘",
};

/** The extractor only fetches these exact HTTPS hosts, including every redirect. */
export function allowedJobUrl(input: string): { url: string; platform: JobPlatform } {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("链接格式不正确，请粘贴完整的岗位分享链接。"); }
  const host = url.hostname.toLowerCase();
  const platform = Object.hasOwn(HOSTS, host) ? HOSTS[host] : undefined;
  if (!platform || url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("仅支持 LinkedIn、猎聘、51JOB 和 BOSS直聘的官方 HTTPS 链接。");
  }
  url.hash = "";
  return { url: url.toString(), platform };
}

/** Accept a share message or an encoded job URL inside a share wrapper. */
export function normalizeJobShare(input: string): { url: string; platform: JobPlatform } {
  if (input.length > 16_000) throw new Error("分享内容过长，请只粘贴岗位链接及分享文字。");
  const found: Array<{ url: string; platform: JobPlatform }> = [];
  const wrappers = new Set<string>();
  const visited = new Map<string, string[]>();
  function visit(value: string, depth: number): string[] {
    if (depth > 3) return [];
    if (visited.has(value)) return visited.get(value)!;
    visited.set(value, []);
    const recognized: string[] = [];
    // Unescaped Chinese sentence punctuation ends a share URL. Encoded punctuation
    // remains part of the URL, as do Chinese path segments and query values.
    const matches: string[] = value.match(/https?:\/\/[^\s<>"「」『』。，；！？【】《》]+/gi) ?? [];
    if (!matches.length) {
      const bare = value.trim().match(/^([a-z\d.-]+)(?=[:/?#\s]|$)([^\s<>"「」『』。，；！？【】《》]*)/i);
      if (bare && Object.hasOwn(HOSTS, bare[1]!.toLowerCase())) matches.push(`https://${bare[0]}`);
    }
    for (const match of matches) {
      const candidate = match.replace(/[。，、；：！？）】》\]),.;!?]+$/g, "").replace(/&amp;/g, "&");
      let parsed: URL;
      try { parsed = new URL(candidate); } catch { continue; }
      // Old platform links commonly use HTTP; upgrade before any network operation.
      if (parsed.protocol === "http:") parsed.protocol = "https:";
      let own: { url: string; platform: JobPlatform } | undefined;
      try { own = allowedJobUrl(parsed.toString()); found.push(own); recognized.push(own.url); } catch { /* Look for a recognized nested URL. */ }
      for (const [key, nested] of parsed.searchParams) {
        if (/^(url|target|redirect|redirect_url|redirecturl|joburl|shareurl|link|dest|destination)$/i.test(key) || /^https?(?::|%3a)/i.test(nested)) {
          const children = visit(nested, depth + 1);
          if (own && children.length) wrappers.add(own.url);
          recognized.push(...children);
        }
      }
    }
    if (!matches.length && /https?%3a/i.test(value)) {
      try { recognized.push(...visit(decodeURIComponent(value), depth + 1)); } catch { /* Malformed percent encoding. */ }
    }
    visited.set(value, recognized);
    return recognized;
  }
  visit(input.trim(), 0);
  const unique = [...new Map(found.map((entry) => [entry.url, entry])).values()];
  const candidates = unique.filter((entry) => !wrappers.has(entry.url));
  if (candidates.length > 1) throw new Error("分享内容包含多个岗位链接，请保留一个再提取。");
  if (!candidates[0]) throw new Error("未找到支持的官方岗位链接。请粘贴完整分享消息，或使用截图识别。");
  const { url, platform } = candidates[0];
  return { url, platform };
}

export type JdSourcePublication = { sourcePublishedAt?: string; sourcePublishedText?: string };

/** Preserve a source disclosure verbatim; only an explicit timezone establishes an instant. */
export function jobPostingPublication(value: unknown): JdSourcePublication {
  if (typeof value !== "string" || !value.trim() || value.length > 1_000) return {};
  const text = value.trim();
  return { sourcePublishedText: text, ...(SourceTimestampSchema.safeParse(text).success ? { sourcePublishedAt: text } : {}) };
}

/** Public service and local backup boundary: optional publication fields never inherit capture time. */
export function readJdPublicationFields(value: { sourcePublishedAt?: unknown; sourcePublishedText?: unknown }): JdSourcePublication {
  const publication = jobPostingPublication(value.sourcePublishedText);
  if (SourceTimestampSchema.safeParse(value.sourcePublishedAt).success) return { ...publication, sourcePublishedAt: value.sourcePublishedAt as string };
  return publication.sourcePublishedText ? publication : jobPostingPublication(value.sourcePublishedAt);
}

export type JdProvenance = JdSourcePublication & {
  kind: "text" | "link" | "screenshot";
  platform?: JobPlatform;
  url?: string;
  title?: string;
  observedAt: string;
  imageNames?: string[];
  edited?: boolean;
};

export type JdImportResult = { text: string; provenance: JdProvenance; method: string };
