import type { AtlasDataset, JobSearchItem } from "@better-me/opportunities";
import { createAtlasListingPresenter, formatAtlasPublication, type AtlasListingPresentation } from "./presentation";

/**
 * 1. 红框：表明来源的平台
 */
export function formatCardPlatform(item: JobSearchItem): string {
  const source = item.sources?.[0];
  if (!source) return "招聘平台";
  const raw = source.label || source.sourceId || "";
  if (/51job|前程无忧/i.test(raw)) return "51Job";
  if (/boss|直聘/i.test(raw)) return "BOSS直聘";
  if (/liepin|猎聘/i.test(raw)) return "猎聘";
  if (/linkedin|领英/i.test(raw)) return "领英";
  if (/tencent|腾讯/i.test(raw)) return "腾讯招聘";
  if (/bosch|博世/i.test(raw)) return "博世官网";
  if (/abb/i.test(raw)) return "ABB官网";
  if (/arbeitnow/i.test(raw)) return "Arbeitnow";
  if (/remoteok/i.test(raw)) return "RemoteOK";
  if (/temporal/i.test(raw)) return "Temporal官网";
  if (/launchdarkly/i.test(raw)) return "LaunchDarkly官网";
  if (/sentry/i.test(raw)) return "Sentry官网";
  if (/hudl/i.test(raw)) return "Hudl官网";
  return raw.replace(/ · 人工核对卡片$/, "").replace(/ · 官方$/, "").replace(/ · 公共.*$/, "").trim() || "招聘平台";
}

/**
 * 2. 蓝框：标发布距今多少天，超过3个月显示发布的日期
 */
export function formatCardPublication(
  item: JobSearchItem,
  presentations?: readonly AtlasListingPresentation[],
  dataset?: AtlasDataset | null,
): { label: string; tooltip: string; days?: number } {
  const pub = presentations?.[0]?.publication ?? (dataset ? createAtlasListingPresenter(dataset)(item)[0]?.publication : undefined) ?? formatAtlasPublication({});
  // Discovery and collection clocks are not source publication evidence.
  if (pub.status === "review" || pub.status === "unknown") return { label: pub.label, tooltip: pub.raw ? pub.label + " · 来源原文：" + pub.raw : pub.label };
  let days: number | undefined;
  if (pub.publishedAt) {
    const at = Date.parse(pub.publishedAt);
    if (Number.isFinite(at) && at <= Date.now()) days = Math.floor((Date.now() - at) / 86400000);
  } else if (pub.calendarDate) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: pub.timeZone || "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const at = Date.parse(pub.calendarDate + "T00:00:00Z");
    if (Number.isFinite(at)) days = Math.floor((Date.parse(today + "T00:00:00Z") - at) / 86400000);
  }
  if (days === undefined || !Number.isFinite(days) || days < 0) return { label: "发布时间未知", tooltip: "来源没有可确认的发布时间" };
  const date = pub.calendarDate ?? pub.publishedAt!.slice(0, 10);
  return { label: days > 90 ? date : days === 0 ? "今天" : days + "天前", tooltip: pub.label, days };

}

/**
 * 3. 黄框：标距离家的距离
 */
export function formatCardDistance(
  item: JobSearchItem,
  hasAnchor: boolean,
): { label: string; tooltip: string } {
  if (item.distance?.km !== undefined) {
    const km = item.distance.km;
    const isEst = item.distance.estimated;
    const kmText = km < 1 ? "<1" : String(Math.round(km));
    return {
      label: `距家 ${isEst ? "约" : ""}${kmText}km`,
      tooltip: isEst
        ? `距家庭参照点约 ${km.toFixed(1)} km（基于城市中心估算）`
        : `距家庭参照点 ${km.toFixed(1)} km（精确工作地坐标）`,
    };
  }
  if (!hasAnchor) {
    return {
      label: "未设家坐标",
      tooltip: "尚未设置家庭坐标参照点，可在筛选中设置以计算通勤距离",
    };
  }
  return {
    label: "距家 待定位",
    tooltip: "该岗位暂无精确坐标，无法计算直线距离",
  };
}

/**
 * 4. 优先显示已归一化人民币薪资，否则保留来源原币种，不猜币种或面议。
 */
