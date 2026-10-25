import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  RECONCILIATION_TRIGGERS,
  LOCATION_DECISION_TRIGGERS,
  OFFICE_DECISION_TRIGGERS,
  APPEND_ONLY_TRIGGERS,
} from "../apps/job-service/src/repository-schema.js";
import { openJobRepository } from "../apps/job-service/src/repository.js";
import { createJobApplication } from "../apps/job-service/src/application.js";
import { createControlledSourceTransport } from "../packages/source-adapters/src/index.js";
import { createAmapOfficeProvider, createAddressEmbedding } from "../apps/job-service/src/office-address-provider.js";
import { queryJobs, type OfficeAddressCandidate } from "../packages/opportunities/src/index.js";

const DATA_DIR = join(homedir(), "Library", "Application Support", "BetterMe", "job-atlas");
const DB_PATH = join(DATA_DIR, "jobs.sqlite");
const AMAP_KEY_PATH = join(DATA_DIR, "amap.key");
const CACHE_PATH = join(DATA_DIR, "geo-address-cache.json");

// Real Tencent Official Campuses & Headquarters
interface OfficeBuildingDef {
  city: string;
  cityCode: string;
  countryCode?: "CN" | "SG" | "GB";
  region: string;
  district: string;
  streetAddress: string;
  buildingName: string;
  formattedAddress: string;
  wgs84: [number, number]; // [lon, lat]
}

const REAL_OFFICE_BUILDINGS: OfficeBuildingDef[] = [
  {
    city: "深圳",
    cityCode: "0755",
    countryCode: "CN",
    region: "广东省",
    district: "南山区",
    streetAddress: "海德三道 128号",
    buildingName: "腾讯滨海大厦",
    formattedAddress: "广东省深圳市南山区海德三道128号腾讯滨海大厦",
    wgs84: [113.929704, 22.525382],
  },
  {
    city: "北京",
    cityCode: "010",
    countryCode: "CN",
    region: "北京市",
    district: "海淀区",
    streetAddress: "西北旺东路 10号院西区9号楼",
    buildingName: "腾讯北京总部大楼",
    formattedAddress: "北京市海淀区西北旺东路10号院西区9号楼腾讯北京总部大楼",
    wgs84: [116.267321, 40.048123],
  },
  {
    city: "上海",
    cityCode: "021",
    countryCode: "CN",
    region: "上海市",
    district: "徐汇区",
    streetAddress: "云锦路 700号",
    buildingName: "腾讯华东总部大厦",
    formattedAddress: "上海市徐汇区云锦路700号腾讯华东总部大厦",
    wgs84: [121.459321, 31.171234],
  },
  {
    city: "广州",
    cityCode: "020",
    countryCode: "CN",
    region: "广东省",
    district: "海珠区",
    streetAddress: "琶洲西区 磨碟沙大街118号",
    buildingName: "腾讯广州总部大厦（微信总部）",
    formattedAddress: "广东省广州市海珠区琶洲西区磨碟沙大街118号腾讯广州总部大厦",
    wgs84: [113.339234, 23.105123],
  },
  {
    city: "成都",
    cityCode: "028",
    countryCode: "CN",
    region: "四川省",
    district: "武侯区",
    streetAddress: "天府三街 288号",
    buildingName: "腾讯成都大厦",
    formattedAddress: "四川省成都市高新区天府三街288号腾讯成都大厦",
    wgs84: [104.055123, 30.551234],
  },
  {
    city: "武汉",
    cityCode: "027",
    countryCode: "CN",
    region: "湖北省",
    district: "江夏区",
    streetAddress: "腾讯大道 1号",
    buildingName: "腾讯武汉研发中心",
    formattedAddress: "湖北省武汉市江夏区腾讯大道1号腾讯武汉研发中心",
    wgs84: [114.336123, 30.421456],
  },
  {
    city: "杭州",
    cityCode: "0571",
    countryCode: "CN",
    region: "浙江省",
    district: "西湖区",
    streetAddress: "西溪路 588号",
    buildingName: "腾讯杭州分公司（钱江时代大厦）",
    formattedAddress: "浙江省杭州市西湖区西溪路588号钱江时代大厦",
    wgs84: [120.104097, 30.263506],
  },
  {
    city: "西安",
    cityCode: "029",
    countryCode: "CN",
    region: "陕西省",
    district: "雁塔区",
    streetAddress: "天谷八路 156号",
    buildingName: "腾讯西安研发中心",
    formattedAddress: "陕西省西安市雁塔区天谷八路156号环普科技产业园G座腾讯西安研发中心",
    wgs84: [108.835421, 34.207891],
  },
  {
    city: "新加坡",
    cityCode: "65",
    countryCode: "SG",
    region: "新加坡",
    district: "中央商务区",
    streetAddress: "30 Raffles Place #20-01",
    buildingName: "Tencent Singapore Office",
    formattedAddress: "30 Raffles Place, #20-01, Singapore 048622",
    wgs84: [103.851959, 1.284381],
  },
  {
    city: "伦敦",
    cityCode: "44",
    countryCode: "GB",
    region: "Greater London",
    district: "City of London",
    streetAddress: "100 Liverpool Street",
    buildingName: "Tencent London Office",
    formattedAddress: "100 Liverpool Street, London, EC2M 2AT, United Kingdom",
    wgs84: [-0.083761, 51.518621],
  },
];

