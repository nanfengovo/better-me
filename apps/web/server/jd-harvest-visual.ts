import type { NativeCdp } from "./jd-native-cdp";
import { localHarvestOcr, proposeHarvestAction, type ComputerContinuation, type OcrLine } from "./jd-harvest-visual-runtime";

export type VisualGate = "login" | "verification" | "platform_limit";
type Control = { label: string; x: number; y: number; width: number; height: number };
export type VisualPage = { url: string; width: number; height: number; scrollX?: number; scrollY?: number; pixelRatio?: number; signature?: number; gate?: VisualGate; blocked?: boolean; controls: Control[] };
export type VisualImage = { base64: string; width: number; height: number };
export type VisualAction = { type: "click"; button: "left"; x: number; y: number } | { type: "scroll"; x: number; y: number; scroll_y: number; scroll_x: number };
export type VisualDriver = { observe(): Promise<VisualPage>; screenshot(page: VisualPage): Promise<VisualImage>; act(action: VisualAction): Promise<void> };
export type VisualResult = { changed: boolean; gate?: VisualGate; reason: string };
type Dependencies = {
  ocr: (image: VisualImage, signal: AbortSignal) => Promise<OcrLine[]>;
  propose: (image: VisualImage, controls: Control[], signal: AbortSignal, continuation?: ComputerContinuation) => Promise<unknown>;
};
// An unread page may be retried or expanded, never skipped via "Next".
const SAFE_LABEL = /^(?:重试|重新加载|刷新|加载更多|展开|展开全部|查看全部|retry|reload|load more|show more)$/i;
export function visualGate(text: string): VisualGate | undefined {
  if (/验证码|安全验证|人机验证|滑块验证|拖动滑块|完成验证|captcha|verify (?:you are|your identity)|security check/i.test(text)) return "verification";
  if (/访问过于频繁|访问受限|异常访问|操作频繁|access denied|too many requests/i.test(text)) return "platform_limit";
  if (/请先登录|登录后.{0,20}(?:查看|继续)|扫码登录|sign in to (?:continue|view)|log in to (?:continue|view)/i.test(text)) return "login";
  return undefined;
}
function sameRoute(actual: string, expected: string) {
  try { const a = new URL(actual), b = new URL(expected); return a.protocol === "https:" && a.origin === b.origin && a.pathname === b.pathname; } catch { return false; }
}
function samePage(a: VisualPage, b: VisualPage) {
  return a.url === b.url && a.width === b.width && a.height === b.height && a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.signature === b.signature && !b.gate && !b.blocked;
}
function controlsWithOcr(page: VisualPage, lines: OcrLine[]): Control[] {
  return page.controls.flatMap(control => {
    if (SAFE_LABEL.test(control.label)) return [control];
    if (control.label) return [];
    const line = lines.find(value => value.confidence >= .85 && SAFE_LABEL.test(value.text.trim())
      && value.x >= control.x && value.y >= control.y
      && value.x + value.width <= control.x + control.width && value.y + value.height <= control.y + control.height);
    return line ? [{ ...control, label: line.text.trim() }] : [];
  });
}
function clickControl(action: VisualAction, controls: Control[]) {
  return controls.find(c => action.x > c.x + 2 && action.x < c.x + c.width - 2 && action.y > c.y + 2 && action.y < c.y + c.height - 2);
}
export function parseVisualAction(value: unknown): VisualAction | undefined {
  if (!value || typeof value !== "object") return;
  const a = value as Record<string, unknown>;
  const coordinate = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
  if (!coordinate(a.x) || !coordinate(a.y)) return;
  if (a.type === "click" && a.button === "left") return { type: "click", button: "left", x: a.x, y: a.y };
  if (a.type === "scroll" && typeof a.scroll_y === "number" && Number.isFinite(a.scroll_y) && a.scroll_x === 0 && Math.abs(a.scroll_y) <= 600 && a.scroll_y !== 0) {
    return { type: "scroll", x: a.x, y: a.y, scroll_y: a.scroll_y, scroll_x: 0 };
  }
}

