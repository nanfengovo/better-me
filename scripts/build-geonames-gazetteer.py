"""Build reviewed local city shards from an explicitly selected GeoNames archive.

No network, address lookup or user data. Retain the original names, codes and point
coordinates; do not translate aliases or turn these points into office addresses.
"""
import argparse
import collections
import hashlib
import gzip
import io
import json
from pathlib import Path
import re
import zipfile

PINNED_SHA256 = "7d1c80d5be04850227384c1f6f9163b56401dc46270be1012e1a2de0a5bf4a70"
SOURCE_URL = "https://download.geonames.org/export/dump/cities15000.zip"


def serialized(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def build(archive_path, metadata_path, output, expected_sha256):
    data = archive_path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if len(data) > 16 * 1024 * 1024 or digest != expected_sha256:
        raise ValueError("Archive size or reviewed SHA-256 does not match")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata.get("url") != SOURCE_URL or metadata.get("sha256") != digest:
        raise ValueError("Download metadata does not describe this exact archive")
    with zipfile.ZipFile(archive_path) as archive:
        entry = archive.getinfo("cities15000.txt")
        if entry.file_size > 48 * 1024 * 1024:
            raise ValueError("Uncompressed city data exceeds review budget")
        text = archive.read(entry).decode("utf-8", errors="strict")
    version = "geonames-cities15000-" + digest[:16]
    countries = collections.defaultdict(list)
    identities = set()
    for line in text.splitlines():
        row = line.split("\t")
        if len(row) != 19 or row[6] != "P" or not re.fullmatch("[A-Z]{2}", row[8]):
            raise ValueError("Unexpected populated-place record")
        identity = "geonames." + row[0]
        if identity in identities:
            raise ValueError("Duplicate source place ID")
        identities.add(identity)
        latitude, longitude = float(row[4]), float(row[5])
        if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
            raise ValueError("Invalid WGS84 coordinate")
        aliases = list(dict.fromkeys(name for name in row[3].split(",") if name))
        alternate_codes = list(dict.fromkeys(code for code in row[9].split(",") if code))
        if any(not re.fullmatch("[A-Z]{2}", code) for code in alternate_codes):
            raise ValueError("Unexpected alternate country code")
        countries[row[8]].append({
            "id": identity, "name": row[1], "asciiName": row[2], "aliases": aliases,
            "sourceRecordUrl": "https://www.geonames.org/" + row[0] + "/",
            "countryCode": row[8], "alternateCountryCodes": alternate_codes,
            "administrativeCodes": {"admin" + str(index + 1): value for index, value in enumerate(row[10:14]) if value},
            "coordinates": {"latitude": latitude, "longitude": longitude, "coordinateSystem": "WGS84"},
            "featureCode": row[7], "population": int(row[14]), "sourceModifiedDate": row[18],
        })
    (output / "countries").mkdir(parents=True, exist_ok=True)
    shards = []
    for country, places in sorted(countries.items()):
        places.sort(key=lambda place: int(place["id"].split(".")[1]))
        body = serialized({"schemaVersion": 1, "datasetVersion": version, "countryCode": country, "places": places})
        if len(body) > 8 * 1024 * 1024:
            raise ValueError("Shard exceeds provider byte budget")
        buffer = io.BytesIO()
        with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0, compresslevel=9) as compressed_file:
            compressed_file.write(body)
        compressed = buffer.getvalue()
        (output / "countries" / (country + ".json.gz")).write_bytes(compressed)
        shards.append({"countryCode": country, "alternateCountryCodes": sorted(set(code for place in places for code in place["alternateCountryCodes"])),
                       "file": country + ".json.gz", "encoding": "gzip", "sha256": hashlib.sha256(compressed).hexdigest(), "bytes": len(compressed), "decodedBytes": len(body), "count": len(places)})
    manifest = {
        "schemaVersion": 1,
        "provenance": {
            "datasetId": "geonames-cities15000", "version": version, "sourceUrl": SOURCE_URL,
            "sourceArchiveSha256": digest, "retrievedAt": metadata["retrievedAt"],
            **({"sourceLastModified": metadata["lastModified"]} if metadata.get("lastModified") else {}),
            "license": "CC-BY-4.0", "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
            "attribution": "GeoNames geographical database, https://www.geonames.org/; transformed by BetterMe into country shards.",
            "coordinateSystem": "WGS84",
            "coverage": "GeoNames cities15000 snapshot: populated places with population > 15000 or capitals. Finite city-reference points, not all addresses/offices; country/admin codes and aliases retain source values.",
        },
        "recordCount": len(identities), "shards": shards,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"version": version, "places": len(identities), "countryShards": len(shards), "shardBytes": sum(shard["bytes"] for shard in shards)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("config/geography/gazetteer"))
    parser.add_argument("--sha256", default=PINNED_SHA256)
    arguments = parser.parse_args()
    build(arguments.archive, arguments.metadata, arguments.output, arguments.sha256)
