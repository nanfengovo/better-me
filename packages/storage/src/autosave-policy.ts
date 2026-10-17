export type AutoSaveSettings = {
  enabled: boolean;
  trigger: "enter" | "idle" | "blur";
  delayMs: number;
  historyIntervalMs: number;
};

export const DEFAULT_AUTO_SAVE_SETTINGS: Readonly<AutoSaveSettings> = Object.freeze({
  enabled: true,
  trigger: "enter",
  delayMs: 5_000,
  historyIntervalMs: 60_000,
});

function boundedDuration(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

/** Preferences are independent of the document and tolerate old or damaged values. */
export function normalizeAutoSaveSettings(value: unknown): AutoSaveSettings {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_AUTO_SAVE_SETTINGS.enabled,
    trigger: source.trigger === "enter" || source.trigger === "idle" || source.trigger === "blur"
      ? source.trigger : DEFAULT_AUTO_SAVE_SETTINGS.trigger,
    delayMs: boundedDuration(source.delayMs, DEFAULT_AUTO_SAVE_SETTINGS.delayMs, 1_000, 300_000),
    historyIntervalMs: boundedDuration(source.historyIntervalMs, DEFAULT_AUTO_SAVE_SETTINGS.historyIntervalMs, 15_000, 600_000),
  };
}
