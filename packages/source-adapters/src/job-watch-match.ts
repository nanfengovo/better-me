import { includesSearchText } from "@better-me/opportunities";
import { discoveryRoleScore, officialQuerySkills } from "./official-discovery-coverage.js";
import type { DiscoverOfficialJobsInput, OfficialJobDiscoveryCandidate } from "./official-job-discovery-contracts.js";
import type { JobWatchMatch } from "./job-watch-contracts.js";

const requirementHeading = /^(?:(?:minimum |basic |required |essential |technical |job |key )?(?:qualifications|requirements|skills|competencies)|what (?:you(?:'ll| will) need|we (?:are looking for|expect)|you bring)|(?:you (?:must|should) have)|任职(?:要求|资格)|岗位要求|职位要求|必备(?:条件|技能)|能力要求)\b\s*[:：]?/i;
const chineseRequirementHeading = /^(?:任职(?:要求|资格)|岗位要求|职位要求|必备(?:条件|技能)|能力要求)\s*[:：]?/;
const optionalHeading = /^(?:(?:the following\s+)?(?:preferred|desirable|optional|nice.to.have|bonus|additional|a plus)\b|(?:the following .*\b(?:optional|advantage)\b)|加分项|优先(?:条件|考虑)|额外技能)/i;
const otherHeading = /^(?:responsibilities|duties|what you(?:'ll| will) do|benefits|about (?:us|the role)|we offer|工作(?:内容|职责)|岗位职责|公司简介|福利)\b|^(?:工作(?:内容|职责)|岗位职责|公司简介|福利)[:：]?/i;
const optionalLanguage = /\b(?:preferred|desirable|optional|nice.to.have|(?:is|are|a) (?:plus|bonus|advantage)|added advantage|would be (?:a |an )?(?:plus|advantage)|beneficial)\b|优先|加分|更佳|更好|有.+者佳/iu;
const experienceLanguage = /\b(?:experience|proficien\w*|knowledge|familiar\w*|skill(?:s)?|expertise|must|required|hands.on|competenc\w*|programming|develop\w*)\b|掌握|熟悉|精通|经验|具备|能够|要求|至少/iu;
const titledSpecialism = /^(?:c#|csharp|\.net(?: core| framework)?|dotnet|asp\.net(?: core)?)$/i;
const excludedHeading = /^(?:education|equal opportunity|accommodations?|about the company|experience level)\s*[:：]?$/i;

/** Alert only on official, currently observed openings with demonstrable role and technical relevance. */
export function assessJobWatchMatch(job: OfficialJobDiscoveryCandidate, input: DiscoverOfficialJobsInput): JobWatchMatch | undefined {
  if (job.verification !== "official-detail" || job.availability !== "open" || !job.description || !job.company) return;
  const roleMatches = !input.role || discoveryRoleScore(job.title, input) >= 6;
  const primary = [...new Set([...input.skills, ...officialQuerySkills(input).filter(skill => titledSpecialism.test(skill) && input.skills.some(own => titledSpecialism.test(own)))])];
  const evidence = new Map<string, string>();
  let section: "unknown" | "required" | "optional" | "other" = "unknown";
  for (const raw of job.description.split(/\r?\n+|(?<=[。；;!?])\s*|(?<=\.)\s+(?=[A-Z])/u)) {
    const line = raw.replace(/^\s*[-•·*▪◦]\s*/, "").trim();
    if (!line) continue;
    if (optionalHeading.test(line)) section = "optional";
    else if (requirementHeading.test(line) || chineseRequirementHeading.test(line)) section = "required";
    else if (otherHeading.test(line) || excludedHeading.test(line)) section = "other";
    if (section === "optional" || section === "other" || optionalLanguage.test(line)) continue;
    if (section !== "required" && !experienceLanguage.test(line)) continue;
    for (const skill of primary) {
      if (includesSearchText(line, skill) && !evidence.has(skill)) {
        const start = Math.max(0, line.toLowerCase().indexOf(skill.toLowerCase()) - 180);
        evidence.set(skill, line.slice(start, start + 500));
      }
    }
  }
  // A technology named in the official title can itself substantiate the specialization.
  for (const skill of primary) if (roleMatches && includesSearchText(job.title, skill)) evidence.set(skill, job.title.slice(0, 500));
  const requiredSkills = [...evidence].slice(0, 12).map(([skill, quote]) => ({ skill, quote }));
  const skillMatches = !input.skills.length || requiredSkills.length > 0;
  const foreignConfirmed = Boolean(job.employerGroup || job.employerNature === "foreign-disclosed" && job.employerNatureEvidence);
  const travelConflicts = Boolean(input.preferLowTravel && (job.travel === "mentioned" || job.travel === "required"));
  const hasDisclosedTravel = !input.preferLowTravel || job.travel === "not-required" || job.travel === "low-frequency";
  const employerMatches = !input.preferForeignEmployer || foreignConfirmed;
  // Related results remain inspectable but cannot create an alert.
  const relevant = roleMatches && (skillMatches || primary.some(skill => includesSearchText(job.description!, skill)))
    || skillMatches && input.skills.length > 0;
  if (!relevant) return;
  const tier = !roleMatches || !skillMatches || travelConflicts || !employerMatches ? "related" : hasDisclosedTravel ? "priority" : "confirm";
  const secondaryMatches = (input.secondarySkills ?? []).filter(skill => includesSearchText(job.description!, skill));
  return { tier, skillEvidence: requiredSkills, foreignConfirmed, secondaryMatches };
}
