export type UserLocationPolygonFeature = {
  type: "Feature";
  properties: {
    kind: "accuracy";
    accuracyMeters: number;
  };
  geometry: {
    type: "Polygon";
    coordinates: [number, number][][];
  };
};

export type UserLocationPointFeature = {
  type: "Feature";
  properties: {
    kind: "point";
    accuracyMeters: number;
    heading: number | null;
    label: string;
  };
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
};

export type UserLocationFeature = UserLocationPolygonFeature | UserLocationPointFeature;

export type UserLocationFeatureCollection = {
  type: "FeatureCollection";
  features: UserLocationFeature[];
};

export type UserLocationSource = "browser" | "macos" | "ip" | "manual" | "search";

export type UserGeolocationFix = {
  longitude: number;
  latitude: number;
  accuracyMeters: number;
  heading: number | null;
  speedMps: number | null;
  timestamp: number;
  source?: UserLocationSource;
  placeLabel?: string;
  streetLabel?: string;
  district?: string;
  subdistrict?: string;
  road?: string;
  coreLocationStatus?: string;
};

export type UserLocationErrorCode = "unsupported" | "denied" | "unavailable" | "timeout";

export type UserLocationState =
  | { phase: "idle" }
  | { phase: "locating" }
  | { phase: "picking" }
  | { phase: "active"; fix: UserGeolocationFix }
  | { phase: "error"; code: UserLocationErrorCode; message: string };

export const EMPTY_USER_LOCATION_GEOJSON: UserLocationFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const EARTH_RADIUS_METERS = 6_378_137;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const VISUAL_ACCURACY_MIN_METERS = 12;
const VISUAL_ACCURACY_MAX_METERS = 5000;

export function isValidLngLat(longitude: number, latitude: number): boolean {
  return (
    Number.isFinite(longitude)
    && Number.isFinite(latitude)
    && longitude >= -180
    && longitude <= 180
    && latitude >= -90
    && latitude <= 90
  );
}

/** Build a geodesic WGS84 accuracy polygon ring representing real horizontal uncertainty in meters. */
export function buildAccuracyCircleRing(
  longitude: number,
  latitude: number,
  radiusMeters: number,
  steps = 64,
): [number, number][] {
  if (!isValidLngLat(longitude, latitude)) return [];
  const safeRadius = Math.max(
    VISUAL_ACCURACY_MIN_METERS,
    Math.min(VISUAL_ACCURACY_MAX_METERS, Number.isFinite(radiusMeters) ? radiusMeters : 100),
  );
  const safeSteps = Math.max(16, Math.min(128, Math.floor(steps)));
  const latRad = latitude * DEG_TO_RAD;
  const cosLat = Math.max(0.05, Math.cos(latRad));
  const dLat = (safeRadius / EARTH_RADIUS_METERS) * RAD_TO_DEG;
  const dLng = (safeRadius / (EARTH_RADIUS_METERS * cosLat)) * RAD_TO_DEG;

  const ring: [number, number][] = [];
  for (let index = 0; index <= safeSteps; index++) {
    const theta = (index / safeSteps) * Math.PI * 2;
    const lng = Math.max(-180, Math.min(180, longitude + dLng * Math.cos(theta)));
    const lat = Math.max(-85, Math.min(85, latitude + dLat * Math.sin(theta)));
    ring.push([Number(lng.toFixed(7)), Number(lat.toFixed(7))]);
  }
  return ring;
}

