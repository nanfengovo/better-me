import type { MapBucket } from "@better-me/opportunities";

/** A list selection only. It never invents a combined coordinate or office. */
export type AtlasBucketSelection = Pick<MapBucket, "id" | "label" | "jobIds" | "jobCount" | "positionBasis"> & {
  memberBucketIds?: string[];
};

export function selectAtlasBuckets(buckets: readonly MapBucket[]): AtlasBucketSelection | null {
  const unique = [...new Map(buckets.map(bucket => [bucket.id, bucket])).values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!unique.length) return null;
  if (unique.length === 1) return unique[0]!;
  const memberBucketIds = unique.map(bucket => bucket.id), jobIds = [...new Set(unique.flatMap(bucket => bucket.jobIds))].sort();
  return { id: JSON.stringify(["overlapping-markers", memberBucketIds]), label: `重叠标记 · ${unique.length} 组`, jobIds, jobCount: jobIds.length,
    memberBucketIds, ...(unique.some(bucket => bucket.positionBasis === "city-reference") ? { positionBasis: "city-reference" as const } : {}) };
}

/** Hit order may contain duplicate category rings or obsolete worker features. */
export function atlasHitBuckets(buckets: readonly MapBucket[], ids: readonly unknown[]): MapBucket[] {
  const hits = new Set(ids.filter((id): id is string => typeof id === "string"));
  return buckets.filter(bucket => hits.has(bucket.id));
}

export function atlasSelectedBucketIds(value: { selectedBucketId?: string; selectedBucketIds?: readonly string[] }): string[] {
  return [...new Set([...(value.selectedBucketIds ?? []), ...(value.selectedBucketId ? [value.selectedBucketId] : [])])].sort();
}

export function atlasBucketMatch(ids: readonly string[]): ["in", ["get", string], ["literal", readonly string[]]] {
  return ["in", ["get", "bucketId"], ["literal", ids]];
}
