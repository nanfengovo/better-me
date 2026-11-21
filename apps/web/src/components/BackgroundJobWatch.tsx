/** @jsxRuntime automatic */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, BellRing, ChevronLeft, ChevronRight, ExternalLink, Pause, Play, Radar, X } from "lucide-react";
import { z } from "zod";
import {
  JobWatchConfigSchema, JobWatchHandleSchema,
  type JobWatchConfig, type JobWatchHit, type JobWatchStatus,
} from "@better-me/source-adapters/browser-contracts";
import { captureIdentityLease, capturePrivateStorage } from "../lib/identity";
import { resolveResumeJobConnection } from "../lib/resume-job-connection";
import { primaryResumeSkills, uniqueSkills } from "../lib/resume-discovery-criteria";
import { invalidateResumeJobCandidates } from "../lib/resume-job-source";
import { useUiPreferences } from "../lib/ui-preferences";
import { AtlasSettingsDialog } from "./atlas/AtlasSettingsDialog";
import { AtlasDiscoveredSourceReview } from "./atlas/AtlasDiscoveredSourceReview";
import { createBackgroundJobWatchClient } from "./atlas/background-job-watch-client";
import { sourceCatalogIdentity } from "./atlas/source-catalog";
import type { AtlasConnectionIdentity } from "./atlas/connection-session";
import "./resume-job-discovery-dialog.css";
import "./atlas/resume-discovery.css";
import "./background-job-watch.css";

const storageKey = "betterme:background-job-watches:v1";
const noticeKey = "betterme:background-job-watch-notice:";
const changedEvent = "betterme:background-job-watch-changed";
const recordSchema = z.object({ scopeKey: z.string(), name: z.string(), handle: JobWatchHandleSchema, config: JobWatchConfigSchema }).strict();
type WatchRecord = z.infer<typeof recordSchema>;
type WatchEntry = { record: WatchRecord; status?: JobWatchStatus; error?: boolean };
export type BackgroundWatchTarget = {
  scopeKey: string; name: string;
  defaults: { targetRole: string; skills: readonly string[]; location?: string };
};
const pageSize = 30;
const pollMs = 12_000;

function readRecords(storage: Storage): WatchRecord[] {
  const records = new Map<string, WatchRecord>();
  const accept = (raw: unknown) => {
    const record = recordSchema.safeParse(raw);
    if (record.success) records.set(record.data.handle.watchId, record.data);
  };
  try {
    const legacy = JSON.parse(storage.getItem(storageKey) ?? "[]");
    if (Array.isArray(legacy)) legacy.forEach(accept);
  } catch { /* An unrelated damaged record must not hide valid watches. */ }
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(storageKey + ":")) continue;
    try { accept(JSON.parse(storage.getItem(key) ?? "null")); } catch { /* Skip an unreadable record. */ }
  }
  return [...records.values()];
}
function putRecord(storage: Storage, record: WatchRecord) {
  // Separate durable handles prevent simultaneous starts in two windows from losing one task.
  storage.setItem(storageKey + ":" + record.handle.watchId, JSON.stringify(recordSchema.parse(record)));
}
function defaultsFor(target: BackgroundWatchTarget) {
  const primary = primaryResumeSkills(target.defaults.skills);
  return {
    role: target.defaults.targetRole, skills: primary, secondarySkills: target.defaults.skills.filter(skill => !primary.includes(skill)),
    region: target.defaults.location ?? "中国", preferForeignEmployer: true, preferLowTravel: true,
  };
}
const timeText = (value: string | undefined, locale: string) => value
  ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";

