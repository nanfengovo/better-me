import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SourceDefinitionSchema } from "@better-me/opportunities";
import { SourceCatalogSchema, availableCatalogEntries, sourceCatalogIdentity, sourceCatalog } from "../src/components/atlas/source-catalog.ts";

const source = SourceDefinitionSchema.parse({ sourceId: "synthetic-catalog", name: "Synthetic company", adapterId: "mapped-json", adapterVersion: "1", capabilities: ["list-jobs"], remoteFilters: [], runtime: ["local-service"], entityType: "job-posting", enabled: false, status: "needs-review", entryUrl: "https://example.invalid/jobs?b=2&a=1", options: { titlePath: "title", urlPath: "url", discoveryOnly: false }, endpointPolicy: { allowedHosts: ["example.invalid"], allowedPathPrefixes: ["/jobs"], requireHttps: true, allowRedirects: false, maxRedirects: 0 }, attribution: { label: "Synthetic source", usage: "unknown", requiresAttribution: true }, refreshPolicy: { mode: "manual", minIntervalSeconds: 60, maxRecords: 100, maxPages: 1, requestsPerMinute: 5 } });
const entry = { source, tags: ["C#", ".NET"], coverage: "Synthetic bounded job feed", checkedAt: "2026-10-19T00:00:00Z", evidenceUrls: ["https://example.invalid/docs"] };

test("the built-in source catalog is validated inert data with unique identifiers and evidence", () => {
  const parsed = SourceCatalogSchema.parse({ schemaVersion: 1, entries: sourceCatalog });
  assert.equal(new Set(parsed.entries.map((item) => item.source.sourceId)).size, parsed.entries.length);
  assert.ok(parsed.entries.every((item) => !item.source.enabled && item.source.status === "needs-review" && item.evidenceUrls.length > 0));
});
test("catalog rejects activated, duplicate or non-job entries instead of silently advertising them as searchable", () => {
  for (const changed of [{ enabled: true }, { status: "active" }, { entityType: "discovery-lead" }, { capabilities: [] }, { entryUrl: undefined }]) {
    assert.equal(SourceCatalogSchema.safeParse({ schemaVersion: 1, entries: [{ ...entry, source: { ...source, ...changed } }] }).success, false);
  }
  assert.equal(SourceCatalogSchema.safeParse({ schemaVersion: 1, entries: [entry, structuredClone(entry)] }).success, false);
});

test("SmartRecruiters catalog entries bind one tenant and remain explicit reviewable configuration", () => {
  const preset = sourceCatalog.find((item) => item.source.adapterId === "smartrecruiters");
  assert.ok(preset);
  assert.equal(preset.source.options?.companyIdentifier, "BoschGroup");
  assert.equal(preset.source.options?.countryCode, "CN");
  assert.equal(preset.source.options?.fetchDetails, true);
  assert.deepEqual(preset.source.endpointPolicy.allowedPathPrefixes, ["/v1/companies/BoschGroup/postings"]);
  assert.deepEqual(preset.source.remoteFilters, ["roles"]);
  for (const changed of [{ options: { companyIdentifier: "../Other" } }, { entryUrl: "https://api.smartrecruiters.com/v1/companies/Other/postings" }, { remoteFilters: [] }]) {
    assert.equal(SourceCatalogSchema.safeParse({ schemaVersion: 1, entries: [{ ...preset, source: { ...preset.source, ...changed } }] }).success, false);
  }
  assert.equal(availableCatalogEntries([preset], [preset.source]).length, 0);
});

