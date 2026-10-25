import { z } from "zod";
import { HttpUrlSchema, SourceDefinitionSchema, TimestampSchema, type SourceDefinition } from "@better-me/opportunities";
import { JsonFieldMappingOptionsSchema, SmartRecruitersSourceOptionsSchema, WorkdaySourceOptionsSchema, validateJobPostingJsonLdSource } from "@better-me/source-adapters/browser-contracts";
import catalogJson from "../../../../../config/sources/catalog.json";

const GithubMarkdownCatalogOptionsSchema = z.object({
  tableIndex: z.number().int().min(0).max(20).optional(),
  tableIndexes: z.array(z.number().int().min(0).max(20)).max(20).optional(),
  companyHeader: z.string().trim().min(1).max(120).optional(),
  titleHeader: z.string().trim().min(1).max(120).optional(),
  locationHeader: z.string().trim().min(1).max(120).optional(),
  urlHeader: z.string().trim().min(1).max(120).optional(),
  publishedHeader: z.string().trim().min(1).max(120).optional(),
  enumerationComplete: z.boolean().default(false),
}).strict().superRefine((options, context) => {
  if (options.tableIndex !== undefined && options.tableIndexes !== undefined) context.addIssue({ code: "custom", path: ["tableIndexes"], message: "Choose tableIndex or tableIndexes, not both." });
  if (options.tableIndexes && new Set(options.tableIndexes).size !== options.tableIndexes.length) context.addIssue({ code: "custom", path: ["tableIndexes"], message: "tableIndexes must be unique." });
});

function isGithubMarkdownCatalogSource(source: SourceDefinition): boolean {
  return source.entityType === "company-directory" && source.adapterId === "github-markdown"
    && source.adapterVersion === "1" && source.capabilities.length === 1 && source.capabilities[0] === "list-jobs"
    && source.runtime.includes("local-service") && Boolean(source.entryUrl);
}

function validGithubMarkdownEndpoint(source: SourceDefinition): boolean {
  if (!source.entryUrl) return false;
  try {
    const entry = new URL(source.entryUrl);
    return entry.protocol === "https:" && entry.hostname === "raw.githubusercontent.com" && !entry.username && !entry.password
      && !entry.port && !entry.search && !entry.hash && entry.pathname.split("/").filter(Boolean).length >= 4
      && source.endpointPolicy.requireHttps && !source.endpointPolicy.allowRedirects && source.endpointPolicy.maxRedirects === 0
      && source.endpointPolicy.allowedHosts.length === 1 && source.endpointPolicy.allowedHosts[0] === entry.hostname
      && source.endpointPolicy.allowedPathPrefixes.length === 1 && source.endpointPolicy.allowedPathPrefixes[0] === entry.pathname;
  } catch { return false; }
}

