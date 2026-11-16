import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";

export type BuildingLayerVisualMode = "dark" | "street" | "satellite";

export interface ArchitecturalLightPreset {
  sunAzimuthDeg: number;
  sunElevationDeg: number;
  sunColor: [number, number, number];
  sunIntensity: number;
  skyZenithColor: [number, number, number];
  skyHorizonColor: [number, number, number];
  groundBounceColor: [number, number, number];
  fogColor: [number, number, number];
  shadowColor: [number, number, number];
  dirShadowAlpha: number;
  contactAoAlpha: number;
  nightEmissive: number;
  glassBoost: number;
  opacity: number;
}

/** Physically tuned mode presets aligning directional shadows, sky reflections, and facade materials. */
export const ARCHITECTURAL_LIGHT_PRESETS: Record<BuildingLayerVisualMode, ArchitecturalLightPreset> = {
  street: {
    sunAzimuthDeg: 222,
    sunElevationDeg: 36,
    sunColor: [1.0, 0.94, 0.84],
    sunIntensity: 1.52,
    skyZenithColor: [0.30, 0.58, 0.92],
    skyHorizonColor: [0.85, 0.93, 0.99],
    groundBounceColor: [0.82, 0.78, 0.72],
    fogColor: [0.86, 0.91, 0.96],
    shadowColor: [0.06, 0.12, 0.24],
    dirShadowAlpha: 0.40,
    contactAoAlpha: 0.48,
    nightEmissive: 0.0,
    glassBoost: 1.38,
    opacity: 1.0,
  },
  dark: {
    sunAzimuthDeg: 214,
    sunElevationDeg: 38,
    sunColor: [0.78, 0.90, 1.0],
    sunIntensity: 1.52,
    skyZenithColor: [0.11, 0.24, 0.42],
    skyHorizonColor: [0.28, 0.52, 0.76],
    groundBounceColor: [0.12, 0.20, 0.32],
    fogColor: [0.05, 0.09, 0.16],
    shadowColor: [0.01, 0.02, 0.05],
    dirShadowAlpha: 0.64,
    contactAoAlpha: 0.68,
    nightEmissive: 1.0,
    glassBoost: 1.32,
    opacity: 1.0,
  },
  satellite: {
    sunAzimuthDeg: 215,
    sunElevationDeg: 44,
    sunColor: [1.0, 0.96, 0.88],
    sunIntensity: 1.32,
    skyZenithColor: [0.36, 0.60, 0.88],
    skyHorizonColor: [0.76, 0.85, 0.93],
    groundBounceColor: [0.54, 0.56, 0.53],
    fogColor: [0.18, 0.28, 0.38],
    shadowColor: [0.03, 0.06, 0.13],
    dirShadowAlpha: 0.46,
    contactAoAlpha: 0.48,
    nightEmissive: 0.15,
    glassBoost: 1.04,
    opacity: 0.94,
  },
};

const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6378137;
const MAX_MERCATOR_LAT = 85.05112878;
const DEG_TO_RAD = Math.PI / 180;
const MIN_EXPOSED_HEIGHT_M = 1.2;
const MAX_BUILDING_HEIGHT_M = 850;
const CONTACT_AO_WIDTH_M = 5.2;
const MAX_SHADOW_PROJ_TAN = 2.15;
const DEFAULT_MAX_BUILDINGS_PER_CHUNK = 750;
const DETAIL_PARAPET_DISTANCE_M_SQ = 420 * 420;
const DETAIL_PENTHOUSE_DISTANCE_M_SQ = 520 * 520;

export interface BuildingFeatureInput {
  id?: string | number;
  geometry:
    | { type: "Polygon"; coordinates: number[][][] }
    | { type: "MultiPolygon"; coordinates: number[][][][] };
  properties?: Record<string, unknown> | null;
}

export interface ArchitecturalChunkData {
  originX: number;
  originY: number;
  mercPerMeter: number;
  featureCount: number;
  solidVertices: Float32Array;
  solidVertexCount: number;
  shadowVertices: Float32Array;
  shadowVertexCount: number;
  aoVertices: Float32Array;
  aoVertexCount: number;
  signature: string;
}

/** Project `[lng, lat]` to Web Mercator `[0..1, 0..1]` matching MapLibre's `MercatorCoordinate`. */
export function lngLatToMercatorXY(lng: number, lat: number): [number, number] {
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const x = (lng + 180) / 360;
  const sinLat = Math.sin(clampedLat * DEG_TO_RAD);
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  return [x, y];
}

/** One meter expressed in Web Mercator `[0..1]` coordinate units at `lat`. */
export function mercatorUnitsPerMeterAtLat(lat: number): number {
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  return 1 / (EARTH_CIRCUMFERENCE_M * Math.cos(clampedLat * DEG_TO_RAD));
}

/** Sun unit direction vector in local East-North-Up `(E, N, U)` coordinates. */
export function sunDirectionENU(azimuthDeg: number, elevationDeg: number): [number, number, number] {
  const az = azimuthDeg * DEG_TO_RAD;
  const el = elevationDeg * DEG_TO_RAD;
  const cosEl = Math.cos(el);
  // Geographic azimuth: 0° = North, 90° = East, 180° = South, 270° = West.
  return [Math.sin(az) * cosEl, Math.cos(az) * cosEl, Math.sin(el)];
}

/** Inverse sun horizontal shadow offset vector in Mercator delta per meter of building elevation. */
export function sunShadowMercatorPerMeter(
  azimuthDeg: number,
  elevationDeg: number,
  mercPerMeter: number,
): [number, number] {
  const [sx, sy, sz] = sunDirectionENU(azimuthDeg, elevationDeg);
  const cotEl = Math.min(MAX_SHADOW_PROJ_TAN, 1 / Math.max(0.26, sz));
  const lenXY = Math.hypot(sx, sy) || 1;
  // Shadow falls away from sun; Mercator +Y points South so negate north component.
  const eastFactor = (-sx / lenXY) * cotEl;
  const southFactor = (sy / lenXY) * cotEl;
  return [eastFactor * mercPerMeter, southFactor * mercPerMeter];
}

/** Compose local-origin `MVP` matrix in 64-bit float so high-zoom building vertices retain sub-mm precision. */
export function composeLocalMvpFloat32(
  mainMatrix: ArrayLike<number>,
  originX: number,
  originY: number,
  zMercPerMeter: number,
  out64?: Float64Array,
): Float32Array {
  const col0_0 = mainMatrix[0]!;
  const col0_1 = mainMatrix[1]!;
  const col0_2 = mainMatrix[2]!;
  const col0_3 = mainMatrix[3]!;
  const col1_0 = mainMatrix[4]!;
  const col1_1 = mainMatrix[5]!;
  const col1_2 = mainMatrix[6]!;
  const col1_3 = mainMatrix[7]!;
  const col2_0 = mainMatrix[8]! * zMercPerMeter;
  const col2_1 = mainMatrix[9]! * zMercPerMeter;
  const col2_2 = mainMatrix[10]! * zMercPerMeter;
  const col2_3 = mainMatrix[11]! * zMercPerMeter;
  const col3_0 = mainMatrix[0]! * originX + mainMatrix[4]! * originY + mainMatrix[12]!;
  const col3_1 = mainMatrix[1]! * originX + mainMatrix[5]! * originY + mainMatrix[13]!;
  const col3_2 = mainMatrix[2]! * originX + mainMatrix[6]! * originY + mainMatrix[14]!;
  const col3_3 = mainMatrix[3]! * originX + mainMatrix[7]! * originY + mainMatrix[15]!;

  if (out64) {
    out64[0] = col0_0; out64[1] = col0_1; out64[2] = col0_2; out64[3] = col0_3;
    out64[4] = col1_0; out64[5] = col1_1; out64[6] = col1_2; out64[7] = col1_3;
    out64[8] = col2_0; out64[9] = col2_1; out64[10] = col2_2; out64[11] = col2_3;
    out64[12] = col3_0; out64[13] = col3_1; out64[14] = col3_2; out64[15] = col3_3;
  }

  return new Float32Array([
    col0_0, col0_1, col0_2, col0_3,
    col1_0, col1_1, col1_2, col1_3,
    col2_0, col2_1, col2_2, col2_3,
    col3_0, col3_1, col3_2, col3_3,
  ]);
}

/** 64-bit matrix inversion using cofactor expansion for recovering exact camera position from `MVP`. */
export function invertMat4Float64(m: ArrayLike<number>): Float64Array | null {
  const m00 = m[0]!, m01 = m[1]!, m02 = m[2]!, m03 = m[3]!;
  const m10 = m[4]!, m11 = m[5]!, m12 = m[6]!, m13 = m[7]!;
  const m20 = m[8]!, m21 = m[9]!, m22 = m[10]!, m23 = m[11]!;
  const m30 = m[12]!, m31 = m[13]!, m32 = m[14]!, m33 = m[15]!;

  const b00 = m00 * m11 - m01 * m10;
  const b01 = m00 * m12 - m02 * m10;
  const b02 = m00 * m13 - m03 * m10;
  const b03 = m01 * m12 - m02 * m11;
  const b04 = m01 * m13 - m03 * m11;
  const b05 = m02 * m13 - m03 * m12;
  const b06 = m20 * m31 - m21 * m30;
  const b07 = m20 * m32 - m22 * m30;
  const b08 = m20 * m33 - m23 * m30;
  const b09 = m21 * m32 - m22 * m31;
  const b10 = m21 * m33 - m23 * m31;
  const b11 = m22 * m33 - m23 * m32;

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-24) return null;
  const invDet = 1 / det;

  return new Float64Array([
    (m11 * b11 - m12 * b10 + m13 * b09) * invDet,
    (m02 * b10 - m01 * b11 - m03 * b09) * invDet,
    (m31 * b05 - m32 * b04 + m33 * b03) * invDet,
    (m22 * b04 - m21 * b05 - m23 * b03) * invDet,
    (m12 * b08 - m10 * b11 - m13 * b07) * invDet,
    (m00 * b11 - m02 * b08 + m03 * b07) * invDet,
    (m32 * b02 - m30 * b05 - m33 * b01) * invDet,
    (m20 * b05 - m22 * b02 + m23 * b01) * invDet,
    (m10 * b10 - m11 * b08 + m13 * b06) * invDet,
    (m01 * b08 - m00 * b10 - m03 * b06) * invDet,
    (m30 * b04 - m31 * b02 + m33 * b00) * invDet,
    (m21 * b02 - m20 * b04 - m23 * b00) * invDet,
    (m11 * b07 - m10 * b09 - m12 * b06) * invDet,
    (m00 * b09 - m01 * b07 + m02 * b06) * invDet,
    (m31 * b01 - m30 * b03 - m32 * b00) * invDet,
    (m20 * b03 - m21 * b01 + m22 * b00) * invDet,
  ]);
}

/** Extract camera eye position in local `(eastMeters, northMeters, zMeters)` directly from local MVP. */
export function extractCameraLocalPositionMeters(
  localMvp: ArrayLike<number>,
  mercPerMeter: number,
): [number, number, number] {
  const inv = invertMat4Float64(localMvp);
  if (!inv) return [0, -280, 420];
  // Clip point (0, 0, -1, 0) satisfies P*eye with eye at view origin.
  const cx = -inv[8]!;
  const cy = -inv[9]!;
  const cz = -inv[10]!;
  const cw = -inv[11]!;
  if (!Number.isFinite(cw) || Math.abs(cw) < 1e-18) {
    // Orthographic or degenerate fallback: unproject near-plane center (0, 0, -1, 1).
    const nw = inv[15]! - inv[11]!;
    if (!Number.isFinite(nw) || Math.abs(nw) < 1e-18) return [0, -280, 420];
    const nx = (inv[12]! - inv[8]!) / nw;
    const ny = (inv[13]! - inv[9]!) / nw;
    const nz = (inv[14]! - inv[10]!) / nw;
    return [nx / mercPerMeter, -ny / mercPerMeter, nz];
  }
  return [cx / cw / mercPerMeter, -(cy / cw) / mercPerMeter, cz / cw];
}

