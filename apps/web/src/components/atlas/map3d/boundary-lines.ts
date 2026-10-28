/** Retain WGS84 rings exactly, including islands/holes. Never snap an administrative line to a coastline. */
export function boundaryRings(geoJson: unknown): number[][] {
  if (!geoJson || typeof geoJson !== "object") return [];
  const value = geoJson as { type?: string; features?: unknown[]; geometry?: unknown; coordinates?: unknown[] };
  if (value.type === "FeatureCollection") return (value.features ?? []).flatMap(boundaryRings);
  if (value.type === "Feature") return boundaryRings(value.geometry);
  const polygons = value.type === "MultiPolygon" ? value.coordinates : value.type === "Polygon" ? [value.coordinates] : [];
  return (polygons ?? []).flatMap(polygon => Array.isArray(polygon) ? polygon.flatMap(ring => {
    if (!Array.isArray(ring) || ring.length < 4 || ring.some(point => !Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90)) return [];
    return [ring.flatMap(point => [point[0], point[1]])];
  }) : []);
}
