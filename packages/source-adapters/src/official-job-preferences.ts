import type { OfficialJobDiscoveryCandidate } from "./official-job-discovery-contracts.js";

const TRAVEL = /\btravel(?:ling|ing)?\b|business trip|出差|驻场|客户现场/i;
const NO_TRAVEL = /\bno (?:business )?travel(?: (?:is )?(?:required|expected|necessary)\b|\s*[.,;。；]|$)|\btravel (?:is )?not required|(?:^|\b)0\s*%\s*(?:business )?travel\b|\btravel\s*[:：-]\s*0\s*%(?!\s*[-–~])|无需出差|不需要出差|无出差(?:要求)?|零出差/i;
const LOW_TRAVEL = /occasionally|occasional|rare(?:ly)?|infrequent|年[度均]?\s*[一两二1-2]\s*次|偶尔|偶发|少量出差|低频出差/i;
const HIGH_TRAVEL = /frequent|regular(?:ly)?|must (?:be able to )?travel|travel (?:is )?required|required to travel|需要(?:经常|定期)?出差|长期驻场|频繁出差|经常出差|定期出差/i;
const FOREIGN = /外商独资(?:企业|公司)?|外资企业|外资公司|(?:德国|法国|美国|英国|日本|瑞士|荷兰|瑞典)(?:独资|跨国|企业|公司)|foreign[- ](?:owned|invested) (?:company|enterprise|subsidiary)|(?:French|German|American|Japanese|Swiss|British|Dutch|Swedish) (?:multinational|company|corporation)/i;
function travelLevel(line: string): OfficialJobDiscoveryCandidate["travel"] {
  const range = String.raw`(\d{1,3}(?:\.\d+)?)\s*(?:[-–~至到]\s*(\d{1,3}(?:\.\d+)?)\s*)?%`;
  const percentages: number[] = [];
  for (const pattern of [
    new RegExp(String.raw`(?:travel|出差)(?:\s+(?:is|of|up|to|about|around|roughly|approximately|expected|required|estimated|at|maximum)|[\s:：-]|比例|约占|时间|最多|不超过){0,12}${range}`, "gi"),
    new RegExp(String.raw`${range}\s*(?:business\s+)?(?:travel|出差)`, "gi"),
  ]) {
    for (const match of line.matchAll(pattern)) percentages.push(Number(match[2] ?? match[1]));
  }
  const ceiling = percentages.length ? Math.max(...percentages) : undefined;
  if (ceiling !== undefined && ceiling > 10) return "required";
  if (HIGH_TRAVEL.test(line) && !NO_TRAVEL.test(line) && !LOW_TRAVEL.test(line) && !ceiling) return "required";
  if ((ceiling !== undefined && ceiling > 0) || LOW_TRAVEL.test(line)) return "low-frequency";
  if (NO_TRAVEL.test(line) && !/\b(?:except|but|unless)\b|偶尔|可能|有时|除非|客户现场|customer site/i.test(line)) return "not-required";
  return "mentioned";
}
function snippet(text: string, pattern: RegExp): string {
  const position = text.search(pattern);
  const start = Math.max(0, position - 140);
  return text.slice(start, start + 430);
}
/** Preferences are supported by text attributable to this role or the named hiring organization. */
export function describeJobPreferences(text: string, company: string): Pick<OfficialJobDiscoveryCandidate,
  "travel" | "travelEvidence" | "employerNature" | "employerNatureEvidence"> {
  // Workday often puts the value on the line after the "Travel Required:" field label.
  const fields = text.replace(/(\btravel(?: required)?|出差(?:要求|频率)?)\s*[:：]\s*\n+\s*(?=occasional|rare|infrequent|frequent|regular|none\b|\d|偶尔|无需|经常)/gi, "$1: ");
  const lines = fields.split(/(?<=[。！!?;；])|(?<=\.)\s+(?=[A-Z])|\n+/u).map(line => line.trim()).filter(Boolean);
  const travel = lines.filter(line => TRAVEL.test(line)).map(line => ({ line, level: travelLevel(line) }));
  const level = (["required", "mentioned", "low-frequency", "not-required"] as const).find(value => travel.some(item => item.level === value)) ?? "unknown";
  const travelEvidence = travel.sort((a, b) => Number(b.level === level) - Number(a.level === level)).slice(0, 2).map(item => snippet(item.line, TRAVEL)).join(" / ");
  const name = company.trim().toLowerCase();
  const nature = lines.find(line => {
    const mention = line.search(FOREIGN);
    if (mention < 0) return false;
    const before = line.slice(0, mention).slice(-150).toLowerCase();
    const after = line.slice(mention).replace(FOREIGN, "").slice(0, 32);
    if (/^\s*(?:的)?(?:客户|供应商|合作伙伴|clients?|customers?|partners?|suppliers?)/i.test(after)) return false;
    if (/客户|供应商|合作方|client|customer|partner|supplier|vendor|(?:并非|不是|not)\s*(?:an?\s*)?$/i.test(before)) return false;
    return /(?:本公司|本企业|我们|我司|we (?:are|are part of)|our company is|the company is)[^。.!?;；]{0,35}$/i.test(before)
      || Boolean(name && before.includes(name) && /(?:是|为|属于|为一家|\bis\b|\ban?\b|[,，:：])[^。.!?;；]{0,45}$/i.test(before));
  });
  return { travel: level, ...(travelEvidence ? { travelEvidence } : {}), employerNature: nature ? "foreign-disclosed" : "unknown",
    ...(nature ? { employerNatureEvidence: snippet(nature, FOREIGN) } : {}) };
}
