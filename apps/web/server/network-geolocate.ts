import dns from "node:dns";
import https from "node:https";
import os from "node:os";
import {
  requestMacosCoreLocation,
  type CoreLocationAuthStatus,
  type MacosCoreLocationResult,
} from "./macos-corelocation";
import {
  reverseGeocodeStreet,
  searchStreetLocations,
  type ReverseGeocodeResult,
  type StreetSearchCandidate,
} from "./street-geocoder";
import {
  discoverNearbyCompanies,
  type NearbyCompaniesResponse,
  type NearbyStreetHints,
} from "./nearby-companies";

export type NetworkGeolocateProvider = "corelocation" | "bilibili-ip" | "ipinfo";

export type NetworkGeolocateSuccess = {
  ok: true;
  source: "macos" | "ip";
  provider: NetworkGeolocateProvider;
  longitude: number;
  latitude: number;
  accuracyMeters: number;
  cityLabel: string;
  streetLabel?: string;
  countryCode: string;
  coreLocationStatus?: CoreLocationAuthStatus;
  timestamp: number;
};

export type NetworkGeolocateFailure = {
  ok: false;
  coreLocationStatus?: CoreLocationAuthStatus;
  error: string;
};

export type NetworkGeolocateResult = NetworkGeolocateSuccess | NetworkGeolocateFailure;

type ParsedProviderGeo = Omit<NetworkGeolocateSuccess, "ok" | "source" | "timestamp" | "streetLabel" | "coreLocationStatus">;

const VIRTUAL_INTERFACE_PATTERN =
  /^(lo|utun|tun|tap|wg|tailscale|bridge|awdl|llw|anpi|gif|stf|veth|docker|br-|vmnet|vboxnet|ppp|ipsec)/i;
const PREFERRED_PHYSICAL_INTERFACE_PATTERN = /^(en|eth|wlan|wl)/i;
const MAX_GEO_RESPONSE_BYTES = 64 * 1024;
const DIRECT_DNS_SERVERS = ["223.5.5.5", "119.29.29.29", "1.1.1.1"];

function interfacePriority(name: string, defaultInterface?: string): number {
  if (defaultInterface && name === defaultInterface) {
    return 0;
  }
  if (PREFERRED_PHYSICAL_INTERFACE_PATTERN.test(name)) {
    return 1;
  }
  return 2;
}

/**
 * Selects active non-virtual IPv4 addresses on physical interfaces so outbound
 * geolocation traffic bypasses OS-level TUN/VPN routes (such as Clash utun4).
 */
export function selectPhysicalIpv4Addresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
  defaultInterface?: string,
): string[] {
  const ranked: Array<{ address: string; priority: number; name: string }> = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries || VIRTUAL_INTERFACE_PATTERN.test(name)) {
      continue;
    }
    const priority = interfacePriority(name, defaultInterface);
    for (const entry of entries) {
      const family = String(entry.family);
      if (entry.internal || (family !== "IPv4" && family !== "4")) {
        continue;
      }
      if (isLinkLocalOrVirtualIpv4(entry.address)) {
        continue;
      }
      ranked.push({ address: entry.address, priority, name });
    }
  }

  ranked.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    return left.name.localeCompare(right.name);
  });

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of ranked) {
    if (!seen.has(item.address)) {
      seen.add(item.address);
      result.push(item.address);
    }
  }
  return result;
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    octets.push(value);
  }
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    return null;
  }
  return [a, b, c, d];
}

function isLinkLocalOrVirtualIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) {
    return true;
  }
  const [a, b] = octets;
  if (a === 0 || a === 127 || a >= 224) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  // 198.18.0.0/15 is used by Clash TUN / Fake-IP adapters
  if (a === 198 && (b === 18 || b === 19)) {
    return true;
  }
  return false;
}

/**
 * Returns true if an IPv4 address is non-public, link-local, or Clash Fake-IP
 * (198.18.0.0/15), meaning it cannot be used for direct physical-NIC HTTPS.
 */
export function isDisallowedPublicIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) {
    return true;
  }
  if (isLinkLocalOrVirtualIpv4(ip)) {
    return true;
  }
  const [a, b] = octets;
  if (a === 10) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  return false;
}

/**
 * Resolves a hostname to a public IPv4 address. Falls back to public domestic
 * resolvers bound to `localAddress` when OS DNS returns a Fake-IP (198.18/15).
 */
