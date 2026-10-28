# Atlas boundary data notice

Made with Natural Earth. This folder contains derived overview data from
[nvkelso/natural-earth-vector](https://github.com/nvkelso/natural-earth-vector)
at commit `ca96624a56bd078437bca8184e78163e5039ad19` (2022-06-02).

Natural Earth's upstream license declares its vector and raster map data **public
domain**, including modification and electronic distribution for personal,
educational and commercial purposes. The primary authors are Tom Patterson and
Nathaniel Vaughn Kelso, with other contributors. The complete, unmodified upstream
license is retained in [NATURAL-EARTH-LICENSE.md](NATURAL-EARTH-LICENSE.md).
No texture, HDR, matcap, logo, boundary file or implementation from the dora demo
or any other map demo has been copied into these assets.

BetterMe's modifications are reproducible with [build-assets.py](build-assets.py).
[manifest.json](manifest.json) records each fixed raw URL, input/output SHA-256,
byte count, exact extraction/grouping rules, geometry repair and validation.

## Meaning and limits of the shapes

- `world-countries-110m.geojson` contains 177 upstream admin-0 map features at
  Natural Earth's generalized 1:110m overview scale. This number is a feature
  count, not a definition of how many countries exist. Many small territories
  and islands are absent. A region missing from the outline can still have jobs,
  a searchable list and geolocated points.
- `china-provinces-10m.geojson` derives 34 **display groups** from 72 upstream
  admin-1 features at the source's 1:10m scale: 31 mainland province-level units,
  the 18 Hong Kong units combined, Macao, and the 21 Taiwan units combined. The
  upstream `PFA+00?` Paracel Islands feature joins the `CN-HI` Hainan display group.
  All constituent source IDs remain in `sourceAdm1Codes` and `sourceAdm0A3`.
- These display IDs and labels do not assign or rewrite any job's `countryCode`,
  employer ownership, sovereignty, geocoding or source evidence. Country metadata
  and disputed boundaries reflect the pinned Natural Earth data. They are not
  evidence about a job or company, and they do not replace the product's explicit
  region-filter configuration.
- The China subset's bounds are approximately 73.602256°E–134.772579°E and
  15.775377°N–53.569444°N. It retains every polygon present in the selected source
  after the documented grouping, but the source lacks a complete South China Sea
  island/claim-line layer. **It is not an official complete standard map** or a
  survey-grade boundary product. Do not crop or conceal islands merely to fit
  the camera, and do not imply that absent geometry means an absent territory.
- Positions in these **two Natural Earth assets** are WGS84 `[longitude, latitude]`.
  They must not receive GCJ-02 or BD-09 conversion. `labelPoint` is for placing a
  visual region label; it is never an
  office, home, geocoding result or promised location accuracy. Generalization
  and topology checks are not geographic accuracy certification.

## DataV administrative detail assets and coordinate normalization

The following legacy detail files are separate from the pinned Natural Earth
dataset above. Their filenames containing `official` do **not** establish
official certification or survey accuracy:

| Local file | Corresponding DataV `areas_v3/bound` endpoint |
| --- | --- |
| `shanghai-official-boundary.geojson` | `310000.json` |
| `beijing-official-boundary.geojson` | `110000.json` |
| `tianjin-official-boundary.geojson` | `120000.json` |
| `chongqing-official-boundary.geojson` | `500000.json` |
| `shanghai-districts.geojson` | `310000_full.json` |
| `beijing-districts.geojson` | `110000_full.json` |
| `guangdong-cities.geojson` | `440000_full.json` |
| `jiangsu-cities.geojson` | `320000_full.json` |
| `zhejiang-cities.geojson` | `330000_full.json` |

Endpoint base: <https://geo.datav.aliyun.com/areas_v3/bound/>. An audit on
2026-10-28 found matching administrative codes, feature structures, and first
coordinates for these bundled files and the respective DataV responses. The
original download dates and versions are not recorded. The bundled Shanghai
geometry has 807 vertices versus 915 in the response examined on that date;
**it has not been replaced with the newer response**. No new boundary data,
coastline correction, or simplification is introduced by coordinate normalization.

[Alibaba DataV's map data documentation](https://help.aliyun.com/en/datav/datav-7-0/user-guide/map-data-format-1)
identifies its map data coordinate system as **GCJ-02**, while
[MapLibre LngLat](https://maplibre.org/maplibre-gl-js/docs/API/classes/LngLat/)
uses **WGS84 / EPSG:4326**. The nine detail assets and live DataV endpoint responses
are therefore explicitly normalized from GCJ-02 to WGS84 **once, on ingestion
into the in-memory display cache**. The original files remain unchanged.
Already-WGS84 input and Natural Earth fallback data pass through unchanged.
Multipart polygons, holes, ring closure, feature identifiers and non-coordinate
metadata are retained. DataV's `center` and `centroid` metadata are normalized too;
existing bounding boxes, when present, are recomputed from the output positions.

The normalization implements the public one-pass approximation from
[wandergis/coordtransform](https://github.com/wandergis/coordtransform/tree/606c6f3b57b6f1d60458793fea39928d2b11b637),
which is linked from the DataV documentation via its CLI. This adaptation keeps
its MIT license in [COORDTRANSFORM-LICENSE.md](COORDTRANSFORM-LICENSE.md).
The source applicability rectangle is an algorithm guard, not a territorial
definition. This public approximation has residual model error: there is **no
guaranteed survey accuracy**. The Shanghai regression vertex
`[121.153743, 31.276646]` changes to approximately
`[121.1491789473, 31.2785217292]`, removing an approximately 482-metre datum
mismatch at that sample; the test tolerance is a numerical regression threshold,
not a claim about actual geographic accuracy.

Administrative range boundaries are not coastline datasets: they may include
water, and their geometry/version/generalization can differ from the OSM basemap.
Residual differences must be investigated against documented source geometry,
not patched by snapping to the coast or translating a screen-space outline.
The Natural Earth public-domain notice above does not license these DataV assets.
Their historical redistribution/license provenance remains unrecorded and needs
an independent source audit before redistributing them as a boundary dataset.

## Recorded Natural Earth geometry changes

The world source has tiny self-intersections in `USA` and `SDN`. Only those two
features receive GEOS `make_valid(method="structure", keep_collapsed=False)`.
The relative changes in planar degree-squared area are about `4.46e-15` and
`1.00e-9`, respectively. Their disconnected components are retained; the whole
world still has its one source hole. The manifest includes exact counts, reasons,
coordinates and before/after areas. No extra world simplification is performed.

For China, unions remove boundaries within the explicit Hong Kong/Taiwan display
groups. The raw 72 units have 148 polygons and two holes; the dissolved 34 display
groups have 113 polygons and zero holes because the original interior spaces are
covered by other members of the same group. After dissolution, shared province
boundaries use GEOS coverage simplification with parameter `0.02` coordinate
degrees and `simplify_boundary=False`. The parameter is not a guaranteed distance
error in kilometres. All 113 polygons and all remaining holes are preserved.
The union before/after simplification is topologically equal, with zero symmetric
difference area; source coastlines and the subset's outer boundary are unchanged.
The largest province planar area change is about 0.151%. These checks concern the
processing operation, not the real-world correctness of the upstream borders.

The output uses closed, finite, two-dimensional coordinate rings with at least
three distinct vertices, counterclockwise exterior rings and clockwise holes.
All 211 output features pass per-feature GEOS validity checks. World boundaries
are generalized source outlines; they are not used as a point-in-country truth
service or as a global topology/coverage guarantee.

Keep this notice and the pinned license with redistributed copies. A suitable
visible map credit is **“Made with Natural Earth · 概略边界”**, linking to this
notice or its public documentation. Upstream does not require attribution; this
project retains it to make source and scope clear.
