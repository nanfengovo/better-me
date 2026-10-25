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

/** Administrative outline of the pinned province geojson. Camera only — never a job coordinate. */
const provinceBounds: Record<string, [number, number, number, number]> = {
  "CN-AH": [114.88, 29.408, 119.63, 34.643],
  "CN-BJ": [115.427, 39.442, 117.486, 41.04],
  "CN-CQ": [105.291, 28.192, 110.175, 32.198],
  "CN-FJ": [115.843, 23.573, 120.429, 28.326],
  "CN-GD": [109.661, 20.238, 117.175, 25.518],
  "CN-GS": [92.766, 32.6, 108.704, 42.787],
  "CN-GX": [104.485, 21.021, 112.047, 26.39],
  "CN-GZ": [103.596, 24.631, 109.52, 29.246],
  "CN-HA": [110.328, 31.395, 116.641, 36.365],
  "CN-HB": [108.381, 29.066, 116.147, 33.266],
  "CN-HE": [113.438, 36.061, 119.85, 42.62],
  "CN-HI": [108.615, 15.775, 112.737, 20.164],
  "CN-HK": [113.837, 22.177, 114.401, 22.561],
  "CN-HL": [121.174, 43.436, 134.773, 53.569],
  "CN-HN": [108.791, 24.643, 114.228, 30.096],
  "CN-JL": [121.65, 40.859, 131.282, 46.291],
  "CN-JS": [116.377, 30.764, 121.93, 35.113],
  "CN-JX": [113.562, 24.5, 118.476, 30.056],
  "CN-LN": [118.848, 38.721, 125.766, 43.472],
  "CN-MO": [113.52, 22.105, 113.587, 22.221],
  "CN-NM": [97.191, 37.39, 126.056, 53.324],
  "CN-NX": [104.359, 35.261, 107.662, 39.361],
  "CN-QH": [89.435, 31.535, 103.04, 39.322],
  "CN-SC": [97.361, 26.035, 108.523, 34.298],
  "CN-SD": [114.834, 34.399, 122.689, 38.395],
  "CN-SH": [120.865, 30.691, 121.987, 31.841],
  "CN-SN": [105.499, 31.705, 111.225, 39.581],
  "CN-SX": [110.237, 34.584, 114.541, 40.743],
  "CN-TJ": [116.681, 38.559, 118.01, 40.257],
  "CN-TW": [118.28, 21.905, 122.005, 25.287],
  "CN-XJ": [73.602, 34.34, 96.366, 49.166],
  "CN-XZ": [78.381, 27.312, 99.109, 36.455],
  "CN-YN": [97.513, 21.134, 106.194, 29.224],
  "CN-ZJ": [118.001, 27.182, 122.531, 31.176],
};

/** Frame the selected province when no source coordinate is plotted. Stays at municipality scale. */
export function frameAdminRegion(mapId: string | undefined): MapResultFrame | null {
  const bounds = mapId ? provinceBounds[mapId] : undefined;
  return bounds ? { bounds, maxZoom: 8 } : null;
}