export function buildUserLocationGeoJson(fix: UserGeolocationFix | null): UserLocationFeatureCollection {
  if (!fix || !isValidLngLat(fix.longitude, fix.latitude)) {
    return EMPTY_USER_LOCATION_GEOJSON;
  }
  const manual = fix.source === "manual";
  const roundedAccuracy = manual ? 0 : Math.max(1, Math.round(Number.isFinite(fix.accuracyMeters) ? fix.accuracyMeters : 50));
  const ring = manual ? [] : buildAccuracyCircleRing(fix.longitude, fix.latitude, fix.accuracyMeters);
  const features: UserLocationFeature[] = [];
  if (ring.length >= 4) {
    features.push({
      type: "Feature",
      properties: {
        kind: "accuracy",
        accuracyMeters: roundedAccuracy,
      },
      geometry: {
        type: "Polygon",
        coordinates: [ring],
      },
    });
  }
  features.push({
    type: "Feature",
    properties: {
      kind: "point",
      accuracyMeters: roundedAccuracy,
      heading: fix.heading,
      label: `我的位置 · ${formatFixPrecisionLabel(fix)}`,
    },
    geometry: {
      type: "Point",
      coordinates: [fix.longitude, fix.latitude],
    },
  });
  return {
    type: "FeatureCollection",
    features,
  };
}

export function formatAccuracyLabel(accuracyMeters: number): string {
  if (!Number.isFinite(accuracyMeters) || accuracyMeters <= 0) return "浏览器定位";
  if (accuracyMeters >= 1000) return `±${(accuracyMeters / 1000).toFixed(1)}km`;
  return `±${Math.max(1, Math.round(accuracyMeters))}m`;
}

export function formatFixPrecisionLabel(
  fix: Pick<UserGeolocationFix, "accuracyMeters" | "source" | "placeLabel" | "streetLabel">,
): string {
  if (fix.source === "manual") {
    return fix.streetLabel ? `${fix.streetLabel} · 手动标点` : "手动标点";
  }
  if (fix.source === "search") {
    return fix.streetLabel ? `${fix.streetLabel} · 街道定位` : "街道定位";
  }
  const accuracy = formatAccuracyLabel(fix.accuracyMeters);
  if (fix.source === "ip") {
    return fix.placeLabel ? `网络定位 · ${fix.placeLabel} · ${accuracy}` : `网络定位 · ${accuracy}`;
  }
  if (fix.streetLabel) {
    return `${fix.streetLabel} · ${accuracy}`;
  }
  return accuracy;
}

export function haversineDistanceMeters(
  from: { longitude: number; latitude: number },
  to: { longitude: number; latitude: number },
): number | null {
  if (!isValidLngLat(from.longitude, from.latitude) || !isValidLngLat(to.longitude, to.latitude)) {
    return null;
  }
  const dLat = (to.latitude - from.latitude) * DEG_TO_RAD;
  const dLng = (to.longitude - from.longitude) * DEG_TO_RAD;
  const lat1 = from.latitude * DEG_TO_RAD;
  const lat2 = to.latitude * DEG_TO_RAD;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const a = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function formatDistanceLabel(distanceMeters: number): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return "";
  if (distanceMeters < 1000) return `${Math.round(distanceMeters)}m`;
  if (distanceMeters < 10_000) return `${(distanceMeters / 1000).toFixed(1)}km`;
  return `${Math.round(distanceMeters / 1000)}km`;
}

export function normalizeGeolocationPosition(position: {
  coords: {
    longitude: number;
    latitude: number;
    accuracy?: number | null;
    heading?: number | null;
    speed?: number | null;
  };
  timestamp?: number;
}): UserGeolocationFix | null {
  const { longitude, latitude, accuracy, heading, speed } = position.coords;
  if (!isValidLngLat(longitude, latitude)) return null;
  return {
    longitude,
    latitude,
    accuracyMeters: typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 50,
    heading: typeof heading === "number" && Number.isFinite(heading) && heading >= 0 && heading <= 360 ? heading : null,
    speedMps: typeof speed === "number" && Number.isFinite(speed) && speed >= 0 ? speed : null,
    timestamp: typeof position.timestamp === "number" && Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
    source: "browser",
  };
}

export const UNSUPPORTED_GEOLOCATION_MESSAGE =
  "当前浏览器环境不支持定位功能，可改用「地图点选」标定位置。";

