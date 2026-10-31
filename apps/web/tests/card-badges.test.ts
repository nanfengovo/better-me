import test from "node:test";
import assert from "node:assert/strict";
import type { JobSearchItem } from "@better-me/opportunities";
import {
  formatCardPlatform,
  formatCardPublication,
  formatCardDistance,
  formatCardSalaryRMB,
  parseSalaryToMonthlyK,
  matchCardSalary,
  matchCardPlatform,
  matchCardDistance,
  matchCardPublication,
} from "../src/components/atlas/card-badges";

function createMockItem(overrides: Partial<JobSearchItem> = {}): JobSearchItem {
  return {
    job: {
      id: "job-1",
      companyId: "company-1",
      title: { value: "C#高级开发工程师" },
      listingIds: ["listing-1"],
      locations: [],
      compensationIds: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    } as any,
    company: {
      id: "company-1",
      names: ["特斯拉上海超级工厂"],
      jurisdiction: "CN",
    } as any,
    locations: [],
    salaryCandidates: [],
    salarySelection: "none",
    salaryLocationScope: "bound",
    color: {
      ruleId: "domestic-foreign",
      color: "#76BD8A",
      label: "外商独资",
      classification: {
        ownership: "foreign",
        jurisdictions: ["US"],
      },
    } as any,
    relevance: 1,
    matchedFields: ["title"],
    sources: [
      {
        sourceId: "reviewed-platform-51job",
        label: "51Job · 人工核对卡片",
        listingId: "listing-1",
      },
    ],
    ...overrides,
  };
}

test("formatCardPlatform identifies platforms correctly", () => {
  assert.equal(
    formatCardPlatform(createMockItem({ sources: [{ sourceId: "reviewed-platform-51job", label: "51Job · 人工核对卡片", listingId: "1" }] })),
    "51Job",
  );
  assert.equal(
    formatCardPlatform(createMockItem({ sources: [{ sourceId: "reviewed-platform-boss", label: "BOSS直聘 · 人工核对卡片", listingId: "1" }] })),
    "BOSS直聘",
  );
  assert.equal(
    formatCardPlatform(createMockItem({ sources: [{ sourceId: "reviewed-platform-liepin", label: "猎聘 · 人工核对卡片", listingId: "1" }] })),
    "猎聘",
  );
  assert.equal(
    formatCardPlatform(createMockItem({ sources: [{ sourceId: "src-tencent-cn", label: "腾讯招聘", listingId: "1" }] })),
    "腾讯招聘",
  );
  assert.equal(
    formatCardPlatform(createMockItem({ sources: [{ sourceId: "reviewed-bosch-china-official", label: "博世官网", listingId: "1" }] })),
    "博世官网",
  );
});

test("formatCardPublication calculates days ago and dates over 3 months", () => {
  const now = Date.now();
  const threeDaysAgo = new Date(now - 3 * 86400000).toISOString();
  const mockPub = (publishedAt: string) => [
    {
      listingId: "listing-1",
      sourceId: "src-1",
      label: "51Job",
      badge: { foreground: "#000", background: "#fff", border: "#ccc", id: "1", matchedBy: "sourceId" as const },
      publication: {
        label: "3天前",
        status: "recent" as const,
        precision: "instant" as const,
        colors: { foreground: "#000", background: "#fff", border: "#ccc" },
        timeZone: "Asia/Shanghai",
        publishedAt,
      },
    },
  ];

  const item = createMockItem();

  // 3 days ago
  const res3Days = formatCardPublication(item, mockPub(threeDaysAgo));
  assert.equal(res3Days.label, "3天前");

  // Today
  const todayIso = new Date().toISOString();
  const resToday = formatCardPublication(item, mockPub(todayIso));
  assert.equal(resToday.label, "今天");

  // 120 days ago (>90 days -> must show publication date YYYY-MM-DD)
  const d120DaysAgo = new Date(now - 120 * 86400000);
  const res120Days = formatCardPublication(item, mockPub(d120DaysAgo.toISOString()));
  assert.equal(res120Days.label, d120DaysAgo.toISOString().slice(0, 10));
});

