import catalog from "../../../../../config/geography/china-administrative/catalog.json";
import manifest from "../../../../../config/geography/china-administrative/source-manifest.json";
import textAliases from "../../../../../config/geography/china-administrative/text-aliases.json";

type RegionNode = { code: string; name: string; children?: readonly RegionNode[] };
export type ChinaRegionSelection = { provinceCode?: string; cityCode?: string; districtCode?: string };
export type ChinaRegionOption = {
  code: string;
  /** Unchanged upstream name; municipality/group labels are separate. */
  name: string;
  label: string;
  level: "province" | "city" | "district" | "township";
  isGrouping: boolean;
  catalogAvailable: boolean;
  mapId?: string;
};
export type ResolvedChinaRegionSelection = {
  selection: ChinaRegionSelection;
  selectedProvince?: ChinaRegionOption;
  selectedCity?: ChinaRegionOption;
  selectedDistrict?: ChinaRegionOption;
};
export type ChinaRegionFilter = Omit<ResolvedChinaRegionSelection, "selection"> & {
  workCountryCodes: Array<"CN" | "HK" | "MO" | "TW">;
  workRegionGroups: string[][];
  /** Broad OR interests for acquisition; final queries still enforce all level groups. */
  sourceRegions: string[];
};

const provinces: readonly RegionNode[] = catalog;
const mapIds: Readonly<Record<string, string>> = manifest.provinceMapIds;
const supplementalRegions: ReadonlyArray<{ code: "HK" | "MO" | "TW"; name: string; mapId: string }> = [
  { code: "HK", name: "香港", mapId: "CN-HK" }, { code: "MO", name: "澳门", mapId: "CN-MO" }, { code: "TW", name: "台湾", mapId: "CN-TW" },
];
const municipalities = new Set(["11", "12", "31", "50"]);
const isGrouping = (node: RegionNode) => node.name === "市辖区" || node.name === "县" || node.name.endsWith("直辖县级行政区划");
const unique = (values: readonly string[]) => [...new Set(values.filter(Boolean))];
const shortName = (name: string) => name.replace(/(?:省|市|区|县)$/, "");
const autonomousAliases: Readonly<Record<string, string>> = { "15": "内蒙古", "45": "广西", "54": "西藏", "64": "宁夏", "65": "新疆" };
const allNamedNodes = provinces.flatMap((province) => [
  { provinceCode: province.code, cityCode: undefined as string | undefined, node: province },
  ...(province.children ?? []).flatMap((city) => [
    { provinceCode: province.code, cityCode: city.code, node: city },
    ...(city.children ?? []).map((node) => ({ provinceCode: province.code, cityCode: city.code, node })),
  ]),
]).filter(({ node }) => !isGrouping(node));
const cityAliasCache = new Map<string, readonly string[]>();
// This finite reference configuration never rewrites a source location or supplies coordinates.
if (textAliases.schemaVersion !== 1 || textAliases.catalogDatasetId !== manifest.datasetId
  || new Set(textAliases.provinces.map(({ code }) => code)).size !== textAliases.provinces.length
  || new Set(textAliases.cities.map(({ code }) => code)).size !== textAliases.cities.length
  || textAliases.provinces.some((entry) => !provinces.some((province) => province.code === entry.code && province.name === entry.name))
  || textAliases.cities.some((entry) => !provinces.some((province) => province.code === entry.provinceCode
    && province.children?.some((city) => city.code === entry.code && city.name === entry.name)))) throw new Error("Chinese location text aliases do not match the pinned administrative catalog.");
const provinceTextAliases = new Map(textAliases.provinces.map(({ code, aliases }) => [code, aliases]));
const cityTextAliases = new Map(textAliases.cities.map((entry) => [entry.code, entry]));
const normalizeAlias = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
const hasAlias = (value: string, term: string) => {
  const normalized = normalizeAlias(value), alias = normalizeAlias(term);
  if (!/[a-z]/u.test(alias)) return normalized.includes(alias);
  // The reference matcher must not read Hangzhou inside Changzhou or Xi'an inside Xi'anmen.
  let offset = normalized.indexOf(alias);
  while (offset >= 0) {
    if (!/[a-z]/u.test(normalized[offset - 1] ?? "") && !/[a-z]/u.test(normalized[offset + alias.length] ?? "")) return true;
    offset = normalized.indexOf(alias, offset + 1);
  }
  return false;
};

