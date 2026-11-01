import { useEffect, useState } from "react";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import { AGENT_BACKUP_LIMIT, parseAgentBackup } from "../lib/betterme-agent/backup";

export function AgentBackupControls({ onExport }: { onExport: () => void }) {
  const { agent, snapshot } = useBetterMeAgent();
  const [candidate, setCandidate] = useState<{ text: string; messages: number; memories: number; tasks: number }>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [durability, setDurability] = useState("正在检查浏览器保留策略…");
  useEffect(() => {
    let live = true;
    void navigator.storage?.persisted?.().then(value => { if (live) setDurability(value ? "浏览器已授予持久保留" : "浏览器可能在空间不足时回收记录"); }).catch(() => { if (live) setDurability("无法检查浏览器保留策略"); });
    if (!navigator.storage?.persisted) setDurability("此浏览器不支持持久保留检查");
    return () => { live = false; };
  }, []);
  if (!agent || !snapshot) return null;
  const blocked = busy || !snapshot.ready || snapshot.saving || Boolean(snapshot.error) || snapshot.data.tasks.some(task => task.status === "running");
  return <details className="agent-backup"><summary>记忆保存、备份与恢复</summary>
    <p>对话与共识索引保存在当前浏览器、当前简历的独立空间。项目完整对话由配套 Agent 服务保存；未发送草稿留在浏览器。切页和收起不清除记录。</p>
    <p>{durability}。换浏览器、清理站点或更换访问地址不会自动迁移；Docker 数据卷不包含浏览器记录。</p>
    <p>这里的 JSON 备份包含对话索引、共识和任务记录，不包含未发送草稿、源码授权或服务端完整会话。简历备份与 Docker 数据卷需分别保存。</p>
    <div className="agent-storage-actions"><button type="button" onClick={onExport}>下载当前记录备份</button><button type="button" disabled={busy || !navigator.storage?.persist} onClick={async () => {
      setBusy(true); try { const granted = await navigator.storage.persist(); setDurability(granted ? "浏览器已授予持久保留" : "浏览器未授予持久保留，请定期下载备份"); } catch { setDurability("本次保留请求未完成，请下载备份"); } finally { setBusy(false); }
    }}>请求浏览器保留</button></div>
    <label>选择 Agent 记录备份（JSON，最多 8 MB）<input type="file" accept="application/json,.json" disabled={blocked} onChange={async event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; setCandidate(undefined); setNotice(""); if (!file) return;
      try { if (file.size > AGENT_BACKUP_LIMIT) throw new Error("备份超过 8 MB，未读取或修改记录。"); const text = await file.text(); const data = parseAgentBackup(text); setCandidate({ text, messages: data.messages.length, memories: data.memories.length, tasks: data.tasks.length }); }
      catch (error) { setNotice(error instanceof Error ? error.message : "无法读取备份，原记录未变。"); }
    }} /></label>
    {candidate && <section className="agent-backup-preview" aria-label="备份恢复预览"><strong>{candidate.messages} 条对话 · {candidate.memories} 项共识 · {candidate.tasks} 项历史任务</strong><p>只追加只读档案，不覆盖现有记录、目标、模型、简历或岗位。旧共识需重新确认，文件授权不恢复，历史不会自动发送给模型，也不重发任务。</p><button type="button" disabled={blocked} onClick={async () => {
      setBusy(true); try { const count = await agent.importBackup(candidate.text); setNotice(`已追加 ${count} 项档案，已有记录保持不变；没有重发请求。`); setCandidate(undefined); }
      catch (error) { setNotice(error instanceof Error ? error.message : "恢复未完成，请保留备份。"); } finally { setBusy(false); }
    }}>{busy ? "正在保存…" : "确认追加为只读档案"}</button><button type="button" disabled={busy} onClick={() => setCandidate(undefined)}>取消恢复</button></section>}
    <p role="status">{notice || (snapshot.data.tasks.some(task => task.status === "running") ? "任务完成后可恢复备份；当前任务不会被打断。" : "备份可能包含个人信息，请只保存在你信任的位置。")}</p>
  </details>;
}
