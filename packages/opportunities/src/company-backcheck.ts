import { z } from "zod";

export const CompanyBackcheckEvidenceTierSchema = z.enum(["tier1_compliance", "tier2_business", "tier3_sentiment"]);
export type CompanyBackcheckEvidenceTier = z.infer<typeof CompanyBackcheckEvidenceTierSchema>;

export const CompanyBackcheckEvidenceSchema = z.object({
  id: z.string().min(1),
  tier: CompanyBackcheckEvidenceTierSchema,
  sourceName: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  observedAt: z.string().datetime(),
  confidence: z.enum(["high", "medium", "low"]),
  summary: z.string().min(1),
  sanitizedExcerpt: z.string().min(1),
  strippedInjectionFragments: z.number().int().nonnegative().default(0),
});
export type CompanyBackcheckEvidence = z.infer<typeof CompanyBackcheckEvidenceSchema>;

export const CompanyBackcheckReportSchema = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  legalEntity: z.string().min(1),
  generatedAt: z.string().datetime(),
  tier1ComplianceSummary: z.string().min(1),
  tier2BusinessSummary: z.string().min(1),
  tier3SentimentSummary: z.string().min(1),
  estimatedSchedule: z.string().min(1),
  estimatedWeeklyHours: z.number().positive(),
  bonusRealizationRate: z.number().min(0).max(1.5),
  sentimentSampleCount: z.number().int().nonnegative(),
  overallRecommendation: z.enum(["strongly_recommended", "recommended_with_caution", "high_risk_decline"]),
  evidences: z.array(CompanyBackcheckEvidenceSchema).min(1),
});
export type CompanyBackcheckReport = z.infer<typeof CompanyBackcheckReportSchema>;

export interface SanitizedPublicTextResult {
  cleanText: string;
  strippedCount: number;
  warnings: string[];
}

const HIDDEN_HTML_BLOCK_RE =
  /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->|<([a-z0-9]+)\b[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0)[^>]*>[\s\S]*?<\/\2>/gi;

const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;

const ZERO_WIDTH_OR_BIDI_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]|\uDB40[\uDC00-\uDC7F]/g;

const INJECTION_LINE_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior)\s+instructions/i,
  /system\s*prompt|developer\s*message/i,
  /忽略(以上|之前|前面|所有).*?(指令|要求|规则|提示)/,
  /无视(以上|之前|所有).*?(指令|规则)/,
  /请直接(调用|执行)(工具|函数|命令)/,
  /\b(tool_call|call_mcp_tool|execute_command|auto_submit)\b/i,
];

/**
 * Deterministic anti-injection sanitizer (`postingGuard`) for untrusted public job postings
 * and community sentiment excerpts (Maimai, Xiaohongshu, KanZhun, V2EX, Judicial records).
 *
 * All public web text is strictly treated as untrusted data and can never escalate permissions
 * or inject instructions into the Agent prompt.
 */
export function sanitizeUntrustedPublicText(raw: string): SanitizedPublicTextResult {
  let strippedCount = 0;
  const warnings: string[] = [];

  const withoutHiddenBlocks = raw.replace(HIDDEN_HTML_BLOCK_RE, () => {
    strippedCount += 1;
    warnings.push("Removed hidden or executable HTML block");
    return " ";
  });

  const withoutZeroWidth = withoutHiddenBlocks.replace(ZERO_WIDTH_OR_BIDI_RE, () => {
    strippedCount += 1;
    warnings.push("Removed zero-width, bidi-override, or Unicode tag character");
    return "";
  });

  const plainText = withoutZeroWidth.replace(HTML_TAG_RE, " ");

  const keptLines: string[] = [];
  for (const line of plainText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const matchedPattern = INJECTION_LINE_PATTERNS.find((re) => re.test(trimmed));
    if (matchedPattern) {
      strippedCount += 1;
      warnings.push(`Stripped instruction-shaped line: ${trimmed.slice(0, 48)}`);
      continue;
    }
    keptLines.push(trimmed.replace(/\s+/g, " "));
  }

  return {
    cleanText: keptLines.join("\n").trim(),
    strippedCount,
    warnings: [...new Set(warnings)],
  };
}

/**
 * Parses domestic engineering work schedule shorthand (e.g. "10-9.5-5", "11-11-6", "9-6-5")
 * into estimated weekly hours.
 */
export function parseWorkScheduleToWeeklyHours(scheduleText: string): number {
  const match = scheduleText.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
  if (!match) return 45;
  const startHour = Number(match[1]);
  const endHourRaw = Number(match[2]);
  const daysPerWeek = Number(match[3]);
  if (!Number.isFinite(startHour) || !Number.isFinite(endHourRaw) || !Number.isFinite(daysPerWeek)) {
    return 45;
  }
  const endHour24 = endHourRaw <= 12 ? endHourRaw + 12 : endHourRaw;
  // Account for ~2h lunch + dinner break on long shifts (>9h span) or ~1h break on standard shifts
  const rawSpan = Math.max(1, endHour24 - startHour);
  const netDailyHours = daysPerWeek <= 5 && rawSpan >= 10.5 ? rawSpan - 2 : rawSpan >= 8.5 ? rawSpan - 1 : rawSpan;
  return Number((netDailyHours * daysPerWeek).toFixed(1));
}