export function describeGeolocationError(error: { code?: number; message?: string } | null | undefined): {
  code: UserLocationErrorCode;
  message: string;
} {
  switch (error?.code) {
    case 1:
      return { code: "denied", message: "未授权位置权限，请在浏览器地址栏允许定位，或改用「地图点选」。" };
    case 3:
      return { code: "timeout", message: "获取当前定位超时（代理或桌面环境常无法自动定位），可「地图点选」或重试。" };
    case 2:
    default:
      return { code: "unavailable", message: "当前无法获取浏览器定位信号，可「地图点选」或确认设备定位已开启。" };
  }
}

export type GeolocationRequestOptions = {
  highAccuracyTimeoutMs?: number;
  standardTimeoutMs?: number;
};

/**
 * Two-stage browser geolocation lookup:
 * 1. Try high-accuracy (allows recent 60s OS cache) within a bounded timeout.
 * 2. If unavailable or timed out (code 2/3), degrade once to standard/network
 *    accuracy with a longer cache window before reporting failure; permission
 *    denial (code 1) fails immediately without fallback.
 */
export function requestBrowserGeolocation(
  geo: Pick<Geolocation, "getCurrentPosition">,
  onSuccess: (fix: UserGeolocationFix) => void,
  onError: (error: { code?: number; message?: string }) => void,
  options: GeolocationRequestOptions = {},
): () => void {
  let cancelled = false;
  const highAccuracyTimeoutMs = options.highAccuracyTimeoutMs ?? 2_500;
  const standardTimeoutMs = options.standardTimeoutMs ?? 3_000;

  const tryStandardAccuracy = () => {
    if (cancelled) return;
    geo.getCurrentPosition(
      (position) => {
        if (cancelled) return;
        const fix = normalizeGeolocationPosition(position);
        if (fix) onSuccess(fix);
        else onError({ code: 2, message: "Invalid geolocation coordinates" });
      },
      (err) => {
        if (!cancelled) onError(err);
      },
      {
        enableHighAccuracy: false,
        timeout: standardTimeoutMs,
        maximumAge: 300_000,
      },
    );
  };

  geo.getCurrentPosition(
    (position) => {
      if (cancelled) return;
      const fix = normalizeGeolocationPosition(position);
      if (fix) onSuccess(fix);
      else tryStandardAccuracy();
    },
    (err) => {
      if (cancelled) return;
      if (err?.code === 1) {
        onError(err);
        return;
      }
      tryStandardAccuracy();
    },
    {
      enableHighAccuracy: true,
      timeout: highAccuracyTimeoutMs,
      maximumAge: 60_000,
    },
  );

  return () => {
    cancelled = true;
  };
}

export type FallbackGeolocationFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "json">>;

export type FallbackGeolocationOptions = {
  fetchImpl?: FallbackGeolocationFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  authorize?: boolean;
};

export type StreetSearchHit = {
  id: string;
  label: string;
  streetLabel: string;
  cityLabel: string;
  longitude: number;
  latitude: number;
};

export type NearbyCompanyKind = "company" | "research" | "park";

export type NearbyCompanyHit = {
  id: string;
  name: string;
  shortName: string;
  searchKeyword: string;
  kind: NearbyCompanyKind;
  longitude: number;
  latitude: number;
  distanceMeters: number;
  streetAddress?: string;
  ownershipLabel: string;
  ownershipColor: string;
  ownershipReason?: string;
  sourceTag?: "osm-map" | "street-web";
  /** Number of matching jobs already indexed in BetterMe's local dataset, if any. */
  indexedJobCount?: number;
};

export type NearbyCompaniesGeoJson = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    id: string;
    properties: {
      companyId: string;
      name: string;
      shortName: string;
      searchKeyword: string;
      kind: NearbyCompanyKind;
      distanceMeters: number;
      distanceText: string;
      streetAddress: string;
      ownershipLabel: string;
      ownershipColor: string;
      indexedJobCount: number;
      mapLabel: string;
      selected: boolean;
      sortKey: number;
    };
    geometry: {
      type: "Point";
      coordinates: [number, number];
    };
  }>;
};

