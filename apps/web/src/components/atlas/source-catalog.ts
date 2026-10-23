import { z } from "zod";
import { HttpUrlSchema, SourceDefinitionSchema, TimestampSchema, type SourceDefinition } from "@better-me/opportunities";
import { JsonFieldMappingOptionsSchema, SmartRecruitersSourceOptionsSchema, validateJobPostingJsonLdSource } from "@better-me/source-adapters/browser-contracts";
import catalogJson from "../../../../../config/sources/catalog.json";

export const SourceCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(z.object({
    source: SourceDefinitionSchema.refine((source) => !source.enabled && source.status === "needs-review", "Catalog sources start disabled")
      .refine((source) => source.entityType === "job-posting" && source.runtime.includes("local-service") && source.capabilities.includes("list-jobs") && Boolean(source.entryUrl), "Catalog entries must provide searchable job sources")
      .superRefine((source, context) => {
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
