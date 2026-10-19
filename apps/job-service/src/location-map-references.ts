import { MapReferencesInputSchema, MapReferencesResultSchema, MapReferenceProjectionSchema, ToolError, defineTool, fingerprintMapReferenceLocation } from "@better-me/opportunities";
import { GeocodingProviderError, type MapReferenceProvider } from "@better-me/source-adapters";
import type { JobRepository } from "./repository.js";

/** Snapshot-bound derived map data. No repository write, address confirmation or private anchor is involved. */
export function createLocationMapReferencesTool(repository: Pick<JobRepository, "readSnapshot">, provider: MapReferenceProvider) {
  return defineTool({
    name: "locations.map-references", version: 1, effect: "read-index",
    description: "从同版本岗位地点的明确国家和城市派生离线城市分布参考，保留地名来源和歧义；不核实办公地址、不写索引、不计算离家距离。",
    inputSchema: MapReferencesInputSchema,
    outputSchema: MapReferencesResultSchema,
    execute: async (input, context) => {
      context.throwIfCancelled();
      if (provider.offline !== true) throw new ToolError("unsupported-capability");
      const snapshot = await repository.readSnapshot(); context.throwIfCancelled();
      if (snapshot.revision !== input.expectedRevision) throw new ToolError("stale-version");
      const ids = input.locationIds ? new Set(input.locationIds) : undefined;
      const selected = snapshot.locations.filter(location => !ids || ids.has(location.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      if (ids && selected.length !== ids.size) throw new ToolError("invalid-input");
      const locations = selected.slice(0, input.limit);
      try {
        const projection = MapReferenceProjectionSchema.parse(await provider.resolveMapReferences(locations, context));
        context.throwIfCancelled();
        if (projection.providerId !== provider.providerId || projection.references.length + projection.unresolved.length !== locations.length
          || [...projection.references, ...projection.unresolved].some(row => !locations.some(location => location.id === row.locationId))) throw new ToolError("invalid-output");
        const byId = new Map(locations.map(location => [location.id, location]));
        for (const reference of projection.references) {
          const location = byId.get(reference.locationId)!;
          if (location.kind === "remote-region" || location.coordinates || location.verification === "conflicting"
            || location.countryCode !== reference.countryCode || location.city !== reference.city
            || await fingerprintMapReferenceLocation(location) !== reference.locationFingerprint) throw new ToolError("invalid-output");
          context.throwIfCancelled();
        }
        return MapReferencesResultSchema.parse({ schemaVersion: 1, snapshotRevision: snapshot.revision, ...projection,
          totalLocations: selected.length, processedLocations: locations.length, truncated: selected.length > locations.length });
      } catch (error) {
        if (error instanceof ToolError) throw error;
        if (error instanceof GeocodingProviderError) throw new ToolError(error.code === "cancelled" ? "cancelled" : error.code === "invalid-request" ? "invalid-input" : "source-changed");
        throw new ToolError("invalid-output");
      }
    },
  });
}
