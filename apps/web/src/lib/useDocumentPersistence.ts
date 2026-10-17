import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  DocumentPersistenceController,
  DEFAULT_AUTO_SAVE_SETTINGS,
  normalizeAutoSaveSettings,
  type AutoSaveSettings,
  type BetterMeDocument,
  type VersionKind,
} from "@better-me/storage";

const AUTO_SAVE_PREFERENCE_KEY = "better-me:auto-save:v1";

function readAutoSavePreference() {
  try {
    const raw = localStorage.getItem(AUTO_SAVE_PREFERENCE_KEY);
    return { settings: normalizeAutoSaveSettings(raw ? JSON.parse(raw) : null), error: "" };
  } catch {
    return { settings: { ...DEFAULT_AUTO_SAVE_SETTINGS }, error: "无法读取保存偏好，当前使用默认设置。" };
  }
}

function isDocumentEditor(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement
    && !!target.closest("#resume-editor-panel, .document-title-row")
    && target.matches("input:not([type=file]):not([type=button]), textarea, select, [contenteditable=true]");
}

export function useDocumentPersistence() {
  const [initialPreference] = useState(readAutoSavePreference);
  const [autoSaveSettings, setSettings] = useState(initialPreference.settings);
  const [autoSavePreferenceError, setPreferenceError] = useState(initialPreference.error);
  const [controller] = useState(() => new DocumentPersistenceController({ autoSave: initialPreference.settings }));
  const subscribe = useCallback((notify: () => void) => controller.subscribe(notify), [controller]);
  const getSnapshot = useCallback(() => controller.getState(), [controller]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void controller.load();
    const flush = () => { void controller.flush(); };
    const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (controller.getState().status.kind === "error") event.preventDefault();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage) controller.handleStorageChange(event.key, event.newValue);
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("storage", onStorage);
      controller.cancelPending();
    };
  }, [controller]);

  useEffect(() => {
    let composing = false;
    let suppressEnterRelease = false;
    const frames = new Set<number>();
    const schedule = (trigger: "enter" | "blur") => {
      const frame = requestAnimationFrame(() => {
        frames.delete(frame);
        void controller.notifyAutoSaveTrigger(trigger);
      });
      frames.add(frame);
    };
    const onCompositionStart = () => { composing = true; };
    const onCompositionEnd = () => { composing = false; suppressEnterRelease = true; };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") suppressEnterRelease = composing || event.isComposing || event.keyCode === 229
        || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const shouldSave = !suppressEnterRelease && !composing && !event.isComposing && event.keyCode !== 229
        && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && isDocumentEditor(event.target);
      suppressEnterRelease = false;
      // Keyup + next frame includes the newline's React input update, while
      // composition confirmation and unrelated dialogs never trigger a save.
      if (shouldSave) schedule("enter");
    };
    const onFocusOut = (event: FocusEvent) => {
      if (isDocumentEditor(event.target)) schedule("blur");
    };
    document.addEventListener("compositionstart", onCompositionStart);
    document.addEventListener("compositionend", onCompositionEnd);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("compositionstart", onCompositionStart);
      document.removeEventListener("compositionend", onCompositionEnd);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("focusout", onFocusOut);
      frames.forEach(cancelAnimationFrame);
    };
  }, [controller]);

  const setAutoSaveSettings = useCallback((next: AutoSaveSettings) => {
    const settings = normalizeAutoSaveSettings(next);
    controller.setAutoSaveSettings(settings);
    setSettings(settings);
    try {
      localStorage.setItem(AUTO_SAVE_PREFERENCE_KEY, JSON.stringify(settings));
      setPreferenceError("");
    } catch { setPreferenceError("本次保存设置已生效，但浏览器无法记住偏好，刷新后需重新设置。"); }
  }, [controller]);

  const update = useCallback((document: BetterMeDocument) => controller.update(document), [controller]);
  const replace = useCallback((document: BetterMeDocument, label?: string, kind?: VersionKind) => controller.replace(document, label, kind), [controller]);
  const checkpoint = useCallback((label: string) => controller.checkpoint(label), [controller]);
  const flush = useCallback(() => controller.flush(true), [controller]);
  return { ...state, update, replace, checkpoint, flush, history: controller.history, autoSaveSettings, setAutoSaveSettings, autoSavePreferenceError };
}
