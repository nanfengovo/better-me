import { DocumentPersistenceController, LocalDocumentHistory, LocalJsonStore, DEFAULT_AUTO_SAVE_SETTINGS, STORAGE_KEY, type BetterMeDocument, type DocumentVersion, type VersionRepository } from "@better-me/storage";

/** Real persistence controller, entirely in memory. Never opens browser or Host data. */
export function syntheticPersistence(initial: BetterMeDocument) {
  const values = new Map([[STORAGE_KEY, JSON.stringify(initial)]]);
  const faults = { official: false, draft: false, history: false };
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      if (key === STORAGE_KEY ? faults.official : faults.draft) throw new Error("Synthetic storage failure");
      values.set(key, value);
    },
    removeItem(key: string) { values.delete(key); },
  };
  let versions: DocumentVersion[] = [];
  const repository: VersionRepository = {
    list: async () => structuredClone(versions),
    putAndPrune: async (version, limit) => { if (faults.history) throw new Error("Synthetic history failure"); versions = [version, ...versions.filter(item => item.id !== version.id)].slice(0, limit); },
    delete: async id => { versions = versions.filter(item => item.id !== id); },
  };
  const draftRepository = { load: async () => null, save: async () => { if (faults.draft) throw new Error("Synthetic draft failure"); } };
  const controller = new DocumentPersistenceController({ storage, store: new LocalJsonStore(STORAGE_KEY, storage), history: new LocalDocumentHistory(repository), draftRepository, previousDraftRepository: draftRepository,
    autoSave: { ...DEFAULT_AUTO_SAVE_SETTINGS, enabled: false },
  });
  return { controller, faults, values, versions: () => repository.list() };
}
