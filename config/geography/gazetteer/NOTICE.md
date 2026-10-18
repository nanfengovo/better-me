# GeoNames local city gazetteer

Contains data from [GeoNames](https://www.geonames.org/), licensed under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
The official license's complete HTML is retained as `LICENSE-CC-BY-4.0.html`;
the original dataset description and licensing statement are in `SOURCE-README.txt`.

Source: <https://download.geonames.org/export/dump/cities15000.zip>.
Downloaded 2026-10-18T13:58:09.120914+00:00; upstream Last-Modified:
`Sun, 18 Oct 2026 02:41:39 GMT`. The archive was 3,361,901 bytes.
Its SHA-256 is
`7d1c80d5be04850227384c1f6f9163b56401dc46270be1012e1a2de0a5bf4a70`.
This repository pins the content as `geonames-cities15000-7d1c80d5be048502`;
the upstream URL is mutable, so the archive hash must match before rebuilding.

Changes made by BetterMe: selected populated-place fields from the original TSV;
retained primary names, ASCII names, original alternate names, original country
and alternate-country codes, all nonempty admin1–admin4 codes, population, feature
code, WGS84 latitude/longitude and source modification date; removed exact duplicate
alternate names; added source-record URLs and stable IDs; split records by their
original country code; serialized UTF-8 JSON and compressed each shard with gzip.
No manual translations, city-specific lookup rules, coordinate conversions or
administrative boundary claims were added. `manifest.json` records each shard's
compressed SHA-256, compressed/decoded sizes and record count.

The snapshot contains **34,167 populated places in 244 country/region-code shards**.
The source describes cities15000 as population greater than 15,000 or capitals;
its approximate count in the upstream README is not the exact snapshot count.
This is a finite reference dataset and does not include every city, village,
street, employer office or historical name. GeoNames supplies the coordinates as
WGS84. They are representative city/populated-place points, not surveyed office
addresses; BetterMe always labels candidate coordinates `precision: city`,
`estimated: true`, `verification: unverified`.

GeoNames country and administrative codes are source facts. Admin1 codes are often
FIPS, as the original README explains; they are not automatically ISO subdivision
codes. Display groups and product market filters must be configured separately.
No code in this dataset should be treated as a political boundary or recoded
because a UI groups several regions together. Alternate country codes remain
available for explicit query scopes.

Place names and aliases can be ambiguous, outdated or erroneous. Population and
country bias may order candidates but never establish employer-location truth.
Every candidate requires explicit selection; the service does not infer an office
from a remote eligibility region or a company headquarters. No address is sent to
GeoNames or another external API during lookup.
