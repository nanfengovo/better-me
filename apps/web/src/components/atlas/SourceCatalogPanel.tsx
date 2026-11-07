/** @jsxRuntime automatic */
import { useMemo, useState } from "react";
import type { SourceDefinition } from "@better-me/opportunities";
import { useUiPreferences } from "../../lib/ui-preferences";
import { availableCatalogEntries, sourceCatalog, type SourceCatalogEntry } from "./source-catalog";
import "./source-catalog.css";

const runtimeText = (source: SourceDefinition, t: (zh: string, en: string) => string) => source.runtime.map(runtime => runtime === "browser-companion"
  ? t("浏览器伴侣", "Browser companion") : runtime === "server" ? t("服务器", "Server") : t("本机服务", "Local service")).join(" · ");
const isDiscoveryLead = (source: SourceDefinition) => source.entityType === "company-directory";

export function SourceCatalogPanel({ installed, busy, connected, onInstall, entries = sourceCatalog }: {
  installed: readonly SourceDefinition[];
  busy: boolean;
  connected: boolean;
  onInstall: (sources: SourceDefinition[]) => void;
  entries?: readonly SourceCatalogEntry[];
}) {
  const { t } = useUiPreferences();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const available = useMemo(() => availableCatalogEntries(entries, installed), [entries, installed]);
  const shown = useMemo(() => availableCatalogEntries(entries, installed, filter), [entries, installed, filter]);
  const chosen = available.filter((entry) => selected.includes(entry.source.sourceId));
  return <section className="atlas-catalog" aria-label={t("扩展可搜索来源", "Expand searchable sources")}>
    <header><h3>{t("扩展可搜索来源", "Expand searchable sources")}</h3><span>{t(`可添加 ${available.length} 个`, `${available.length} available`)}</span></header>
    <p>{t("选择已核对公开端点的企业官网或多公司来源，岗位源可加入主搜索；公司目录和 GitHub 清单会保持待审核线索，不会直接进入岗位地图。每个来源独立保留标签、原文和覆盖限制；不代表全网。", "Add reviewed public company boards or multi-company feeds. Job sources can join the main search; company directories and GitHub lists remain review-required leads and do not enter the job map directly. Each keeps its attribution, original links and coverage limits; this is not whole-web coverage.")}</p>
    <p>{t("技术标签表示来源文本中观察到过这些关键词；公司介绍中的提及不等于岗位要求匹配，具体要求仍需核对。", "Technical tags mark keywords observed in source text. A mention in company copy does not establish a role requirement; review the actual job requirements.")}</p>
    <label>{t("筛选来源目录", "Filter source catalog")}<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("例如 C#、.NET、远程、官网…", "For example C#, .NET, remote, official…")} /></label>
    <div className="atlas-catalog-list">{shown.map((entry) => <article key={entry.source.sourceId}>
      <label className="atlas-catalog-select"><input type="checkbox" checked={selected.includes(entry.source.sourceId)} disabled={busy} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, entry.source.sourceId])] : current.filter((id) => id !== entry.source.sourceId))} /><strong>{entry.source.attribution.label}</strong>{isDiscoveryLead(entry.source) && <span className="atlas-catalog-review-badge">{t("发现线索 · 待审核", "Discovery lead · review required")}</span>}</label>
      <div className="atlas-catalog-tags">{entry.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><p><strong>{t("声明覆盖", "Declared coverage")}: </strong>{entry.coverage}</p>
      <p>{t("接入方式", "Access mode")}: {runtimeText(entry.source, t)} · {t("类型", "Type")}: {isDiscoveryLead(entry.source) ? t("公司目录 / 发现线索", "Company directory / discovery lead") : t("岗位", "Job posting")} · {t("能力", "Capabilities")}: {entry.source.capabilities.join(", ") || t("未声明", "none")}</p>
      <p className="atlas-catalog-limits">{t("每次上限", "Per-run limit")} {entry.source.refreshPolicy.maxRecords} {t("条", "records")} / {entry.source.refreshPolicy.maxPages} {t("页", "pages")} · {t("端点核对", "Endpoint checked")} {entry.checkedAt.slice(0, 10)} · {t("最短刷新间隔", "Minimum refresh interval")} {entry.source.refreshPolicy.minIntervalSeconds} {t("秒", "seconds")} {entry.source.refreshPolicy.maxRequestsPerUtcDay !== undefined && `· ${t("每日最多", "Daily maximum")} ${entry.source.refreshPolicy.maxRequestsPerUtcDay} ${t("次（UTC）", "reads (UTC)")}`}</p>
      <a href={entry.evidenceUrls[0]} target="_blank" rel="noopener noreferrer">{t("查看来源说明", "Source evidence")}</a>
    </article>)}</div>
    {!shown.length && <p>{available.length ? t("没有符合该目录关键词的来源。", "No catalog sources match this filter.") : t("目录来源均已配置。可继续通过企业官网发现或自定义 JSON 扩展。", "All catalog sources are configured. Discover company career pages or import custom JSON to extend further.")}</p>}
    <div className="atlas-catalog-actions"><button type="button" disabled={!connected || busy || !chosen.length} onClick={() => onInstall(chosen.map((entry) => structuredClone(entry.source)))}>{chosen.some((entry) => isDiscoveryLead(entry.source))
      ? t(`保存所选 ${chosen.length} 个来源（线索保持待审核）`, `Save ${chosen.length} selected sources (leads remain review-required)`)
      : t(`添加并启用所选 ${chosen.length} 个来源`, `Add and enable ${chosen.length} selected sources`)}</button><span>{chosen.some((entry) => isDiscoveryLead(entry.source))
        ? t("公司目录不会自动启用，也不会通过普通岗位刷新进入地图。", "Company directories are never enabled automatically and do not enter the map through ordinary job refresh.")
        : t("仅保存来源配置；获取岗位由主搜索明确发起。", "Saves source settings only. Fetch jobs explicitly from the main search.")}</span></div>
  </section>;
}