export function BackgroundJobWatchCenter({ target, onCloseTarget, onOpenMap }: {
  target?: BackgroundWatchTarget; onCloseTarget: () => void; onOpenMap: () => void;
}) {
  const { t, locale } = useUiPreferences();
  const [storage] = useState(capturePrivateStorage);
  const [entries, setEntries] = useState<WatchEntry[]>(() => readRecords(storage).map(record => ({ record })));
  const [overview, setOverview] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [notice, setNotice] = useState<{ watchId: string; count: number }>();
  const [refresh, setRefresh] = useState(0);
  const localeRef = useRef(locale);
  localeRef.current = locale;

  useEffect(() => {
    const lease = captureIdentityLease();
    if (!lease.ownerId) return;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, lease.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => { if (!signal.aborted) timer = setTimeout(() => void poll(), pollMs); };
    const poll = async () => {
      try {
        lease.assert();
        const records = readRecords(storage);
        if (!records.length) { setEntries([]); return; }
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
        const connection = await resolveResumeJobConnection(requestSignal);
        requestSignal.throwIfAborted();
        const results = connection ? await Promise.all(records.map(async record => {
          try { return { record, status: await createBackgroundJobWatchClient(connection).status(record.handle, requestSignal) }; }
          catch { return { record, error: true }; }
        })) : records.map(record => ({ record, error: true }));
        if (signal.aborted) return;
        lease.assert();
        setEntries(previous => results.map(entry => "error" in entry ? { ...entry, status: previous.find(old => old.record.handle.watchId === entry.record.handle.watchId)?.status } : entry));
        setNotice(previous => {
          if (!previous) return;
          const fresh = results.find(entry => entry.record.handle.watchId === previous.watchId);
          return fresh && "status" in fresh && fresh.status ? fresh.status.unread ? { ...previous, count: fresh.status.unread } : undefined : previous;
        });
        for (const entry of results) {
          if (!("status" in entry) || !entry.status?.unread || !entry.status.latestAlertAt) continue;
          const key = noticeKey + entry.record.handle.watchId;
          const last = storage.getItem(key);
          if (last && last >= entry.status.latestAlertAt) continue;
          storage.setItem(key, entry.status.latestAlertAt);
          setNotice({ watchId: entry.record.handle.watchId, count: entry.status.unread });
          const zh = localeRef.current === "zh";
          if (window.desktopApi?.notifyJobWatch && (document.hidden || !document.hasFocus())) {
            void window.desktopApi.notifyJobWatch().catch(() => {});
          } else if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
            try { new Notification("BetterMe", { body: zh ? "有新的官网岗位等待审阅。" : "New verified jobs are ready for review.", tag: "betterme-job-watch" }); }
            catch { /* The in-app inbox remains available. */ }
          }
        }
      } catch {
        if (!signal.aborted) setEntries(previous => previous.map(entry => ({ ...entry, error: true })));
      } finally { schedule(); }
    };
    const changed = () => { if (!signal.aborted) setRefresh(value => value + 1); };
    const onStorage = (event: StorageEvent) => { if (event.key?.endsWith(storageKey) || event.key?.includes(storageKey + ":")) changed(); };
    window.addEventListener(changedEvent, changed);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", changed);
    void poll();
    return () => { abort.abort(); clearTimeout(timer); window.removeEventListener(changedEvent, changed); window.removeEventListener("storage", onStorage); window.removeEventListener("focus", changed); };
  }, [storage, refresh]);

  useEffect(() => window.desktopApi?.onJobWatchNotice?.(() => { onCloseTarget(); setSelected(undefined); setOverview(true); setNotice(undefined); }), [onCloseTarget]);

  const unread = entries.reduce((total, entry) => total + (entry.status?.unread ?? 0), 0);
  const chosen = entries.find(entry => entry.record.handle.watchId === selected) ?? entries.find(entry => entry.status?.unread) ?? entries[0];
  const active = target ? [...entries].reverse().find(entry => entry.record.scopeKey === target.scopeKey) : chosen;
  const scopeKey = target?.scopeKey ?? active?.record.scopeKey;
  const open = Boolean(target || overview && active);
  function openInbox(watchId?: string) { onCloseTarget(); setSelected(watchId); setOverview(true); setNotice(undefined); }
  function close() { onCloseTarget(); setOverview(false); }
  function updateRecord(record: WatchRecord) {
    captureIdentityLease().assert();
    putRecord(storage, record);
    setEntries(previous => [...previous.filter(entry => entry.record.handle.watchId !== record.handle.watchId), { record }]);
    setRefresh(value => value + 1);
  }
  return <>
    {entries.length > 0 && <button type="button" className="job-watch-bell" aria-haspopup="dialog"
      aria-label={unread ? t(`后台寻岗 · ${unread} 条新提醒`, `Background jobs · ${unread} new alerts`) : t("后台寻岗提醒", "Background job alerts")}
      title={t("后台寻岗提醒", "Background job alerts")} onClick={() => openInbox()}>
      {unread ? <BellRing size={14} /> : <Bell size={14} />}
      {unread > 0 && <span className="job-watch-badge">{unread > 99 ? "99+" : unread}</span>}
    </button>}
    {notice && !open && createPortal(<div className="job-watch-toast" role="status">
      <BellRing size={19} aria-hidden="true" /><div><strong>{t("Agent 发现新岗位", "Agent found new jobs")}</strong><p>{t(`${notice.count} 条官网岗位等待审阅`, `${notice.count} verified jobs ready for review`)}</p></div>
      <button type="button" onClick={() => openInbox(notice.watchId)}>{t("查看", "Review")}</button>
      <button className="job-watch-toast-close" type="button" aria-label={t("关闭提醒", "Dismiss alert")} onClick={() => setNotice(undefined)}><X size={15} /></button>
    </div>, document.body)}
    {open && scopeKey && createPortal(<AtlasSettingsDialog className="resume-job-dialog background-job-watch-dialog"
      title={t("后台寻岗", "Background job discovery")} closeLabel={t("关闭后台寻岗", "Close background job discovery")} onClose={close}>
      {!target && entries.length > 1 && <label className="job-watch-switch">{t("查看任务", "View watch")}<select value={active?.record.handle.watchId} onChange={event => setSelected(event.target.value)}>
        {entries.map(entry => <option key={entry.record.handle.watchId} value={entry.record.handle.watchId}>{entry.record.name}{entry.status?.unread ? ` · ${entry.status.unread} ${t("新", "new")}` : ""}</option>)}
      </select></label>}
      <WatchDetail key={target ? scopeKey : active?.record.handle.watchId} target={target} entry={active} onRecord={updateRecord}
        onChange={() => window.dispatchEvent(new Event(changedEvent))} onOpenMap={() => { close(); onOpenMap(); }} />
    </AtlasSettingsDialog>, document.body)}
  </>;
}

