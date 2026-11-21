/** @jsxRuntime automatic */
import { useEffect, useRef, useState } from "react";
import type { SourceDefinition } from "@better-me/opportunities";
import { useUiPreferences } from "../../lib/ui-preferences";
import { AtlasSourceServiceError, createAtlasSourceClient, type AtlasRegisterSource } from "./service-client";
import { sourceCatalogIdentity } from "./source-catalog";

interface Props {
  proposal: SourceDefinition;
  endpoint: string;
  token: string;
  disabled: boolean;
  alreadyEnabled?: boolean;
  onBusy: (busy: boolean) => void;
  onEnabled?: () => void;
}

export function AtlasDiscoveredSourceReview({ proposal, endpoint, token, disabled, alreadyEnabled, onBusy, onEnabled }: Props) {
  const { t } = useUiPreferences();
  const [status, setStatus] = useState<"available" | "enabled" | "review" | "retry">(alreadyEnabled ? "enabled" : "available");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const pending = useRef<{ key: string; registration: AtlasRegisterSource } | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);

  async function enable() {
    if (disabled || active.current || status === "enabled" || status === "review") return;
    const controller = new AbortController();
    const { signal } = controller;
    active.current = controller; setBusy(true); onBusy(true); setMessage("");
    const client = createAtlasSourceClient(endpoint, token);
    try {
      if (!pending.current) {
        const snapshot = await client.browseSnapshot({ signal });
        signal.throwIfAborted();
        const identity = sourceCatalogIdentity(proposal);
        const existing = snapshot.sources.find(s => s.sourceId === proposal.sourceId)
          ?? snapshot.sources.find(s => sourceCatalogIdentity(s) === identity);
        if (existing) {
          const enabled = sourceCatalogIdentity(existing) === identity && existing.enabled && existing.status === "active";
          setStatus(enabled ? "enabled" : "review");
          setMessage(enabled ? t("这个公司来源已启用。", "This company source is already enabled.") :
            t("已有来源需要核对，请打开公司采集来源查看配置。", "Review the existing configuration in company sources."));
          return;
        }
        pending.current = { key: crypto.randomUUID(), registration: {
          source: { ...proposal, enabled: true, status: "active" }, expectedRevision: snapshot.revision,
        } };
      }
      await client.register(pending.current.registration, { signal, idempotencyKey: pending.current.key });
      signal.throwIfAborted();
      pending.current = null; setStatus("enabled");
      setMessage(t("已加入公司采集。下次采集新岗位时可以选择这个来源。", "Company source added. Select it the next time you collect jobs."));
      onEnabled?.();
    } catch (failure) {
      if (signal.aborted) return;
      if (failure instanceof AtlasSourceServiceError && failure.code === "stale-version") {
        pending.current = null; setStatus("available");
        setMessage(t("来源配置已发生变化，请重新核对后启用。", "Source configuration changed. Review it again before enabling."));
      } else {
        setStatus(pending.current ? "retry" : "available");
        setMessage(failure instanceof Error ? failure.message : t("未收到来源回执。", "Source receipt was not received."));
      }
    } finally {
      active.current = null;
      if (!signal.aborted) { setBusy(false); onBusy(false); }
    }
  }

  return <details className="ard-source-review"><summary>{status === "enabled" ? t("已加入公司采集", "Company source enabled") : t("将公司加入岗位采集", "Add company to job collection")} · {proposal.attribution.label}</summary>
    {proposal.attribution.homepageUrl && <p>{t("公司招聘板", "Company careers board")} · <a href={proposal.attribution.homepageUrl} target="_blank" rel="noopener noreferrer">{proposal.attribution.homepageUrl}</a></p>}
    <p>{t("本次启用的采集地址", "Source endpoint to enable")} · <a href={proposal.entryUrl} target="_blank" rel="noopener noreferrer">{proposal.entryUrl}</a></p>
    <p>{t("采集范围", "Scope")} · {proposal.options?.countryCode && typeof proposal.options.countryCode === "string" ? proposal.options.countryCode + " · " : ""}
      {t(`此招聘板每次最多 ${proposal.refreshPolicy.maxPages} 页、${proposal.refreshPolicy.maxRecords} 条。`,
         `Up to ${proposal.refreshPolicy.maxPages} pages and ${proposal.refreshPolicy.maxRecords} records per run on this board.`)}</p>
    {proposal.entryUrl && new URL(proposal.entryUrl).hostname.endsWith(".myworkdayjobs.com") && <p className="ard-hint">{t("此招聘板可能包含集团内其他招聘主体和地区的岗位。", "This careers board may include roles from other subsidiaries and locations.")}</p>}
    {proposal.attribution.usage === "link-only" && <p>{t("来源使用范围 · 仅链接", "Source usage · links only")}</p>}
    <p className="ard-hint">{t("启用后由你在地图中发起岗位采集。", "Start collection from the map after enabling the source.")}</p>
    <button type="button" disabled={disabled || busy || status === "enabled" || status === "review"} onClick={() => void enable()}>
      {busy ? t("正在核对公司来源…", "Checking company source…") : status === "enabled" ? t("来源已启用", "Source enabled") :
        status === "review" ? t("已有配置待核对", "Review existing configuration") : status === "retry" ?
          t("使用原请求重试", "Retry original request") : t("确认启用公司来源", "Confirm and enable company source")}
    </button>
    {message && <p role="status">{message}</p>}
  </details>;
}