export const EMPTY_NEARBY_COMPANIES_GEOJSON: NearbyCompaniesGeoJson = {
  type: "FeatureCollection",
  features: [],
};

function defaultFetchImpl(): FallbackGeolocationFetch | undefined {
  return typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
}

/**
 * Runs a bounded AbortController-managed GET JSON fetch for local location helpers.
 */
async function fetchLocalLocationJson(
  url: string,
  fetchImpl: FallbackGeolocationFetch | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ ok: boolean; payload: unknown } | null> {
  if (typeof fetchImpl !== "function" || signal?.aborted) {
    return null;
  }
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response) {
      return null;
    }
    const payload = await response.json();
    return { ok: Boolean(response.ok), payload };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Falls back to host-side geolocation (macOS CoreLocation street Wi-Fi positioning
 * first, then physical-NIC IPv4 geolocation) when browser geolocation fails/times out.
 * Never invoked when the user explicitly denies browser permission (code === 1).
 */
export async function requestNetworkFallbackGeolocation(
  fetchOrOptions: FallbackGeolocationFetch | FallbackGeolocationOptions | undefined = defaultFetchImpl(),
  signalArg?: AbortSignal,
  timeoutMsArg?: number,
): Promise<UserGeolocationFix | null> {
  const normalized: FallbackGeolocationOptions =
    typeof fetchOrOptions === "function" || fetchOrOptions === undefined
      ? { fetchImpl: fetchOrOptions ?? defaultFetchImpl(), signal: signalArg, timeoutMs: timeoutMsArg }
      : { fetchImpl: fetchOrOptions.fetchImpl ?? defaultFetchImpl(), ...fetchOrOptions };

  const authorize = Boolean(normalized.authorize);
  const timeoutMs = normalized.timeoutMs ?? (authorize ? 18_000 : 5_000);
  const endpoint = authorize ? "/api/network/geolocate?authorize=1" : "/api/network/geolocate";
  const result = await fetchLocalLocationJson(endpoint, normalized.fetchImpl, normalized.signal, timeoutMs);
  if (!result || !result.ok) {
    return null;
  }
  const payload = result.payload as {
    ok?: unknown;
    source?: unknown;
    longitude?: unknown;
    latitude?: unknown;
    accuracyMeters?: unknown;
    cityLabel?: unknown;
    streetLabel?: unknown;
    coreLocationStatus?: unknown;
    timestamp?: unknown;
  } | null;
  if (!payload || payload.ok !== true) {
    return null;
  }
  const longitude = typeof payload.longitude === "number" ? payload.longitude : Number(payload.longitude);
  const latitude = typeof payload.latitude === "number" ? payload.latitude : Number(payload.latitude);
  if (!isValidLngLat(longitude, latitude) || (Math.abs(longitude) < 1e-6 && Math.abs(latitude) < 1e-6)) {
    return null;
  }
  const source: UserLocationSource = payload.source === "macos" ? "macos" : "ip";
  const rawAccuracy = typeof payload.accuracyMeters === "number" ? payload.accuracyMeters : source === "macos" ? 50 : 5_000;
  const accuracyMeters =
    Number.isFinite(rawAccuracy) && rawAccuracy > 0
      ? Math.max(source === "macos" ? 5 : 500, rawAccuracy)
      : source === "macos"
        ? 50
        : 5_000;
  const cityLabel =
    typeof payload.cityLabel === "string" && payload.cityLabel.trim() ? payload.cityLabel.trim() : undefined;
  const streetLabel =
    source === "macos" && typeof payload.streetLabel === "string" && payload.streetLabel.trim()
      ? payload.streetLabel.trim()
      : undefined;
  const coreLocationStatus =
    typeof payload.coreLocationStatus === "string" && payload.coreLocationStatus.trim()
      ? payload.coreLocationStatus.trim()
      : undefined;
  const timestamp =
    typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp) ? payload.timestamp : Date.now();
  return {
    longitude,
    latitude,
    accuracyMeters,
    heading: null,
    speedMps: null,
    timestamp,
    source,
    ...(cityLabel ? { placeLabel: cityLabel } : {}),
    ...(streetLabel ? { streetLabel } : {}),
    ...(coreLocationStatus ? { coreLocationStatus } : {}),
  };
}

