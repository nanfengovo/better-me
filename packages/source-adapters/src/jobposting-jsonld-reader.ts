import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { normalizeSourceUrl, ToolError } from "@better-me/opportunities";
import { SourceJobRecordSchema, type SourceJobRecord, type SourceRecordLocation } from "./contracts.js";
import { idValue, plainText, publicUrl, record, timeValue } from "./adapters/common.js";
import { resolveSourceCountryCode } from "./source-country.js";

const PAGE_BYTES = 2 * 1024 * 1024, SCRIPT_BYTES = 1024 * 1024;
const MAX_SCRIPTS = 32, MAX_NODES = 10_000, MAX_DEPTH = 32;
const inert = new Set(["template", "noscript", "textarea", "title", "style", "iframe", "noembed", "noframes", "object", "canvas", "xmp", "plaintext", "svg", "math"]);
type Node = { value: Record<string, unknown>; path: string; script: number };
const changed = () => new ToolError("source-changed");
const bounded = () => new ToolError("budget-exceeded");
const controls = (value: string, includeSpace = false) => [...value].some(character => character.charCodeAt(0) <= (includeSpace ? 32 : 31) || character.charCodeAt(0) === 127);

function jsonScripts(html: string): Array<{ text: string; index: number }> {
  if (Buffer.byteLength(html, "utf8") > PAGE_BYTES) throw bounded();
  // WHATWG parsing preserves raw-text, script escaping and foreign-content boundaries without executing scripts.
  const document = parse(html, { scriptingEnabled: true });
  const scripts: Array<{ text: string; index: number }> = [];
  const pending: Array<{ node: DefaultTreeAdapterTypes.Node; depth: number; excluded: boolean }> = [{ node: document, depth: 0, excluded: false }];
  let count = 0, totalBytes = 0, nodes = 0;
  while (pending.length) {
    const { node, depth, excluded: ancestorExcluded } = pending.pop()!;
    if (++nodes > 50_000 || depth > 256) throw bounded();
    const element = "tagName" in node ? node : undefined;
    const excluded = ancestorExcluded || !!element && (element.namespaceURI !== "http://www.w3.org/1999/xhtml" || inert.has(element.tagName));
    if (element?.tagName === "script" && !excluded) {
      const attributes = Object.fromEntries(element.attrs.map(attribute => [attribute.name, attribute.value]));
      if (attributes.type?.split(";")[0]?.trim().toLowerCase() === "application/ld+json") {
        if (++count > MAX_SCRIPTS) throw bounded();
        // External scripts are never fetched; only this page's inline structured data is eligible.
        if (!Object.hasOwn(attributes, "src")) {
          const text = element.childNodes.filter((child): child is DefaultTreeAdapterTypes.TextNode => child.nodeName === "#text").map(child => child.value).join("");
          totalBytes += Buffer.byteLength(text, "utf8"); if (totalBytes > SCRIPT_BYTES) throw bounded();
          scripts.push({ text, index: count - 1 });
        }
      }
    }
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push({ node: node.childNodes[index]!, depth: depth + 1, excluded });
    }
    // Template contents live in a separate fragment, but still count toward the HTML traversal limits.
    if ("content" in node) pending.push({ node: node.content, depth: depth + 1, excluded: true });
  }
  return scripts;
}

