import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { AtlasDatasetSchema, type AtlasDataset } from "@better-me/opportunities";
import { openJobRepository } from "../src/repository.js";
import { createDatasetBaselineStore } from "../src/dataset-baseline.js";
import { BaselineResponseSchema, BASELINE_MAX_BYTES, BASELINE_MAX_ENTITIES, type BaselinePage } from "../src/dataset-baseline-contract.js";
import { DATASET_TABLES, datasetEntityId, applyDatasetDelta } from "../src/dataset-sync-contract.js";
import { syntheticAtlas } from "./synthetic-atlas.js";

const owner = "synthetic-baseline-owner";
const options = (idempotencyKey: string) => ({ actorScope: owner, idempotencyKey });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "better-me-baseline-"));
  const path = join(directory, "jobs.sqlite"), repo = openJobRepository(path);
  return { directory, path, repo, close: async () => { repo.close(); await rm(directory, { recursive: true, force: true }); } };
}
function collect(pages: BaselinePage[]): AtlasDataset {
  const first = pages[0]!;
  const data: AtlasDataset = { schemaVersion: 1, revision: first.cursor.revision, sources: [], companies: [], jobs: [], locations: [], compensations: [], listings: [], observations: [], snapshots: [] };
  for (const page of pages) for (const table of DATASET_TABLES) (data[table] as unknown[]).push(...page.rows[table]);
  for (const table of DATASET_TABLES) (data[table] as unknown[]).sort((a, b) => datasetEntityId(table, a) < datasetEntityId(table, b) ? -1 : 1);
  return AtlasDatasetSchema.parse(data);
}

test("bounded job-first pages reconstruct the exact public dataset, with safe progressive checkpoints and retry replay", async () => {
  const f = await fixture();
  try {
    await f.repo.importSnapshot(syntheticAtlas(200), options("seed"));
    const orphan = syntheticAtlas(0); orphan.companies = [{ ...syntheticAtlas(1, "orphan").companies[0]! }];
    await f.repo.importSnapshot(orphan, options("orphan-company"));
    const expected = await f.repo.readSnapshot();
    const directive = await f.repo.syncSnapshot({}, true);
    assert.equal(directive.kind, "baseline-required"); assert.equal("dataset" in directive, false);
    const pages: BaselinePage[] = []; let next: BaselinePage["next"];
    do {
      const value = BaselineResponseSchema.parse(await f.repo.readBaselinePage(next ? { page: next } : {}, owner));
      assert.equal(value.kind, "page"); if (value.kind !== "page") throw new Error("expired");
      assert.ok(DATASET_TABLES.reduce((sum, table) => sum + value.rows[table].length, 0) <= BASELINE_MAX_ENTITIES);
      assert.ok(Buffer.byteLength(JSON.stringify(value)) <= BASELINE_MAX_BYTES);
      pages.push(value);
      if (value.checkpoint) assert.equal(collect(pages).jobs.length, value.loadedJobs);
      if (next) assert.deepEqual(await f.repo.readBaselinePage({ page: next }, owner), value, "lost response retries must replay rather than skip rows");
      next = value.next;
    } while (next);
    assert.ok(pages.length > 1);
    assert.ok(pages.some(page => page.checkpoint && !page.complete && page.loadedJobs > 0 && page.loadedJobs < 200));
    assert.deepEqual(collect(pages), expected);
    assert.deepEqual(await f.repo.readSnapshot(), expected, "reads must not rewrite stored jobs or evidence");
    await f.repo.closeBaselineSession(pages[0]!.session, owner);
    assert.equal((await f.repo.readBaselinePage({ page: { session: pages[0]!.session, sequence: 0 } }, owner)).kind, "expired");
  } finally { await f.close(); }
});

test("concurrent commits never mix baseline revisions; the original cursor catches up with delta afterward", async () => {
  const f = await fixture();
  try {
    await f.repo.importSnapshot(syntheticAtlas(180), options("seed"));
    const expected = await f.repo.readSnapshot();
    const first = await f.repo.readBaselinePage({}, owner); assert.equal(first.kind, "page"); if (first.kind !== "page") throw new Error("expired");
    const pages = [first];
    await f.repo.importSnapshot(syntheticAtlas(3, "during-read"), options("concurrent"));
    let next = first.next;
    while (next) { const page = await f.repo.readBaselinePage({ page: next }, owner); if (page.kind !== "page") throw new Error("expired"); pages.push(page); next = page.next; }
    assert.deepEqual(collect(pages), expected);
    assert.ok(pages.every(page => page.cursor.revision === first.cursor.revision));
    const delta = await f.repo.syncSnapshot({ cursor: first.cursor }, true); assert.equal(delta.kind, "delta");
    if (delta.kind === "delta") assert.deepEqual(applyDatasetDelta(collect(pages), first.cursor, delta), await f.repo.readSnapshot());
  } finally { await f.close(); }
});

test("baseline traversal amortizes already-seen keysets without an empty HTTP page per range", async () => {
  const f = await fixture();
  try {
    await f.repo.importSnapshot(syntheticAtlas(500), options("seed"));
    let next: BaselinePage["next"], pages = 0, empty = 0;
    do {
      const page = await f.repo.readBaselinePage(next ? { page: next } : {}, owner);
      if (page.kind !== "page") throw new Error("expired");
      pages++;
      if (!DATASET_TABLES.some(table => page.rows[table].length)) empty++;
      next = page.next;
    } while (next);
    assert.ok(pages <= 18, `500 jobs required ${pages} pages`);
    assert.ok(empty <= 2, `already-delivered keysets required ${empty} empty pages`);
  } finally { await f.close(); }
});

