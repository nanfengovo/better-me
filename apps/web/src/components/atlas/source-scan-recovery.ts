import { useCallback, useSyncExternalStore } from "react";
import type { ContinueSourceScanInput, SourceSyncResult } from "@better-me/source-adapters/browser-contracts";
import type { AtlasSourceScopeInput } from "./service-client";

export type AtlasSourceScanWrite = { kind: "refresh"; sourceId: string; input: AtlasSourceScopeInput; key: string }
  | { kind: "continue"; sourceId: string; input: ContinueSourceScanInput; key: string };
export type AtlasSourceScanMode = "jobs" | "discovery-leads";
export type AtlasSourceScanRecovery = { mode?: AtlasSourceScanMode; pending?: AtlasSourceScanWrite; saved?: SourceSyncResult; refreshOnly?: string };
const empty: AtlasSourceScanRecovery = Object.freeze({});
// Connection-scoped, memory-only: closing panels or switching workspaces does not
// turn a lost reply into permission to issue another external scan.
const recoveries = new Map<string, AtlasSourceScanRecovery>(), listeners = new Set<() => void>();
export const atlasSourceScanRecoveryScope = (endpoint: string, token: string) => JSON.stringify([endpoint, token]);
export const readAtlasSourceScanRecovery = (scope: string): AtlasSourceScanRecovery => recoveries.get(scope) ?? empty;
export function writeAtlasSourceScanRecovery(scope: string, value: AtlasSourceScanRecovery) {
  if (value.pending || value.saved || value.refreshOnly) recoveries.set(scope, Object.freeze(structuredClone(value))); else recoveries.delete(scope);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useAtlasSourceScanRecovery(endpoint: string, token: string) {
  const scope = atlasSourceScanRecoveryScope(endpoint, token);
  const getSnapshot = useCallback(() => readAtlasSourceScanRecovery(scope), [scope]);
  return useSyncExternalStore(subscribe, getSnapshot, () => empty);
}