test("formatCardDistance handles coordinates, missing coordinates and missing anchor", () => {
  const itemWithDistance = createMockItem({
    distance: { km: 12.4, estimated: false } as any,
  });
  assert.equal(formatCardDistance(itemWithDistance, true).label, "距家 12km");

  const itemEstimated = createMockItem({
    distance: { km: 24.8, estimated: true } as any,
  });
  assert.equal(formatCardDistance(itemEstimated, true).label, "距家 约25km");

  const itemNoCoordWithAnchor = createMockItem({ distance: undefined });
  assert.equal(formatCardDistance(itemNoCoordWithAnchor, true).label, "距家 待定位");

  const itemNoAnchor = createMockItem({ distance: undefined });
  assert.equal(formatCardDistance(itemNoAnchor, false).label, "未设家坐标");
});

test("formatCardSalaryRMB displays salary ranges explicitly in RMB", () => {
  // Normalized CNY Annual
  const itemAnnual = createMockItem({
    salary: {
      schemaVersion: 1,
      ruleVersion: "annual-base-v1",
      compensationId: "c1",
      raw: "25-35万/年",
      verification: "unverified",
      evidence: [],
      status: "comparable",
      reason: "comparable",
      estimated: false,
      assumptions: [],
      cnyAnnual: { currency: "CNY", min: 250000, max: 350000 },
    } as any,
  });
  assert.equal(formatCardSalaryRMB(itemAnnual).label, "¥25–35万/年");

  // Raw monthly K salary (e.g. 9-17k)
  const itemRawK = createMockItem({
    salary: {
      schemaVersion: 1,
      ruleVersion: "annual-base-v1",
      compensationId: "c2",
      raw: "9-17k",
      verification: "unverified",
      evidence: [],
      status: "unavailable",
      reason: "unknown-period",
      estimated: false,
      assumptions: [],
    } as any,
  });
  assert.equal(formatCardSalaryRMB(itemRawK).label, "9-17k");

  // Raw with bonus (e.g. 1.5-2.5万·14薪)
  const itemRawBonus = createMockItem({
    salary: {
      raw: "1.5-2.5万·14薪",
    } as any,
  });
  assert.equal(formatCardSalaryRMB(itemRawBonus).label, "1.5-2.5万·14薪");

  // Undisclosed
  const itemUnknown = createMockItem({ salary: undefined, salaryCandidates: [] });
  assert.equal(formatCardSalaryRMB(itemUnknown).label, "薪资未披露");
  assert.equal(formatCardSalaryRMB(itemUnknown).isNegotiable, false);
});

test("matchCardPlatform correctly matches platform filters", () => {
  const item51 = createMockItem({ sources: [{ sourceId: "reviewed-platform-51job", label: "51Job · 人工核对卡片", listingId: "1" }] });
  const itemTencent = createMockItem({ sources: [{ sourceId: "src-tencent-cn", label: "腾讯招聘", listingId: "1" }] });
  const itemBosch = createMockItem({ sources: [{ sourceId: "reviewed-bosch-china-official", label: "博世官网", listingId: "1" }] });

  assert.equal(matchCardPlatform(item51, "ALL"), true);
  assert.equal(matchCardPlatform(item51, "51job"), true);
  assert.equal(matchCardPlatform(item51, "tencent"), false);

  assert.equal(matchCardPlatform(itemTencent, "tencent"), true);
  assert.equal(matchCardPlatform(itemTencent, "51job"), false);

  assert.equal(matchCardPlatform(itemBosch, "official"), true);
  assert.equal(matchCardPlatform(itemBosch, "51job"), false);
});

test("parseSalaryToMonthlyK and matchCardSalary filter correctly", () => {
  const item9to17k = createMockItem({ salary: { raw: "¥9-17k/月" } as any });
  const parsed1 = parseSalaryToMonthlyK(item9to17k);
  assert.equal(parsed1.minK, 9);
  assert.equal(parsed1.maxK, 17);
  assert.equal(parsed1.isNegotiable, false);

  // 9-17k matches 10-20k (overlaps [10, 20])
  assert.equal(matchCardSalary(item9to17k, "10-20k"), true);
  // 9-17k does not match >50k
  assert.equal(matchCardSalary(item9to17k, ">50k"), false);

  const item15to30w = createMockItem({ salary: { raw: "¥1.5-3万/月·13薪" } as any });
  const parsed2 = parseSalaryToMonthlyK(item15to30w);
  assert.equal(parsed2.minK, 15);
  assert.equal(parsed2.maxK, 30);
  assert.equal(matchCardSalary(item15to30w, "10-20k"), true);
  assert.equal(matchCardSalary(item15to30w, "20-30k"), true);
  assert.equal(matchCardSalary(item15to30w, "<10k"), false);

  const itemNegotiable = createMockItem({ salary: { raw: "面议" } as any });
  assert.equal(matchCardSalary(itemNegotiable, "negotiable"), true);
  assert.equal(matchCardSalary(itemNegotiable, "20-30k"), false);
});