function isJob(value: unknown): boolean {
  const types = Array.isArray(value) ? value : [value];
  return types.some(type => type === "JobPosting" || type === "https://schema.org/JobPosting" || type === "http://schema.org/JobPosting");
}
function collectJobs(scripts: ReturnType<typeof jsonScripts>, warnings: string[]): Node[] {
  const jobs: Node[] = []; let nodes = 0;
  for (const script of scripts) {
    let root: unknown;
    try { root = JSON.parse(script.text); } catch { warnings.push("An inline JSON-LD block is not valid JSON and was not executed or repaired."); continue; }
    const pending: Array<{ value: unknown; path: string; depth: number; eligible: boolean }> = [{ value: root, path: "$", depth: 0, eligible: true }];
    while (pending.length) {
      const current = pending.pop()!;
      if (++nodes > MAX_NODES || current.depth > MAX_DEPTH) throw bounded();
      if (Array.isArray(current.value)) {
        for (let index = current.value.length - 1; index >= 0; index--) pending.push({ value: current.value[index], path: `${current.path}[${index}]`, depth: current.depth + 1, eligible: current.eligible });
      } else if (current.value && typeof current.value === "object") {
        const object = record(current.value);
        if (current.eligible && isJob(object["@type"])) jobs.push({ value: object, path: current.path, script: script.index });
        for (const [key, value] of Object.entries(object).reverse()) pending.push({ value, path: `${current.path}[${JSON.stringify(key)}]`, depth: current.depth + 1, eligible: current.eligible && key === "@graph" });
      }
    }
  }
  return jobs;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)]));
  return value;
}
function pageIdentity(value: unknown, pageUrl: string, fragment: boolean): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || controls(value, true) || value.includes("\\")) throw changed();
  let url: URL;
  try { url = new URL(value, pageUrl); } catch { throw changed(); }
  if (!fragment && url.hash) throw changed();
  url.hash = "";
  if (!publicUrl(url.toString()) || normalizeSourceUrl(url.toString()) !== normalizeSourceUrl(pageUrl)) throw changed();
  return value;
}
function text(value: unknown, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw changed();
  const result = plainText(value); if (result.length > maximum) throw changed();
  return result || undefined;
}
function sourceIdentifier(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const values = Array.isArray(value) ? value : [value];
  const identifiers = values.map(entry => idValue(typeof entry === "object" ? record(entry).value : entry));
  if (identifiers.some(value => !value || value.length > 1000 || controls(value)) || new Set(identifiers).size > 1) throw changed();
  return identifiers[0];
}