export async function resolveDirectHostIpv4(hostname: string, localAddress?: string): Promise<string> {
  try {
    const osResult = await dns.promises.lookup(hostname, { family: 4 });
    if (osResult?.address && !isDisallowedPublicIpv4(osResult.address)) {
      return osResult.address;
    }
  } catch {
    // Fall through to direct resolver when OS DNS is unavailable or intercepted.
  }

  const resolver = new dns.promises.Resolver({ timeout: 1_800, tries: 1 });
  resolver.setServers(DIRECT_DNS_SERVERS);
  if (localAddress) {
    try {
      resolver.setLocalAddress(localAddress);
    } catch {
      // Some platforms do not support binding UDP DNS to an IPv4 localAddress; continue without it.
    }
  }
  const addresses = await resolver.resolve4(hostname);
  const usable = addresses.find((address) => !isDisallowedPublicIpv4(address));
  if (!usable) {
    throw new Error(`No public IPv4 resolved for ${hostname}`);
  }
  return usable;
}

function isValidNonZeroCoordinate(longitude: unknown, latitude: unknown): { longitude: number; latitude: number } | null {
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
  return { longitude: lng, latitude: lat };
}

function normalizeLabelPart(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseBilibiliIpGeo(payload: unknown): ParsedProviderGeo | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as { code?: unknown; data?: Record<string, unknown> | null };
  if (record.code !== 0 || !record.data || typeof record.data !== "object") {
    return null;
  }
  const coords = isValidNonZeroCoordinate(record.data.longitude, record.data.latitude);
  if (!coords) {
    return null;
  }
  const city = normalizeLabelPart(record.data.city);
  const province = normalizeLabelPart(record.data.province);
  const country = normalizeLabelPart(record.data.country);
  const cityLabel = city || province || country || "当前城市";
  const countryCode = country === "中国" ? "CN" : country.toUpperCase();

  return {
    provider: "bilibili-ip",
    longitude: coords.longitude,
    latitude: coords.latitude,
    accuracyMeters: 5_000,
    cityLabel,
    countryCode,
  };
}

export function parseIpinfoGeo(payload: unknown): ParsedProviderGeo | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.loc !== "string") {
    return null;
  }
  const parts = record.loc.split(",");
  if (parts.length !== 2) {
    return null;
  }
  const coords = isValidNonZeroCoordinate(parts[1], parts[0]);
  if (!coords) {
    return null;
  }
  const city = normalizeLabelPart(record.city);
  const region = normalizeLabelPart(record.region);
  const country = normalizeLabelPart(record.country);

  return {
    provider: "ipinfo",
    longitude: coords.longitude,
    latitude: coords.latitude,
    accuracyMeters: 5_000,
    cityLabel: city || region || country || "当前城市",
    countryCode: country.toUpperCase(),
  };
}

type InterfaceJsonFetchOptions = {
  localAddress?: string;
  timeoutMs: number;
  resolveHost?: (hostname: string, localAddress?: string) => Promise<string>;
};

