import assert from "node:assert/strict";
import test from "node:test";
import { createAtlasDemo } from "../src/components/atlas/demo";
import { enrichSnapshotCompaniesAndOffices } from "../src/components/atlas/live-platform-auto-import";
import type { createAtlasSourceClient } from "../src/components/atlas/service-client";

type SourceClient = ReturnType<typeof createAtlasSourceClient>;

function sourceSnapshot(raw: string, companyName = "合成科技有限公司") {
  const data = createAtlasDemo();
  const job = data.jobs[0]!;
  data.jobs = [job];
  const company = data.companies.find((item) => item.id === job.companyId)!;
  company.names = [companyName];
  data.companies = [company];
  const location = data.locations.find((item) => item.id === job.locationIds[0])!;
  delete location.coordinates;
  delete location.countryCode;
  delete location.regionId;
  delete location.city;
  location.raw = raw;
  location.precision = "unknown";
  location.kind = "unknown";
  data.locations = [location];
  return data;
}

test("normalizes a disclosed administrative area without inventing a precise office from catalog intelligence", async () => {
  const data = sourceSnapshot("上海-闵行区");
  let locationConfirms = 0;
  let officePreviews = 0;
  let officeConfirms = 0;
  const client = {
    snapshot: async () => data,
    previewLocationConfirmation: async (input: unknown) => {
      assert.match(JSON.stringify(input), /平台卡片披露原文/);
      return { expectedRevision: data.revision, previewFingerprint: "synthetic" };
    },
    confirmLocation: async () => {
      locationConfirms++;
      data.revision++;
      data.locations[0]!.countryCode = "CN";
      data.locations[0]!.kind = "office";
      return { revision: data.revision };
    },
    previewOfficeConfirmation: async () => { officePreviews++; return { expectedRevision: data.revision, previewFingerprint: "synthetic" }; },
    confirmOfficeAddress: async () => { officeConfirms++; return { revision: ++data.revision }; },
  } as unknown as SourceClient;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ results: {
    [data.jobs[0]!.companyId]: { sourceMethod: "catalog-heuristic", resolvedOffice: {
      district: "闵行区", streetAddress: "紫竹高新技术产业开发区东川路555号",
      formattedAddress: "上海市闵行区紫竹高新技术产业开发区东川路555号", latitude: 31.0285, longitude: 121.4485,
    } },
  } });
  try {
    const result = await enrichSnapshotCompaniesAndOffices({ client, snapshot: data });
    assert.equal(locationConfirms, 1);
    assert.equal(result.locationsConfirmed, 1);
    assert.equal(officePreviews, 0);
    assert.equal(officeConfirms, 0);
    assert.equal(result.officeAddressesConfirmed, 0);
    assert.equal(result.snapshot.locations[0]!.coordinates, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test("does not use search filters or an employer city to fill unknown job geography", async () => {
  const data = sourceSnapshot("地点待披露", "上海合成科技有限公司");
  let locationConfirms = 0;
  const client = {
    snapshot: async () => data,
    previewLocationConfirmation: async () => { locationConfirms++; return {}; },
    confirmLocation: async () => { locationConfirms++; return {}; },
  } as unknown as SourceClient;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ results: {} });
  try {
    const result = await enrichSnapshotCompaniesAndOffices({
      client, snapshot: data, fallbackChinaSelection: { provinceCode: "31", cityCode: "3101", districtCode: "310112" },
    });
    assert.equal(locationConfirms, 0);
    assert.equal(result.locationsConfirmed, 0);
    assert.equal(result.snapshot.locations[0]!.countryCode, undefined);
    assert.equal(result.snapshot.locations[0]!.coordinates, undefined);
  } finally { globalThis.fetch = originalFetch; }
});