export function formatCardSalaryRMB(item: JobSearchItem): {
  label: string;
  isNegotiable: boolean;
  tooltip: string;
} {
  if (item.salarySelection === "ambiguous") return { label: "多种薪资待核实", isNegotiable: false, tooltip: "多地或多种薪资披露，没有单一可比较金额；请查看详情中的来源记录" };
  if (item.salary?.verification === "conflicting") return { label: "薪资待核实", isNegotiable: false, tooltip: "薪资证据有冲突；来源原文：" + item.salary.raw };
  // 1. If normalized cnyAnnual exists
  if (item.salary?.cnyAnnual && validSalaryBounds(item.salary.cnyAnnual)) {
    const { min, max } = item.salary.cnyAnnual;
    if (min !== undefined && max !== undefined) {
      const minW = (min / 10000).toFixed(min % 10000 === 0 ? 0 : 1);
      const maxW = (max / 10000).toFixed(max % 10000 === 0 ? 0 : 1);
      const label = min === max ? `¥${minW}万/年` : `¥${minW}–${maxW}万/年`;
      return { label, isNegotiable: false, tooltip: `固定税前年薪（人民币）：${label}` };
    }
    if (min !== undefined) {
      const minW = (min / 10000).toFixed(min % 10000 === 0 ? 0 : 1);
      const label = `¥≥${minW}万/年`;
      return { label, isNegotiable: false, tooltip: `固定税前年薪下限（人民币）：${label}` };
    }
    if (max !== undefined) {
      const maxW = (max / 10000).toFixed(max % 10000 === 0 ? 0 : 1);
      const label = `¥≤${maxW}万/年`;
      return { label, isNegotiable: false, tooltip: `固定税前年薪上限（人民币）：${label}` };
    }
  }

  const raw = salaryRaw(item);
  if (!raw) return { label: "薪资未披露", isNegotiable: false, tooltip: "来源未披露薪资，不能视为面议" };
  if (corruptSalary(raw) || !/\d|面议|协商/.test(raw)) return { label: "薪资待核实", isNegotiable: false, tooltip: "来源薪资原文（待核实）：" + raw };
  if (/面议|协商/.test(raw) && !/\d/.test(raw)) return { label: "薪资面议", isNegotiable: true, tooltip: "来源明确披露：" + raw };
  return { label: raw, isNegotiable: false, tooltip: "来源薪资原文：" + raw + (isCnySalary(item, raw) ? "（人民币，未据此推算年薪）" : "（保留原币种；未换算人民币）") };

}

function validSalaryBounds(amount: { min?: number; max?: number }): boolean {
  return (amount.min !== undefined || amount.max !== undefined) && [amount.min, amount.max].every(value => value === undefined || (Number.isFinite(value) && value >= 0)) && !(amount.min !== undefined && amount.max !== undefined && amount.min > amount.max);
}
function salaryRaw(item: JobSearchItem): string {
  return (item.salary?.raw || (item.salaryCandidates.length === 1 ? item.salaryCandidates[0]?.raw : "") || "").trim();
}
function corruptSalary(raw: string): boolean { return /[\p{Co}\uFFFD]/u.test(raw) || [...raw].some(character => character.codePointAt(0)! < 32); }
function salaryCandidate(item: JobSearchItem) {
  return item.salaryCandidates.find(entry => entry.compensationId === item.salary?.compensationId) ?? (item.salaryCandidates.length === 1 ? item.salaryCandidates[0] : undefined);
}
function isCnySalary(item: JobSearchItem, raw: string): boolean {
  if (/USD|EUR|GBP|AUD|CAD|SGD|HKD|US\$|[$€£]|美元|港币|欧元/i.test(raw)) return false;
  return (item.salary?.originalAnnual?.currency ?? salaryCandidate(item)?.originalAnnual?.currency) === "CNY" || /[¥￥]|CNY|RMB|人民币/i.test(raw);
}

/**
 * Monthly salary parsed in k RMB (e.g. 15k-30k)
 */
