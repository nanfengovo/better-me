import { z } from "zod";
import {
  SourceDefinitionSchema, FxImportDraftSchema, buildFxReferenceSnapshot, ToolError,
  type FxImportDraft, type ToolHandlerContext,
} from "@better-me/opportunities";
import defaults from "./default-fx-reference.json" with { type: "json" };
import type { SourceTransport } from "./contracts.js";
import { SourceTransportError } from "./transport.js";

function publicEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && (!url.port || url.port === "443") && url.hostname.includes(".") && !url.hostname.endsWith(".")
      && !/[\\\s\p{Cc}]/u.test(value) && !/^[\d.]+$/.test(url.hostname)
      && !/(?:^|\.)(?:localhost|local|internal|lan|invalid|test)$/.test(url.hostname);
  } catch { return false; }
}

/** Host configuration only; neither tool inputs nor imported evidence select a request URL. */
export const FxReferenceProviderConfigSchema = z.object({
  provider: z.string().trim().min(1).max(200),
  endpoint: z.string().min(1).max(2048).refine(publicEndpoint, "Use a public HTTPS endpoint without credentials, query or fragment."),
  format: z.enum(["eur-reference-json-v1", "frankfurter-v2-eur-json-v1"]),
  providerKey: z.string().regex(/^[A-Z0-9_]{1,40}$/).optional(),
}).strict();
export type FxReferenceProviderConfig = z.infer<typeof FxReferenceProviderConfigSchema>;
export interface FxReferenceProvider {
  read(context: ToolHandlerContext): Promise<FxImportDraft>;
}

/** Reads EUR-base JSON reference rates, preserving the response verbatim for review. */
export function createFxReferenceProvider(
  transport: SourceTransport,
  configuration: FxReferenceProviderConfig = FxReferenceProviderConfigSchema.parse(defaults),
  options: { now?: () => string } = {},
): FxReferenceProvider {
  const config = FxReferenceProviderConfigSchema.parse(configuration);
  const endpoint = new URL(config.endpoint);
  if (config.providerKey) endpoint.searchParams.set("providers", config.providerKey);
  const requestUrl = endpoint.toString();
  // This transient transport policy is never registered in the recruitment catalog.
  const policy = SourceDefinitionSchema.parse({
    sourceId: "host-fx-reference", name: config.provider, adapterId: "eur-reference-json", adapterVersion: "1",
    capabilities: [], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", remoteFilters: [],
    endpointPolicy: { allowedHosts: [endpoint.hostname], allowedPathPrefixes: [endpoint.pathname], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
    attribution: { label: config.provider, homepageUrl: endpoint.origin, usage: "link-only", requiresAttribution: true },
    refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 1, maxPages: 1, requestsPerMinute: 6 },
  });
  return {
    async read(context) {
      context.throwIfCancelled();
      const observedAt = options.now?.() ?? new Date().toISOString();
      try {
        const response = await transport.request({ url: requestUrl, source: policy,
          context: { ...context, observedAt }, headers: { accept: "application/json" } });
        context.throwIfCancelled();
        if (response.url !== requestUrl || response.status !== 200) throw new ToolError("source-changed");
        const draft = FxImportDraftSchema.parse({ schemaVersion: 1, provider: config.provider, sourceUrl: requestUrl,
          retrievedAt: observedAt, raw: response.text, format: config.format });
        await buildFxReferenceSnapshot(draft, { now: observedAt });
        context.throwIfCancelled();
        return draft;
      } catch (error) {
        if (error instanceof ToolError) throw error;
        if (error instanceof SourceTransportError) throw new ToolError(error.code === "cancelled" ? "cancelled"
          : error.code === "timeout" ? "timeout" : error.code === "rate-limited" ? "rate-limited"
            : error.code === "response-too-large" ? "budget-exceeded" : "source-changed");
        throw new ToolError("source-changed");
      }
    },
  };
}
