import test from "node:test";
import assert from "node:assert/strict";
import {
  DomainTaxonomyTool,
  OpportunityHarvestPipeline,
  SpatialGeocodingTool,
} from "../server/harvest-pipeline";
import { classifyEnterpriseOwnershipAndOrigin } from "../src/components/atlas/company-intelligence-catalog";

test("DomainTaxonomyTool dynamically expands technical domain intent without hardcoded companies", () => {
  const csharpIntent = DomainTaxonomyTool.expandIntent("C#", "上海");
  assert.equal(csharpIntent.rawKeyword, "C#");
  assert.equal(csharpIntent.region, "上海");
  assert.ok(csharpIntent.domainSynonyms.includes("C#"));
  assert.ok(csharpIntent.domainSynonyms.includes(".NET"));
  assert.ok(csharpIntent.domainSynonyms.includes("上位机"));
  // Ensure no hardcoded company names were injected
  for (const s of csharpIntent.domainSynonyms) {
    assert.equal(/特斯拉|星逻|中科|卡斯柯|西门子/i.test(s), false, `Should not inject company name: ${s}`);
  }

  const cppIntent = DomainTaxonomyTool.expandIntent("C++", "北京");
  assert.ok(cppIntent.domainSynonyms.includes("Qt"));
  assert.ok(cppIntent.domainSynonyms.includes("嵌入式软件"));
});

test("classifyEnterpriseOwnershipAndOrigin correctly classifies enterprises using dynamic statutory rules without static company dictionary", () => {
  // Central SOE rule
  const soe1 = classifyEnterpriseOwnershipAndOrigin({ companyName: "中国船舶工业集团有限公司" });
  assert.equal(soe1.controllers[0]?.jurisdictionCode, "CN");
  assert.equal(soe1.controllers[0]?.kind, "state");
  assert.ok(soe1.categoryLabel.includes("央企"));

  // Municipal SOE / Research institute rule
  const soe2 = classifyEnterpriseOwnershipAndOrigin({ companyName: "上海精密机械研究所" });
  assert.equal(soe2.controllers[0]?.kind, "state");
  assert.ok(soe2.categoryLabel.includes("国企"));

  // Joint Venture rule
  const jv = classifyEnterpriseOwnershipAndOrigin({ companyName: "上汽大众汽车有限公司" });
  assert.equal(jv.controllers.some((c) => c.kind === "joint"), true);
  assert.ok(jv.categoryLabel.includes("合资"));

  // Foreign corporate subsidiary rules
  const de = classifyEnterpriseOwnershipAndOrigin({
    companyName: "库卡机器人（上海）有限公司",
    jobTexts: ["德资企业", "GmbH"],
  });
  assert.equal(de.controllers[0]?.jurisdictionCode, "DE");
  assert.ok(de.categoryLabel.includes("德国"));

  const fr = classifyEnterpriseOwnershipAndOrigin({
    companyName: "达索系统（上海）技术有限公司",
    jobTexts: ["法资跨国公司"],
  });
  assert.equal(fr.controllers[0]?.jurisdictionCode, "FR");
  assert.ok(fr.categoryLabel.includes("法国"));

  const us = classifyEnterpriseOwnershipAndOrigin({
    companyName: "英特尔亚太研发（上海）有限公司",
  });
  assert.equal(us.controllers[0]?.jurisdictionCode, "US");
  assert.ok(us.categoryLabel.includes("外企"));

  // Listed company rule
  const listed = classifyEnterpriseOwnershipAndOrigin({
    companyName: "上海宝信软件股份有限公司",
    jobTexts: ["国内主板A股已上市"],
  });
  assert.equal(listed.controllers[0]?.kind, "private");
  assert.ok(listed.categoryLabel.includes("上市"));
});

test("SpatialGeocodingTool resolves office coordinates via district innovation hub projection", () => {
  // Shanghai Pudong Zhangjiang
  const office1 = SpatialGeocodingTool.resolveOfficeCoordinates(
    "comp-1",
    "某某软件有限公司",
    "浦东新区张江高科技园区",
  );
  assert.ok(office1);
  assert.equal(office1.district, "浦东新区");
  assert.ok(office1.latitude > 31.0 && office1.latitude < 31.5);
  assert.ok(office1.longitude > 121.3 && office1.longitude < 121.8);

  // Beijing Haidian Zhongguancun
  const office2 = SpatialGeocodingTool.resolveOfficeCoordinates(
    "comp-bj",
    "北京某智控软件公司",
    "北京·海淀区·中关村软件园",
  );
  assert.ok(office2);
  assert.equal(office2.district, "海淀区");
  assert.ok(office2.latitude > 39.8 && office2.latitude < 40.3);
  assert.ok(office2.longitude > 116.1 && office2.longitude < 116.5);

  // Shenzhen Nanshan Tech Park
  const office3 = SpatialGeocodingTool.resolveOfficeCoordinates(
    "comp-sz",
    "深圳某高新半导体研发",
    "深圳·南山区·深圳湾科技生态园",
  );
  assert.ok(office3);
  assert.equal(office3.district, "南山区");
  assert.ok(office3.latitude > 22.3 && office3.latitude < 22.7);
  assert.ok(office3.longitude > 113.7 && office3.longitude < 114.2);

  // Universal provincial city fallback (e.g. Ningbo)
  const office4 = SpatialGeocodingTool.resolveOfficeCoordinates(
    "comp-nb",
    "宁波某精密仪器股份有限公司",
    "浙江省·宁波市·鄞州区",
  );
  assert.ok(office4);
  assert.equal(office4.district, "鄞州区");
  assert.ok(office4.latitude > 29.5 && office4.latitude < 30.2);
  assert.ok(office4.longitude > 121.3 && office4.longitude < 121.8);
});

test("OpportunityHarvestPipeline executes chained stages and emits progress events", () => {
  const events: string[] = [];
  const pipeline = new OpportunityHarvestPipeline({
    keyword: "C#",
    region: "上海",
    enableWebSearch: false,
  });

  pipeline.onProgress((p) => {
    events.push(`Stage ${p.stageIndex}: ${p.stage}`);
  });

  // Execute chained Stage 1
  pipeline.stage1_ExpandIntent();
  assert.equal(events.length, 1);
  assert.ok(events[0]?.includes("stage1-intent-expansion"));

  // Stage 5 Receipt assembly check
  const receipt = pipeline.stage5_AssembleReceipt();
  assert.equal(receipt.intent.rawKeyword, "C#");
  assert.ok(receipt.intent.domainSynonyms.length >= 3);
});
