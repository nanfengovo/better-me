/**
 * Deterministic Rewrite Fact-Preservation Guard (Zero-LLM).
 *
 * Adapted from Resume-Matcher's `_novel_numbers` preservation seam and extended
 * for bilingual (Chinese + English) resume rewrites:
 * - Normalizes equivalent numeric claims (e.g. `1,500` === `1.5k`, `50%` === `50 percent`, `2万` === `20k`)
 * - Ignores version numbers (`Python 3`, `Node 24`, `.NET 8`, `Vue 3`, `v2.1`, `HTTP/2`)
 *   and date-like years (`2023-05`, `Jan 2024`, `2023年`, `2022 - 2024`)
 * - Detects any novel numeric claim introduced by an AI rewrite that did not appear
 *   in the original resume line or explicitly confirmed user supplement texts.
 */

export interface NumericClaim {
  /** Raw matched surface text, e.g. "99.9%", "3倍", "$2.5M". */
  raw: string;
  /** Canonical comparison key combining semantic unit kind + normalized numeric value. */
  key: string;
  /** Normalized numeric magnitude. */
  value: number;
  /** Canonical unit bucket (`%`, `x`, `$`, `¥`, `ms`, `s`, `gb`, etc. or empty string). */
  kind: string;
}

export interface RewritePreservationInput {
  sourceText: string;
  candidateText: string;
  /** Optional extra user-confirmed fact texts (e.g. user supplement or parent experience claims). */
  additionalFactTexts?: readonly string[];
}

export interface RewritePreservationReport {
  /** True when the candidate introduces zero novel numeric claims beyond allowed sources. */
  ok: boolean;
  /** Raw novel numeric claims introduced in `candidateText`. */
  novelNumbers: string[];
  /** Canonical keys of novel numeric claims. */
  novelKeys: string[];
  /** Raw numeric claims present in source (+ additionalFactTexts). */
  sourceNumbers: string[];
  /** Raw numeric claims present in candidateText. */
  candidateNumbers: string[];
  summary: {
    zh: string;
    en: string;
  };
}

// Matches optional currency prefix, number with commas/decimals, and optional EN/ZH scale or unit suffix.
const NUMBER_CLAIM_RE =
  /(?<![A-Za-z0-9_.])(?<currency>[$€£¥￥])?(?<number>\d[\d,]*(?:\.\d+)?)(?:\s*(?<unit>thousand|million|billion|percent|times|ms|gb|mb|tb|kb|qps|tps|rps|百分点|[kmb%x]|万|亿|千|倍|秒|分钟|小时|天))?(?![A-Za-z0-9])/giu;

