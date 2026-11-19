/** Per-owner usage observed at the Host's model-dispatch boundaries.
 * Tokens come only from provider usage reports; runtimes without one stay
 * `metered: false` instead of being estimated. Resets at local midnight and
 * optionally persists same-day counters to a private JSON store across Host restarts. */
import fsSync from "node:fs";
import { z } from "zod";
import { writePrivateJson } from "../identity/private-json.js";

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

const persistedEntrySchema = z.object({
  label: z.string().min(1).max(120),
  kind: z.enum(["model", "chatgpt", "native"]),
  calls: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  metered: z.boolean(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  lastAt: z.string(),
}).strict();

const persistedSnapshotSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  since: z.string().min(1),
  models: z.array(persistedEntrySchema).max(MAX_MODELS),
}).passthrough();

export function providerTokenUsage(value: unknown): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = count(usage.input_tokens), outputTokens = count(usage.output_tokens);
  return inputTokens === undefined || outputTokens === undefined ? undefined : { inputTokens, outputTokens };
}

export type ModelUsageMeterOptions = (() => Date) | {
  now?: () => Date;
  filePath?: string;
};

export class ModelUsageMeter {
  private readonly now: () => Date;
  private readonly filePath?: string;
  private day: string;
  private since: string;
  private models = new Map<string, ModelUsageEntry>();
  private active = new Map<number, { label: string; startedAt: string }>();
  private sequence = 0;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(nowOrOptions: ModelUsageMeterOptions = () => new Date()) {
    if (typeof nowOrOptions === "function") {
      this.now = nowOrOptions;
    } else {
      this.now = nowOrOptions.now ?? (() => new Date());
      this.filePath = nowOrOptions.filePath;
    }
    const time = this.now();
    this.day = localDay(time);
    this.since = time.toISOString();
    this.hydrateFromDisk();
  }

  private hydrateFromDisk() {
    if (!this.filePath) return;
    try {
      const stat = fsSync.lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1_048_576
        || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) return;
      const raw: unknown = JSON.parse(fsSync.readFileSync(this.filePath, "utf8"));
      const parsed = persistedSnapshotSchema.safeParse(raw);
      if (!parsed.success || parsed.data.day !== this.day) return;
      this.since = parsed.data.since;
      for (const entry of parsed.data.models) {
        this.models.set(entry.label, { ...entry });
      }
    } catch {
      // Missing, unreadable, or corrupt usage telemetry fails cleanly to zero state.
    }
  }

  private schedulePersist() {
    if (!this.filePath) return;
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      this.enqueuePersist();
    }, 150);
    this.persistTimer.unref();
  }

  private enqueuePersist() {
    if (!this.filePath) return;
    const target = this.filePath;
    const snap = this.snapshot();
    const payload = { day: snap.day, since: snap.since, models: snap.models, active: [] };
    this.writeQueue = this.writeQueue.then(
      () => writePrivateJson(target, payload).catch(() => undefined),
      () => writePrivateJson(target, payload).catch(() => undefined),
    );
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.filePath && this.dirty) {
      this.dirty = false;
      this.enqueuePersist();
    }
    await this.writeQueue;
  }

  private roll() {
    const time = this.now(), day = localDay(time);
    if (day === this.day) return;
    this.day = day; this.since = time.toISOString(); this.models.clear();
    this.schedulePersist();
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
      this.schedulePersist();
    };
  }

  snapshot(): ModelUsageSnapshot {
    this.roll();
    return {
      day: this.day,
      since: this.since,
      models: [...this.models.values()].map(entry => ({ ...entry })),
      active: [...this.active.values()].map(item => ({ ...item })),
    };
  }
}
