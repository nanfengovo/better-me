import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_WORKSPACE_THEME_ID, getWorkspaceTheme, isWorkspaceThemeId, workspaceThemeVariables, type WorkspaceThemeId } from "../themes/workspace-theme";

export function useReducedMotion() {
  const { reduceMotion } = useUiPreferences();
  const [system, setSystem] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystem(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return Boolean(reduceMotion || system);
}

export type UiLocale = "zh" | "en";
export type UiTheme = "light" | "dark";
export type DockPosition = "bottom" | "left" | "right";
export type DesktopPreferences = {
  menuBarAutoHide?: boolean;
  dockAutoHide?: boolean;
  dockPosition?: DockPosition;
  dockSize?: number;
  dockMagnification?: boolean;
  dockMagScale?: number;
  dockOpacity?: number;
  dockBlur?: number;
  reduceMotion?: boolean;
  wallpaper?: string;
  wallpaperOpacity?: number;
  wallpaperBlur?: number;
  windowOpacity?: number;
  windowBlur?: number;
  menuOpacity?: number;
};
export type UiPreferences = DesktopPreferences & { locale: UiLocale; theme: UiTheme; workspaceThemeId?: WorkspaceThemeId };
export const UI_PREFERENCES_KEY = "betterme.ui.preferences.v1";
export type UiTranslator = (chinese: string, english: string) => string;
const DEFAULT_PREFERENCES: UiPreferences = {
  locale: "zh",
  theme: "light",
  dockPosition: "bottom",
  dockSize: 48,
  dockMagnification: true,
  dockMagScale: 1.45,
  dockOpacity: 0.85,
  dockBlur: 24,
  dockAutoHide: true,
  menuBarAutoHide: false,
  wallpaperOpacity: 1,
  wallpaperBlur: 0,
  windowOpacity: 0.92,
  windowBlur: 24,
  menuOpacity: 0.90,
};

export function parseUiPreferences(raw: string | null): UiPreferences {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_PREFERENCES };
    const saved = value as Record<string, unknown>;
    return {
      locale: saved.locale === "en" ? "en" : "zh", theme: saved.theme === "dark" ? "dark" : "light",
      ...(isWorkspaceThemeId(saved.workspaceThemeId) ? { workspaceThemeId: saved.workspaceThemeId } : {}),
      ...(typeof saved.dockAutoHide === "boolean" ? { dockAutoHide: saved.dockAutoHide } : {}),
      ...(typeof saved.menuBarAutoHide === "boolean" ? { menuBarAutoHide: saved.menuBarAutoHide } : {}),
      ...(saved.dockPosition === "left" || saved.dockPosition === "right" || saved.dockPosition === "bottom" ? { dockPosition: saved.dockPosition } : {}),
      ...(typeof saved.dockSize === "number" && saved.dockSize >= 32 && saved.dockSize <= 80 ? { dockSize: saved.dockSize } : {}),
      ...(typeof saved.dockMagnification === "boolean" ? { dockMagnification: saved.dockMagnification } : {}),
      ...(typeof saved.dockMagScale === "number" && saved.dockMagScale >= 1.0 && saved.dockMagScale <= 2.2 ? { dockMagScale: saved.dockMagScale } : {}),
      ...(typeof saved.dockOpacity === "number" && saved.dockOpacity >= 0.1 && saved.dockOpacity <= 1 ? { dockOpacity: saved.dockOpacity } : {}),
      ...(typeof saved.dockBlur === "number" && saved.dockBlur >= 0 && saved.dockBlur <= 40 ? { dockBlur: saved.dockBlur } : {}),
      ...(typeof saved.reduceMotion === "boolean" ? { reduceMotion: saved.reduceMotion } : {}),
      ...(typeof saved.wallpaper === "string" ? { wallpaper: saved.wallpaper } : {}),
      ...(typeof saved.wallpaperOpacity === "number" && saved.wallpaperOpacity >= 0.05 && saved.wallpaperOpacity <= 1 ? { wallpaperOpacity: saved.wallpaperOpacity } : {}),
      ...(typeof saved.wallpaperBlur === "number" && saved.wallpaperBlur >= 0 && saved.wallpaperBlur <= 40 ? { wallpaperBlur: saved.wallpaperBlur } : {}),
      ...(typeof saved.windowOpacity === "number" && saved.windowOpacity >= 0.2 && saved.windowOpacity <= 1 ? { windowOpacity: saved.windowOpacity } : {}),
      ...(typeof saved.windowBlur === "number" && saved.windowBlur >= 0 && saved.windowBlur <= 40 ? { windowBlur: saved.windowBlur } : {}),
      ...(typeof saved.menuOpacity === "number" && saved.menuOpacity >= 0.2 && saved.menuOpacity <= 1 ? { menuOpacity: saved.menuOpacity } : {}),
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
  const winOpacity = preferences.windowOpacity ?? 0.92;
  const winBlur = preferences.windowBlur ?? 24;
  const menuOpacity = preferences.menuOpacity ?? 0.90;
  const dockPosition = preferences.dockPosition ?? "bottom";
  const dockOpacity = preferences.dockOpacity ?? 0.85;
  const dockBlur = preferences.dockBlur ?? 24;
  const dockSize = preferences.dockSize ?? 48;
  document.documentElement.dataset.dockPosition = dockPosition;
  document.documentElement.style.setProperty("--os-window-opacity", String(winOpacity));
  document.documentElement.style.setProperty("--os-window-blur", `${winBlur}px`);
  document.documentElement.style.setProperty("--os-menu-opacity", String(menuOpacity));
  document.documentElement.style.setProperty("--os-menu-blur", `${winBlur}px`);
  document.documentElement.style.setProperty("--os-dock-opacity", String(dockOpacity));
  document.documentElement.style.setProperty("--os-dock-blur", `${dockBlur}px`);
  document.documentElement.style.setProperty("--os-dock-size", `${dockSize}px`);
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
  setDesktopPreferences: (patch: DesktopPreferences) => void;
  persistenceError: boolean;
};
const UiPreferencesContext = createContext<UiContext>({
  ...DEFAULT_PREFERENCES, workspaceThemeId: DEFAULT_WORKSPACE_THEME_ID, t: (chinese) => chinese,
  setLocale: () => {}, setTheme: () => {}, setWorkspaceThemeId: () => {}, setDesktopPreferences: () => {}, persistenceError: false,
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
        && getWorkspaceTheme(preferencesRef.current.workspaceThemeId).id === getWorkspaceTheme(next.workspaceThemeId).id
        && preferencesRef.current.dockAutoHide === next.dockAutoHide
        && preferencesRef.current.menuBarAutoHide === next.menuBarAutoHide
        && preferencesRef.current.dockPosition === next.dockPosition
        && preferencesRef.current.dockSize === next.dockSize
        && preferencesRef.current.dockMagnification === next.dockMagnification
        && preferencesRef.current.dockMagScale === next.dockMagScale
        && preferencesRef.current.dockOpacity === next.dockOpacity
        && preferencesRef.current.dockBlur === next.dockBlur
        && preferencesRef.current.reduceMotion === next.reduceMotion
        && preferencesRef.current.wallpaper === next.wallpaper
        && preferencesRef.current.wallpaperOpacity === next.wallpaperOpacity
        && preferencesRef.current.wallpaperBlur === next.wallpaperBlur) return;
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
  const setDesktopPreferences = useCallback((patch: DesktopPreferences) => {
    const desktop: DesktopPreferences = {};
    if (typeof patch.dockAutoHide === "boolean") desktop.dockAutoHide = patch.dockAutoHide;
    if (typeof patch.menuBarAutoHide === "boolean") desktop.menuBarAutoHide = patch.menuBarAutoHide;
    if (patch.dockPosition === "left" || patch.dockPosition === "right" || patch.dockPosition === "bottom") {
      desktop.dockPosition = patch.dockPosition;
    }
    if (typeof patch.dockSize === "number" && !isNaN(patch.dockSize)) {
      desktop.dockSize = Math.max(32, Math.min(80, patch.dockSize));
    }
    if (typeof patch.dockMagnification === "boolean") {
      desktop.dockMagnification = patch.dockMagnification;
    }
    if (typeof patch.dockMagScale === "number" && !isNaN(patch.dockMagScale)) {
      desktop.dockMagScale = Math.max(1.0, Math.min(2.2, patch.dockMagScale));
    }
    if (typeof patch.dockOpacity === "number" && !isNaN(patch.dockOpacity)) {
      desktop.dockOpacity = Math.max(0.1, Math.min(1, patch.dockOpacity));
    }
    if (typeof patch.dockBlur === "number" && !isNaN(patch.dockBlur)) {
      desktop.dockBlur = Math.max(0, Math.min(40, patch.dockBlur));
    }
    if (typeof patch.reduceMotion === "boolean") desktop.reduceMotion = patch.reduceMotion;
    if (typeof patch.wallpaper === "string") desktop.wallpaper = patch.wallpaper;
    if (typeof patch.wallpaperOpacity === "number" && !isNaN(patch.wallpaperOpacity)) {
      desktop.wallpaperOpacity = Math.max(0.05, Math.min(1, patch.wallpaperOpacity));
    }
    if (typeof patch.wallpaperBlur === "number" && !isNaN(patch.wallpaperBlur)) {
      desktop.wallpaperBlur = Math.max(0, Math.min(40, patch.wallpaperBlur));
    }
    if (typeof patch.windowOpacity === "number" && !isNaN(patch.windowOpacity)) {
      desktop.windowOpacity = Math.max(0.2, Math.min(1, patch.windowOpacity));
    }
    if (typeof patch.windowBlur === "number" && !isNaN(patch.windowBlur)) {
      desktop.windowBlur = Math.max(0, Math.min(40, patch.windowBlur));
    }
    if (typeof patch.menuOpacity === "number" && !isNaN(patch.menuOpacity)) {
      desktop.menuOpacity = Math.max(0.2, Math.min(1, patch.menuOpacity));
    }
    commit(desktop);
  }, [commit]);
  const context = useMemo(() => ({ ...preferences, workspaceThemeId: getWorkspaceTheme(preferences.workspaceThemeId).id, setLocale, setTheme, setWorkspaceThemeId, setDesktopPreferences, t, persistenceError }), [preferences, setLocale, setTheme, setWorkspaceThemeId, setDesktopPreferences, t, persistenceError]);
  return <UiPreferencesContext.Provider value={context}>{children}</UiPreferencesContext.Provider>;
}
export function useUiPreferences(): UiContext { return useContext(UiPreferencesContext); }
