import type { BossExpandPlan } from "./jd-boss-expand";
import type { CdpObject, NativeCdp } from "./jd-native-cdp";
import { abortNative } from "./jd-native-edge";

type CapturedPlan = { plan: BossExpandPlan; identity: string; frameId: string };
type ExpansionOptions = {
  cdp: NativeCdp;
  sessionId: string;
  signal: AbortSignal;
  expectedIdentity: string;
  capturePlan: () => Promise<CapturedPlan | undefined>;
  current: (identity: string) => Promise<boolean>;
  isCurrent: (identity: string) => boolean;
};

const nodeId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function validPlan(value: CapturedPlan | undefined, expectedIdentity: string): value is CapturedPlan {
  if (!value || value.identity !== expectedIdentity || !value.frameId) return false;
  const plan = value.plan;
  return !!plan && nodeId(plan.controlBackendNodeId) && nodeId(plan.descriptionBackendNodeId)
    && plan.controlBackendNodeId !== plan.descriptionBackendNodeId
    && Array.isArray(plan.hitBackendNodeIds) && plan.hitBackendNodeIds.length > 0 && plan.hitBackendNodeIds.length <= 128
    && plan.hitBackendNodeIds.every(nodeId) && new Set(plan.hitBackendNodeIds).size === plan.hitBackendNodeIds.length
    && plan.hitBackendNodeIds.includes(plan.controlBackendNodeId);
}
function samePlan(before: CapturedPlan, after: CapturedPlan) {
  return before.identity === after.identity && before.frameId === after.frameId
    && before.plan.controlBackendNodeId === after.plan.controlBackendNodeId
    && before.plan.descriptionBackendNodeId === after.plan.descriptionBackendNodeId
    && before.plan.hitBackendNodeIds.length === after.plan.hitBackendNodeIds.length
    && before.plan.hitBackendNodeIds.every(id => after.plan.hitBackendNodeIds.includes(id));
}
function object(value: unknown): CdpObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as CdpObject : undefined;
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }

/** Quads/Input use CSS viewport pixels; Chromium DOM hit-testing uses CSS document pixels. */
function clickPoint(metrics: CdpObject, content: CdpObject): { input: { x: number; y: number }; hit: { x: number; y: number } } | undefined {
  const layout = object(metrics.cssLayoutViewport); const visual = object(metrics.cssVisualViewport);
  if (!layout || !visual || !finite(layout.clientWidth) || !finite(layout.clientHeight)
    || !finite(visual.clientWidth) || !finite(visual.clientHeight)
    || !finite(layout.pageX) || !finite(layout.pageY) || !finite(visual.pageX) || !finite(visual.pageY)
    || layout.pageX < 0 || layout.pageY < 0 || layout.pageX > 10_000_000 || layout.pageY > 10_000_000
    || visual.pageX !== layout.pageX || visual.pageY !== layout.pageY
    || layout.clientWidth < 1 || layout.clientHeight < 1 || layout.clientWidth > 16384 || layout.clientHeight > 16384
    || visual.clientWidth !== layout.clientWidth || visual.clientHeight !== layout.clientHeight
    || visual.offsetX !== 0 || visual.offsetY !== 0 || visual.scale !== 1) return;
  const quads = content.quads;
  if (!Array.isArray(quads) || quads.length !== 1 || !Array.isArray(quads[0])) return;
  const quad: unknown[] = quads[0];
  if (quad.length !== 8 || !quad.every(finite)) return;
  const [left, top, right, top2, right2, bottom, left2, bottom2] = quad as number[];
  if (left !== left2 || right !== right2 || top !== top2 || bottom !== bottom2
    || left < 0 || top < 0 || right > layout.clientWidth || bottom > layout.clientHeight
    || right - left < 2 || bottom - top < 2) return;
  const x = Math.round((left + right) / 2); const y = Math.round((top + bottom) / 2);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x <= left || x >= right || y <= top || y >= bottom) return;
  const documentX = Math.round(x + layout.pageX); const documentY = Math.round(y + layout.pageY);
  if (!Number.isSafeInteger(documentX) || !Number.isSafeInteger(documentY)) return;
  return { input: { x, y }, hit: { x: documentX, y: documentY } };
}

/** One ordinary click on a freshly proved expansion control; capture/inspect never invoke this themselves. */
export async function performBossDescriptionExpansion(options: ExpansionOptions): Promise<boolean> {
  const { cdp, sessionId, signal, expectedIdentity, capturePlan, current, isCurrent } = options;
  abortNative(signal);
  if (!sessionId || !expectedIdentity || !cdp.connected) return false;
  try {
    const before = await capturePlan(); abortNative(signal);
    if (!cdp.connected || !validPlan(before, expectedIdentity)) return false;
    const beforeCurrent = await current(expectedIdentity); abortNative(signal);
    if (!beforeCurrent || !cdp.connected) return false;
    await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: before.plan.controlBackendNodeId }, sessionId); abortNative(signal);
    const after = await capturePlan(); abortNative(signal);
    if (!cdp.connected || !validPlan(after, expectedIdentity) || !samePlan(before, after)) return false;
    const stillCurrent = await current(expectedIdentity); abortNative(signal);
    if (!stillCurrent || !cdp.connected) return false;
    const metrics = await cdp.send("Page.getLayoutMetrics", {}, sessionId); abortNative(signal);
    if (!cdp.connected) return false;
    const content = await cdp.send("DOM.getContentQuads", { backendNodeId: after.plan.controlBackendNodeId }, sessionId); abortNative(signal);
    const point = clickPoint(metrics, content);
    if (!point || !cdp.connected) return false;
    const hit = await cdp.send("DOM.getNodeForLocation", { ...point.hit, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }, sessionId); abortNative(signal);
    if (!cdp.connected || !nodeId(hit.backendNodeId) || hit.frameId !== after.frameId || !after.plan.hitBackendNodeIds.includes(hit.backendNodeId)) return false;
    // The hit must remain the last awaited observation. A full asynchronous
    // identity recheck here would make that hit stale while it sends more CDP
    // queries. Check current owned-document event state synchronously instead.
    const currentNow = isCurrent(expectedIdentity); abortNative(signal);
    if (!currentNow || !cdp.connected) return false;

    // Commit the normal press/release together in this JS turn. No await between them:
    // a cancellation received after commit must not leave a pressed mouse or defer its
    // release into later navigation. CDP input itself is not an atomic browser action;
    // navigation after this last identity check cannot be transactionally prevented.
    const input = (params: CdpObject) => {
      try { return cdp.send("Input.dispatchMouseEvent", params, sessionId); }
      catch (error) { return Promise.reject(error); }
    };
    const press = input({ type: "mousePressed", ...point.input, button: "left", buttons: 1, clickCount: 1 });
    const release = input({ type: "mouseReleased", ...point.input, button: "left", buttons: 0, clickCount: 1 });
    const settled = await Promise.allSettled([press, release]); abortNative(signal);
    return settled.every(result => result.status === "fulfilled");
  } catch {
    abortNative(signal);
    return false;
  }
}