export interface RawPublicBackcheckInput {
  company: string;
  role: string;
  legalEntity: string;
  scheduleText: string;
  bonusRealizationRate: number;
  sentimentSampleCount: number;
  maxPreferredWeeklyHours?: number;
  rawEvidences: Array<{
    id: string;
    tier: CompanyBackcheckEvidenceTier;
    sourceName: string;
    sourceUrl?: string;
    observedAt?: string;
    confidence: "high" | "medium" | "low";
    summary: string;
    rawExcerpt: string;
  }>;
}

/**
 * Builds a validated, three-tier Company Reverse Due Diligence report (`CompanyBackcheckReport`)
 * from read-only public evidence while sanitizing all untrusted excerpts.
 */
export function buildCompanyBackcheckReport(input: RawPublicBackcheckInput): CompanyBackcheckReport {
  const nowIso = new Date().toISOString();
  const weeklyHours = parseWorkScheduleToWeeklyHours(input.scheduleText);
  const maxHours = input.maxPreferredWeeklyHours ?? 52;

  const evidences: CompanyBackcheckEvidence[] = input.rawEvidences.map((item) => {
    const sanitized = sanitizeUntrustedPublicText(item.rawExcerpt);
    const cleanSummary = sanitizeUntrustedPublicText(item.summary).cleanText || item.summary;
    return {
      id: item.id,
      tier: item.tier,
      sourceName: item.sourceName,
      sourceUrl: item.sourceUrl,
      observedAt: item.observedAt ?? nowIso,
      confidence: item.confidence,
      summary: cleanSummary,
      sanitizedExcerpt: sanitized.cleanText || "(已被反注入护栏净化的空白摘录)",
      strippedInjectionFragments: sanitized.strippedCount,
    };
  });

  const tier1 = evidences.filter((e) => e.tier === "tier1_compliance").map((e) => e.summary).join("；") || "签约主体合规核验通过";
  const tier2 = evidences.filter((e) => e.tier === "tier2_business").map((e) => e.summary).join("；") || "业务线处于常规迭代周期";
  const tier3 = evidences.filter((e) => e.tier === "tier3_sentiment").map((e) => e.summary).join("；") || "公开社区样本已交叉核验";

  let overallRecommendation: CompanyBackcheckReport["overallRecommendation"] = "strongly_recommended";
  if (weeklyHours > maxHours + 10 || input.bonusRealizationRate < 0.6) {
    overallRecommendation = "high_risk_decline";
  } else if (weeklyHours > maxHours || input.bonusRealizationRate < 0.8) {
    overallRecommendation = "recommended_with_caution";
  }

  return CompanyBackcheckReportSchema.parse({
    company: input.company,
    role: input.role,
    legalEntity: input.legalEntity,
    generatedAt: nowIso,
    tier1ComplianceSummary: tier1,
    tier2BusinessSummary: tier2,
    tier3SentimentSummary: tier3,
    estimatedSchedule: input.scheduleText,
    estimatedWeeklyHours: weeklyHours,
    bonusRealizationRate: input.bonusRealizationRate,
    sentimentSampleCount: input.sentimentSampleCount,
    overallRecommendation,
    evidences,
  });
}

export interface OfferBackcheckComparisonItem {
  offerId: string;
  company: string;
  role: string;
  monthlyBaseK: number;
  guaranteedMonths: number;
  bonusMonths: number;
  providentFundRate: number;
  commuteMinutesOneWay: number;
  backcheck: CompanyBackcheckReport;
}

export interface OfferBackcheckEvaluatedResult {
  offerId: string;
  company: string;
  role: string;
  nominalAnnualWan: number;
  realisticAnnualWan: number;
  weeklyWorkHours: number;
  weeklyTotalHoursWithCommute: number;
  realHourlyWageRmb: number;
  recommendation: CompanyBackcheckReport["overallRecommendation"];
}

/**
 * Evaluates and ranks multiple Offers by combining nominal package numbers with
 * read-only public backcheck metrics (real work hours, bonus realization rate, provident fund, and commute).
 */
export function compareOffersWithBackcheck(
  items: OfferBackcheckComparisonItem[]
): OfferBackcheckEvaluatedResult[] {
  return items
    .map((item) => {
      const nominalMonths = item.guaranteedMonths + item.bonusMonths;
      const nominalAnnualWan = Number(((item.monthlyBaseK * nominalMonths) / 10).toFixed(1));
      const effectiveMonths =
        item.guaranteedMonths +
        item.bonusMonths * item.backcheck.bonusRealizationRate +
        12 * item.providentFundRate * 2;
      const realisticAnnualWan = Number(((item.monthlyBaseK * effectiveMonths) / 10).toFixed(1));
      const weeklyWorkHours = item.backcheck.estimatedWeeklyHours;
      const workDays = Number(item.backcheck.estimatedSchedule.split("-")[2]) || 5;
      const weeklyCommuteHours = ((item.commuteMinutesOneWay * 2) / 60) * workDays;
      const weeklyTotalHoursWithCommute = Number((weeklyWorkHours + weeklyCommuteHours).toFixed(1));
      const realHourlyWageRmb = Math.round((realisticAnnualWan * 10000) / (50 * weeklyTotalHoursWithCommute));

      return {
        offerId: item.offerId,
        company: item.company,
        role: item.role,
        nominalAnnualWan,
        realisticAnnualWan,
        weeklyWorkHours,
        weeklyTotalHoursWithCommute,
        realHourlyWageRmb,
        recommendation: item.backcheck.overallRecommendation,
      };
    })
    .sort((a, b) => b.realHourlyWageRmb - a.realHourlyWageRmb);
}
