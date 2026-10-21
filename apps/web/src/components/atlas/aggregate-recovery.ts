import { useCallback, useSyncExternalStore } from "react";
import { AtlasSourceServiceError, type AtlasSourceScopeInput, type AtlasSourceSync } from "./service-client";

export type AtlasAggregateRecoveryEntry = {
  sourceId: string; label: string; input: AtlasSourceScopeInput; key: string; receipt?: AtlasSourceSync; rejected?: true;
};
export type AtlasAggregateRecovery = { entries: readonly AtlasAggregateRecoveryEntry[]; active: boolean };
const empty: AtlasAggregateRecovery = Object.freeze({ entries: Object.freeze([]), active: false });
const states = new Map<string, AtlasAggregateRecovery>(), owners = new Map<string, string>(), listeners = new Set<() => void>();
// Memory-only and connection-scoped. Neither a panel lifecycle nor a changed
// search filter grants permission to replace an unconfirmed write with a new key.
export const atlasAggregateRecoveryScope = (endpoint: string, token: string) => JSON.stringify([endpoint, token]);
export const readAtlasAggregateRecovery = (scope: string): AtlasAggregateRecovery => states.get(scope) ?? empty;
function publish(scope: string, entries: readonly AtlasAggregateRecoveryEntry[]) {
  const active = owners.has(scope);
  if (entries.length || active) states.set(scope, Object.freeze({ entries: Object.freeze(structuredClone(entries)), active }));
  else states.delete(scope);
  for (const listener of listeners) listener();
}
/** Atomic lease shared by the original batch and all recovery surfaces. */
export function beginAtlasAggregateRecovery(scope: string): string | undefined {
  if (owners.has(scope)) return undefined;
  const owner = crypto.randomUUID(); owners.set(scope, owner); publish(scope, readAtlasAggregateRecovery(scope).entries); return owner;
}
export function endAtlasAggregateRecovery(scope: string, owner: string) {
  if (owners.get(scope) !== owner) return;
  owners.delete(scope); publish(scope, readAtlasAggregateRecovery(scope).entries);
}
/** Call immediately before dispatch; never retain queued, undispatched work. */
export function retainAtlasAggregateRequest(scope: string, entry: AtlasAggregateRecoveryEntry) {
  const entries = readAtlasAggregateRecovery(scope).entries;
  if (entries.some(value => value.key === entry.key)) return;
  publish(scope, [...entries, entry]);
}
export function saveAtlasAggregateReceipt(scope: string, key: string, receipt: AtlasSourceSync) {
  const entries = readAtlasAggregateRecovery(scope).entries;
  const entry = entries.find(value => value.key === key);
  if (!entry || entry.sourceId !== receipt.run.sourceId || entry.receipt && entry.receipt.run.status !== "running") return;
  publish(scope, entries.map(value => value.key === key ? { ...value, receipt } : value));
}
/** A typed tool rejection confirms that this command did not create a run.
 * Transport/response uncertainty and rate limits still retain the original key. */
export function rejectAtlasAggregateRequest(scope: string, key: string, failure: unknown) {
  if (!(failure instanceof AtlasSourceServiceError) || !["invalid-input", "stale-version", "idempotency-conflict", "not-authorized", "conflict", "not-found", "unsupported-capability"].includes(failure.code)) return;
  const entries = readAtlasAggregateRecovery(scope).entries;
  publish(scope, entries.map(entry => entry.key === key && !entry.receipt ? { ...entry, rejected: true as const } : entry));
}
export function settleAtlasAggregateRejection(scope: string, key: string) {
  publish(scope, readAtlasAggregateRecovery(scope).entries.filter(entry => entry.key !== key || !entry.rejected));
}
/** Clear only a trusted terminal receipt whose matching index was read. */
export function settleAtlasAggregateReceipt(scope: string, key: string, runId: string) {
  const entries = readAtlasAggregateRecovery(scope).entries;
  publish(scope, entries.filter(value => value.key !== key || value.receipt?.run.runId !== runId || value.receipt.run.status === "running"));
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useAtlasAggregateRecovery(endpoint: string, token: string) {
  const scope = atlasAggregateRecoveryScope(endpoint, token);
  const snapshot = useCallback(() => readAtlasAggregateRecovery(scope), [scope]);
  return useSyncExternalStore(subscribe, snapshot, () => empty);
}
