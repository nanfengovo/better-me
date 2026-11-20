import type { MapBucket } from "@better-me/opportunities";
import { isMappableOfficeBucket } from "../prototypes/map-performance";

export type SceneDetail = number | "exact";
export type SceneMarker = {
  id: string;
  longitude: number;
  latitude: number;
  bucketIds: string[];
  jobCount: number;
  coordinateCount: number;
  color: string;
  label: string;
};

const exactZoom = 15;
const defaultColor = "#3a9e85";

/** A little hysteresis avoids rebuilding marker groups at a camera zoom boundary. */
export function sceneDetailForZoom(zoom: number, previous?: SceneDetail): SceneDetail {
  if (!Number.isFinite(zoom)) return previous ?? 0;
  if (previous === "exact" && zoom >= exactZoom - .2) return previous;
  if (typeof previous === "number" && zoom >= previous - .2 && zoom < previous + 1.2) return previous;
  return zoom >= exactZoom ? "exact" : Math.max(0, Math.floor(zoom));
}

export function isSceneOffice(bucket: MapBucket): boolean {
  return isMappableOfficeBucket(bucket)
    && Number.isFinite(bucket.longitude) && Number.isFinite(bucket.latitude)
    && Math.abs(bucket.longitude) <= 180 && Math.abs(bucket.latitude) <= 90 && bucket.jobCount > 0;
}

type MarkerGroup = {
  marker: SceneMarker;
  coordinates: Set<string>;
  jobs: Set<string>;
  fallbackJobs: number;
  anchorDistance: number;
};

/** At overview scale groups represent cells, anchored at a real member coordinate.
 * At street scale every marker is located at its original source coordinate. */
export function sceneMarkers(buckets: readonly MapBucket[], detail: SceneDetail = "exact"): Map<string, SceneMarker> {
  const groups = new Map<string, MarkerGroup>();
  const cellSize = detail === "exact" ? 0 : 360 / 2 ** (detail + 3);
  for (const bucket of buckets) {
    if (!isSceneOffice(bucket)) continue;
    const { longitude, latitude } = bucket;
    const coordinate = `${longitude},${latitude}`;
    const normalizedLongitude = longitude === 180 ? -180 : longitude;
    const x = cellSize ? Math.floor((normalizedLongitude + 180) / cellSize) : 0;
    const y = cellSize ? Math.min(Math.floor(180 / cellSize) - 1, Math.floor((latitude + 90) / cellSize)) : 0;
    const cell = cellSize ? `region:${detail}:${x}:${y}` : coordinate;
    const distance = cellSize
      ? (normalizedLongitude - ((x + .5) * cellSize - 180)) ** 2 + (latitude - ((y + .5) * cellSize - 90)) ** 2
      : 0;
    const color = bucket.categories.find(category => /^#[a-f\d]{6}$/i.test(category.color))?.color ?? defaultColor;
    let group = groups.get(cell);
    if (!group) {
      group = {
        marker: { id: cell, longitude, latitude, bucketIds: [], jobCount: 0, coordinateCount: 0, color, label: bucket.label },
        coordinates: new Set(), jobs: new Set(), fallbackJobs: 0, anchorDistance: Infinity,
      };
      groups.set(cell, group);
    }
    const { marker } = group;
    marker.bucketIds.push(bucket.id);
    if (marker.color !== color) marker.color = defaultColor;
    if (distance < group.anchorDistance || (distance === group.anchorDistance && coordinate < `${marker.longitude},${marker.latitude}`)) {
      marker.longitude = longitude; marker.latitude = latitude; marker.label = bucket.label;
      group.anchorDistance = distance;
    }
    group.coordinates.add(coordinate);
    for (const job of bucket.jobIds ?? []) group.jobs.add(job);
    if (!bucket.jobIds?.length) group.fallbackJobs += bucket.jobCount;
  }
  return new Map([...groups.values()].map(({ marker, coordinates, jobs, fallbackJobs }) => {
    marker.jobCount = jobs.size + fallbackJobs;
    marker.coordinateCount = coordinates.size;
    if (coordinates.size === 1) marker.id = coordinates.values().next().value!;
    else marker.label = `${coordinates.size} 个来源坐标`;
    return [marker.id, marker];
  }));
}

export function sameMarker(a: SceneMarker, b: SceneMarker): boolean {
  return a.longitude === b.longitude && a.latitude === b.latitude && a.jobCount === b.jobCount
    && a.coordinateCount === b.coordinateCount && a.color === b.color && a.label === b.label
    && a.bucketIds.length === b.bucketIds.length && a.bucketIds.every((id, i) => id === b.bucketIds[i]);
}

/** Camera movement changes the projection only when its detail band changes.
 * The bucket identities and source coordinates remain available for picking. */
export function createSceneReconciler(write: { upsert: (marker: SceneMarker) => void; remove: (id: string) => void; select: (id?: string) => void; render: () => void }) {
  let input: readonly MapBucket[] | undefined;
  let detail: SceneDetail | undefined;
  let markers = new Map<string, SceneMarker>();
  let bucketToMarker = new Map<string, string>();
  let selected: string | undefined;
  return (buckets: readonly MapBucket[], selectedBucketId?: string, nextDetail: SceneDetail = "exact") => {
    let changed = false;
    if (input !== buckets || detail !== nextDetail) {
      const next = sceneMarkers(buckets, nextDetail);
      for (const id of markers.keys()) if (!next.has(id)) { write.remove(id); changed = true; }
      for (const [id, marker] of next) if (!markers.has(id) || !sameMarker(markers.get(id)!, marker)) { write.upsert(marker); changed = true; }
      markers = next; input = buckets; detail = nextDetail;
      bucketToMarker = new Map([...markers.values()].flatMap(marker => marker.bucketIds.map(id => [id, marker.id] as const)));
    }
    const nextSelected = selectedBucketId ? bucketToMarker.get(selectedBucketId) : undefined;
    if (selected !== nextSelected || changed) { write.select(nextSelected); selected = nextSelected; changed = true; }
    if (changed) write.render();
    return markers;
  };
}
