import { useCallback, useEffect, useState } from "react";

export type ShortcutId =
  | "commandPalette"
  | "undo"
  | "redo"
  | "save"
  | "history"
  | "focusMode"
  | "toggleDesign"
  | "findJobs"
  | "openSettings"
  | "switchResume"
  | "switchOpportunities"
  | "switchAtlas"
  | "switchAgent";

export type ShortcutCategory = "edit" | "view" | "navigation";

export interface ShortcutDefinition {
  id: ShortcutId;
  category: ShortcutCategory;
  defaultSpec: string;
  zh: string;
  en: string;
  descZh: string;
  descEn: string;
}

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  { id: "undo", category: "edit", defaultSpec: "mod+z", zh: "撤销修改", en: "Undo", descZh: "撤销最近一次简历编辑或排序", descEn: "Undo the last resume edit or reorder" },
  { id: "redo", category: "edit", defaultSpec: "mod+shift+z", zh: "重做修改", en: "Redo", descZh: "恢复刚刚撤销的简历修改", descEn: "Redo the last undone edit" },
  { id: "save", category: "edit", defaultSpec: "mod+s", zh: "立即保存", en: "Save now", descZh: "立即持久化当前简历文档", descEn: "Save the current resume immediately" },
  { id: "history", category: "edit", defaultSpec: "mod+shift+s", zh: "历史版本", en: "Version history", descZh: "打开版本历史与回滚面板", descEn: "Open version history and restore panel" },
  { id: "commandPalette", category: "view", defaultSpec: "mod+k", zh: "全局命令面板", en: "Command palette", descZh: "快速搜索并执行任意操作、模板或工作台切换", descEn: "Search and run any action, template, or workspace jump" },
  { id: "focusMode", category: "view", defaultSpec: "mod+shift+f", zh: "切换专注模式", en: "Toggle focus mode", descZh: "隐藏桌面顶栏，专注编辑与预览", descEn: "Hide desktop chrome for focused editing" },
  { id: "toggleDesign", category: "view", defaultSpec: "mod+shift+d", zh: "切换内容 / 设计", en: "Toggle Content / Design", descZh: "在内容编辑与版式设计间切换", descEn: "Switch between Content and Design tabs" },
  { id: "findJobs", category: "view", defaultSpec: "mod+j", zh: "按简历找岗位", en: "Find jobs with resume", descZh: "唤起按简历匹配岗位的搜索窗口", descEn: "Open resume-based job discovery" },
  { id: "openSettings", category: "view", defaultSpec: "mod+,", zh: "打开系统设置", en: "Open Settings", descZh: "打开系统设置与快捷键配置", descEn: "Open system settings window" },
  { id: "switchResume", category: "navigation", defaultSpec: "alt+1", zh: "切到简历工作室", en: "Go to Resume Studio", descZh: "快速切换到简历工作室", descEn: "Switch to Resume Studio" },
  { id: "switchOpportunities", category: "navigation", defaultSpec: "alt+2", zh: "切到机会与投递", en: "Go to Opportunities", descZh: "快速切换到机会与投递", descEn: "Switch to Opportunities" },
  { id: "switchAtlas", category: "navigation", defaultSpec: "alt+3", zh: "切到岗位地图", en: "Go to Opportunity Atlas", descZh: "快速切换到岗位地图", descEn: "Switch to Opportunity Atlas" },
  { id: "switchAgent", category: "navigation", defaultSpec: "alt+4", zh: "切到 AI 顾问", en: "Go to AI Workspace", descZh: "快速切换到 AI 职业顾问", descEn: "Switch to AI Career Workspace" },
];

export type ShortcutMap = Record<ShortcutId, string>;

const STORAGE_KEY = "better-me.shortcuts.v1";
const CHANGE_EVENT = "betterme:shortcuts-changed";

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

export function getDefaultShortcuts(): ShortcutMap {
  const map = {} as ShortcutMap;
  for (const def of SHORTCUT_DEFINITIONS) map[def.id] = def.defaultSpec;
  return map;
}

export interface ParsedShortcut {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export function normalizeKeyToken(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower === " " || lower === "spacebar") return "space";
  if (lower === "esc") return "escape";
  return lower;
}

export function parseShortcut(spec: string): ParsedShortcut | null {
  const parts = spec.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return null;
  const parsed: ParsedShortcut = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: "" };
  for (const part of parts) {
    if (part === "mod") parsed.mod = true;
    else if (part === "ctrl" || part === "control") parsed.ctrl = true;
    else if (part === "meta" || part === "cmd" || part === "command") parsed.meta = true;
    else if (part === "alt" || part === "option") parsed.alt = true;
    else if (part === "shift") parsed.shift = true;
    else parsed.key = normalizeKeyToken(part);
  }
  return parsed.key ? parsed : null;
}

export function serializeShortcut(parsed: ParsedShortcut): string {
  const tokens: string[] = [];
  if (parsed.mod) tokens.push("mod");
  if (parsed.ctrl) tokens.push("ctrl");
  if (parsed.meta) tokens.push("meta");
  if (parsed.alt) tokens.push("alt");
  if (parsed.shift) tokens.push("shift");
  tokens.push(parsed.key);
  return tokens.join("+");
}

