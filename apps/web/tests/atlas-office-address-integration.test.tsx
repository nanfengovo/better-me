import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";
import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLTextAreaElement } from "happy-dom";
import type { AtlasDataset, OfficeAddressProposal, SourceDefinition } from "@better-me/opportunities";
import type { SourceJobRecord } from "@better-me/source-adapters";
import { createJobApplication } from "../../job-service/src/application.ts";
import { createJobHttpServer } from "../../job-service/src/http.ts";
import { openJobRepository } from "../../job-service/src/repository.ts";
import { projectSourcePage } from "../../job-service/src/projection.ts";
import type { AtlasOfficeAddressConfirmationProps } from "../src/components/atlas/AtlasOfficeAddressConfirmation.tsx";

const dom = new Window({ url: "http://synthetic-office-integration.invalid" });
const React = await import("react");
const { act, createElement: h } = React;
const globals = { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const hooks = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { source: "export {};", format: "module", shortCircuit: true } : nextLoad(url, context);
} });
const { createRoot } = await import("react-dom/client");
const { AtlasOfficeAddressConfirmation } = await import("../src/components/atlas/AtlasOfficeAddressConfirmation.tsx");

const AT = "2026-10-19T12:00:00.000Z", TOKEN = "synthetic-office-integration-token-123456789";
const source: SourceDefinition = { sourceId: "synthetic-office-integration", name: "Synthetic office source", adapterId: "synthetic", adapterVersion: "1",
  capabilities: ["list-jobs"], runtime: ["local-service"], entityType: "job-posting", enabled: true, status: "active", remoteFilters: [],
  endpointPolicy: { allowedHosts: ["careers.example.invalid"], allowedPathPrefixes: ["/"], requireHttps: true, allowRedirects: false, maxRedirects: 0 },
  attribution: { label: "Synthetic source", usage: "metadata", requiresAttribution: true },
  refreshPolicy: { mode: "manual", minIntervalSeconds: 0, maxRecords: 10, maxPages: 1, requestsPerMinute: 30 } };
const proposal: OfficeAddressProposal = { basis: "manual-user-confirmation", countryCode: "CN", formattedAddress: "Synthetic Integration Road 10, Shanghai",
  streetAddress: "Synthetic Integration Road 10", postalCode: "200000", coordinates: { latitude: 31.123456, longitude: 121.654321, coordinateSystem: "WGS84" },
  coordinateMeaning: "building", evidenceUrl: "https://careers.example.invalid/jobs/synthetic-42" };
const record: SourceJobRecord = { entityType: "job-posting", sourceRecordId: "synthetic-42", url: proposal.evidenceUrl, title: "Synthetic integration engineer",
  companyName: "Synthetic integration employer", description: "Synthetic full job description; no actual employer or office is represented.",
  locations: [{ raw: "Shanghai, China", countryCode: "CN", city: "Shanghai", postalCode: "200001" }], compensations: [], workMode: "on-site", employmentType: "unknown",
  remoteEligibleRegions: [], availability: "unknown", completeness: "detail", evidence: [], warnings: [] };

