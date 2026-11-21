import type { FactBase, ProjectedResume } from "@better-me/core";
import { extractResumePrefill } from "../components/atlas/resume-prefill";
import { extractRecommendationProfile, skillsFromResumeTraits } from "./resume-job-recommendations";

export function resumeDiscoveryCriteria(resume?: ProjectedResume | null, facts?: FactBase | null, direction?: string) {
  // Select by stable IDs so a job-specific version cannot pick up a hidden experience from another version.
  const visible = resume && new Map(resume.experiences.map(exp => [exp.id, new Set(exp.claims.map(claim => claim.id))]));
  const selectedFacts = facts && visible ? { ...facts, experiences: facts.experiences.filter(exp => visible.has(exp.id)).map(exp => ({
    ...exp, claims: exp.claims.filter(claim => visible.get(exp.id)?.has(claim.id)),
  })) } : facts;
  const profile = selectedFacts && extractRecommendationProfile(selectedFacts);
  const prefill = extractResumePrefill(resume, resume ? undefined : facts);
  const privateNames = [facts?.profile.displayName.zh, facts?.profile.displayName.en].filter((name): name is string => Boolean(name?.trim()));
  const publicTerm = (term: string) => term.length <= 80 && !/[\r\n@：:!?！？。]|https?:\/\/|www\.|(?:\d[\s()-]*){7}/i.test(term)
    && !privateNames.some(name => name.length > 1 && term.toLowerCase().includes(name.trim().toLowerCase()));
  const role = [direction, ...(resume?.profile.targetRoles ?? profile?.roles ?? []), resume?.experiences.find(exp => exp.type !== "education")?.title]
    .map(term => term?.trim()).find((term): term is string => Boolean(term && publicTerm(term)));
  const traits = resume?.profile.traits ?? facts?.profile.traits ?? [];
  const skills = [...skillsFromResumeTraits(traits), ...(profile?.skills ?? prefill.skills)]
    .flatMap(skill => skill.split(/\s+\/\s+/)).map(skill => skill.trim()).filter(skill => skill && publicTerm(skill));
  const constraints = (facts?.profile.constraints ?? []).join("；");
  return {
    targetRole: role ?? "", skills: [...new Set(skills)].slice(0, 12),
    location: prefill.chinaSelection.provinceCode ? prefill.locationName : undefined,
    preferLowTravel: /(?:少|低频|减少|避免|不(?:想|愿|接受|喜欢|要)?|无|零|0)出差|(?:no|minimal|limited) travel/i.test(constraints),
    preferForeignEmployer: !/(?:不(?:想去|喜欢|考虑|要)|排除|拒绝)(?:外企|外资企业)/.test(constraints)
      && /(?:^|[，,、；;\s])(?:外企|外资企业)(?:优先|$|[，,、；;\s])|(?:优先|首选|偏好|只考虑|希望去|想去)(?:外企|外资企业)/.test(constraints),
  };
}

export function uniqueSkills(value: string) {
  const seen = new Set<string>();
  return value.split(/[,，、;；\n]+/).map(term => term.trim()).filter(term => {
    const key = term.toLowerCase();
    if (!term || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function primaryResumeSkills(skills: readonly string[]) {
  const first = skills[0];
  if (!first) return [];
  const dotnetSkill = /^(?:c#|csharp|\.net(?: core| framework)?|dotnet)$/i;
  return dotnetSkill.test(first) ? skills.filter(skill => dotnetSkill.test(skill)) : [first];
}

