import { type SourceDefinition } from "@better-me/opportunities";
import { publicUrl, record } from "./adapters/common.js";
import { workdayBoard } from "./workday-job-search.js";
import type { OfficialJobDiscoveryExecution } from "./official-job-discovery.js";
import type { OfficialJobDiscoveryCandidate } from "./official-job-discovery-contracts.js";

const endpoint = "https://www.wikidata.org/w/api.php";
const source: SourceDefinition = {
  sourceId: "public-employer-background", name: "Wikidata 公开企业资料", adapterId: "public-employer-background", adapterVersion: "1",
  capabilities: ["discover-sources"], runtime: ["local-service"], entityType: "company-directory", enabled: true, status: "active", remoteFilters: [],
  endpointPolicy: { allowedHosts: ["www.wikidata.org"], allowedPathPrefixes: ["/w/api.php"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Wikidata", homepageUrl: "https://www.wikidata.org/", usage: "metadata", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxPages: 1, maxRecords: 10, requestsPerMinute: 12 },
};
const key = (name: string) => name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\d]/gu, "");
const qid = (value: unknown): value is string => typeof value === "string" && /^Q\d{1,14}$/.test(value);
function values(entity: unknown, property: string) {
  const claims = record(record(entity).claims)[property];
  return Array.isArray(claims) ? claims.filter(item => record(item).rank !== "deprecated")
    .map(item => record(record(record(item).mainsnak).datavalue).value) : [];
}
function entityId(entity: unknown, property: string) {
  const ids = [...new Set(values(entity, property).map(value => record(value).id).filter(qid))];
  return ids.length === 1 ? ids[0] : undefined;
}
function label(entity: unknown, language = "en") {
  const labels = record(record(entity).labels);
  const value = language === "zh" ? record(labels["zh-hans"]).value ?? record(labels.zh).value ?? record(labels.en).value
    : record(labels[language]).value ?? record(labels.en).value;
  return typeof value === "string" ? value : undefined;
}
const urlDomain = (url: string) => new URL(url).hostname.replace(/^www\./, "");
function siteName(url: string) {
  return key(urlDomain(url).split(".")[0] ?? "");
}

/** Public structured headquarters evidence for a newly encountered employer.
 * Its official ATS tenant or disclosed website must agree with the entity's
 * corporate site. The local hiring entity's ownership remains unknown. */
export async function discoverEmployerBackground(job: OfficialJobDiscoveryCandidate, execution: OfficialJobDiscoveryExecution) {
  if (job.employerGroup || job.verification !== "official-detail" || !job.company) return;
  const board = workdayBoard(job.url);
  const knownSite = job.companyWebsite && publicUrl(job.companyWebsite);
  const hiringHost = new URL(job.url).hostname;
  const tenant = board?.tenant;
  const search = tenant ? (tenant.length <= 4 ? tenant.toUpperCase() : tenant) + " Corporation"
    : job.company.replace(/\s*[（(][^）)]*[）)]\s*.*$/u, "").trim();
  if (search.length < 3 || search.length > 120) return;
  const { context } = execution;
  async function api(params: Record<string, string>) {
    const url = endpoint + "?" + new URLSearchParams({ ...params, format: "json" });
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(5000)]);
    const response = await execution.transport.request({ url, source, context: { ...context, signal,
      throwIfCancelled() { context.throwIfCancelled(); signal.throwIfAborted(); } }, headers: { accept: "application/json" } });
    if (response.status !== 200 || response.url !== url || response.text.length > 2_000_000) throw new Error("unavailable");
    return record(JSON.parse(response.text));
  }
  try {
    const found = await api({ action: "wbsearchentities", search, language: "en", type: "item", limit: "5" });
    const ids = Array.isArray(found.search) ? found.search.map(item => record(item).id).filter(qid).slice(0, 3) : [];
    if (!ids.length) return;
    const entities = record((await api({ action: "wbgetentities", ids: ids.join("|"), props: "labels|claims", languages: "en|zh" })).entities);
    for (const id of ids) {
      const entity = entities[id], name = label(entity), country = entityId(entity, "P17"), hq = entityId(entity, "P159");
      if (!name || !country || !hq || country === "Q148" || !values(entity, "P31").length) continue;
      const website = values(entity, "P856").map(publicUrl).find(value => {
        if (!value) return false;
        const host = urlDomain(value);
        if (knownSite) return host === urlDomain(knownSite) || urlDomain(knownSite).endsWith("." + host);
        if (tenant && key(tenant) === siteName(value)) return key(name).startsWith(key(tenant)) && key(job.company!).includes(key(tenant)) ||
          key(name).startsWith(key(tenant)) && key(job.description ?? "").includes(key(tenant));
        return (hiringHost === host || hiringHost.endsWith("." + host)) && key(name).startsWith(siteName(value));
      });
      if (!website) continue;
      // Confirm the headquarters place is actually in the stated country.
      if (hq !== country) {
        const headquarters = await api({ action: "wbgetclaims", entity: hq, property: "P17" });
        if (!values(headquarters, "P17").some(value => record(value).id === country)) continue;
      }
      const places = record((await api({ action: "wbgetentities", ids: [hq, country].join("|"), props: "labels", languages: "en|zh-hans|zh" })).entities);
      const city = label(places[hq], "zh"), nation = label(places[country], "zh");
      if (!city || !nation || name.length > 120 || (city + nation).length > 115) continue;
      return { website, group: { name, headquarters: nation + (hq !== country ? " · " + city : ""), evidenceUrl: "https://www.wikidata.org/wiki/" + id, evidenceKind: "public-entity" as const } };
    }
  } catch { context.throwIfCancelled(); }
}
