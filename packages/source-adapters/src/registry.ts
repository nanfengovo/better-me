import { HttpUrlSchema, SourceDefinitionSchema, TimestampSchema, type SourceCapability, type SourceDefinition, type SourceRuntime } from "@better-me/opportunities";
import {
  SourceAdapterMetadataSchema, SourceJobRecordSchema, SourcePageSchema, SourceRegistryError, SourceScopeSchema,
  type SourceAdapter, type SourceAdapterDetailRequest, type SourceAdapterOriginalRequest, type SourceAdapterMetadata, type SourceAdapterRequest, type SourceAdapterResolution,
  type SourceFilter, type SourceJobRecord, type SourcePage,
} from "./contracts.js";

function adapterKey(id: string, version: string): string { return JSON.stringify([id, version]); }

/** Adapters are explicitly installed code. Source JSON never imports or evaluates executable modules. */
export class SourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  constructor(adapters: readonly SourceAdapter[] = []) { for (const adapter of adapters) this.register(adapter); }

  register(adapter: SourceAdapter): void {
    if (!adapter || typeof adapter.list !== "function" || (adapter.readDetail !== undefined && typeof adapter.readDetail !== "function")
      || (adapter.readOriginal !== undefined && typeof adapter.readOriginal !== "function")
      || (adapter.matchesOriginalUrl !== undefined && typeof adapter.matchesOriginalUrl !== "function")) throw new SourceRegistryError("invalid-source");
    const parsed = SourceAdapterMetadataSchema.safeParse({ adapterId: adapter.adapterId, version: adapter.version, capabilities: adapter.capabilities, remoteFilters: adapter.remoteFilters, entityTypes: adapter.entityTypes });
    if (!parsed.success) throw new SourceRegistryError("invalid-source");
    const key = adapterKey(parsed.data.adapterId, parsed.data.version);
    if (this.adapters.has(key)) throw new SourceRegistryError("duplicate-adapter");
    this.adapters.set(key, Object.freeze({ ...parsed.data, list: adapter.list.bind(adapter),
      ...(adapter.readDetail ? { readDetail: adapter.readDetail.bind(adapter) } : {}),
      ...(adapter.readOriginal ? { readOriginal: adapter.readOriginal.bind(adapter) } : {}),
      ...(adapter.matchesOriginalUrl ? { matchesOriginalUrl: adapter.matchesOriginalUrl.bind(adapter) } : {}) }));
  }

  describe(): SourceAdapterMetadata[] {
    return [...this.adapters.values()].map((adapter) => SourceAdapterMetadataSchema.parse({
      adapterId: adapter.adapterId, version: adapter.version, capabilities: [...adapter.capabilities],
      remoteFilters: [...adapter.remoteFilters], entityTypes: [...adapter.entityTypes],
    }))
      .sort((a, b) => a.adapterId.localeCompare(b.adapterId) || a.version.localeCompare(b.version));
  }

  matchesOriginalUrl(sourceInput: SourceDefinition, url: string): boolean {
    try {
      const source = SourceDefinitionSchema.safeParse(sourceInput);
      if (!source.success || source.data.entityType !== "job-posting" || !HttpUrlSchema.safeParse(url).success) return false;
      const { adapter } = this.resolve(source.data, "list-jobs", "local-service");
      return Boolean(adapter.readOriginal && adapter.matchesOriginalUrl?.({ source: source.data, url }) === true);
    } catch { return false; }
  }

  async readDetail(request: SourceAdapterDetailRequest): Promise<SourceJobRecord> {
    const source = SourceDefinitionSchema.safeParse(request?.source);
    const observedAt = request?.context?.observedAt;
    if (!source.success || typeof request.sourceRecordId !== "string" || !request.sourceRecordId.trim()
      || request.sourceRecordId.length > 1000 || /[\p{Cc}\p{Cs}]/u.test(request.sourceRecordId)
      || !HttpUrlSchema.safeParse(request.url).success || !TimestampSchema.safeParse(observedAt).success
      || typeof request.context?.throwIfCancelled !== "function" || typeof request.transport?.request !== "function"
      || Object.keys(request).some(key => !["source", "sourceRecordId", "url", "context", "transport"].includes(key))) {
      throw new SourceRegistryError("invalid-source");
    }
    const resolution = this.resolve(source.data, "list-jobs", "local-service");
    if (source.data.entityType !== "job-posting" || !resolution.adapter.readDetail) throw new SourceRegistryError("unsupported-capability");
    const sourceRecordId = request.sourceRecordId, url = request.url;
    request.context.throwIfCancelled();
    const result = SourceJobRecordSchema.safeParse(await resolution.adapter.readDetail({
      source: source.data, sourceRecordId, url,
      context: request.context, transport: request.transport,
    }));
    request.context.throwIfCancelled();
    if (!result.success || result.data.entityType !== "job-posting" || result.data.sourceRecordId !== sourceRecordId
      || result.data.url !== url || request.context.observedAt !== observedAt) throw new SourceRegistryError("invalid-output");
    return result.data;
  }

  async readOriginal(request: SourceAdapterOriginalRequest): Promise<SourceJobRecord> {
    const source = SourceDefinitionSchema.safeParse(request?.source);
    const observedAt = request?.context?.observedAt;
    if (!source.success || !HttpUrlSchema.safeParse(request.url).success || !TimestampSchema.safeParse(observedAt).success
      || typeof request.context?.throwIfCancelled !== "function" || typeof request.transport?.request !== "function"
      || Object.keys(request).some(key => !["source", "url", "context", "transport"].includes(key))) {
      throw new SourceRegistryError("invalid-source");
    }
    const resolution = this.resolve(source.data, "list-jobs", "local-service");
    if (source.data.entityType !== "job-posting" || !resolution.adapter.readOriginal) throw new SourceRegistryError("unsupported-capability");
    const url = request.url;
    request.context.throwIfCancelled();
    const result = SourceJobRecordSchema.safeParse(await resolution.adapter.readOriginal({
      source: source.data, url, context: request.context, transport: request.transport,
    }));
    request.context.throwIfCancelled();
    if (!result.success || result.data.entityType !== "job-posting" || result.data.url !== url
      || !result.data.sourceRecordId?.trim() || result.data.sourceRecordId.length > 1000 || /[\p{Cc}\p{Cs}]/u.test(result.data.sourceRecordId)
      || request.context.observedAt !== observedAt) throw new SourceRegistryError("invalid-output");
    return result.data;
  }

  resolve(sourceInput: SourceDefinition, capability: SourceCapability = "list-jobs", runtime?: SourceRuntime): SourceAdapterResolution {
    const parsed = SourceDefinitionSchema.safeParse(sourceInput);
    if (!parsed.success) throw new SourceRegistryError("invalid-source");
    const source = parsed.data;
    if (!source.enabled || source.status !== "active") throw new SourceRegistryError("source-disabled");
    const adapter = this.adapters.get(adapterKey(source.adapterId, source.adapterVersion));
    if (!adapter) throw new SourceRegistryError([...this.adapters.values()].some((value) => value.adapterId === source.adapterId) ? "unsupported-version" : "adapter-not-found");
    if (!source.capabilities.includes(capability) || !adapter.capabilities.includes(capability) || (runtime && !source.runtime.includes(runtime))) throw new SourceRegistryError("unsupported-capability");
    const expectedEntity = source.entityType === "company-directory" ? "discovery-lead" : source.entityType;
    if (!adapter.entityTypes.includes(expectedEntity)) throw new SourceRegistryError("unsupported-capability");
    return {
      adapter: { ...adapter, capabilities: [...adapter.capabilities], remoteFilters: [...adapter.remoteFilters], entityTypes: [...adapter.entityTypes] },
      capabilities: adapter.capabilities.filter((value) => source.capabilities.includes(value)),
      remoteFilters: adapter.remoteFilters.filter((value) => source.remoteFilters.includes(value)),
    };
  }

  async list(request: SourceAdapterRequest): Promise<SourcePage> {
    const source = SourceDefinitionSchema.safeParse(request.source);
    const scope = SourceScopeSchema.safeParse(request.scope);
    if (!source.success || !scope.success || !TimestampSchema.safeParse(request.context?.observedAt).success ||
        (request.cursor !== undefined && (typeof request.cursor !== "string" || request.cursor.length < 1 || request.cursor.length > 2000))) throw new SourceRegistryError("invalid-source");
    const resolution = this.resolve(source.data);
    request.context.throwIfCancelled();
    const page = SourcePageSchema.safeParse(await resolution.adapter.list({ ...request, source: source.data, scope: scope.data }));
    request.context.throwIfCancelled();
    if (!page.success) throw new SourceRegistryError("invalid-output");
    const value = page.data;
    if (value.observedAt !== request.context.observedAt || value.records.length > source.data.refreshPolicy.maxRecords ||
        value.records.some((record) => !resolution.adapter.entityTypes.includes(record.entityType))) throw new SourceRegistryError("invalid-output");
    const requestedFilters = (["roles", "regions", "companyNames"] as SourceFilter[]).filter((filter) => scope.data[filter].length > 0);
    if (value.coverage.appliedFilters.some((filter) => !resolution.remoteFilters.includes(filter) || !requestedFilters.includes(filter)) ||
        value.coverage.ignoredFilters.some((filter) => !requestedFilters.includes(filter)) ||
        requestedFilters.some((filter) => !value.coverage.appliedFilters.includes(filter) && !value.coverage.ignoredFilters.includes(filter))) throw new SourceRegistryError("invalid-output");
    return scope.data.countryCodes?.length ? { ...value, warnings: [...new Set([
      "Country-code constraints are checked locally on the same location as region interests; no upstream country-filter support is claimed.",
      ...value.warnings,
    ])].slice(0, 100) } : value;
  }
}

export function createSourceRegistry(adapters: readonly SourceAdapter[] = []): SourceRegistry { return new SourceRegistry(adapters); }