test("cross-job evidence and parent references close before a prefix becomes queryable", async () => {
  const f = await fixture();
  try {
    const seed = syntheticAtlas(200);
    seed.companies[0]!.ultimateControllers.evidence = seed.locations[199]!.evidence;
    seed.companies[0]!.parentCompanyIds = [seed.companies[198]!.id];
    await f.repo.importSnapshot(seed, options("linked-seed"));
    const pages: BaselinePage[] = []; let next: BaselinePage["next"];
    do {
      const page = await f.repo.readBaselinePage(next ? { page: next } : {}, owner);
      if (page.kind !== "page") throw new Error("expired");
      pages.push(page);
      if (page.checkpoint) collect(pages); // Global reference validation, including back-edges.
      next = page.next;
    } while (next);
    assert.deepEqual(collect(pages), await f.repo.readSnapshot());
    assert.ok(pages.some(page => page.checkpoint && !page.complete && page.loadedJobs > 64));
  } finally { await f.close(); }
});

test("an indivisible long JD is transmitted intact on its own bounded exceptional page", async () => {
  const f = await fixture();
  try {
    const seed = syntheticAtlas(1), text = "合成岗位内容 ".repeat(40_000);
    const hash = createHash("sha256").update(text).digest("hex");
    seed.jobs[0]!.description = text; seed.snapshots[0]!.text = text;
    seed.snapshots[0]!.contentHash = hash; seed.observations[0]!.contentHash = hash;
    await f.repo.importSnapshot(seed, options("long-jd"));
    const pages: BaselinePage[] = []; let next: BaselinePage["next"];
    do {
      const page = await f.repo.readBaselinePage(next ? { page: next } : {}, owner);
      if (page.kind !== "page") throw new Error("expired");
      pages.push(page);
      if (Buffer.byteLength(JSON.stringify(page)) > BASELINE_MAX_BYTES) {
        assert.equal(DATASET_TABLES.reduce((sum, table) => sum + page.rows[table].length, 0), 1);
      }
      next = page.next;
    } while (next);
    assert.equal(pages.filter(page => Buffer.byteLength(JSON.stringify(page)) > BASELINE_MAX_BYTES).length, 2);
    assert.deepEqual(collect(pages), await f.repo.readSnapshot());
  } finally { await f.close(); }
});

test("paged public office quarantine agrees exactly with full export without rewriting stored decisions", async () => {
  const f = await fixture();
  try {
    const seed = syntheticAtlas(1);
    delete seed.locations[0]!.coordinates; seed.locations[0]!.precision = "unknown";
    await f.repo.importSnapshot(seed, options("seed"));
    const current = await f.repo.readSnapshot();
    const input = { jobId: seed.jobs[0]!.id, locationId: seed.locations[0]!.id, expectedRevision: current.revision,
      reason: "企业公开办公区与园区坐标核实：Synthetic historical campus", proposal: { basis: "manual-user-confirmation" as const,
        countryCode: "CN", formattedAddress: "上海 Synthetic Road 123", streetAddress: "Synthetic Road 123",
        evidenceUrl: seed.listings[0]!.canonicalUrl, coordinates: { latitude: 31.2, longitude: 121.5, coordinateSystem: "WGS84" as const }, coordinateMeaning: "building" as const } };
    const preview = await f.repo.previewOfficeConfirmation(input);
    await f.repo.confirmOfficeAddress({ ...input, reviewed: true, previewFingerprint: preview.previewFingerprint }, { ...options("legacy"), expectedRevision: current.revision });
    const expected = await f.repo.readSnapshot(), pages: BaselinePage[] = []; let next: BaselinePage["next"];
    do {
      const page = await f.repo.readBaselinePage(next ? { page: next } : {}, owner);
      if (page.kind !== "page") throw new Error("expired");
      pages.push(page); next = page.next;
    } while (next);
    const result = collect(pages);
    assert.deepEqual(result, expected); assert.equal(result.locations[0]!.coordinates, undefined);
    assert.match(result.observations[0]!.warnings.join(" "), /legacy-office-coordinate-quarantined/);
    assert.deepEqual(await f.repo.readSnapshot(), expected);
  } finally { await f.close(); }
});

test("idle expiration, absolute lifetime, owner isolation, release and capacity are bounded", async () => {
  const f = await fixture(); let time = 0;
  const store = createDatasetBaselineStore(f.path, { now: () => time, idleMs: 100, lifetimeMs: 150, maxSessions: 1 });
  try {
    await f.repo.importSnapshot(syntheticAtlas(80), options("seed"));
    const first = store.read({}, owner); if (first.kind !== "page") throw new Error("expired");
    assert.equal(store.read({ page: first.next! }, "another-owner").kind, "expired");
    assert.throws(() => store.read({}, owner), /baseline-capacity/);
    time = 80; const second = store.read({ page: first.next! }, owner); if (second.kind !== "page") throw new Error("expired");
    time = 151; assert.equal(store.read({ page: second.next! }, owner).kind, "expired", "active requests cannot pin WAL forever");
    const fresh = store.read({}, owner); if (fresh.kind !== "page") throw new Error("expired");
    store.closeSession(fresh.session, "another-owner"); assert.throws(() => store.read({}, owner), /baseline-capacity/);
    store.closeSession(fresh.session, owner); assert.equal(store.read({}, owner).kind, "page");
    time = 252; const afterIdle = store.read({}, owner); assert.equal(afterIdle.kind, "page");
  } finally { store.close(); await f.close(); }
});
