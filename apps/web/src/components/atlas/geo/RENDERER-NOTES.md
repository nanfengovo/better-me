# Renderer prototype handoff

## Implemented comparison adapters

The sibling `../prototypes/` directory now contains two independent React
adapters behind the same `AtlasPrototypeProps` contract:

- `MapLibrePrototype.tsx`: a true globe projection with local land dots,
  domestic fill extrusion, WGS84 bucket picking, category rings and a continuous
  zoom to configurable online vector/raster basemaps. Its default OpenFreeMap
  Positron/Dark style follows the workspace light/dark preference; explicit
  `basemap: null` retains only the local overview.
- `ThreePrototype.tsx`: a true ocean sphere with triangulated spherical country
  meshes, province `ExtrudeGeometry`, instanced job markers with proportional
  category sectors, selectable regions and an optional domestic pedestal.

Both accept the existing `MapBucket[]` without altering source/company facts.
The local geometry requires no tile key, glyph/texture/HDR service or data from
a visual reference site. MapLibre's optional online detail separately requests
its configured provider's style, tiles, glyphs and sprites, with visible source
attribution; those provider requests are not offline assets. Effects own and
dispose their renderer, fetch, listeners and resize observer. They support
reduced motion, hidden-tab pause, context-loss errors and a list-compatible
fallback message. Keyboard camera controls are included in the Three adapter;
the consuming workspace remains responsible for accessible job/region controls.

The integration change installed exact `maplibre-gl@6.15.0` and `three@0.186.1`;
R3F/Drei remain researched alternatives. The Three adapter uses plain React
effects and Three rather than claiming an uninstalled React scene framework.

MapLibre's standalone `.mjs` worker is explicitly imported through Vite `?url`
and assigned with `setWorkerUrl`, so optimized development modules and Pages
subpaths resolve the actual worker asset. The registered map configuration lives
in `../prototypes/basemaps.json`; endpoints, native zoom, maximum view zoom and
attribution can be supplied through the same typed contract. A tile/glyph/style
failure reports a status while retaining the local overview. It does not become
a fullscreen WebGL-failure message. See `../prototypes/README.md` for provider
scope and location-precision boundaries.

Independent Node checks on 2026-10-18 passed for the actual geometry helpers:

| Check | World | China display groups |
| --- | --- | --- |
| Features / retained polygon parts / holes | 177 / 290 / 1 | 34 / 113 / 0 |
| Generated land vertices | 94,767 | 302,868 |
| Geometry attribute bytes | 2,274,408 | 9,691,776 |
| Outline vertices | 22,062 | 50,704 |
| One measured construction + finite-array audit | 82.1 ms | 151.8 ms |

All world vertices lie at radius `4.026 ± 0.00000024`; every triangle centroid
remains outside the radius-4 ocean sphere (minimum `4.01816289`). China vertices
remain within the requested `0–0.16` extrusion height. Both modes also passed
finite marker matrices, mixed-category segment construction, invalid-coordinate
filtering, empty input and selection checks. These are local Node CPU checks,
not browser/GPU/frame-time or visual acceptance. Scoped ESLint and the Web
TypeScript project passed after implementation. Actual browser comparison,
device budgets and the final renderer decision belong to integration acceptance.

## Candidate research retained for context

Checked 2026-10-18 against exact npm registry metadata and upstream source. No map
dependency was installed by this asset task. The current workspace resolves
React 19.3.1; the peer ranges below include that version.

