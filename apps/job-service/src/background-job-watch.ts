import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { closeSync, openSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { defineTool, normalizeSourceUrl, ToolError, type ToolHandlerContext } from "@better-me/opportunities";
import {
  assessJobWatchMatch, canExpandWebDiscovery, createCareerWebSearchProvider, createWebJobDiscoveryState,
  expandWebJobDiscovery, JobWatchAckSchema, JobWatchConfigSchema, JobWatchEnableSchema, JobWatchReadSchema,
  JobWatchReceiptSchema, JobWatchStartSchema, JobWatchStatusSchema, OfficialJobDiscoveryCandidateSchema,
  type CareerWebSearchProvider, type JobWatchConfig, type JobWatchHandle, type JobWatchHit, type JobWatchMatch,
  type JobWatchStatus, type OfficialJobDiscoveryCandidate, type OfficialJobDiscoveryResult, type OfficialJobDiscoveryExecution,
  type SourceTransport, type WebJobDiscoveryState,
} from "@better-me/source-adapters";
import { discoverAcrossSources } from "./official-job-discovery.js";
import type { JobRepository } from "./repository.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const date = (ms: number) => new Date(ms).toISOString();
const pageSize = 30;
const expansionInterval = 2 * 60_000;

type StoredWatch = {
  id: string; key_hash: string; actor_scope: string; config: string; phase: JobWatchStatus["phase"];
  enabled: number; generation: number; next_at: number | null; last_at: number | null;
  rounds: number; pages: number; pending_pages: number; cursor: string | null; warnings: string;
};
type StoredHit = { id: string; job: string; match: string; first_at: number; last_at: number; unread: number; alerted: number; alert_at: number | null; tier: JobWatchMatch["tier"] };

type Cursor = Omit<WebJobDiscoveryState, "visited" | "knownCompanies" | "knownJobs" | "structuredJobs" | "listings" | "searched" | "backgroundChecked"> & {
  visited: string[]; knownCompanies: string[]; knownJobs: [string, OfficialJobDiscoveryCandidate][];
  structuredJobs: string[]; listings: [string, { url: string; links: string[]; kind: "html-list" | "sitemap-urlset" }][];
  searched: string[]; backgroundChecked: string[];
};
function encodeCursor(state: WebJobDiscoveryState) {
  const cursor: Cursor = { ...state, visited: [...state.visited], knownCompanies: [...state.knownCompanies],
    knownJobs: [...state.knownJobs], structuredJobs: [...state.structuredJobs], listings: [...state.listings],
    searched: [...state.searched], backgroundChecked: [...state.backgroundChecked] };
  return JSON.stringify(cursor);
}
function decodeCursor(raw: string): WebJobDiscoveryState {
  const cursor: Cursor = JSON.parse(raw);
  return { ...cursor, visited: new Set(cursor.visited), knownCompanies: new Set(cursor.knownCompanies),
    knownJobs: new Map(cursor.knownJobs), structuredJobs: new Set(cursor.structuredJobs), listings: new Map(cursor.listings),
    searched: new Set(cursor.searched), backgroundChecked: new Set(cursor.backgroundChecked) };
}

function makeExecutionContext(actorScope: string, signal: AbortSignal, observedAt: string): OfficialJobDiscoveryExecution["context"] {
  const budget = { requests: 144, bytes: 64 * 1024 * 1024, timeoutMs: 120_000 };
  let requests = 0, bytes = 0;
  const check = () => { if (signal.aborted) throw new ToolError("cancelled"); };
  return {
    actorScope, requestId: randomUUID(), signal, budget, observedAt, throwIfCancelled: check,
    consumeRequests(count = 1) { check(); requests += count; if (requests > budget.requests) throw new ToolError("budget-exceeded"); },
    consumeBytes(count) { check(); bytes += count; if (bytes > budget.bytes) throw new ToolError("budget-exceeded"); },
  };
}

type Options = {
  databasePath: string;
  repository: JobRepository;
  transport: SourceTransport;
  detailTransport: SourceTransport;
  searchProvider?: CareerWebSearchProvider;
  now?: () => number;
  seed?: typeof discoverAcrossSources;
  expand?: typeof expandWebJobDiscovery;
  /** Host/test controls. A watch request cannot choose timers or providers. */
  expansionIntervalMs?: number;
  autoStart?: boolean;
};

/** One durable, read-only web research worker for the writer lane. No source or canonical job mutations. */
export function createBackgroundJobWatch(options: Options) {
  const now = options.now ?? Date.now;
  const provider = options.searchProvider ?? createCareerWebSearchProvider({ provider: "duckduckgo-html" });
  const seed = options.seed ?? discoverAcrossSources;
  const expand = options.expand ?? expandWebJobDiscovery;
  if (options.databasePath !== ":memory:") {
    try { closeSync(openSync(options.databasePath, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const db = new DatabaseSync(options.databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS job_watch (
      id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, actor_scope TEXT NOT NULL, config TEXT NOT NULL,
      phase TEXT NOT NULL, enabled INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER, last_at INTEGER, rounds INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0,
      pending_pages INTEGER NOT NULL DEFAULT 0, cursor TEXT, warnings TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS job_watch_hit (
      watch_id TEXT NOT NULL REFERENCES job_watch(id) ON DELETE CASCADE,
      id TEXT NOT NULL, url TEXT NOT NULL, company TEXT NOT NULL, job TEXT NOT NULL, match TEXT NOT NULL, tier TEXT NOT NULL,
      first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, unread INTEGER NOT NULL, alerted INTEGER NOT NULL,
      visible INTEGER NOT NULL DEFAULT 1, alert_at INTEGER, relevance INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (watch_id, id), UNIQUE (watch_id, url)
    );
    CREATE INDEX IF NOT EXISTS job_watch_due ON job_watch(enabled, next_at);
    CREATE INDEX IF NOT EXISTS job_watch_inbox ON job_watch_hit(watch_id, unread, tier, last_at);
  `);
  const hitColumns = db.prepare("PRAGMA table_info(job_watch_hit)").all().map(column => column.name);
  if (!hitColumns.includes("visible")) db.exec("ALTER TABLE job_watch_hit ADD COLUMN visible INTEGER NOT NULL DEFAULT 1");
  if (!hitColumns.includes("alert_at")) db.exec("ALTER TABLE job_watch_hit ADD COLUMN alert_at INTEGER");
  if (!hitColumns.includes("relevance")) db.exec("ALTER TABLE job_watch_hit ADD COLUMN relevance INTEGER NOT NULL DEFAULT 0");
  db.prepare("UPDATE job_watch SET phase='scheduled', next_at=? WHERE enabled=1 AND phase='searching'").run(now());

  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: { id: string; controller: AbortController; task: Promise<void> } | undefined;
  let closed = false;
  let stopped = false;

  const row = (id: string) => db.prepare("SELECT * FROM job_watch WHERE id=?").get(id) as StoredWatch | undefined;
  const configOf = (watch: StoredWatch) => JobWatchConfigSchema.parse(JSON.parse(watch.config));
  const authorize = (handle: JobWatchHandle, context: ToolHandlerContext) => {
    context.throwIfCancelled();
    const watch = row(handle.watchId);
    if (!watch) throw new ToolError("stale-version");
    if (watch.actor_scope !== context.actorScope || !timingSafeEqual(Buffer.from(watch.key_hash, "hex"), Buffer.from(hash(handle.watchKey), "hex"))) throw new ToolError("not-authorized");
    return watch;
  };
  function transaction(operation: () => void) {
    db.exec("BEGIN IMMEDIATE");
    try { operation(); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function interrupt(id: string) { if (current?.id === id) current.controller.abort(); }
  function wake() {
    if (closed || stopped || options.autoStart === false || current) return;
    if (timer) clearTimeout(timer);
    const next = db.prepare("SELECT next_at FROM job_watch WHERE enabled=1 AND next_at IS NOT NULL ORDER BY next_at LIMIT 1").get() as { next_at: number } | undefined;
    if (!next) { timer = undefined; return; }
    // The configured schedule lives on disk. Cap long sleeps to account for host clock changes.
    timer = setTimeout(() => { timer = undefined; void runDue().catch(() => { if (!stopped && !closed) { timer = setTimeout(wake, 10_000); timer.unref(); } }); },
      Math.max(0, Math.min(60_000, next.next_at - now())));
    timer.unref();
  }

  function start(handle: JobWatchHandle, config: JobWatchConfig, context: ToolHandlerContext) {
    context.throwIfCancelled();
    const existing = row(handle.watchId);
    if (!existing) {
      db.prepare("INSERT INTO job_watch(id,key_hash,actor_scope,config,phase,enabled,next_at) VALUES (?,?,?,?, 'scheduled',1,?)")
        .run(handle.watchId, hash(handle.watchKey), context.actorScope, JSON.stringify(config), now());
    } else {
      const watch = authorize(handle, context);
      if (isDeepStrictEqual(configOf(watch), config)) {
        if (!watch.enabled) changeEnabled(handle, true, context);
      } else {
        // Changing only the polling cadence preserves the reviewed postings, frontier, and deduplication.
        const criteriaChanged = !isDeepStrictEqual(configOf(watch).criteria, config.criteria);
        if (criteriaChanged) {
          transaction(() => {
            db.prepare("UPDATE job_watch SET config=?,enabled=1,phase='scheduled',next_at=?,generation=generation+1,cursor=NULL,last_at=NULL,rounds=0,pages=0,pending_pages=0,warnings='[]' WHERE id=?")
              .run(JSON.stringify(config), now(), watch.id);
            db.prepare("DELETE FROM job_watch_hit WHERE watch_id=?").run(watch.id);
          });
        } else {
          db.prepare("UPDATE job_watch SET config=?,enabled=1,phase='scheduled',next_at=?,generation=generation+1 WHERE id=?")
            .run(JSON.stringify(config), now(), watch.id);
        }
        interrupt(watch.id);
      }
    }
    wake();
  }
  function changeEnabled(handle: JobWatchHandle, enabled: boolean, context: ToolHandlerContext) {
    const watch = authorize(handle, context);
    if (Boolean(watch.enabled) !== enabled) {
      db.prepare("UPDATE job_watch SET enabled=?,phase=?,next_at=?,generation=generation+1 WHERE id=?")
        .run(Number(enabled), enabled ? "scheduled" : "paused", enabled ? now() : null, watch.id);
      if (!enabled) interrupt(watch.id);
    }
    wake();
  }
  function getStatus(watch: StoredWatch, offset?: number, view?: "matches" | "related"): JobWatchStatus {
    const counts = db.prepare(`SELECT count(*) AS total, count(DISTINCT company) AS companies,
      coalesce(sum(tier='priority'),0) AS priority, coalesce(sum(tier='confirm'),0) AS confirm, coalesce(sum(unread),0) AS unread,
      max(CASE WHEN unread=1 THEN alert_at END) AS alert_at FROM job_watch_hit WHERE watch_id=? AND visible=1`).get(watch.id) as { total: number; companies: number; priority: number; confirm: number; unread: number; alert_at: number | null };
    const filter = view === "matches" ? " AND tier!='related'" : view === "related" ? " AND tier='related'" : "";
    const records = offset === undefined ? undefined : db.prepare(`SELECT * FROM job_watch_hit WHERE watch_id=? AND visible=1${filter}
      ORDER BY unread DESC, CASE tier WHEN 'priority' THEN 0 WHEN 'confirm' THEN 1 ELSE 2 END, relevance DESC, first_at DESC, id LIMIT ? OFFSET ?`)
      .all(watch.id, pageSize, offset) as StoredHit[];
    const hits: JobWatchHit[] | undefined = records?.map(hit => ({ id: hit.id, job: JSON.parse(hit.job), match: JSON.parse(hit.match),
      firstSeenAt: date(hit.first_at), lastObservedAt: date(hit.last_at), unread: Boolean(hit.unread) }));
    const { alert_at, ...totals } = counts;
    return JobWatchStatusSchema.parse({ watchId: watch.id, config: configOf(watch), phase: watch.phase,
      ...(watch.next_at !== null && watch.enabled ? { nextRunAt: date(watch.next_at) } : {}),
      ...(watch.last_at !== null ? { lastRunAt: date(watch.last_at) } : {}), rounds: watch.rounds, pages: watch.pages,
      pendingPages: watch.pending_pages, ...totals, ...(alert_at !== null ? { latestAlertAt: date(alert_at) } : {}), warnings: JSON.parse(watch.warnings), ...(hits ? { hits } : {}) });
  }

  function saveHit(watchId: string, candidate: OfficialJobDiscoveryCandidate, criteria: JobWatchConfig["criteria"], observed: number) {
    const job = clean(candidate);
    delete job.candidateId;
    const url = normalizeSourceUrl(job.url);
    const company = job.company?.trim().normalize("NFKC").toLowerCase() ?? "";
    const id = hash(company && job.jobId ? JSON.stringify([company, job.jobId]) : url);
    const [prior, duplicate] = db.prepare("SELECT * FROM job_watch_hit WHERE watch_id=? AND (id=? OR url=?) ORDER BY id=? DESC LIMIT 2")
      .all(watchId, id, url, id) as StoredHit[];
    if (prior && duplicate) {
      // URL and requisition aliases can become linked only after reading a later official detail.
      const alertTimes = [prior.alert_at, duplicate.alert_at].filter((value): value is number => value !== null);
      prior.first_at = Math.min(prior.first_at, duplicate.first_at);
      prior.alerted = Math.max(prior.alerted, duplicate.alerted);
      prior.unread = Math.max(prior.unread, duplicate.unread);
      prior.alert_at = alertTimes.length ? Math.max(...alertTimes) : null;
      db.prepare("DELETE FROM job_watch_hit WHERE watch_id=? AND id=?").run(watchId, duplicate.id);
      db.prepare("UPDATE job_watch_hit SET first_at=?,alerted=?,unread=?,alert_at=? WHERE watch_id=? AND id=?")
        .run(prior.first_at, prior.alerted, prior.unread, prior.alert_at, watchId, prior.id);
    }
    if (prior && job.verification === "official-detail" && job.availability === "open") {
      const previous = OfficialJobDiscoveryCandidateSchema.parse(JSON.parse(prior.job));
      if (normalizeSourceUrl(previous.url) === url && previous.company === job.company) {
        job.employerGroup ??= previous.employerGroup;
        job.companyWebsite ??= previous.companyWebsite;
        if (!job.sourceId && !job.sourceProposal) job.sourceProposal = previous.sourceProposal;
      }
    }
    const match = assessJobWatchMatch(job, criteria);
    if (!match || !company) {
      if (prior && job.verification === "official-detail") db.prepare("UPDATE job_watch_hit SET visible=0,unread=0 WHERE watch_id=? AND id=?").run(watchId, prior.id);
      return;
    }
    const eligible = match.tier !== "related";
    const unread = eligible && (!prior?.alerted || prior.unread === 1);
    const alerted = eligible || Boolean(prior?.alerted);
    const alertAt = eligible && !prior?.alerted ? now() : prior?.alert_at ?? null;
    db.prepare(`INSERT INTO job_watch_hit(watch_id,id,url,company,job,match,tier,first_at,last_at,unread,alerted,visible,alert_at,relevance)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(watch_id,id) DO UPDATE SET url=excluded.url,company=excluded.company,
      job=excluded.job,match=excluded.match,tier=excluded.tier,last_at=excluded.last_at,unread=excluded.unread,alerted=excluded.alerted,visible=1,alert_at=excluded.alert_at,relevance=excluded.relevance`)
      .run(watchId, prior?.id ?? id, url, company, JSON.stringify(job), JSON.stringify(match), match.tier, prior?.first_at ?? observed, observed, Number(unread), Number(alerted), alertAt, match.skillEvidence.length * 4 + match.secondaryMatches.length);
  }

  async function research(watch: StoredWatch, controller: AbortController) {
    const config = configOf(watch);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
    const observedAt = date(now());
    let pages = 0;
    try {
      let cursor = watch.cursor ? decodeCursor(watch.cursor) : undefined;
      const execution: OfficialJobDiscoveryExecution = {
        context: makeExecutionContext(watch.actor_scope, signal, observedAt),
        transport: options.transport, detailTransport: options.detailTransport, searchProvider: provider,
        registeredSources: await options.repository.readSourceDefinitions(),
      };
      let result: OfficialJobDiscoveryResult;
      if (cursor && canExpandWebDiscovery(cursor)) {
        const before = cursor.visited.size;
        result = await expand(config.criteria, cursor, execution);
        pages = Math.max(0, cursor.visited.size - before);
      } else {
        result = await seed(config.criteria, execution);
        const previous = cursor;
        cursor = createWebJobDiscoveryState(config.criteria, result);
        if (previous) {
          // Refresh known providers periodically while keeping unvisited links and rotating new search phrases.
          cursor.searched = new Set([...previous.searched, ...cursor.searched].slice(-192));
          cursor.searchOffset = (previous.searchOffset ?? 0) + Math.max(1, previous.round);
          const known = new Set([...cursor.visited, ...cursor.queued.map(lead => lead.url)]);
          // Revisit older actual postings as part of a fresh sweep, in addition to discovering new employers.
          const older = db.prepare("SELECT url,job FROM job_watch_hit WHERE watch_id=? AND visible=1 AND tier!='related' AND last_at<? ORDER BY last_at LIMIT 12")
            .all(watch.id, now() - config.intervalMinutes * 60_000) as { url: string; job: string }[];
          const rechecks = older.filter(item => !known.has(item.url)).map(item => {
            const job = OfficialJobDiscoveryCandidateSchema.parse(JSON.parse(item.job));
            return { url: item.url, label: job.title, company: job.company, depth: 0, priority: 200 };
          });
          for (const check of rechecks) known.add(check.url);
          cursor.queued = [...rechecks, ...previous.queued.filter(lead => !known.has(lead.url)).slice(0, Math.max(0, 240 - cursor.queued.length - rechecks.length)), ...cursor.queued];
        }
      }
      execution.context.throwIfCancelled();
      const latest = row(watch.id);
      if (!latest?.enabled || latest.generation !== watch.generation || stopped) return;
      const observed = Date.parse(result.observedAt);
      const completedAt = now();
      const savedCursor = cursor;
      const nextAt = completedAt + (canExpandWebDiscovery(savedCursor) ? options.expansionIntervalMs ?? expansionInterval : config.intervalMinutes * 60_000);
      transaction(() => {
        for (const job of result.candidates) saveHit(watch.id, job, config.criteria, observed);
        for (const url of savedCursor.closedUrls ?? []) db.prepare("UPDATE job_watch_hit SET visible=0,unread=0 WHERE watch_id=? AND url=?")
          .run(watch.id, normalizeSourceUrl(url));
        db.prepare(`UPDATE job_watch SET phase=?,next_at=?,last_at=?,rounds=rounds+1,pages=pages+?,pending_pages=?,cursor=?,warnings=? WHERE id=?`)
          .run(result.status === "provider-unavailable" ? "retry" : "scheduled", nextAt, completedAt, pages, savedCursor.queued.length, encodeCursor(savedCursor), JSON.stringify(result.warnings), watch.id);
      });
    } catch {
      if (stopped || controller.signal.aborted) return;
      const latest = row(watch.id);
      if (latest?.enabled && latest.generation === watch.generation) {
        db.prepare("UPDATE job_watch SET phase='retry',next_at=?,warnings=? WHERE id=?")
          .run(now() + config.intervalMinutes * 60_000, JSON.stringify(["本轮官网探索未完成，已保留进度和候选；到期自动重试。"]), watch.id);
      }
    }
  }

  async function runDue() {
    if (closed || stopped || current) return;
    const watch = db.prepare("SELECT * FROM job_watch WHERE enabled=1 AND next_at<=? ORDER BY next_at,id LIMIT 1").get(now()) as StoredWatch | undefined;
    if (!watch) { wake(); return; }
    db.prepare("UPDATE job_watch SET phase='searching' WHERE id=?").run(watch.id);
    const controller = new AbortController();
    const task = research(watch, controller);
    current = { id: watch.id, controller, task };
    try { await task; }
    finally { current = undefined; wake(); }
  }
  const definitions = [
    defineTool({ name: "jobs.watch-start", version: 1, description: "保存并开启用户选择的持续官网探索任务。", effect: "local-write",
      inputSchema: JobWatchStartSchema, outputSchema: JobWatchReceiptSchema,
      execute: ({ config, ...handle }, context) => { start(handle, config, context); return { saved: true as const }; } }),
    defineTool({ name: "jobs.watch-status", version: 1, description: "读取指定后台寻岗任务的持久进度与待审阅候选。", effect: "read-index",
      inputSchema: JobWatchReadSchema, outputSchema: JobWatchStatusSchema,
      execute: ({ offset, view, ...handle }, context) => getStatus(authorize(handle, context), offset, view) }),
    defineTool({ name: "jobs.watch-enable", version: 1, description: "暂停或继续指定后台寻岗任务。", effect: "local-write",
      inputSchema: JobWatchEnableSchema, outputSchema: JobWatchReceiptSchema,
      execute: ({ enabled, ...handle }, context) => { changeEnabled(handle, enabled, context); return { saved: true as const }; } }),
    defineTool({ name: "jobs.watch-ack", version: 1, description: "将已审阅的确切岗位提醒标为已读。", effect: "local-write",
      inputSchema: JobWatchAckSchema, outputSchema: JobWatchReceiptSchema,
      execute: ({ hitIds, ...handle }, context) => {
        const watch = authorize(handle, context);
        transaction(() => { const statement = db.prepare("UPDATE job_watch_hit SET unread=0 WHERE watch_id=? AND id=?"); for (const id of hitIds) statement.run(watch.id, id); });
        return { saved: true as const };
      } }),
  ] as const;
  wake();
  return { definitions, runDue, async stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    current?.controller.abort();
    await current?.task.catch(() => undefined);
    closed = true;
    db.close();
  } };
}