/**
 * Resolves exact Chinese street/road names for precise GPS, macOS, or manual-pin coordinates.
 */
export async function requestReverseGeocode(
  longitude: number,
  latitude: number,
  fetchImpl: FallbackGeolocationFetch | undefined = defaultFetchImpl(),
  signal?: AbortSignal,
  timeoutMs = 4_000,
): Promise<{
  cityLabel: string;
  streetLabel: string;
  district?: string;
  subdistrict?: string;
  road?: string;
} | null> {
  if (!isValidLngLat(longitude, latitude) || (Math.abs(longitude) < 1e-6 && Math.abs(latitude) < 1e-6)) {
    return null;
  }
  const url = `/api/network/reverse-geocode?lon=${encodeURIComponent(String(longitude))}&lat=${encodeURIComponent(String(latitude))}`;
  const result = await fetchLocalLocationJson(url, fetchImpl, signal, timeoutMs);
  if (!result || !result.ok || !result.payload || typeof result.payload !== "object") {
    return null;
  }
  const payload = result.payload as {
    ok?: unknown;
    cityLabel?: unknown;
    streetLabel?: unknown;
    district?: unknown;
    subdistrict?: unknown;
    road?: unknown;
  };
  if (payload.ok !== true || typeof payload.streetLabel !== "string" || !payload.streetLabel.trim()) {
    return null;
  }
  const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    cityLabel: opt(payload.cityLabel) ?? "",
    streetLabel: payload.streetLabel.trim(),
    ...(opt(payload.district) ? { district: opt(payload.district) } : {}),
    ...(opt(payload.subdistrict) ? { subdistrict: opt(payload.subdistrict) } : {}),
    ...(opt(payload.road) ? { road: opt(payload.road) } : {}),
  };
}

/**
 * Searches Chinese street addresses / landmarks / metro stations for street-level pin placement.
 */
export async function requestSearchLocation(
  query: string,
  cityHint?: string,
  fetchImpl: FallbackGeolocationFetch | undefined = defaultFetchImpl(),
  signal?: AbortSignal,
  timeoutMs = 5_000,
): Promise<StreetSearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const params = new URLSearchParams({ q: trimmed });
  if (cityHint?.trim()) {
    params.set("city", cityHint.trim());
  }
  const result = await fetchLocalLocationJson(`/api/network/search-location?${params.toString()}`, fetchImpl, signal, timeoutMs);
  if (!result || !result.ok || !result.payload || typeof result.payload !== "object") {
    return [];
  }
  const payload = result.payload as { ok?: unknown; candidates?: unknown };
  if (payload.ok !== true || !Array.isArray(payload.candidates)) {
    return [];
  }
  const valid: StreetSearchHit[] = [];
  for (const item of payload.candidates) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const lng = Number(record.longitude);
    const lat = Number(record.latitude);
    if (
      !isValidLngLat(lng, lat)
      || (Math.abs(lng) < 1e-6 && Math.abs(lat) < 1e-6)
      || typeof record.streetLabel !== "string"
      || !record.streetLabel.trim()
    ) {
      continue;
    }
    valid.push({
      id: typeof record.id === "string" ? record.id : `${lng},${lat}`,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : record.streetLabel.trim(),
      streetLabel: record.streetLabel.trim(),
      cityLabel: typeof record.cityLabel === "string" ? record.cityLabel.trim() : "",
      longitude: lng,
      latitude: lat,
    });
  }
  return valid;
}

/**
 * Fetches real surrounding companies, R&D centers, and office parks near a coordinate.
 */