/** One collection owns one budget across all keywords/providers. No screenshots or model text retained. */
export class HarvestVisualRecovery {
  private calls = 0;
  private deadline = 0;
  private readonly providers = new Map<string, number>();
  private readonly issued = new Set<string>();
  private readonly deps: Dependencies;
  private readonly meter = { requests: 0, inputTokens: 0, outputTokens: 0 };
  get usage() { return { ...this.meter, reservedCalls: this.calls, maxCalls: 4 }; }
  constructor(deps?: Dependencies) {
    this.deps = deps ?? { ocr: localHarvestOcr, propose: (image, controls, signal, context) => proposeHarvestAction(image, controls, signal, context, receipt => {
      this.meter.requests++; this.meter.inputTokens += receipt.inputTokens; this.meter.outputTokens += receipt.outputTokens;
    }) };
  }
  async recover(driver: VisualDriver, expectedUrl: string, provider: string, signal?: AbortSignal): Promise<VisualResult> {
    const stop = (reason: string, gate?: VisualGate): VisualResult => ({ changed: false, reason, ...(gate ? { gate } : {}) });
    if (signal?.aborted) return stop("cancelled");
    if (!this.deadline) this.deadline = Date.now() + 90_000;
    if (Date.now() >= this.deadline || this.calls >= 4 || (this.providers.get(provider) ?? 0) >= 2) return stop("budget");
    this.providers.set(provider, (this.providers.get(provider) ?? 0) + 1);
    const bounded = AbortSignal.any([AbortSignal.timeout(Math.min(25_000, this.deadline - Date.now())), ...(signal ? [signal] : [])]);
    try {
      const page = await driver.observe();
      if (page.gate) return stop("gate", page.gate);
      if (page.blocked || !sameRoute(page.url, expectedUrl)) return stop("unsafe-page");
      bounded.throwIfAborted();
      let image = await driver.screenshot(page);
      const afterCapture = await driver.observe();
      if (afterCapture.gate) return stop("gate", afterCapture.gate);
      if (!samePage(page, afterCapture)) return stop("stale-page");
      const rawLines = await this.deps.ocr(image, bounded);
      const gate = visualGate(rawLines.map(line => line.text).join("\n"));
      if (gate) return stop("gate", gate);
      const lines = rawLines.map(line => ({ ...line, x: line.x * page.width / image.width, y: line.y * page.height / image.height,
        width: line.width * page.width / image.width, height: line.height * page.height / image.height }));
      const controls = controlsWithOcr(page, lines);
      // No generic coordinate clicking. At least one independently safe DOM control is required.
      if (!controls.length) return stop("no-safe-control");
      const beforeCloud = await driver.observe();
      if (beforeCloud.gate) return stop("gate", beforeCloud.gate);
      if (!samePage(page, beforeCloud)) return stop("stale-page");
      bounded.throwIfAborted();
      let context: ComputerContinuation | undefined;
      let proposed: VisualAction | undefined;
      for (let turn = 0; turn < 2; turn++) {
        bounded.throwIfAborted();
        if (this.calls >= 4) return stop("budget");
        // Reserve each billable request, including screenshot handshakes, before awaiting it.
        this.calls++;
        const response = await this.deps.propose(image, controls.map(c => ({ ...c,
          x: c.x * image.width / page.width, y: c.y * image.height / page.height,
          width: c.width * image.width / page.width, height: c.height * image.height / page.height })), bounded, context);
        const handshake = response as { action?: { type?: string }; continuation?: ComputerContinuation } | undefined;
        if (turn === 0 && handshake?.action?.type === "screenshot" && handshake.continuation) {
          const latest = await driver.observe();
          if (latest.gate) return stop("gate", latest.gate);
          if (!samePage(page, latest)) return stop("stale-page");
          image = await driver.screenshot(latest);
          const check = await this.deps.ocr(image, bounded);
          const gate = visualGate(check.map(line => line.text).join("\n"));
          if (gate) return stop("gate", gate);
          const afterOcr = await driver.observe();
          if (afterOcr.gate) return stop("gate", afterOcr.gate);
          if (!samePage(page, afterOcr)) return stop("stale-page");
          context = handshake.continuation;
          continue;
        }
        proposed = parseVisualAction(response);
        break;
      }
      if (!proposed || proposed.x >= image.width || proposed.y >= image.height) return stop("rejected-action");
      const action = { ...proposed, x: proposed.x * page.width / image.width, y: proposed.y * page.height / image.height };
      if (action.type === "scroll") action.scroll_y = Math.max(-600, Math.min(600, action.scroll_y * page.height / image.height));
      const fresh = await driver.observe();
      if (fresh.gate) return stop("gate", fresh.gate);
      if (!samePage(page, fresh)) return stop("stale-page");
      const candidate = action.type === "click" ? clickControl(action, controls) : undefined;
      if (action.type === "click" && (!candidate || !fresh.controls.some(c => c.x === candidate.x && c.y === candidate.y
        && c.width === candidate.width && c.height === candidate.height && (c.label === candidate.label || !c.label)))) return stop("stale-control");
      if (candidate) { action.x = candidate.x + candidate.width / 2; action.y = candidate.y + candidate.height / 2; }
      // OCR-only labels must be re-recognized immediately before dispatch too.
      if (candidate && !page.controls.some(c => c.label === candidate.label && c.x === candidate.x && c.y === candidate.y)) {
        const verifyImage = await driver.screenshot(fresh);
        const verifyLines = await this.deps.ocr(verifyImage, bounded);
        const verifyGate = visualGate(verifyLines.map(line => line.text).join("\n"));
        if (verifyGate) return stop("gate", verifyGate);
        const scaled = verifyLines.map(line => ({ ...line, x: line.x * page.width / verifyImage.width, y: line.y * page.height / verifyImage.height,
          width: line.width * page.width / verifyImage.width, height: line.height * page.height / verifyImage.height }));
        if (!controlsWithOcr(fresh, scaled).some(c => c.label === candidate.label && c.x === candidate.x && c.y === candidate.y)) return stop("stale-control");
        const final = await driver.observe();
        if (final.gate) return stop("gate", final.gate);
        if (!samePage(fresh, final)) return stop("stale-page");
      }
      const fingerprint = JSON.stringify([provider, page.url, action]);
      if (this.issued.has(fingerprint)) return stop("already-issued");
      this.issued.add(fingerprint); // Ambiguous input outcomes are never replayed automatically.
      bounded.throwIfAborted();
      await driver.act(action);
      bounded.throwIfAborted();
      const after = await driver.observe();
      if (after.gate) return stop("gate", after.gate);
      if (after.blocked || !sameRoute(after.url, expectedUrl)) return stop("unsafe-page");
      return { changed: true, reason: "action-issued-needs-structural-verification" };
    } catch { return stop(bounded.aborted ? "timeout-or-cancelled" : "unavailable"); }
  }
}