/** Read one detail page's literal structured data; no script, context, reference or URL is fetched. */
export function readJobPostingJsonLd(html: string, pageUrl: string): { record?: SourceJobRecord; warnings: string[] } {
  if (typeof html !== "string" || typeof pageUrl !== "string" || publicUrl(pageUrl) !== pageUrl || new URL(pageUrl).hash) throw new ToolError("invalid-input");
  const warnings: string[] = [], jobs = collectJobs(jsonScripts(html), warnings);
  if (!jobs.length) return { warnings: [...new Set([...warnings, "No inline Schema.org JobPosting was found on this detail page."])] };
  const unique = new Map(jobs.map(node => [JSON.stringify(stable(node.value)), node]));
  if (unique.size !== 1) throw changed();
  const node = unique.values().next().value!, input = node.value, prefix = `jsonld-script[${node.script}]${node.path}`;
  const title = text(input.title, 1000); if (!title) throw changed();
  const job: SourceJobRecord = { entityType: "job-posting", url: pageUrl, title, locations: [], compensations: [], workMode: "unknown", employmentType: "unknown", remoteEligibleRegions: [], availability: "unknown", completeness: "excerpt", evidence: [], warnings: [] };
  function evidence(field: string, path: string, original: unknown) {
    if (job.evidence.length >= 500) throw bounded();
    const quote = typeof original === "string" ? original : JSON.stringify(original);
    if (quote) job.evidence.push({ field, selector: `${prefix}.${path}`.slice(0, 1000), quote: quote.slice(0, 20_000), sourceUrl: pageUrl });
  }
  evidence("title", "title", input.title);
  for (const key of ["url", "@id", "mainEntityOfPage"] as const) {
    const value = input[key]; if (value === undefined) continue;
    if (key === "mainEntityOfPage" && value && typeof value === "object" && !Array.isArray(value)) {
      const identity = record(value);
      if (identity["@id"] === undefined && identity.url === undefined) throw changed();
      for (const field of ["@id", "url"] as const) if (identity[field] !== undefined) pageIdentity(identity[field], pageUrl, field === "@id");
    } else pageIdentity(value, pageUrl, key === "@id");
    evidence(`source.${key}`, key, value);
  }
  const id = sourceIdentifier(input.identifier);
  if (id) { job.sourceRecordId = id; evidence("sourceRecordId", "identifier", input.identifier); }
  const description = text(input.description, 2_000_000);
  if (description) { job.description = description; job.completeness = "detail"; evidence("description", "description", input.description); }
  else warnings.push("The JobPosting does not disclose a readable description; this record remains an excerpt.");
  if (input.hiringOrganization !== undefined) {
    const organization = typeof input.hiringOrganization === "string" ? input.hiringOrganization : record(input.hiringOrganization).name;
    const name = text(organization, 500);
    if (name) job.companyName = name;
    else warnings.push("The JobPosting hiring organization has no unambiguous name; no company name was supplied.");
    evidence("companyName", "hiringOrganization", input.hiringOrganization);
  } else warnings.push("The JobPosting does not disclose a hiring organization; no configured company name was substituted.");
  const published = timeValue(input.datePosted);
  if (published.raw) { job.sourcePublishedRaw = published.raw; evidence("sourcePublishedRaw", "datePosted", input.datePosted); }
  if (published.at) job.sourcePublishedAt = published.at;
  for (const field of ["employmentType", "validThrough", "jobLocationType", "applicantLocationRequirements"] as const) if (input[field] !== undefined) evidence(`source.${field}`, field, input[field]);
  if (input.employmentType !== undefined) warnings.push("Employment contract labels do not establish social, campus or internship recruitment; employment type remains unknown.");
  if (input.jobLocationType === "TELECOMMUTE") job.workMode = "remote";
  if (input.applicantLocationRequirements !== undefined) {
    const values = Array.isArray(input.applicantLocationRequirements) ? input.applicantLocationRequirements : [input.applicantLocationRequirements];
    for (const value of values) {
      const name = text(typeof value === "string" ? value : record(value).name, 240);
      if (name && !job.remoteEligibleRegions.includes(name)) job.remoteEligibleRegions.push(name);
    }
  }
  const locations = input.jobLocation === undefined ? [] : Array.isArray(input.jobLocation) ? input.jobLocation : [input.jobLocation];
  if (locations.length > 100) throw bounded();
  for (const [index, value] of locations.entries()) {
    const place = record(value), address = record(place.address);
    const name = text(typeof value === "string" ? value : place.name, 5000), addressText = typeof place.address === "string" ? text(place.address, 5000) : undefined;
    const street = text(address.streetAddress, 1000), postal = text(address.postalCode, 500), region = text(address.addressRegion, 500), city = text(address.addressLocality, 500);
    const country = text(typeof address.addressCountry === "string" ? address.addressCountry : record(address.addressCountry).name, 500);
    const countryCode = country ? resolveSourceCountryCode(country) : undefined;
    const fields = [street, city, region, postal, country].filter(Boolean).join(", ");
    const raw = [name, addressText, fields].filter(Boolean).join(" · ");
    if (!raw) { warnings.push("A JobPosting location has no readable address fields and was omitted."); continue; }
    if (raw.length > 5000) throw changed();
    const location: SourceRecordLocation = { raw, ...(countryCode ? { countryCode } : {}), ...(region ? { region } : {}), ...(city ? { city } : {}) };
    if (!job.locations.some(old => JSON.stringify(old) === JSON.stringify(location))) job.locations.push(location);
    evidence("locations", `jobLocation[${index}]`, value);
  }
  if (input.baseSalary !== undefined) {
    const salary = input.baseSalary;
    const raw = typeof salary === "string" ? salary.trim() : salary !== null && (typeof salary === "number" || typeof salary === "object" && !Array.isArray(salary)) ? JSON.stringify(salary) : undefined;
    if (raw && raw.length <= 5000) job.compensations.push({ raw, period: "unknown", tax: "unknown", kind: "base" });
    else warnings.push("Structured base salary exceeds the raw display limit or is empty; no comparable salary was inferred.");
    evidence("compensations", "baseSalary", input.baseSalary);
  }
  warnings.push("Structured data is a publisher claim, not verified availability, office coordinates or controlling ownership. JSON-LD contexts and references were not fetched or expanded.");
  job.warnings = [...new Set(warnings)];
  const checked = SourceJobRecordSchema.safeParse(job); if (!checked.success) throw changed();
  return { record: checked.data, warnings: [...job.warnings] };
}
