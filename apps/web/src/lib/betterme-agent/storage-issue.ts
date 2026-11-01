import { AgentStorageConflict } from "./storage";

export type AgentStorageIssue = { kind: "connection" | "quota" | "blocked" | "conflict" | "unavailable"; title: string; message: string; retryable: boolean };
/** Presentation boundary: never display raw browser errors, paths or internals. */
export function agentStorageIssue(error: unknown): AgentStorageIssue {
  const name = error instanceof Error ? error.name : "", message = error instanceof Error ? error.message : String(error ?? "");
  if (error instanceof AgentStorageConflict || /另一窗口/.test(message)) return { kind: "conflict", title: "另一窗口已更新 Agent 记录", message: "本页内容仍在，未覆盖另一窗口。请先下载本页记录，再选择重新读取已保存记录。", retryable: false };
  if (name === "QuotaExceededError" || /quota|配额|空间不足/i.test(message)) return { kind: "quota", title: "浏览器存储空间不足", message: "本页记录尚未保存。请先下载备份；释放空间后可重试。不会自动清理任何数据。", retryable: true };
  if (name === "InvalidStateError" || /connection.*clos/i.test(message)) return { kind: "connection", title: "本地记录连接暂时断开", message: "本页内容仍保留。可重连并重试保存；不会重发模型请求或更换提供方。", retryable: true };
  if (name === "VersionError" || /阻塞/.test(message)) return { kind: "blocked", title: "其他窗口正在占用本地记录", message: "请保留当前输入，待其他窗口完成升级后重试。不会删除或重建数据库。", retryable: true };
  return { kind: "unavailable", title: "Agent 本地记录暂不可用", message: "本页内容仍在，但写入失败或记录尚未载入。请下载本页记录并检查浏览器存储权限，再重试。", retryable: true };
}
