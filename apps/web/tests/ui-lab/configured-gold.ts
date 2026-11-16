// Standalone opt-in operator page: importing App would also open personal stores.
// The credential stays in this closure and is never rendered or saved elsewhere.
const configuration = document.getElementById("configuration")!;
const status = document.getElementById("status")!;
const stored = localStorage.getItem("better-me:llm-config");
let settings: { provider?: string; baseUrl?: string; model?: string; apiKey?: string } | undefined;
try { settings = stored ? JSON.parse(stored) : undefined; } catch { /* Safe missing state. */ }
const selected = settings && typeof settings.model === "string" && typeof settings.baseUrl === "string" ? settings : undefined;
let origin = "未配置";
try { origin = new URL(selected!.baseUrl!).origin; } catch { /* No arbitrary config text in the DOM. */ }
for (const [name, value] of [["提供商", selected?.provider ?? "未配置"], ["模型", selected?.model ?? "未配置"], ["接收方", origin],
  ["已保存凭据", typeof selected?.apiKey === "string" && selected.apiKey.trim() ? "存在（不展示）" : "不存在"]]) {
  const term = document.createElement("dt"), definition = document.createElement("dd");
  term.textContent = name; definition.textContent = value; configuration.append(term, definition);
}
status.textContent = selected ? "尚未发起模型请求。" : "当前应用来源未保存模型配置；没有读取其他资料或猜测供应商。";
const run = document.getElementById("run") as HTMLButtonElement;
const results = document.getElementById("results")!;
const bridge = "http://127.0.0.1:5340";
let submitted = false;
async function observe() {
  try {
    const response = await fetch(`${bridge}/state`, { credentials: "omit", redirect: "error", cache: "no-store" });
    if (!response.ok) throw Error("bridge_unavailable");
    const state = await response.json();
    const same = selected?.model === state.selection.model && origin === state.selection.providerOrigin;
    status.textContent = state.stage === "completed" ? "五例已结束；所有成功、失败与未决均保留。" : state.claimed ? "本批已提交，仅观察原任务，不会重发。" : same ? "已固定接收方与模型，等待明确启动。" : "当前配置与操作者固定选择不同，不能启动。";
    run.disabled = submitted || state.claimed || !same || !selected?.apiKey?.trim();
    results.textContent = JSON.stringify({ stage: state.stage, selection: state.selection, events: state.events, summary: state.summary }, null, 2);
    return state.stage === "completed" || state.stage === "stopped";
  } catch { run.disabled = true; status.textContent = "专用评测桥未运行；没有派送模型请求。"; return false; }
}
run.addEventListener("click", async () => {
  if (submitted || run.disabled || !selected) return;
  submitted = true; run.disabled = true;
  try {
    await fetch(`${bridge}/run`, { method: "POST", credentials: "omit", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consent: true, modelSettings: selected }) });
  } catch { status.textContent = "提交回执未知；只读核对原批次，不再次派送。"; }
  await observe();
});
await observe();
const timer = setInterval(() => { void observe().then(done => { if (done) clearInterval(timer); }); }, 1500);
export {};
