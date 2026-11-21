import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createInitialDocument, STORAGE_KEY } from "@better-me/storage";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const principal = { id: "f5f63810-c411-4df6-ac10-0addbe4735ae", username: "resume-fixture", displayName: "虚构验收账号" };
const endpoint = "http://127.0.0.1:42819";
const role = "软件工程师";
const resumeText = [
  "姓名：虚构用例", "邮箱：private-inbox@example.invalid", "求职意向：" + role, "所在城市：上海市",
  "专业技能", "C#、Python、Vue、React", "工作经历", "2021.01 - 2024.12 虚构软件公司 | 软件工程师", "维护业务服务。",
].join("\n");

test("the resume toolbar opens the current version and searches an uploaded resume in place on one click", { timeout: 120_000 }, async t => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const cacheDir = await mkdtemp(path.join(tmpdir(), "betterme-resume-jobs-test-"));
  const server = await createServer({
    root, cacheDir, configFile: false, envFile: false, logLevel: "silent", plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": path.join(root, "src") } },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, fs: { allow: [path.resolve(root, "../..")] } },
  });
  t.after(async () => { await server.close(); await rm(cacheDir, { recursive: true, force: true, maxRetries: 3 }); });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1424, height: 1067 }, locale: "zh-CN", serviceWorkers: "block" });

  const doc = createInitialDocument();
  const isolated = structuredClone(doc.factBase);
  isolated.profile.targetRoles = [];
  isolated.profile.traits = [];
  delete isolated.profile.headline;
  isolated.experiences = [];
  const empty = { ...doc.resumeViews[0]!, id: "empty-version", name: "空白测试版本", isolatedFactBase: isolated };
  doc.resumeViews.push(empty);
  const queries: Record<string, unknown>[] = [];
  const collected: unknown[] = [];
  const observedAt = "2026-11-20T08:00:00Z";
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === endpoint) {
      const envelope = (value: unknown) => route.fulfill({ json: { ok: true, requestId: "resume-discovery-test", value } });
      if (url.pathname === "/api/v1/jobs/discover-official") {
        const input = request.postDataJSON();
        queries.push(input);
        const localJob = {
          candidateId: "fixture-posting", url: "https://careers.example.org/backend", title: "后端工程师",
          company: "虚构招聘企业", verification: "official-detail", verificationEvidence: "企业招聘页原文", availability: "open",
          matchedSkills: ["C#"], description: "上海团队开发 C# 服务", location: "上海", travel: "unknown",
        };
        const otherJob = { ...localJob, candidateId: "fixture-other-posting", location: "深圳", title: ".NET 开发工程师",
          url: "https://careers.example.org/another/backend", company: "第二家虚构企业", description: "在深圳维护 C#/.NET 应用。" };
        return envelope({ observedAt, status: "complete", queries: [input.region === "中国" ? ".NET China" : "C# Shanghai"],
          warnings: [], candidates: input.region === "中国" ? [otherJob, { ...localJob, candidateId: "fixture-fresh" }] : [localJob] });
      }
      if (url.pathname === "/api/v1/jobs/discover-official/import") {
        collected.push(request.postDataJSON());
        return envelope({ ok: true, revision: 1, jobIds: ["fixture-job"], snapshotIds: [],
          counts: { newJobs: 1, updatedJobs: 0, unchangedJobs: 0, newListings: 1, newObservations: 1, newSnapshots: 0 } });
      }
      return route.fulfill({ status: 503, json: {} });
    }
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/api/v1/agent/identity/session") return route.fulfill({ json: { principal } });
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/__better-me/")) return route.fulfill({ status: 503, json: {} });
    return route.continue();
  });
  await context.addInitScript(({ doc, owner, documentKey, endpoint }) => {
    const ownerKey = "betterme.owner.v1:" + owner + ":";
    localStorage.setItem(ownerKey + documentKey, JSON.stringify(doc));
    localStorage.setItem("betterme:onboarding:v1", JSON.stringify({ version: 1, state: "completed" }));
    sessionStorage.setItem("better-me:atlas-connection-session:v1", JSON.stringify({ schemaVersion: 1, dataMode: "live", endpoint, token: "fixture-only-search" }));
  }, { doc, owner: principal.id, documentKey: STORAGE_KEY, endpoint });
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
  await page.goto(origin + "/?workspace=resume", { waitUntil: "domcontentloaded" });
  const trigger = page.getByRole("button", { name: "按简历找岗位", exact: true });
  const dialog = page.getByRole("dialog", { name: "按简历找岗位", exact: true });
  const picker = page.getByRole("combobox", { name: "切换简历", exact: true });
  await picker.click();
  await page.getByRole("option", { name: empty.name, exact: true }).click();
  await trigger.click();
  await dialog.getByLabel("主技能", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("目标岗位", { exact: true }).inputValue(), "");
  assert.equal(await dialog.getByLabel("主技能", { exact: true }).inputValue(), "");
  assert.equal(queries.length, 0, "the empty version cannot inherit the original resume's terms");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "更多简历操作", exact: true }).click();
  await page.getByRole("button", { name: "导入简历", exact: true }).click();
  const importer = page.locator("dialog.resume-import-dialog");
  await importer.locator('input[type="file"]').first().setInputFiles({ name: "示例简历.txt", mimeType: "text/plain", buffer: Buffer.from(resumeText) });
  await importer.getByRole("button", { name: "使用离线规则解析", exact: true }).click();
  await importer.getByRole("button", { name: "确认替换简历并选择下一步", exact: true }).click();
  await importer.waitFor({ state: "hidden" });
  assert.equal(queries.length, 0, "uploading on its own must not launch a public search");
  assert.equal(await trigger.count(), 1);
  await trigger.click();
  const card = dialog.getByRole("region", { name: "虚构招聘企业", exact: true });
  await card.waitFor();
  assert.equal(queries.length, 1, "one toolbar click sends one search");
  assert.equal(queries[0]!.role, role);
  assert.deepEqual(queries[0]!.skills, ["C#"]);
  assert.deepEqual(queries[0]!.secondarySkills, ["Python", "Vue", "React"]);
  assert.match(String(queries[0]!.region), /上海/);
  assert.doesNotMatch(JSON.stringify(queries), /虚构用例|private-inbox|虚构软件公司|维护业务服务/);
  assert.equal(new URL(page.url()).searchParams.get("workspace"), "resume");
  assert.equal(await card.getByRole("link", { name: "后端工程师", exact: true }).getAttribute("href"), "https://careers.example.org/backend");
  assert.equal(collected.length, 0);
  await card.getByRole("button", { name: "收录这个岗位" }).click();
  await card.getByRole("button", { name: "已收录", exact: true }).waitFor();
  assert.deepEqual(collected, [{ candidateId: "fixture-posting" }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("button", { name: "扩大到全国找更多公司" }).click();
  const secondCard = dialog.getByRole("region", { name: "第二家虚构企业", exact: true });
  await secondCard.waitFor();
  await secondCard.locator(".ard-company-jobs > summary").click();
  assert.equal(await secondCard.getByRole("link", { name: ".NET 开发工程师", exact: true }).getAttribute("href"), "https://careers.example.org/another/backend");
  assert.deepEqual(queries[1], { ...queries[0], region: "中国" });
  assert.equal(await dialog.locator(".ard-company").count(), 2);
  await dialog.getByRole("button", { name: "只看上海市结果" }).click();
  await card.getByRole("button", { name: "已收录", exact: true }).waitFor();
  assert.equal(await dialog.locator(".ard-company").count(), 1);
  assert.equal(queries.length, 2);
  assert.equal(collected.length, 1);
});
