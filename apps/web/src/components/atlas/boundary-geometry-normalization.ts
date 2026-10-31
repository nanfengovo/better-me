/*!
 * GCJ-02 conversion adapted from wandergis/coordtransform, MIT.
 * Copyright (c) 2015 记忆的残骸
 * Pinned source: 606c6f3b57b6f1d60458793fea39928d2b11b637.
 * Full license: ./geo/COORDTRANSFORM-LICENSE.md
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

export type GeoJsonFeature = {
  type: "Feature";
  id?: string | number;
  bbox?: number[];
  properties?: Record<string, any>;
  geometry: {
    type: string;
    coordinates: any;
    bbox?: number[];
  };
};

export type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  bbox?: number[];
  features: GeoJsonFeature[];
};

export type AdminGeoJson = GeoJsonFeatureCollection | GeoJsonFeature;
export type BoundaryCoordinateSystem = "GCJ-02" | "WGS84";

/** Source CRS is explicit: never infer it from a location or a .geojson suffix. */
export type BoundaryGeometryInput<T extends AdminGeoJson> = {
  geoJson: T;
  coordinateSystem: BoundaryCoordinateSystem;
};

const SEMI_MAJOR_AXIS = 6378245;
const ECCENTRICITY_SQUARED = 0.006693421622965943;

/**
 * The public coordtransform one-pass inverse, not a survey-grade transformation.
 * Its applicability rectangle is algorithmic, not an administrative boundary.
 * Only call for source data documented as GCJ-02. WGS84 data must pass through.
 */
function gcj02ToWgs84(longitude: number, latitude: number): [number, number] {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
    || !(longitude > 73.66 && longitude < 135.05 && latitude > 3.86 && latitude < 53.55)) {
    return [longitude, latitude];
  }

  const x = longitude - 105;
  const y = latitude - 35;
  let latitudeOffset = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  latitudeOffset += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  latitudeOffset += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  latitudeOffset += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;

  let longitudeOffset = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  longitudeOffset += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  longitudeOffset += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  longitudeOffset += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;

  const radians = latitude * Math.PI / 180;
  const sine = Math.sin(radians);
  const magic = 1 - ECCENTRICITY_SQUARED * sine * sine;
  const root = Math.sqrt(magic);
  const latitudeDelta = latitudeOffset * 180
    / ((SEMI_MAJOR_AXIS * (1 - ECCENTRICITY_SQUARED)) / (magic * root) * Math.PI);
  const longitudeDelta = longitudeOffset * 180
    / (SEMI_MAJOR_AXIS / root * Math.cos(radians) * Math.PI);
  return [longitude - longitudeDelta, latitude - latitudeDelta];
}

function normalizeCoordinates(coordinates: unknown): unknown {
  if (!Array.isArray(coordinates)) return coordinates;
  if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    // Preserve altitude/extra position dimensions, ring closure, holes and parts.
    return [...gcj02ToWgs84(coordinates[0], coordinates[1]), ...coordinates.slice(2)];
  }
  return coordinates.map(normalizeCoordinates);
}

function boundsOfCoordinates(coordinates: unknown): number[] | undefined {
  const min: number[] = [];
  const max: number[] = [];
  function visit(value: unknown) {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      value.forEach((entry: unknown, index: number) => {
        if (typeof entry !== "number" || !Number.isFinite(entry)) return;
        min[index] = Math.min(min[index] ?? Infinity, entry);
        max[index] = Math.max(max[index] ?? -Infinity, entry);
      });
    } else {
      value.forEach(visit);
    }
  }
  visit(coordinates);
  return min.length >= 2 ? [...min, ...max] : undefined;
}

function normalizeFeature(feature: GeoJsonFeature): GeoJsonFeature {
  const coordinates = normalizeCoordinates(feature.geometry.coordinates);
  const geometry = { ...feature.geometry, coordinates };
  if (geometry.bbox) geometry.bbox = boundsOfCoordinates(coordinates);
  const properties = feature.properties ? { ...feature.properties } : undefined;
  // DataV's documented metadata positions share its source CRS. Do not alter
  // administrative codes, names, or unrelated metadata that happen to be arrays.
  if (properties) {
    for (const key of ["center", "centroid"]) {
      const position = properties[key];
      if (Array.isArray(position) && typeof position[0] === "number" && typeof position[1] === "number") {
        properties[key] = normalizeCoordinates(position);
      }
    }
  }
  return {
    ...feature,
    geometry,
    ...(properties ? { properties } : {}),
    ...(feature.bbox ? { bbox: boundsOfCoordinates(coordinates) } : {}),
  };
}

/**
 * Normalize once at a documented source boundary, before caching or styling.
 * The returned WGS84 envelope is a no-op when passed back in; raw data is never
 * mutated. No simplification, coastline snapping or source-version replacement.
 */
export function normalizeBoundaryGeometry<T extends AdminGeoJson>(
  input: BoundaryGeometryInput<T>
): { geoJson: T; coordinateSystem: "WGS84" } {
  if (input.coordinateSystem === "WGS84") {
    return { geoJson: input.geoJson, coordinateSystem: "WGS84" };
  }
  const data = input.geoJson;
  const normalized = data.type === "Feature"
    ? normalizeFeature(data)
    : { ...data, features: data.features.map(normalizeFeature) };
  if (normalized.type === "FeatureCollection" && normalized.bbox) {
    normalized.bbox = boundsOfCoordinates(normalized.features.map((feature) => feature.geometry.coordinates));
  }
  return { geoJson: normalized as T, coordinateSystem: "WGS84" };
}
