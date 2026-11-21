import { FactBaseSchema, type Experience, type FactBase, type FactClaim } from "../schema/fact.js";
import type { Locale, LocalizedString } from "../schema/locale.js";

export interface JsonResumeDocument {
  $schema: string;
  basics: {
    name: string;
    label?: string;
    email?: string;
    phone?: string;
    url?: string;
    summary?: string;
    location?: { city?: string };
    profiles?: Array<{ network: string; url: string }>;
  };
  work?: Array<{
    name: string;
    position: string;
    startDate: string;
    endDate?: string;
    url?: string;
    highlights?: string[];
    keywords?: string[];
  }>;
  projects?: Array<{
    name: string;
    description?: string;
    roles?: string[];
    startDate?: string;
    endDate?: string;
    url?: string;
    highlights?: string[];
    keywords?: string[];
  }>;
  education?: Array<{
    institution: string;
    area?: string;
    studyType?: string;
    startDate?: string;
    endDate?: string;
  }>;
  skills?: Array<{
    name: string;
    keywords: string[];
  }>;
}

function pickLocale(value: LocalizedString | undefined, locale: Locale): string {
  if (!value) return "";
  return locale === "en" ? value.en?.trim() || value.zh : value.zh || value.en?.trim() || "";
}

function claimHighlightText(claim: FactClaim, locale: Locale): string {
  const base = pickLocale(claim.text, locale).trim();
  if (!claim.metric?.confirmed) return base;
  const metricText = `${claim.metric.value}${claim.metric.unit}`;
  if (base.includes(metricText)) return base;
  const extra = [claim.metric.baseline, claim.metric.causal].filter(Boolean).join(" · ");
  return extra ? `${base} (${metricText}; ${extra})` : `${base} (${metricText})`;
}

/**
 * Export a BetterMe FactBase to standard JSON Resume v1 (`jsonresume.org`),
 * respecting BetterMe's zero-fabrication rule (unconfirmed metrics are excluded).
 */
export function factBaseToJsonResume(factBase: FactBase, locale: Locale = "zh"): JsonResumeDocument {
  const { profile, experiences } = factBase;
  const workExps = experiences.filter((e) => e.type === "work");
  const projectExps = experiences.filter((e) => e.type === "opensource" || e.type === "other");
  const eduExps = experiences.filter((e) => e.type === "education");
  const allSkills = [...new Set(experiences.flatMap((e) => e.techStack).map((s) => s.trim()).filter(Boolean))];

  const doc: JsonResumeDocument = {
    $schema: "https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json",
    basics: {
      name: pickLocale(profile.displayName, locale),
      ...(profile.targetRoles[0] ? { label: pickLocale(profile.targetRoles[0], locale) } : {}),
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.phone ? { phone: profile.phone } : {}),
      ...(profile.links[0]?.url ? { url: profile.links[0].url } : {}),
      ...(profile.headline ? { summary: pickLocale(profile.headline, locale) } : {}),
      ...(profile.location ? { location: { city: pickLocale(profile.location, locale) } } : {}),
      ...(profile.links.length > 0
        ? { profiles: profile.links.map((link) => ({ network: link.label, url: link.url })) }
        : {}),
    },
  };

  if (workExps.length > 0) {
    doc.work = workExps.map((exp) => ({
      name: pickLocale(exp.org, locale),
      position: pickLocale(exp.title, locale),
      startDate: exp.start,
      ...(exp.end ? { endDate: exp.end } : {}),
      ...(exp.url ? { url: exp.url } : {}),
      highlights: exp.claims.map((c) => claimHighlightText(c, locale)).filter(Boolean),
      ...(exp.techStack.length > 0 ? { keywords: exp.techStack } : {}),
    }));
  }

  if (projectExps.length > 0) {
    doc.projects = projectExps.map((exp) => ({
      name: pickLocale(exp.projectName ?? exp.org, locale),
      roles: [pickLocale(exp.title, locale)].filter(Boolean),
      startDate: exp.start,
      ...(exp.end ? { endDate: exp.end } : {}),
      ...(exp.url ? { url: exp.url } : {}),
      highlights: exp.claims.map((c) => claimHighlightText(c, locale)).filter(Boolean),
      ...(exp.techStack.length > 0 ? { keywords: exp.techStack } : {}),
    }));
  }

  if (eduExps.length > 0) {
    doc.education = eduExps.map((exp) => ({
      institution: pickLocale(exp.org, locale),
      area: pickLocale(exp.title, locale),
      startDate: exp.start,
      ...(exp.end ? { endDate: exp.end } : {}),
    }));
  }

  if (allSkills.length > 0 || profile.traits.length > 0) {
    doc.skills = [
      ...(allSkills.length > 0 ? [{ name: locale === "en" ? "Technical Skills" : "专业技能", keywords: allSkills }] : []),
      ...(profile.traits.length > 0 ? [{ name: locale === "en" ? "Core Strengths" : "核心优势", keywords: profile.traits }] : []),
    ];
  }

  return doc;
}

