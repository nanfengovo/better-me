import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";
import { prepareSkillConstellation } from "../src/lib/skill-constellation/model";
import type { SkillConstellationSceneHandle, SkillConstellationSceneStatus } from "../src/lib/skill-constellation/types";

const win = new Window({ url: "https://skill-constellation-scene-fixture.invalid" }), originals = new Map<string, PropertyDescriptor | undefined>();
let network = 0;
for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement,
  HTMLCanvasElement: win.HTMLCanvasElement, HTMLImageElement: win.HTMLImageElement, Image: win.Image,
  fetch: async () => { network++; throw new Error("No external source in the shared-scene fixture"); } })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const C = await import("cesium"), { createSkillConstellationScene } = await import("../src/lib/skill-constellation/cesium-scene");
const binding = { ownerId: "synthetic-owner", sessionGeneration: 1, contextId: "synthetic-context", revision: "1" };
const model = prepareSkillConstellation({ binding, badge: { id: "badge-a", label: "合成徽章", verificationReceiptId: "receipt-a", sourceHash: "a".repeat(64), skillIds: ["sqlite"] },
  links: [{ id: "badge-a:job-a", badgeId: "badge-a", jobId: "job-a", sourceHash: "b".repeat(64), skillIds: ["sqlite"], longitude: -122.1234567, latitude: 37.7654321,
    strength: .5, meaning: "explicit_skill_evidence_overlap_not_hiring_probability" }] });
const handles: SkillConstellationSceneHandle[] = [];
function fixture() {
  const host = win.document.createElement("div"), canvas = win.document.createElement("canvas"); host.append(canvas); win.document.body.append(host);
  canvas.getBoundingClientRect = () => new win.DOMRect(0, 0, 800, 500);
  const dataSources = new C.DataSourceCollection(), postRender = new C.Event(), renderError = new C.Event();
  let renderRequests = 0, destroys = 0, cameraCommands = 0;
  const viewer = { scene: { canvas, postRender, renderError, requestRender() { renderRequests++; }, drillPick() { return []; } }, container: host, dataSources,
    camera: { positionCartographic: { height: 1_000_000 }, setView() { cameraCommands++; }, lookAt() { cameraCommands++; }, lookAtTransform() {}, zoomIn() { cameraCommands++; }, zoomOut() { cameraCommands++; } },
    isDestroyed: () => false, destroy() { destroys++; } };
  return { host, canvas, viewer: viewer as unknown as InstanceType<typeof C.Viewer>, dataSources, postRender, renderError,
    counts: () => ({ renderRequests, destroys, cameraCommands }) };
}
afterEach(() => { for (const handle of handles.splice(0)) handle.dispose(); win.document.body.replaceChildren(); assert.equal(network, 0); });
after(async () => { await win.happyDOM.abort(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });

test("real Cesium overlay uses exact source endpoints and waits for postRender on a synthetic shared scene (not a GPU test)", async () => {
  const scene = fixture(), statuses: SkillConstellationSceneStatus[] = [], abort = new AbortController();
  const foreign = new C.CustomDataSource("unrelated-owner-layer"); await scene.dataSources.add(foreign);
  const handle = await createSkillConstellationScene(scene.host as unknown as HTMLElement, model, { status: value => statuses.push(value), pick() {}, inspectBadge() {} },
    { signal: abort.signal, isCurrent: () => true, sharedViewer: scene.viewer }); handles.push(handle);
  assert.deepEqual(statuses.map(value => value.phase), ["loading"]); assert.equal(scene.dataSources.length, 2); assert.equal(scene.counts().cameraCommands, 0);
  const overlay = scene.dataSources.get(1), office = overlay.entities.values.find(entity => entity.id.includes("-office-"))!, arc = overlay.entities.values.find(entity => entity.id.includes("-arc-"))!;
  const expected = C.Cartesian3.fromDegrees(-122.1234567, 37.7654321), at = C.JulianDate.now();
  assert.equal(C.Cartesian3.distance(office.position!.getValue(at)!, expected), 0);
  const positions = arc.polyline!.positions!.getValue(at) as InstanceType<typeof C.Cartesian3>[]; assert.equal(C.Cartesian3.distance(positions.at(-1)!, expected), 0);
  assert.equal(arc.polyline!.arcType!.getValue(at), C.ArcType.NONE);
  scene.postRender.raiseEvent(); assert.equal(statuses.at(-1)!.phase, "ready"); assert.equal(statuses.at(-1)!.renderedFrame, true);
  handle.focus("not-authorized"); assert.equal(scene.counts().cameraCommands, 0); handle.focus("job-a"); handle.navigate("in"); handle.navigate("reset"); assert.equal(scene.counts().cameraCommands, 3);
  handle.update({ ...model, entries: [], status: "empty" }); assert.equal(overlay.entities.values.length, 1, "only the non-geographic badge symbol remains when filtering to empty");
  handle.dispose(); assert.equal(scene.dataSources.length, 1); assert.equal(scene.dataSources.get(0), foreign); assert.equal(scene.counts().destroys, 0);
  assert.equal(scene.postRender.numberOfListeners, 0); assert.equal(scene.renderError.numberOfListeners, 0);
});

test("context loss and invalidated authority never become a new rendered success and shared Viewer configuration is preserved", async () => {
  const scene = fixture(), statuses: SkillConstellationSceneStatus[] = []; let current = true;
  const handle = await createSkillConstellationScene(scene.host as unknown as HTMLElement, model, { status: value => statuses.push(value), pick() {}, inspectBadge() {} },
    { signal: new AbortController().signal, isCurrent: () => current, sharedViewer: scene.viewer }); handles.push(handle);
  const event = new win.Event("webglcontextlost", { cancelable: true }); scene.canvas.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true); assert.equal(statuses.at(-1)!.phase, "error"); assert.equal(statuses.at(-1)!.failure!.kind, "gpu");
  scene.postRender.raiseEvent(); assert.equal(statuses.some(value => value.phase === "ready"), false);
  current = false; handle.focus("job-a"); handle.navigate("reset"); assert.equal(scene.counts().cameraCommands, 0);
  handle.dispose(); assert.equal(scene.counts().destroys, 0);
});

test("an overlay attached after cancellation is removed without destroying the shared Viewer", async () => {
  const scene = fixture(), abort = new AbortController(); let attach: (() => Promise<void>) | undefined;
  const originalAdd = scene.dataSources.add.bind(scene.dataSources);
  scene.dataSources.add = dataSource => new Promise(resolve => { attach = async () => { resolve(await originalAdd(dataSource)); }; });
  const operation = createSkillConstellationScene(scene.host as unknown as HTMLElement, model, { status() {}, pick() {}, inspectBadge() {} },
    { signal: abort.signal, isCurrent: () => true, sharedViewer: scene.viewer });
  abort.abort(); assert.ok(attach); await attach(); await assert.rejects(operation, /取消|授权版本/);
  assert.equal(scene.dataSources.length, 0); assert.equal(scene.counts().destroys, 0);
});