export async function requestNearbyCompanies(
  longitude: number,
  latitude: number,
  radiusMeters = 2_500,
  fetchImpl: FallbackGeolocationFetch | undefined = defaultFetchImpl(),
  signal?: AbortSignal,
  timeoutMs = 9_500,
  streetHints?: { road?: string; district?: string; city?: string; suburb?: string },
): Promise<NearbyCompanyHit[]> {
  if (!isValidLngLat(longitude, latitude) || (Math.abs(longitude) < 1e-6 && Math.abs(latitude) < 1e-6)) {
    return [];
  }
  const safeRadius = Math.max(500, Math.min(5_000, Math.round(radiusMeters)));
  const extraParts: string[] = [];
  if (streetHints?.road?.trim()) extraParts.push(`road=${encodeURIComponent(streetHints.road.trim())}`);
  if (streetHints?.district?.trim()) extraParts.push(`district=${encodeURIComponent(streetHints.district.trim())}`);
  if (streetHints?.city?.trim()) extraParts.push(`city=${encodeURIComponent(streetHints.city.trim())}`);
  if (streetHints?.suburb?.trim()) extraParts.push(`suburb=${encodeURIComponent(streetHints.suburb.trim())}`);
  const url =
    `/api/network/nearby-companies?lon=${encodeURIComponent(String(longitude))}` +
    `&lat=${encodeURIComponent(String(latitude))}&radius=${safeRadius}` +
    (extraParts.length > 0 ? `&${extraParts.join("&")}` : "");
  const result = await fetchLocalLocationJson(url, fetchImpl, signal, timeoutMs);
  if (!result || !result.ok || !result.payload || typeof result.payload !== "object") {
    return [];
  }
  const payload = result.payload as { ok?: unknown; companies?: unknown };
  if (payload.ok !== true || !Array.isArray(payload.companies)) {
    return [];
  }
  const hits: NearbyCompanyHit[] = [];
  for (const raw of payload.companies) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const lng = Number(rec.longitude);
    const lat = Number(rec.latitude);
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name || !isValidLngLat(lng, lat) || (Math.abs(lng) < 1e-6 && Math.abs(lat) < 1e-6)) continue;
    const kind: NearbyCompanyKind = rec.kind === "research" ? "research" : rec.kind === "park" ? "park" : "company";
    const rawDist = Number(rec.distanceMeters);
    const distanceMeters = Number.isFinite(rawDist) && rawDist >= 0 ? Math.round(rawDist) : 0;
    hits.push({
      id: typeof rec.id === "string" && rec.id ? rec.id : `${lng},${lat}:${name}`,
      name,
      shortName: typeof rec.shortName === "string" && rec.shortName.trim() ? rec.shortName.trim() : name,
      searchKeyword: typeof rec.searchKeyword === "string" && rec.searchKeyword.trim() ? rec.searchKeyword.trim() : name,
      kind,
      longitude: lng,
      latitude: lat,
      distanceMeters,
      ...(typeof rec.streetAddress === "string" && rec.streetAddress.trim() ? { streetAddress: rec.streetAddress.trim() } : {}),
      ownershipLabel: typeof rec.ownershipLabel === "string" && rec.ownershipLabel.trim() ? rec.ownershipLabel.trim() : "企业实体",
      ownershipColor: typeof rec.ownershipColor === "string" && /^#[0-9a-fA-F]{6}$/.test(rec.ownershipColor)
        ? rec.ownershipColor
        : "#38BDF8",
      ...(typeof rec.ownershipReason === "string" && rec.ownershipReason.trim() ? { ownershipReason: rec.ownershipReason.trim() } : {}),
      ...(rec.sourceTag === "street-web" || rec.sourceTag === "osm-map" ? { sourceTag: rec.sourceTag } : {}),
      ...(typeof rec.indexedJobCount === "number" && Number.isFinite(rec.indexedJobCount) && rec.indexedJobCount > 0
        ? { indexedJobCount: Math.round(rec.indexedJobCount) }
        : {}),
    });
  }
  return hits;
}