function parseOptionalHexColor(raw: unknown): [number, number, number] | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (short) {
    const h = short[1]!;
    return [parseInt(h[0]! + h[0]!, 16) / 255, parseInt(h[1]! + h[1]!, 16) / 255, parseInt(h[2]! + h[2]!, 16) / 255];
  }
  const full = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (!full) return null;
  const h = full[1]!;
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

interface ProjectedRing {
  points: Array<{ dx: number; dy: number; mx: number; my: number }>;
  areaM2: number;
}

function signedAreaMeters(pts: Array<{ mx: number; my: number }>): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    area += a.mx * b.my - b.mx * a.my;
  }
  return area * 0.5;
}

function prepareRing(
  coords: number[][],
  originX: number,
  originY: number,
  mercPerMeter: number,
  wantPositiveMetersArea: boolean,
): ProjectedRing | null {
  if (coords.length < 3) return null;
  const end =
    coords.length > 3
    && coords[0]![0] === coords[coords.length - 1]![0]
    && coords[0]![1] === coords[coords.length - 1]![1]
      ? coords.length - 1
      : coords.length;
  const points: ProjectedRing["points"] = [];
  for (let i = 0; i < end; i++) {
    const pair = coords[i]!;
    const [vx, vy] = lngLatToMercatorXY(pair[0]!, pair[1]!);
    const dx = vx - originX;
    const dy = vy - originY;
    const mx = dx / mercPerMeter;
    const my = -dy / mercPerMeter; // Local East-North meters (Y up = North).
    const prev = points[points.length - 1];
    if (!prev || Math.hypot(mx - prev.mx, my - prev.my) > 0.08) {
      points.push({ dx, dy, mx, my });
    }
  }
  if (points.length >= 2 && Math.hypot(points[0]!.mx - points[points.length - 1]!.mx, points[0]!.my - points[points.length - 1]!.my) <= 0.08) {
    points.pop();
  }
  if (points.length < 3) return null;
  let area = signedAreaMeters(points);
  if (Math.abs(area) < 1.2) return null;
  // In local East-North coordinates (my = North up), CCW rings have area > 0; holes have area < 0.
  if ((wantPositiveMetersArea && area < 0) || (!wantPositiveMetersArea && area > 0)) {
    points.reverse();
    area = -area;
  }
  return { points, areaM2: area };
}

function computeBuildingSeed(mx: number, my: number, height: number, count: number): number {
  const raw = Math.sin(mx * 0.137 + my * 0.293 + height * 1.71 + count * 0.53) * 43758.5453;
  return raw - Math.floor(raw);
}

function pointInRingMeters(px: number, py: number, pts: ProjectedRing["points"]): boolean {
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (!a || !b) continue;
    const intersects = (a.my > py) !== (b.my > py)
      && px < ((b.mx - a.mx) * (py - a.my)) / ((b.my - a.my) || 1e-12) + a.mx;
    if (intersects) inside = !inside;
  }
  return inside;
}

function minDistToRingEdgesMeters(px: number, py: number, pts: ProjectedRing["points"]): number {
  let minSq = Infinity;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (!a || !b) continue;
    const vx = b.mx - a.mx;
    const vy = b.my - a.my;
    const lenSq = vx * vx + vy * vy;
    const t = lenSq > 1e-8 ? Math.max(0, Math.min(1, ((px - a.mx) * vx + (py - a.my) * vy) / lenSq)) : 0;
    const dx = px - (a.mx + vx * t);
    const dy = py - (a.my + vy * t);
    const dSq = dx * dx + dy * dy;
    if (dSq < minSq) minSq = dSq;
  }
  return Math.sqrt(minSq);
}

function findInscribedRoofSite(
  outer: ProjectedRing,
  holes: ProjectedRing[],
  minMx: number,
  maxMx: number,
  minMy: number,
  maxMy: number,
): { mx: number; my: number; radius: number } | null {
  const spanX = maxMx - minMx;
  const spanY = maxMy - minMy;
  if (spanX < 8 || spanY < 8) return null;

  const isInside = (x: number, y: number): boolean => {
    if (!pointInRingMeters(x, y, outer.points)) return false;
    for (const h of holes) {
      if (pointInRingMeters(x, y, h.points)) return false;
    }
    return true;
  };

  const clearanceAt = (x: number, y: number): number => {
    let minD = minDistToRingEdgesMeters(x, y, outer.points);
    for (const h of holes) {
      const hd = minDistToRingEdgesMeters(x, y, h.points);
      if (hd < minD) minD = hd;
    }
    return minD;
  };

  let bestX = (minMx + maxMx) * 0.5;
  let bestY = (minMy + maxMy) * 0.5;
  let bestR = isInside(bestX, bestY) ? clearanceAt(bestX, bestY) : -1;

  const steps = 5;
  for (let gx = 1; gx <= steps; gx++) {
    const x = minMx + (spanX * gx) / (steps + 1);
    for (let gy = 1; gy <= steps; gy++) {
      const y = minMy + (spanY * gy) / (steps + 1);
      if (!isInside(x, y)) continue;
      const r = clearanceAt(x, y);
      if (r > bestR) {
        bestR = r;
        bestX = x;
        bestY = y;
      }
    }
  }
  if (bestR <= 0) return null;

  const fineStep = Math.min(spanX, spanY) / (steps * 2.5);
  for (const dx of [-fineStep, 0, fineStep]) {
    for (const dy of [-fineStep, 0, fineStep]) {
      if (dx === 0 && dy === 0) continue;
      const cx = bestX + dx;
      const cy = bestY + dy;
      if (!isInside(cx, cy)) continue;
      const r = clearanceAt(cx, cy);
      if (r > bestR) {
        bestR = r;
        bestX = cx;
        bestY = cy;
      }
    }
  }
  return { mx: bestX, my: bestY, radius: bestR };
}

function dominantOrientationAngle(pts: ProjectedRing["points"]): number {
  let maxLenSq = 0;
  let angle = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (!a || !b) continue;
    const ex = b.mx - a.mx;
    const ey = b.my - a.my;
    const lenSq = ex * ex + ey * ey;
    if (lenSq > maxLenSq) {
      maxLenSq = lenSq;
      angle = Math.atan2(ey, ex);
    }
  }
  return angle;
}

class Float32Builder {
  private buf: Float32Array;
  public length = 0;

  constructor(initialFloats: number) {
    this.buf = new Float32Array(Math.max(256, initialFloats));
  }

