/** Per-owner, in-memory usage observed at the Host's single model-dispatch seam.
 * Tokens come only from provider usage reports; runtimes without one stay
 * `metered: false` instead of being estimated. Resets at local midnight and on
 * Host restart (`since` tells readers which applies). */
export type ModelUsageEntry = {
  label: string; kind: "model" | "chatgpt" | "native";
  calls: number; failures: number; metered: boolean;
  inputTokens: number; outputTokens: number; lastAt: string;
};
export type ModelUsageSnapshot = {
  day: string; since: string;
  models: ModelUsageEntry[];
  active: Array<{ label: string; startedAt: string }>;
};
export type ProviderTokenUsage = { inputTokens: number; outputTokens: number };

const MAX_MODELS = 32;
const MAX_ACTIVE = 16;
const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

export function providerTokenUsage(value: unknown): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = count(usage.input_tokens), outputTokens = count(usage.output_tokens);
  return inputTokens === undefined || outputTokens === undefined ? undefined : { inputTokens, outputTokens };
}

export class ModelUsageMeter {
  private day: string;
  private since: string;
  private models = new Map<string, ModelUsageEntry>();
  private active = new Map<number, { label: string; startedAt: string }>();
  private sequence = 0;
  constructor(private readonly now: () => Date = () => new Date()) {
    const time = this.now();
    this.day = localDay(time); this.since = time.toISOString();
  }
  private roll() {
    const time = this.now(), day = localDay(time);
    if (day === this.day) return;
    this.day = day; this.since = time.toISOString(); this.models.clear();
  }
  /** Returns a finish callback; call it exactly once with the provider usage, if any. */
  begin(label: string, kind: ModelUsageEntry["kind"]) {
    this.roll();
    const id = ++this.sequence, safeLabel = label.slice(0, 120) || "unknown";
    if (this.active.size < MAX_ACTIVE) this.active.set(id, { label: safeLabel, startedAt: this.now().toISOString() });
    let done = false;
    return (outcome: { ok: boolean; usage?: ProviderTokenUsage }) => {
      if (done) return; done = true;
      this.active.delete(id); this.roll();
      let entry = this.models.get(safeLabel);
      if (!entry) {
        if (this.models.size >= MAX_MODELS) return;
        entry = { label: safeLabel, kind, calls: 0, failures: 0, metered: false, inputTokens: 0, outputTokens: 0, lastAt: "" };
        this.models.set(safeLabel, entry);
      }
      entry.calls++; if (!outcome.ok) entry.failures++;
      entry.lastAt = this.now().toISOString();
      if (outcome.usage) { entry.metered = true; entry.inputTokens += outcome.usage.inputTokens; entry.outputTokens += outcome.usage.outputTokens; }
    };
  }
  snapshot(): ModelUsageSnapshot {
    this.roll();
    return { day: this.day, since: this.since, models: [...this.models.values()].map(entry => ({ ...entry })),
      active: [...this.active.values()].map(item => ({ ...item })) };
  }
}
