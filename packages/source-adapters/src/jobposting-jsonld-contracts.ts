import { z } from "zod";
import { ToolError, type SourceDefinition } from "@better-me/opportunities";

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Syntax only. Public DNS, endpoint permissions and redirect policy remain transport checks. */
function reviewedHttpsUrl(value: string): boolean {
  if (!value || value.length > 4096 || value !== value.trim() || /[\\#\s]/u.test(value) || containsControl(value)) return false;
  try {
    const url = new URL(value);
    const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1] ?? "";
    if (url.protocol !== "https:" || url.username || url.password || /[:@]/.test(authority) || url.port || !url.hostname.includes(".")
      || url.hostname.endsWith(".") || /^\[|^[\d.]+$/.test(url.hostname)) return false;
    const rawPath = /^https:\/\/[^/?#]+([^?#]*)/i.exec(value)?.[1] ?? "";
    if (/%(?:2f|5c)/i.test(rawPath)) return false;
    const path = decodeURIComponent(rawPath);
    return !/[\\%]/u.test(path) && !containsControl(path) && !path.split("/").some((segment) => segment === "." || segment === "..");
  } catch { return false; }
}

function reviewedPathPrefix(value: string): boolean {
  return value.startsWith("/") && !value.includes("//") && !/[\\%?#\s]/u.test(value) && !containsControl(value)
    && !value.split("/").some((segment) => segment === "." || segment === "..");
}

const urlSchema = z.string().min(1).max(4096).refine(reviewedHttpsUrl, "Expected a reviewed absolute HTTPS URL without credentials, a fragment or ambiguous path.");
const prefixesSchema = z.array(z.string().min(1).max(1000).refine(reviewedPathPrefix, "Expected an unambiguous absolute path prefix.")).min(1).max(20);
const urlsSchema = z.array(urlSchema).min(1).max(20);

/** Flat data options fit SourceOptionsSchema; no selectors, scripts or configurable HTTP methods. */
export const JobPostingJsonLdOptionsSchema = z.object({
  /** Discovery association only; never fills or overrides a posting's actual hiring organization. */
  companyName: z.string().trim().min(1).max(500).optional(),
  enumerationKind: z.enum(["sitemap-urlset", "html-list"]),
  enumerationUrls: urlsSchema,
  postingPathPrefixes: prefixesSchema,
  pageSize: z.number().int().min(1).max(20).default(5),
  /** Queue priority only. The adapter must first find each URL in the actual enumeration. */
  priorityPostingUrls: z.array(urlSchema).max(20).optional(),
}).strict().superRefine((options, context) => {
  const first = options.enumerationUrls[0];
  if (!first || !reviewedHttpsUrl(first)) return;
  const origin = new URL(first).origin;
  for (const key of ["enumerationUrls", "priorityPostingUrls"] as const) {
    const values = options[key] ?? [], seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      // Child field validation may already have rejected a URL; do not throw from a refinement.
      if (!reviewedHttpsUrl(value)) continue;
      const url = new URL(value), normalized = url.toString();
      if (url.origin !== origin) context.addIssue({ code: z.ZodIssueCode.custom, path: [key, index], message: "Enumeration and priority URLs must share one origin." });
      if (seen.has(normalized)) context.addIssue({ code: z.ZodIssueCode.custom, path: [key, index], message: "URL entries must be unique after URL normalization." });
      seen.add(normalized);
      if (key === "priorityPostingUrls") {
        const path = decodeURIComponent(url.pathname);
        if (!options.postingPathPrefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: [key, index], message: "A priority posting must be inside a reviewed posting path." });
        }
      }
    }
  }
  if (new Set(options.postingPathPrefixes).size !== options.postingPathPrefixes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["postingPathPrefixes"], message: "Posting path prefixes must be unique." });
  }
});
export type JobPostingJsonLdOptions = z.infer<typeof JobPostingJsonLdOptionsSchema>;

/** This does not authorize a request or enable a source. The controlled transport still does both endpoint and DNS checks. */
export function validateJobPostingJsonLdSource(source: SourceDefinition): JobPostingJsonLdOptions {
  const parsed = JobPostingJsonLdOptionsSchema.safeParse(source.options ?? {});
  if (!parsed.success || source.adapterId !== "jobposting-jsonld" || source.adapterVersion !== "1"
    || source.entryUrl !== parsed.data.enumerationUrls[0]) throw new ToolError("invalid-input");
  return parsed.data;
}
