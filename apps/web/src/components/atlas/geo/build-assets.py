"""Build pinned, local-only atlas boundaries. See NOTICE.md before using the shapes.

Python 3.11+, numpy 2.2.6, Shapely 2.1.2 / GEOS 3.13.1.
Only --download uses the network. Raw inputs belong in an ignored build cache.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen

import numpy
import shapely
from shapely.geometry import MultiPolygon, mapping, shape
from shapely.geometry.polygon import orient

COMMIT = "ca96624a56bd078437bca8184e78163e5039ad19"
REPOSITORY = "https://github.com/nvkelso/natural-earth-vector"
BASE_URL = f"https://raw.githubusercontent.com/nvkelso/natural-earth-vector/{COMMIT}/"
INPUTS = {
    "license": {"path": "LICENSE.md", "bytes": 4636, "sha256": "2631b5b39b6d1acc56de75235109b5af2dbb4b0ac5a127b6f06185977247fd4b"},
    "world": {"path": "geojson/ne_110m_admin_0_countries.geojson", "bytes": 838726, "sha256": "6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f"},
    "admin1": {"path": "geojson/ne_10m_admin_1_states_provinces.geojson", "bytes": 40726851, "sha256": "22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5"},
}
ROOT = Path(__file__).resolve().parent
SCOPE = {"CHN", "HKG", "MAC", "TWN"}
DISPLAY_GROUPS = {
    "HKG": ("CN-HK", "Hong Kong", "香港特别行政区"),
    "MAC": ("CN-MO", "Macao", "澳门特别行政区"),
    "TWN": ("CN-TW", "Taiwan", "台湾省"),
}
TOLERANCE = 0.02


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def encode(value: object, pretty: bool = False) -> bytes:
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2 if pretty else None,
                       separators=None if pretty else (",", ":")) + "\n").encode("utf-8")


def versions() -> dict:
    actual = {"numpy": numpy.__version__, "shapely": shapely.__version__, "geos": shapely.geos_version_string}
    if actual != {"numpy": "2.2.6", "shapely": "2.1.2", "geos": "3.13.1"}:
        raise ValueError(f"Use the pinned build toolchain for reproducibility: {actual!r}")
    return actual


def load_inputs(cache: Path, download: bool) -> dict[str, bytes]:
    result = {}
    for key, spec in INPUTS.items():
        target = cache / Path(spec["path"]).name
        if not target.is_file():
            if not download:
                raise ValueError(f"Missing pinned input {target}; use --download explicitly.")
            request = Request(BASE_URL + spec["path"], headers={"User-Agent": "BetterMe-atlas-asset-build/1"})
            with urlopen(request, timeout=60) as response:
                data = response.read(spec["bytes"] + 1)
            if len(data) != spec["bytes"] or digest(data) != spec["sha256"]:
                raise ValueError(f"Pinned upstream bytes did not match: {key}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        data = target.read_bytes()
        if len(data) != spec["bytes"] or digest(data) != spec["sha256"]:
            raise ValueError(f"Existing input changed; preserve and inspect it: {target}")
        result[key] = data
    return result


def polygons(geometry):
    if geometry.geom_type == "Polygon":
        return [geometry]
    if geometry.geom_type == "MultiPolygon":
        return list(geometry.geoms)
    raise ValueError(f"Unexpected geometry {geometry.geom_type}")


def normalized(geometry):
    """RFC 7946 planar winding; deterministic part order; no dropped components."""
    parts = [orient(part, sign=1.0) for part in polygons(geometry)]
    parts.sort(key=lambda part: (-part.area, part.bounds, part.wkb_hex))
    return MultiPolygon(parts) if geometry.geom_type == "MultiPolygon" else parts[0]


def geometry_counts(geometries) -> dict:
    return {
        "featureCount": len(geometries),
        "polygonCount": sum(len(polygons(item)) for item in geometries),
        "holeCount": sum(len(part.interiors) for item in geometries for part in polygons(item)),
        "coordinateCount": sum(int(shapely.get_num_coordinates(item)) for item in geometries),
    }


def signed_area(ring) -> float:
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2


def validate(collection: dict) -> dict:
    if collection.get("type") != "FeatureCollection" or not collection.get("features"):
        raise ValueError("A non-empty FeatureCollection is required.")
    ids = set()
    geometries = []
    for feature in collection["features"]:
        identifier = feature["id"]
        if identifier in ids or feature["properties"]["id"] != identifier:
            raise ValueError("Duplicate or inconsistent feature ID.")
        ids.add(identifier)
        geometry = feature["geometry"]
        ring_groups = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        for rings in ring_groups:
            for index, ring in enumerate(rings):
                if len(ring) < 4 or ring[0] != ring[-1]:
                    raise ValueError(f"Open or short ring in {identifier}")
                if len({tuple(point) for point in ring[:-1]}) < 3:
                    raise ValueError(f"Degenerate ring in {identifier}")
                for point in ring:
                    if len(point) != 2 or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in point):
                        raise ValueError("Non-finite or non-2D WGS84 coordinate.")
                    if not (-180 <= point[0] <= 180 and -90 <= point[1] <= 90):
                        raise ValueError(f"Coordinate out of WGS84 bounds: {identifier}")
                if (signed_area(ring) > 0) != (index == 0):
                    raise ValueError(f"Unexpected ring winding in {identifier}")
        built = shape(geometry)
        if built.is_empty or not built.is_valid:
            raise ValueError(f"Invalid geometry {identifier}: {shapely.is_valid_reason(built)}")
        label = feature["properties"]["labelPoint"]
        if len(label) != 2 or not all(math.isfinite(value) for value in label):
            raise ValueError(f"Invalid visual label point {identifier}")
        geometries.append(built)
    bounds = shapely.total_bounds(geometries).tolist()
    return {**geometry_counts(geometries), "validFeatureCount": len(geometries), "bounds": bounds,
            "ringClosure": "all-closed", "ringWinding": "outer-ccw-inner-cw", "coordinateSystem": "WGS84-longitude-latitude"}


def world_asset(raw: bytes) -> tuple[dict, dict]:
    source = json.loads(raw)
    features = []
    repairs = []
    original = []
    for feature in source["features"]:
        props = feature["properties"]
        identifier = props["ADM0_A3"]
        geometry = shape(feature["geometry"])
        original.append(geometry)
        if not geometry.is_valid:
            before = geometry
            reason = shapely.is_valid_reason(before)
            geometry = shapely.make_valid(before, method="structure", keep_collapsed=False)
            relative = abs(geometry.area - before.area) / before.area
            if relative > 1e-7:
                raise ValueError(f"Upstream repair changed too much area: {identifier}")
            repairs.append({"id": identifier, "reason": reason, "method": "make_valid(method=structure, keep_collapsed=false)",
                            "before": geometry_counts([before]), "after": geometry_counts([geometry]),
                            "beforePlanarAreaDegreesSquared": before.area, "afterPlanarAreaDegreesSquared": geometry.area,
                            "relativePlanarAreaChange": relative})
        geometry = normalized(geometry)
        country_code = props["ISO_A2_EH"]
        properties = {"id": identifier, "name": props["NAME_EN"] or props["NAME"], "nameZh": props["NAME_ZH"],
                      "countryCode": country_code if re.fullmatch("[A-Z]{2}", country_code) else None,
                      "sourceAdm0A3": identifier, "sourceIsoA2": props["ISO_A2"],
                      "labelPoint": [props["LABEL_X"], props["LABEL_Y"]]}
        features.append({"type": "Feature", "id": identifier, "properties": properties, "geometry": mapping(geometry)})
    features.sort(key=lambda feature: feature["id"])
    output = {"type": "FeatureCollection", "features": features}
    if len(features) != 177:
        raise ValueError("Pinned world source count changed.")
    return output, {"source": geometry_counts(original), "repairs": repairs, "additionalSimplification": "none",
                    "unmappedCountryFeatureIds": [feature["id"] for feature in features if feature["properties"]["countryCode"] is None],
                    "countryCodeMapping": "ISO_A2_EH matching two uppercase letters; XK is retained as upstream code; -99 becomes null"}


def china_asset(raw: bytes) -> tuple[dict, dict]:
    selected = [feature for feature in json.loads(raw)["features"] if feature["properties"].get("adm0_a3") in SCOPE]
    if len(selected) != 72:
        raise ValueError("Pinned admin1 source scope changed.")
    groups = defaultdict(list)
    for feature in selected:
        props = feature["properties"]
        admin = props["adm0_a3"]
        identifier = props["iso_3166_2"] if admin == "CHN" else DISPLAY_GROUPS[admin][0]
        if props["adm1_code"] == "PFA+00?":
            identifier = "CN-HI"
        if not re.fullmatch("CN-[A-Z]{2}", identifier):
            raise ValueError("An unreviewed display grouping was introduced.")
        groups[identifier].append(feature)
    keys = sorted(groups)
    if len(keys) != 34:
        raise ValueError("Expected 34 explicit display groups.")
    dissolved = [shapely.union_all([shape(feature["geometry"]) for feature in groups[key]]) for key in keys]
    if not all(item.is_valid for item in dissolved) or not shapely.coverage_is_valid(dissolved):
        raise ValueError("Source groups are not a valid shared-boundary coverage.")
    simplified = shapely.coverage_simplify(dissolved, TOLERANCE, simplify_boundary=False)
    if not shapely.coverage_is_valid(simplified):
        raise ValueError("Simplification broke coverage topology.")
    before_union = shapely.union_all(dissolved)
    after_union = shapely.union_all(simplified)
    if not before_union.equals(after_union):
        raise ValueError("Simplification changed the source coastline or outer boundary.")
    changes = []
    features = []
    for identifier, before, after in zip(keys, dissolved, simplified):
        if geometry_counts([before])["polygonCount"] != geometry_counts([after])["polygonCount"] or geometry_counts([before])["holeCount"] != geometry_counts([after])["holeCount"]:
            raise ValueError("Simplification removed a source component or hole.")
        relative = abs(after.area - before.area) / before.area
        if relative > 0.002:
            raise ValueError(f"Province planar area changed more than 0.2%: {identifier}")
        changes.append({"id": identifier, "relativePlanarAreaChange": relative})
        source_features = groups[identifier]
        source_admins = sorted({item["properties"]["adm0_a3"] for item in source_features})
        if source_admins[0] in DISPLAY_GROUPS:
            _, name, name_zh = DISPLAY_GROUPS[source_admins[0]]
        else:
            base = next(item["properties"] for item in source_features if item["properties"]["iso_3166_2"] == identifier)
            name, name_zh = base["name_en"] or base["name"], base["name_zh"]
        after = normalized(after)
        label = max(polygons(after), key=lambda part: part.area).representative_point()
        properties = {"id": identifier, "name": name, "nameZh": name_zh, "labelPoint": [label.x, label.y],
                      "sourceAdm1Codes": sorted(item["properties"]["adm1_code"] for item in source_features), "sourceAdm0A3": source_admins}
        features.append({"type": "Feature", "id": identifier, "properties": properties, "geometry": mapping(after)})
    return {"type": "FeatureCollection", "features": features}, {
        "selection": "adm0_a3 in CHN,HKG,MAC,TWN", "sourceScopeCounts": dict(sorted(Counter(item["properties"]["adm0_a3"] for item in selected).items())),
        "source": geometry_counts([shape(item["geometry"]) for item in selected]), "dissolved": geometry_counts(dissolved),
        "grouping": {"CHN": "Keep each CN-XX source ISO subdivision; PFA+00? (Paracel Islands) joins the CN-HI display group.",
                     "HKG": "Dissolve all 18 upstream units into CN-HK.", "MAC": "Map the one upstream unit to CN-MO.",
                     "TWN": "Dissolve all 21 upstream units into CN-TW.",
                     "labels": "Mainland names copied from source; CN-HK/CN-MO/CN-TW are explicit bilingual UI display labels.",
                     "domainBoundary": "Display grouping never assigns or rewrites a job countryCode, ownership jurisdiction, or location evidence."},
        "simplification": {"method": "shapely.coverage_simplify", "tolerance": TOLERANCE, "units": "source coordinate degrees; algorithm parameter, not a guaranteed metric displacement bound", "simplify_boundary": False,
                           "validCoverageBefore": True, "validCoverageAfter": True, "outerUnionTopologicallyEqual": True,
                           "outerUnionSymmetricDifferenceArea": before_union.symmetric_difference(after_union).area,
                           "sourceComponentsAndHolesPreservedAfterDissolve": True, "maximumRelativePlanarAreaChange": max(item["relativePlanarAreaChange"] for item in changes), "perFeatureAreaChanges": changes},
        "labelPointRule": "Interior representative point of largest polygon; visual labels only, never a job or home coordinate.",
        "knownScopeLimits": "Only source-covered islands are retained. This pinned subset has no complete South China Sea islands or claim-line layer and is not an official standard map.",
    }


def build(inputs: dict[str, bytes]) -> dict[str, bytes]:
    world, world_processing = world_asset(inputs["world"])
    china, china_processing = china_asset(inputs["admin1"])
    outputs = {}
    assets = []
    for name, collection, source_key, processing in [
        ("world-countries-110m.geojson", world, "world", world_processing),
        ("china-provinces-10m.geojson", china, "admin1", china_processing),
    ]:
        stats = validate(collection)
        data = encode(collection)
        outputs[name] = data
        assets.append({"file": name, "sourceKey": source_key, "sha256": digest(data), "bytes": len(data), "validation": stats, "processing": processing})
    license_file = "NATURAL-EARTH-LICENSE.md"
    outputs[license_file] = inputs["license"]
    manifest = {"schemaVersion": 1, "dataset": "BetterMe atlas overview boundaries", "upstream": {"repository": REPOSITORY, "commit": COMMIT, "commitDate": "2022-06-02T07:25:00Z", "license": "public-domain", "sources": {key: {**value, "url": BASE_URL + value["path"]} for key, value in INPUTS.items()}},
                "licenseFile": license_file, "build": {"script": "build-assets.py", "scriptSha256": digest(Path(__file__).read_bytes()), "pythonMinimum": "3.11", "toolchain": versions(), "coordinates": "WGS84 longitude,latitude; no GCJ-02/BD-09 conversion", "serialization": "UTF-8, compact JSON, one LF; RFC 7946 winding, deterministic feature and polygon ordering"},
                "limitations": ["Generalized overview boundaries, not survey, geocoding, location precision or evidence of employer ownership.", "Names, country codes and disputed boundaries are inherited source metadata, not canonical job facts.", "110m omits many small territories and islands; missing shape never means zero jobs or unsupported region.", "China display grouping is separate from job-country filters; retained source scope is not an official complete standard map."], "assets": assets}
    outputs["manifest.json"] = encode(manifest, pretty=True)
    return outputs


def verify_files() -> None:
    versions()
    manifest = json.loads((ROOT / "manifest.json").read_bytes())
    if manifest["build"]["scriptSha256"] != digest(Path(__file__).read_bytes()):
        raise ValueError("Builder changed after the manifest was produced.")
    license_data = (ROOT / manifest["licenseFile"]).read_bytes()
    if digest(license_data) != INPUTS["license"]["sha256"]:
        raise ValueError("Upstream license bytes changed.")
    for asset in manifest["assets"]:
        data = (ROOT / asset["file"]).read_bytes()
        if len(data) != asset["bytes"] or digest(data) != asset["sha256"]:
            raise ValueError(f"Output hash changed: {asset['file']}")
        if validate(json.loads(data)) != asset["validation"]:
            raise ValueError(f"Output geometry validation changed: {asset['file']}")
        print(json.dumps({"file": asset["file"], "sha256": asset["sha256"], **asset["validation"]}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-cache", type=Path, help="Dedicated ignored directory containing pinned upstream bytes.")
    parser.add_argument("--download", action="store_true", help="Fetch missing pinned upstream inputs; hash mismatches are never overwritten.")
    parser.add_argument("--check", action="store_true", help="Rebuild in memory and compare every committed output byte.")
    parser.add_argument("--verify", action="store_true", help="Verify local outputs and geometry without reading or fetching raw inputs.")
    args = parser.parse_args()
    versions()
    if args.verify:
        if args.download or args.check or args.source_cache:
            parser.error("--verify is an offline standalone operation.")
        verify_files()
        return
    if not args.source_cache:
        parser.error("--source-cache is required when building.")
    outputs = build(load_inputs(args.source_cache.resolve(), args.download))
    for name, data in outputs.items():
        target = ROOT / name
        if args.check:
            if not target.is_file() or target.read_bytes() != data:
                raise ValueError(f"Rebuild differs from committed bytes: {name}")
        else:
            target.write_bytes(data)
    verify_files()


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