export const SourceCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(z.object({
    source: SourceDefinitionSchema.refine((source) => !source.enabled && source.status === "needs-review", "Catalog sources start disabled")
      .refine((source) => (source.entityType === "job-posting" && source.runtime.includes("local-service") && source.capabilities.includes("list-jobs") && Boolean(source.entryUrl))
        || isGithubMarkdownCatalogSource(source), "Catalog entries must provide a reviewed job source or a reviewed GitHub discovery source")
      .superRefine((source, context) => {
        if (source.adapterId === "github-markdown") {
          const options = GithubMarkdownCatalogOptionsSchema.safeParse(source.options ?? {});
          if (source.entityType !== "company-directory" || !isGithubMarkdownCatalogSource(source) || !validGithubMarkdownEndpoint(source) || !options.success) {
            context.addIssue({ code: "custom", path: ["options"], message: "GitHub Markdown discovery sources require a fixed raw.githubusercontent.com HTTPS file, strict table options and disabled review state." });
          }
        }
        if (source.adapterId === "jobposting-jsonld") {
          try { validateJobPostingJsonLdSource(source); }
          catch { context.addIssue({ code: "custom", path: ["options"], message: "Structured job sources require reviewed same-origin manifests and posting paths." }); }
        }
        if (source.adapterId === "smartrecruiters") {
          const options = SmartRecruitersSourceOptionsSchema.safeParse(source.options ?? {});
          const endpoint = options.success ? `https://api.smartrecruiters.com/v1/companies/${options.data.companyIdentifier}/postings` : undefined;
          if (!options.success || source.entryUrl !== endpoint || !source.remoteFilters.includes("roles")) {
            context.addIssue({ code: "custom", path: ["options"], message: "SmartRecruiters requires a valid tenant, exact posting endpoint and declared keyword candidate query" });
          }
        }
        if (source.adapterId === "workday-cxs") {
          const options = WorkdaySourceOptionsSchema.safeParse(source.options ?? {});
          let entry: URL | undefined;
          try { if (source.entryUrl) entry = new URL(source.entryUrl); } catch { /* schema issue below */ }
          if (!options.success || !entry || entry.protocol !== "https:" || entry.username || entry.password || entry.port || entry.search || entry.hash || entry.pathname !== `/${options.data.site}`
            || source.endpointPolicy.allowedHosts.length !== 1 || source.endpointPolicy.allowedHosts[0] !== entry.hostname
            || !source.endpointPolicy.requireHttps || source.endpointPolicy.allowedPathPrefixes.length !== 1 || source.endpointPolicy.allowedPathPrefixes[0] !== `/wday/cxs/${options.data.tenant}/${options.data.site}`
            || source.endpointPolicy.allowRedirects || source.endpointPolicy.maxRedirects !== 0 || !source.remoteFilters.includes("roles")) {
            context.addIssue({ code: "custom", path: ["options"], message: "Workday source requires a fixed HTTPS tenant, site, CXS path and declared search-text query" });
          }
        }
        if (source.adapterId !== "mapped-json") return;
        const mapping = JsonFieldMappingOptionsSchema.safeParse(source.options ?? {});
        if (!mapping.success || mapping.data.discoveryOnly) context.addIssue({ code: "custom", path: ["options"], message: "Catalog JSON job feeds require a valid mapping with discoveryOnly disabled" });
      }),
    tags: z.array(z.string().trim().min(1).max(80)).max(20),
    coverage: z.string().trim().min(1).max(1000),
    checkedAt: TimestampSchema,
    evidenceUrls: z.array(HttpUrlSchema).min(1).max(5),
  }).strict()).max(100),
}).strict().superRefine((catalog, context) => {
  const ids = new Set<string>();
  for (const [index, entry] of catalog.entries.entries()) {
    if (ids.has(entry.source.sourceId)) context.addIssue({ code: "custom", path: ["entries", index, "source", "sourceId"], message: "Duplicate catalog source" });
    ids.add(entry.source.sourceId);
  }
});
export type SourceCatalogEntry = z.infer<typeof SourceCatalogSchema>["entries"][number];
export const sourceCatalog = SourceCatalogSchema.parse(catalogJson).entries;

/** Company directories produce leads and always remain disabled until separately reviewed. */
export function sourceCatalogRegistration(source: SourceDefinition): SourceDefinition {
  return source.entityType === "company-directory"
    ? { ...structuredClone(source), enabled: false, status: "needs-review" }
    : { ...structuredClone(source), enabled: true, status: "active" };
}

/** Compare source endpoints, not labels; an existing configuration is never overwritten by a preset. */
export function sourceCatalogIdentity(source: SourceDefinition): string {
  if (!source.entryUrl) return JSON.stringify([source.adapterId, source.sourceId]);
  const url = new URL(source.entryUrl); url.hash = ""; url.searchParams.sort();
  return JSON.stringify([source.adapterId, source.adapterVersion, url.href]);
}

export function availableCatalogEntries(entries: readonly SourceCatalogEntry[], installed: readonly SourceDefinition[], filter = ""): SourceCatalogEntry[] {
  const query = filter.trim().toLocaleLowerCase();
  const identities = new Set(installed.map(sourceCatalogIdentity));
  return entries.filter((entry) => !installed.some((source) => source.sourceId === entry.source.sourceId)
    && !identities.has(sourceCatalogIdentity(entry.source))
    && (!query || [entry.source.name, entry.source.attribution.label, entry.coverage, ...entry.tags].join(" ").toLocaleLowerCase().includes(query)));
}
