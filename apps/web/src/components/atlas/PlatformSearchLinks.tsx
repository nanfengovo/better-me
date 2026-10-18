/** @jsxRuntime automatic */
import {
  PLATFORM_SEARCH_PROVIDERS, PlatformSearchError, buildPlatformSearchRequest, resolvePlatformSearchRegion,
  type PlatformSearchRegion, type PlatformSearchRequest,
} from "@better-me/source-adapters/browser-contracts";
import { useUiPreferences, type UiTranslator } from "../../lib/ui-preferences";
import "./platform-search-links.css";
import { PlatformSearchSessionPanel } from "./PlatformSearchSessionPanel";
import type { PlatformSearchCard } from "../../lib/platform-search-client";

export type PlatformSearchLinksProps = {
  keyword: string;
  regionText: string;
  countryCode: string;
  onOpenSingleJob?: () => void;
  onReviewCard?: (card: PlatformSearchCard, capturedAt: string) => void;
};

type RegionSelection = { region?: PlatformSearchRegion; error?: string };
function selectedRegion(regionText: string, countryCode: string, t: UiTranslator): RegionSelection {
  const text = regionText.trim();
  const country = countryCode.trim().toUpperCase();
  const region = text ? resolvePlatformSearchRegion(text) : country ? resolvePlatformSearchRegion(country) : undefined;
  if ((text || country) && !region) return { error: t(
    `地区“${text || country}”尚无明确的平台映射，请修改地区或补充配置后再搜索。`,
    `No explicit platform mapping is configured for “${text || country}”. Select a supported region or configure its mapping first.`,
  ) };
  if (region && country && region.countryCode !== country) return { error: t(
    `地区“${region.name}”与所选国家或地区 ${country} 不一致，请先调整筛选条件。`,
    `“${region.name}” does not match the selected country or region ${country}. Adjust the location filters first.`,
  ) };
  return { region };
}

function buildError(error: unknown, t: UiTranslator): string {
  if (error instanceof PlatformSearchError && error.code === "unsupported-region") return t(
    "此平台尚无所选地区映射，请选择其他地区或平台。",
    "This platform has no mapping for the selected region. Choose another region or platform.",
  );
  if (error instanceof PlatformSearchError && error.code === "invalid-input") return t(
    "关键词无效：最多 300 个字符，并移除换行或控制字符。",
    "Use at most 300 characters without line breaks or control characters.",
  );
  return t("无法生成此平台的搜索链接，请检查关键词与地区配置。", "Unable to build this platform search link. Check the keyword and region configuration.");
}

function platformNote(request: PlatformSearchRequest, t: UiTranslator): string | undefined {
  if (request.region?.basis === "parameter-only") return t(
    "BOSS 当前仅核对搜索参数，打开后请确认地区；可能需要登录或人工验证。",
    "BOSS search parameters are checked; confirm the region on the platform. Login or human verification may be required.",
  );
  if (request.provider === "linkedin" && request.region) return t(
    "地区以文本提交，请确认 LinkedIn 解析后的地点范围。",
    "Location is submitted as text. Check the location resolved by LinkedIn.",
  );
  return undefined;
}

/** External launch links only; rendering never fetches, imports or updates map results. */
export function PlatformSearchLinks({ keyword, regionText, countryCode, onOpenSingleJob, onReviewCard }: PlatformSearchLinksProps) {
  const { t } = useUiPreferences();
  const selection = selectedRegion(regionText, countryCode, t);
  const inputError = selection.error;
  const searches = PLATFORM_SEARCH_PROVIDERS.map((provider) => {
    if (inputError) return { provider, error: inputError, request: undefined };
    try { return { provider, request: buildPlatformSearchRequest({ provider: provider.id, keyword,
      ...(selection.region ? { regionId: selection.region.id } : {}), }), error: undefined }; }
    catch (error) { return { provider, request: undefined, error: buildError(error, t) }; }
  });
  return <details className="atlas-platform-search" aria-label={t("四平台原站搜索", "Search four original platforms")}>
    <summary>{t("51JOB · BOSS · 猎聘 · LinkedIn 原站搜索", "Search on 51JOB · BOSS · Liepin · LinkedIn")}
      <span>{t("外部搜索", "External search")}</span>
    </summary>
    <p className="atlas-platform-search-disclosure">{t("打开原站搜索；尚未采集到地图。", "Open the original platform search; no jobs have been collected into the map.")}</p>
    <p className="atlas-platform-search-scope">{t("关键词", "Keyword")}：<strong>{keyword.trim() || "—"}</strong> · {t("地区", "Region")}：{selection.region
      ? `${selection.region.name} (${selection.region.countryCode})`
      : regionText.trim() || countryCode.trim() || t("平台默认地区", "Platform default location")}</p>
    {inputError && <p className="atlas-platform-search-error" role="status">{inputError}</p>}
    {!keyword.trim() && !inputError && <p className="atlas-platform-search-note">{t("未填写关键词，将按所选地区浏览岗位；也可以在上方输入岗位或企业名称。", "No keyword: browse the selected region, or enter a role or employer above.")}</p>}
    {!inputError && !selection.region && <p className="atlas-platform-search-note">{t(
      "未指定地区，原站可能使用默认或上次选择的地区，请打开后确认；这不代表全国或全球搜索。",
      "No location is specified. The platform may use its default or last selected location; confirm it on the opened page. This is not a nationwide or worldwide search.",
    )}</p>}
    <ul className="atlas-platform-search-grid">
      {searches.map(({ provider, request, error }) => <li key={provider.id} data-platform-search={provider.id}>
        <strong>{provider.name}</strong>
        {request ? <a href={request.url} target="_blank" rel="noopener noreferrer" aria-label={t(`打开 ${provider.name} 原站搜索`, `Open ${provider.name} search on the original site`)}>
          {t("打开原站搜索", "Open platform search")} <span aria-hidden="true">↗</span>
        </a> : <span className="atlas-platform-search-unavailable" aria-disabled="true">{t("暂不可搜索", "Search unavailable")}</span>}
        {request && platformNote(request, t) && <small>{platformNote(request, t)}</small>}
        {!inputError && error && <small className="atlas-platform-search-error">{error}</small>}
      </li>)}
    </ul>
    <PlatformSearchSessionPanel requests={searches.flatMap((search) => search.request ? [search.request] : [])} onReviewCard={onReviewCard} />
    <div className="atlas-platform-search-followup"><p>{t(
      "在原站选择具体岗位后，可通过单岗读取核对来源并收藏。打开搜索页不会自动导入岗位。",
      "After selecting a specific job on the platform, use the single-job reader to review its source and save it. Opening a search page does not import jobs.",
    )}</p>{onOpenSingleJob && <button type="button" onClick={onOpenSingleJob}>{t("读取 / 收藏单个岗位", "Read / save one job")}</button>}</div>
  </details>;
}
