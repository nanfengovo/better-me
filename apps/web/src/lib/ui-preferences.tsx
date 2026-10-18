import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_WORKSPACE_THEME_ID, getWorkspaceTheme, isWorkspaceThemeId, workspaceThemeVariables, type WorkspaceThemeId } from "../themes/workspace-theme";

export type UiLocale = "zh" | "en";
export type UiTheme = "light" | "dark";
export type UiPreferences = { locale: UiLocale; theme: UiTheme; workspaceThemeId?: WorkspaceThemeId };
export const UI_PREFERENCES_KEY = "betterme.ui.preferences.v1";
export type UiTranslator = (chinese: string, english: string) => string;
const DEFAULT_PREFERENCES: UiPreferences = { locale: "zh", theme: "light" };

export function parseUiPreferences(raw: string | null): UiPreferences {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_PREFERENCES };
    const saved = value as Record<string, unknown>;
    return {
      locale: saved.locale === "en" ? "en" : "zh", theme: saved.theme === "dark" ? "dark" : "light",
      ...(isWorkspaceThemeId(saved.workspaceThemeId) ? { workspaceThemeId: saved.workspaceThemeId } : {}),
    };
  } catch { return { ...DEFAULT_PREFERENCES }; }
}
export function readUiPreferences(): UiPreferences {
  try { return parseUiPreferences(localStorage.getItem(UI_PREFERENCES_KEY)); }
  catch { return { ...DEFAULT_PREFERENCES }; }
}
export function applyUiAppearance(preferences: UiPreferences): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = preferences.locale === "zh" ? "zh-CN" : "en";
  document.title = preferences.locale === "en" ? "BetterMe · Career workspace" : "迈向更好 · BetterMe";
  document.documentElement.dataset.uiLocale = preferences.locale;
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.dataset.workspaceTheme = getWorkspaceTheme(preferences.workspaceThemeId).id;
  document.documentElement.style.colorScheme = preferences.theme;
  for (const [name, value] of Object.entries(workspaceThemeVariables(preferences.workspaceThemeId, preferences.theme))) {
    document.documentElement.style.setProperty(name, value);
  }
}
// Run before mounting React so a saved dark theme does not flash light on load.
export function initializeUiAppearance(): UiPreferences {
  const preferences = readUiPreferences();
  applyUiAppearance(preferences);
  return preferences;
}

type UiContext = UiPreferences & {
  workspaceThemeId: WorkspaceThemeId;
  t: UiTranslator;
  setLocale: (locale: UiLocale) => void;
  setTheme: (theme: UiTheme) => void;
  setWorkspaceThemeId: (id: WorkspaceThemeId) => void;
  persistenceError: boolean;
};
const UiPreferencesContext = createContext<UiContext>({
  ...DEFAULT_PREFERENCES, workspaceThemeId: DEFAULT_WORKSPACE_THEME_ID, t: (chinese) => chinese,
  setLocale: () => {}, setTheme: () => {}, setWorkspaceThemeId: () => {}, persistenceError: false,
});

export function UiPreferencesProvider({ children, initialPreferences }: { children: ReactNode; initialPreferences?: UiPreferences }) {
  const [preferences, setPreferences] = useState(initialPreferences ?? readUiPreferences);
  const preferencesRef = useRef(preferences);
  const [persistenceError, setPersistenceError] = useState(false);
  useLayoutEffect(() => { applyUiAppearance(preferences); }, [preferences]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== UI_PREFERENCES_KEY && event.key !== null) return;
      let next: UiPreferences;
      try {
        if (event.storageArea && event.storageArea !== localStorage) return;
        // Read the latest value: queued events may describe an older write.
        next = parseUiPreferences(localStorage.getItem(UI_PREFERENCES_KEY));
      } catch { next = parseUiPreferences(event.newValue); }
      if (preferencesRef.current.locale === next.locale && preferencesRef.current.theme === next.theme
        && getWorkspaceTheme(preferencesRef.current.workspaceThemeId).id === getWorkspaceTheme(next.workspaceThemeId).id) return;
      preferencesRef.current = next;
      setPreferences(next);
      // Remote events only update appearance; never echo them into storage.
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const commit = useCallback((patch: Partial<UiPreferences>) => {
    const next = { ...preferencesRef.current, ...patch };
    preferencesRef.current = next;
    setPreferences(next);
    try { localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(next)); setPersistenceError(false); }
    catch { setPersistenceError(true); }
  }, []);
  const setLocale = useCallback((locale: UiLocale) => commit({ locale }), [commit]);
  const setTheme = useCallback((theme: UiTheme) => commit({ theme }), [commit]);
  const setWorkspaceThemeId = useCallback((id: WorkspaceThemeId) => {
    if (isWorkspaceThemeId(id)) commit({ workspaceThemeId: id });
  }, [commit]);
  const t = useCallback<UiTranslator>((chinese, english) => preferences.locale === "en" ? english : chinese, [preferences.locale]);
  const context = useMemo(() => ({ ...preferences, workspaceThemeId: getWorkspaceTheme(preferences.workspaceThemeId).id, setLocale, setTheme, setWorkspaceThemeId, t, persistenceError }), [preferences, setLocale, setTheme, setWorkspaceThemeId, t, persistenceError]);
  return <UiPreferencesContext.Provider value={context}>{children}</UiPreferencesContext.Provider>;
}
export function useUiPreferences(): UiContext { return useContext(UiPreferencesContext); }
