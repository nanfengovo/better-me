export type SettingsSection = "appearance" | "desktop" | "shortcuts" | "accessibility" | "connections" | "tools" | "research";
export function openSystemSettings(section: SettingsSection = "connections") {
  window.dispatchEvent(new CustomEvent("betterme:open-settings", { detail: section }));
}
