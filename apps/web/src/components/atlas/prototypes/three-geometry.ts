import { BufferGeometry, ExtrudeGeometry, Float32BufferAttribute, Path, Shape, ShapeUtils, Vector2, Vector3 } from "three";
import { CHINA_BOUNDS, type BoundaryFeature, type Coordinate } from "./types";

const RAD = Math.PI / 180;
const mercator = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, latitude)) * RAD / 2));
const centerX = (CHINA_BOUNDS[0] + CHINA_BOUNDS[2]) * .5 * RAD;
const centerY = (mercator(CHINA_BOUNDS[1]) + mercator(CHINA_BOUNDS[3])) * .5;
export function domesticPosition(longitude: number, latitude: number, height = 0): Vector3 {
  return new Vector3((longitude * RAD - centerX) * 12, height, -(mercator(latitude) - centerY) * 12);
}
export function globePosition(longitude: number, latitude: number, radius = 4): Vector3 {
  const phi = latitude * RAD; const theta = longitude * RAD;
  return new Vector3(radius * Math.cos(phi) * Math.sin(theta), radius * Math.sin(phi), radius * Math.cos(phi) * Math.cos(theta));
}
export function featurePolygons(feature: BoundaryFeature): Coordinate[][][] {
  return feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
}
export function domesticGeometry(feature: BoundaryFeature, depth: number): ExtrudeGeometry {
  const shapes = featurePolygons(feature).map((rings) => {
    const outline = new Shape();
    const addRing = (ring: Coordinate[], path: Shape | Path) => {
      ring.forEach(([longitude, latitude], index) => {
        const point = domesticPosition(longitude, latitude);
        if (index === 0) path.moveTo(point.x, -point.z); else path.lineTo(point.x, -point.z);
      });
      path.closePath();
    };
    addRing(rings[0]!, outline);
    for (const ring of rings.slice(1)) { const hole = new Path(); addRing(ring, hole); outline.holes.push(hole); }
    return outline;
  });
  const geometry = new ExtrudeGeometry(shapes, { depth, steps: 1, bevelEnabled: false, curveSegments: 1 });
  geometry.rotateX(-Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

/** Subdivide longitude/latitude triangles before mapping to the sphere, so land follows the curved surface. */
export function globeGeometry(feature: BoundaryFeature): BufferGeometry {
  const positions: number[] = []; const normals: number[] = [];
  const write = (a: Coordinate, b: Coordinate, c: Coordinate) => {
    const points = [a, b, c].map(([longitude, latitude]) => globePosition(longitude, latitude, 4.026));
    const normal = points[1]!.clone().sub(points[0]!).cross(points[2]!.clone().sub(points[0]!));
    if (normal.dot(points[0]!) < 0) [points[1], points[2]] = [points[2]!, points[1]!];
    for (const point of points) { positions.push(point.x, point.y, point.z); const unit = point.clone().normalize(); normals.push(unit.x, unit.y, unit.z); }
  };
  for (const rings of featurePolygons(feature)) {
    const contour = rings[0]!.slice(0, -1).map(([x, y]) => new Vector2(x, y));
    const holes = rings.slice(1).map((ring) => ring.slice(0, -1).map(([x, y]) => new Vector2(x, y)));
    const faces = ShapeUtils.triangulateShape(contour, holes);
    const vertices = [...contour, ...holes.flat()];
    for (const face of faces) {
      const a = vertices[face[0]!]!; const b = vertices[face[1]!]!; const c = vertices[face[2]!]!;
      const longest = Math.max(a.distanceTo(b), a.distanceTo(c), b.distanceTo(c));
      const divisions = Math.min(32, Math.max(1, Math.ceil(longest / 7)));
      const at = (u: number, v: number): Coordinate => [a.x + (b.x - a.x) * u + (c.x - a.x) * v, a.y + (b.y - a.y) * u + (c.y - a.y) * v];
      for (let i = 0; i < divisions; i++) for (let j = 0; j < divisions - i; j++) {
        write(at(i / divisions, j / divisions), at((i + 1) / divisions, j / divisions), at(i / divisions, (j + 1) / divisions));
        if (i + j < divisions - 1) write(at((i + 1) / divisions, j / divisions), at((i + 1) / divisions, (j + 1) / divisions), at(i / divisions, (j + 1) / divisions));
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Densify the globe outline as well; chords may otherwise disappear under the ocean sphere. */
export function outlineGeometry(features: readonly BoundaryFeature[], mode: "global" | "domestic", height: number): BufferGeometry {
  const positions: number[] = [];
  for (const feature of features) for (const rings of featurePolygons(feature)) for (const ring of rings) {
    for (let index = 1; index < ring.length; index++) {
      const a = ring[index - 1]!; const b = ring[index]!;
      const pieces = mode === "global" ? Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2)) : 1;
      const at = (fraction: number) => {
        const longitude = a[0] + (b[0] - a[0]) * fraction; const latitude = a[1] + (b[1] - a[1]) * fraction;
        return mode === "global" ? globePosition(longitude, latitude, 4.037) : domesticPosition(longitude, latitude, height + .006);
      };
      for (let part = 0; part < pieces; part++) { const first = at(part / pieces); const next = at((part + 1) / pieces); positions.push(first.x, first.y, first.z, next.x, next.y, next.z); }
    }
  }
  return new BufferGeometry().setAttribute("position", new Float32BufferAttribute(positions, 3));
}
