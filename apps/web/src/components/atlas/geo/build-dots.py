"""Build a deterministic decorative land-dot mask from the pinned local Natural Earth asset.

Standard library only. These points decorate the globe; they are never job locations,
office coordinates or a replacement for the country geometry. No network access.
"""
from pathlib import Path
import hashlib
import json
import math

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "world-countries-110m.geojson"
STEP = 1.1


def contains(ring, x, y):
    inside = False
    previous = ring[-1]
    for current in ring:
        ax, ay = previous
        bx, by = current
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
        previous = current
    return inside


def build():
    raw = SOURCE.read_bytes()
    world = json.loads(raw)
    points = set()
    for feature in world["features"]:
        geometry = feature["geometry"]
        polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        for polygon in polygons:
            outer = polygon[0]
            min_x, max_x = min(p[0] for p in outer), max(p[0] for p in outer)
            min_y, max_y = max(-56, min(p[1] for p in outer)), min(83, max(p[1] for p in outer))
            for row in range(math.ceil(min_y / STEP), math.floor(max_y / STEP) + 1):
                lat = round(row * STEP, 6)
                lon_step = STEP / max(.15, math.cos(math.radians(lat)))
                for col in range(math.ceil(min_x / lon_step), math.floor(max_x / lon_step) + 1):
                    lon = round(col * lon_step, 6)
                    if contains(outer, lon, lat) and not any(contains(hole, lon, lat) for hole in polygon[1:]):
                        points.add((lon, lat))
    data = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"purpose": "decorative-land-mask"}, "geometry": {"type": "MultiPoint", "coordinates": sorted(points, key=lambda p: (p[1], p[0]))}}]}
    output = (json.dumps(data, separators=(",", ":")) + "\n").encode()
    target = ROOT / "world-land-dots.geojson"
    target.write_bytes(output)
    manifest = {"schemaVersion": 1, "purpose": "Decorative globe land mask, not job data", "source": SOURCE.name, "sourceSha256": hashlib.sha256(raw).hexdigest(), "license": "public-domain", "licenseFile": "NATURAL-EARTH-LICENSE.md", "noticeFile": "NOTICE.md", "script": "build-dots.py", "gridLatitudeDegrees": STEP, "longitudeSpacing": "latitude-adjusted for approximately equal surface density", "latitudeRange": [-56, 83], "file": target.name, "pointCount": len(points), "bytes": len(output), "sha256": hashlib.sha256(output).hexdigest()}
    (ROOT / "dots-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest))


if __name__ == "__main__":
    build()
