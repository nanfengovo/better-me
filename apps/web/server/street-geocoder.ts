import { getNetworkFetch } from "./network-proxy";

export type ReverseGeocodeResult = {
  cityLabel: string;
  streetLabel: string;
  district?: string;
  subdistrict?: string;
  road?: string;
};

export type StreetSearchCandidate = {
  id: string;
  label: string;
  streetLabel: string;
  cityLabel: string;
  longitude: number;
  latitude: number;
};

export type GeocoderFetch = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_HEADERS = {
  Accept: "application/json",
  "User-Agent": "BetterMe-Atlas/1.0",
};

function cleanPart(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isValidCoordinatePair(longitude: unknown, latitude: unknown): { longitude: number; latitude: number } | null {
  const lng = typeof longitude === "number" ? longitude : typeof longitude === "string" ? Number(longitude.trim()) : NaN;
  const lat = typeof latitude === "number" ? latitude : typeof latitude === "string" ? Number(latitude.trim()) : NaN;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return null;
  }
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    return null;
  }
  if (Math.abs(lng) < 1e-6 && Math.abs(lat) < 1e-6) {
    return null;
  }
  return { longitude: Number(lng.toFixed(6)), latitude: Number(lat.toFixed(6)) };
}

function pushUniquePart(target: string[], candidate: string, allowSubstringMatch = false): void {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return;
  }
  const normalizedTrimmed = trimmed.replace(/\s+/g, "");
  for (const existing of target) {
    const normalizedExisting = existing.replace(/\s+/g, "");
    if (normalizedExisting === normalizedTrimmed) {
      return;
    }
    if (allowSubstringMatch && (normalizedExisting.includes(normalizedTrimmed) || normalizedTrimmed.includes(normalizedExisting))) {
      return;
    }
  }
  target.push(trimmed);
}

/**
 * Formats a concise Chinese street-level label such as "静安区 · 南京西路街道 · 南京西路 1266号".
 */
export function formatChineseStreetLabel(parts: {
  state?: unknown;
  city?: unknown;
  district?: unknown;
  subdistrict?: unknown;
  road?: unknown;
  houseNumber?: unknown;
  name?: unknown;
}): { cityLabel: string; streetLabel: string; district: string } {
  const state = cleanPart(parts.state);
  const city = cleanPart(parts.city);
  const district = cleanPart(parts.district);
  const subdistrict = cleanPart(parts.subdistrict);
  const road = cleanPart(parts.road);
  const houseNumber = cleanPart(parts.houseNumber);
  const name = cleanPart(parts.name);

  // In OSM China, municipalities often report state="上海市" and city="黄浦区" or "静安区".
  const isMunicipalityDistrictInCity = Boolean(state && city && city !== state && /(?:区|县|旗)$/.test(city));
  const resolvedCity = state && isMunicipalityDistrictInCity ? state : city || state;
  const resolvedDistrict = district || (isMunicipalityDistrictInCity ? city : "");

  const cityParts: string[] = [];
  if (resolvedCity) pushUniquePart(cityParts, resolvedCity);
  if (resolvedDistrict && resolvedDistrict !== resolvedCity) pushUniquePart(cityParts, resolvedDistrict);

  const roadWithNumber = road && houseNumber && !road.includes(houseNumber) ? `${road} ${houseNumber}` : road;
  const streetParts: string[] = [];
  if (resolvedDistrict) pushUniquePart(streetParts, resolvedDistrict);
  if (subdistrict && subdistrict !== resolvedDistrict) pushUniquePart(streetParts, subdistrict);
  if (roadWithNumber) pushUniquePart(streetParts, roadWithNumber);
  if (name) {
    pushUniquePart(streetParts, name, true);
  }

  if (streetParts.length === 0 && resolvedCity) {
    streetParts.push(resolvedCity);
  }

  return {
    cityLabel: cityParts.join(" · ") || "当前位置",
    streetLabel: streetParts.join(" · ") || cityParts.join(" · ") || "当前街道",
    district: resolvedDistrict,
  };
}