  private ensure(extra: number) {
    const needed = this.length + extra;
    if (needed <= this.buf.length) return;
    let nextLen = this.buf.length * 2;
    while (nextLen < needed) nextLen *= 2;
    const next = new Float32Array(nextLen);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  push14(
    a0: number, a1: number, a2: number, a3: number, a4: number, a5: number, a6: number,
    a7: number, a8: number, a9: number, a10: number, a11: number, a12: number, a13: number,
  ) {
    this.ensure(14);
    const b = this.buf;
    let i = this.length;
    b[i++] = a0; b[i++] = a1; b[i++] = a2; b[i++] = a3;
    b[i++] = a4; b[i++] = a5; b[i++] = a6; b[i++] = a7;
    b[i++] = a8; b[i++] = a9; b[i++] = a10; b[i++] = a11;
    b[i++] = a12; b[i++] = a13;
    this.length = i;
  }

  push12(
    a0: number, a1: number, a2: number, a3: number,
    a4: number, a5: number, a6: number, a7: number,
    a8: number, a9: number, a10: number, a11: number,
  ) {
    this.ensure(12);
    const b = this.buf;
    let i = this.length;
    b[i++] = a0; b[i++] = a1; b[i++] = a2; b[i++] = a3;
    b[i++] = a4; b[i++] = a5; b[i++] = a6; b[i++] = a7;
    b[i++] = a8; b[i++] = a9; b[i++] = a10; b[i++] = a11;
    this.length = i;
  }

  push9(
    a0: number, a1: number, a2: number,
    a3: number, a4: number, a5: number,
    a6: number, a7: number, a8: number,
  ) {
    this.ensure(9);
    const b = this.buf;
    let i = this.length;
    b[i++] = a0; b[i++] = a1; b[i++] = a2;
    b[i++] = a3; b[i++] = a4; b[i++] = a5;
    b[i++] = a6; b[i++] = a7; b[i++] = a8;
    this.length = i;
  }

  finish(): Float32Array {
    return this.length === this.buf.length ? this.buf : this.buf.slice(0, this.length);
  }
}

type RingPt = ProjectedRing["points"][number];

function cross2D(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function pointInTriStrict(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number,
): boolean {
  const c1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  if (c1 < -1e-9) return false;
  const c2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  if (c2 < -1e-9) return false;
  const c3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  return c3 >= -1e-9;
}

/** Fast zero-dep 2D polygon triangulation supporting convex quads and rings with courtyard holes. */
function triangulatePolygonMeters(
  outerPts: RingPt[],
  holes: ProjectedRing[],
): { allPts: RingPt[]; indices: number[] } {
  const outerLen = outerPts.length;
  if (holes.length === 0) {
    if (outerLen === 3) {
      return { allPts: outerPts, indices: [0, 1, 2] };
    }
    if (outerLen === 4) {
      const p0 = outerPts[0]!, p1 = outerPts[1]!, p2 = outerPts[2]!, p3 = outerPts[3]!;
      const c0 = cross2D(p3.mx, p3.my, p0.mx, p0.my, p1.mx, p1.my);
      const c1 = cross2D(p0.mx, p0.my, p1.mx, p1.my, p2.mx, p2.my);
      const c2 = cross2D(p1.mx, p1.my, p2.mx, p2.my, p3.mx, p3.my);
      const c3 = cross2D(p2.mx, p2.my, p3.mx, p3.my, p0.mx, p0.my);
      if (c0 > -1e-6 && c1 > -1e-6 && c2 > -1e-6 && c3 > -1e-6) {
        return { allPts: outerPts, indices: [0, 1, 2, 0, 2, 3] };
      }
    }
  }

  const allPts: RingPt[] = outerPts.slice();
  const poly: number[] = new Array(outerLen);
  for (let i = 0; i < outerLen; i++) poly[i] = i;

  if (holes.length > 0) {
    const holeEntries = holes.map((hole) => {
      const start = allPts.length;
      const hPts = hole.points;
      let maxOffset = 0;
      let maxX = -Infinity;
      for (let i = 0; i < hPts.length; i++) {
        const pt = hPts[i]!;
        allPts.push(pt);
        if (pt.mx > maxX) {
          maxX = pt.mx;
          maxOffset = i;
        }
      }
      return { start, len: hPts.length, maxIdx: start + maxOffset, maxX };
    });
    holeEntries.sort((a, b) => b.maxX - a.maxX);

    for (const hole of holeEntries) {
      const m = allPts[hole.maxIdx]!;
      let bestRayX = Infinity;
      let bestEdgeVertexPolyPos = -1;

      for (let i = 0; i < poly.length; i++) {
        const ai = poly[i]!;
        const bi = poly[(i + 1) % poly.length]!;
        const a = allPts[ai]!;
        const b = allPts[bi]!;
        if (a.my > m.my && b.my > m.my) continue;
        if (a.my < m.my && b.my < m.my) continue;
        const dy = b.my - a.my;
        let xInt: number;
        if (Math.abs(dy) < 1e-12) {
          if (a.mx < m.mx - 1e-9 && b.mx < m.mx - 1e-9) continue;
          xInt = Math.max(m.mx, Math.min(a.mx, b.mx));
        } else {
          xInt = a.mx + ((m.my - a.my) * (b.mx - a.mx)) / dy;
          if (xInt < m.mx - 1e-9) continue;
        }
        if (xInt < bestRayX) {
          bestRayX = xInt;
          bestEdgeVertexPolyPos = a.mx >= b.mx ? i : (i + 1) % poly.length;
        }
      }

      if (bestEdgeVertexPolyPos < 0) continue;
      let visiblePos = bestEdgeVertexPolyPos;
      const pEnd = allPts[poly[visiblePos]!]!;
      let minSlope = Math.abs(pEnd.my - m.my) / Math.max(1e-9, pEnd.mx - m.mx);

      for (let i = 0; i < poly.length; i++) {
        if (i === bestEdgeVertexPolyPos) continue;
        const r = allPts[poly[i]!]!;
        if (r.mx < m.mx - 1e-9) continue;
        const insideRayTri = pEnd.my >= m.my
          ? pointInTriStrict(m.mx, m.my, bestRayX, m.my, pEnd.mx, pEnd.my, r.mx, r.my)
          : pointInTriStrict(m.mx, m.my, pEnd.mx, pEnd.my, bestRayX, m.my, r.mx, r.my);
        if (!insideRayTri) continue;
        if (r.mx === pEnd.mx && r.my === pEnd.my) continue;
        const slope = Math.abs(r.my - m.my) / Math.max(1e-9, r.mx - m.mx);
        if (slope < minSlope) {
          minSlope = slope;
          visiblePos = i;
        }
      }

      const vIdx = poly[visiblePos]!;
      const localMax = hole.maxIdx - hole.start;
      const bridge: number[] = [];
      for (let k = 0; k <= hole.len; k++) {
        bridge.push(hole.start + ((localMax + k) % hole.len));
      }
      bridge.push(vIdx);
      poly.splice(visiblePos + 1, 0, ...bridge);
    }
  }

  const indices: number[] = [];
  let guard = 0;
  const maxSteps = Math.max(32, poly.length * poly.length + 16);
  let i = 0;
  while (poly.length >= 3 && guard < maxSteps) {
    guard++;
    const n = poly.length;
    i = i % n;
    const prevPos = (i - 1 + n) % n;
    const nextPos = (i + 1) % n;
    const ia = poly[prevPos]!;
    const ib = poly[i]!;
    const ic = poly[nextPos]!;
    if (ia === ic) {
      // Collapse backtracked bridge pair.
      poly.splice(Math.max(i, nextPos), 1);
      poly.splice(Math.min(i, nextPos), 1);
      i = Math.max(0, prevPos);
      continue;
    }
    const pa = allPts[ia]!;
    const pb = allPts[ib]!;
    const pc = allPts[ic]!;
    const area2 = cross2D(pa.mx, pa.my, pb.mx, pb.my, pc.mx, pc.my);
    if (area2 < 1e-8) {
      if (area2 > -1e-8 && n > 3) {
        poly.splice(i, 1);
        i = prevPos % (n - 1);
        continue;
      }
      i++;
      continue;
    }

    let containsPoint = false;
    for (let j = 0; j < n; j++) {
      if (j === prevPos || j === i || j === nextPos) continue;
      const idx = poly[j]!;
      if (idx === ia || idx === ib || idx === ic) continue;
      const pt = allPts[idx]!;
      if (pointInTriStrict(pa.mx, pa.my, pb.mx, pb.my, pc.mx, pc.my, pt.mx, pt.my)) {
        containsPoint = true;
        break;
      }
    }
    if (!containsPoint) {
      indices.push(ia, ib, ic);
      poly.splice(i, 1);
      i = prevPos % (n - 1);
    } else {
      i++;
    }
  }
  return { allPts, indices };
}

/**
 * Triangulate building footprints into three compact GPU meshes:
 * 1. Solid architectural mesh (`14 floats/vertex`: wall facades + raised parapet rim + recessed roof deck)
 * 2. Directional shadow caster volume (`4 floats/vertex`: extruded roof + sides projected along sun ray)
 * 3. Geometric outward contact AO skirt (`3 floats/vertex`: mitered border + bevel corner fans)
 */
export function buildArchitecturalChunk(
  features: readonly BuildingFeatureInput[],
  originLng: number,
  originLat: number,
  maxBuildings = DEFAULT_MAX_BUILDINGS_PER_CHUNK,
): ArchitecturalChunkData {
  const [originX, originY] = lngLatToMercatorXY(originLng, originLat);
  const mercPerMeter = mercatorUnitsPerMeterAtLat(originLat);
  const metersPerDegLng = 111320 * Math.max(0.15, Math.cos(originLat * DEG_TO_RAD));

  interface CandidatePoly {
    coords: number[][][];
    heightNum: number;
    safeMinH: number;
    tint: [number, number, number] | null;
    score: number;
  }

  const candidates: CandidatePoly[] = [];
  for (const feature of features) {
    const props = feature.properties ?? {};
    if (props.hide_3d === true) continue;
    const rawH = props.render_height ?? props.height;
    const heightNum = typeof rawH === "number" ? rawH : Number(rawH);
    if (!Number.isFinite(heightNum) || heightNum < MIN_EXPOSED_HEIGHT_M) continue;

    const rawMinH = props.render_min_height ?? props.min_height ?? 0;
    const minHNum = typeof rawMinH === "number" ? rawMinH : Number(rawMinH);
    const safeMinH = Number.isFinite(minHNum) ? Math.max(0, minHNum) : 0;
    const tint = parseOptionalHexColor(props.colour ?? props.color);
    const geom = feature.geometry;
    if (!geom) continue;

    const pushPolyCandidate = (coords: number[][][]) => {
      const sample = coords[0]?.[0];
      let score = heightNum * 22;
      if (sample) {
        const dx = (sample[0]! - originLng) * metersPerDegLng;
        const dy = (sample[1]! - originLat) * 110574;
        score -= Math.hypot(dx, dy) * 0.14;
      }
      candidates.push({ coords, heightNum, safeMinH, tint, score });
    };

    if (geom.type === "Polygon") {
      pushPolyCandidate(geom.coordinates);
    } else if (geom.type === "MultiPolygon") {
      for (const poly of geom.coordinates) {
        pushPolyCandidate(poly);
      }
    }
  }

  if (candidates.length > maxBuildings) {
    candidates.sort((a, b) => b.score - a.score);
  }

  const estimatedActive = Math.min(candidates.length, maxBuildings);
  const solid = new Float32Builder(estimatedActive * 180 * 14);
  const shadow = new Float32Builder(estimatedActive * 64 * 4);
  const ao = new Float32Builder(estimatedActive * 56 * 3);
  const seen = new Set<string>();
  let featureCount = 0;

  const pushSolid = (
    dx: number, dy: number, z: number,
    nx: number, ny: number, nz: number,
    wallU: number, role: number, baseH: number, topH: number,
    seed: number, tr: number, tg: number, tb: number,
  ) => {
    solid.push14(dx, dy, z, nx, ny, nz, wallU, role, baseH, topH, seed, tr, tg, tb);
  };

  const pushShadowTri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ) => {
    shadow.push12(ax, ay, az, 1, bx, by, bz, 1, cx, cy, cz, 1);
  };

  const pushAoTri = (
    ax: number, ay: number, at: number,
    bx: number, by: number, bt: number,
    cx: number, cy: number, ct: number,
  ) => {
    ao.push9(ax, ay, at, bx, by, bt, cx, cy, ct);
  };

  const processPolygon = (ringsCoords: number[][][], rawHeight: number, rawBase: number, tint: [number, number, number] | null) => {
    const outer = ringsCoords[0] ? prepareRing(ringsCoords[0], originX, originY, mercPerMeter, true) : null;
    if (!outer) return;

    const minH = Math.max(0, Math.min(rawBase, rawHeight - MIN_EXPOSED_HEIGHT_M));
    const maxH = Math.min(MAX_BUILDING_HEIGHT_M, rawHeight);
    if (maxH - minH < MIN_EXPOSED_HEIGHT_M) return;

    const holes: ProjectedRing[] = [];
    for (let r = 1; r < ringsCoords.length; r++) {
      const hole = prepareRing(ringsCoords[r]!, originX, originY, mercPerMeter, false);
      if (hole) holes.push(hole);
    }

    // Deduplicate overlapping cached parent/child tile copies while keeping clipped seam pieces.
    let sumMx = 0;
    let sumMy = 0;
    let minMx = Infinity;
    let maxMx = -Infinity;
    let minMy = Infinity;
    let maxMy = -Infinity;
    for (const p of outer.points) {
      sumMx += p.mx;
      sumMy += p.my;
      if (p.mx < minMx) minMx = p.mx;
      if (p.mx > maxMx) maxMx = p.mx;
      if (p.my < minMy) minMy = p.my;
      if (p.my > maxMy) maxMy = p.my;
    }
    const dedupKey = `${Math.round(minMx * 4)}:${Math.round(minMy * 4)}:${Math.round(maxMx * 4)}:${Math.round(maxMy * 4)}:${outer.points.length}:${Math.round(maxH * 10)}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    featureCount += 1;

    const cxM = sumMx / outer.points.length;
    const cyM = sumMy / outer.points.length;
    const distSqFromOrigin = cxM * cxM + cyM * cyM;
    const heightSpan = maxH - minH;
    const nearOrHero = heightSpan >= 6.5 || distSqFromOrigin <= DETAIL_PARAPET_DISTANCE_M_SQ;
    const seed = computeBuildingSeed(cxM, cyM, maxH, outer.points.length);
    const tr = tint ? tint[0] : -1;
    const tg = tint ? tint[1] : -1;
    const tb = tint ? tint[2] : -1;

    const { allPts, indices } = triangulatePolygonMeters(outer.points, holes);

    // 1. Solid recessed rooftop deck + projected directional shadow top/base cap.
    const radiusScale = Math.max(12, Math.hypot(maxMx - minMx, maxMy - minMy) * 0.5);
    for (let t = 0; t < indices.length; t += 3) {
      const ia = indices[t];
      const ib = indices[t + 1];
      const ic = indices[t + 2];
      if (ia === undefined || ib === undefined || ic === undefined) continue;
      const pa = allPts[ia];
      const pb = allPts[ib];
      const pc = allPts[ic];
      if (!pa || !pb || !pc) continue;
      const da = Math.hypot(pa.mx - cxM, pa.my - cyM) / radiusScale;
      const db = Math.hypot(pb.mx - cxM, pb.my - cyM) / radiusScale;
      const dc = Math.hypot(pc.mx - cxM, pc.my - cyM) / radiusScale;
      pushSolid(pa.dx, pa.dy, maxH, 0, 0, 1, da, 1.0, minH, maxH, seed, tr, tg, tb);
      pushSolid(pb.dx, pb.dy, maxH, 0, 0, 1, db, 1.0, minH, maxH, seed, tr, tg, tb);
      pushSolid(pc.dx, pc.dy, maxH, 0, 0, 1, dc, 1.0, minH, maxH, seed, tr, tg, tb);

      pushShadowTri(pa.dx, pa.dy, maxH, pb.dx, pb.dy, maxH, pc.dx, pc.dy, maxH);
      if (minH < 0.05) {
        pushShadowTri(pa.dx, pa.dy, 0, pb.dx, pb.dy, 0, pc.dx, pc.dy, 0);
      } else {
        pushShadowTri(pa.dx, pa.dy, minH, pb.dx, pb.dy, minH, pc.dx, pc.dy, minH);
      }
    }

    // Raised parapet dimensions calibrated by building scale.
    const parapetH = Math.max(0.28, Math.min(0.68, maxH * 0.025));
    const parapetTop = maxH + parapetH;
    const insetSpan = Math.max(0.38, Math.min(0.85, 0.35 + maxH * 0.008));

    const emitRingExtrusion = (ring: ProjectedRing, emitContactAo: boolean) => {
      const pts = ring.points;
      const n = pts.length;
      const edgeNormals: Array<[number, number, number]> = new Array(n);
      let uAccum = 0;

      for (let i = 0; i < n; i++) {
        const p0 = pts[i]!;
        const p1 = pts[(i + 1) % n]!;
        const ex = p1.mx - p0.mx;
        const ey = p1.my - p0.my;
        const len = Math.hypot(ex, ey);
        // For CCW outer ring (+area) and CW hole ring (-area), right-hand normal (ey, -ex) always faces exterior/void.
        edgeNormals[i] = len > 1e-4 ? [ey / len, -ex / len, len] : [0, 1, 0];
      }

      for (let i = 0; i < n; i++) {
        const p0 = pts[i]!;
        const p1 = pts[(i + 1) % n]!;
        const [nx, ny, segLen] = edgeNormals[i]!;
        if (segLen < 0.05) continue;

        const u0 = uAccum;
        const u1 = uAccum + segLen;
        uAccum = u1;

        // Facade wall quad (role = 0.0).
        pushSolid(p0.dx, p0.dy, minH, nx, ny, 0, u0, 0.0, minH, maxH, seed, tr, tg, tb);
        pushSolid(p1.dx, p1.dy, minH, nx, ny, 0, u1, 0.0, minH, maxH, seed, tr, tg, tb);
        pushSolid(p1.dx, p1.dy, maxH, nx, ny, 0, u1, 0.0, minH, maxH, seed, tr, tg, tb);

        pushSolid(p0.dx, p0.dy, minH, nx, ny, 0, u0, 0.0, minH, maxH, seed, tr, tg, tb);
        pushSolid(p1.dx, p1.dy, maxH, nx, ny, 0, u1, 0.0, minH, maxH, seed, tr, tg, tb);
        pushSolid(p0.dx, p0.dy, maxH, nx, ny, 0, u0, 0.0, minH, maxH, seed, tr, tg, tb);

        // Exterior parapet cornice skirt & inner recessed parapet rim on hero/nearby buildings.
        if (nearOrHero) {
          pushSolid(p0.dx, p0.dy, maxH, nx, ny, 0, u0, 0.5, minH, maxH, seed, tr, tg, tb);
          pushSolid(p1.dx, p1.dy, maxH, nx, ny, 0, u1, 0.5, minH, maxH, seed, tr, tg, tb);
          pushSolid(p1.dx, p1.dy, parapetTop, nx, ny, 0, u1, 0.5, minH, maxH, seed, tr, tg, tb);

          pushSolid(p0.dx, p0.dy, maxH, nx, ny, 0, u0, 0.5, minH, maxH, seed, tr, tg, tb);
          pushSolid(p1.dx, p1.dy, parapetTop, nx, ny, 0, u1, 0.5, minH, maxH, seed, tr, tg, tb);
          pushSolid(p0.dx, p0.dy, parapetTop, nx, ny, 0, u0, 0.5, minH, maxH, seed, tr, tg, tb);

          if (n <= 28) {
            const maxSafeInset = Math.min(insetSpan, segLen * 0.32);
            const ix0 = p0.dx - nx * maxSafeInset * mercPerMeter;
            const iy0 = p0.dy + ny * maxSafeInset * mercPerMeter;
            const ix1 = p1.dx - nx * maxSafeInset * mercPerMeter;
            const iy1 = p1.dy + ny * maxSafeInset * mercPerMeter;

            pushSolid(p0.dx, p0.dy, parapetTop, 0, 0, 1, u0, 0.5, minH, maxH, seed, tr, tg, tb);
            pushSolid(p1.dx, p1.dy, parapetTop, 0, 0, 1, u1, 0.5, minH, maxH, seed, tr, tg, tb);
            pushSolid(ix1, iy1, parapetTop, 0, 0, 1, u1, 0.5, minH, maxH, seed, tr, tg, tb);

            pushSolid(p0.dx, p0.dy, parapetTop, 0, 0, 1, u0, 0.5, minH, maxH, seed, tr, tg, tb);
            pushSolid(ix1, iy1, parapetTop, 0, 0, 1, u1, 0.5, minH, maxH, seed, tr, tg, tb);
            pushSolid(ix0, iy0, parapetTop, 0, 0, 1, u0, 0.5, minH, maxH, seed, tr, tg, tb);

            // Inner downward rim of parapet casting recessed ledge contrast onto roof.
            pushSolid(ix0, iy0, parapetTop, -nx, -ny, 0, u0, 0.5, minH, maxH, seed, tr, tg, tb);
            pushSolid(ix1, iy1, parapetTop, -nx, -ny, 0, u1, 0.5, minH, maxH, seed, tr, tg, tb);
            pushSolid(ix1, iy1, maxH, -nx, -ny, 0, u1, 0.5, minH, maxH, seed, tr, tg, tb);

            pushSolid(ix0, iy0, parapetTop, -nx, -ny, 0, u0, 0.5, minH, maxH, seed, tr, tg, tb);
            pushSolid(ix1, iy1, maxH, -nx, -ny, 0, u1, 0.5, minH, maxH, seed, tr, tg, tb);
            pushSolid(ix0, iy0, maxH, -nx, -ny, 0, u0, 0.5, minH, maxH, seed, tr, tg, tb);
          }
        }

        // Swept directional shadow wall quad projected along ray in shader.
        pushShadowTri(p0.dx, p0.dy, minH, p1.dx, p1.dy, minH, p1.dx, p1.dy, maxH);
        pushShadowTri(p0.dx, p0.dy, minH, p1.dx, p1.dy, maxH, p0.dx, p0.dy, maxH);

        // Ground contact Ambient Occlusion skirt + corner radial bevel cap (when base rests on ground).
        if (emitContactAo && minH < 0.75) {
          const aoMercX = nx * CONTACT_AO_WIDTH_M * mercPerMeter;
          const aoMercY = -ny * CONTACT_AO_WIDTH_M * mercPerMeter;
          pushAoTri(p0.dx, p0.dy, 0.0, p1.dx, p1.dy, 0.0, p1.dx + aoMercX, p1.dy + aoMercY, 1.0);
          pushAoTri(p0.dx, p0.dy, 0.0, p1.dx + aoMercX, p1.dy + aoMercY, 1.0, p0.dx + aoMercX, p0.dy + aoMercY, 1.0);

          const [nxPrev, nyPrev, prevLen] = edgeNormals[(i - 1 + n) % n]!;
          if (prevLen >= 0.05) {
            // Add rounded bevel fan at convex vertices so AO halo never gaps at corners.
            const cross = nxPrev * ny - nyPrev * nx;
            if (cross > 0.05) {
              const prevX = p0.dx + nxPrev * CONTACT_AO_WIDTH_M * mercPerMeter;
              const prevY = p0.dy - nyPrev * CONTACT_AO_WIDTH_M * mercPerMeter;
              const midNx = nxPrev + nx;
              const midNy = nyPrev + ny;
              const midLen = Math.hypot(midNx, midNy) || 1;
              const midX = p0.dx + (midNx / midLen) * CONTACT_AO_WIDTH_M * mercPerMeter;
              const midY = p0.dy - (midNy / midLen) * CONTACT_AO_WIDTH_M * mercPerMeter;
              const curX = p0.dx + aoMercX;
              const curY = p0.dy + aoMercY;
              pushAoTri(p0.dx, p0.dy, 0.0, prevX, prevY, 1.0, midX, midY, 1.0);
              pushAoTri(p0.dx, p0.dy, 0.0, midX, midY, 1.0, curX, curY, 1.0);
            }
          }
        }
      }
    };

    const emitOrientedRoofBox = (
      centerMx: number,
      centerMy: number,
      ux: number,
      uy: number,
      vx: number,
      vy: number,
      halfW: number,
      halfD: number,
      baseZ: number,
      topZ: number,
      castShadow: boolean,
    ) => {
      const c0mx = centerMx - hwOffsetX(ux, vx, halfW, halfD);
      const c0my = centerMy - hwOffsetY(uy, vy, halfW, halfD);
      const c1mx = centerMx + ux * halfW - vx * halfD;
      const c1my = centerMy + uy * halfW - vy * halfD;
      const c2mx = centerMx + ux * halfW + vx * halfD;
      const c2my = centerMy + uy * halfW + vy * halfD;
      const c3mx = centerMx - ux * halfW + vx * halfD;
      const c3my = centerMy - uy * halfW + vy * halfD;

      const corners = [
        { mx: c0mx, my: c0my, dx: c0mx * mercPerMeter, dy: -c0my * mercPerMeter },
        { mx: c1mx, my: c1my, dx: c1mx * mercPerMeter, dy: -c1my * mercPerMeter },
        { mx: c2mx, my: c2my, dx: c2mx * mercPerMeter, dy: -c2my * mercPerMeter },
        { mx: c3mx, my: c3my, dx: c3mx * mercPerMeter, dy: -c3my * mercPerMeter },
      ];

      let uAcc = 0;
      for (let i = 0; i < 4; i++) {
        const a = corners[i]!;
        const b = corners[(i + 1) % 4]!;
        const ex = b.mx - a.mx;
        const ey = b.my - a.my;
        const len = Math.hypot(ex, ey) || 1;
        const nx = ey / len;
        const ny = -ex / len;
        const uNext = uAcc + len;

        pushSolid(a.dx, a.dy, baseZ, nx, ny, 0, uAcc, 0.30, baseZ, topZ, seed, tr, tg, tb);
        pushSolid(b.dx, b.dy, baseZ, nx, ny, 0, uNext, 0.30, baseZ, topZ, seed, tr, tg, tb);
        pushSolid(b.dx, b.dy, topZ, nx, ny, 0, uNext, 0.30, baseZ, topZ, seed, tr, tg, tb);

        pushSolid(a.dx, a.dy, baseZ, nx, ny, 0, uAcc, 0.30, baseZ, topZ, seed, tr, tg, tb);
        pushSolid(b.dx, b.dy, topZ, nx, ny, 0, uNext, 0.30, baseZ, topZ, seed, tr, tg, tb);
        pushSolid(a.dx, a.dy, topZ, nx, ny, 0, uAcc, 0.30, baseZ, topZ, seed, tr, tg, tb);

        if (castShadow) {
          pushShadowTri(a.dx, a.dy, baseZ, b.dx, b.dy, baseZ, b.dx, b.dy, topZ);
          pushShadowTri(a.dx, a.dy, baseZ, b.dx, b.dy, topZ, a.dx, a.dy, topZ);
        }
        uAcc = uNext;
      }

      const ca = corners[0]!;
      const cb = corners[1]!;
      const cc = corners[2]!;
      const cd = corners[3]!;
      pushSolid(ca.dx, ca.dy, topZ, 0, 0, 1, 0.25, 1.0, baseZ, topZ, seed, tr, tg, tb);
      pushSolid(cb.dx, cb.dy, topZ, 0, 0, 1, 0.25, 1.0, baseZ, topZ, seed, tr, tg, tb);
      pushSolid(cc.dx, cc.dy, topZ, 0, 0, 1, 0.25, 1.0, baseZ, topZ, seed, tr, tg, tb);

      pushSolid(ca.dx, ca.dy, topZ, 0, 0, 1, 0.25, 1.0, baseZ, topZ, seed, tr, tg, tb);
      pushSolid(cc.dx, cc.dy, topZ, 0, 0, 1, 0.25, 1.0, baseZ, topZ, seed, tr, tg, tb);
      pushSolid(cd.dx, cd.dy, topZ, 0, 0, 1, 0.25, 1.0, baseZ, topZ, seed, tr, tg, tb);

      if (castShadow) {
        pushShadowTri(ca.dx, ca.dy, topZ, cb.dx, cb.dy, topZ, cc.dx, cc.dy, topZ);
        pushShadowTri(ca.dx, ca.dy, topZ, cc.dx, cc.dy, topZ, cd.dx, cd.dy, topZ);
      }
    };

    const hwOffsetX = (ux: number, vx: number, hw: number, hd: number) => ux * hw + vx * hd;
    const hwOffsetY = (uy: number, vy: number, hw: number, hd: number) => uy * hw + vy * hd;

    emitRingExtrusion(outer, true);
    for (const hole of holes) emitRingExtrusion(hole, false);

    // Add stepped mechanical penthouses & rooftop HVAC units safely inside inscribed footprint circles.
    if (outer.areaM2 >= 180 && heightSpan >= 4.8 && distSqFromOrigin <= DETAIL_PENTHOUSE_DISTANCE_M_SQ) {
      const site = findInscribedRoofSite(outer, holes, minMx, maxMx, minMy, maxMy);
      if (site && site.radius >= 3.2) {
        const theta = dominantOrientationAngle(outer.points);
        const ux = Math.cos(theta);
        const uy = Math.sin(theta);
        const vx = -uy;
        const vy = ux;
        const hw = Math.min(site.radius * 0.44, 9.4);
        const hd = Math.min(site.radius * 0.32, 6.6);
        if (Math.hypot(hw, hd) < site.radius * 0.90) {
          const pentH = Math.max(1.8, Math.min(4.6, heightSpan * 0.12));
          const pentTop = maxH + pentH;
          emitOrientedRoofBox(site.mx, site.my, ux, uy, vx, vy, hw, hd, maxH, pentTop, heightSpan >= 14);

          if (site.radius >= 6.4 && hw >= 3.8) {
            const chillOffset = hd + 1.45;
            const uw = Math.min(hw * 0.44, 2.3);
            const ud = 0.95;
            if (Math.hypot(uw + 1.8, chillOffset + ud) < site.radius * 0.92) {
              const unitBase = maxH;
              const unitTop = maxH + 1.25;
              emitOrientedRoofBox(
                site.mx + vx * chillOffset - ux * (hw * 0.45),
                site.my + vy * chillOffset - uy * (hw * 0.45),
                ux, uy, vx, vy, uw, ud, unitBase, unitTop, false,
              );
              emitOrientedRoofBox(
                site.mx + vx * chillOffset + ux * (hw * 0.45),
                site.my + vy * chillOffset + uy * (hw * 0.45),
                ux, uy, vx, vy, uw, ud, unitBase, unitTop, false,
              );
            }
          }
        }
      }
    }
  };

  for (const candidate of candidates) {
    if (featureCount >= maxBuildings) break;
    processPolygon(candidate.coords, candidate.heightNum, candidate.safeMinH, candidate.tint);
  }

  return {
    originX,
    originY,
    mercPerMeter,
    featureCount,
    solidVertices: solid.finish(),
    solidVertexCount: solid.length / 14,
    shadowVertices: shadow.finish(),
    shadowVertexCount: shadow.length / 4,
    aoVertices: ao.finish(),
    aoVertexCount: ao.length / 3,
    signature: `${featureCount}:${solid.length}:${shadow.length}:${ao.length}`,
  };
}

const SHADOW_CASTER_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_shadow_pos;
uniform mat4 u_local_mvp;
uniform vec2 u_shadow_proj_per_m;
uniform float u_height_scale;
void main() {
  float h = a_shadow_pos.z * u_height_scale;
  vec2 shifted = a_shadow_pos.xy + u_shadow_proj_per_m * h;
  gl_Position = u_local_mvp * vec4(shifted, 0.0, 1.0);
}`;

const SHADOW_CASTER_FRAG = /* glsl */ `#version 300 es
precision mediump float;
out vec4 fragColor;
void main() {
  fragColor = vec4(1.0, 0.0, 0.0, 1.0);
}`;

const CONTACT_AO_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_ao_pos;
uniform mat4 u_local_mvp;
out float v_ao_t;
void main() {
  v_ao_t = a_ao_pos.z;
  gl_Position = u_local_mvp * vec4(a_ao_pos.xy, 0.0, 1.0);
}`;

const CONTACT_AO_FRAG = /* glsl */ `#version 300 es
precision mediump float;
in float v_ao_t;
out vec4 fragColor;
void main() {
  float falloff = pow(clamp(1.0 - v_ao_t, 0.0, 1.0), 2.15);
  fragColor = vec4(0.0, falloff, 0.0, 1.0);
}`;

const SHADOW_COMPOSITE_VERT = /* glsl */ `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 pos = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  v_uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const SHADOW_COMPOSITE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_shadow_tex;
uniform vec2 u_texel_size;
uniform vec3 u_shadow_color;
uniform float u_dir_shadow_alpha;
uniform float u_ao_alpha;
uniform float u_fade_opacity;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec2 center = texture(u_shadow_tex, v_uv).rg;
  vec2 k = u_texel_size * 1.15;
  float dirShadow = center.r * 0.36
    + (texture(u_shadow_tex, v_uv + vec2( k.x,  k.y)).r
     + texture(u_shadow_tex, v_uv + vec2(-k.x,  k.y)).r
     + texture(u_shadow_tex, v_uv + vec2( k.x, -k.y)).r
     + texture(u_shadow_tex, v_uv + vec2(-k.x, -k.y)).r) * 0.16;
  float ao = center.g;
  float occ = 1.0 - (1.0 - clamp(dirShadow, 0.0, 1.0) * u_dir_shadow_alpha) * (1.0 - ao * u_ao_alpha);
  occ *= u_fade_opacity;
  if (occ < 0.004) discard;
  fragColor = vec4(u_shadow_color * occ, occ);
}`;

const BUILDING_VERT = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec4 a_meta;
layout(location = 3) in vec4 a_style;

uniform mat4 u_local_mvp;
uniform float u_height_scale;
uniform float u_inv_merc_per_meter;

out vec3 v_world_pos_m;
out vec3 v_normal_enu;
out float v_wall_u;
out float v_surface_role;
out float v_z_above_base;
out float v_building_height;
out float v_seed;
out vec3 v_custom_tint;

void main() {
  float scaledZ = mix(a_meta.z, a_pos.z, u_height_scale);
  gl_Position = u_local_mvp * vec4(a_pos.xy, scaledZ, 1.0);
  v_world_pos_m = vec3(a_pos.x * u_inv_merc_per_meter, -a_pos.y * u_inv_merc_per_meter, scaledZ);
  v_normal_enu = a_normal;
  v_wall_u = a_meta.x;
  v_surface_role = a_meta.y;
  v_z_above_base = max(0.0, scaledZ - a_meta.z);
  v_building_height = max(1.0, a_meta.w - a_meta.z);
  v_seed = a_style.x;
  v_custom_tint = a_style.yzw;
}`;

const BUILDING_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform vec3 u_camera_pos_m;
uniform vec3 u_sun_dir;
uniform vec3 u_sun_color;
uniform float u_sun_intensity;
uniform vec3 u_sky_zenith;
uniform vec3 u_sky_horizon;
uniform vec3 u_ground_bounce;
uniform vec3 u_fog_color;
uniform float u_night_emissive;
uniform float u_glass_boost;
uniform float u_opacity;
uniform float u_is_street_mode;

in vec3 v_world_pos_m;
in vec3 v_normal_enu;
in float v_wall_u;
in float v_surface_role;
in float v_z_above_base;
in float v_building_height;
in float v_seed;
in vec3 v_custom_tint;

out vec4 fragColor;

float hash1(float n) {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453123);
}

float hash2(vec2 p, float s) {
  return fract(sin(dot(p, vec2(127.1, 311.7)) + s * 74.7) * 43758.5453123);
}

vec3 sampleEnvironment(vec3 R) {
  float elev = R.z;
  vec3 upperSky = mix(u_sky_horizon, u_sky_zenith, pow(clamp(elev * 1.4, 0.0, 1.0), 0.72));
  vec3 streetDark = u_ground_bounce * mix(0.45, 0.85, clamp(1.0 + elev * 1.5, 0.0, 1.0));
  // Crisp urban horizon reflection seam across curtain walls.
  float horizonMask = smoothstep(-0.07, 0.14, elev);
  vec3 env = mix(streetDark, upperSky, horizonMask);
  float rimBand = exp(-abs(elev - 0.03) * 14.0) * 0.28 * u_glass_boost;
  return env + u_sky_horizon * rimBand;
}

void main() {
  vec3 N = normalize(v_normal_enu);
  vec3 toCam = u_camera_pos_m - v_world_pos_m;
  float camDist = max(1.0, length(toCam));
  vec3 V = toCam / camDist;
  vec3 H = normalize(u_sun_dir + V);

  float ndl = max(dot(N, u_sun_dir), 0.0);
  float halfLambert = dot(N, u_sun_dir) * 0.5 + 0.5;
  float ndv = max(dot(N, V), 0.001);
  float skyFill = clamp(0.45 + 0.55 * N.z, 0.0, 1.0);
  float groundBounce = clamp(-N.z * 0.3 + (1.0 - abs(N.z)) * 0.32, 0.0, 1.0);

  // Subtle vertical contact occlusion grounding lower building floors + upper eaves overhang shadow.
  float baseAo = mix(0.52, 1.0, smoothstep(0.0, 5.2, v_z_above_base));
  float eavesAo = mix(0.74, 1.0, smoothstep(0.0, 1.35, max(0.0, v_building_height - v_z_above_base)));
  float towerFactor = smoothstep(20.0, 54.0, v_building_height);
  float archetype = hash1(v_seed * 11.3);
  float glassStyle = clamp(mix(0.32, 0.90, archetype) + towerFactor * 0.25, 0.28, 0.96);

  // Cohesive architectural material base palette per lighting mode, honoring optional OSM colour tags.
  vec3 streetWallPalette = mix(vec3(0.91, 0.87, 0.81), vec3(0.68, 0.76, 0.85), hash1(v_seed * 5.7));
  vec3 darkWallPalette = mix(vec3(0.18, 0.27, 0.39), vec3(0.26, 0.37, 0.51), hash1(v_seed * 5.7));
  vec3 stoneBase = mix(darkWallPalette, streetWallPalette, u_is_street_mode);
  if (v_custom_tint.r >= 0.0) {
    stoneBase = mix(stoneBase, v_custom_tint, u_is_street_mode > 0.5 ? 0.38 : 0.24);
  }

  vec3 glassAlbedo = mix(vec3(0.05, 0.14, 0.25), vec3(0.06, 0.18, 0.31), u_is_street_mode);
  vec3 litColor;

  if (v_surface_role < 0.25) {
    // 1. Building wall facade: podium colonnade + decoupled fwidth-filtered horizontal floor bands & vertical mullions.
    float floorH = mix(3.45, 4.10, hash1(v_seed * 19.7));
    float bayW = mix(2.45, 3.30, hash1(v_seed * 23.1));
    float podiumH = clamp(floorH * 1.42, 4.0, 5.8);
    float inPodium = (1.0 - smoothstep(podiumH - 0.25, podiumH + 0.25, v_z_above_base)) * step(5.2, v_building_height);

    vec2 uv = vec2(v_wall_u / bayW, max(0.0, v_z_above_base) / floorH);
    vec2 fw = max(fwidth(uv), vec2(0.0015));

    float mullionHalf = mix(0.16, 0.085, glassStyle);
    float spandrelHalf = mix(0.24, 0.16, glassStyle);
    spandrelHalf = mix(spandrelHalf, 0.095, inPodium);

    vec2 cellFrac = fract(uv);
    vec2 cellId = floor(uv);

    float winU = smoothstep(mullionHalf - fw.x, mullionHalf + fw.x, cellFrac.x)
               * (1.0 - smoothstep(1.0 - mullionHalf - fw.x, 1.0 - mullionHalf + fw.x, cellFrac.x));
    float winV = smoothstep(spandrelHalf - fw.y, spandrelHalf + fw.y, cellFrac.y)
               * (1.0 - smoothstep(1.0 - spandrelHalf - fw.y, 1.0 - spandrelHalf + fw.y, cellFrac.y));

    float detailFadeX = 1.0 - smoothstep(0.32, 0.78, fw.x);
    float detailFadeY = 1.0 - smoothstep(0.40, 0.90, fw.y);
    float detailFade = detailFadeX * detailFadeY;

    float filteredU = mix(max(0.28, 1.0 - 2.0 * mullionHalf), winU, detailFadeX);
    float filteredV = mix(max(0.28, 1.0 - 2.0 * spandrelHalf), winV, detailFadeY);
    float windowMask = clamp(filteredU * filteredV, 0.0, 1.0);

    // Subtle recessed spandrel head shadow & interior blind tone gradient for layered facade relief.
    float headShadow = mix(1.0, mix(0.70, 1.0, smoothstep(0.10, 0.42, 1.0 - spandrelHalf - cellFrac.y)), winV * detailFadeY);

    // Subtle per-pane glass waviness so reflected skyline plates read independently.
    float paneHash = hash2(cellId, v_seed);
    vec3 tangentENU = normalize(cross(vec3(0.0, 0.0, 1.0), N) + vec3(1e-4, 0.0, 0.0));
    vec3 paneTilt = (tangentENU * ((paneHash - 0.5) * 0.068) + vec3(0.0, 0.0, (fract(paneHash * 7.3) - 0.5) * 0.048)) * detailFadeY * windowMask;
    vec3 surfN = normalize(N + paneTilt);

    vec3 R = reflect(-V, surfN);
    vec3 envRefl = sampleEnvironment(R);
    float fresnel = mix(0.12, 0.96, pow(1.0 - max(dot(surfN, V), 0.0), 3.2));
    float specPow = mix(18.0, 92.0, windowMask * mix(0.45, 1.0, glassStyle));
    float sunSpec = pow(max(dot(surfN, H), 0.0), specPow) * mix(0.10, 1.38 * u_glass_boost, windowMask) * smoothstep(0.0, 0.14, u_sun_dir.z);

    vec3 frameColor = mix(stoneBase, stoneBase * 0.74, inPodium);
    float interiorDepth = mix(0.76, 1.26, fract(paneHash * 5.3) * 0.52 + (1.0 - cellFrac.y) * 0.48);
    vec3 surfaceBase = mix(frameColor, glassAlbedo * mix(1.0, interiorDepth, detailFade) * headShadow, windowMask);

    vec3 diffuseLight = u_sun_color * (ndl * u_sun_intensity * 0.80 + halfLambert * 0.16)
                      + u_sky_horizon * (skyFill * 0.46)
                      + u_ground_bounce * (groundBounce * 0.26);

    // Reflective glazing carries environment reflection balanced with surface diffuse.
    float reflWeight = fresnel * mix(0.07, 0.94, windowMask * mix(0.58, 1.0, glassStyle));
    litColor = surfaceBase * diffuseLight * (1.0 - 0.48 * reflWeight)
             + envRefl * reflWeight * (0.88 + 0.30 * u_glass_boost)
             + u_sun_color * sunSpec;

    // Coherent multi-pane occupied office suites & illuminated lobbies in dark radar mode.
    if (u_night_emissive > 0.01 && detailFade > 0.02) {
      vec2 suiteId = vec2(floor(cellId.x / 2.2), cellId.y);
      float suiteRand = hash2(suiteId, v_seed * 17.9);
      float paneDim = 0.72 + 0.28 * paneHash;
      float multiStoryGate = step(5.8, v_building_height);
      float officeLit = smoothstep(0.68, 0.80, suiteRand) * multiStoryGate;
      float lobbyLit = smoothstep(0.42, 0.58, suiteRand) * inPodium * multiStoryGate;
      float roomGlow = max(officeLit, lobbyLit) * windowMask * mix(0.45, 1.0, detailFadeY) * mix(0.65, paneDim, detailFadeX);
      float ceilingShade = mix(0.62, 1.15, smoothstep(0.14, 0.86, cellFrac.y));
      vec3 warmDesk = mix(vec3(1.0, 0.74, 0.36), vec3(0.54, 0.86, 1.0), step(0.76, fract(suiteRand * 19.3)));
      litColor += warmDesk * roomGlow * ceilingShade * 0.90 * u_night_emissive;
    }

    // Subtle crisp upper crown cornice highlight band on tall towers.
    float crownHighlight = smoothstep(max(0.0, v_building_height - 1.25), v_building_height, v_z_above_base);
    litColor += u_sky_horizon * crownHighlight * (u_is_street_mode > 0.5 ? 0.10 : 0.20);
    litColor *= baseAo * eavesAo;
  } else if (v_surface_role < 0.45) {
    // 2. Stepped rooftop mechanical penthouses & louvered HVAC equipment housings.
    float louv = v_z_above_base * 3.8;
    float lfw = max(fwidth(louv), 0.02);
    float louverBand = mix(0.78, 1.06, smoothstep(0.35 - lfw, 0.65 + lfw, fract(louv)));
    float louverFade = 1.0 - smoothstep(0.35, 0.78, lfw);
    vec3 metalAlbedo = mix(vec3(0.14, 0.21, 0.32), vec3(0.32, 0.37, 0.44), u_is_street_mode);
    metalAlbedo *= mix(1.0, louverBand, louverFade);
    vec3 metalLight = u_sun_color * (ndl * u_sun_intensity * 0.86 + halfLambert * 0.16)
                    + u_sky_horizon * (skyFill * 0.54);
    float specMetal = pow(max(dot(N, H), 0.0), 26.0) * 0.32;
    litColor = metalAlbedo * metalLight + u_sun_color * specMetal;
    litColor *= mix(0.66, 1.0, smoothstep(0.0, 0.75, v_z_above_base));
  } else if (v_surface_role < 0.75) {
    // 3. Raised rooftop parapet rim: brighter cornice catching crisp top light & rim silhouette.
    vec3 rimAlbedo = mix(stoneBase * 1.22 + vec3(0.05, 0.07, 0.10), stoneBase * 1.08 + vec3(0.05), u_is_street_mode);
    vec3 rimLight = u_sun_color * (ndl * u_sun_intensity * 0.88 + 0.14)
                  + u_sky_zenith * (skyFill * 0.58);
    float fresnelRim = pow(1.0 - ndv, 3.0) * (u_is_street_mode > 0.5 ? 0.18 : 0.36);
    litColor = rimAlbedo * rimLight + u_sky_horizon * fresnelRim;
  } else {
    // 4. Recessed interior roof membrane with analytical rooftop seam panels & skylight grids.
    vec3 roofBase = mix(stoneBase * 0.70, mix(vec3(0.68, 0.67, 0.63), vec3(0.51, 0.55, 0.60), archetype), u_is_street_mode);
    vec2 roofUv = v_world_pos_m.xy / 6.0;
    vec2 rfw = max(fwidth(roofUv), vec2(0.002));
    float gridX = abs(fract(roofUv.x) - 0.5);
    float gridY = abs(fract(roofUv.y) - 0.5);
    float seam = (1.0 - smoothstep(0.44 - rfw.x, 0.48 + rfw.x, gridX)) * (1.0 - smoothstep(0.44 - rfw.y, 0.48 + rfw.y, gridY));
    float seamFade = 1.0 - smoothstep(0.3, 0.75, max(rfw.x, rfw.y));
    roofBase *= mix(1.0, 0.90 + 0.10 * seam, seamFade);

    // Brushed aluminum top caps on stepped penthouses + tinted glass skylight bays on roof slabs.
    float skylightHash = hash2(floor(roofUv * 0.5), v_seed * 3.1);
    float isPenthouseCap = step(v_wall_u, 0.28) * step(0.22, v_wall_u);
    vec3 capTint = mix(roofBase, mix(vec3(0.36, 0.47, 0.60), vec3(0.84, 0.86, 0.89), u_is_street_mode), isPenthouseCap * 0.85);
    if (isPenthouseCap < 0.5 && skylightHash > 0.84) {
      capTint = mix(capTint, u_sky_zenith * 0.56, 0.42 * seamFade);
    }

    // Soft ambient shadow inside parapet perimeter + sunlit open center.
    float rimShade = smoothstep(0.75, 1.0, v_wall_u);
    float roofAo = mix(1.0, 0.74, rimShade * 0.70);
    vec3 roofLight = u_sun_color * (ndl * u_sun_intensity * 0.84 + 0.10) + u_sky_zenith * 0.54;
    litColor = capTint * roofLight * roofAo;
  }

  // Distance aerial perspective gently receding far skylines into sky horizon haze.
  float fogAmount = clamp(1.0 - exp(-max(0.0, camDist - 360.0) * 0.00058), 0.0, 0.58);
  vec3 finalRgb = mix(litColor, u_fog_color, fogAmount);

  // Soft filmic tone compression preventing clipped highlights.
  finalRgb = (finalRgb * (2.51 * finalRgb + 0.03)) / (finalRgb * (2.43 * finalRgb + 0.59) + 0.14);
  fragColor = vec4(finalRgb * u_opacity, u_opacity);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram | null {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vert || !frag) {
    if (vert) gl.deleteShader(vert);
    if (frag) gl.deleteShader(frag);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    return null;
  }
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

export interface Building3DController {
  shadowLayerId: string;
  buildingLayerId: string;
  attach: () => void;
  setVisualState: (mode: BuildingLayerVisualMode, flat: boolean) => void;
  scheduleSync: (immediate?: boolean) => void;
  isRenderingCustom: () => boolean;
  dispose: () => void;
}

export const CUSTOM_BUILDING_SHADOW_LAYER_ID = "basemap:building:ground-shadows";
export const CUSTOM_BUILDING_SCENE_LAYER_ID = "basemap:building:architectural";

/**
 * Attach WebGL2 directional shadow / contact AO and procedural architectural facade layers
 * to a MapLibre map while preserving native `basemap:building:3d` layers as a fallback.
 */
export function createBuilding3DController(
  map: MapLibreMap,
  options: {
    sourceId: string;
    initialMode: BuildingLayerVisualMode;
    initialFlat: boolean;
    onCustomStateChange?: (active: boolean) => void;
  },
): Building3DController {
  let disposed = false;
  let visualMode: BuildingLayerVisualMode = options.initialMode;
  let isFlat = options.initialFlat;
  let glRef: WebGL2RenderingContext | null = null;
  let programsReady = false;
  let programsFailed = false;
  let customRenderedReported = false;
  let layersAttached = false;

  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let chunk: ArchitecturalChunkData | null = null;
  let chunkUploaded = false;

  // GL resources
  let shadowCasterProgram: WebGLProgram | null = null;
  let aoProgram: WebGLProgram | null = null;
  let shadowCompositeProgram: WebGLProgram | null = null;
  let buildingProgram: WebGLProgram | null = null;
  let uniforms: {
    casterMvp: WebGLUniformLocation | null;
    casterProjPerM: WebGLUniformLocation | null;
    casterHeightScale: WebGLUniformLocation | null;
    aoMvp: WebGLUniformLocation | null;
    compShadowTex: WebGLUniformLocation | null;
    compTexelSize: WebGLUniformLocation | null;
    compShadowColor: WebGLUniformLocation | null;
    compDirShadowAlpha: WebGLUniformLocation | null;
    compAoAlpha: WebGLUniformLocation | null;
    compFadeOpacity: WebGLUniformLocation | null;
    bldgMvp: WebGLUniformLocation | null;
    bldgHeightScale: WebGLUniformLocation | null;
    bldgInvMercPerM: WebGLUniformLocation | null;
    bldgCamPosM: WebGLUniformLocation | null;
    bldgSunDir: WebGLUniformLocation | null;
    bldgSunColor: WebGLUniformLocation | null;
    bldgSunIntensity: WebGLUniformLocation | null;
    bldgSkyZenith: WebGLUniformLocation | null;
    bldgSkyHorizon: WebGLUniformLocation | null;
    bldgGroundBounce: WebGLUniformLocation | null;
    bldgFogColor: WebGLUniformLocation | null;
    bldgNightEmissive: WebGLUniformLocation | null;
    bldgGlassBoost: WebGLUniformLocation | null;
    bldgOpacity: WebGLUniformLocation | null;
    bldgIsStreetMode: WebGLUniformLocation | null;
  } | null = null;

  let shadowBuffer: WebGLBuffer | null = null;
  let shadowVao: WebGLVertexArrayObject | null = null;
  let aoBuffer: WebGLBuffer | null = null;
  let aoVao: WebGLVertexArrayObject | null = null;
  let solidBuffer: WebGLBuffer | null = null;
  let solidVao: WebGLVertexArrayObject | null = null;
  let emptyVao: WebGLVertexArrayObject | null = null;

  let shadowFbo: WebGLFramebuffer | null = null;
  let shadowTex: WebGLTexture | null = null;
  let shadowDepthStencil: WebGLRenderbuffer | null = null;
  let fboWidth = 0;
  let fboHeight = 0;
  const localMvp64 = new Float64Array(16);

  const notifyCustomActive = () => {
    const active = Boolean(!disposed && !isFlat && programsReady && !programsFailed && chunk && chunk.solidVertexCount > 0);
    if (active !== customRenderedReported) {
      customRenderedReported = active;
      options.onCustomStateChange?.(active);
    }
  };

  const ensurePrograms = (gl: WebGL2RenderingContext) => {
    if (programsReady || programsFailed) return programsReady;
    shadowCasterProgram = linkProgram(gl, SHADOW_CASTER_VERT, SHADOW_CASTER_FRAG);
    aoProgram = linkProgram(gl, CONTACT_AO_VERT, CONTACT_AO_FRAG);
    shadowCompositeProgram = linkProgram(gl, SHADOW_COMPOSITE_VERT, SHADOW_COMPOSITE_FRAG);
    buildingProgram = linkProgram(gl, BUILDING_VERT, BUILDING_FRAG);
    if (!shadowCasterProgram || !aoProgram || !shadowCompositeProgram || !buildingProgram) {
      programsFailed = true;
      disposeGlResources();
      return false;
    }

    uniforms = {
      casterMvp: gl.getUniformLocation(shadowCasterProgram, "u_local_mvp"),
      casterProjPerM: gl.getUniformLocation(shadowCasterProgram, "u_shadow_proj_per_m"),
      casterHeightScale: gl.getUniformLocation(shadowCasterProgram, "u_height_scale"),
      aoMvp: gl.getUniformLocation(aoProgram, "u_local_mvp"),
      compShadowTex: gl.getUniformLocation(shadowCompositeProgram, "u_shadow_tex"),
      compTexelSize: gl.getUniformLocation(shadowCompositeProgram, "u_texel_size"),
      compShadowColor: gl.getUniformLocation(shadowCompositeProgram, "u_shadow_color"),
      compDirShadowAlpha: gl.getUniformLocation(shadowCompositeProgram, "u_dir_shadow_alpha"),
      compAoAlpha: gl.getUniformLocation(shadowCompositeProgram, "u_ao_alpha"),
      compFadeOpacity: gl.getUniformLocation(shadowCompositeProgram, "u_fade_opacity"),
      bldgMvp: gl.getUniformLocation(buildingProgram, "u_local_mvp"),
      bldgHeightScale: gl.getUniformLocation(buildingProgram, "u_height_scale"),
      bldgInvMercPerM: gl.getUniformLocation(buildingProgram, "u_inv_merc_per_meter"),
      bldgCamPosM: gl.getUniformLocation(buildingProgram, "u_camera_pos_m"),
      bldgSunDir: gl.getUniformLocation(buildingProgram, "u_sun_dir"),
      bldgSunColor: gl.getUniformLocation(buildingProgram, "u_sun_color"),
      bldgSunIntensity: gl.getUniformLocation(buildingProgram, "u_sun_intensity"),
      bldgSkyZenith: gl.getUniformLocation(buildingProgram, "u_sky_zenith"),
      bldgSkyHorizon: gl.getUniformLocation(buildingProgram, "u_sky_horizon"),
      bldgGroundBounce: gl.getUniformLocation(buildingProgram, "u_ground_bounce"),
      bldgFogColor: gl.getUniformLocation(buildingProgram, "u_fog_color"),
      bldgNightEmissive: gl.getUniformLocation(buildingProgram, "u_night_emissive"),
      bldgGlassBoost: gl.getUniformLocation(buildingProgram, "u_glass_boost"),
      bldgOpacity: gl.getUniformLocation(buildingProgram, "u_opacity"),
      bldgIsStreetMode: gl.getUniformLocation(buildingProgram, "u_is_street_mode"),
    };

    shadowBuffer = gl.createBuffer();
    shadowVao = gl.createVertexArray();
    gl.bindVertexArray(shadowVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, shadowBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);

    aoBuffer = gl.createBuffer();
    aoVao = gl.createVertexArray();
    gl.bindVertexArray(aoVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, aoBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);

    solidBuffer = gl.createBuffer();
    solidVao = gl.createVertexArray();
    gl.bindVertexArray(solidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, solidBuffer);
    const stride = 14 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 6 * 4);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 10 * 4);

    emptyVao = gl.createVertexArray();
    gl.bindVertexArray(null);
    programsReady = true;
    return true;
  };