| Package / exact candidate | License | Relevant compatibility | Pinned source |
| --- | --- | --- | --- |
| `maplibre-gl@6.15.0` | BSD-3-Clause plus its third-party notices | Node >=16.14, npm >=8.1; uses WebGL2; direct lifecycle integration needs no React wrapper | [gitHead 638b3f9](https://github.com/maplibre/maplibre-gl-js/tree/638b3f9ecab4b743fd4d086d3bfd19bce7b7b032) |
| `three@0.186.1` | MIT | Direct React effect integration or R3F; built-in `Shape`, hole-aware triangulation, `ExtrudeGeometry`, `InstancedMesh`, and addon `OrbitControls` | [gitHead 9b4a2ac](https://github.com/mrdoob/three.js/tree/9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8) |
| `@react-three/fiber@9.8.2` | MIT | React / React DOM >=19 <19.4; Three >=0.156; native/Expo peers optional | [gitHead e6ec350](https://github.com/pmndrs/react-three-fiber/tree/e6ec3506ebf7879c26bd5ac27986b5d4421f3254) |
| `@react-three/drei@10.7.9` | MIT | React ^19; R3F ^9; Three >=0.159 | [gitHead 66b9bda](https://github.com/pmndrs/drei/tree/66b9bda91eee0ae98837e16c053888c34341421e) |

Registry evidence: [MapLibre 6.15.0](https://registry.npmjs.org/maplibre-gl/6.15.0),
[Three 0.186.1](https://registry.npmjs.org/three/0.186.1),
[R3F 9.8.2](https://registry.npmjs.org/@react-three/fiber/9.8.2),
[Drei 10.7.9](https://registry.npmjs.org/@react-three/drei/10.7.9).
These are observed package versions, not a promise that future `latest` tags or
an untested combination will remain compatible.

## What to run first

Build two small renderers behind the same map/list controller. First install only
exact MapLibre and Three versions in the owner's integration change; a plain
Three effect can establish the visual comparison without adding R3F and Drei.
The latter are reasonable once the scene complexity warrants React scene nodes.
Keep each renderer in a separate dynamic import and destroy the inactive scene.

Use **MapLibre for the initial global candidate**: it already handles globe
projection, country-to-city camera navigation, WGS84 picking and clustered
GeoJSON points. It can use a fully local style with the world file as its only
land source. An empty `sources`/`layers` style has no remote glyphs, sprites or
tiles. Add local geometry, data points and at most selected HTML labels. This
avoids claiming a remote demo tile service is a free offline map.

For the domestic premium scene, compare MapLibre's tilted `fill-extrusion` with
**Three's province extrusions** using the same 34-feature file. Three offers
better control over independent province lift, rim lighting, paper/metal/glass
materials and a restrained pedestal. Begin with opaque/low-transmission physical
materials and no bevel on narrow islands. Expensive glass transmission and
postprocessing need an explicit measured quality tier. No external HDR or
unlicensed matcap is necessary: hemisphere/directional lights and local colors
are enough to assess shape, hierarchy and readability.

The recommended decision gate is the actual comparison: keep MapLibre globally;
use the domestic Three adapter if its visual and interaction result justifies
the extra engine and meets the measured device budget. Otherwise retain a shared
MapLibre renderer. This remains a prototype recommendation, not a completed
renderer selection or visual/performance acceptance result.

## Minimal MapLibre entry point

After the exact dependency is installed, this is a runnable effect helper with
the parsed local world collection. It requests no remote tile/font/texture:

```ts
import { Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { FeatureCollection } from "geojson";

export function mountGlobe(container: HTMLElement, world: FeatureCollection) {
  const map = new Map({
    container, center: [105, 24], zoom: 1.1,
    style: {
      version: 8,
      sources: { land: { type: "geojson", data: world } },
      layers: [
        { id: "ocean", type: "background", paint: { "background-color": "#101e26" } },
        { id: "land", type: "fill", source: "land", paint: { "fill-color": "#53736a" } },
        { id: "borders", type: "line", source: "land", paint: { "line-color": "#b4c8bc", "line-width": 0.6 } },
      ],
    },
  });
  map.on("load", () => {
    map.setProjection({ type: "globe" });
    map.setSky({ "atmosphere-blend": 1 });
  });
  const observer = new ResizeObserver(() => map.resize());
  observer.observe(container);
  return () => { observer.disconnect(); map.remove(); };
}
```

Source checks found `Map.setProjection`, `Map.setSky`, and explicit `webgl2`
context creation in the exact MapLibre source. The `geojson` type can be provided
by its installed type dependency; the renderer must still perform its own runtime
fetch/error handling. Add a visible source credit outside the canvas.

## Domestic extrusion core

The parent renderer owns the camera, lights, resize/cleanup and job picking.
This reusable core retains every multipart outline and hole; its projection is
only a visual Mercator placement, never the job-distance calculation:

```ts
import { ExtrudeGeometry, Path, Shape } from "three";
import type { FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";

const radians = Math.PI / 180;
function project(point: Position): [number, number] {
  const [longitude, latitude] = point;
  if (typeof longitude !== "number" || typeof latitude !== "number") {
    throw new Error("Expected a validated WGS84 position");
  }
  return [longitude * radians, Math.log(Math.tan(Math.PI / 4 + latitude * radians / 2))];
}
export function provinceGeometries(data: FeatureCollection<Polygon | MultiPolygon>) {
  return data.features.map((feature) => {
    const parts = feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const shapes = parts.map((rings) => {
      const outline = new Shape();
      const exterior = rings[0];
      if (!exterior) throw new Error("Expected a non-empty validated polygon");
      exterior.forEach((position, index) => {
        const [x, y] = project(position);
        if (index === 0) outline.moveTo(x, y); else outline.lineTo(x, y);
      });
      outline.closePath();
      rings.slice(1).forEach((ring) => {
        const hole = new Path();
        ring.forEach((position, index) => {
          const [x, y] = project(position);
          if (index === 0) hole.moveTo(x, y); else hole.lineTo(x, y);
        });
        hole.closePath();
        outline.holes.push(hole);
      });
      return outline;
    });
    return { id: String(feature.id), geometry: new ExtrudeGeometry(shapes, {
      depth: 0.015, steps: 1, bevelEnabled: false, curveSegments: 1,
    }) };
  });
}
```

Validate parsed GeoJSON before passing it to either helper; the snippet focuses
on the geometry operation. Center/scale the complete group from
its bounds and orient the camera to view the XY top surface. Do not fit only the
mainland or label points. `ExtrudeGeometry`'s exact source invokes
`ShapeUtils.triangulateShape(contour, holes)`; skipping holes or a MultiPolygon's
later parts is an implementation bug, not a limitation of this asset.

Measure both candidates on the same repeatable points, 1440px desktop and a
narrow viewport: first-render time, transferred chunks, idle work, interaction
frame time, memory, resize, pointer/list selection, context loss and unmount.
Use instancing for repeated job markers, modest DPR, reduced-motion/static mode
and no perpetual camera rotation. No WebGL2 must leave an accessible SVG/list
view; a different WebGL canvas is not a no-WebGL fallback. Results are still to
be collected by the renderer implementation task.
