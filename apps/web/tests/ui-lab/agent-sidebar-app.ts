import { createInitialDocument, STORAGE_KEY } from "@better-me/storage";
// Deliberately cannot seed the normal 5173 origin. Start the no-proxy layout
// config with --port 5231. Existing data on this test origin is never replaced.
if (location.hostname !== "127.0.0.1" || location.port !== "5231") throw new Error("正式布局隔离验收仅允许独立 5231 测试源。");
const fetchAsset = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname.endsWith("/runtimes")) return Response.json({ runtimes: [] });
  if (url.origin !== location.origin || url.pathname.includes("/api/") || url.pathname.includes("__")) return Response.json({ error: "隔离布局：未连接真实服务" }, { status: 503 });
  return fetchAsset(input, init);
};
if (!localStorage.getItem(STORAGE_KEY)) {
  const doc = createInitialDocument();
  doc.documentId = "isolated-sidebar-formal-app";
  doc.factBase.profile.displayName = { zh: "隔离布局测试用户" };
  doc.factBase.profile.email = "sidebar@example.invalid"; doc.factBase.profile.phone = "";
  doc.resumeViews[0]!.name = "隔离简历 · 不是真实资料";
  localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  localStorage.setItem("better-me:auto-save:v1", JSON.stringify({ enabled: false, trigger: "idle", delayMs: 5000, historyIntervalMs: 60000 }));
  localStorage.setItem("betterme:onboarding:v1", JSON.stringify({ version: 1, state: "skipped" }));
}
await import("../../src/main");
