import assert from "node:assert/strict";
import test from "node:test";
import { AtlasDatasetSchema } from "@better-me/opportunities";
import { applyDatasetDelta, DatasetSyncResponseSchema } from "../../../job-service/src/dataset-sync-contract";
import { advanceLab, createLabState, LAB_STREAM_MAX_BATCHES, syncLab } from "./data";

for (const size of [5000, 15000]) test(`UI lab ${size} isolated records preserve contracts through revision updates`, () => {
  const state = createLabState(size, "ready", "a".repeat(32));
  const baseline = structuredClone(state.data);
  assert.equal(baseline.jobs.length, size);
  assert.equal(baseline.locations.filter(location => location.coordinates).length, size / 4);
  assert.ok(baseline.jobs.some(job => job.title.value.includes("C#")));
  assert.ok(baseline.jobs.some(job => job.title.value.includes("Python")));
  assert.ok(baseline.locations.some(location => location.city === "上海市"));
  assert.ok(baseline.locations.some(location => location.city === "杭州市"));
  assert.equal(DatasetSyncResponseSchema.parse(syncLab(state)).kind, "snapshot");
  for (let index = 0; index < 4; index++) advanceLab(state);
  const cursor = { epoch: state.epoch, revision: baseline.revision };
  const delta = DatasetSyncResponseSchema.parse(syncLab(state, cursor));
  assert.equal(delta.kind, "delta");
  if (delta.kind !== "delta") throw new Error("Expected delta");
  const updated = applyDatasetDelta(baseline, cursor, delta);
  AtlasDatasetSchema.parse(updated);
  assert.equal(updated.jobs.length, size + 40);
  assert.equal(updated.revision, 5);
  assert.equal(delta.upserts.locations.length, 41, "multiple updates to one map point coalesce");
  assert.equal(DatasetSyncResponseSchema.parse(syncLab(state, delta.to)).kind, "unchanged");
  assert.ok(updated.snapshots.every(snapshot => snapshot.sourceUrl.startsWith("https://careers.example.test/")));
});

test("UI lab empty and unlocated scenarios never invent production points", () => {
  const empty = createLabState(5000, "empty", "b".repeat(32));
  assert.equal(empty.data.jobs.length, 0);
  const unlocated = createLabState(5000, "unlocated", "c".repeat(32));
  assert.equal(unlocated.data.locations.filter(location => location.coordinates).length, 0);
  AtlasDatasetSchema.parse(unlocated.data);
});

test("UI lab stream lasts sixty bounded batches and recovers a stale cursor with a valid baseline", () => {
  const state = createLabState(10, "ready", "d".repeat(32));
  state.streaming = true;
  const cursor = { epoch: state.epoch, revision: state.data.revision };
  for (let index = 0; index < LAB_STREAM_MAX_BATCHES; index++) advanceLab(state);
  assert.equal(state.batches, 60);
  assert.equal(state.data.jobs.length, 610);
  const current = DatasetSyncResponseSchema.parse(syncLab(state, { ...cursor, revision: state.data.revision - 3 }));
  assert.equal(current.kind, "delta", "ordinary polls still receive incremental changes");
  const recovered = DatasetSyncResponseSchema.parse(syncLab(state, cursor));
  assert.equal(recovered.kind, "snapshot");
  if (recovered.kind === "snapshot") assert.equal(recovered.reason, "delta-too-large");
  advanceLab(state);
  assert.equal(state.streaming, false);
  assert.equal(state.batches, 60);
  assert.equal(state.data.jobs.length, 610);
});