function option(node: RegionNode, level: ChinaRegionOption["level"], province?: RegionNode): ChinaRegionOption {
  const grouping = isGrouping(node);
  const label = level === "city" && province && municipalities.has(province.code)
    ? (province.children?.length === 1 ? province.name : `${province.name} · ${node.name}`)
    : level === "township" ? `${node.name}（镇街／功能区）` : node.name;
  return { code: node.code, name: node.name, label, level, isGrouping: grouping, catalogAvailable: true,
    ...(level === "province" && mapIds[node.code] ? { mapId: mapIds[node.code] } : {}) };
}

export function getChinaProvinces(): ChinaRegionOption[] {
  return [...provinces.map((node) => option(node, "province")), ...supplementalRegions.map(({ code, name, mapId }) => ({
    code, name, mapId, label: `${name}（仅地区，暂无下级目录）`, level: "province" as const, isGrouping: false, catalogAvailable: false,
  }))];
}
export function findChinaProvinceByMapId(id: string): ChinaRegionOption | undefined {
  return getChinaProvinces().find((node) => node.mapId === id);
}
export function getChinaCities(provinceCode?: string): ChinaRegionOption[] {
  const province = provinces.find((node) => node.code === provinceCode);
  return (province?.children ?? []).map((node) => option(node, "city", province));
}
export function getChinaDistricts(provinceCode?: string, cityCode?: string): ChinaRegionOption[] {
  const province = provinces.find((node) => node.code === provinceCode);
  const city = province?.children?.find((node) => node.code === cityCode);
  return (city?.children ?? []).map((node) => option(node, node.code.length === 9 ? "township" : "district"));
}
/** Returns reference children only. The parent must exist in this snapshot. */
export function getChinaRegionChildren(parentCode?: string): ChinaRegionOption[] {
  if (!parentCode) return getChinaProvinces();
  const province = provinces.find((node) => node.code === parentCode || node.children?.some((city) => city.code === parentCode));
  return province?.code === parentCode ? getChinaCities(parentCode) : province ? getChinaDistricts(province.code, parentCode) : [];
}

/** A stale child never survives a changed/unknown parent, even when its code exists elsewhere. */
export function resolveChinaRegionSelection(input: ChinaRegionSelection = {}): ResolvedChinaRegionSelection {
  const selectedProvince = getChinaProvinces().find((node) => node.code === input.provinceCode);
  if (!selectedProvince) return { selection: {} };
  const selectedCity = getChinaCities(selectedProvince.code).find((node) => node.code === input.cityCode);
  if (!selectedCity) return { selection: { provinceCode: selectedProvince.code }, selectedProvince };
  const selectedDistrict = getChinaDistricts(selectedProvince.code, selectedCity.code).find((node) => node.code === input.districtCode);
  return { selection: { provinceCode: selectedProvince.code, cityCode: selectedCity.code, ...(selectedDistrict ? { districtCode: selectedDistrict.code } : {}) },
    selectedProvince, selectedCity, ...(selectedDistrict ? { selectedDistrict } : {}) };
}

function cityNames(province: RegionNode, city: RegionNode, forProvinceExpansion = false): string[] {
  const cacheKey = `${city.code}:${forProvinceExpansion}`;
  const cached = cityAliasCache.get(cacheKey);
  if (cached) return [...cached];
  if (municipalities.has(province.code)) {
    // Chongqing's two statistical groups must not both mean every place in Chongqing.
    return province.children!.length > 1 ? (city.children ?? []).map((child) => child.name) : unique([province.name, shortName(province.name), ...(provinceTextAliases.get(province.code) ?? [])]);
  }
  if (isGrouping(city)) return (city.children ?? []).flatMap((child) => cityNames(province, child, forProvinceExpansion));
  const short = city.name.endsWith("市") ? shortName(city.name) : city.name;
  // Literal substring filters cannot disambiguate e.g. 辽宁朝阳市 from 北京朝阳区.
  const ambiguous = short !== city.name && allNamedNodes.some(({ node, cityCode }) => node.code !== city.code && cityCode !== city.code && node.name.includes(short));
  const translated = cityTextAliases.get(city.code);
  const names = unique([city.name, ...(!ambiguous && short.length >= 2 ? [short] : []), ...(translated?.aliases ?? []),
    ...(forProvinceExpansion ? [] : translated?.parentRequiredAliases ?? [])]);
  cityAliasCache.set(cacheKey, names);
  return [...names];
}
function provinceNames(province: RegionNode): string[] {
  const short = autonomousAliases[province.code] ?? shortName(province.name);
  const ambiguous = allNamedNodes.some(({ node, provinceCode }) => provinceCode !== province.code && node.name.includes(short));
  return unique([province.name, mapIds[province.code] ?? "", ...(!ambiguous ? [short] : []), ...(provinceTextAliases.get(province.code) ?? [])]);
}

