/** @jsxRuntime automatic */
import { useUiPreferences } from "../lib/ui-preferences";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectResume } from "@better-me/core";
import {
  HISTORY_LIMIT,
  describeDocumentChanges,
  getDocumentFieldChanges,
  type BetterMeDocument,
  type DocumentFieldChange,
  type DocumentVersion,
  type LocalDocumentHistory,
  type PersistenceStatus,
} from "@better-me/storage";
import { Clock3, GitBranch, RotateCcw, Save, Trash2, X } from "lucide-react";
import { ResumeTemplate, resolveResumeTemplate } from "./ResumeTemplate";
import { useConfirm } from "./ConfirmationDialog";
import { localizeFieldChangeLabel, localizeFieldRestoreReason, localizeDocumentSummary } from "../lib/ui-document-diff";

type Props = {
  history: LocalDocumentHistory;
  currentDocument: BetterMeDocument;
  persistenceStatus?: PersistenceStatus;
  onRestore: (version: DocumentVersion) => Promise<boolean>;
  onRestoreField: (version: DocumentVersion, change: DocumentFieldChange) => Promise<boolean>;
  onCheckpoint: (label: string) => Promise<boolean>;
  onClose: () => void;
};

export function formatVersionTime(time: string, locale: "zh" | "en" = "zh"): string {
  return new Date(time).toLocaleString(locale === "en" ? "en-GB" : "zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function VersionHistoryPanel({ history, currentDocument, persistenceStatus, onRestore, onRestoreField, onCheckpoint, onClose }: Props) {
  const { t, locale } = useUiPreferences();
  const KIND_LABELS = { automatic: t("自动保存", "Autosave"), checkpoint: t("手动检查点", "Named checkpoint"), restore: t("恢复版本", "Restored version"), import: t("导入版本", "Imported version") };

  const confirm = useConfirm();
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busyRef = useRef(false);
  const operation = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const refresh = useCallback(async () => {
    const request = ++operation.current;
    setLoading(true);
    try {
      const next = await history.list();
      if (request !== operation.current) return;
      setVersions(next);
      setSelectedId((previous) => next.some((item) => item.id === previous) ? previous : next[0]?.id ?? "");
      setError("");
    } catch (err) {
      if (request === operation.current) setError(err instanceof Error ? err.message : t("版本读取失败，请重试。", "Could not load versions. Try again."));
    } finally {
      if (request === operation.current) setLoading(false);
    }
  }, [history, t]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    void refresh();
    closeRef.current?.focus();
    return () => {
      operation.current += 1;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [refresh]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest(".confirmation-dialog")) return;
      if (event.key === "Escape" && !busyRef.current) onClose();
      if (event.key === "Tab") {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex='0']") ?? []).filter((item) => item.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, busy]);

  const selected = versions.find((item) => item.id === selectedId);
  const changes = useMemo(() => selected ? describeDocumentChanges(currentDocument, selected.document) : [], [currentDocument, selected]);
  const fieldChanges = useMemo(() => selected ? getDocumentFieldChanges(currentDocument, selected.document) : [], [currentDocument, selected]);
  const preview = useMemo(() => {
    if (!selected) return null;
    const view = selected.document.resumeViews.find((item) => item.id === selected.document.activeResumeId);
    return view ? projectResume(selected.document.factBase, view) : null;
  }, [selected]);

  function beginOperation(): boolean {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    return true;
  }
  function finishOperation() {
    busyRef.current = false;
    setBusy(false);
  }

  async function createCheckpoint() {
    if (!beginOperation()) return;
    try {
      const saved = await onCheckpoint(label.trim() || `${t("检查点", "Checkpoint")} ${new Date().toLocaleTimeString(locale === "en" ? "en-GB" : "zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`);
      if (!saved) { setError(t("检查点未保存。请先补齐无效字段，或检查本地存储状态。当前编辑仍保留。", "Checkpoint not saved. Complete invalid fields or check local storage. Current edits are retained.")); return; }
      setLabel("");
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : t("检查点保存失败，当前编辑仍保留。", "Checkpoint save failed. Current edits are retained.")); }
    finally { finishOperation(); }
  }
  async function restoreSelected() {
    if (!selected || !beginOperation()) return;
    try {
      if (await onRestore(selected)) onClose();
      else setError(t("恢复未完成，当前简历未被替换。请检查存储空间或下载备份。", "Restore did not complete. The current resume was not replaced. Check storage space or download a backup."));
    } catch (err) { setError(err instanceof Error ? err.message : t("恢复失败，当前简历未被替换。", "Restore failed. The current resume was not replaced.")); }
    finally { finishOperation(); }
  }
  async function restoreField(change: DocumentFieldChange) {
    if (!selected || !change.restore.available || !beginOperation()) return;
    try {
      if (!(await onRestoreField(selected, change))) {
        setError(t("此项恢复未完成，当前编辑仍保留。请检查存储状态后重试。", "This item was not restored. Current edits are retained. Check storage and try again."));
        return;
      }
      await refresh();
      const label = localizeFieldChangeLabel(change, t);
      setNotice(t(`已恢复「${label}」，其他编辑保留。`, `Restored “${label}”; other edits are retained.`));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("此项恢复失败，当前编辑仍保留。", "This item could not be restored. Current edits are retained."));
    } finally { finishOperation(); }
  }
  async function deleteSelected() {
    if (!selected || !beginOperation()) return;
    try {
      if (!(await confirm(t(`删除「${selected.label}」的本地历史快照？当前正在编辑的简历将继续保留。`, `Delete the local history snapshot “${selected.label}”? Your current resume edits will be retained.`), { title: t("删除历史快照", "Delete history snapshot"), confirmLabel: t("删除快照", "Delete snapshot"), danger: true }))) return;
      await history.delete(selected.id);
      await refresh();
    }
    catch (err) { setError(err instanceof Error ? err.message : t("版本删除失败。", "Could not delete the version.")); }
    finally { finishOperation(); }
  }

  return (
    <div className="no-print fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-3 backdrop-blur-sm sm:p-6">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="history-title" className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-white/50 bg-[#f7f8fa] shadow-2xl">
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-slate-900 text-white"><GitBranch size={20} /></span>
            <div><h2 id="history-title" className="text-lg font-semibold tracking-tight text-slate-900">{t("版本时光机", "Version history")}</h2><p className="mt-1 text-xs text-slate-500">{t("预览、比较，再回到你需要的那一版。", "Preview, compare and restore the version you need.")}</p></div>
          </div>
          <button ref={closeRef} type="button" onClick={() => { if (!busyRef.current) onClose(); }} disabled={busy} aria-label={t("关闭版本历史", "Close version history")} className="rounded-xl p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-40"><X size={20} /></button>
        </header>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white/80 px-6 py-4">
          <label htmlFor="checkpoint-name" className="text-xs font-semibold text-slate-600">{t("保存检查点", "Save checkpoint")}</label>
          <input id="checkpoint-name" value={label} disabled={busy} onChange={(event) => setLabel(event.target.value)} placeholder={t("例如：投递前 · 前端开发版", "For example: Before applying · Frontend role")} maxLength={100} className="min-w-44 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 disabled:opacity-40" />
          <button type="button" onClick={() => void createCheckpoint()} disabled={busy || loading} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"><Save size={14} />{busy ? t("正在处理…", "Processing…") : t("命名并保存", "Name and save")}</button>
          <p className="w-full text-[11px] leading-5 text-slate-500">{t(`此浏览器保留最近 ${HISTORY_LIMIT} 个完整版本（含命名检查点）。自动版本按「保存设置」中的间隔合并，草稿保护不生成历史；命名检查点独立保留。恢复后的保存结果会在面板内显示；仍有未完成字段时先保护为本地草稿，补齐并保存后再生成完整版本。长期留存请下载 JSON 备份。`, `This browser keeps the latest ${HISTORY_LIMIT} complete versions, including named checkpoints. Automatic versions merge according to Save settings; drafts do not create history. Named checkpoints stay separate. Restore results appear here; incomplete content is protected as a local draft until it is completed and saved. Download a JSON backup for long-term retention.`)}</p>
        </div>
        {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-6 py-3 text-xs text-amber-800"><span>{error}</span><button type="button" disabled={busy} onClick={() => void refresh()} className="rounded border border-amber-300 px-3 py-1">{t("重新读取", "Reload")}</button></div>}
        {notice && <div className="space-y-1 border-b border-emerald-200 bg-emerald-50 px-6 py-3 text-xs text-emerald-800">
          <p role="status" aria-label={t("单项恢复状态", "Field restore status")}>{notice}</p>
          {persistenceStatus && <p aria-label={t("恢复保存状态", "Restore save status")}>{persistenceStatus.message}</p>}
          {persistenceStatus?.kind === "draft" && <p>{t("当前仅保护为本地草稿，尚未生成恢复后的完整版本。", "Currently protected as a local draft only; a complete restored version has not been created.")}</p>}
          {persistenceStatus?.historyError && <p role="alert" className="text-amber-800">{t("历史记录未完整保存：", "History was not fully saved:")}{persistenceStatus.historyError}</p>}
        </div>}
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[300px_1fr]">
          <aside aria-label={t("历史版本列表", "History versions")} className="max-h-64 overflow-y-auto border-b border-slate-200 bg-white p-4 md:max-h-none md:border-r md:border-b-0">
            <p className="mb-3 px-1 text-[10px] text-slate-500">{t("时间：北京时间 · Asia/Shanghai（UTC+8）", "Time: Beijing · Asia/Shanghai (UTC+8)")}</p>
            {loading && <p role="status" className="px-2 py-6 text-sm text-slate-500">{t("正在读取版本…", "Loading versions…")}</p>}
            {!loading && versions.length === 0 && <div className="px-2 py-7 text-sm leading-6 text-slate-500">{t("还没有历史版本。完整修改会自动产生快照，也可以先保存一个命名检查点。", "No history yet. Complete edits create automatic snapshots, or you can save a named checkpoint.")}</div>}
            <ol className="space-y-2">
              {versions.map((version, index) => <li key={version.id}><button type="button" disabled={busy} onClick={() => { if (!busyRef.current) { setSelectedId(version.id); setNotice(""); setError(""); } }} aria-pressed={selectedId === version.id} className={`w-full rounded-2xl border p-3 text-left transition ${selectedId === version.id ? "border-slate-900 bg-slate-900 text-white shadow-sm" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}>
                <div className="flex items-center justify-between gap-2 text-[10px] font-medium opacity-65"><span>{KIND_LABELS[version.kind]}</span>{index === 0 && <span>{t("最新", "Latest")}</span>}</div>
                <div className="mt-2 break-words text-sm font-semibold">{version.label}</div>
                <div className="mt-2 flex items-center gap-1.5 text-[11px] opacity-65"><Clock3 size={11} />{formatVersionTime(version.createdAt, locale)}</div>
              </button></li>)}
            </ol>
          </aside>
          <div className="min-w-0 overflow-auto p-4 sm:p-6">
            {selected && preview ? <>
              <div className="mb-5 rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div><h3 className="text-sm font-semibold text-slate-900">{selected.label}</h3><p className="mt-1 text-xs text-slate-500">{t("当前内容 → 所选版本的变化", "Current content → selected version")}</p></div>
                  <button type="button" disabled={busy} onClick={() => void deleteSelected()} className="inline-flex items-center gap-1 rounded-lg p-2 text-xs text-slate-500 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-40"><Trash2 size={13} />{t("删除快照", "Delete snapshot")}</button>
                </div>
                {changes.length > 0 ? <ul className="mt-3 flex flex-wrap gap-2" aria-label={t("版本差异", "Version differences")}>{changes.map((change) => <li key={change} className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs text-slate-600">{localizeDocumentSummary(change, t)}</li>)}</ul> : <p className="mt-3 text-xs text-slate-500">{t("与当前简历内容一致。", "Identical to the current resume content.")}</p>}
                {fieldChanges.length > 0 && <details key={selected.id} className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60">
                  <summary className="cursor-pointer px-3 py-3 text-xs font-semibold text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500">{t(`查看逐项差异（${fieldChanges.length} 项）`, `View individual differences (${fieldChanges.length} items)`)}</summary>
                  <div aria-label={t("逐项版本差异", "Individual version differences")} role="region" tabIndex={0} className="max-h-80 overflow-auto border-t border-slate-200 px-3 pb-3">
                    <div className="sticky top-0 grid grid-cols-2 gap-2 bg-slate-50 py-2 text-[10px] font-semibold text-slate-500"><span>{t("当前正在编辑", "Current edits")}</span><span>{t("所选历史版本", "Selected history version")}</span></div>
                    <ol className="space-y-3">
                      {fieldChanges.map((change) => {
                        const label = localizeFieldChangeLabel(change, t);
                        return <li key={change.id} className="rounded-lg border border-slate-200 bg-white p-3">
                        <div className="mb-2 flex flex-wrap items-start gap-2"><span className="min-w-0 flex-1 break-words text-xs font-semibold text-slate-700">{label}</span><span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{change.kind === "added" ? t("恢复将新增", "Restoring adds this") : change.kind === "removed" ? t("恢复将移除", "Restoring removes this") : t("恢复将修改", "Restoring changes this")}</span></div>
                        <div className="grid grid-cols-2 gap-2 text-[11px] leading-5"><p className="min-w-0 whitespace-pre-wrap break-words rounded-md bg-rose-50/70 px-2 py-2 text-slate-600" aria-label={t("当前值", "Current value")}>{change.before}</p><p className="min-w-0 whitespace-pre-wrap break-words rounded-md bg-emerald-50/70 px-2 py-2 text-slate-700" aria-label={t("所选版本值", "Selected version value")}>{change.after}</p></div>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                          <p className="min-w-0 flex-1 text-[10px] leading-5 text-slate-500">{localizeFieldRestoreReason(change, t) ?? (change.restore.available ? t("仅采用此项所选版本的内容，其他编辑保留。", "Apply only this item from the selected version; keep other edits.") : t("此项暂不支持单独恢复，可检查后使用完整版本恢复。", "This item cannot be restored separately. Review it before using complete-version restore."))}</p>
                          <button type="button" aria-label={t(`恢复此项：${label}`, `Restore this item: ${label}`)} disabled={busy || loading || !change.restore.available} onClick={() => void restoreField(change)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40"><RotateCcw size={12} />{t("恢复此项", "Restore this item")}</button>
                        </div>
                      </li>;
                      })}
                    </ol>
                    <p className="mt-3 text-[10px] text-slate-500">{t(`已列出全部 ${fieldChanges.length} 项差异。左侧是当前内容，右侧是恢复后采用的内容。`, `Showing all ${fieldChanges.length} differences. Current content is on the left; the selected content to restore is on the right.`)}</p>
                  </div>
                </details>}
                <button type="button" disabled={busy} onClick={() => void restoreSelected()} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"><RotateCcw size={14} />{t("恢复为新版本", "Restore as a new version")}</button>
              </div>
              <div className="overflow-x-auto rounded-2xl bg-slate-200/60 p-3" aria-label={t("所选版本简历预览", "Selected version resume preview")}><div className="history-resume-preview origin-top-left" style={{ zoom: 0.68 }}><ResumeTemplate resume={preview} templateId={resolveResumeTemplate(preview.templateId)} showAvatar /></div></div>
            </> : <div className="grid min-h-64 place-items-center text-sm text-slate-400">{t("选择版本查看简历与差异", "Select a version to preview and compare")}</div>}
          </div>
        </div>
      </section>
    </div>
  );
}
