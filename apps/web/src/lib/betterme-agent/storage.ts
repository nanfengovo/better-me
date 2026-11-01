import { z } from "zod";

export const Origin = z.enum(["writing", "companion", "growth", "understanding"]);
export type AgentOrigin = z.infer<typeof Origin>;
const Message = z.object({
  id: z.string(), origin: Origin, role: z.enum(["user", "assistant", "event"]), text: z.string(), at: z.string(),
  taskId: z.string().optional(), memoryIds: z.array(z.string()).default([]),
  contextRevision: z.number().int().optional(),
  resumeShared: z.boolean().optional(),
}).strict();
const Memory = z.object({
  id: z.string(), sessionId: z.string(), workspaceKey: z.string(), projectKey: z.string(), targetKey: z.string(),
  sourceText: z.string(), fieldText: z.string().optional(), label: z.string(), revision: z.number().int(), summaryHash: z.string(), summary: z.string(),
  valid: z.boolean(), shared: z.boolean(), at: z.string(), reason: z.string().optional(),
}).strict();
const Task = z.object({
  id: z.string(), origin: Origin, label: z.string(), destination: z.string(), at: z.string(), updatedAt: z.string(),
  status: z.enum(["running", "waiting", "completed", "failed", "cancelled", "interrupted"]),
  detail: z.string().optional(), memoryIds: z.array(z.string()),
  remote: z.object({ sessionId: z.string(), turnCount: z.number().int(), targetKey: z.string().optional() }).optional(),
}).strict();
const GrowthEvent = z.object({ id: z.string(), kind: z.enum(["consensus", "resume-applied", "plan-adopted", "evidence", "task-status"]),
  label: z.string(), at: z.string(), origin: Origin, memoryId: z.string().optional() }).strict();
export const AgentStateSchema = z.object({
  version: z.literal(1), workspaceKey: z.string(), revision: z.number().int().nonnegative(),
  messages: z.array(Message), memories: z.array(Memory), tasks: z.array(Task), events: z.array(GrowthEvent),
  tracking: z.boolean(), goal: z.string().max(4000).default(""), contextRevision: z.number().int().default(0),
  selection: z.object({ kind: z.enum(["current", "chatgpt"]), profileId: z.string(), model: z.string() }).strict(),
}).strict();
export type AgentState = z.infer<typeof AgentStateSchema>;
export type AgentMessage = AgentState["messages"][number];
export type AgentTask = AgentState["tasks"][number];
export type AgentMemory = AgentState["memories"][number];
export type AgentGrowthEvent = AgentState["events"][number];
export function emptyAgentState(workspaceKey: string): AgentState {
  return { version: 1, workspaceKey, revision: 0, messages: [], memories: [], tasks: [], events: [], tracking: false, goal: "", contextRevision: 0,
    selection: { kind: "current", profileId: "", model: "" } };
}
export class AgentStorageConflict extends Error {
  constructor() { super("另一窗口已更新 BetterMe Agent。未覆盖对方记录；请先下载本页记录，再重新读取。"); }
}
export interface AgentRepository {
  load(key: string): Promise<AgentState | undefined>;
  save(state: AgentState, expectedRevision: number): Promise<void>;
}
function checked(value: unknown, key: string) {
  if (value === undefined) return undefined;
  const parsed = AgentStateSchema.safeParse(value);
  if (!parsed.success || parsed.data.workspaceKey !== key) throw new Error("Agent 记录无法安全读取，原始记录未覆盖。请保留浏览器数据并检查备份。");
  return parsed.data;
}
export function createMemoryAgentRepository(): AgentRepository {
  const states = new Map<string, AgentState>();
  return {
    async load(key) { return structuredClone(states.get(key)); },
    async save(state, expected) {
      if ((states.get(state.workspaceKey)?.revision ?? 0) !== expected || state.revision !== expected + 1) throw new AgentStorageConflict();
      states.set(state.workspaceKey, AgentStateSchema.parse(structuredClone(state)));
    },
  };
}
/** A new, independent database. Never opens resume, job, credential or coach stores. */
export class IndexedDbAgentRepository implements AgentRepository {
  private database?: Promise<IDBDatabase>;
  private open() {
    return this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("better-me:agent-continuity:v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("workspaces");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Agent 本地记录暂时无法打开；不会清理其他数据。"));
      request.onblocked = () => reject(new Error("Agent 记录升级被其他窗口阻塞，请保留当前输入。"));
    });
  }
  async load(key: string) {
    const database = await this.open();
    return new Promise<AgentState | undefined>((resolve, reject) => {
      const tx = database.transaction("workspaces", "readonly"), request = tx.objectStore("workspaces").get(key);
      tx.oncomplete = () => { try { resolve(checked(request.result, key)); } catch (error) { reject(error); } };
      tx.onerror = () => reject(tx.error ?? new Error("Agent 记录读取失败。"));
      tx.onabort = () => reject(tx.error ?? new Error("Agent 记录读取中断。"));
    });
  }
  async save(state: AgentState, expectedRevision: number) {
    const safe = AgentStateSchema.parse(state), database = await this.open();
    return new Promise<void>((resolve, reject) => {
      const tx = database.transaction("workspaces", "readwrite"), store = tx.objectStore("workspaces");
      let failure: unknown;
      const request = store.get(safe.workspaceKey);
      request.onsuccess = () => {
        try {
          const previous = checked(request.result, safe.workspaceKey);
          if ((previous?.revision ?? 0) !== expectedRevision || safe.revision !== expectedRevision + 1) throw new AgentStorageConflict();
          store.put(safe, safe.workspaceKey);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error("Agent 记录未保存，请下载备份后再关闭页面。"));
    });
  }
}