function button(label: string) {
  const entry = [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
  assert.ok(entry, `Missing button ${label}`); return entry;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function change(label: string, value: string) {
  const entry = dom.document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`); assert.ok(entry);
  await act(async () => {
    const prototype = entry.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(entry, value);
    entry.dispatchEvent(new dom.Event("input", { bubbles: true }));
  });
}
async function check(selector: string) {
  const entry = dom.document.querySelector<HTMLInputElement>(`${selector} input[type=checkbox]`); assert.ok(entry);
  await act(async () => entry.click());
}
async function settled(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    if (predicate()) return;
  }
  assert.fail(`Synthetic HTTP/React action did not settle: ${dom.document.body.textContent}`);
}

after(() => {
  hooks.deregister(); void dom.happyDOM.abort();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test("React explicitly queries, previews, confirms and revokes an office through authenticated HTTP and in-memory SQLite", async () => {
  const repository = openJobRepository(":memory:", { now: () => AT });
  const projection = await projectSourcePage(await repository.readProjectionSnapshot(), source,
    { records: [record], observedAt: AT, coverage: { complete: true, partial: false, fetchedRecords: 1, appliedFilters: [], ignoredFilters: [] }, warnings: [] }, "synthetic-seed");
  await repository.importSnapshot(projection.delta, { actorScope: "synthetic-seeder", idempotencyKey: "synthetic-seed", expectedRevision: 0 });
  let providerReads = 0;
  const providerInputs: Array<Record<string, unknown>> = [];
  const application = createJobApplication({ repository, now: () => AT, officeAddressProvider: { providerId: "synthetic-provider", async search(input, context) {
    providerInputs.push({ ...input });
    providerReads++; context.consumeRequests(); assert.equal(input.query, proposal.formattedAddress);
    assert.equal(input.location.raw, record.locations[0]!.raw);
    return [{ id: "synthetic-candidate", providerId: "synthetic-provider", proposal, evidenceUrl: proposal.evidenceUrl,
      attribution: "Synthetic provider only; no external geocoding", estimated: true, verification: "unverified" }];
  } } });
  const server = createJobHttpServer({ registry: application.registry, token: TOKEN, allowedOrigins: [dom.location.origin], port: 0 });
  const { url } = await server.listen();
  dom.document.body.innerHTML = "<main></main>";
  const root = createRoot(dom.document.querySelector("main")! as unknown as Element);
  const snapshots: AtlasDataset[] = [];
  try {
    const before = await repository.readSnapshot(), sourceLocation = before.locations[0]!, job = before.jobs[0]!;
    const props: AtlasOfficeAddressConfirmationProps = { endpoint: url, token: TOKEN, jobId: job.id, location: sourceLocation,
      revision: before.revision, onClose() {}, onSnapshot: data => { snapshots.push(data); } };
    await act(async () => root.render(h(AtlasOfficeAddressConfirmation, props)));
    assert.equal(providerReads, 0); assert.deepEqual(await repository.readSnapshot(), before);

    const candidateInput = { jobId: job.id, locationId: sourceLocation.id, expectedRevision: before.revision, query: proposal.formattedAddress };
    const path = `${url}/api/v1/locations/office-address/candidates`;
    assert.equal((await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(candidateInput) })).status, 401);
    assert.equal((await fetch(path, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Origin: "https://untrusted.example.invalid" }, body: JSON.stringify(candidateInput) })).status, 403);
    assert.equal((await fetch(path, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...candidateInput, actorScope: "forged-admin", provider: "forged-provider" }) })).status, 400);
    assert.equal(providerReads, 0); assert.deepEqual(await repository.readSnapshot(), before);

    await change("办公地址限定城市", "  Shanghai  "); await change("办公地址限定邮编", "  00007  ");
    assert.equal(providerReads, 0);
    await click("读取地址来源与查询配置"); await settled(() => !!dom.document.querySelector(".atlas-office-candidates"));
    assert.equal(providerReads, 0);
    await change("办公地址查询", proposal.formattedAddress); await click("查询地址候选");
    await settled(() => dom.document.body.textContent!.includes("Synthetic provider only"));
    assert.equal(providerReads, 1); assert.equal(providerInputs[0]!.locality, "Shanghai"); assert.equal(providerInputs[0]!.postalCode, "00007");
    assert.equal(dom.document.querySelector<HTMLInputElement>('[aria-label="办公地址邮编"]')!.value, "200001");
    await change("办公地址限定城市", " ");
    assert.equal(dom.document.querySelector(".atlas-office-candidates"), null); assert.equal(providerReads, 1);
    await change("办公地址限定邮编", " "); await click("查询地址候选");
    await settled(() => dom.document.body.textContent!.includes("Synthetic provider only"));
    assert.equal(providerReads, 2); assert.equal(Object.hasOwn(providerInputs[1]!, "locality"), false); assert.equal(Object.hasOwn(providerInputs[1]!, "postalCode"), false);
    assert.equal((providerInputs[1]!.location as typeof sourceLocation).postalCode, "200001");
    await click("填入表单，继续人工核对");
    await change("办公地址核对说明", "Synthetic user explicitly checked this job, address and WGS84 building point.");
    await click("预览办公地址变更"); await settled(() => !!dom.document.querySelector(".atlas-office-preview"));
    assert.equal(button("确认保存办公地址").disabled, true); assert.deepEqual(await repository.readSnapshot(), before);
    await check(".atlas-office-preview"); await click("确认保存办公地址"); await settled(() => snapshots.length === 1);

    const confirmed = snapshots[0]!, point = confirmed.locations.find(value => value.id === sourceLocation.id)!;
    assert.equal(confirmed.revision, before.revision + 1); assert.deepEqual(point.coordinates, proposal.coordinates);
    assert.equal(point.precision, "address"); assert.equal(point.verification, "unverified"); assert.ok(point.officeResolution);
    assert.equal(point.raw, sourceLocation.raw); assert.deepEqual(point.evidence, sourceLocation.evidence);
    assert.deepEqual((await repository.readProjectionSnapshot()).locations, before.locations);
    assert.equal((await repository.backup()).officeDecisions.length, 1); assert.equal(providerReads, 2);

    await act(async () => root.render(h(AtlasOfficeAddressConfirmation, { ...props, revision: confirmed.revision, location: point })));
    await change("办公地址核对说明", "Synthetic explicit revocation restores the disclosed source location.");
    await check(".atlas-office-revoke"); await click("撤销当前办公地址确认"); await settled(() => snapshots.length === 2);
    const revoked = snapshots[1]!;
    assert.equal(revoked.revision, confirmed.revision + 1);
    assert.deepEqual(revoked.locations.find(value => value.id === sourceLocation.id), sourceLocation);
    assert.equal((await repository.backup()).officeDecisions.length, 2); assert.equal(providerReads, 2);
    assert.match(dom.document.querySelector(".atlas-office-saved")!.textContent!, /已恢复/);
  } finally {
    await act(async () => root.unmount()); await server.close(); await application.shutdown(); repository.close();
  }
});
