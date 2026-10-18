import catalogData from "./workspace-theme.json";

export const WORKSPACE_THEME_IDS = ["atelier", "navy", "plum", "graphite"] as const;
export type WorkspaceThemeId = typeof WORKSPACE_THEME_IDS[number];
export type WorkspaceAppearance = "light" | "dark";
export const DEFAULT_WORKSPACE_THEME_ID: WorkspaceThemeId = "atelier";

// Keep this allowlist separate from CSS: theme data can only supply colors.
// Shadows and property names are generated here, never interpreted from JSON.
export const WORKSPACE_COLOR_KEYS = [
  "canvas", "surface", "surfaceRaised", "surfaceSoft", "input", "hover", "border", "borderStrong",
  "text", "textSecondary", "textMuted", "accent", "accentSoft", "action", "actionHover", "onAction", "focus",
  "warning", "warningSoft", "warningBorder", "danger", "dangerSoft", "dangerBorder", "info", "infoSoft", "infoBorder",
  "rail", "railText", "railActive", "railSelected", "railMarker", "railBorder", "railHover",
  "previewCanvas", "previewDot", "shadow", "shadowSoft", "panelShadow",
] as const;
export type WorkspaceColorKey = typeof WORKSPACE_COLOR_KEYS[number];
export type WorkspacePalette = Readonly<Record<WorkspaceColorKey, string>>;
type LocalizedText = Readonly<{ zh: string; en: string }>;
export type WorkspaceTheme = Readonly<{
  schemaVersion: 1;
  id: WorkspaceThemeId;
  name: LocalizedText;
  description: LocalizedText;
  light: WorkspacePalette;
  dark: WorkspacePalette;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isWorkspaceThemeId(value: unknown): value is WorkspaceThemeId {
  return typeof value === "string" && WORKSPACE_THEME_IDS.some(id => id === value);
}
function localizedText(value: unknown): value is LocalizedText {
  return record(value) && Object.keys(value).length === 2
    && [value.zh, value.en].every(text => typeof text === "string" && text.trim().length > 0 && text.length <= 180);
}
function palette(value: unknown): value is WorkspacePalette {
  return record(value) && Object.keys(value).length === WORKSPACE_COLOR_KEYS.length
    && WORKSPACE_COLOR_KEYS.every(key => typeof value[key] === "string" && /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value[key]));
}

export function parseWorkspaceTheme(value: unknown): WorkspaceTheme {
  if (!record(value) || Object.keys(value).length !== 6 || value.schemaVersion !== 1 || !isWorkspaceThemeId(value.id)
    || !localizedText(value.name) || !localizedText(value.description) || !palette(value.light) || !palette(value.dark)) {
    throw new Error("Invalid workspace theme: expected a versioned built-in theme with safe color tokens");
  }
  return Object.freeze({
    schemaVersion: 1,
    id: value.id,
    name: Object.freeze({ ...value.name }),
    description: Object.freeze({ ...value.description }),
    light: Object.freeze({ ...value.light }),
    dark: Object.freeze({ ...value.dark }),
  });
}

const themes = catalogData.map(parseWorkspaceTheme);
if (themes.length !== WORKSPACE_THEME_IDS.length || new Set(themes.map(theme => theme.id)).size !== WORKSPACE_THEME_IDS.length) {
  throw new Error("Workspace theme catalog must contain each built-in theme exactly once");
}
export const WORKSPACE_THEMES: readonly WorkspaceTheme[] = Object.freeze(themes);

export function getWorkspaceTheme(id: unknown = DEFAULT_WORKSPACE_THEME_ID): WorkspaceTheme {
  return WORKSPACE_THEMES.find(theme => theme.id === id) ?? WORKSPACE_THEMES[0]!;
}

export function workspaceThemeVariables(id: unknown, appearance: WorkspaceAppearance): Readonly<Record<string, string>> {
  const colors = getWorkspaceTheme(id)[appearance];
  const variables: Record<string, string> = {};
  for (const key of WORKSPACE_COLOR_KEYS) {
    const cssName = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    variables[`--workspace-${cssName}`] = colors[key];
  }
  variables["--workspace-dialog-shadow"] = `0 22px 60px ${colors.shadow}, 0 3px 8px ${colors.shadowSoft}`;
  variables["--workspace-panel-shadow"] = `0 3px 8px ${colors.shadowSoft}, 0 18px 34px -28px ${colors.panelShadow}`;
  return Object.freeze(variables);
}