const VERSION_PREFIX_RE =
  /(?:python|node(?:\.js)?|java|go(?:lang)?|rust|react|vue|angular|next(?:\.js)?|typescript|ts|es|http\/?|tls|ipv|utf-?|sha-?|md|dotnet|\.net|c#|asp\.net\s*core|ef\s*core|postgres(?:ql)?|mysql|redis|k8s|docker|ros|s7-?|plc|version|ver\.?|v)\s*$/i;

const EN_MONTH_RE =
  /(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*$/i;

function isDateLikeNumber(text: string, start: number, end: number, rawNumber: string): boolean {
  if (rawNumber.includes(".") || rawNumber.includes(",")) return false;
  const intVal = Number.parseInt(rawNumber, 10);
  const prefix = text.slice(Math.max(0, start - 24), start);
  const suffix = text.slice(end, Math.min(text.length, end + 16));

  // Four-digit year contexts (1900..2100)
  if (intVal >= 1900 && intVal <= 2100) {
    if (EN_MONTH_RE.test(prefix)) return true;
    if (/(?:in|since|during|from|until|through|between)\s*$/i.test(prefix) && /^\s*(?:$|[,.;:)])/.test(suffix)) return true;
    if (/\b\d{4}\s*[-–—/~至]\s*$/.test(prefix)) return true;
    if (/^\s*[-–—/~至]\s*(?:\d{4}|present|current|now|至今)/i.test(suffix)) return true;
    if (/^\s*(?:年|[-./](?:0?[1-9]|1[0-2])(?:\b|[^\d]))/.test(suffix)) return true;
  }

  // Month/day components immediately attached to a 4-digit year (e.g. `2025-09`, `2025.09`, `2025年09月`)
  if (intVal >= 1 && intVal <= 31) {
    if (/(?:19|20)\d{2}\s*[-./年]\s*$/.test(prefix)) return true;
    if (/^\s*月/.test(suffix) && /(?:19|20)\d{2}\s*年\s*$/.test(prefix)) return true;
  }

  return false;
}

function isVersionOrIdentifierContext(text: string, start: number, end: number): boolean {
  const prefix = text.slice(Math.max(0, start - 20), start);
  const suffix = text.slice(end, Math.min(text.length, end + 8));
  if (VERSION_PREFIX_RE.test(prefix)) return true;
  // Semantic version middle/tail segments like `2.14.0` or `v1.3.0`
  if (/^\.\d+/.test(suffix) && /(?:v|version|\.)\s*\d*$/i.test(prefix)) return true;
  if (/\d\.\s*$/.test(prefix)) return true;
  // Common tech abbreviations like P99, P95, L4, B2B, 2C, S3, EC2, K8s
  if (/(?:^|[\s(/（·，,])(?:p|l|s|b|h|t|ec|i|w)\s*$/i.test(prefix)) return true;
  if (/(?:^|[\s(/（·，,])\d+$/.test(prefix + text.slice(start, end)) && /^[a-z]/i.test(suffix)) return true;
  return false;
}

const SCALE_MAP: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  "千": 1_000,
  "万": 10_000,
  m: 1_000_000,
  million: 1_000_000,
  "亿": 100_000_000,
  b: 1_000_000_000,
  billion: 1_000_000_000,
};

function normalizeUnitKind(currency: string, unitLower: string): string {
  if (currency) return currency === "￥" ? "¥" : currency;
  if (unitLower === "%" || unitLower === "percent" || unitLower === "百分点") return "%";
  if (unitLower === "x" || unitLower === "times" || unitLower === "倍") return "x";
  if (unitLower === "秒") return "s";
  if (unitLower === "分钟") return "min";
  if (unitLower === "小时") return "h";
  if (unitLower === "天") return "d";
  if (["ms", "gb", "mb", "tb", "kb", "qps", "tps", "rps"].includes(unitLower)) return unitLower;
  return "";
}

function formatNormalizedNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  // Avoid floating-point dust like 1.5 * 10000 = 15000.000000000002
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return String(rounded);
}

/**
 * Extract normalized numeric claims from text, ignoring version numbers and dates.
 */
export function extractNumericClaims(text: string): NumericClaim[] {
  const claims: NumericClaim[] = [];
  if (!text) return claims;

  for (const match of text.matchAll(NUMBER_CLAIM_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const end = start + raw.length;
    const currency = match.groups?.currency ?? "";
    const rawNumber = (match.groups?.number ?? "").replace(/,/g, "");
    const unitRaw = match.groups?.unit ?? "";
    const unitLower = unitRaw.toLowerCase();

    if (!rawNumber) continue;
    if (!currency && !unitRaw && isVersionOrIdentifierContext(text, start, end)) continue;
    if (!currency && !unitRaw && isDateLikeNumber(text, start, end, rawNumber)) continue;

    const base = Number.parseFloat(rawNumber);
    if (!Number.isFinite(base)) continue;

    const scale = SCALE_MAP[unitLower] ?? 1;
    const normalizedValue = base * scale;
    const kind = normalizeUnitKind(currency, unitLower);
    const key = `${kind}:${formatNormalizedNumber(normalizedValue)}`;

    claims.push({ raw: raw.trim(), key, value: normalizedValue, kind });
  }

  return claims;
}

/**
 * Deterministically verify that `candidateText` does not introduce novel numeric claims
 * absent from `sourceText` (and any explicitly confirmed `additionalFactTexts`).
 */
export function checkRewriteFactPreservation(input: RewritePreservationInput): RewritePreservationReport {
  const allowedSources = [input.sourceText, ...(input.additionalFactTexts ?? [])].filter(Boolean);
  const sourceClaims = allowedSources.flatMap((text) => extractNumericClaims(text));
  const candidateClaims = extractNumericClaims(input.candidateText);

  const sourceCounts = new Map<string, number>();
  for (const claim of sourceClaims) {
    sourceCounts.set(claim.key, (sourceCounts.get(claim.key) ?? 0) + 1);
  }

  const seenCandidateCounts = new Map<string, number>();
  const novelNumbers: string[] = [];
  const novelKeys: string[] = [];

  for (const claim of candidateClaims) {
    const nextCount = (seenCandidateCounts.get(claim.key) ?? 0) + 1;
    seenCandidateCounts.set(claim.key, nextCount);
    const allowedCount = sourceCounts.get(claim.key) ?? 0;
    if (nextCount > allowedCount) {
      novelNumbers.push(claim.raw);
      novelKeys.push(claim.key);
    }
  }

  const uniqueNovel = [...new Set(novelNumbers)];
  const ok = uniqueNovel.length === 0;

  return {
    ok,
    novelNumbers: uniqueNovel,
    novelKeys: [...new Set(novelKeys)],
    sourceNumbers: sourceClaims.map((c) => c.raw),
    candidateNumbers: candidateClaims.map((c) => c.raw),
    summary: ok
      ? {
          zh: "数值保真检查通过，未检测到原文外的新增数字。",
          en: "Numeric grounding check passed — no novel numbers introduced.",
        }
      : {
          zh: `检测到 ${uniqueNovel.length} 处原文未出现的新增数字：${uniqueNovel.join("、")}。请核实是否有真实依据后再采用。`,
          en: `Detected ${uniqueNovel.length} novel number(s) not in the source: ${uniqueNovel.join(", ")}. Verify against real facts before applying.`,
        },
  };
}
