import { z } from "zod";
import { agentOrigin, captureIdentity, currentPrincipal, ownedFetch } from "../lib/identity";
import { readRuntimeConnection } from "../lib/runtime-connection";

export class OwnedRecordConflict extends Error {
  constructor() { super("另一窗口已修改此账号记录，未覆盖；请先下载本页备份，再重新读取。"); this.name = "OwnedRecordConflict"; }
}

/** Owner comes from the signed-in cookie, not the requested workspace or record contents. */
export function createOwnedRecords(namespace: "continuity" | "growth") {
  const owner = currentPrincipal()?.id, assertIdentity = captureIdentity();
  async function request(key: string, body?: unknown) {
    assertIdentity();
    if (!owner || currentPrincipal()?.id !== owner) throw new Error("请先登录 BetterMe 本机账号，未读取其他人的记录。");
    const response = await ownedFetch(`${agentOrigin()}/api/v1/agent/records/${namespace}?key=${encodeURIComponent(key)}`, {
      method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${readRuntimeConnection()?.agentToken ?? "better-me-agent-token"}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    assertIdentity();
    if (response.status === 409) throw new OwnedRecordConflict();
    if (!response.ok) throw new Error("当前账号的本机记录暂不可用，未覆盖已有内容。请检查 Agent Host 后重试。");
    const payload = z.object({ ownerId: z.literal(owner), revision: z.number().int().nonnegative(), value: z.unknown().optional() }).parse(await response.json());
    assertIdentity(); return payload;
  }
  return {
    async load(key: string) { return (await request(key)).value ?? undefined; },
    async save(key: string, expectedRevision: number, value: unknown) { await request(key, { expectedRevision, value }); },
  };
}