export function parseSalaryToMonthlyK(item: JobSearchItem): {
  minK?: number;
  maxK?: number;
  isNegotiable: boolean;
} {
  if (item.salarySelection === "ambiguous" || item.salary?.verification === "conflicting") return { isNegotiable: false };
  // 1. Normalized cnyAnnual
  if (item.salary?.cnyAnnual && validSalaryBounds(item.salary.cnyAnnual)) {
    const { min, max } = item.salary.cnyAnnual;
    const minK = min !== undefined ? Math.round(min / 1200) / 10 : undefined;
    const maxK = max !== undefined ? Math.round(max / 1200) / 10 : undefined;
    if (minK !== undefined || maxK !== undefined) {
      return { minK, maxK, isNegotiable: false };
    }
  }

  // 2. Raw candidates
  const raw = salaryRaw(item);
  if (!raw || corruptSalary(raw)) return { isNegotiable: false };
  if (/面议|协商/.test(raw) && !/\d/.test(raw)) return { isNegotiable: true };
  if (!isCnySalary(item, raw) || !/月|年|\/month|\/year/i.test(raw)) return { isNegotiable: false };

  const isAnnual = /年|\/year/i.test(raw);

  // Pattern A: "1.5-3万" or "1.5-3万·13薪" or "10-20k"
  const rangeMatch = /(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*([kK千万元])/.exec(raw);
  if (rangeMatch && rangeMatch[1] && rangeMatch[2] && rangeMatch[3]) {
    let low = parseFloat(rangeMatch[1]);
    let high = parseFloat(rangeMatch[2]);
    const unit = rangeMatch[3];
    if (unit === "万") {
      low *= 10;
      high *= 10;
    }
    if (isAnnual) {
      low = Math.round((low / 12) * 10) / 10;
      high = Math.round((high / 12) * 10) / 10;
    }
    return { minK: low, maxK: high, isNegotiable: false };
  }

  // Pattern B: "8千-1.5万"
  const mixedMatch = /(\d+(?:\.\d+)?)\s*千\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*万/.exec(raw);
  if (mixedMatch && mixedMatch[1] && mixedMatch[2]) {
    let low = parseFloat(mixedMatch[1]);
    let high = parseFloat(mixedMatch[2]) * 10;
    if (isAnnual) {
      low = Math.round((low / 12) * 10) / 10;
      high = Math.round((high / 12) * 10) / 10;
    }
    return { minK: low, maxK: high, isNegotiable: false };
  }

  // Pattern C: "20k以上" / "20k+"
  const plusMatch = /(\d+(?:\.\d+)?)\s*([kK万])\s*(?:以上|\+|起)/.exec(raw);
  if (plusMatch && plusMatch[1] && plusMatch[2]) {
    let val = parseFloat(plusMatch[1]);
    if (plusMatch[2] === "万") val *= 10;
    if (isAnnual) val = Math.round((val / 12) * 10) / 10;
    return { minK: val, isNegotiable: false };
  }

  return { isNegotiable: false };
}

/**
 * Filter match: 按薪资
 */
export function matchCardSalary(item: JobSearchItem, filter: string): boolean {
  if (!filter || filter === "ALL") return true;
  const parsed = parseSalaryToMonthlyK(item);
  if (filter === "negotiable") {
    return parsed.isNegotiable;
  }
  if (parsed.isNegotiable || (parsed.minK === undefined && parsed.maxK === undefined)) {
    return false;
  }
  const minK = parsed.minK ?? parsed.maxK ?? 0;
  const maxK = parsed.maxK ?? parsed.minK ?? 9999;

  switch (filter) {
    case "<10k":
      return minK < 10;
    case "10-20k":
      return !(maxK < 10 || minK > 20);
    case "20-30k":
      return !(maxK < 20 || minK > 30);
    case "30-50k":
      return !(maxK < 30 || minK > 50);
    case ">50k":
      return maxK >= 50 || minK >= 50;
    default:
      return true;
  }
}

/**
 * Filter match: 按平台
 */
export function matchCardPlatform(item: JobSearchItem, filter: string): boolean {
  if (!filter || filter === "ALL") return true;
  const platform = formatCardPlatform(item);
  switch (filter) {
    case "51job":
      return platform === "51Job";
    case "boss":
      return platform === "BOSS直聘";
    case "liepin":
      return platform === "猎聘";
    case "linkedin":
      return platform === "领英";
    case "tencent":
      return platform === "腾讯招聘";
    case "official":
      return platform.includes("官网");
    case "other":
      return !["51Job", "BOSS直聘", "猎聘", "领英", "腾讯招聘"].includes(platform) && !platform.includes("官网");
    default:
      return true;
  }
}

/**
 * Filter match: 按距离
 */
export function matchCardDistance(item: JobSearchItem, filter: string): boolean {
  if (!filter || filter === "ALL") return true;
  if (filter === "exact") {
    return item.distance !== undefined && !item.distance.estimated;
  }
  if (!item.distance) return false;
  const km = item.distance.km;
  switch (filter) {
    case "5km":
      return km <= 5;
    case "10km":
      return km <= 10;
    case "20km":
      return km <= 20;
    case "30km":
      return km <= 30;
    case "50km":
      return km <= 50;
    default:
      return true;
  }
}

/**
 * Filter match: 按发布时间
 */
export function matchCardPublication(
  item: JobSearchItem,
  filter: string,
  presentations?: readonly AtlasListingPresentation[],
  dataset?: AtlasDataset | null,
): boolean {
  if (!filter || filter === "ALL") return true;
  const pub = formatCardPublication(item, presentations, dataset);
  const days = pub.days;
  if (days === undefined) return false;
  switch (filter) {
    case "3d":
      return days <= 3;
    case "7d":
      return days <= 7;
    case "30d":
      return days <= 30;
    case "90d":
      return days <= 90;
    case ">90d":
      return days > 90;
    default:
      return true;
  }
}