// Only fixed application code is evaluated. The model never provides JS, selectors or URLs.
const OBSERVE = `(() => {
  const visible = e => { const r=e.getBoundingClientRect(),s=getComputedStyle(e); return r.width>3&&r.height>3&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&s.visibility!=='hidden'&&s.display!=='none'; };
  const text=(document.body?.innerText||'').slice(0,30000);
  const verification=/验证码|安全验证|人机验证|滑块验证|拖动滑块|完成验证|captcha|verify (?:you are|your identity)|security check/i.test(text+' '+location.href);
  const login=[...document.querySelectorAll('input[type=password]')].some(visible)||/请先登录|登录后.{0,20}(?:查看|继续)|扫码登录|sign in to (?:continue|view)|log in to (?:continue|view)/i.test(text)||/\\/(?:login|signin)(?:[/?#]|$)/i.test(location.href);
  const limited=/访问过于频繁|访问受限|异常访问|操作频繁|access denied|too many requests/i.test(text);
  const blocked=[...document.querySelectorAll('iframe')].some(visible)||!!document.querySelector('input[type=file]')||(visualViewport&&visualViewport.scale!==1);
  const controls=[...document.querySelectorAll('button,[role=button],a')].filter(visible).filter(e=>!e.closest('form')&&!e.disabled&&e.getAttribute('aria-disabled')!=='true').flatMap(e=>{
    const r=e.getBoundingClientRect(); if(r.x<0||r.y<0||r.right>innerWidth||r.bottom>innerHeight)return [];
    const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); if(!hit||!(hit===e||e.contains(hit)))return [];
    if(e.tagName==='A'){try{const u=new URL(e.getAttribute('href')||'',location.href);if(u.origin!==location.origin||u.pathname!==location.pathname)return [];}catch{return [];}}
    const label=(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,100);
    return [{label,x:r.x,y:r.y,width:r.width,height:r.height}];
  }).slice(0,120);
  let signature=2166136261; for(let i=0;i<text.length;i++)signature=Math.imul(signature^text.charCodeAt(i),16777619)>>>0;
  return {url:location.href,width:innerWidth,height:innerHeight,scrollX,scrollY,pixelRatio:devicePixelRatio,signature,gate:verification?'verification':limited?'platform_limit':login?'login':undefined,blocked:!!blocked,controls};
})()`;
export function nativeVisualDriver(cdp: NativeCdp, sessionId: string, signal?: AbortSignal): VisualDriver {
  return {
    async observe() {
      signal?.throwIfAborted();
      const response = await cdp.send<{ result?: { value?: VisualPage } }>("Runtime.evaluate", { expression: OBSERVE, returnByValue: true }, sessionId, 2000);
      const value = response.result?.value;
      if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width < 1 || value.height < 1 || !Array.isArray(value.controls)) throw new Error("visual-observation-unavailable");
      return value;
    },
    async screenshot(page) {
      signal?.throwIfAborted();
      const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false,
        clip: { x: page.scrollX ?? 0, y: page.scrollY ?? 0, width: page.width, height: page.height,
          scale: Math.min(1, 1280 / page.width, 900 / page.height) } }, sessionId, 4000);
      if (typeof data !== "string" || data.length > 8_000_000) throw new Error("visual-image-limit");
      const png = Buffer.from(data, "base64");
      if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new Error("visual-image-invalid");
      const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
      if (!width || !height || width * height > 5_000_000) throw new Error("visual-image-limit");
      return { base64: data, width, height };
    },
    async act(action) {
      signal?.throwIfAborted();
      if (action.type === "scroll") { await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: action.x, y: action.y, deltaX: 0, deltaY: action.scroll_y }, sessionId, 2000); return; }
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: action.x, y: action.y, button: "left", clickCount: 1, buttons: 1 }, sessionId, 2000);
      // Always release a pressed button, even if cancellation arrives between the two inputs.
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: action.x, y: action.y, button: "left", clickCount: 1, buttons: 0 }, sessionId, 2000);
    },
  };
}
