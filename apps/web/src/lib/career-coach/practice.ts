import { PracticeReceiptSchema, type PracticeReceipt } from "./types";

/** Original BetterMe exercise. No copied company code or external question bank. */
export const TRANSITION_EXERCISE = {
  id: "state-transitions", version: "1", title: "状态迁移与重复操作",
  skill: "状态建模、幂等和失败边界", language: "JavaScript 函数体（不是 C# 运行器）",
  instructions: "实现 transition(current, next)。合法状态为 todo、doing、done；允许 todo→doing、doing→done 和原地重复。成功返回 {ok:true,state:next}；逆行/跨级返回 {ok:false,state:current,error:'illegal_transition'}；未知状态返回 {ok:false,state:current,error:'invalid_state'}。不修改输入。",
  starter: "// 参数 current、next 已提供。请自己实现函数体。\nreturn { ok: true, state: next };",
  resources: [{ title: "MDN：JavaScript 条件与错误处理", url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Control_flow_and_error_handling" }],
} as const;
export const PRACTICE_CASES = [
  ...["todo", "doing", "done"].flatMap(current => ["todo", "doing", "done"].map(next => ({ current, next }))),
  { current: "unknown", next: "doing" }, { current: "todo", next: "unknown" },
];
function expectedResult(current: string, next: string) {
  const states = ["todo", "doing", "done"];
  if (!states.includes(current) || !states.includes(next)) return { ok: false, state: current, error: "invalid_state" };
  return current === next || (current === "todo" && next === "doing") || (current === "doing" && next === "done")
    ? { ok: true, state: next } : { ok: false, state: current, error: "illegal_transition" };
}
/** Grades outside the untrusted realm. The worker never receives expected answers or authority to set pass counts. */
export function gradePractice(outputs: unknown): PracticeReceipt["checks"] {
  if (!Array.isArray(outputs) || outputs.length !== PRACTICE_CASES.length || outputs.some(output => typeof output !== "string" || output.length > 400)) throw new Error("运行回执不完整或超出限制，未生成成绩。");
  return PRACTICE_CASES.map(({ current, next }, index) => {
    const expected = expectedResult(current, next), actual: string = outputs[index];
    let passed = false;
    try {
      const value: unknown = JSON.parse(actual);
      passed = value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === Object.keys(expected).length
        && Object.entries(expected).every(([key, expectedValue]) => (value as Record<string, unknown>)[key] === expectedValue);
    } catch { /* A thrown exception/invalid return is a test failure, not a fabricated score. */ }
    return { name: `${current} → ${next}`, passed, expected: JSON.stringify(expected), actual };
  });
}
export function practiceEvidence(receipt: PracticeReceipt): string {
  const passed = receipt.checks.filter(item => item.passed).length;
  return [`BetterMe 原创隔离练习：${TRANSITION_EXERCISE.title} v${receipt.version}`, `运行ID：${receipt.id}；代码SHA-256：${receipt.sourceHash}`,
    `本浏览器实际运行 ${receipt.checks.length} 项：${passed} 通过，${receipt.checks.length - passed} 失败，0 跳过。仅覆盖此练习，不是生产能力认证。`,
    ...receipt.checks.map(item => `${item.passed ? "通过" : "失败"} ${item.name}；期望 ${item.expected}；实际 ${item.actual}`),
    `提交代码（JavaScript函数体${receipt.source.length > 5000 ? "，仅摘录前5000字；完整代码保留在结构化回执" : ""}）：\n${receipt.source.slice(0, 5000)}`].join("\n");
}
export function practiceBundle(source: string) {
  return JSON.stringify({ format: "betterme-practice-v1", exerciseId: TRANSITION_EXERCISE.id, version: TRANSITION_EXERCISE.version, source }, null, 2);
}
export function readPracticeBundle(raw: string): string {
  if (raw.length > 128000) throw new Error("练习文件过大；只支持本练习的 JSON 文件。");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("练习文件格式不正确。");
  const item = value as Record<string, unknown>;
  if (item.format !== "betterme-practice-v1" || item.exerciseId !== TRANSITION_EXERCISE.id || item.version !== TRANSITION_EXERCISE.version
    || typeof item.source !== "string" || item.source.length > 20000) throw new Error("练习标识或版本不匹配；不会执行其他文件。");
  return item.source;
}

const workerScript = `"use strict";
const send = self.postMessage.bind(self), stringify = JSON.stringify.bind(JSON), Compile = Function;
self.onmessage = event => {
  self.onmessage = null;
  for (const name of ['fetch','importScripts','Worker','SharedWorker','WebSocket','WebTransport','XMLHttpRequest','BroadcastChannel','indexedDB','caches','postMessage','close']) {
    try { Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false }); } catch {}
  }
  try {
    const fn = new Compile('current', 'next', '"use strict";\\n' + event.data.source);
    const outputs = [];
    for (let i=0; i<event.data.cases.length; i++) {
      const input = event.data.cases[i];
      try { const value = stringify(fn(input.current, input.next)); outputs[i] = typeof value === 'string' ? value.slice(0,400) : 'undefined'; }
      catch (error) { outputs[i] = ('执行异常：' + String(error?.message || error)).slice(0,400); }
    }
    send({outputs});
  } catch (error) { send({error: ('代码未能执行：' + String(error?.message || error)).slice(0,300)}); }
};`;

/** Opaque-origin iframe + blob worker; no same-origin flag, host filesystem, credentials, network or fallback eval. */
export function runPractice(source: string, signal?: AbortSignal): Promise<PracticeReceipt> {
  if (!source.trim() || source.length > 20000) return Promise.reject(new Error("请填写 1–20000 字的练习代码。"));
  if (signal?.aborted) return Promise.reject(new DOMException("练习已停止。", "AbortError"));
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe"), token = crypto.randomUUID();
    frame.hidden = true; frame.title = "隔离练习运行器"; frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; connect-src 'none';"><script>
      let worker, timer, started = false;
      const token = ${JSON.stringify(token)};
      function finish(result) { clearTimeout(timer); if(worker) worker.terminate(); parent.postMessage({token,...result}, '*'); }
      addEventListener('message', event => {
        if(event.source !== parent || event.data?.token !== token) return;
        if(event.data.stop) { clearTimeout(timer); if(worker) worker.terminate(); return; }
        if(started) return; started = true;
        try {
          const url = URL.createObjectURL(new Blob([${JSON.stringify(workerScript)}],{type:'text/javascript'}));
          worker = new Worker(url); URL.revokeObjectURL(url);
          timer = setTimeout(()=>finish({error:'练习运行超时（2秒），已停止；未生成成绩。'}),2000);
          worker.onmessage = event => finish(event.data);
          worker.onerror = () => finish({error:'隔离运行器未能执行，未生成成绩。'});
          worker.postMessage({source:event.data.source,cases:event.data.cases});
        } catch { finish({error:'浏览器不支持隔离运行器；不会回退到主页面或终端执行。'}); }
      });
      parent.postMessage({token,ready:true}, '*');
    </script>`;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); window.removeEventListener("message", receive);
      frame.contentWindow?.postMessage({ token, stop: true }, "*"); frame.remove();
    };
    const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const abort = () => fail(new DOMException("练习已停止，代码草稿保留。", "AbortError"));
    const timer = setTimeout(() => fail(new Error("隔离运行器未响应，已停止；未生成成绩。")), 5000);
    const receive = (event: MessageEvent) => {
      if (settled || event.source !== frame.contentWindow || event.origin !== "null" || event.data?.token !== token) return;
      if (event.data.ready) { frame.contentWindow?.postMessage({ token, source, cases: PRACTICE_CASES }, "*"); return; }
      if (event.data.error) { fail(new Error(String(event.data.error).slice(0, 400))); return; }
      try {
        const checks = gradePractice(event.data.outputs);
        settled = true; cleanup();
        void crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)).then(hash => {
          if (signal?.aborted) { reject(new DOMException("练习已停止。", "AbortError")); return; }
          resolve(PracticeReceiptSchema.parse({ id: token, exerciseId: TRANSITION_EXERCISE.id, version: TRANSITION_EXERCISE.version,
            source, sourceHash: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
            at: new Date().toISOString(), runner: "opaque-browser-worker", checks }));
        }, reject);
      } catch (error) { fail(error instanceof Error ? error : new Error("无效运行回执。")); }
    };
    window.addEventListener("message", receive); signal?.addEventListener("abort", abort, { once: true });
    document.body.append(frame);
  });
}
