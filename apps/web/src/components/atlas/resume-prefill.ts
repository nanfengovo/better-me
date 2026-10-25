import type { FactBase } from "@better-me/core";
import type { ProjectedResume } from "@better-me/core";
import { matchDisclosedChinaCities, getChinaProvinces, type ChinaRegionSelection } from "./china-regions";

export type ResumePrefillSuggestion = {
  hasResumeData: boolean;
  targetRole: string;
  locationName: string;
  mode: "domestic" | "global";
  chinaSelection: ChinaRegionSelection;
  countryCode?: string;
  skills: string[];
  salaryMinWan?: string;
  summaryLabel: string;
};

/**
 * Extracts sensible search defaults and keyword chips from active resume and FactBase.
 * Everything is local-first and strictly non-destructive.
 */
export function extractResumePrefill(
  resume?: ProjectedResume | null,
  factBase?: FactBase | null,
): ResumePrefillSuggestion {
  // 1. Target Role
  const resumeAny = resume as any;
  const roleFromResume = resume?.profile?.targetRoles?.[0]?.trim() || resumeAny?.header?.targetRole?.trim();
  const roleFromFactBase = factBase?.profile?.targetRoles?.[0];
  const roleFromFactZh = typeof roleFromFactBase === "object"
    ? (roleFromFactBase.zh || roleFromFactBase.en)?.trim()
    : typeof roleFromFactBase === "string"
      ? (roleFromFactBase as string).trim()
      : undefined;

  // Fallback to latest experience title if no explicit target role
  const expTitle = factBase?.experiences?.[0]?.title;
  const expTitleStr = typeof expTitle === "object"
    ? (expTitle.zh || expTitle.en)?.trim()
    : typeof expTitle === "string"
      ? (expTitle as string).trim()
      : resume?.experiences?.[0]?.title?.trim();

  const targetRole = roleFromResume || roleFromFactZh || expTitleStr || "";

  // 2. Location
  const locFromResume = resume?.profile?.location?.trim() || resumeAny?.header?.location?.trim();
  const locFromFact = factBase?.profile?.location;
  const locFromFactStr = typeof locFromFact === "object"
    ? (locFromFact.zh || locFromFact.en)?.trim()
    : typeof locFromFact === "string"
      ? (locFromFact as string).trim()
      : undefined;

  const rawLocation = locFromResume || locFromFactStr || "";

  let mode: "domestic" | "global" = "domestic";
  let chinaSelection: ChinaRegionSelection = {};
  let countryCode: string | undefined = undefined;
  let locationName = rawLocation;

  if (rawLocation) {
    // Check Hong Kong, Macau, Taiwan
    if (/香港|Hong Kong|HK/i.test(rawLocation)) {
      mode = "domestic";
      chinaSelection = { provinceCode: "HK" };
      locationName = "中国香港";
    } else if (/澳门|Macau|MO/i.test(rawLocation)) {
      mode = "domestic";
      chinaSelection = { provinceCode: "MO" };
      locationName = "中国澳门";
    } else if (/台湾|Taiwan|TW/i.test(rawLocation)) {
      mode = "domestic";
      chinaSelection = { provinceCode: "TW" };
      locationName = "中国台湾";
    } else {
      // Try domestic city matching
      const matches = matchDisclosedChinaCities({ countryCode: "CN", raw: rawLocation });
      if (matches.length > 0 && matches[0]) {
        mode = "domestic";
        const best = matches[0];
        chinaSelection = {
          provinceCode: best.province.code,
          cityCode: best.city.code,
        };
        const rawCityName = best.city.isGrouping ? best.province.name : best.city.name;
        locationName = rawCityName.endsWith("市") || rawCityName.endsWith("区") || rawCityName.endsWith("州") || rawCityName.endsWith("盟")
          ? rawCityName
          : `${rawCityName}市`;
      } else {
        // Check if rawLocation is a province name (e.g. 浙江, 广东)
        const provinces = getChinaProvinces();
        const foundProvince = provinces.find(
          (p) => rawLocation.includes(p.name) || p.name.includes(rawLocation.replace(/(?:省|市)$/, "")),
        );
        if (foundProvince) {
          mode = "domestic";
          chinaSelection = { provinceCode: foundProvince.code };
          locationName = foundProvince.name;
        } else {
          // Overseas or text fallback
          mode = "global";
          locationName = rawLocation;
        }
      }
    }
  }

  // 3. Skills / Tech Stack
  const rawSkills: string[] = [];
  if (Array.isArray(resume?.skills)) {
    for (const skillItem of resume.skills as unknown[]) {
      if (typeof skillItem === "string") {
        rawSkills.push(skillItem);
      } else if (skillItem && typeof skillItem === "object") {
        const itemObj = skillItem as Record<string, unknown>;
        if (typeof itemObj.name === "string") {
          rawSkills.push(itemObj.name);
        }
        if (Array.isArray(itemObj.keywords)) {
          for (const kw of itemObj.keywords) {
            if (typeof kw === "string") rawSkills.push(kw);
          }
        }
      }
    }
  }
  if (factBase?.experiences) {
    for (const exp of factBase.experiences) {
      if (Array.isArray(exp.techStack)) {
        rawSkills.push(...exp.techStack);
      }
      if (Array.isArray(exp.claims)) {
        for (const claim of exp.claims) {
          if (Array.isArray(claim.tags)) {
            rawSkills.push(...claim.tags);
          }
        }
      }
    }
  }

  // Count frequencies, filter and deduplicate
  const freqMap = new Map<string, { label: string; count: number }>();
  for (const s of rawSkills) {
    const str = typeof s === "string" ? s : String(s || "");
    const trimmed = str.trim();
    if (!trimmed || trimmed.length > 28 || /^(项目|工作|经验|负责|优化|参与)$/.test(trimmed)) continue;
    const lower = trimmed.toLowerCase();
    const existing = freqMap.get(lower);
    if (existing) {
      existing.count += 1;
    } else {
      freqMap.set(lower, { label: trimmed, count: 1 });
    }
  }

  const sortedSkills = Array.from(freqMap.values())
    .sort((a, b) => b.count - a.count)
    .map((item) => item.label)
    .slice(0, 8);

  // 4. Expected Salary
  let salaryMinWan: string | undefined = undefined;
  const salaryRange = factBase?.profile?.salaryRange;
  if (salaryRange?.minK && salaryRange.minK > 0) {
    // e.g. minK = 25 (25k/mo) -> ~30万/年
    const annualWan = Math.round((salaryRange.minK * 12) / 10);
    if (annualWan > 0) {
      salaryMinWan = String(annualWan);
    }
  }

  const hasResumeData = Boolean(targetRole || locationName || sortedSkills.length > 0);
  const summaryParts: string[] = [];
  if (targetRole) summaryParts.push(targetRole);
  if (locationName) summaryParts.push(locationName);
  if (salaryMinWan) summaryParts.push(`期望年薪 ≥ ${salaryMinWan}万`);

  return {
    hasResumeData,
    targetRole,
    locationName,
    mode,
    chinaSelection,
    countryCode,
    skills: sortedSkills,
    salaryMinWan,
    summaryLabel: summaryParts.join(" · ") || "未提供简历画像",
  };
}
