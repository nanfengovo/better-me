// Browser persistence only: not the server's authorization boundary. No DOM-only imports.
let ownerId: string | undefined;
export function activateStorageOwner(id: string | undefined) { ownerId = id; }
function scopedKey(id: string | undefined, key: string) { return id ? `betterme.owner.v1:${id}:${key}` : key; }
export function privateKey(key: string) { return scopedKey(ownerId, key); }
/** Long-lived controllers capture this object, so an old queued write stays in its original scope. */
export function capturePrivateStorage(): Storage {
  const id = ownerId;
  return storageFor(key => scopedKey(id, key));
}
/** Never falls back to legacy keys when an account has no data. */
function storageFor(keyFor: (key: string) => string): Storage {
  return {
    get length() { return Object.keys(globalThis.localStorage).filter(key => key.startsWith(keyFor(""))).length; },
    key(index) { const prefix = keyFor(""); return Object.keys(globalThis.localStorage).filter(key => key.startsWith(prefix))[index]?.slice(prefix.length) ?? null; },
    getItem: key => globalThis.localStorage.getItem(keyFor(key)),
    setItem: (key, value) => globalThis.localStorage.setItem(keyFor(key), value),
    removeItem: key => globalThis.localStorage.removeItem(keyFor(key)),
    clear() { const keys = Array.from({ length: this.length }, (_, index) => this.key(index)); keys.forEach(key => { if (key !== null) this.removeItem(key); }); },
  };
}
export const privateStorage = storageFor(privateKey);
export function privateStorageEvent(event: { storageArea: unknown; key: string | null; newValue: string | null }) {
  if (event.storageArea && event.storageArea !== globalThis.localStorage) return undefined;
  const prefix = privateKey("");
  if (event.key !== null && !event.key.startsWith(prefix)) return undefined;
  return { key: event.key?.slice(prefix.length) ?? null, newValue: event.newValue };
}
export function ownerDatabase(name: string) { return privateKey(name); }

/** A recovered archive opens in its own URL and document store; the default space stays untouched. */
export function recoverySpace(search = ""): string | undefined {
  const value = new URLSearchParams(search).get("recovery");
  if (value === null) return undefined;
  if (!/^[a-f0-9]{32}\.[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error("恢复档案地址无效，未打开或改动当前文档。");
  return value;
}
function documentPrefix(space?: string) { return space ? `betterme.document-space.v1:${space}:` : ""; }
export function captureDocumentStorage(space?: string): Storage {
  const id = ownerId, prefix = documentPrefix(space);
  return storageFor(key => scopedKey(id, prefix + key));
}
export function documentDatabase(name: string, space?: string) { return privateKey(documentPrefix(space) + name); }
export function documentStorageEvent(event: { storageArea: unknown; key: string | null; newValue: string | null }, space?: string) {
  const change = privateStorageEvent(event); if (!change) return undefined;
  const prefix = documentPrefix(space);
  if (change.key !== null && !change.key.startsWith(prefix)) return undefined;
  return { ...change, key: change.key?.slice(prefix.length) ?? null };
}