  const ensureShadowFbo = (gl: WebGL2RenderingContext, width: number, height: number) => {
    const safeW = Math.max(2, width);
    const safeH = Math.max(2, height);
    if (shadowFbo && fboWidth === safeW && fboHeight === safeH) return true;

    if (!shadowFbo) shadowFbo = gl.createFramebuffer();
    if (!shadowTex) shadowTex = gl.createTexture();
    if (!shadowDepthStencil) shadowDepthStencil = gl.createRenderbuffer();

    gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, safeW, safeH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindRenderbuffer(gl.RENDERBUFFER, shadowDepthStencil);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, safeW, safeH);

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, shadowTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, shadowDepthStencil);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);

    if (status !== gl.FRAMEBUFFER_COMPLETE) return false;
    fboWidth = safeW;
    fboHeight = safeH;
    return true;
  };

  const uploadChunkIfNeeded = (gl: WebGL2RenderingContext) => {
    if (!chunk || chunkUploaded || !programsReady) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, solidBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, chunk.solidVertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, shadowBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, chunk.shadowVertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, aoBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, chunk.aoVertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    chunkUploaded = true;
    notifyCustomActive();
  };

  const disposeGlResources = () => {
    const gl = glRef;
    if (!gl) return;
    if (shadowCasterProgram) gl.deleteProgram(shadowCasterProgram);
    if (aoProgram) gl.deleteProgram(aoProgram);
    if (shadowCompositeProgram) gl.deleteProgram(shadowCompositeProgram);
    if (buildingProgram) gl.deleteProgram(buildingProgram);
    if (shadowBuffer) gl.deleteBuffer(shadowBuffer);
    if (aoBuffer) gl.deleteBuffer(aoBuffer);
    if (solidBuffer) gl.deleteBuffer(solidBuffer);
    if (shadowVao) gl.deleteVertexArray(shadowVao);
    if (aoVao) gl.deleteVertexArray(aoVao);
    if (solidVao) gl.deleteVertexArray(solidVao);
    if (emptyVao) gl.deleteVertexArray(emptyVao);
    if (shadowTex) gl.deleteTexture(shadowTex);
    if (shadowDepthStencil) gl.deleteRenderbuffer(shadowDepthStencil);
    if (shadowFbo) gl.deleteFramebuffer(shadowFbo);
    shadowCasterProgram = aoProgram = shadowCompositeProgram = buildingProgram = null;
    uniforms = null;
    shadowBuffer = aoBuffer = solidBuffer = null;
    shadowVao = aoVao = solidVao = emptyVao = null;
    shadowTex = null;
    shadowDepthStencil = null;
    shadowFbo = null;
    fboWidth = fboHeight = 0;
    programsReady = false;
  };

  const zoomHeightScale = () => {
    const z = map.getZoom?.() ?? 0;
    if (z <= 13.0) return 0;
    const t = Math.max(0, Math.min(1, (z - 13.0) / 0.85));
    return t * t * (3 - 2 * t);
  };

  const syncGeometry = () => {
    if (disposed || isFlat) return;
    if (typeof map.querySourceFeatures !== "function") return;
    const zoom = map.getZoom?.() ?? 0;
    if (zoom < 12.6) {
      if (chunk && chunk.featureCount > 0) {
        chunk = null;
        chunkUploaded = false;
        notifyCustomActive();
      }
      return;
    }

    let rawFeatures: BuildingFeatureInput[];
    try {
      rawFeatures = map.querySourceFeatures(options.sourceId, { sourceLayer: "building" }) as unknown as BuildingFeatureInput[];
    } catch {
      return;
    }
    if (!rawFeatures.length) return;
    const center = map.getCenter?.();
    if (!center) return;
    const nextChunk = buildArchitecturalChunk(rawFeatures, center.lng, center.lat);
    if (!nextChunk.solidVertexCount) return;
    if (chunk && chunk.signature === nextChunk.signature && Math.abs(chunk.originX - nextChunk.originX) < 0.002 && Math.abs(chunk.originY - nextChunk.originY) < 0.002) {
      return;
    }
    chunk = nextChunk;
    chunkUploaded = false;
    notifyCustomActive();
    map.triggerRepaint?.();
  };

  const scheduleSync = (immediate = false) => {
    if (disposed) return;
    if (syncTimer) clearTimeout(syncTimer);
    if (immediate) {
      syncTimer = undefined;
      syncGeometry();
      return;
    }
    const motionMap = map as unknown as { isMoving?: () => boolean; isZooming?: () => boolean; isRotating?: () => boolean };
    const interacting = Boolean(chunk && (motionMap.isMoving?.() || motionMap.isZooming?.() || motionMap.isRotating?.()));
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      if (disposed) return;
      if (chunk && (motionMap.isMoving?.() || motionMap.isZooming?.() || motionMap.isRotating?.())) {
        scheduleSync(false);
        return;
      }
      syncGeometry();
    }, interacting ? 220 : 110);
  };

  const computeLocalProjection = (renderOpts: CustomRenderMethodInput): Float32Array | null => {
    if (!chunk || !renderOpts.defaultProjectionData?.mainMatrix) return null;
    // Above zoom 12.5 globe projection converges onto Mercator fallback/main matrix smoothly.
    const rawMatrix = renderOpts.defaultProjectionData.projectionTransition > 0.001
      ? renderOpts.defaultProjectionData.fallbackMatrix
      : renderOpts.defaultProjectionData.mainMatrix;
    return composeLocalMvpFloat32(rawMatrix, chunk.originX, chunk.originY, chunk.mercPerMeter, localMvp64);
  };

  const shadowLayer: CustomLayerInterface = {
    id: CUSTOM_BUILDING_SHADOW_LAYER_ID,
    type: "custom",
    renderingMode: "2d",
    onAdd(_m, gl) {
      glRef = gl;
      ensurePrograms(gl);
      notifyCustomActive();
    },
    onRemove(_m, gl) {
      glRef = gl;
      disposeGlResources();
    },
    prerender(gl, renderOpts) {
      if (disposed || isFlat) return;
      glRef = gl;
      if (!ensurePrograms(gl)) return;
      uploadChunkIfNeeded(gl);
      const heightScale = zoomHeightScale();
      if (!chunk || !chunkUploaded || heightScale <= 0.005 || (!chunk.shadowVertexCount && !chunk.aoVertexCount)) return;
      if (typeof renderOpts?.defaultProjectionData?.projectionTransition === "number" && renderOpts.defaultProjectionData.projectionTransition > 0.15) return;

      const localMvp = computeLocalProjection(renderOpts);
      if (!localMvp) return;
      const targetShadowW = Math.max(2, Math.round(gl.drawingBufferWidth * 0.5));
      const targetShadowH = Math.max(2, Math.round(gl.drawingBufferHeight * 0.5));
      if (!ensureShadowFbo(gl, targetShadowW, targetShadowH)) return;

      const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      const restoreW = gl.drawingBufferWidth;
      const restoreH = gl.drawingBufferHeight;
      const preset = ARCHITECTURAL_LIGHT_PRESETS[visualMode];
      const projPerM = sunShadowMercatorPerMeter(preset.sunAzimuthDeg, preset.sunElevationDeg, chunk.mercPerMeter);

      gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFbo);
      gl.viewport(0, 0, fboWidth, fboHeight);
      gl.colorMask(true, true, true, true);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.stencilMask(0xff);
      gl.clearColor(0, 0, 0, 0);
      gl.clearStencil(0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

      // Pass 1: Stencil-deduplicated projected directional shadows into Red channel.
      if (chunk.shadowVertexCount > 0 && shadowCasterProgram && uniforms) {
        gl.colorMask(true, false, false, false);
        gl.disable(gl.BLEND);
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(gl.EQUAL, 0, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
        gl.useProgram(shadowCasterProgram);
        gl.uniformMatrix4fv(uniforms.casterMvp, false, localMvp);
        gl.uniform2f(uniforms.casterProjPerM, projPerM[0], projPerM[1]);
        gl.uniform1f(uniforms.casterHeightScale, heightScale);
        gl.bindVertexArray(shadowVao);
        gl.drawArrays(gl.TRIANGLES, 0, chunk.shadowVertexCount);
        gl.disable(gl.STENCIL_TEST);
      }

      // Pass 2: Smooth radial wall contact Ambient Occlusion skirts into Green channel with MAX blending.
      if (chunk.aoVertexCount > 0 && aoProgram && uniforms) {
        gl.colorMask(false, true, false, false);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.MAX);
        gl.useProgram(aoProgram);
        gl.uniformMatrix4fv(uniforms.aoMvp, false, localMvp);
        gl.bindVertexArray(aoVao);
        gl.drawArrays(gl.TRIANGLES, 0, chunk.aoVertexCount);
        gl.blendEquation(gl.FUNC_ADD);
      }

      gl.colorMask(true, true, true, true);
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
      gl.viewport(0, 0, restoreW, restoreH);
    },
    render(gl, renderOpts) {
      if (disposed || isFlat || !programsReady || !chunk || !chunkUploaded || !shadowCompositeProgram || !shadowTex || !uniforms) return;
      const heightScale = zoomHeightScale();
      if (heightScale <= 0.005) return;
      if (typeof renderOpts?.defaultProjectionData?.projectionTransition === "number" && renderOpts.defaultProjectionData.projectionTransition > 0.15) return;

      const preset = ARCHITECTURAL_LIGHT_PRESETS[visualMode];
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(shadowCompositeProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, shadowTex);
      gl.uniform1i(uniforms.compShadowTex, 0);
      const dprScale = Math.max(1, gl.drawingBufferWidth / Math.max(1, map.getCanvas?.()?.clientWidth || gl.drawingBufferWidth));
      gl.uniform2f(uniforms.compTexelSize, (dprScale * 0.65) / Math.max(1, fboWidth), (dprScale * 0.65) / Math.max(1, fboHeight));
      gl.uniform3f(uniforms.compShadowColor, preset.shadowColor[0], preset.shadowColor[1], preset.shadowColor[2]);
      gl.uniform1f(uniforms.compDirShadowAlpha, preset.dirShadowAlpha * heightScale);
      gl.uniform1f(uniforms.compAoAlpha, preset.contactAoAlpha * Math.min(1, heightScale * 1.15));
      gl.uniform1f(uniforms.compFadeOpacity, preset.opacity);
      gl.bindVertexArray(emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D, null);
    },
  };

  const architecturalLayer: CustomLayerInterface = {
    id: CUSTOM_BUILDING_SCENE_LAYER_ID,
    type: "custom",
    renderingMode: "3d",
    render(gl, renderOpts) {
      if (disposed || isFlat) return;
      glRef = gl;
      if (!ensurePrograms(gl)) return;
      uploadChunkIfNeeded(gl);
      const heightScale = zoomHeightScale();
      if (!chunk || !chunkUploaded || !buildingProgram || !uniforms || chunk.solidVertexCount === 0 || heightScale <= 0.005) return;
      if (typeof renderOpts?.defaultProjectionData?.projectionTransition === "number" && renderOpts.defaultProjectionData.projectionTransition > 0.15) return;

      const localMvp = computeLocalProjection(renderOpts);
      if (!localMvp) return;
      notifyCustomActive();

      const preset = ARCHITECTURAL_LIGHT_PRESETS[visualMode];
      const sunDir = sunDirectionENU(preset.sunAzimuthDeg, preset.sunElevationDeg);
      const camPos = extractCameraLocalPositionMeters(localMvp64, chunk.mercPerMeter);

      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(buildingProgram);
      gl.uniformMatrix4fv(uniforms.bldgMvp, false, localMvp);
      gl.uniform1f(uniforms.bldgHeightScale, heightScale);
      gl.uniform1f(uniforms.bldgInvMercPerM, 1 / chunk.mercPerMeter);
      gl.uniform3f(uniforms.bldgCamPosM, camPos[0], camPos[1], camPos[2]);
      gl.uniform3f(uniforms.bldgSunDir, sunDir[0], sunDir[1], sunDir[2]);
      gl.uniform3f(uniforms.bldgSunColor, preset.sunColor[0], preset.sunColor[1], preset.sunColor[2]);
      gl.uniform1f(uniforms.bldgSunIntensity, preset.sunIntensity);
      gl.uniform3f(uniforms.bldgSkyZenith, preset.skyZenithColor[0], preset.skyZenithColor[1], preset.skyZenithColor[2]);
      gl.uniform3f(uniforms.bldgSkyHorizon, preset.skyHorizonColor[0], preset.skyHorizonColor[1], preset.skyHorizonColor[2]);
      gl.uniform3f(uniforms.bldgGroundBounce, preset.groundBounceColor[0], preset.groundBounceColor[1], preset.groundBounceColor[2]);
      gl.uniform3f(uniforms.bldgFogColor, preset.fogColor[0], preset.fogColor[1], preset.fogColor[2]);
      gl.uniform1f(uniforms.bldgNightEmissive, preset.nightEmissive);
      gl.uniform1f(uniforms.bldgGlassBoost, preset.glassBoost);
      gl.uniform1f(uniforms.bldgOpacity, preset.opacity);
      gl.uniform1f(uniforms.bldgIsStreetMode, visualMode === "street" ? 1.0 : 0.0);

      gl.bindVertexArray(solidVao);
      gl.drawArrays(gl.TRIANGLES, 0, chunk.solidVertexCount);
      gl.bindVertexArray(null);
    },
  };

  const attach = () => {
    if (disposed || layersAttached || typeof map.addLayer !== "function" || typeof map.getStyle !== "function") return;
    // Skip attaching custom WebGL layers in synthetic DOM test environments or when shaders fail to link.
    let probeGl: WebGL2RenderingContext | null;
    try {
      const canvas = map.getCanvas?.();
      if (!canvas || typeof canvas.getContext !== "function") return;
      probeGl = canvas.getContext("webgl2");
      if (!probeGl) return;
      glRef = probeGl;
      if (!ensurePrograms(probeGl)) return;
    } catch {
      return;
    }

    const styleLayers = map.getStyle?.()?.layers ?? [];
    const native3d = styleLayers.find((layer) => layer.id.endsWith(":3d"));
    const beforeId = native3d?.id;
    try {
      if (!map.getLayer?.(CUSTOM_BUILDING_SHADOW_LAYER_ID)) {
        map.addLayer(shadowLayer as unknown as Parameters<MapLibreMap["addLayer"]>[0], beforeId);
      }
      if (!map.getLayer?.(CUSTOM_BUILDING_SCENE_LAYER_ID)) {
        map.addLayer(architecturalLayer as unknown as Parameters<MapLibreMap["addLayer"]>[0], beforeId);
      }
      layersAttached = true;
      scheduleSync(true);
    } catch {
      // Leave native fill-extrusion intact on unsupported runtimes.
    }
  };

  return {
    shadowLayerId: CUSTOM_BUILDING_SHADOW_LAYER_ID,
    buildingLayerId: CUSTOM_BUILDING_SCENE_LAYER_ID,
    attach,
    setVisualState(mode, flat) {
      visualMode = mode;
      isFlat = flat;
      notifyCustomActive();
      map.triggerRepaint?.();
    },
    scheduleSync,
    isRenderingCustom() {
      return customRenderedReported;
    },
    dispose() {
      disposed = true;
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = undefined;
      try {
        if (map.getLayer?.(CUSTOM_BUILDING_SCENE_LAYER_ID)) map.removeLayer?.(CUSTOM_BUILDING_SCENE_LAYER_ID);
        if (map.getLayer?.(CUSTOM_BUILDING_SHADOW_LAYER_ID)) map.removeLayer?.(CUSTOM_BUILDING_SHADOW_LAYER_ID);
      } catch {
        // Ignore teardown errors when map is already destroyed.
      }
      disposeGlResources();
    },
  };
}
