import type { GeocodingCandidate, JobLocation, JobSearchItem, LocationPrecision, OfficeAddressCandidate } from "@better-me/opportunities";

/** A camera request and its transient highlight, never a persisted geocoding result. */
export type AtlasMapFocus = {
  longitude: number;
  latitude: number;
  zoom?: number;
  requestId?: string;
  jobId?: string;
  locationId?: string;
  label?: string;
  locationLabel?: string;
  precision?: LocationPrecision;
  verification?: JobLocation["verification"];
  estimated?: boolean;
  positionBasis?: "city-reference" | "office-confirmation" | "geocoder-candidate";
  color?: string;
  /** Temporary screen offset supplied by the workspace to keep the pin beside its detail panel. */
  viewportOffset?: [number, number];
};

const precisionZoom: Record<LocationPrecision, number> = {
  country: 4.5, region: 7.5, city: 10.5, street: 14, address: 16.5, manual: 16, unknown: 10.5,
};

export function validMapFocus(target: AtlasMapFocus | undefined): target is AtlasMapFocus {
  return Boolean(target && Number.isFinite(target.longitude) && Number.isFinite(target.latitude)
    && Math.abs(target.longitude) <= 180 && Math.abs(target.latitude) <= 90);
}

/** A different selected job must not inherit the previous job's highlighted location. */
export function activeMapFocus(target: AtlasMapFocus | undefined, selectedJobId?: string): AtlasMapFocus | undefined {
  return validMapFocus(target) && (selectedJobId === undefined || !target.jobId || target.jobId === selectedJobId) ? target : undefined;
}

type FocusJob = Pick<JobSearchItem, "job" | "company" | "locations" | "color" | "mapReferences">;
type FocusOptions = {
  locationId?: string;
  /** An explicit candidate for this location; its reference point remains visibly estimated. */
  cityCandidate?: { locationId: string; candidate: GeocodingCandidate };
};

