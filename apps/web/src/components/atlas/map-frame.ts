import type { MapBucket, MapDisplayGrade } from "@better-me/opportunities";

export type MapResultFrame = {
  bounds: [west: number, south: number, east: number, north: number];
  maxZoom: number;
};

const zoomCap: Record<MapDisplayGrade, number> = { building: 16, street: 14.5, address: 15, city: 9 };
const singlePad: Record<MapDisplayGrade, number> = { building: 0.008, street: 0.03, address: 0.02, city: 0.42 };
const gradeOrder: MapDisplayGrade[] = ["city", "address", "street", "building"];

export function mapBucketGrade(bucket: Pick<MapBucket, "displayGrade" | "positionBasis" | "precision">): MapDisplayGrade {
  if (bucket.displayGrade) return bucket.displayGrade;
  if (bucket.positionBasis === "city-reference" || bucket.precision === "city") return "city";
  return "address";
}

function finer(left: MapDisplayGrade, right: MapDisplayGrade): MapDisplayGrade {
  return gradeOrder.indexOf(left) >= gradeOrder.indexOf(right) ? left : right;
}

/** Frame the camera on plotted points. City estimates stay at city scale; an empty result keeps the overview. */
export function frameSearchMap(buckets: readonly MapBucket[]): MapResultFrame | null {
  const points = buckets.filter((bucket) => Number.isFinite(bucket.latitude) && Number.isFinite(bucket.longitude)
    && bucket.latitude >= -90 && bucket.latitude <= 90 && bucket.longitude >= -180 && bucket.longitude <= 180 && bucket.jobCount > 0);
  if (!points.length) return null;
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity, finest: MapDisplayGrade = "city";
  for (const bucket of points) {
    west = Math.min(west, bucket.longitude); east = Math.max(east, bucket.longitude);
    south = Math.min(south, bucket.latitude); north = Math.max(north, bucket.latitude);
    finest = finer(finest, mapBucketGrade(bucket));
  }
  if (east - west > 180 || north - south > 120) return null;
  const pad = points.length === 1 ? singlePad[mapBucketGrade(points[0]!)] : Math.min(0.6, Math.max(0.012, (east - west) * 0.12, (north - south) * 0.12));
  const latitude = (value: number) => Math.max(-85, Math.min(85, value));
  const longitude = (value: number) => Math.max(-180, Math.min(180, value));
  return {
    bounds: [longitude(west - pad), latitude(south - pad), longitude(east + pad), latitude(north + pad)],
    maxZoom: zoomCap[finest],
  };
}