function eventKeyName(event: Pick<KeyboardEvent, "key" | "code">): string {
  // Prefer physical key code for letters & digits so Alt/Option on macOS doesn't produce "å", "¡", etc.
  if (event.code) {
    if (/^Key([A-Z])$/.test(event.code)) return event.code.slice(3).toLowerCase();
    if (/^Digit([0-9])$/.test(event.code)) return event.code.slice(5);
    if (event.code === "Comma") return ",";
    if (event.code === "Period") return ".";
    if (event.code === "Slash") return "/";
    if (event.code === "BracketLeft") return "[";
    if (event.code === "BracketRight") return "]";
    if (event.code === "Space") return "space";
  }
  return normalizeKeyToken(event.key);
}

export function matchesShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  spec: string,
  mac = isMacPlatform(),
): boolean {
  const parsed = parseShortcut(spec);
  if (!parsed) return false;
  const expectedCtrl = parsed.ctrl || (parsed.mod && !mac);
  const expectedMeta = parsed.meta || (parsed.mod && mac);
  if (Boolean(event.ctrlKey) !== expectedCtrl) return false;
  if (Boolean(event.metaKey) !== expectedMeta) return false;
  if (Boolean(event.altKey) !== parsed.alt) return false;
  if (Boolean(event.shiftKey) !== parsed.shift) return false;
  return eventKeyName(event) === parsed.key;
}

const MODIFIER_ONLY_KEYS = new Set(["control", "meta", "shift", "alt", "os", "altgraph"]);

export function eventToShortcutSpec(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  mac = isMacPlatform(),
): string | null {
  const key = eventKeyName(event);
  if (!key || MODIFIER_ONLY_KEYS.has(key)) return null;
  const modPressed = mac ? event.metaKey : event.ctrlKey;
  const otherCtrl = mac ? event.ctrlKey : false;
  const otherMeta = mac ? false : event.metaKey;
  // Require at least one modifier (or function key) so plain typing is never hijacked
  const isFunctionKey = /^f([1-9]|1[0-2])$/.test(key);
  if (!modPressed && !otherCtrl && !otherMeta && !event.altKey && !isFunctionKey) return null;
  return serializeShortcut({
    mod: Boolean(modPressed),
    ctrl: Boolean(otherCtrl),
    meta: Boolean(otherMeta),
    alt: Boolean(event.altKey),
    shift: Boolean(event.shiftKey),
    key,
  });
}

export function formatShortcutTokens(spec: string, mac = isMacPlatform()): string[] {
  const parsed = parseShortcut(spec);
  if (!parsed) return [];
  const out: string[] = [];
  if (parsed.ctrl || (parsed.mod && !mac)) out.push(mac ? "⌃" : "Ctrl");
  if (parsed.alt) out.push(mac ? "⌥" : "Alt");
  if (parsed.shift) out.push(mac ? "⇧" : "Shift");
  if (parsed.meta || (parsed.mod && mac)) out.push(mac ? "⌘" : "Win");
  const keyLabel =
    parsed.key === "space"
      ? "Space"
      : parsed.key === "arrowup"
        ? "↑"
        : parsed.key === "arrowdown"
          ? "↓"
          : parsed.key.length === 1
            ? parsed.key.toUpperCase()
            : parsed.key[0]!.toUpperCase() + parsed.key.slice(1);
  out.push(keyLabel);
  return out;
}

export function formatShortcut(spec: string, mac = isMacPlatform()): string {
  const tokens = formatShortcutTokens(spec, mac);
  return mac ? tokens.join(" ") : tokens.join(" + ");
}

export function findShortcutConflict(map: ShortcutMap, id: ShortcutId, nextSpec: string): ShortcutId | null {
  const normalized = parseShortcut(nextSpec);
  if (!normalized) return null;
  const canonical = serializeShortcut(normalized);
  for (const def of SHORTCUT_DEFINITIONS) {
    if (def.id === id) continue;
    const current = parseShortcut(map[def.id]);
    if (current && serializeShortcut(current) === canonical) return def.id;
  }
  return null;
}

export function readShortcuts(): ShortcutMap {
  const defaults = getDefaultShortcuts();
  if (typeof localStorage === "undefined") return defaults;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
    for (const def of SHORTCUT_DEFINITIONS) {
      const candidate = parsed[def.id];
      if (typeof candidate === "string" && parseShortcut(candidate)) {
        defaults[def.id] = candidate;
      }
    }
  } catch {
    /* Fall back to defaults on corrupt storage. */
  }
  return defaults;
}

export function writeShortcuts(next: ShortcutMap): void {
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* Storage may be unavailable in restricted contexts. */
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  }
}

export function useShortcuts() {
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(() => readShortcuts());

  useEffect(() => {
    const onChange = () => setShortcuts(readShortcuts());
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const updateShortcut = useCallback((id: ShortcutId, nextSpec: string) => {
    const current = readShortcuts();
    const updated: ShortcutMap = { ...current, [id]: nextSpec };
    writeShortcuts(updated);
    setShortcuts(updated);
  }, []);

  const resetShortcut = useCallback((id: ShortcutId) => {
    const def = SHORTCUT_DEFINITIONS.find((item) => item.id === id);
    if (!def) return;
    updateShortcut(id, def.defaultSpec);
  }, [updateShortcut]);

  const resetAll = useCallback(() => {
    const defaults = getDefaultShortcuts();
    writeShortcuts(defaults);
    setShortcuts(defaults);
  }, []);

  return { shortcuts, updateShortcut, resetShortcut, resetAll };
}