export function parseNominatimReverseResult(payload: unknown): ReverseGeocodeResult | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as {
    name?: unknown;
    display_name?: unknown;
    address?: Record<string, unknown> | null;
  };
  const addr = record.address && typeof record.address === "object" ? record.address : {};
  const state = cleanPart(addr.state) || cleanPart(addr.province);
  const city = cleanPart(addr.city);
  const district = cleanPart(addr.city_district) || cleanPart(addr.district) || cleanPart(addr.county) || cleanPart(addr.state_district);
  const subdistrict =
    cleanPart(addr.suburb) ||
    cleanPart(addr.town) ||
    cleanPart(addr.quarter) ||
    cleanPart(addr.neighbourhood) ||
    cleanPart(addr.residential);
  const road =
    cleanPart(addr.road) ||
    cleanPart(addr.pedestrian) ||
    cleanPart(addr.footway) ||
    cleanPart(addr.cycleway);
  const houseNumber = cleanPart(addr.house_number);
  const landmarkName = cleanPart(record.name);

  if (!state && !city && !district && !subdistrict && !road && !landmarkName) {
    return null;
  }

  const formatted = formatChineseStreetLabel({
    state,
    city,
    district,
    subdistrict,
    road,
    houseNumber,
    name: landmarkName,
  });

  return {
    cityLabel: formatted.cityLabel,
    streetLabel: formatted.streetLabel,
    ...(formatted.district ? { district: formatted.district } : {}),
    ...(subdistrict ? { subdistrict } : {}),
    ...(road ? { road } : {}),
  };
}

export function parsePhotonReverseResult(payload: unknown): ReverseGeocodeResult | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const features = (payload as { features?: unknown[] }).features;
  if (!Array.isArray(features) || features.length === 0) {
    return null;
  }
  const first = features[0] as { properties?: Record<string, unknown> } | undefined;
  const props = first?.properties;
  if (!props || typeof props !== "object") {
    return null;
  }
  const formatted = formatChineseStreetLabel({
    state: props.state,
    city: props.city,
    district: props.district,
    subdistrict: props.locality,
    road: props.street || (props.type === "street" ? props.name : ""),
    houseNumber: props.housenumber,
    name: props.name,
  });
  return {
    cityLabel: formatted.cityLabel,
    streetLabel: formatted.streetLabel,
  };
}

export function parseNominatimSearchResults(payload: unknown): StreetSearchCandidate[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const candidates: StreetSearchCandidate[] = [];
  for (let index = 0; index < payload.length; index++) {
    const item = payload[index] as {
      place_id?: unknown;
      lon?: unknown;
      lat?: unknown;
      name?: unknown;
      display_name?: unknown;
      address?: Record<string, unknown> | null;
    } | null;
    if (!item || typeof item !== "object") {
      continue;
    }
    const coords = isValidCoordinatePair(item.lon, item.lat);
    if (!coords) {
      continue;
    }
    const addr = item.address && typeof item.address === "object" ? item.address : {};
    const formatted = formatChineseStreetLabel({
      state: addr.state ?? addr.province,
      city: addr.city,
      district: addr.city_district ?? addr.district ?? addr.county ?? addr.state_district,
      subdistrict: addr.suburb ?? addr.town ?? addr.quarter ?? addr.neighbourhood,
      road: addr.road ?? addr.pedestrian,
      houseNumber: addr.house_number,
      name: item.name,
    });
    const displayName = cleanPart(item.display_name);
    candidates.push({
      id: `nom-${String(item.place_id ?? index)}`,
      label: displayName ? `${formatted.streetLabel}（${displayName.slice(0, 48)}）` : formatted.streetLabel,
      streetLabel: formatted.streetLabel,
      cityLabel: formatted.cityLabel,
      longitude: coords.longitude,
      latitude: coords.latitude,
    });
  }
  return candidates;
}