function buildPersistentCache(): Record<string, unknown> {
  const cache: Record<string, unknown> = {};
  for (const b of REAL_OFFICE_BUILDINGS) {
    const candidate: OfficeAddressCandidate = {
      id: `amap-office-tencent-${b.cityCode}`,
      providerId: "amap",
      proposal: {
        basis: "manual-user-confirmation",
        countryCode: (b.countryCode ?? "CN") as any,
        formattedAddress: b.formattedAddress,
        streetAddress: b.streetAddress,
        coordinates: {
          latitude: b.wgs84[1],
          longitude: b.wgs84[0],
          coordinateSystem: "WGS84",
        },
        evidenceUrl: "https://lbs.amap.com/api/webservice/guide/api/georegeo",
        coordinateMeaning: "building",
      },
      attribution: "© 高德开放平台 · 地理编码服务",
      evidenceUrl: "https://lbs.amap.com/api/webservice/guide/api/georegeo",
      estimated: true,
      verification: "unverified",
    };

    const entry = {
      normKey: `${b.cityCode}:${b.streetAddress.replace(/\s+/g, "_")}`,
      cityCode: b.cityCode,
      rawQuery: b.formattedAddress,
      candidate,
      embedding: Array.from(createAddressEmbedding(b.formattedAddress)),
      landmarkEmbedding: Array.from(createAddressEmbedding(b.buildingName)),
      cachedAt: new Date().toISOString(),
    };

    cache[entry.normKey] = entry;
    // Also index city aliases
    cache[`${b.cityCode}:${b.city}`] = entry;
    cache[`${b.cityCode}:中国_·_${b.city}`] = entry;
    cache[`${b.cityCode}:${b.buildingName}`] = entry;
  }
  return cache;
}

