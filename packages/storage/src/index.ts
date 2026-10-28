export type { BetterMeDocument, DocumentStore } from "./types.js";
export {
  LocalJsonStore,
  STORAGE_KEY,
  StoredDocumentError,
  DocumentSchema,
  createInitialDocument,
  exportDocumentJson,
  parseDocumentJson,
} from "./local-json.js";
export {
  DRAFT_STORAGE_KEY,
  PREVIOUS_DRAFT_STORAGE_KEY,
  HISTORY_LIMIT,
  AUTO_SNAPSHOT_COALESCE_MS,
  DraftDocumentSchema,
  LocalDocumentHistory,
  IndexedDbVersionRepository,
  IndexedDbDraftRepository,
  DocumentPersistenceController,
  documentFingerprint,
  describeDocumentChanges,
} from "./document-history.js";
export type { DocumentVersion, VersionKind, VersionRepository, DraftRepository, PersistenceStatus, PersistenceState } from "./document-history.js";
export { getDocumentFieldChanges } from "./document-diff.js";
export { applyDocumentFieldChange } from "./document-field-restore.js";
export type { DocumentFieldChange, DocumentFieldTarget, DocumentFieldRestoreResult } from "./document-field-restore.js";
export { DEFAULT_AUTO_SAVE_SETTINGS, normalizeAutoSaveSettings } from "./autosave-policy.js";
export type { AutoSaveSettings } from "./autosave-policy.js";
