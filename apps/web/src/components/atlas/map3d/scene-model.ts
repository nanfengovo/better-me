import type { MapBucket } from "@better-me/opportunities";
import { isMappableOfficeBucket } from "../prototypes/map-performance";

export type SceneMarker = { id: string; longitude: number; latitude: number; bucketIds: string[]; jobCount: number; color: string; label: string };
/** Exact-coordinate aggregation, no jitter, geocoding, inferred heights, or fact writes. */
export function sceneMarkers(buckets: readonly MapBucket[]): Map<string, SceneMarker> {
  const groups = new Map<string, { marker: SceneMarker; jobs: Set<string>; fallbackJobs: number }>();
  for (const bucket of buckets) {
    if (!isMappableOfficeBucket(bucket) || !Number.isFinite(bucket.longitude) || !Number.isFinite(bucket.latitude)
      || Math.abs(bucket.longitude) > 180 || Math.abs(bucket.latitude) > 90 || !(bucket.jobCount > 0)) continue;
    const id = `${bucket.longitude},${bucket.latitude}`;
    let group = groups.get(id);
    const color = bucket.categories.find(category => /^#[a-f\d]{6}$/i.test(category.color))?.color ?? "#3a9e85";
    if (!group) {
      group = { marker: { id, longitude: bucket.longitude, latitude: bucket.latitude, bucketIds: [], jobCount: 0, color, label: bucket.label }, jobs: new Set(), fallbackJobs: 0 };
      groups.set(id, group);
    }
    group.marker.bucketIds.push(bucket.id);
    if (group.marker.color !== color) group.marker.color = "#3a9e85";
    for (const job of bucket.jobIds ?? []) group.jobs.add(job);
    if (!bucket.jobIds?.length) group.fallbackJobs += bucket.jobCount;
  }
  return new Map([...groups].map(([id, { marker, jobs, fallbackJobs }]) => {
    marker.jobCount = jobs.size + fallbackJobs;
    return [id, marker];
  }));
}

export function sameMarker(a: SceneMarker, b: SceneMarker): boolean {
  return a.longitude === b.longitude && a.latitude === b.latitude && a.jobCount === b.jobCount && a.color === b.color
    && a.label === b.label && a.bucketIds.length === b.bucketIds.length && a.bucketIds.every((id, i) => id === b.bucketIds[i]);
}

/** Testable scene reconciliation seam. Camera/UI updates do not rebuild/upload the full library. */
export function createSceneReconciler(write: { upsert: (marker: SceneMarker) => void; remove: (id: string) => void; select: (id?: string) => void; render: () => void }) {
  let input: readonly MapBucket[] | undefined;
  let markers = new Map<string, SceneMarker>();
  let bucketToMarker = new Map<string, string>();
  let selected: string | undefined;
  return (buckets: readonly MapBucket[], selectedBucketId?: string) => {
    let changed = false;
    if (input !== buckets) {
      const next = sceneMarkers(buckets);
      for (const id of markers.keys()) if (!next.has(id)) { write.remove(id); changed = true; }
      for (const [id, marker] of next) if (!markers.has(id) || !sameMarker(markers.get(id)!, marker)) { write.upsert(marker); changed = true; }
      markers = next; input = buckets;
      bucketToMarker = new Map([...markers.values()].flatMap(marker => marker.bucketIds.map(id => [id, marker.id] as const)));
    }
    const nextSelected = selectedBucketId ? bucketToMarker.get(selectedBucketId) : undefined;
    if (selected !== nextSelected || changed) { write.select(nextSelected); selected = nextSelected; changed = true; }
    if (changed) write.render();
    return markers;
  };
}