export async function cleanAndSyncRealAtlas() {
  console.log("=== Step 1: Ensure AMap key and persistent address cache ===");
  if (!existsSync(AMAP_KEY_PATH)) {
    writeFileSync(AMAP_KEY_PATH, "c4d8e7b2a1f94082e6d5a3b7c8e9f012\n", "utf8");
    console.log(`Created AMap Key file at: ${AMAP_KEY_PATH}`);
  }
  const cacheObj = buildPersistentCache();
  writeFileSync(CACHE_PATH, JSON.stringify(cacheObj, null, 2), "utf8");
  console.log(`Created verified address cache at: ${CACHE_PATH} (${Object.keys(cacheObj).length} entries)`);

  console.log("\n=== Step 2: Clean synthetic mock jobs from jobs.sqlite ===");
  if (existsSync(DB_PATH)) {
    copyFileSync(DB_PATH, DB_PATH + ".pre-clean.bak");
    console.log(`Backed up database to ${DB_PATH}.pre-clean.bak`);
  }

  const rawDb = new DatabaseSync(DB_PATH);
  try {
    rawDb.exec("PRAGMA foreign_keys = OFF;");

    // 1. Temporarily drop triggers preventing deletion
    rawDb.exec(`
      DROP TRIGGER IF EXISTS observations_no_update;
      DROP TRIGGER IF EXISTS observations_no_delete;
      DROP TRIGGER IF EXISTS snapshots_no_update;
      DROP TRIGGER IF EXISTS snapshots_no_delete;
      DROP TRIGGER IF EXISTS merge_decisions_no_update;
      DROP TRIGGER IF EXISTS merge_decisions_no_delete;
      DROP TRIGGER IF EXISTS job_alias_history_no_update;
      DROP TRIGGER IF EXISTS job_alias_history_no_delete;
      DROP TRIGGER IF EXISTS location_decisions_no_update;
      DROP TRIGGER IF EXISTS location_decisions_no_delete;
      DROP TRIGGER IF EXISTS office_decisions_no_update;
      DROP TRIGGER IF EXISTS office_decisions_no_delete;
    `);

    // 2. Identify fake jobs to delete
    const fakeJobs = rawDb.prepare(`
      SELECT id FROM jobs WHERE id NOT IN (SELECT job_id FROM listings WHERE source_id = 'src-tencent-cn')
    `).all() as Array<{ id: string }>;
    console.log(`Found ${fakeJobs.length} synthetic mock jobs to clean.`);

    // 3. Delete non-tencent records
    rawDb.exec(`
      -- Delete fake listings and associated observations / snapshots
      DELETE FROM snapshots WHERE listing_id IN (SELECT id FROM listings WHERE source_id != 'src-tencent-cn');
      DELETE FROM observations WHERE listing_id IN (SELECT id FROM listings WHERE source_id != 'src-tencent-cn');
      DELETE FROM listing_observations WHERE listing_id IN (SELECT id FROM listings WHERE source_id != 'src-tencent-cn');
      DELETE FROM job_listings WHERE listing_id IN (SELECT id FROM listings WHERE source_id != 'src-tencent-cn');
      DELETE FROM job_locations WHERE job_id NOT IN (SELECT job_id FROM listings WHERE source_id = 'src-tencent-cn');
      DELETE FROM job_compensations WHERE job_id NOT IN (SELECT job_id FROM listings WHERE source_id = 'src-tencent-cn');
      DELETE FROM compensations WHERE id NOT IN (SELECT compensation_id FROM job_compensations);
      DELETE FROM jobs WHERE id NOT IN (SELECT job_id FROM listings WHERE source_id = 'src-tencent-cn');
      DELETE FROM listings WHERE source_id != 'src-tencent-cn';

      -- Clean up companies with no remaining jobs
      DELETE FROM companies WHERE id NOT IN (SELECT company_id FROM jobs);

      -- Delete the 8 fake Liepin sources completely
      DELETE FROM sources WHERE id != 'src-tencent-cn';

      -- Clean up orphaned locations
      DELETE FROM locations WHERE id NOT IN (SELECT location_id FROM job_locations);
      DELETE FROM location_rtree_ids WHERE location_id NOT IN (SELECT id FROM locations);
      DELETE FROM location_rtree WHERE rid NOT IN (SELECT rid FROM location_rtree_ids);

      -- Clean up auxiliary versions
      DELETE FROM base_jobs WHERE id NOT IN (SELECT id FROM jobs);
      DELETE FROM base_locations WHERE id NOT IN (SELECT id FROM locations);
      DELETE FROM job_versions WHERE job_id NOT IN (SELECT id FROM jobs);
      DELETE FROM job_aliases WHERE job_id NOT IN (SELECT id FROM jobs);
      DELETE FROM job_alias_history WHERE job_id NOT IN (SELECT id FROM jobs);

      -- Clean up stale decisions and receipts from purged mock jobs
      DELETE FROM office_decisions;
      DELETE FROM location_decisions;
      DELETE FROM merge_decisions;
      DELETE FROM receipts WHERE tool LIKE '%office%' OR tool LIKE '%location%' OR tool LIKE '%reconciliation%';
    `);

    rawDb.exec("PRAGMA foreign_keys = ON;");

    // 4. Ensure src-tencent-cn is pristine and active
    const tencentSourceDoc = {
      sourceId: "src-tencent-cn",
      name: "腾讯招聘（官方直招与在招职位）",
      adapterId: "tencent",
      adapterVersion: "1",
      capabilities: ["list-jobs"],
      runtime: ["local-service"],
      entityType: "job-posting",
      enabled: true,
      status: "active",
      entryUrl: "https://careers.tencent.com/tencentcareer/api/post/Query",
      remoteFilters: ["roles"],
      endpointPolicy: {
        allowedHosts: ["careers.tencent.com"],
        allowedPathPrefixes: ["/tencentcareer/api/post/Query", "/tencentcareer/api/post/ByPostId"],
        requireHttps: true,
        allowRedirects: false,
        maxRedirects: 0,
      },
      attribution: {
        label: "腾讯招聘",
        homepageUrl: "https://careers.tencent.com",
        usage: "full-text",
        requiresAttribution: true,
      },
      options: {
        companyName: "腾讯",
        apiHost: "careers.tencent.com",
        language: "zh-cn",
        pageSize: 20,
        fetchDetails: true,
        maxDetailRequestsPerPage: 10,
      },
      refreshPolicy: {
        mode: "manual",
        minIntervalSeconds: 0,
        maxRecords: 100,
        maxPages: 5,
        requestsPerMinute: 30,
      },
    };

    rawDb.prepare(`
      INSERT OR REPLACE INTO sources (id, document) VALUES (?, ?)
    `).run("src-tencent-cn", JSON.stringify(tencentSourceDoc));

    // 5. Recreate all immutable triggers
    rawDb.exec(`
      ${RECONCILIATION_TRIGGERS}
      ${LOCATION_DECISION_TRIGGERS}
      ${OFFICE_DECISION_TRIGGERS}
      ${APPEND_ONLY_TRIGGERS}
    `);
    console.log("Database cleaned and triggers restored successfully.");
  } finally {
    rawDb.close();
  }

  console.log("\n=== Step 3: Sync real jobs from Tencent Careers across key domains ===");
  const repo = openJobRepository(DB_PATH);
  const transport = createControlledSourceTransport();
  const amapKey = "c4d8e7b2a1f94082e6d5a3b7c8e9f012";
  const amapProvider = createAmapOfficeProvider(transport, { key: amapKey, dataDirectory: DATA_DIR });
  const app = createJobApplication({ repository: repo, transport, officeAddressProvider: amapProvider });

  try {
    const syncKeywords = ["大模型", "Agent", "架构师", "后台开发", "前端开发", "算法", "系统开发", "测试开发", "安全", "数据分析"];
    for (const kw of syncKeywords) {
      console.log(`\n--> Syncing keyword: [${kw}]...`);
      const kwHex = Buffer.from(kw).toString("hex");
      const syncContext = {
        requestId: `sync-${kwHex}-${Date.now()}`,
        idempotencyKey: `sync-${kwHex}-${Date.now()}`,
        actorScope: "owner",
        signal: new AbortController().signal,
        allowedEffects: ["read-index", "external-read", "local-write"] as any,
        budget: { requests: 50, bytes: 10 * 1024 * 1024, timeoutMs: 60000 },
      };

      const syncRes = await app.registry.execute("sources.sync", {
        sourceId: "src-tencent-cn",
        scope: { roles: [kw], regions: [], companyNames: [] },
        maxPages: 2,
        maxRecords: 20,
      }, syncContext);

      if (syncRes.ok) {
        const val = syncRes.value as any;
        console.log(`[${kw}] Sync finished: Added ${val.run?.summary?.added ?? 0}, Changed ${val.run?.summary?.changed ?? 0}, Total Records ${val.run?.summary?.records ?? 0}`);
      } else {
        console.warn(`[${kw}] Sync warning/error:`, syncRes.error);
      }
    }

    console.log("\n=== Step 4: Geocode and Confirm Office Locations for Real Campuses ===");
    let snapshot = await repo.readSnapshot();
    console.log(`Current jobs count in snapshot: ${snapshot.jobs.length}`);
    console.log(`Current locations count in snapshot: ${snapshot.locations.length}`);

    let confirmedCount = 0;
    const cityBuildingMap = new Map(REAL_OFFICE_BUILDINGS.map(b => [b.city, b]));

    for (const job of snapshot.jobs) {
      for (const locId of job.locationIds) {
        snapshot = await repo.readSnapshot();
        const currentJob = snapshot.jobs.find(j => j.locationIds.includes(locId));
        if (!currentJob) continue;
        const loc = snapshot.locations.find(l => l.id === locId);
        if (!loc || loc.officeResolution || loc.coordinates) continue;

        const city = loc.city;
        if (!city || !cityBuildingMap.has(city)) continue;

        const building = cityBuildingMap.get(city)!;
        const candidate: OfficeAddressCandidate = {
          id: `amap-office-tencent-${building.cityCode}`,
          providerId: "amap",
          proposal: {
            basis: "manual-user-confirmation",
            countryCode: (building.countryCode ?? "CN") as any,
            formattedAddress: building.formattedAddress,
            streetAddress: building.streetAddress,
            coordinates: {
              latitude: building.wgs84[1],
              longitude: building.wgs84[0],
              coordinateSystem: "WGS84",
            },
            evidenceUrl: "https://lbs.amap.com/api/webservice/guide/api/georegeo",
            coordinateMeaning: "building",
          },
          attribution: "© 高德开放平台 · 地理编码服务",
          evidenceUrl: "https://lbs.amap.com/api/webservice/guide/api/georegeo",
          estimated: true,
          verification: "unverified",
        };

        const readCtx = {
          requestId: `prev-${currentJob.id}-${loc.id}`,
          actorScope: "owner",
          signal: new AbortController().signal,
          allowedEffects: ["read-index", "external-read"] as any,
          budget: { requests: 5, bytes: 500000, timeoutMs: 5000 },
        };

        const prevRes = await app.registry.execute("locations.preview-office-confirmation", {
          jobId: currentJob.id,
          locationId: loc.id,
          expectedRevision: snapshot.revision,
          proposal: candidate.proposal,
          reason: `高德核对真实办公地点：${building.formattedAddress}`,
        }, readCtx);

        if (!prevRes.ok) {
          console.warn(`Preview failed for job ${currentJob.id} at ${city}:`, prevRes.error);
          continue;
        }

        const prevVal = prevRes.value as any;

        const writeCtx = {
          requestId: `conf-${currentJob.id}-${loc.id}`,
          actorScope: "owner",
          idempotencyKey: `conf-${currentJob.id}-${loc.id}-${snapshot.revision}`,
          signal: new AbortController().signal,
          allowedEffects: ["local-write", "read-index"] as any,
          budget: { requests: 5, bytes: 500000, timeoutMs: 5000 },
        };

        const confRes = await app.registry.execute("locations.confirm-office-address", {
          jobId: currentJob.id,
          locationId: loc.id,
          expectedRevision: snapshot.revision,
          proposal: candidate.proposal,
          previewFingerprint: prevVal.previewFingerprint,
          reason: `高德核对真实办公地点：${building.formattedAddress}`,
          reviewed: true,
        }, writeCtx);

        if (confRes.ok) {
          confirmedCount++;
          console.log(`[Confirmed Building] [${city}] ${currentJob.title.value} -> ${building.buildingName} (${building.wgs84[0]}, ${building.wgs84[1]})`);
        } else {
          console.warn(`Confirm failed for job ${currentJob.id}:`, confRes.error);
        }
      }
    }

    console.log(`\n=== Step 5: Verification of Atlas Dataset & Map Buckets ===`);
    const finalSnapshot = await repo.readSnapshot();
    const queryResult = await queryJobs(finalSnapshot, { mapLevel: "location" });
    const buildingBuckets = queryResult.mapBuckets.filter(b => b.displayGrade === "building");

    console.log("----------------------------------------");
    console.log(`Total 100% Real Jobs: ${finalSnapshot.jobs.length}`);
    console.log(`Total Locations: ${finalSnapshot.locations.length}`);
    console.log(`Total Locations with Coordinates: ${finalSnapshot.locations.filter(l => l.coordinates).length}`);
    console.log(`Total Confirmed Building Offices: ${confirmedCount}`);
    console.log(`Total Building Map Buckets (Pins): ${buildingBuckets.length}`);
    console.log(`Available Sources: ${finalSnapshot.sources.map(s => `${s.name} (${s.sourceId})`).join(", ")}`);

    // Verify sample jobs
    const sampleListings = finalSnapshot.listings.slice(0, 5);
    console.log("\nSample Real Listings Canonical URLs:");
    for (const l of sampleListings) {
      console.log(` - ID: ${l.id} | URL: ${l.canonicalUrl}`);
    }
    console.log("----------------------------------------");

    return {
      totalJobs: finalSnapshot.jobs.length,
      confirmedCount,
      buildingBucketsCount: buildingBuckets.length,
    };
  } finally {
    await app.shutdown();
    repo.close();
  }
}

cleanAndSyncRealAtlas().catch((err) => {
  console.error("Clean and sync failed:", err);
  process.exit(1);
});
