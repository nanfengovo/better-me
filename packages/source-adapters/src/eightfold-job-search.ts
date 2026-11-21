import { eightfoldDetail, eightfoldListings, microsoftPcsBoard } from "./adapters/eightfold-pcs.js";
import { discoveryRegion, discoveryRoleScore, mapDiscoveryItems, matchedOfficialSkills } from "./official-discovery-coverage.js";
import type { OfficialJobDiscoveryExecution } from "./official-job-discovery.js";
import { describeJobPreferences } from "./official-job-preferences.js";
import type { DiscoverOfficialJobsInput, OfficialJobDiscoveryCandidate, OfficialJobDiscoveryResult } from "./official-job-discovery-contracts.js";

export async function discoverEightfoldJobs(input: DiscoverOfficialJobsInput, execution: OfficialJobDiscoveryExecution): Promise<OfficialJobDiscoveryResult> {
  const { context, transport } = execution;
  const access = { context, transport, source: microsoftPcsBoard };
  const term = input.skills[0] || input.role;
  const area = discoveryRegion(input.region);
  const result: OfficialJobDiscoveryResult = {
    observedAt: context.observedAt, status: "partial", candidates: [], warnings: [],
    queries: ["Microsoft Careers · " + [term, area.english].filter(Boolean).join(" · ")],
  };
  try {
    const list = await eightfoldListings(term, input.region, 0, access);
    const officeFallback = list.evidenceUrl.startsWith("https://careers.microsoft.com/");
    if (officeFallback) result.queries.push("Microsoft Careers · " + (list.evidenceUrl.split("/").pop() ?? "").replace(".html", "") + " · 城市招聘页");
    const rows = list.rows.filter(row => !row.locations?.length || row.locations.some(place => area.matches({ ...place, country: place.countryCode })))
      .sort((a, b) => discoveryRoleScore(b.name ?? "", input) - discoveryRoleScore(a.name ?? "", input));
    const previous = execution.registeredSources?.find(s => s.adapterId === microsoftPcsBoard.adapterId && s.entryUrl === microsoftPcsBoard.entryUrl);
    let failed = 0;
    const candidates = await mapDiscoveryItems(rows.slice(0, 3), 2, async (row): Promise<OfficialJobDiscoveryCandidate | undefined> => {
      try {
        const job = await eightfoldDetail(row, list.evidenceUrl, access);
        if (!job?.description || input.region && !job.locations.some(place => area.matches({ ...place, country: place.countryCode }))) return;
        const text = job.title + "\n" + job.description;
        const matchedSkills = matchedOfficialSkills(text, input);
        const roleMatch = discoveryRoleScore(job.title, input);
        if (input.skills.length ? !matchedSkills.some(s => input.skills.includes(s)) : !roleMatch) return;
        if (input.role && discoveryRoleScore("Software Engineer", input) && !roleMatch) return;
        return { url: row.url, company: "Microsoft", companyWebsite: "https://www.microsoft.com/", title: job.title, jobId: row.id,
          location: job.locations.map(place => place.raw).join(" / ").slice(0, 5000), description: job.description.slice(0, 60_000), matchedSkills,
          availability: "open", verification: "official-detail", detailEvidenceUrl: row.url,
          verificationEvidence: "微软当前招聘目录与其职位详情中的发布主体、职位编号相互对应。",
          ...describeJobPreferences(job.description, "Microsoft"),
          ...(previous ? { sourceId: previous.sourceId } : { sourceProposal: { ...microsoftPcsBoard, ...(input.region && area.country === "CN" ? { options: { fallbackRegion: input.region } } : {}) } }) };
      } catch { context.throwIfCancelled(); failed++; return; }
    });
    result.candidates = candidates.filter((candidate): candidate is OfficialJobDiscoveryCandidate => !!candidate);
    if (failed || officeFallback) result.warnings.push(officeFallback ? "微软招聘地区页仅展示部分近期职位。" : "微软部分职位详情暂时无法读取。");
  } catch {
    context.throwIfCancelled();
    result.status = "provider-unavailable";
    result.warnings.push("微软公开招聘目录暂时无法读取。");
  }
  return result;
}