/** Source coordinates take priority. A separate city reference never changes the source location. */
export function createJobMapFocus(item: FocusJob, requestId: string, options: FocusOptions = {}): AtlasMapFocus | null {
  if (item.job.workMode === "remote") return null;
  const selectedLocationId = options.locationId ?? options.cityCandidate?.locationId;
  const locations = item.locations.filter((location) => location.kind !== "remote-region"
    && (!selectedLocationId || location.id === selectedLocationId));
  const location = locations.filter((entry) => entry.kind === "office" && entry.coordinates?.coordinateSystem === "WGS84"
    && entry.precision !== "unknown" && validMapFocus(entry.coordinates))
    .sort((left, right) => precisionZoom[right.precision] - precisionZoom[left.precision])[0];
  const common = { requestId, jobId: item.job.id, label: item.job.title.value,
    color: /^#[a-fA-F0-9]{6}$/.test(item.color.color) ? item.color.color : undefined };
  if (location?.coordinates) return {
    ...common, longitude: location.coordinates.longitude, latitude: location.coordinates.latitude,
    locationId: location.id, locationLabel: location.officeResolution?.formattedAddress ?? location.streetAddress ?? location.raw, precision: location.precision,
    verification: location.verification, estimated: ["country", "region", "city", "street"].includes(location.precision) || !!location.officeResolution,
    ...(location.officeResolution ? { positionBasis: "office-confirmation" as const } : {}),
    zoom: precisionZoom[location.precision],
  };
  const candidateInput = options.cityCandidate;
  if (!candidateInput) {
    const reference = item.mapReferences?.find(entry => entry.precision === "city" && entry.estimated === true
      && entry.coordinateMeaning === "populated-place-reference-point" && entry.coordinates.coordinateSystem === "WGS84" && validMapFocus(entry.coordinates)
      && locations.some(location => location.id === entry.locationId && !location.coordinates && location.countryCode === entry.countryCode && location.city === entry.label));
    if (!reference) return null;
    const source = locations.find(location => location.id === reference.locationId)!;
    return { ...common, longitude: reference.coordinates.longitude, latitude: reference.coordinates.latitude,
      locationId: reference.locationId, locationLabel: `${source.raw} · ${reference.label}`,
      precision: "city", verification: "unverified", estimated: true, positionBasis: "city-reference", zoom: 9 };
  }
  const candidateLocation = locations.find((entry) => entry.id === candidateInput.locationId);
  const { candidate } = candidateInput;
  if (!candidateLocation || candidateLocation.kind !== "office" || candidate.precision !== "city" || candidate.estimated !== true
    || candidate.coordinateMeaning !== "populated-place-reference-point" || candidate.verification !== "unverified"
    || candidate.place.coordinates.coordinateSystem !== "WGS84" || !validMapFocus(candidate.place.coordinates)
    || (candidateLocation.countryCode && candidateLocation.countryCode !== candidate.place.countryCode
      && !candidate.place.alternateCountryCodes.includes(candidateLocation.countryCode))) return null;
  return {
    ...common, longitude: candidate.place.coordinates.longitude, latitude: candidate.place.coordinates.latitude,
    locationId: candidateLocation.id, locationLabel: `${candidateLocation.raw} · ${candidate.place.name}`,
    precision: "city", verification: "unverified", estimated: true, zoom: precisionZoom.city,
  };
}

/** A geocoder proposal is a transient map preview until the person reviews and saves it. */
export function createOfficeCandidateMapFocus(jobId: string, jobLabel: string, location: JobLocation,
  candidate: OfficeAddressCandidate, requestId: string): AtlasMapFocus | null {
  const { proposal } = candidate;
  if (!jobId || location.kind !== "office" || location.evidence.length === 0 || candidate.estimated !== true
    || candidate.verification !== "unverified" || proposal.coordinates.coordinateSystem !== "WGS84"
    || (location.countryCode && location.countryCode !== proposal.countryCode) || !validMapFocus(proposal.coordinates)) return null;
  return { requestId, jobId, locationId: location.id, longitude: proposal.coordinates.longitude, latitude: proposal.coordinates.latitude,
    label: jobLabel || "办公地址候选", locationLabel: proposal.formattedAddress, precision: "address", verification: "unverified",
    estimated: true, positionBasis: "geocoder-candidate", zoom: precisionZoom.address };
}

export function mapFocusPrecisionLabel(target: AtlasMapFocus): string {
  const precision: Record<LocationPrecision, string> = {
    country: "国家级概略位置", region: "地区级概略位置", city: "城市级估算 · 非办公地址",
    street: "街道级估算 · 非精确办公地址", address: "地址级坐标", manual: "手动设置位置", unknown: "位置精度未说明",
  };
  const label = `${target.positionBasis === "city-reference" ? "城市分布参考 · " : target.positionBasis === "office-confirmation" ? "本人核对的办公位置 · " : target.positionBasis === "geocoder-candidate" ? "地址查询候选 · 估算位置 · 尚未保存 · " : ""}${precision[target.precision ?? "unknown"]}`;
  if (target.verification === "conflicting") return `${label} · 来源有冲突`;
  if (target.verification !== "verified") return `${label} · 待核实`;
  return label;
}

/** Limit the camera to the actual precision, even if a caller requests building zoom for a city. */
export function mapFocusCameraOptions(target: AtlasMapFocus, maxZoom: number, reducedMotion: boolean) {
  if (!validMapFocus(target)) return null;
  const limit = Number.isFinite(maxZoom) ? Math.max(1, maxZoom) : 22;
  const precisionLimit = target.positionBasis === "city-reference" ? 9 : target.precision ? precisionZoom[target.precision] : 22;
  const requestedZoom = target.zoom !== undefined && Number.isFinite(target.zoom) ? target.zoom : target.precision ? precisionLimit : 16;
  return {
    center: [target.longitude, target.latitude] as [number, number],
    zoom: Math.min(limit, precisionLimit, Math.max(1, requestedZoom)),
    pitch: target.precision === "country" || target.precision === "region" ? 20 : 42,
    bearing: 0, duration: reducedMotion ? 0 : 1600, curve: 1.35, essential: false,
    ...(target.viewportOffset?.every((value) => Number.isFinite(value) && Math.abs(value) <= 1000) ? { offset: target.viewportOffset } : {}),
  };
}

/** Text-only DOM content keeps job/source strings out of HTML and CSS parsers. */
export function createMapFocusMarker(document: Document, target: AtlasMapFocus, light: boolean): HTMLDivElement {
  const root = document.createElement("div");
  root.className = `atlas-focus-marker${light ? " light" : ""}${target.estimated ? " estimated" : ""}`;
  root.setAttribute("aria-hidden", "true");
  root.dataset.jobId = target.jobId ?? "";
  root.style.setProperty("--atlas-focus-color", target.color && /^#[a-fA-F0-9]{6}$/.test(target.color) ? target.color : light ? "#286b60" : "#b6f1da");
  const pin = document.createElement("span"); pin.className = "atlas-focus-pin";
  pin.appendChild(document.createElement("i"));
  const label = document.createElement("span"); label.className = "atlas-focus-label";
  const title = document.createElement("strong"); title.textContent = target.label || "已定位位置";
  const location = document.createElement("span"); location.textContent = target.locationLabel || `${target.latitude.toFixed(4)}, ${target.longitude.toFixed(4)}`;
  const precision = document.createElement("small"); precision.textContent = mapFocusPrecisionLabel(target);
  label.append(title, location, precision); root.append(pin, label);
  return root;
}
