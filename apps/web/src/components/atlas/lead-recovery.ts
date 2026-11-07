import { useCallback, useSyncExternalStore } from "react";
import type { OriginalLeadImportInput } from "@better-me/source-adapters/browser-contracts";
import type { LeadImportReceipt } from "./lead-client";

export type AtlasLeadWrite = { input: OriginalLeadImportInput; key: string; jobId: string };
export type AtlasLeadRecovery = { pending?: AtlasLeadWrite; saved?: { receipt: LeadImportReceipt; leadId: string;
  original: { sourceId: string; sourceRecordId: string; url: string } }; active?: true };
const empty: AtlasLeadRecovery = Object.freeze({});
const states = new Map<string, AtlasLeadRecovery>(), owners = new Map<string, string>(), listeners = new Set<() => void>();
function freezeRecovery<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freezeRecovery(entry);
    Object.freeze(value);
  }
  return value;
}
export const atlasLeadRecoveryScope = (endpoint: string, token: string) => JSON.stringify([endpoint, token]);
export const readAtlasLeadRecovery = (scope: string): AtlasLeadRecovery => states.get(scope) ?? empty;
/** Memory only: closing a pane or switching a view cannot discard an unconfirmed command. */
export function writeAtlasLeadRecovery(scope: string, value: AtlasLeadRecovery) {
  const next = { ...structuredClone(value), ...(owners.has(scope) ? { active: true as const } : {}) };
  if (next.pending || next.saved || next.active) states.set(scope, freezeRecovery(next)); else states.delete(scope);
  for (const listener of listeners) listener();
}
export function beginAtlasLeadRecovery(scope: string): string | undefined {
  if (owners.has(scope)) return undefined;
  const owner = crypto.randomUUID(); owners.set(scope, owner); writeAtlasLeadRecovery(scope, readAtlasLeadRecovery(scope)); return owner;
}
export function endAtlasLeadRecovery(scope: string, owner: string) {
  if (owners.get(scope) !== owner) return;
  owners.delete(scope);
  const { active: _active, ...state } = readAtlasLeadRecovery(scope); void _active;
  writeAtlasLeadRecovery(scope, state);
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useAtlasLeadRecovery(endpoint: string, token: string) {
  const scope = atlasLeadRecoveryScope(endpoint, token), snapshot = useCallback(() => readAtlasLeadRecovery(scope), [scope]);
  return useSyncExternalStore(subscribe, snapshot, () => empty);
}