/** Directory aliases select disclosed text only; they do not populate job location fields. */
export function buildChinaRegionFilter(input: ChinaRegionSelection = {}): ChinaRegionFilter {
  const { selectedProvince, selectedCity, selectedDistrict } = resolveChinaRegionSelection(input);
  if (!selectedProvince) return { workCountryCodes: [], workRegionGroups: [], sourceRegions: [] };
  const supplemental = supplementalRegions.find((node) => node.code === selectedProvince.code);
  if (supplemental) return { workCountryCodes: [supplemental.code], workRegionGroups: [], sourceRegions: [supplemental.code], selectedProvince };
  const province = provinces.find((node) => node.code === selectedProvince.code)!;
  const city = province.children?.find((node) => node.code === selectedCity?.code);
  const cityTerms = (province.children ?? []).map((node) => cityNames(province, node, true));
  // A municipality's district names alone cannot establish its province (e.g. 宁波 also has 江北区).
  const workRegionGroups = [unique([...provinceNames(province), ...(municipalities.has(province.code) ? [] : cityTerms.flat())])];
  if (city) workRegionGroups.push(cityNames(province, city));
  if (selectedDistrict) workRegionGroups.push([selectedDistrict.name]);
  const sourceCities = (province.children ?? []).flatMap((node) => isGrouping(node) && !municipalities.has(province.code) ? node.children ?? [] : [node]);
  const sourceRegions = selectedDistrict ? [selectedDistrict.name] : city ? cityNames(province, city)
    : municipalities.has(province.code) ? provinceNames(province)
    : unique([...provinceNames(province), ...sourceCities.flatMap((node) => cityNames(province, node))]);
  return { workCountryCodes: ["CN"], workRegionGroups, sourceRegions, selectedProvince,
    ...(selectedCity ? { selectedCity } : {}), ...(selectedDistrict ? { selectedDistrict } : {}) };
}

export type DisclosedChinaLocation = { countryCode?: string; raw?: string; city?: string; region?: string; regionId?: string };
export type DisclosedChinaCityMatch = {
  province: ChinaRegionOption;
  city: ChinaRegionOption;
  matchedField: "city" | "raw" | "region";
  matchedText: string;
  method: "disclosed-text-catalog-reference";
};
/** Reference matches remain separate from the location. A district alone never supplies a city. */
export function matchDisclosedChinaCities(location: DisclosedChinaLocation): DisclosedChinaCityMatch[] {
  if (location.countryCode !== "CN") return [];
  const matches: DisclosedChinaCityMatch[] = [];
  const disclosedFields = [location.city, location.raw, location.region, location.regionId].filter((value): value is string => Boolean(value));
  for (const province of provinces) {
    const hasParent = disclosedFields.some((field) => provinceNames(province).some((term) => hasAlias(field, term)));
    for (const city of province.children ?? []) {
      const municipality = municipalities.has(province.code);
      if (municipality && province.children!.length > 1 && ![location.city, location.raw, location.region].some((field) =>
        field && cityNames(province, city).some((district) => field.normalize("NFKC").includes(district)))) continue;
      const translated = cityTextAliases.get(city.code);
      const terms = municipality ? unique([province.name, shortName(province.name), ...(provinceTextAliases.get(province.code) ?? [])])
        : unique([...cityNames(province, city, true), ...(hasParent ? translated?.parentRequiredAliases ?? [] : [])]);
      for (const field of ["city", "raw", "region"] as const) {
        const disclosed = location[field]?.normalize("NFKC");
        if (!disclosed) continue;
        const matchedText = terms.find((term) => hasAlias(disclosed, term));
        if (!matchedText) continue;
        matches.push({ province: option(province, "province"), city: option(city, "city", province), matchedField: field, matchedText, method: "disclosed-text-catalog-reference" });
        break;
      }
    }
  }
  return matches;
}
