import { SourceDefinitionSchema, TimestampSchema, type SourceCapability, type SourceDefinition, type SourceRuntime } from "@better-me/opportunities";
import {
  SourceAdapterMetadataSchema, SourcePageSchema, SourceRegistryError, SourceScopeSchema,
  type SourceAdapter, type SourceAdapterMetadata, type SourceAdapterRequest, type SourceAdapterResolution,
  type SourceFilter, type SourcePage,
} from "./contracts.js";

function adapterKey(id: string, version: string): string { return JSON.stringify([id, version]); }

/** Adapters are explicitly installed code. Source JSON never imports or evaluates executable modules. */
export class SourceRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  constructor(adapters: readonly SourceAdapter[] = []) { for (const adapter of adapters) this.register(adapter); }

  register(adapter: SourceAdapter): void {
    if (!adapter || typeof adapter.list !== "function") throw new SourceRegistryError("invalid-source");
    const parsed = SourceAdapterMetadataSchema.safeParse({ adapterId: adapter.adapterId, version: adapter.version, capabilities: adapter.capabilities, remoteFilters: adapter.remoteFilters, entityTypes: adapter.entityTypes });
    if (!parsed.success) throw new SourceRegistryError("invalid-source");
    const key = adapterKey(parsed.data.adapterId, parsed.data.version);
    if (this.adapters.has(key)) throw new SourceRegistryError("duplicate-adapter");
    this.adapters.set(key, Object.freeze({ ...parsed.data, list: adapter.list.bind(adapter) }));
  }

  describe(): SourceAdapterMetadata[] {
    return [...this.adapters.values()].map(({ list: _list, ...metadata }) => structuredClone(metadata))
      .sort((a, b) => a.adapterId.localeCompare(b.adapterId) || a.version.localeCompare(b.version));
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
