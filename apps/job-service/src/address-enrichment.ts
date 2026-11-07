import { isDeepStrictEqual } from "node:util";
import {
  AddressEnrichmentPlanSchema, PlanAddressEnrichmentInputSchema, defineTool, ToolError,
  type AddressEnrichmentPlanItem, type AddressEnrichmentPlatformTarget, type AddressEnrichmentOfficialTarget,
  type AddressEnrichmentStreetTarget,
  type SourceDefinition,
} from "@better-me/opportunities";
import { reviewedCardIdentity, REVIEWED_PLATFORM_NAMES, type PlatformSearchProvider } from "@better-me/source-adapters";
import { reviewedCardsSource } from "./reviewed-cards.js";
import type { JobRepository } from "./repository.js";

// Installed recruiting protocols, not company-name heuristics. A source match only
// identifies an already owned disclosure; it does not authenticate the employer.
const officialAdapters = new Set(["greenhouse", "lever", "ashby", "tencent", "smartrecruiters", "jobposting-jsonld"]);
const TARGET_LIMIT = 20;
function exactHttpsUrl(value: string | undefined): value is string {
  if (!value || value !== value.trim() || /[\\\s#]/u.test(value)) return false;
  try {
    const url = new URL(value), path = /^https:\/\/[^/?#]+([^?#]*)/i.exec(value)?.[1] ?? "";
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash && !url.hostname.endsWith(".")
      && !/%(?:2e|2f|5c)/i.test(path) && !path.split("/").some(segment => segment === "." || segment === "..");
  } catch { return false; }
}

/** A bounded read-only next-step plan. It never invokes a transport or any write tool. */
export function createAddressEnrichmentTool(repository: Pick<JobRepository, "readSnapshot" | "readProjectionSnapshot">,
  options: { canReadOfficialSource?: (source: SourceDefinition) => boolean } = {}) {
  // A source's declared adapter/version never proves that executable code is
  // installed. Hosts must supply their current registry resolver explicitly.
  const canReadOfficialSource = options.canReadOfficialSource ?? (() => false);
  return defineTool({
    name: "jobs.plan-address-enrichment", version: 1, effect: "read-index",
    description: "按当前搜索结果的明确岗位ID和版本规划逐岗办公地址补全；区分已有有效点、原来源街址、同平台原岗、已持有官网来源及弱企业发现，不联网、不查地址、不写入。",
    inputSchema: PlanAddressEnrichmentInputSchema, outputSchema: AddressEnrichmentPlanSchema,
    execute: async (input, context) => {
      context.throwIfCancelled();
      const current = await repository.readSnapshot();
      context.throwIfCancelled();
      if (current.revision !== input.expectedRevision) throw new ToolError("stale-version");
      // Source baselines contain neither local area nor office overlays. Both
      // separately read projections must be at this same monotonically increasing revision.
      const original = await repository.readProjectionSnapshot();
      context.throwIfCancelled();
      if (original.revision !== current.revision) throw new ToolError("stale-version");
      const jobs = new Map(current.jobs.map(job => [job.id, job]));
      if (input.jobIds.some(id => !jobs.has(id))) throw new ToolError("invalid-input");
      const sources = new Map(current.sources.map(source => [source.sourceId, source]));
      const originalLocations = new Map(original.locations.map(location => [location.id, location]));
      const effectiveLocations = new Map(current.locations.map(location => [location.id, location]));
      const observationOwners = new Map(current.observations.map(observation => [observation.id, observation.listingId]));
      const items: AddressEnrichmentPlanItem[] = [];
      for (const jobId of input.jobIds) {
        context.throwIfCancelled();
        const job = jobs.get(jobId)!;
        const company = current.companies.find(entry => entry.id === job.companyId);
        if (!company) throw new ToolError("source-changed");
        const locations = job.locationIds.map(id => effectiveLocations.get(id)).filter(value => value !== undefined);
        const remoteOnly = job.workMode === "remote" || !!locations.length && locations.every(location => location.kind === "remote-region");
        const listings = current.listings.filter(listing => job.listingIds.includes(listing.id) && listing.canonicalJobId === job.id)
          .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const listingIds = new Set(listings.map(listing => listing.id));
        const currentOffice = remoteOnly ? [] : locations.filter(location => location.kind === "office" && location.coordinates
          && ["address", "manual"].includes(location.precision) && location.evidence.some(ref => listingIds.has(observationOwners.get(ref.observationId) ?? "")));
        const readyLocationIds = new Set(currentOffice.map(location => location.id));
        const pendingLocationIds = remoteOnly ? [] : locations.filter(location => location.kind !== "remote-region" && !readyLocationIds.has(location.id))
          .map(location => location.id);
        const sourceStreetTargets: AddressEnrichmentStreetTarget[] = [];
        const exactPlatformTargets: AddressEnrichmentPlatformTarget[] = [];
        const ownedOfficialTargets: AddressEnrichmentOfficialTarget[] = [];
        if (!remoteOnly) for (const listing of listings) {
          const source = sources.get(listing.sourceId);
          if (!source) continue;
          for (const locationId of listing.locationIds ?? []) {
            // Keep source evidence intact, but honor a user's current correction
            // that this particular location is remote eligibility or unknown.
            if (!job.locationIds.includes(locationId) || effectiveLocations.get(locationId)?.kind !== "office" || readyLocationIds.has(locationId)) continue;
            const location = originalLocations.get(locationId);
            const evidence = location?.evidence.find(ref => observationOwners.get(ref.observationId) === listing.id);
            if (!location || location.kind !== "office" || !location.streetAddress || !evidence || location.userResolution || location.officeResolution) continue;
            sourceStreetTargets.push({ listingId: listing.id, sourceId: listing.sourceId, locationId,
              sourceUrl: listing.canonicalUrl ?? evidence.sourceUrl, sourceLocation: location });
          }
          const provider = (Object.keys(REVIEWED_PLATFORM_NAMES) as PlatformSearchProvider[])
            .find(value => source.sourceId === `reviewed-platform-${value}`);
          if (provider && isDeepStrictEqual(source, reviewedCardsSource(provider)) && exactHttpsUrl(listing.canonicalUrl)) {
            const identity = reviewedCardIdentity(listing.canonicalUrl, provider);
            if (identity && listing.sourceRecordId === identity.id) exactPlatformTargets.push({ listingId: listing.id,
              sourceId: source.sourceId, provider, url: listing.canonicalUrl, label: source.attribution.label });
          }
          if (officialAdapters.has(source.adapterId) && source.enabled && source.status === "active"
            && source.entityType === "job-posting" && source.capabilities.includes("list-jobs") && source.runtime.includes("local-service")
            && exactHttpsUrl(source.entryUrl) && exactHttpsUrl(listing.canonicalUrl) && canReadOfficialSource(source)) ownedOfficialTargets.push({ listingId: listing.id, sourceId: source.sourceId,
            adapterId: source.adapterId, url: listing.canonicalUrl, label: source.attribution.label });
        }
        const truncated = [currentOffice, sourceStreetTargets, exactPlatformTargets, ownedOfficialTargets].some(values => values.length > TARGET_LIMIT);
        const status = remoteOnly ? "remote-only" : currentOffice.length && !pendingLocationIds.length ? "office-ready" : sourceStreetTargets.length ? "source-street"
          : exactPlatformTargets.length ? "platform-detail" : ownedOfficialTargets.length ? "official-source" : "company-discovery";
        items.push({ jobId: job.id, title: job.title.value, companyId: company.id, companyName: company.names[0]!, status,
          currentOffice: currentOffice.slice(0, TARGET_LIMIT), pendingLocationIds, sourceStreetTargets: sourceStreetTargets.slice(0, TARGET_LIMIT),
          exactPlatformTargets: exactPlatformTargets.slice(0, TARGET_LIMIT), ownedOfficialTargets: ownedOfficialTargets.slice(0, TARGET_LIMIT),
          companyLookup: { companyName: company.names[0]!, association: "unverified", strength: "weak" }, truncated,
          warnings: [
            "此项仅规划下一步，未读取外部详情、查询地图候选或保存任何地址。",
            "企业名称是待审弱线索；同企业、同标题或城市不证明同岗，不得用企业总部或联系地址补办公室。",
            "已有办公点不代表其他来源未披露的地点均已覆盖；待补地点仅包含当前索引已存在的非远程地点。",
            ...(ownedOfficialTargets.length ? ["官网目标仅来自当前岗位实际持有的已启用招聘来源；不认证雇主归属或办公地址。精确读取仍受原来源协议与访问策略约束。"] : []),
            ...(remoteOnly ? ["当前岗位仅作远程资格范围处理，不把该范围或企业地址作为办公室。"] : []),
            ...(truncated ? ["本岗位某类目标超过20项，只返回前20项；其他地点仍未规划。"] : []),
          ],
        });
      }
      return AddressEnrichmentPlanSchema.parse({ schemaVersion: 1, snapshotRevision: current.revision,
        requestedJobs: input.jobIds.length, processedJobs: items.length, truncated: items.some(item => item.truncated), items,
        warnings: ["范围仅为本次明确提交的岗位ID，不代表全部搜索结果或市场覆盖。", "本计划只读索引，地址仍需来源披露、同岗关联与预览确认；未知不会变成已定位。"] });
    },
  });
}