export function fetchJsonOverInterface(urlString: string, options: InterfaceJsonFetchOptions): Promise<unknown> {
  const parsed = new URL(urlString);
  const resolveHost = options.resolveHost ?? resolveDirectHostIpv4;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error !== null && error !== undefined) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } else {
        resolve(value);
      }
    };

    const request = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        family: 4,
        localAddress: options.localAddress,
        servername: parsed.hostname,
        timeout: options.timeoutMs,
        headers: {
          Accept: "application/json",
          "User-Agent": "BetterMe-Atlas/1.0",
        },
        lookup: (hostname, lookupOptions, callback) => {
          void resolveHost(hostname, options.localAddress).then(
            (address) => {
              if (lookupOptions && typeof lookupOptions === "object" && lookupOptions.all) {
                (callback as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void)(null, [
                  { address, family: 4 },
                ]);
                return;
              }
              (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
                null,
                address,
                4,
              );
            },
            (error: unknown) => {
              const err = (error instanceof Error ? error : new Error(String(error))) as NodeJS.ErrnoException;
              (callback as (err: NodeJS.ErrnoException | null, address?: unknown) => void)(err);
            },
          );
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          finish(new Error(`HTTP ${status} from ${parsed.hostname}`));
          return;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_GEO_RESPONSE_BYTES) {
            request.destroy(new Error(`Response exceeded ${MAX_GEO_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            finish(null, JSON.parse(raw));
          } catch (error) {
            finish(error);
          }
        });
        response.on("error", (error) => {
          finish(error);
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error(`Timed out after ${options.timeoutMs}ms`));
    });
    request.on("error", (error) => {
      finish(error);
    });
    request.end();
  });
}

type ProviderSpec = {
  id: NetworkGeolocateProvider;
  url: string;
  parse: (payload: unknown) => ParsedProviderGeo | null;
};

const PROVIDERS: ProviderSpec[] = [
  {
    id: "bilibili-ip",
    url: "https://api.live.bilibili.com/xlive/web-room/v1/index/getIpInfo",
    parse: parseBilibiliIpGeo,
  },
  {
    id: "ipinfo",
    url: "https://ipinfo.io/json",
    parse: parseIpinfoGeo,
  },
];

export type DetectHostNetworkLocationOptions = {
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  defaultInterface?: string;
  timeoutMs?: number;
  allowPrompt?: boolean;
  enableMacosCoreLocation?: boolean;
  macosLocate?: (opts: { allowPrompt?: boolean }) => Promise<MacosCoreLocationResult>;
  reverseGeocode?: (longitude: number, latitude: number) => Promise<ReverseGeocodeResult | null>;
  now?: () => number;
  fetchJson?: (url: string, options: { localAddress?: string; timeoutMs: number }) => Promise<unknown>;
};

/**
 * Resolves the host location with macOS native CoreLocation first (street/Wi-Fi accuracy)
 * when available, then falls back cleanly to physical-NIC IPv4 geolocation.
 */
export async function detectHostNetworkLocation(
  options: DetectHostNetworkLocationOptions = {},
): Promise<NetworkGeolocateResult> {
  const timeoutMs = options.timeoutMs ?? 3_500;
  const fetchJson = options.fetchJson ?? fetchJsonOverInterface;
  const now = options.now ?? Date.now;
  let coreLocationStatus: CoreLocationAuthStatus | undefined;

  const shouldTryMacos =
    typeof options.macosLocate === "function" ||
    (options.enableMacosCoreLocation !== false &&
      process.platform === "darwin" &&
      !options.interfaces &&
      !options.fetchJson &&
      process.env.BETTERME_DISABLE_CORELOCATION !== "1");

  if (shouldTryMacos) {
    try {
      const macosLocate = options.macosLocate ?? requestMacosCoreLocation;
      const macosResult = await macosLocate({ allowPrompt: options.allowPrompt });
      if (macosResult.ok) {
        const revFn = options.reverseGeocode ?? reverseGeocodeStreet;
        const reverse = await revFn(macosResult.longitude, macosResult.latitude).catch(() => null);
        return {
          ok: true,
          source: "macos",
          provider: "corelocation",
          longitude: macosResult.longitude,
          latitude: macosResult.latitude,
          accuracyMeters: macosResult.accuracyMeters,
          cityLabel: reverse?.cityLabel ?? "当前城市",
          ...(reverse?.streetLabel ? { streetLabel: reverse.streetLabel } : {}),
          countryCode: "CN",
          coreLocationStatus: "authorized",
          timestamp: now(),
        };
      }
      coreLocationStatus = macosResult.status;
    } catch {
      coreLocationStatus = "unavailable";
    }
  }

  const physicalAddresses = selectPhysicalIpv4Addresses(options.interfaces, options.defaultInterface);
  // If a physical NIC exists, restrict probes to those addresses so VPN/TUN exits never spoof the city.
  const addressCandidates: Array<string | undefined> =
    physicalAddresses.length > 0 ? physicalAddresses : [undefined];

  for (const localAddress of addressCandidates) {
    for (const provider of PROVIDERS) {
      try {
        const payload = await fetchJson(provider.url, { localAddress, timeoutMs });
        const parsed = provider.parse(payload);
        if (parsed) {
          return {
            ok: true,
            source: "ip",
            timestamp: now(),
            ...(coreLocationStatus ? { coreLocationStatus } : {}),
            ...parsed,
          };
        }
      } catch {
        // Try next provider or physical NIC candidate.
      }
    }
  }

  return {
    ok: false,
    ...(coreLocationStatus ? { coreLocationStatus } : {}),
    error: "当前本机直连网络无法获取位置，请通过上方搜索具体街道或「地图点选」标定位置。",
  };
}

export type LocalLocationRouteDeps = {
  geolocate?: (options?: { allowPrompt?: boolean }) => Promise<NetworkGeolocateResult>;
  reverseGeocode?: (longitude: number, latitude: number) => Promise<ReverseGeocodeResult | null>;
  searchLocations?: (query: string, cityHint?: string) => Promise<StreetSearchCandidate[]>;
  nearbyCompanies?: (
    longitude: number,
    latitude: number,
    options?: { radiusMeters?: number; streetHints?: NearbyStreetHints },
  ) => Promise<NearbyCompaniesResponse>;
};

export async function handleLocalLocationRoute(
  pathname: string,
  searchParams: URLSearchParams,
  method: string | undefined,
  deps: LocalLocationRouteDeps = {},
): Promise<{ status: number; body: unknown } | null> {
  if (pathname === "/api/network/geolocate") {
    if (method !== "GET") {
      return { status: 405, body: { error: "不支持的定位请求方法。" } };
    }
    const allowPrompt = searchParams.get("authorize") === "1";
    const run = deps.geolocate ?? detectHostNetworkLocation;
    const result = await run({ allowPrompt });
    return { status: result.ok ? 200 : 503, body: result };
  }

  if (pathname === "/api/network/reverse-geocode") {
    if (method !== "GET") {
      return { status: 405, body: { error: "不支持的逆地理编码请求方法。" } };
    }
    const lon = Number(searchParams.get("lon"));
    const lat = Number(searchParams.get("lat"));
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      return { status: 400, body: { ok: false, error: "经纬度参数无效。" } };
    }
    const rev = deps.reverseGeocode ?? reverseGeocodeStreet;
    const result = await rev(lon, lat);
    if (!result) {
      return { status: 200, body: { ok: false } };
    }
    return { status: 200, body: { ok: true, ...result } };
  }

  if (pathname === "/api/network/search-location") {
    if (method !== "GET") {
      return { status: 405, body: { error: "不支持的地点搜索请求方法。" } };
    }
    const q = searchParams.get("q")?.trim() ?? "";
    if (!q) {
      return { status: 400, body: { ok: false, error: "请输入街道、路名或地标。" } };
    }
    const cityHint = searchParams.get("city")?.trim() || undefined;
    const search = deps.searchLocations ?? ((query, hint) => searchStreetLocations(query, { cityHint: hint }));
    const candidates = await search(q, cityHint);
    return { status: 200, body: { ok: true, candidates } };
  }

  if (pathname === "/api/network/nearby-companies") {
    if (method !== "GET") {
      return { status: 405, body: { error: "不支持的周边企业查询请求方法。" } };
    }
    const lon = Number(searchParams.get("lon"));
    const lat = Number(searchParams.get("lat"));
    if (
      !Number.isFinite(lon)
      || !Number.isFinite(lat)
      || lon < -180
      || lon > 180
      || lat < -90
      || lat > 90
      || (Math.abs(lon) < 1e-6 && Math.abs(lat) < 1e-6)
    ) {
      return { status: 400, body: { ok: false, error: "经纬度参数无效。" } };
    }
    const rawRadius = Number(searchParams.get("radius") ?? "2500");
    const radiusMeters = Number.isFinite(rawRadius) ? Math.max(500, Math.min(5_000, Math.round(rawRadius))) : 2_500;
    const road = searchParams.get("road")?.trim() || undefined;
    const district = searchParams.get("district")?.trim() || undefined;
    const city = searchParams.get("city")?.trim() || undefined;
    const suburb = searchParams.get("suburb")?.trim() || undefined;
    const streetHints: NearbyStreetHints | undefined = (road || district || city || suburb)
      ? {
          ...(road ? { road } : {}),
          ...(district ? { district } : {}),
          ...(city ? { city } : {}),
          ...(suburb ? { suburb } : {}),
        }
      : undefined;
    const discover = deps.nearbyCompanies ?? discoverNearbyCompanies;
    const result = await discover(lon, lat, {
      radiusMeters,
      ...(streetHints ? { streetHints } : {}),
    });
    return { status: 200, body: result };
  }

  return null;
}