/** Detect whether an arbitrary parsed JSON object looks like a JSON Resume payload (vs a BetterMe backup). */
export function isJsonResumePayload(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  if ("factBase" in obj || "resumeViews" in obj) return false;
  return (
    (typeof obj.basics === "object" && obj.basics !== null) ||
    Array.isArray(obj.work) ||
    Array.isArray(obj.education) ||
    Array.isArray(obj.projects)
  );
}

function normalizeYearMonth(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  const ym = trimmed.match(/((?:19|20)\d{2})[-./](\d{1,2})/);
  if (ym) {
    const month = ym[2]!.padStart(2, "0");
    if (Number(month) >= 1 && Number(month) <= 12) return `${ym[1]}-${month}`;
  }
  const yOnly = trimmed.match(/\b((?:19|20)\d{2})\b/);
  if (yOnly) return `${yOnly[1]}-01`;
  return fallback;
}

function normalizeOptionalEnd(raw: unknown, start: string): string | null {
  if (typeof raw !== "string" || !raw.trim() || /present|current|now|至今/i.test(raw)) return null;
  const parsed = normalizeYearMonth(raw, "");
  if (!parsed) return null;
  return parsed >= start ? parsed : start;
}

function safeUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  try {
    return new URL(trimmed).toString();
  } catch {
    return undefined;
  }
}

function safeEmail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : undefined;
}

function toLoc(value: string): LocalizedString {
  return { zh: value, ...(value && !/[\u4e00-\u9fa5]/.test(value) ? { en: value } : {}) };
}

/**
 * Import a standard `jsonresume.org` JSON object into a schema-validated BetterMe `FactBase`.
 */
