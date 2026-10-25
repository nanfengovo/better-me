import { z } from "zod";

/** Standalone browser/server wire identity. No workspace entrypoint or source .js graph is required. */
export const PlatformSearchProviderSchema = z.enum(["51job", "boss", "liepin", "linkedin", "seek", "indeed", "gradconnection"]);
export type PlatformSearchProvider = z.infer<typeof PlatformSearchProviderSchema>;
export type PlatformSearchJobPlatform = "51JOB" | "BOSS直聘" | "猎聘" | "LinkedIn" | "Seek" | "Indeed" | "GradConnection";
export const REVIEWED_PLATFORM_NAMES: Readonly<Record<PlatformSearchProvider, PlatformSearchJobPlatform>> = {
  "51job": "51JOB", boss: "BOSS直聘", liepin: "猎聘", linkedin: "LinkedIn",
  seek: "Seek", indeed: "Indeed", gradconnection: "GradConnection",
};

// Keep these exact hosts and single-job patterns aligned with the browser reader's
// allowedJobUrl/detailIdentity rules. A share wrapper or search page is not a job.
const hosts: Readonly<Record<PlatformSearchProvider, readonly string[]>> = {
  "51job": ["51job.com", "www.51job.com", "jobs.51job.com", "m.51job.com", "msearch.51job.com", "we.51job.com", "q.51job.com"],
  boss: ["zhipin.com", "www.zhipin.com", "m.zhipin.com"],
  liepin: ["liepin.com", "www.liepin.com", "m.liepin.com"],
  linkedin: ["linkedin.com", "www.linkedin.com", "cn.linkedin.com", "m.linkedin.com", "uk.linkedin.com", "de.linkedin.com", "fr.linkedin.com", "au.linkedin.com", "ca.linkedin.com", "sg.linkedin.com", "hk.linkedin.com", "jp.linkedin.com", "in.linkedin.com", "nl.linkedin.com", "tw.linkedin.com", "ae.linkedin.com", "nz.linkedin.com", "ie.linkedin.com", "lnkd.in"],
  seek: ["seek.com.au", "www.seek.com.au", "seek.co.nz", "www.seek.co.nz", "seek.com", "www.seek.com"],
  indeed: ["indeed.com", "www.indeed.com", "au.indeed.com", "uk.indeed.com", "ca.indeed.com", "de.indeed.com", "fr.indeed.com", "cn.indeed.com", "jp.indeed.com", "sg.indeed.com", "nz.indeed.com", "in.indeed.com"],
  gradconnection: ["gradconnection.com", "www.gradconnection.com", "au.gradconnection.com", "nz.gradconnection.com", "uk.gradconnection.com", "sg.gradconnection.com", "hk.gradconnection.com"],
};

export function reviewedPlatformUrl(input: string, provider: PlatformSearchProvider): URL | undefined {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts[provider].includes(url.hostname)) return;
    url.hash = "";
    return url;
  } catch { return; }
}

/** The platform plus its actual single-job ID is stable across tracking URLs and title slugs. */
export function reviewedCardIdentity(input: string, provider: PlatformSearchProvider): { id: string; url: string } | undefined {
  const url = reviewedPlatformUrl(input, provider);
  if (!url) return;
  if (provider === "indeed") {
    const jk = url.searchParams.get("jk");
    if (jk && /^[a-z\d_-]+$/i.test(jk)) return { id: jk, url: url.toString() };
  }
  const patterns: Record<PlatformSearchProvider, RegExp[]> = {
    boss: [/^\/job_detail\/([a-z\d_-]+)\.html\/?$/i, /^\/mpa\/html\/weijd\/weijd-job\/([a-z\d_-]+)\/?$/i],
    liepin: [/^\/(?:job|a)\/(\d+)\.shtml\/?$/i],
    "51job": [/^\/jobs\/(?:[^/]+\/)*([a-z\d_-]+)\.html\/?$/i, ...(url.hostname === "jobs.51job.com" ? [/^\/(?!jobs\/)[^/]+\/([a-z\d_-]+)\.html\/?$/i] : [])],
    linkedin: [/^\/jobs\/view\/(?:[^/]*-)?(\d+)\/?$/i],
    seek: [/^\/job\/(\d+)\/?$/i],
    indeed: [/^\/viewjob\/?$/i, /^\/jobs\/view\/(?:[^/]*-)?([a-z\d_-]+)\/?$/i, /^\/rc\/clk\/?$/i],
    gradconnection: [/^\/jobs\/([a-z\d_-]+)\/?$/i, /^\/graduates\/[a-z\d_-]+\/([a-z\d_-]+)\/?$/i],
  };
  for (const pattern of patterns[provider]) {
    const id = url.pathname.match(pattern)?.[1];
    if (id) return { id, url: url.toString() };
  }
}
