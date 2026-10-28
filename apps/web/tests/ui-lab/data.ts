import { createHash } from "node:crypto";
import { AtlasDatasetSchema, type AtlasDataset } from "@better-me/opportunities";
import { syntheticAtlas } from "../../../job-service/tests/synthetic-atlas";
import {
  DATASET_SYNC_PROTOCOL, DATASET_TABLES, MAX_DELTA_ENTITIES, emptyDatasetDeletes, emptyDatasetUpserts,
  type DatasetCursor, type DatasetDelta, type DatasetUpserts,
} from "../../../job-service/src/dataset-sync-contract";

export type LabScenario = "ready" | "empty" | "unlocated" | "attention" | "loading";
export const LAB_STREAM_MAX_BATCHES = 60;
export type LabState = {
  data: AtlasDataset;
  epoch: string;
  baselineSize: number;
  scenario: LabScenario;
  streaming: boolean;
  batches: number;
  changes: Array<{ revision: number; upserts: DatasetUpserts }>;
  timer?: ReturnType<typeof setInterval>;
};

/** Deliberately fictitious records. This lab never imports a user's job or resume store. */
export function createLabDataset(size: number, prefix = "ui-lab"): AtlasDataset {
  const data = syntheticAtlas(size, prefix);
  data.revision = 1;
  data.sources[0]!.name = "UI 验收合成来源 · 非真实招聘";
  data.sources[0]!.attribution.label = "UI 验收合成来源";
  const titles = ["C# 后端工程师", "Python 数据工程师", "TypeScript 前端工程师", "C# 平台工程师"];
  const companyNames = ["青屿科技", "远山实验室", "澄明软件", "序原智能", "林间数据", "知行工业"];
  data.jobs.forEach((job, index) => {
    const shanghai = index % 2 === 0;
    const city = shanghai ? "上海市" : "杭州市";
    const title = titles[index % titles.length]!;
    const text = `【UI 性能验收合成岗位，非真实招聘】\n${title}\n工作地点：${city}。负责可靠服务与团队协作。要求 3–5 年相关经验，关注可维护性与用户体验。`;
    const contentHash = createHash("sha256").update(text).digest("hex");
    job.title.value = `${title} · 合成 ${String(index + 1).padStart(5, "0")}`;
    job.description = text;
    job.status = "open";
    data.companies[index]!.names = [`${companyNames[index % companyNames.length]} · 合成企业 ${index + 1}`];
    const location = data.locations[index]!;
    location.raw = `${city}${shanghai ? "浦东新区" : "滨江区"}合成验收地址 ${index + 1} 号`;
    location.countryCode = "CN";
    location.city = city;
    location.region = shanghai ? "上海市" : "浙江省";
    location.regionId = shanghai ? "CN-SH" : "CN-ZJ";
    // One quarter have explicitly synthetic address coordinates; others remain unlocated.
    if (index % 4 === 0) location.coordinates = {
      coordinateSystem: "WGS84", latitude: 31.12 + (index % 100) / 500,
      longitude: 121.34 + Math.floor(index / 100) % 100 / 500,
    };
    location.evidence[0]!.quote = location.raw;
    const salaryId = `salary-${job.id}`;
    job.compensationIds = [salaryId];
    data.compensations.push({ id: salaryId, raw: `合成薪资 ${18 + index % 12}–${26 + index % 12}K / 月`,
      currency: "CNY", period: "month", min: (18 + index % 12) * 1000, max: (26 + index % 12) * 1000,
      tax: "gross", kind: "base", verification: "unverified", evidence: [] });
    data.snapshots[index]!.text = text;
    data.snapshots[index]!.contentHash = contentHash;
    data.observations[index]!.contentHash = contentHash;
    data.observations[index]!.availability = "open";
    data.observations[index]!.warnings = ["synthetic-ui-lab"];
  });
  return AtlasDatasetSchema.parse(data);
}

export function createLabState(size: number, scenario: LabScenario, epoch: string): LabState {
  const data = createLabDataset(scenario === "empty" ? 0 : size);
  if (scenario === "unlocated") for (const location of data.locations) {
    delete location.coordinates; location.precision = "city";
  }
  return { data, epoch, baselineSize: size, scenario, streaming: false, batches: 0, changes: [] };
}

export function advanceLab(state: LabState): void {
  if (state.batches >= LAB_STREAM_MAX_BATCHES) { state.streaming = false; clearInterval(state.timer); return; }
  const revision = state.data.revision + 1;
  const addition = createLabDataset(10, `ui-stream-${revision}`);
  const upserts = emptyDatasetUpserts();
  for (const table of DATASET_TABLES) {
    if (table === "sources") continue;
    (upserts[table] as unknown[]).push(...addition[table]);
    (state.data[table] as unknown[]).push(...addition[table]);
  }
  // Exercise a coordinate change as well as list append, without guessing real locations.
  const firstLocation = state.data.locations[0];
  if (firstLocation?.coordinates) {
    const changed = { ...firstLocation, coordinates: { ...firstLocation.coordinates,
      longitude: firstLocation.coordinates.longitude + 0.0002 } };
    state.data.locations[0] = changed;
    upserts.locations.push(changed);
  }
  state.data.revision = revision;
  state.changes.push({ revision, upserts });
  state.batches++;
}

export function syncLab(state: LabState, cursor?: DatasetCursor) {
  const current = { epoch: state.epoch, revision: state.data.revision };
  if (cursor?.epoch === state.epoch && cursor.revision === state.data.revision) {
    return { protocol: DATASET_SYNC_PROTOCOL, kind: "unchanged", cursor: current };
  }
  if (cursor?.epoch === state.epoch && cursor.revision >= 1 && cursor.revision < state.data.revision) {
    const upserts = emptyDatasetUpserts();
    for (const table of DATASET_TABLES) {
      const rows = new Map<string, unknown>();
      for (const change of state.changes.filter(change => change.revision > cursor.revision)) {
        for (const row of change.upserts[table]) rows.set(table === "sources"
          ? (row as AtlasDataset["sources"][number]).sourceId : (row as { id: string }).id, row);
      }
      (upserts[table] as unknown[]).push(...rows.values());
    }
    // Long-running lab sessions must preserve the real transport's entity bound.
    // If a tab missed the entire stream, return a valid baseline rather than an
    // over-budget delta that the production synchronizer would correctly reject.
    if (DATASET_TABLES.reduce((total, table) => total + upserts[table].length, 0) > MAX_DELTA_ENTITIES) {
      return { protocol: DATASET_SYNC_PROTOCOL, kind: "snapshot", cursor: current,
        reason: "delta-too-large", dataset: state.data };
    }
    return { protocol: DATASET_SYNC_PROTOCOL, kind: "delta", schemaVersion: 1, from: cursor, to: current,
      upserts, deletes: emptyDatasetDeletes() } satisfies DatasetDelta;
  }
  return { protocol: DATASET_SYNC_PROTOCOL, kind: "snapshot", cursor: current,
    reason: cursor ? "store-changed" : "initial", dataset: state.data };
}
