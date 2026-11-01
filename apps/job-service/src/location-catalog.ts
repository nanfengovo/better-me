import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { LocationConfirmationProposalSchema, ResolvedLocationAreaSchema, resolveLegacyCountryCode, type LocationConfirmationProposal, type ResolvedLocationArea } from "@better-me/opportunities";

type Node = { code: string; name: string; children?: Node[] };
const node: z.ZodType<Node> = z.lazy(() => z.object({ code: z.string().regex(/^\d{2,9}$/), name: z.string().min(1), children: z.array(node).optional() }).strict());
let trusted: { countries: Set<string>; provinces: Node[]; datasetId: string; version: string; mapIds: Record<string, string> } | undefined;
function catalog() {
  if (trusted) return trusted;
  const manifest = JSON.parse(readFileSync(new URL("../../../config/geography/china-administrative/source-manifest.json", import.meta.url), "utf8")) as { datasetId: string; dataFileRevision: string; provinceMapIds: Record<string, string>; files: Array<{ file: string; sha256: string }> };
  const bytes = readFileSync(new URL("../../../config/geography/china-administrative/catalog.json", import.meta.url));
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.files.find(value => value.file === "catalog.json")?.sha256) throw new Error("invalid-location-catalog");
  const countries = z.object({ schemaVersion: z.literal(1), countries: z.array(z.string().regex(/^[A-Z]{2}$/)) }).passthrough().parse(JSON.parse(readFileSync(new URL("../../../config/geography/countries.json", import.meta.url), "utf8")));
  trusted = { countries: new Set(countries.countries), provinces: z.array(node).parse(JSON.parse(bytes.toString("utf8"))), datasetId: manifest.datasetId, version: manifest.dataFileRevision, mapIds: manifest.provinceMapIds };
  return trusted;
}
/** Trusted catalog lookup. Tool arguments select codes; they cannot supply names, provenance or coordinates. */
export function resolveLocationArea(input: LocationConfirmationProposal): ResolvedLocationArea {
  const proposal = LocationConfirmationProposalSchema.parse(input); const data = catalog();
  if (!data.countries.has(proposal.countryCode)) throw new Error("unknown-location-country");
  if (proposal.area.kind === "manual-area") {
    const { kind: _kind, ...labels } = proposal.area;
    return ResolvedLocationAreaSchema.parse({ countryCode: proposal.countryCode, kind: proposal.locationKind, ...labels, basis: { kind: "manual-area" } });
  }
  const { provinceCode, cityCode, districtCode } = proposal.area;
  const province = data.provinces.find(value => value.code === provinceCode);
  const city = cityCode ? province?.children?.find(value => value.code === cityCode) : undefined;
  const district = districtCode ? city?.children?.find(value => value.code === districtCode) : undefined;
  if (!province || cityCode && !city || districtCode && !district) throw new Error("invalid-location-catalog-path");
  const municipality = new Set(["11", "12", "31", "50"]).has(province.code);
  return ResolvedLocationAreaSchema.parse({ countryCode: "CN", kind: proposal.locationKind, region: province.name, regionId: data.mapIds[province.code],
    ...(city ? { city: municipality ? province.name : city.name } : {}), ...(district ? { district: district.name } : {}),
    basis: { kind: "china-catalog", datasetId: data.datasetId, version: data.version, provinceCode, ...(cityCode ? { cityCode } : {}), ...(districtCode ? { districtCode } : {}) } });
}

export type SourceNormalizationArea = { countryCode: string; region: string; regionId?: string; city?: string; aliases: readonly string[];
  regionAliases?: readonly string[]; parentRequiredAliases?: readonly string[] };
let normalizationAreas: readonly SourceNormalizationArea[] | undefined;
/** Public administrative labels only; no geocoding, coordinates or user data. */
export function listSourceNormalizationAreas(): readonly SourceNormalizationArea[] {
  if (normalizationAreas) return normalizationAreas;
  const data = catalog();
  // The same finite, pinned text aliases used by the browser filters. Do not
  // invent pinyin, translate arbitrary text or import search-intent parameters.
  const namesSchema = z.object({ code: z.string(), name: z.string(), aliases: z.array(z.string()) });
  const text = z.object({ schemaVersion: z.literal(1), catalogDatasetId: z.literal(data.datasetId),
    provinces: z.array(namesSchema), cities: z.array(namesSchema.extend({ provinceCode: z.string(), parentRequiredAliases: z.array(z.string()) })),
  }).parse(JSON.parse(readFileSync(new URL("../../../config/geography/china-administrative/text-aliases.json", import.meta.url), "utf8")));
  if (new Set(text.provinces.map(area => area.code)).size !== text.provinces.length
    || new Set(text.cities.map(area => area.code)).size !== text.cities.length
    || text.provinces.some(area => !data.provinces.some(province => province.code === area.code && province.name === area.name))
    || text.cities.some(area => !data.provinces.some(province => province.code === area.provinceCode
      && province.children?.some(city => city.code === area.code && city.name === area.name)))) throw new Error("invalid-location-text-aliases");
  const names = (name: string, aliases: readonly string[] = []) => [...new Set([name, name.replace(/[省市]$/u, ""), ...aliases])];
  normalizationAreas = data.provinces.filter(province => !["71", "81", "82"].includes(province.code)).flatMap(province => {
    const regionAliases = names(province.name, text.provinces.find(area => area.code === province.code)?.aliases);
    const base = { countryCode: "CN", region: province.name, regionId: data.mapIds[province.code], regionAliases };
    if (["11", "12", "31", "50"].includes(province.code)) return [{ ...base, city: province.name, aliases: regionAliases }];
    return [{ ...base, aliases: regionAliases }, ...(province.children ?? [])
      .filter(city => /市$/u.test(city.name) && !/直辖|市辖区/u.test(city.name))
      .map(city => { const translated = text.cities.find(area => area.code === city.code);
        return { ...base, city: city.name, aliases: names(city.name, translated?.aliases), parentRequiredAliases: translated?.parentRequiredAliases }; })];
  });
  return normalizationAreas;
}

const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
/** Match a disclosed English phrase as whole words, not Shanghai inside NewShanghai. */
export function hasLocationTextAlias(raw: string, alias: string): boolean {
  const value = normalized(raw), term = normalized(alias);
  if (!/[a-z]/u.test(term)) return value.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, "u").test(value);
}

let countryNames: Array<{ code: string; name: string }> | undefined;
/** An explicit different country/territory blocks inference from a Chinese city. */
export function hasConflictingSourceCountry(raw: string, expected: string): boolean {
  if (!countryNames) {
    const displays = [new Intl.DisplayNames(["en"], { type: "region" }), new Intl.DisplayNames(["zh"], { type: "region" })];
    countryNames = [...catalog().countries].flatMap(code => displays.map(display => ({ code, name: display.of(code) ?? code })));
  }
  // Mongolia inside Inner Mongolia is not a separate country disclosure.
  const text = raw.replace(/内蒙古|inner\s+mongolia|nei\s+mongol/giu, " ");
  if (countryNames.some(({ code, name }) => code !== expected && hasLocationTextAlias(text, name))) return true;
  return text.split(/[，,、;；/|()（）]+/u).some(part => {
    const code = resolveLegacyCountryCode(part) ?? (catalog().countries.has(part.trim().toUpperCase()) ? part.trim().toUpperCase() : undefined);
    return code !== undefined && code !== expected;
  });
}
