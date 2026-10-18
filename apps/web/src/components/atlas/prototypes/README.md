# Atlas rendering adapters

`MapLibrePrototype` is the current continuous map adapter. It uses one WGS84
camera from the global dotted globe through country and city views to street
detail. Domestic mode starts with province extrusion, which fades between zoom
4.5 and 6.5 to expose the detailed basemap. The standalone `ThreePrototype`
remains a geometry/material comparison adapter; it does not supply street maps.

The common contract in `types.ts` consumes the shared opportunity query's
`MapBucket[]`. Renderers never infer an office, an employer's controlling
jurisdiction or the existence of a job from a boundary or a map label.

## Configuration and camera

- `visual.theme` chooses `light` or `dark`. Without an explicit basemap, the
  default is OpenFreeMap Positron or Dark respectively. Its source definitions,
  public endpoints, attribution links and allowed view zoom are in
  [basemaps.json](basemaps.json). `basemaps.ts` validates the same configuration
  supplied by a consuming application.
- `basemap: null` chooses the packaged local overview and makes no basemap
  requests. A configured vector-style or raster provider supplies online
  detail. This contract accommodates another licensed provider or a self-hosted
  map service without changing the opportunity query.
- `focus: { longitude, latitude, zoom?, requestId? }` flies to a supplied WGS84
  coordinate. The consumer owns address lookup, candidate confirmation and
  coordinate precision. A new request ID can represent a repeated navigation.
- `onViewChange` reports `{ zoom, center, bounds }` after camera movement ends;
  auto-rotation frames are suppressed. The consumer can query city buckets at
  overview scale and location buckets at close range through the same domain
  query. Camera movement does not write or upgrade location evidence.
- A country/province click fits its retained geometry. Bucket picking returns
  the original bucket. It does not silently promote a city estimate to a
  verified street address. The consumer can deliberately focus the selected
  location with its recorded precision.

Navigation/scale controls and keyboard movement come from MapLibre. Scene
rotation is optional, restricted to the distant globe and respects reduced
motion and hidden tabs. Context-loss errors retain the accompanying job list.
Online tile, glyph, sprite or style errors use a status message and preserve the
packaged overview. Detailed labels and geographic coverage remain properties of
the chosen map provider.

## Online sources and geographic detail

Checked on 2026-10-18:

| Provider | Requests / detail | Attribution and service conditions |
| --- | --- | --- |
| OpenFreeMap Positron / Dark | Public style, vector TileJSON, sprites and glyphs; no key. Current `/planet` TileJSON has native max zoom 14. Vector geometry stays crisp when overzoomed through view zoom 22; this does not create additional measured detail. Street/building/house-number coverage follows its OpenStreetMap/OpenMapTiles data. | Visible OpenFreeMap, OpenMapTiles and OpenStreetMap credit. [Quick start](https://openfreemap.org/quick_start/), [service terms](https://openfreemap.org/tos/) and [source attribution](https://openfreemap.org/#attribution). Public service is free and supplied as-is; availability and geographic completeness are not guaranteed. |
| OpenStreetMap Standard raster | Optional configured fallback, exact HTTPS endpoint `tile.openstreetmap.org/{z}/{x}/{y}.png`, native zoom 19, view overzoom to 22. | Visible OpenStreetMap copyright link, ordinary browser Referer and HTTP caching. [Tile usage policy](https://operations.osmfoundation.org/policies/tiles/) permits normal interactive viewport loading and prohibits bulk/offline prefetch or headless pan/zoom scans. No prefetch/download feature is implemented here. |
| Packaged Natural Earth overview | Versioned world/province geometry and derived land dots. Overview rendering needs no online map provider. | [Boundary notice](../geo/NOTICE.md), [license](../geo/NATURAL-EARTH-LICENSE.md), [manifest](../geo/manifest.json) and [dot manifest](../geo/dots-manifest.json). Generalized display geometry does not establish job-address or employer evidence. |

No Google tile URL is used. A Google map integration must use the official
licensed SDK/API, project restrictions and billing/quota configuration. An
ordinary official Google Maps URL for a chosen coordinate/address is a separate
external navigation action, and does not grant rights to load Google's tiles
into MapLibre.

Map providers see the map-view requests needed for their service. The renderer
does not send the private home anchor as a separate geocoding request. Home
coordinates, lookup input and source evidence remain the consuming workspace's
responsibility.

## Verification scope

The actual generated style layer expressions passed the official
`@maplibre/maplibre-gl-style-spec@26.4.4` validator for global/domestic ×
light/dark × online/offline, eight configurations with no validation errors.
The Web TypeScript project and scoped ESLint passed. An isolated Vite production
build emitted all three GeoJSON assets and the 518,806-byte MapLibre worker as
separate hashed files. MapLibre remains a large lazily loaded chunk; these
results do not replace device/GPU, interaction, source-failure or visual
acceptance by the integrating workspace.