function WatchDetail({ target, entry, onRecord, onChange, onOpenMap }: {
  target?: BackgroundWatchTarget; entry?: WatchEntry; onRecord: (record: WatchRecord) => void; onChange: () => void; onOpenMap: () => void;
}) {
  const { t, locale } = useUiPreferences();
  const initial = entry?.record.config ?? { criteria: defaultsFor(target!), intervalMinutes: 30 as const };
  const [role, setRole] = useState(initial.criteria.role);
  const [primary, setPrimary] = useState(initial.criteria.skills.join(", "));
  const [secondary, setSecondary] = useState(initial.criteria.secondarySkills?.join(", ") ?? "");
  const [region, setRegion] = useState(initial.criteria.region ?? "");
  const [foreign, setForeign] = useState(Boolean(initial.criteria.preferForeignEmployer));
  const [lowTravel, setLowTravel] = useState(Boolean(initial.criteria.preferLowTravel));
  const [interval, setInterval] = useState<JobWatchConfig["intervalMinutes"]>(initial.intervalMinutes);
  const [edit, setEdit] = useState(!entry?.status);
  const [detail, setDetail] = useState<JobWatchStatus>();
  const [connection, setConnection] = useState<AtlasConnectionIdentity>();
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<"matches" | "related">("matches");
  const [request, setRequest] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [enabledSources, setEnabledSources] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const handleRef = useRef(entry?.record.handle);
  const lifetime = useRef<AbortController | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const [notificationPermission, setNotificationPermission] = useState(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const record = entry?.record;
  const watchId = record?.handle.watchId;
  const watchKey = record?.handle.watchKey;

  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => { controller.abort(); activeRequest.current?.abort(); }; }, []);
  useEffect(() => {
    if (!watchId || !watchKey) return;
    const lease = captureIdentityLease(), abort = new AbortController();
    const signal = AbortSignal.any([lease.signal, abort.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
        const session = await resolveResumeJobConnection(requestSignal);
        if (!session) throw new Error();
        const status = await createBackgroundJobWatchClient(session).status({ watchId, watchKey }, requestSignal, offset, view);
        lease.assert(); signal.throwIfAborted();
        setConnection(session); setDetail(status);
      } catch { if (!signal.aborted) setConnection(undefined); }
      finally { if (!signal.aborted) timer = setTimeout(() => void poll(), pollMs); }
    };
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [watchId, watchKey, offset, request, view]);

  const status = detail ?? entry?.status;
  const config = status?.config;
  const paused = status?.phase === "paused";
  const phaseLabel = status?.phase === "searching" ? t("正在探索招聘官网", "Exploring employer sites") : paused ? t("已暂停", "Paused")
    : status?.phase === "retry" ? t("等待自动重试", "Waiting to retry") : t("已开启，等待下一轮", "On · next round scheduled");
  const upcoming = status?.nextRunAt && status.phase !== "searching" ? timeText(status.nextRunAt, locale) : undefined;

  async function command(action: (client: ReturnType<typeof createBackgroundJobWatchClient>, signal: AbortSignal) => Promise<unknown>) {
    if (activeRequest.current || !lifetime.current) return;
    const lease = captureIdentityLease(), controller = new AbortController();
    activeRequest.current = controller;
    const signal = AbortSignal.any([lease.signal, lifetime.current.signal, controller.signal, AbortSignal.timeout(30_000)]);
    setBusy(true); setError("");
    try {
      lease.assert();
      const session = await resolveResumeJobConnection(signal, true);
      if (!session) throw new Error(t("岗位服务未连接，请先连接。", "Connect the job service first."));
      await action(createBackgroundJobWatchClient(session), signal);
      lease.assert(); signal.throwIfAborted();
      setConnection(session); setRequest(value => value + 1); onChange();
    } catch (failure) {
      if (!lease.signal.aborted && !lifetime.current?.signal.aborted) setError(failure instanceof Error ? failure.message : t("未收到任务回执，请重试。", "No watch receipt. Try again."));
    } finally {
      activeRequest.current = null;
      if (!lease.signal.aborted && !lifetime.current?.signal.aborted) setBusy(false);
    }
  }

  function save() {
    const parsed = JobWatchConfigSchema.safeParse({ criteria: {
      role: role.trim(), skills: uniqueSkills(primary), secondarySkills: uniqueSkills(secondary), ...(region.trim() ? { region: region.trim() } : {}),
      preferForeignEmployer: foreign, preferLowTravel: lowTravel,
    }, intervalMinutes: interval });
    if (!parsed.success) { setError(t("请检查岗位方向、核心技能和地区格式。", "Check the role, main skills and region.")); return; }
    const handle = handleRef.current ?? { watchId: crypto.randomUUID(), watchKey: crypto.randomUUID() };
    handleRef.current = handle;
    void command(async (client, signal) => {
      const saved = { scopeKey: record?.scopeKey ?? target!.scopeKey, name: target?.name ?? record!.name, handle, config: parsed.data };
      // Save the owner-scoped recovery handle before starting the durable task.
      onRecord(saved);
      await client.start(handle, parsed.data, signal);
      signal.throwIfAborted();
      setEdit(false); setDetail(undefined); setOffset(0); setView("matches");
    });
  }
  const matchedCount = (status?.priority ?? 0) + (status?.confirm ?? 0);
  const relatedCount = Math.max(0, (status?.total ?? 0) - matchedCount);
  const visibleCount = view === "matches" ? matchedCount : relatedCount;
  function switchView(next: "matches" | "related") { setDetail(undefined); setOffset(0); setView(next); }
  const hits = detail?.hits ?? [];
  const groups = new Map<string, JobWatchHit[]>();
  for (const hit of hits) {
    const name = hit.job.company!;
    const list = groups.get(name) ?? [];
    list.push(hit); groups.set(name, list);
  }
  return <div className="job-watch-content">
    <p className="resume-job-origin">{t("简历", "Resume")} · {target?.name ?? record?.name}</p>
    {status && <section className="job-watch-state" data-phase={status.phase}>
      <div className="job-watch-state-title"><div><Radar size={18} aria-hidden="true" /><strong>{phaseLabel}</strong></div>
        <button type="button" disabled={busy || !handleRef.current} onClick={() => void command((client, signal) => client.enable(handleRef.current!, paused, signal))}>
          {paused ? <Play size={14} /> : <Pause size={14} />}{paused ? t("继续后台寻岗", "Resume watch") : t("暂停", "Pause")}
        </button>
      </div>
      <div className="job-watch-metrics">
        <div><strong>{status.companies}</strong><span>{t("相关公司", "Employers")}</span></div>
        <div><strong>{status.priority}</strong><span>{t("优先匹配", "Priority")}</span></div>
        <div><strong>{status.confirm}</strong><span>{t("出差待确认", "Travel unclear")}</span></div>
        <div><strong>{status.unread}</strong><span>{t("未读提醒", "Unread")}</span></div>
      </div>
      <p className="job-watch-muted">{t(`累计 ${status.rounds} 轮 · 进一步探索 ${status.pages} 个网页线索 · ${status.pendingPages} 个待探索`,
        `${status.rounds} rounds · ${status.pages} further pages checked · ${status.pendingPages} queued`)}{upcoming && ` · ${t("下一轮", "Next")} ${upcoming}`}</p>
      {status.lastRunAt && <p className="job-watch-muted">{t("最近完成", "Last completed")} {timeText(status.lastRunAt, locale)}</p>}
      {!connection && entry?.error && <p role="status">{t("暂时无法读取服务进度，恢复连接后会同步。", "Progress is temporarily unavailable; it will sync on reconnection.")}</p>}
      <details className="job-watch-details"><summary>{t("查看本轮状态", "Round status")}</summary>{status.warnings.length ? <ul>{status.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul> : <p>{t("暂无本轮提示。", "No round messages.")}</p>}</details>
    </section>}
    {!status && record && entry?.error && <p className="job-watch-muted" role="status">{t("正在核对已保存任务。若未收到开启回执，可以重试原任务。", "Checking the saved task. Retry the same watch if the start receipt was lost.")}</p>}
    {status && !edit && <div className="job-watch-criteria-summary">
      <span>{[config?.criteria.role, config?.criteria.skills.join(" / "), config?.criteria.region || t("全部地区", "All regions"),
        config?.criteria.preferForeignEmployer && t("外企优先", "Foreign employers"), config?.criteria.preferLowTravel && t("少出差优先", "Minimal travel")].filter(Boolean).join(" · ")}</span>
      <button type="button" disabled={busy} onClick={() => setEdit(true)}>{t("调整条件", "Edit criteria")}</button>
    </div>}
    {edit && <section className="job-watch-config">
      <div className="job-watch-form">
        <label>{t("目标岗位", "Target role")}<input value={role} onChange={event => setRole(event.target.value)} maxLength={120} /></label>
        <label>{t("核心技能", "Core skills")}<input value={primary} onChange={event => setPrimary(event.target.value)} placeholder="C#, .NET" /></label>
        <label>{t("补充技能", "Additional skills")}<input value={secondary} onChange={event => setSecondary(event.target.value)} placeholder="Python, Vue, React" /></label>
        <label>{t("探索地区", "Search region")}<div className="job-watch-region"><input value={region} onChange={event => setRegion(event.target.value)} maxLength={120} placeholder={t("中国", "China")} /><button type="button" onClick={() => setRegion("中国")}>{t("全国", "China")}</button></div></label>
      </div>
      <div className="job-watch-preferences"><label><input type="checkbox" checked={foreign} onChange={event => setForeign(event.target.checked)} />{t("外企优先", "Prefer foreign employers")}</label>
        <label><input type="checkbox" checked={lowTravel} onChange={event => setLowTravel(event.target.checked)} />{t("少出差优先", "Prefer minimal travel")}</label>
        <label>{t("官网重新查找间隔", "Refresh interval")}<select value={interval} onChange={event => setInterval(Number(event.target.value) as JobWatchConfig["intervalMinutes"])}>{[15,30,60].map(minutes => <option key={minutes} value={minutes}>{t(`${minutes} 分钟`, `${minutes} min`)}</option>)}</select></label>
      </div>
      <p className="job-watch-muted">{t("先确认核心技能与求职地区。Agent 每约 2 分钟探索下一批新线索；一轮范围探索完成后会按设置重新找官网岗位。", "Confirm the core skills and location. The agent explores the next batch about every 2 minutes and refreshes employer listings after each sweep.")}</p>
      {status && <p className="job-watch-muted">{t("修改岗位、技能或地区后会重新整理此任务的待审阅列表。", "Changing the role, skills or region rebuilds this watch’s review list.")}</p>}
      <div className="job-watch-config-actions"><button type="button" className="job-watch-primary" disabled={busy} onClick={save}>{busy ? t("正在保存…", "Saving…") : status ? t("保存条件并继续", "Save criteria and resume") : t("开启后台寻岗", "Start background search")}</button>
        {status && <button type="button" disabled={busy} onClick={() => setEdit(false)}>{t("取消调整", "Cancel edit")}</button>}</div>
    </section>}
    {error && <p role="alert" className="job-watch-error">{error}</p>}
    <p className="job-watch-muted">{t("关闭此面板仍会继续探索。BetterMe 本机岗位服务运行时自动寻岗；服务停止后，在下次启动恢复进度。新发现会出现在顶部铃铛。", "Closing this panel keeps the watch running while the local job service is active. Progress resumes when the service restarts. New findings appear at the top bell.")}</p>
    {!window.desktopApi?.notifyJobWatch && notificationPermission === "default" && <button className="job-watch-notification-setting" type="button" onClick={() => void Notification.requestPermission().then(setNotificationPermission).catch(() => {})}>{t("开启浏览器系统提醒", "Enable browser notifications")}</button>}
    {status && <section className="job-watch-results">
      <header><div><h3>{t("待审阅官网岗位", "Employer jobs to review")}</h3><small>{t("按岗位原文、核心要求、外企依据和出差描述排序。", "Ranked by original posting, core requirements, employer evidence and travel.")}</small></div>
        <button disabled={busy || sourceBusy || !hits.some(hit => hit.unread)} type="button" onClick={() => void command(async (client, signal) => {
          await client.acknowledge(handleRef.current!, hits.filter(hit => hit.unread).map(hit => hit.id), signal); setOffset(0);
        })}>{t("本页提醒标为已读", "Mark page alerts read")}</button>
      </header>
      <div className="job-watch-filter" role="group" aria-label={t("岗位匹配类型", "Match categories")}>
        <button type="button" aria-pressed={view === "matches"} disabled={sourceBusy || busy} onClick={() => { if (view !== "matches") switchView("matches"); }}>{t("优先及待确认", "Priority and review")} <span>{matchedCount}</span></button>
        <button type="button" aria-pressed={view === "related"} disabled={sourceBusy || busy} onClick={() => { if (view !== "related") switchView("related"); }}>{t("其他相关线索", "Other related roles")} <span>{relatedCount}</span></button>
      </div>
      {!visibleCount && <div className="job-watch-empty"><Radar size={27} /><strong>{view === "related" ? t("暂无其他线索", "No related roles yet")
        : status.phase === "paused" ? t("暂无待审阅匹配", "No matches to review") : t("Agent 正在寻找匹配岗位", "Looking for matching jobs")}</strong>
        <p>{t("核对到企业招聘原文后，会在这里显示证据和待审阅公司。", "Verified employer postings and reviewable companies appear here.")}</p></div>}
      {visibleCount > 0 && !detail && <p role="status">{t("正在读取岗位详情…", "Loading job details…")}</p>}
      {[...groups].map(([company, jobs]) => {
        const proposals = new Map(jobs.flatMap(hit => hit.job.sourceProposal ? [[sourceCatalogIdentity(hit.job.sourceProposal), hit.job.sourceProposal] as const] : []));
        return <article className="ard-company job-watch-company" key={company}>
          <h4>{company}</h4>
          {jobs.map(hit => <WatchJob key={hit.id} hit={hit} lastRunAt={status.lastRunAt} />)}
          {connection && [...proposals].map(([id, proposal]) => <AtlasDiscoveredSourceReview key={id} proposal={proposal} {...connection}
            disabled={busy || sourceBusy} onBusy={setSourceBusy} alreadyEnabled={enabledSources.has(id)}
            onEnabled={() => { setEnabledSources(previous => new Set([...previous, id])); invalidateResumeJobCandidates(); }} />)}
          {!proposals.size && (jobs.some(hit => hit.job.sourceId) ? <p className="job-watch-muted">{t("此公司已有采集来源，请到岗位地图核对启用状态。", "Review this company’s existing source in the job map.")} <button type="button" onClick={onOpenMap}>{t("岗位地图", "Job map")}</button></p>
            : <p className="job-watch-muted">{t("当前已发现官网职位；公司采集入口仍待核对。", "Employer posting found; collection entry is pending verification.")}</p>)}
        </article>;
      })}
      {(offset > 0 || visibleCount > pageSize) && <footer className="job-watch-page"><button type="button" disabled={!offset || busy || sourceBusy} onClick={() => { setDetail(undefined); setOffset(value => Math.max(0, value - pageSize)); }}><ChevronLeft size={15} />{t("上一页", "Previous")}</button>
        <span>{Math.floor(offset/pageSize)+1} / {Math.ceil(visibleCount/pageSize)}</span><button type="button" disabled={offset+pageSize >= visibleCount || busy || sourceBusy} onClick={() => { setDetail(undefined); setOffset(value => value + pageSize); }}>{t("下一页", "Next")}<ChevronRight size={15} /></button></footer>}
    </section>}
  </div>;
}

function WatchJob({ hit, lastRunAt }: { hit: JobWatchHit; lastRunAt?: string }) {
  const { t, locale } = useUiPreferences();
  const { job, match } = hit;
  const tier = match.tier === "priority" ? t("优先匹配", "Priority match") : match.tier === "confirm" ? t("出差待确认", "Confirm travel") : t("相关线索", "Related");
  const old = Boolean(lastRunAt && Date.parse(lastRunAt) - Date.parse(hit.lastObservedAt) > 24 * 60 * 60_000);
  const travel = { "not-required": t("无需出差", "No travel required"), "low-frequency": t("低频出差", "Infrequent travel"), required: t("有较高或明确出差要求", "Travel required"), mentioned: t("提到出差", "Travel mentioned"), unknown: t("官网未说明", "Not disclosed") }[job.travel];
  return <div className="job-watch-job">
    <div className="job-watch-job-title"><h5>{job.title}</h5><span className="job-watch-tier" data-tier={match.tier}>{tier}{hit.unread && ` · ${t("新", "New")}`}</span></div>
    <p className="job-watch-muted">{job.location || t("地点未说明", "Location not disclosed")} · {t("上次确认在招", "Last observed open")} {timeText(hit.lastObservedAt, locale)}{old && ` · ${t("超过一天，请重新核对", "Over a day ago · recheck")}`}</p>
    {job.employerGroup ? <p>{t("外企集团依据", "Employer group evidence")} · {job.employerGroup.name} · {job.employerGroup.headquarters} <a href={job.employerGroup.evidenceUrl} target="_blank" rel="noreferrer">{t("出处", "Evidence")}</a></p>
      : job.employerNatureEvidence ? <p>{t("企业披露", "Employer disclosure")} · {job.employerNatureEvidence}</p> : <p className="job-watch-muted">{t("外企背景待确认", "Employer background unconfirmed")}</p>}
    <p>{t("出差", "Travel")} · {travel}{job.travelEvidence && <small className="job-watch-quote">{job.travelEvidence}</small>}</p>
    {match.skillEvidence.length ? <details className="job-watch-details"><summary>{t("核心技能原文", "Core skill evidence")} · {match.skillEvidence.map(item => item.skill).join(" / ")}</summary>
      {match.skillEvidence.map(item => <p key={item.skill}><strong>{item.skill}</strong> · {item.quote}</p>)}</details>
      : <p className="job-watch-muted">{t("核心技能要求尚未明确，建议核对岗位原文。", "Core skill requirements not established. Review the original posting.")}</p>}
    {match.secondaryMatches.length > 0 && <p className="job-watch-muted">{t("原文包含补充技能", "Additional skills in posting")} · {match.secondaryMatches.join(" / ")}</p>}
    <div className="job-watch-link"><a href={job.url} target="_blank" rel="noopener noreferrer">{t("打开招聘官网岗位", "Open employer posting")} <ExternalLink size={13} /></a></div>
    {job.description && <details className="job-watch-details"><summary>{t("查看职位正文", "View job description")}</summary><p className="ard-description">{job.description}</p></details>}
  </div>;
}