export function buildNearbyCompaniesGeoJson(
  companies: readonly NearbyCompanyHit[],
  selectedCompanyId?: string,
): NearbyCompaniesGeoJson {
  if (!companies.length) return EMPTY_NEARBY_COMPANIES_GEOJSON;
  const features: NearbyCompaniesGeoJson["features"] = [];
  for (let index = 0; index < companies.length; index++) {
    const company = companies[index]!;
    if (!isValidLngLat(company.longitude, company.latitude)) continue;
    const distanceText = formatDistanceLabel(company.distanceMeters);
    const indexedJobCount = company.indexedJobCount ?? 0;
    const mapLabel = indexedJobCount > 0
      ? `${company.shortName} · ${indexedJobCount}岗 · ${distanceText}`
      : `${company.shortName} · ${distanceText}`;
    const selected = Boolean(selectedCompanyId && company.id === selectedCompanyId);
    features.push({
      type: "Feature",
      id: company.id,
      properties: {
        companyId: company.id,
        name: company.name,
        shortName: company.shortName,
        searchKeyword: company.searchKeyword,
        kind: company.kind,
        distanceMeters: company.distanceMeters,
        distanceText,
        streetAddress: company.streetAddress ?? "",
        ownershipLabel: company.ownershipLabel,
        ownershipColor: company.ownershipColor,
        indexedJobCount,
        mapLabel,
        selected,
        // Prioritize selected, in-index hiring firms, and closer employers in symbol collision checks
        sortKey: (selected ? -100_000 : 0) + (indexedJobCount > 0 ? -10_000 : 0) + company.distanceMeters + index,
      },
      geometry: {
        type: "Point",
        coordinates: [company.longitude, company.latitude],
      },
    });
  }
  return { type: "FeatureCollection", features };
}

export function createUserLocationMarker(
  doc: Document,
  fix: UserGeolocationFix,
  light: boolean,
  distanceToTargetMeters?: number | null,
): HTMLElement {
  const root = doc.createElement("div");
  root.className = `atlas-user-location-marker${light ? " light" : ""}${fix.source === "ip" ? " is-approximate" : ""}`;
  root.setAttribute("role", "status");

  const distanceText = distanceToTargetMeters !== undefined && distanceToTargetMeters !== null
    ? ` · 距选中 ${formatDistanceLabel(distanceToTargetMeters)}`
    : "";
  const precisionText = formatFixPrecisionLabel(fix);
  const sourceText =
    fix.source === "manual"
      ? "手动标点"
      : fix.source === "search"
        ? "街道定位"
        : fix.source === "macos"
          ? "系统精准定位"
          : fix.source === "ip"
            ? "网络定位"
            : "浏览器定位";
  const ariaPrecision =
    fix.source === "ip"
      ? fix.placeLabel
        ? `${fix.placeLabel} ${formatAccuracyLabel(fix.accuracyMeters)}`
        : formatAccuracyLabel(fix.accuracyMeters)
      : precisionText;
  root.setAttribute("aria-label", `我的当前位置（${sourceText} ${ariaPrecision}${distanceText}）`);

  const halo = doc.createElement("span");
  halo.className = "atlas-user-location-halo";
  root.append(halo);

  if (fix.heading !== null && Number.isFinite(fix.heading)) {
    const cone = doc.createElement("span");
    cone.className = "atlas-user-location-heading";
    cone.style.transform = `translate(-50%, -100%) rotate(${Math.round(fix.heading)}deg)`;
    root.append(cone);
  }

  const dot = doc.createElement("span");
  dot.className = "atlas-user-location-dot";
  root.append(dot);

  const tag = doc.createElement("span");
  tag.className = "atlas-user-location-tag";
  tag.textContent = `我的位置 · ${precisionText}${distanceText}`;
  root.append(tag);

  return root;
}
