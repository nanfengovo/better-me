import type { AtlasDataset, JobSearchItem } from "@better-me/opportunities";
import type { AtlasListingPresentation } from "./presentation";

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
  const pub = presentations?.[0]?.publication;
  let targetDate: Date | undefined;

  // Direct parsed timestamp from publication badge
  if (pub?.publishedAt) {
    const d = new Date(pub.publishedAt);
    if (!isNaN(d.getTime())) targetDate = d;
  } else if (pub?.calendarDate && /^\d{4}-\d{2}-\d{2}$/.test(pub.calendarDate)) {
    const d = new Date(`${pub.calendarDate}T00:00:00.000Z`);
    if (!isNaN(d.getTime())) targetDate = d;
  }

  // Check raw publication text
  const raw = pub?.raw?.trim() || "";
  if (!targetDate && raw) {
    const matchDate = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(raw);
    if (matchDate && matchDate[1] && matchDate[2] && matchDate[3]) {
      const d = new Date(`${matchDate[1]}-${matchDate[2].padStart(2, "0")}-${matchDate[3].padStart(2, "0")}T00:00:00.000Z`);
      if (!isNaN(d.getTime())) targetDate = d;
    } else if (raw.includes("刚刚") || raw.includes("今天") || /小时前|分钟前/.test(raw)) {
      return { label: "今天", tooltip: `发布时间原文：${raw}`, days: 0 };
    } else if (raw.includes("昨天")) {
      return { label: "1天前", tooltip: `发布时间原文：${raw}`, days: 1 };
    } else {
      const matchDays = /(\d+)\s*天前/.exec(raw);
      if (matchDays && matchDays[1]) {
        const days = parseInt(matchDays[1], 10);
        if (days <= 90) return { label: `${days}天前`, tooltip: `发布时间原文：${raw}`, days };
        const d = new Date(Date.now() - days * 86400000);
        const ymd = d.toISOString().slice(0, 10);
        return { label: ymd, tooltip: `发布时间原文：${raw}`, days };
      }
    }
  }

  // Fallback to dataset listing firstDiscoveredAt or observation fetchedAt
  if (!targetDate && dataset && item.job.listingIds.length > 0) {
    for (const listingId of item.job.listingIds) {
      const listing = dataset.listings.find((l) => l.id === listingId);
      if (listing?.observationIds?.length) {
        for (const obsId of listing.observationIds) {
          const obs = dataset.observations.find((o) => o.id === obsId);
          if (obs?.sourcePublishedAt) {
            const d = new Date(obs.sourcePublishedAt);
            if (!isNaN(d.getTime())) { targetDate = d; break; }
          }
          if (obs?.fetchedAt && !targetDate) {
            const d = new Date(obs.fetchedAt);
            if (!isNaN(d.getTime())) targetDate = d;
          }
        }
      }
      if (targetDate) break;
      if (listing?.firstDiscoveredAt) {
        const d = new Date(listing.firstDiscoveredAt);
        if (!isNaN(d.getTime())) targetDate = d;
      }
    }
  }

  if (targetDate) {
    const now = Date.now();
    const diffMs = now - targetDate.getTime();
    const diffDays = Math.max(0, Math.floor(diffMs / (24 * 3600 * 1000)));
    const dateStr = targetDate.toISOString().slice(0, 10);
    if (diffDays > 90) {
      // 超过3个月显示发布的日期
      return { label: dateStr, tooltip: `发布日期：${dateStr}（距今 ${diffDays} 天）`, days: diffDays };
    }
    if (diffDays === 0) return { label: "今天", tooltip: `今日发布（${dateStr}）`, days: 0 };
    return { label: `${diffDays}天前`, tooltip: `发布时间：${dateStr}（${diffDays} 天前）`, days: diffDays };
  }

  return { label: "近期发布", tooltip: "来源未标明具体发布时间，按近期收录展示", days: 30 };
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
 * 4. 右上角绿框：标薪资范围单位都是人民币
 */
export function formatCardSalaryRMB(item: JobSearchItem): {
  label: string;
  isNegotiable: boolean;
  tooltip: string;
} {
  // 1. If normalized cnyAnnual exists
  if (item.salary?.cnyAnnual) {
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

  // 2. If raw salary is available in salary or candidates
  const rawCandidate = item.salary?.raw || item.salaryCandidates?.[0]?.raw;
  if (rawCandidate && typeof rawCandidate === "string" && rawCandidate.trim()) {
    const raw = rawCandidate.trim();
    if (/面议|协商|待定|不限/.test(raw)) {
      return { label: "薪资面议", isNegotiable: true, tooltip: "薪资待双方沟通核对" };
    }
    // Prefix with ¥ if pure number range or k/w range
    if (/^[0-9]+(\.[0-9]+)?[kK千万元]/.test(raw) || /^[0-9]+(\.[0-9]+)?-[0-9]+/.test(raw)) {
      return { label: `¥${raw}`, isNegotiable: false, tooltip: `来源披露薪资（人民币）：¥${raw}` };
    }
    if (raw.startsWith("¥") || raw.startsWith("￥")) {
      return { label: raw, isNegotiable: false, tooltip: `来源披露薪资（人民币）：${raw}` };
    }
    const matchRange = /(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*([kK千万元])([·\s\S]*)?/.exec(raw);
    if (matchRange && matchRange[1] && matchRange[2] && matchRange[3]) {
      const formatted = `¥${matchRange[1]}-${matchRange[2]}${matchRange[3].toUpperCase()}${matchRange[4] ? ` ${matchRange[4].trim()}` : ""}`;
      return { label: formatted, isNegotiable: false, tooltip: `来源披露薪资（人民币）：${formatted}` };
    }
    return { label: `¥${raw}`, isNegotiable: false, tooltip: `来源薪资（人民币）：¥${raw}` };
  }

  return { label: "薪资面议", isNegotiable: true, tooltip: "来源未披露固定薪资范围" };
}

/**
 * Monthly salary parsed in k RMB (e.g. 15k-30k)
 */
export function parseSalaryToMonthlyK(item: JobSearchItem): {
  minK?: number;
  maxK?: number;
  isNegotiable: boolean;
} {
  // 1. Normalized cnyAnnual
  if (item.salary?.cnyAnnual) {
    const { min, max } = item.salary.cnyAnnual;
    const minK = min !== undefined ? Math.round(min / 1200) / 10 : undefined;
    const maxK = max !== undefined ? Math.round(max / 1200) / 10 : undefined;
    if (minK !== undefined || maxK !== undefined) {
      return { minK, maxK, isNegotiable: false };
    }
  }

  // 2. Raw candidates
  const raw = (item.salary?.raw || item.salaryCandidates?.[0]?.raw || "").trim();
  if (!raw || /面议|协商|待定|不限/.test(raw)) {
    return { isNegotiable: true };
  }

  const isAnnual = /年|年薪|\/年/.test(raw);

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

  return { isNegotiable: true };
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
  if (parsed.isNegotiable) {
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
  const days = pub.days ?? (pub.label === "今天" ? 0 : pub.label === "1天前" ? 1 : 30);
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
