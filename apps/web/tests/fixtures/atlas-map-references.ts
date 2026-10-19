import { fingerprintMapReferenceLocation, MapReferencesResultSchema, type AtlasDataset, type MapReferencesResult, type UnresolvedMapReference } from "@better-me/opportunities";

/** Entirely synthetic place records for offline UI tests, never real office coordinates. */
export async function createMapReferenceFixture(data: AtlasDataset): Promise<MapReferencesResult> {
  const places: MapReferencesResult["places"] = [], references: MapReferencesResult["references"] = [], unresolved: UnresolvedMapReference[] = [];
  for (const [index, location] of data.locations.entries()) {
    const reason = location.coordinates ? "existing-coordinate" : location.kind === "remote-region" ? "remote-region"
      : !location.countryCode ? "missing-country" : !location.city ? "missing-city" : undefined;
    if (reason) { unresolved.push({ locationId: location.id, reason }); continue; }
    const placeId = `place.synthetic.${index}`;
    places.push({ place: { id: placeId, name: location.city!, aliases: [], countryCode: location.countryCode!, alternateCountryCodes: [],
      coordinates: { coordinateSystem: "WGS84", latitude: 31 + index / 100, longitude: 121 + index / 100 },
      administrativeCodes: {}, featureCode: "PPL", population: 20000, sourceModifiedDate: "2026-10-19",
      sourceRecordUrl: `https://places.example.invalid/${index}` }, shardSha256: "b".repeat(64), precision: "city", estimated: true,
      coordinateMeaning: "populated-place-reference-point", verification: "unverified" });
    references.push({ locationId: location.id, locationFingerprint: await fingerprintMapReferenceLocation(location), placeId,
      countryCode: location.countryCode!, city: location.city!, matchedName: location.city!, match: "exact-name" });
  }
  return MapReferencesResultSchema.parse({ schemaVersion: 1, snapshotRevision: data.revision, providerId: "synthetic-map-reference-provider",
    provenance: { datasetId: "synthetic", version: "synthetic-v1", sourceUrl: "https://places.example.invalid/data.zip",
      sourceArchiveSha256: "a".repeat(64), retrievedAt: "2026-10-19T00:00:00Z", license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/", attribution: "Synthetic city references, not office coordinates.",
      coordinateSystem: "WGS84", coverage: "Finite synthetic city points." },
    places, references, unresolved, warnings: ["Synthetic city point; excluded from home distance."],
    totalLocations: data.locations.length, processedLocations: data.locations.length, truncated: false });
}
