import { z } from "zod";
import { DocumentSchema } from "@better-me/storage";
import { agentOrigin, captureIdentity, currentPrincipal, ownedFetch } from "./identity";
import { readRuntimeConnection } from "./runtime-connection";
import { documentDatabase } from "./private-storage";
import { UnderstandingSessionSchema } from "@better-me/agent-contracts";

const Archive = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/), label: z.string(), createdAt: z.string(),
  documents: z.array(z.object({ key: z.string(), label: z.string(), source: z.string(), documentId: z.string() })),
  artifactCount: z.number(), agentWorkspaces: z.number(), sessionCount: z.number(),
  sessions: z.array(z.object({ id: z.string(), label: z.string(), messageCount: z.number(), phase: z.string() })) });
export type RecoveryArchive = z.infer<typeof Archive>;
async function read(route: string) {
  const owner = currentPrincipal()?.id; if (!owner) throw new Error("请先登录原账号。");
  const response = await ownedFetch(`${agentOrigin()}/api/v1/agent/recovery${route}`, {
    headers: { Authorization: `Bearer ${readRuntimeConnection()?.agentToken ?? "better-me-agent-token"}` },
  });
  if (!response.ok) throw new Error("当前账号的恢复档案不可用；未替换或覆盖任何文档。");
  return z.object({ ownerId: z.literal(owner) }).passthrough().parse(await response.json());
}
export async function listRecoveryArchives(): Promise<RecoveryArchive[]> {
  return z.array(Archive).parse((await read("")).archives);
}
export async function readRecoverySession(reference: string) {
  if (!/^[a-f0-9]{32}\.[a-zA-Z0-9_-]{1,100}$/.test(reference)) throw new Error("会话恢复地址无效。");
  const [id, key] = reference.split(".");
  return UnderstandingSessionSchema.parse((await read(`/${id}/sessions/${key}`)).session);
}
/** Seed only a missing draft in one atomic IDB transaction. Never replace an existing working copy. */
export async function prepareRecoverySpace(space: string): Promise<void> {
  const assert = captureIdentity(); assert();
  const [id, key] = space.split(".");
  if (!id || !key || !/^[a-f0-9]{32}\.[a-zA-Z0-9_-]{1,100}$/.test(space)) throw new Error("恢复地址无效。");
  const databaseName = documentDatabase("better-me:document-draft:v1", space);
  const payload = await read(`/${id}/documents/${key}`); assert();
  const document = DocumentSchema.parse(payload.document);
  const raw = JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), document });
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("无法建立恢复工作副本，原资料保持不变。"));
    request.onblocked = () => reject(new Error("恢复库被其他窗口占用，请保留原页面稍后重试。"));
  });
  try {
    assert();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("drafts", "readwrite"), store = transaction.objectStore("drafts");
      const request = store.get("active");
      request.onsuccess = () => {
        try { assert(); if (request.result === undefined) store.add(raw, "active"); }
        catch { transaction.abort(); }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new Error("恢复工作副本未写入，已有资料未覆盖。"));
    });
    assert();
  } finally { database.close(); }
}
