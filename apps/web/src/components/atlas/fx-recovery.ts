import { useCallback, useSyncExternalStore } from "react";
import type { ActivateFxSnapshotInput, ConfirmFxImportInput, FxMutationReceipt } from "@better-me/opportunities";

export type AtlasFxWrite = { kind: "import"; input: ConfirmFxImportInput; key: string }
  | { kind: "activate"; input: ActivateFxSnapshotInput; key: string };
export type AtlasFxRecovery = { pending?: AtlasFxWrite; saved?: FxMutationReceipt };
const empty: AtlasFxRecovery = Object.freeze({});
// Memory only. Credentials, original write bodies and keys never enter browser storage.
const recoveries = new Map<string, AtlasFxRecovery>();
const listeners = new Set<() => void>();
export const atlasFxRecoveryScope = (endpoint: string, token: string) => JSON.stringify([endpoint, token]);
export const readAtlasFxRecovery = (scope: string): AtlasFxRecovery => recoveries.get(scope) ?? empty;
export function writeAtlasFxRecovery(scope: string, value: AtlasFxRecovery) {
  if (value.pending || value.saved) recoveries.set(scope, Object.freeze(value)); else recoveries.delete(scope);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** Always subscribed at the workspace boundary, even when the FX panel is closed. */
export function useAtlasFxRecovery(endpoint: string, token: string) {
  const scope = atlasFxRecoveryScope(endpoint, token);
  const getSnapshot = useCallback(() => readAtlasFxRecovery(scope), [scope]);
  return useSyncExternalStore(subscribe, getSnapshot, () => empty);
}