test("catalog rejects unusable mapped job feeds while preserving valid options and native adapters", () => {
  for (const options of [undefined, {}, { titlePath: "title" }, { titlePath: "title", discoveryOnly: true },
    { titlePath: "__proto__.title", discoveryOnly: false }, { titlePath: "title", discoveryOnly: false, publishedFormat: "guess" }]) {
    const parsed = SourceCatalogSchema.safeParse({ schemaVersion: 1, entries: [{ ...entry, source: { ...source, options } }] });
    assert.equal(parsed.success, false, `Rejected mapping: ${JSON.stringify(options)}`);
    if (!parsed.success) assert.ok(parsed.error.issues.some((issue) => issue.path.join(".") === "entries.0.source.options"));
  }
  const options = { ...source.options, companyName: "Synthetic configured employer" };
  const parsed = SourceCatalogSchema.parse({ schemaVersion: 1, entries: [{ ...entry, source: { ...source, options } }] });
  assert.deepEqual(parsed.entries[0]!.source.options, options, "mapping validation must not strip source metadata or insert defaults into its configuration");
  assert.equal(SourceCatalogSchema.safeParse({ schemaVersion: 1, entries: [{ ...entry, source: { ...source, adapterId: "greenhouse", options: undefined } }] }).success, true);
});

test("structured job presets require reviewed manifests, stay disabled and do not claim country coverage from a locale", () => {
  const preset = sourceCatalog.find(item => item.source.adapterId === "jobposting-jsonld");
  assert.ok(preset);
  assert.equal(preset.source.enabled, false);
  assert.equal(preset.source.status, "needs-review");
  assert.deepEqual(preset.source.remoteFilters, []);
  assert.match(preset.coverage, /不按语言猜工作国家/);
  assert.match(preset.coverage, /候选URL数量不等于岗位数量/);
  for (const change of [{ entryUrl: "https://other.example.test/sitemap.xml" }, { options: { ...preset.source.options, enumerationUrls: ["https://other.example.test/sitemap.xml"] } },
    { options: { ...preset.source.options, postingPathPrefixes: ["../jobs"] } }, { options: { ...preset.source.options, code: "arbitrary" } }]) {
    assert.equal(SourceCatalogSchema.safeParse({ schemaVersion: 1, entries: [{ ...preset, source: { ...preset.source, ...change } }] }).success, false);
  }
  assert.equal(availableCatalogEntries([preset], [preset.source]).length, 0);
});

test("catalog UI explains that technical text mentions do not establish job requirements", async () => {
  const hooks = registerHooks({ load(url, context, nextLoad) { return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context); } });
  try {
    const { SourceCatalogPanel } = await import("../src/components/atlas/SourceCatalogPanel.tsx");
    const html = renderToStaticMarkup(createElement(SourceCatalogPanel, { installed: [], busy: false, connected: false, entries: [entry], onInstall: () => assert.fail("rendering must not install sources") }));
    assert.match(html, /技术标签表示来源文本中观察到过这些关键词/);
    assert.match(html, /公司介绍中的提及不等于岗位要求匹配/);
    assert.match(html, /Synthetic source/);
    assert.match(html, /C#/);
    assert.match(html, /\.NET/);
  } finally { hooks.deregister(); }
});
test("catalog endpoint identity ignores query order and labels without overwriting any existing source", () => {
  const installed = { ...source, sourceId: "existing-personal-config", name: "Existing name", entryUrl: "https://example.invalid/jobs?a=1&b=2" };
  const before = JSON.stringify(installed);
  assert.equal(sourceCatalogIdentity(source), sourceCatalogIdentity(installed));
  assert.deepEqual(availableCatalogEntries([entry], [installed]), []);
  assert.equal(JSON.stringify(installed), before);
  assert.deepEqual(availableCatalogEntries([entry], [{ ...installed, entryUrl: "https://example.invalid/another", sourceId: source.sourceId }]), []);
});
test("catalog filtering searches source evidence metadata while preserving explicit source identity", () => {
  assert.deepEqual(availableCatalogEntries([entry], [], " .net "), [entry]);
  assert.deepEqual(availableCatalogEntries([entry], [], "C#"), [entry]);
  assert.deepEqual(availableCatalogEntries([entry], [], "bounded"), [entry]);
  assert.deepEqual(availableCatalogEntries([entry], [], "Java"), []);
});
