# Local atlas boundary assets

Read [NOTICE.md](NOTICE.md) for source, license and geographic scope. No runtime
map service, API key, token, remote tile server, Python or build-tool download is
needed to display these two committed GeoJSON files.

| Asset | Features | Polygon parts | Coordinates | Bytes | Local gzip estimate |
| --- | ---: | ---: | ---: | ---: | ---: |
| `world-countries-110m.geojson` | 177 | 290 | 10,659 | 276,625 | 110,724 |
| `china-provinces-10m.geojson` | 34 display groups | 113 | 25,465 | 585,038 | 216,405 |

The gzip numbers are local compression estimates, not measured production
transfer sizes. The files retain all output multipart geometry and holes. Exact
hashes, source IDs, repair details and validation are in [manifest.json](manifest.json).

## Consume from Vite without embedding data in the initial JavaScript

Load only the current view's asset. The `?url` suffix sends a static file through
Vite's asset pipeline and respects Pages' configured base path:

```ts
async function loadWorldBoundary() {
  const { default: url } = await import("./geo/world-countries-110m.geojson?url");
  const response = await fetch(url);
  if (!response.ok) throw new Error("World boundary asset unavailable");
  return response.json();
}

async function loadChinaBoundary() {
  const { default: url } = await import("./geo/china-provinces-10m.geojson?url");
  const response = await fetch(url);
  if (!response.ok) throw new Error("China boundary asset unavailable");
  return response.json();
}
```

The example is relative to a module in the parent `atlas/` directory. Both files
are ordinary GeoJSON `FeatureCollection`s. A feature has a stable string `id`,
matching `properties.id`, `name`, `nameZh` and a WGS84 `labelPoint`. World features
add `countryCode` from the source `ISO_A2_EH` when it is a two-letter code,
`sourceAdm0A3` and `sourceIsoA2`; unknown values stay `null`. `XK` is retained as an
upstream code, without declaring it a universal ISO assignment. China features
add constituent `sourceAdm1Codes[]` and `sourceAdm0A3[]` and carry **no job
country assignment**.

Render every polygon part. For Three.js, convert each part's first ring to a
`Shape`, put the other rings into `shape.holes`, and extrude all parts. Do not
select only `coordinates[0]` or discard small shapes. Camera bounds must include
all retained parts. Country/subdivision selection should publish IDs to the
shared query controller, while the renderer keeps no separate job database.

## Rebuild or audit

The following commands install geometry tools into an isolated ignored cache,
not into the application's Python or npm dependency tree. Run from repository
root with Python 3.11+ and a Shapely wheel supplying GEOS 3.13.1:

```powershell
$geoTools = ".agent-memory/.tmp/atlas-geo-build-tools"
$geoInputs = ".agent-memory/.tmp/atlas-geo-inputs"
python -m pip install --target $geoTools --only-binary=:all: `
  -r apps/web/src/components/atlas/geo/requirements-build.txt
$env:PYTHONPATH = (Resolve-Path -LiteralPath $geoTools).Path

# Explicit network use: fixed URLs and input SHA-256, once per missing raw file.
python apps/web/src/components/atlas/geo/build-assets.py --source-cache $geoInputs --download

# Rebuild in memory and compare all committed output bytes; no network.
python apps/web/src/components/atlas/geo/build-assets.py --source-cache $geoInputs --check

# Audit only committed output hashes, ring coordinates/winding and GEOS validity.
python apps/web/src/components/atlas/geo/build-assets.py --verify
```

The temporary `PYTHONPATH` setting affects geometry-build commands in this shell;
use a dedicated shell if it already has a custom Python environment. The builder
fails on a changed input hash, changed toolchain, unreviewed display grouping,
lost component/hole, invalid coverage, changed outer coastline, or province area
change above 0.2%. It never overwrites a mismatched cached upstream input.
`--check` additionally verifies byte-for-byte reproducibility. Tool versions are
build requirements, not browser runtime dependencies or a performance claim.

Renderer version research and runnable prototype outlines are in
[RENDERER-NOTES.md](RENDERER-NOTES.md). This asset delivery does not establish
completed 3D rendering, visual acceptance, GPU performance or map/list integration.