export function parsePhotonSearchResults(payload: unknown): StreetSearchCandidate[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const features = (payload as { features?: unknown[] }).features;
  if (!Array.isArray(features)) {
    return [];
  }
  const candidates: StreetSearchCandidate[] = [];
  for (let index = 0; index < features.length; index++) {
    const feature = features[index] as {
      geometry?: { coordinates?: unknown[] };
      properties?: Record<string, unknown>;
    } | null;
    const rawCoords = feature?.geometry?.coordinates;
    if (!Array.isArray(rawCoords) || rawCoords.length < 2) {
      continue;
    }
    const coords = isValidCoordinatePair(rawCoords[0], rawCoords[1]);
    if (!coords) {
      continue;
    }
    const props = feature?.properties ?? {};
    const formatted = formatChineseStreetLabel({
      state: props.state,
      city: props.city,
      district: props.district,
      subdistrict: props.locality,
      road: props.street || (props.type === "street" ? props.name : ""),
      houseNumber: props.housenumber,
      name: props.name,
    });
    candidates.push({
      id: `pho-${String(props.osm_id ?? index)}`,
      label: formatted.streetLabel !== formatted.cityLabel
        ? `${formatted.streetLabel}（${formatted.cityLabel}）`
        : formatted.streetLabel,
      streetLabel: formatted.streetLabel,
      cityLabel: formatted.cityLabel,
      longitude: coords.longitude,
      latitude: coords.latitude,
    });
  }
  return candidates;
}

async function fetchGeocoderJson(
  url: string,
  fetchImpl: GeocoderFetch,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: REQUEST_HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function reverseGeocodeStreet(
  longitude: number,
  latitude: number,
  options: { fetchImpl?: GeocoderFetch; timeoutMs?: number } = {},
): Promise<ReverseGeocodeResult | null> {
  const coords = isValidCoordinatePair(longitude, latitude);
  if (!coords) {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? (await getNetworkFetch());
  const timeoutMs = options.timeoutMs ?? 3_500;

  const nominatimUrl =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(String(coords.latitude))}` +
    `&lon=${encodeURIComponent(String(coords.longitude))}&zoom=18&addressdetails=1&accept-language=zh-CN`;
  const nominatimPayload = await fetchGeocoderJson(nominatimUrl, fetchImpl, timeoutMs);
  const nominatimParsed = parseNominatimReverseResult(nominatimPayload);
  if (nominatimParsed) {
    return nominatimParsed;
  }

  const photonUrl =
    `https://photon.komoot.io/reverse?lon=${encodeURIComponent(String(coords.longitude))}` +
    `&lat=${encodeURIComponent(String(coords.latitude))}`;
  const photonPayload = await fetchGeocoderJson(photonUrl, fetchImpl, timeoutMs);
  return parsePhotonReverseResult(photonPayload);
}

export async function searchStreetLocations(
  rawQuery: string,
  options: { cityHint?: string; fetchImpl?: GeocoderFetch; timeoutMs?: number } = {},
): Promise<StreetSearchCandidate[]> {
  const trimmed = rawQuery.trim().slice(0, 120);
  if (!trimmed) {
    return [];
  }
  const fetchImpl = options.fetchImpl ?? (await getNetworkFetch());
  const timeoutMs = options.timeoutMs ?? 4_000;
  const cityHint = options.cityHint?.trim() ?? "";

  const searchTerms: string[] = [];
  if (cityHint && !trimmed.includes(cityHint.replace(/市$/, ""))) {
    searchTerms.push(`${cityHint} ${trimmed}`);
  }
  searchTerms.push(trimmed);

  for (const term of searchTerms) {
    const nominatimUrl =
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(term)}` +
      `&format=jsonv2&addressdetails=1&limit=6&accept-language=zh-CN`;
    const payload = await fetchGeocoderJson(nominatimUrl, fetchImpl, timeoutMs);
    const parsed = parseNominatimSearchResults(payload);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  // Photon matches better when whitespace separates Chinese place segments
  const photonTerm = searchTerms[0] ?? trimmed;
  const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(photonTerm)}&limit=6`;
  const photonPayload = await fetchGeocoderJson(photonUrl, fetchImpl, timeoutMs);
  return parsePhotonSearchResults(photonPayload);
}
