import { useCallback, useSyncExternalStore } from "react";
import type { ConfirmCompanyControlReviewInput, RevokeCompanyControlReviewInput, CompanyControlReviewReceipt } from "@better-me/opportunities";

export type AtlasCompanyControlWrite = { kind: "confirm"; input: ConfirmCompanyControlReviewInput; key: string }
  | { kind: "revoke"; input: RevokeCompanyControlReviewInput; key: string };
export type AtlasCompanyControlRecovery = { pending?: AtlasCompanyControlWrite; saved?: CompanyControlReviewReceipt };
const empty: AtlasCompanyControlRecovery = Object.freeze({});
// Memory only. Neither evidence drafts nor service identities enter browser storage.
const recoveries = new Map<string, AtlasCompanyControlRecovery>();
const listeners = new Set<() => void>();
export const atlasCompanyControlRecoveryScope = (endpoint: string, token: string) => JSON.stringify([endpoint, token]);
export const readAtlasCompanyControlRecovery = (scope: string): AtlasCompanyControlRecovery => recoveries.get(scope) ?? empty;
export function writeAtlasCompanyControlRecovery(scope: string, value: AtlasCompanyControlRecovery) {
  if (value.pending || value.saved) recoveries.set(scope, Object.freeze(value)); else recoveries.delete(scope);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** Workspace stays subscribed while a panel is closed or another data mode is selected. */
export function useAtlasCompanyControlRecovery(endpoint: string, token: string) {
  const scope = atlasCompanyControlRecoveryScope(endpoint, token);
  const getSnapshot = useCallback(() => readAtlasCompanyControlRecovery(scope), [scope]);
  return useSyncExternalStore(subscribe, getSnapshot, () => empty);
}