test("matchCardDistance filters by kilometer bounds", () => {
  const item12km = createMockItem({ distance: { km: 12.3, estimated: false } as any });
  assert.equal(matchCardDistance(item12km, "5km"), false);
  assert.equal(matchCardDistance(item12km, "10km"), false);
  assert.equal(matchCardDistance(item12km, "20km"), true);
  assert.equal(matchCardDistance(item12km, "30km"), true);
  assert.equal(matchCardDistance(item12km, "exact"), true);

  const itemEst = createMockItem({ distance: { km: 8, estimated: true } as any });
  assert.equal(matchCardDistance(itemEst, "10km"), true);
  assert.equal(matchCardDistance(itemEst, "exact"), false);
});

test("matchCardPublication filters by days relative to publication", () => {
  const itemToday = createMockItem();
  const mockPub = (raw: string) => [
    {
      listingId: "1",
      sourceId: "src-1",
      label: "51Job",
      badge: { foreground: "#000", background: "#fff", border: "#ccc", id: "1", matchedBy: "sourceId" as const },
      publication: {
        label: raw,
        status: "recent" as const,
        precision: "instant" as const,
        colors: { foreground: "#000", background: "#fff", border: "#ccc" },
        timeZone: "Asia/Shanghai",
        ...(raw === "今天" ? { publishedAt: new Date().toISOString() } : raw === "5天前" ? { publishedAt: new Date(Date.now() - 5 * 86400000).toISOString() } : { calendarDate: raw }),
      },
    },
  ];

  assert.equal(matchCardPublication(itemToday, "3d", mockPub("今天")), true);
  assert.equal(matchCardPublication(itemToday, "7d", mockPub("5天前")), true);
  assert.equal(matchCardPublication(itemToday, "3d", mockPub("5天前")), false);
  assert.equal(matchCardPublication(itemToday, ">90d", mockPub("2025-01-01")), true);
  assert.equal(matchCardPublication(itemToday, "30d", mockPub("2025-01-01")), false);
});

test("collection timestamps and unresolved relative text never imply a publication date", () => {
  const item = createMockItem();
  const collected = new Date().toISOString();
  const data = { sources: [], listings: [{ id: "listing-1", sourceId: item.sources[0]!.sourceId, firstDiscoveredAt: collected, observationIds: ["obs-1"] }], observations: [{ id: "obs-1", fetchedAt: collected }] } as any;
  assert.equal(formatCardPublication(item, undefined, data).label, "发布时间未知");
  assert.equal(matchCardPublication(item, "30d", undefined, data), false);
  assert.equal(matchCardPublication(item, "3d", [{ publication: { raw: "今天", status: "unknown", precision: "raw", label: "发布时间原文：今天" } }] as any), false);
});

test("salary uncertainty preserves evidence without inventing currency or negotiability", () => {
  const rawSalary = (raw: string) => createMockItem({ salary: { raw } as any });
  const broken = rawSalary("\ue001\ue002-\ue003万");
  assert.equal(formatCardSalaryRMB(broken).label, "薪资待核实");
  assert.ok(formatCardSalaryRMB(broken).tooltip.includes("\ue001"));
  assert.equal(formatCardSalaryRMB(rawSalary("USD 100-120k/year")).label, "USD 100-120k/year");
  for (const item of [broken, rawSalary("USD 100-120k/year"), rawSalary("待定"), createMockItem(), rawSalary("9-17k")]) {
    for (const filter of ["negotiable", "<10k", "10-20k", ">50k"]) assert.equal(matchCardSalary(item, filter), false);
  }
  assert.equal(matchCardSalary(rawSalary("面议"), "negotiable"), true);
  const ambiguous = createMockItem({ salarySelection: "ambiguous" });
  assert.equal(formatCardSalaryRMB(ambiguous).label, "多种薪资待核实");
  assert.equal(matchCardSalary(ambiguous, "<10k"), false);
});
