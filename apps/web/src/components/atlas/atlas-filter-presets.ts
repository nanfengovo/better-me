import { CompanyColorConfigSchema, getDefaultCompanyColorConfig, type CompanyColorConfig } from "@better-me/opportunities";
import { privateStorage as localStorage } from "../../lib/identity";

export const COLOR_KEY = "better-me:atlas-colors:v1";

const regionNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["zh"], { type: "region" }) : undefined;

export function countryName(code: string): string {
  return regionNames?.of(code) ?? code;
}

export function initialColors(): CompanyColorConfig {
  try {
    const saved = localStorage.getItem(COLOR_KEY);
    if (saved) return CompanyColorConfigSchema.parse(JSON.parse(saved));
  } catch {
    /* Defaults remain available when storage is blocked. */
  }
  return getDefaultCompanyColorConfig();
}

export function colorForCountryCode(code: string, config: CompanyColorConfig): string {
  for (const rule of config.rules) {
    if (rule.jurisdictions?.includes(code)) {
      return rule.color;
    }
    if (rule.group) {
      const group = config.groups.find((g) => g.id === rule.group);
      if (group?.jurisdictions.includes(code)) {
        return rule.color;
      }
    }
  }
  return config.rules.find((r) => r.id === "other-known")?.color ?? config.defaultColor;
}

export const PLATFORM_FILTER_OPTIONS = [
  ["", "全部平台"],
  ["51job", "51Job"],
  ["boss", "BOSS直聘"],
  ["liepin", "猎聘"],
  ["linkedin", "领英"],
  ["tencent", "腾讯招聘"],
  ["official", "官网直聘"],
  ["other", "其他公开源"],
] as const;

export const SALARY_FILTER_OPTIONS = [
  ["", "全部薪资"],
  ["<10k", "10k以下"],
  ["10-20k", "10-20k"],
  ["20-30k", "20-30k"],
  ["30-50k", "30-50k"],
  [">50k", "50k以上"],
  ["negotiable", "薪资面议"],
] as const;

export const DISTANCE_FILTER_OPTIONS = [
  ["", "全部距离"],
  ["5km", "5km内"],
  ["10km", "10km内"],
  ["20km", "20km内"],
  ["30km", "30km内"],
  ["50km", "50km内"],
  ["exact", "精确定位"],
] as const;

export const PUBLICATION_FILTER_OPTIONS = [
  ["", "全部时间"],
  ["3d", "3天内"],
  ["7d", "7天内"],
  ["30d", "30天内"],
  ["90d", "3个月内"],
  [">90d", "3个月前"],
] as const;
