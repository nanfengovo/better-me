import { AgentStateSchema, type AgentState } from "./storage";

export const AGENT_BACKUP_LIMIT = 8 * 1024 * 1024;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Backups are untrusted data, never instructions, grants, model configuration or executable tasks. */
export function parseAgentBackup(text: string): AgentState {
  if (new TextEncoder().encode(text).byteLength > AGENT_BACKUP_LIMIT) throw new Error("备份超过 8 MB，请分批保留记录；未修改现有数据。");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("不是有效的 Agent JSON 备份，未修改现有记录。"); }
  const result = AgentStateSchema.safeParse(value);
  if (!result.success) throw new Error("备份版本或记录结构不受支持，未修改现有记录。");
  const state = result.data;
  if (state.messages.length > 20000 || state.tasks.length > 10000 || state.memories.length > 2000 || state.events.length > 10000 || state.workspaceKey.length > 512
    || [...state.messages, ...state.tasks, ...state.memories, ...state.events].some(item => item.id.length > 1000 || !item.id || !Number.isFinite(Date.parse(item.at)))) {
    throw new Error("备份记录数量、标识或时间不完整，未修改现有记录。");
  }
  for (const records of [state.messages, state.tasks, state.memories, state.events]) {
    if (new Set(records.map(item => item.id)).size !== records.length) throw new Error("备份中有重复标识，未修改现有记录。");
  }
  return state;
}
export function mergeAgentBackup(current: AgentState, source: AgentState) {
  const next = structuredClone(current);
  const prefix = `backup:${encodeURIComponent(source.workspaceKey)}:`;
  const id = (key: string) => key.startsWith("backup:") ? key : `${prefix}${key}`;
  let added = 0;
  function append<T extends { id: string }>(target: T[], records: T[]) {
    for (const record of records) {
      const existing = target.find(item => item.id === record.id);
      if (existing && canonical(existing) !== canonical(record)) throw new Error("此备份与已恢复的同名记录有冲突；未覆盖任何记录，请保留两份备份另行核对。");
      if (!existing) { target.push(record); added++; }
    }
  }
  append(next.memories, source.memories.map(memory => ({ ...memory, id: id(memory.id), sessionId: id(memory.sessionId), valid: false, shared: false,
    reason: "从备份恢复的只读共识；请回到原文重新建立或核对项目理解，未恢复资料授权。" })));
  append(next.tasks, source.tasks.map(task => ({ ...task, id: id(task.id), memoryIds: task.memoryIds.map(id), remote: undefined,
    status: task.status === "running" || task.status === "waiting" ? "interrupted" as const : task.status,
    detail: "从备份恢复的历史任务，不会自动执行或重发请求。" })));
  append(next.messages, source.messages.map(message => ({ ...message, id: id(message.id), taskId: message.taskId ? id(message.taskId) : undefined,
    memoryIds: message.memoryIds.map(id), archived: true, resumeShared: false, contextRevision: undefined })));
  append(next.events, source.events.map(event => ({ ...event, id: id(event.id), memoryId: event.memoryId ? id(event.memoryId) : undefined })));
  return { state: AgentStateSchema.parse(next), added };
}
