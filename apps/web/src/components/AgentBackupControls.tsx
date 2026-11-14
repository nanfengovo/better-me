import { useEffect, useState } from "react";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import { AGENT_BACKUP_LIMIT, parseAgentBackup } from "../lib/betterme-agent/backup";
import { useUiPreferences } from "../lib/ui-preferences";

type DurabilityState = "checking" | "granted" | "reclaimable" | "unavailable" | "unsupported" | "denied" | "request-failed";

export function AgentBackupControls({ onExport }: { onExport: () => void }) {
  const { agent, snapshot } = useBetterMeAgent();
  const { t } = useUiPreferences();
  const [candidate, setCandidate] = useState<{ text: string; messages: number; memories: number; tasks: number }>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [durabilityState, setDurabilityState] = useState<DurabilityState>("checking");
  useEffect(() => {
    let live = true;
    void navigator.storage?.persisted?.().then(value => { if (live) setDurabilityState(value ? "granted" : "reclaimable"); }).catch(() => { if (live) setDurabilityState("unavailable"); });
    if (!navigator.storage?.persisted) setDurabilityState("unsupported");
    return () => { live = false; };
  }, []);
  if (!agent || !snapshot) return null;
  const durability = {
    checking: t("正在检查浏览器保留策略…", "Checking browser retention policy…"),
    granted: t("浏览器已授予持久保留", "The browser granted persistent storage"),
    reclaimable: t("浏览器可能在空间不足时回收记录", "The browser may reclaim records when storage is low"),
    unavailable: t("无法检查浏览器保留策略", "Browser retention policy could not be checked"),
    unsupported: t("此浏览器不支持持久保留检查", "This browser does not support persistent-storage checks"),
    denied: t("浏览器未授予持久保留，请定期下载备份", "Persistent storage was not granted; download backups regularly"),
    "request-failed": t("本次保留请求未完成，请下载备份", "The retention request did not finish; download a backup"),
  }[durabilityState];
  const blocked = busy || !snapshot.ready || snapshot.saving || Boolean(snapshot.error) || snapshot.data.tasks.some(task => task.status === "running");
  return <details className="agent-backup"><summary data-agent-guide="agent-backup">{t("记忆保存、备份与恢复", "Memory storage, backup and recovery")}</summary>
    <p>{snapshot.data.ownerId ? t("对话、共识索引与任务保存在当前 BetterMe 账号的本机 Agent Host；登录同一服务的同一账号可继续读取。", "Conversations, understanding indexes and tasks are stored by the local Agent Host for this BetterMe account; the same account on the same service can read them again.") : t("对话与共识索引保存在当前浏览器、当前简历的独立空间。", "Conversations and understanding indexes are stored in an isolated space for this browser and resume.")}{t("项目完整对话由配套 Agent 服务保存；未发送草稿留在浏览器。切页和收起不清除记录。", "Full project conversations are stored by the companion Agent service; unsent drafts stay in the browser. Navigating or collapsing this panel does not clear records.")}</p>
    <p>{durability}{t("。", ". ")}{t("简历与未发送草稿不会因登录自动跨浏览器同步；Docker 数据卷不包含浏览器草稿。旧的无归属记录不会自动进入新账号。", "Resumes and unsent drafts do not automatically sync across browsers after sign-in; Docker volumes do not contain browser drafts. Legacy unowned records are not moved into a new account.")}</p>
    <p>{t("这里的 JSON 备份包含对话索引、共识和任务记录，不包含未发送草稿、源码授权或服务端完整会话。简历备份与 Docker 数据卷需分别保存。", "This JSON backup contains conversation indexes, shared understanding and task records. It excludes unsent drafts, source grants and full server sessions. Save resume backups and Docker volumes separately.")}</p>
    <div className="agent-storage-actions"><button type="button" onClick={onExport}>{t("下载当前记录备份", "Download current record backup")}</button><button type="button" disabled={busy || !navigator.storage?.persist} onClick={async () => {
      setBusy(true); try { const granted = await navigator.storage.persist(); setDurabilityState(granted ? "granted" : "denied"); } catch { setDurabilityState("request-failed"); } finally { setBusy(false); }
    }}>{t("请求浏览器保留", "Request persistent storage")}</button></div>
    <label>{t("选择 Agent 记录备份（JSON，最多 8 MB）", "Select an Agent record backup (JSON, up to 8 MB)")}<input type="file" accept="application/json,.json" disabled={blocked} onChange={async event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; setCandidate(undefined); setNotice(""); if (!file) return;
      try { if (file.size > AGENT_BACKUP_LIMIT) throw new Error(t("备份超过 8 MB，未读取或修改记录。", "The backup exceeds 8 MB. No records were read or changed.")); const text = await file.text(); const data = parseAgentBackup(text); setCandidate({ text, messages: data.messages.length, memories: data.memories.length, tasks: data.tasks.length }); }
      catch (error) { setNotice(error instanceof Error ? error.message : t("无法读取备份，原记录未变。", "The backup could not be read. Original records were not changed.")); }
    }} /></label>
    {candidate && <section className="agent-backup-preview" aria-label={t("备份恢复预览", "Backup recovery preview")}><strong>{t(`${candidate.messages} 条对话 · ${candidate.memories} 项共识 · ${candidate.tasks} 项历史任务`, `${candidate.messages} conversations · ${candidate.memories} understanding items · ${candidate.tasks} historical tasks`)}</strong><p>{t("只追加只读档案，不覆盖现有记录、目标、模型、简历或岗位。旧共识需重新确认，文件授权不恢复，历史不会自动发送给模型，也不重发任务。", "Only a read-only archive will be appended. Existing records, goals, models, resumes and jobs are not overwritten. Previous understanding must be reconfirmed, file grants are not restored, history is not sent to a model, and tasks are not resent.")}</p><button type="button" disabled={blocked} onClick={async () => {
      setBusy(true); try { const count = await agent.importBackup(candidate.text); setNotice(t(`已追加 ${count} 项档案，已有记录保持不变；没有重发请求。`, `Appended ${count} archive items. Existing records remain unchanged and no request was resent.`)); setCandidate(undefined); }
      catch (error) { setNotice(error instanceof Error ? error.message : t("恢复未完成，请保留备份。", "Recovery did not finish. Keep the backup.")); } finally { setBusy(false); }
    }}>{busy ? t("正在保存…", "Saving…") : t("确认追加为只读档案", "Append as read-only archive")}</button><button type="button" disabled={busy} onClick={() => setCandidate(undefined)}>{t("取消恢复", "Cancel recovery")}</button></section>}
    <p role="status">{notice || (snapshot.data.tasks.some(task => task.status === "running") ? t("任务完成后可恢复备份；当前任务不会被打断。", "The backup can be restored after the task finishes; the current task will not be interrupted.") : t("备份可能包含个人信息，请只保存在你信任的位置。", "Backups may contain personal information. Store them only in a location you trust."))}</p>
  </details>;
}
