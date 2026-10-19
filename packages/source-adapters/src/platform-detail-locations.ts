import { z } from "zod";
import { PlatformSearchProviderSchema, reviewedCardIdentity, REVIEWED_PLATFORM_NAMES, type PlatformSearchProvider, type PlatformSearchJobPlatform } from "@better-me/source-adapters/platform-job-identity";

// These wire scalars deliberately stay local: Vite's server config loads this
// standalone subpath with Node, without traversing workspace source .js exports.
const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/);
const TimestampSchema = z.string().datetime({ offset: true }).max(64);

const text = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value), "Expected bounded plain text.");
const fields = {
  raw: text(1000), countryCode: CountryCodeSchema.optional(), region: text(200).optional(), city: text(200).optional(),
  streetAddress: text(1000).optional(), postalCode: text(100).optional(),
};
const locationSchema = z.object({ ...fields, evidence: z.object({ selector: z.string().regex(/^jobLocation\[(?:0|[1-9]\d?)\]$/), quote: z.string().min(2).max(20_000) }).strict() }).strict();
export type PlatformDetailLocation = z.infer<typeof locationSchema>;
const workModeEvidenceSchema = z.object({ selector: z.literal("jobLocationType"), quote: z.string().min(2).max(2000) }).strict();
function parseWorkMode(value: unknown): { workMode: "remote" | "unknown"; workModeEvidence?: z.infer<typeof workModeEvidenceSchema> } | undefined {
  if (value === undefined) return { workMode: "unknown" };
  const result = z.union([text(100), z.array(text(100)).min(1).max(10)]).safeParse(value);
  if (!result.success) return;
  const remote = typeof result.data === "string" ? result.data === "TELECOMMUTE" : result.data.includes("TELECOMMUTE");
  return { workMode: remote ? "remote" : "unknown", workModeEvidence: { selector: "jobLocationType", quote: JSON.stringify(result.data) } };
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function boundedJson(value: unknown, depth = 0, budget = { count: 0 }): boolean {
  if (++budget.count > 256 || depth > 12) return false;
  if (typeof value === "string") return value.length <= 20_000 && !/[\p{Cs}]/u.test(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value !== "object") return false;
  return Object.entries(value).every(([key, item]) => key.length <= 200 && boundedJson(item, depth + 1, budget));
}

/** Only explicit PostalAddress fields establish supplied values. No geocoding or name/headquarters inference. */
export function parsePlatformJobLocation(value: unknown, index: number): PlatformDetailLocation | undefined {
  if (!record(value) || !Number.isInteger(index) || index < 0 || index >= 20 || !boundedJson(value)) return;
  const address = record(value.address) ? value.address : value["@type"] === "PostalAddress" ? value : undefined;
  if (!address) return;
  const read = (key: string, max: number): string | undefined => {
    const supplied = address[key];
    if (supplied === undefined) return;
    if (typeof supplied !== "string" || /[\p{Cc}\p{Cs}]/u.test(supplied)) throw new Error("Invalid address field.");
    const parsed = text(max).safeParse(supplied.trim());
    if (!parsed.success) throw new Error("Invalid address field.");
    return parsed.data;
  };
  try {
    const streetAddress = read("streetAddress", 1000), city = read("addressLocality", 200), region = read("addressRegion", 200), postalCode = read("postalCode", 100);
    let country: string | undefined;
    if (record(address.addressCountry)) {
      const object = address.addressCountry;
      // A Country name remains raw text. Only an explicit code supplies countryCode.
      const identifier = object.identifier;
      if (identifier !== undefined && (typeof identifier !== "string" || /[\p{Cc}\p{Cs}]/u.test(identifier) || !text(200).safeParse(identifier.trim()).success)) return;
      if (object.name !== undefined && (typeof object.name !== "string" || /[\p{Cc}\p{Cs}]/u.test(object.name) || !text(200).safeParse(object.name.trim()).success)) return;
      country = typeof identifier === "string" ? identifier.trim() : typeof object.name === "string" ? object.name.trim() : undefined;
    } else country = read("addressCountry", 200);
    const raw = [streetAddress, city, region, postalCode, country].filter(Boolean).join(", ");
    if (!raw || raw.length > 1000) return;
    const countryCode = country && /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : undefined;
    const quote = JSON.stringify(value);
    const result = locationSchema.safeParse({ raw, ...(countryCode ? { countryCode } : {}), ...(region ? { region } : {}), ...(city ? { city } : {}), ...(streetAddress ? { streetAddress } : {}), ...(postalCode ? { postalCode } : {}), evidence: { selector: `jobLocation[${index}]`, quote } });
    return result.success ? result.data : undefined;
  } catch { return; }
}

export const PlatformDetailLocationsSchema = z.object({
  version: z.literal(1), provider: PlatformSearchProviderSchema, url: text(4096), capturedAt: TimestampSchema,
  locations: z.array(locationSchema).max(20), workMode: z.enum(["unknown", "remote", "hybrid", "onsite"]),
  workModeEvidence: workModeEvidenceSchema.optional(),
}).strict().superRefine((value, context) => {
  const path = /^https:\/\/[^/?#]+([^?#]*)/i.exec(value.url)?.[1] ?? "";
  if (!reviewedCardIdentity(value.url, value.provider) || /[\\\s#]/u.test(value.url) || /%(?:2e|2f|5c)/i.test(path) || path.split("/").some(segment => segment === "." || segment === "..")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "Expected an official single-job URL." });
  let disclosedMode: unknown;
  try { if (value.workModeEvidence) disclosedMode = JSON.parse(value.workModeEvidence.quote); } catch { disclosedMode = null; }
  const parsedMode = parseWorkMode(disclosedMode);
  if (!parsedMode || parsedMode.workMode !== value.workMode || (value.workModeEvidence && JSON.stringify(parsedMode.workModeEvidence) !== JSON.stringify(value.workModeEvidence))) context.addIssue({ code: z.ZodIssueCode.custom, path: ["workMode"], message: "Work mode must reproduce the supplied jobLocationType evidence; no evidence only supports unknown." });
  if (!value.locations.length && value.workMode !== "remote") context.addIssue({ code: z.ZodIssueCode.custom, path: ["locations"], message: "An empty disclosure only represents explicit remote work." });
  value.locations.forEach((location, index) => {
    let original: unknown;
    try { original = JSON.parse(location.evidence.quote); } catch { /* Report below. */ }
    const parsed = parsePlatformJobLocation(original, index);
    if (!parsed || JSON.stringify(parsed) !== JSON.stringify(location)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["locations", index], message: "Location fields and selector must exactly reproduce the quoted jobLocation object." });
  });
});
export type PlatformDetailLocations = z.infer<typeof PlatformDetailLocationsSchema>;

export function platformDetailProvider(platform: PlatformSearchJobPlatform): PlatformSearchProvider {
  return (Object.keys(REVIEWED_PLATFORM_NAMES) as PlatformSearchProvider[]).find(provider => REVIEWED_PLATFORM_NAMES[provider] === platform)!;
}

/** Parse one already accepted JobPosting; malformed addresses omit the whole disclosure, never fail its JD. */
export function parsePlatformJobLocations(posting: Record<string, unknown>): Pick<PlatformDetailLocations, "locations" | "workMode" | "workModeEvidence"> | undefined {
  const mode = parseWorkMode(posting.jobLocationType);
  if (!mode) return;
  const source = posting.jobLocation;
  const values = source === undefined ? [] : Array.isArray(source) ? source : [source];
  if (values.length > 20 || (!values.length && mode.workMode !== "remote")) return;
  const locations: PlatformDetailLocation[] = [];
  for (const [index, value] of values.entries()) {
    const location = parsePlatformJobLocation(value, index);
    if (!location) return;
    locations.push(location);
  }
  return { locations, ...mode };
}

/** Rebind a validated same-job browser redirect to the original request's exact source and capture instant. */
export function rebindPlatformDetailLocations(value: PlatformDetailLocations | undefined, url: string, capturedAt: string): PlatformDetailLocations | undefined {
  if (!value) return;
  const before = reviewedCardIdentity(value.url, value.provider), after = reviewedCardIdentity(url, value.provider);
  if (!before || !after || before.id !== after.id) return;
  const result = PlatformDetailLocationsSchema.safeParse({ ...value, url, capturedAt });
  return result.success ? result.data : undefined;
}