export function jsonResumeToFactBase(raw: unknown, now = new Date().toISOString()): FactBase {
  if (!isJsonResumePayload(raw)) {
    throw new Error("不是有效的 JSON Resume 文件（缺少 basics / work / education 等字段）。");
  }
  const obj = raw;
  const basics = (obj.basics && typeof obj.basics === "object" ? obj.basics : {}) as Record<string, unknown>;
  const name = typeof basics.name === "string" && basics.name.trim() ? basics.name.trim() : "未命名候选人";
  const label = typeof basics.label === "string" ? basics.label.trim() : "";
  const summary = typeof basics.summary === "string" ? basics.summary.trim() : "";
  const email = safeEmail(basics.email);
  const phone = typeof basics.phone === "string" && basics.phone.trim() ? basics.phone.trim() : undefined;
  const locObj = basics.location && typeof basics.location === "object" ? (basics.location as Record<string, unknown>) : undefined;
  const locationText = [locObj?.city, locObj?.region, locObj?.countryCode].filter((v): v is string => typeof v === "string" && Boolean(v.trim())).join(", ");

  const links: Array<{ label: string; url: string }> = [];
  const mainUrl = safeUrl(basics.url);
  if (mainUrl) links.push({ label: "Website", url: mainUrl });
  if (Array.isArray(basics.profiles)) {
    for (const item of basics.profiles) {
      if (!item || typeof item !== "object") continue;
      const p = item as Record<string, unknown>;
      const url = safeUrl(p.url);
      if (!url || links.some((l) => l.url === url)) continue;
      links.push({ label: typeof p.network === "string" && p.network.trim() ? p.network.trim() : "Profile", url });
    }
  }

  const skillKeywords: string[] = [];
  const traits: string[] = [];
  if (Array.isArray(obj.skills)) {
    for (const group of obj.skills) {
      if (!group || typeof group !== "object") continue;
      const g = group as Record<string, unknown>;
      const kws = Array.isArray(g.keywords) ? g.keywords.filter((k): k is string => typeof k === "string" && Boolean(k.trim())).map((k) => k.trim()) : [];
      if (kws.length > 0) skillKeywords.push(...kws);
      else if (typeof g.name === "string" && g.name.trim()) traits.push(g.name.trim());
    }
  }

  const experiences: Experience[] = [];
  const defaultYearMonth = now.slice(0, 7);

  if (Array.isArray(obj.work)) {
    obj.work.forEach((item, idx) => {
      if (!item || typeof item !== "object") return;
      const w = item as Record<string, unknown>;
      const org = (typeof w.name === "string" && w.name.trim()) || (typeof w.company === "string" && w.company.trim()) || `公司 ${idx + 1}`;
      const title = (typeof w.position === "string" && w.position.trim()) || "Engineer";
      const start = normalizeYearMonth(w.startDate, defaultYearMonth);
      const end = normalizeOptionalEnd(w.endDate, start);
      const highlights = [
        ...(typeof w.summary === "string" && w.summary.trim() ? [w.summary.trim()] : []),
        ...(Array.isArray(w.highlights) ? w.highlights.filter((h): h is string => typeof h === "string" && Boolean(h.trim())).map((h) => h.trim()) : []),
      ];
      const keywords = Array.isArray(w.keywords)
        ? w.keywords.filter((k): k is string => typeof k === "string" && Boolean(k.trim())).map((k) => k.trim())
        : idx === 0
          ? [...new Set(skillKeywords)]
          : [];
      experiences.push({
        id: `exp-jr-work-${idx + 1}`,
        type: "work",
        org: toLoc(org),
        title: toLoc(title),
        start,
        end,
        url: safeUrl(w.url),
        techStack: keywords,
        claims: highlights.map((text, cIdx) => ({
          id: `claim-jr-work-${idx + 1}-${cIdx + 1}`,
          kind: "action",
          text: toLoc(text),
          tags: [],
          createdAt: now,
          updatedAt: now,
        })),
      });
    });
  }

  if (Array.isArray(obj.projects)) {
    obj.projects.forEach((item, idx) => {
      if (!item || typeof item !== "object") return;
      const p = item as Record<string, unknown>;
      const nameStr = (typeof p.name === "string" && p.name.trim()) || `项目 ${idx + 1}`;
      const roleStr = Array.isArray(p.roles) && typeof p.roles[0] === "string" && p.roles[0].trim() ? p.roles[0].trim() : "Contributor";
      const start = normalizeYearMonth(p.startDate, defaultYearMonth);
      const end = normalizeOptionalEnd(p.endDate, start);
      const highlights = [
        ...(typeof p.description === "string" && p.description.trim() ? [p.description.trim()] : []),
        ...(Array.isArray(p.highlights) ? p.highlights.filter((h): h is string => typeof h === "string" && Boolean(h.trim())).map((h) => h.trim()) : []),
      ];
      const keywords = Array.isArray(p.keywords)
        ? p.keywords.filter((k): k is string => typeof k === "string" && Boolean(k.trim())).map((k) => k.trim())
        : [];
      experiences.push({
        id: `exp-jr-proj-${idx + 1}`,
        type: "opensource",
        org: toLoc(nameStr),
        title: toLoc(roleStr),
        start,
        end,
        url: safeUrl(p.url),
        techStack: keywords,
        claims: highlights.map((text, cIdx) => ({
          id: `claim-jr-proj-${idx + 1}-${cIdx + 1}`,
          kind: "action",
          text: toLoc(text),
          tags: [],
          createdAt: now,
          updatedAt: now,
        })),
      });
    });
  }

  let educationSummary: string | undefined;
  if (Array.isArray(obj.education)) {
    obj.education.forEach((item, idx) => {
      if (!item || typeof item !== "object") return;
      const e = item as Record<string, unknown>;
      const inst = (typeof e.institution === "string" && e.institution.trim()) || `院校 ${idx + 1}`;
      const degreeParts = [e.studyType, e.area].filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim());
      const title = degreeParts.join(" · ") || "Education";
      if (!educationSummary) educationSummary = `${inst} · ${title}`;
      const start = normalizeYearMonth(e.startDate, defaultYearMonth);
      const end = normalizeOptionalEnd(e.endDate, start);
      experiences.push({
        id: `exp-jr-edu-${idx + 1}`,
        type: "education",
        org: toLoc(inst),
        title: toLoc(title),
        start,
        end,
        techStack: [],
        claims: [],
      });
    });
  }

  return FactBaseSchema.parse({
    schemaVersion: 1,
    updatedAt: now,
    profile: {
      displayName: toLoc(name),
      ...(summary ? { headline: toLoc(summary) } : {}),
      ...(educationSummary ? { education: toLoc(educationSummary) } : {}),
      ...(locationText ? { location: toLoc(locationText) } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      links,
      traits: [...new Set([...traits, ...skillKeywords.slice(0, 6)])],
      targetRoles: label ? [toLoc(label)] : [],
      constraints: [],
    },
    experiences,
  });
}
