import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createInitialDocument, STORAGE_KEY } from "@better-me/storage";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium, type Page } from "playwright-core";
import { createServer } from "vite";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(webRoot, "../..");
const principal = { id: "11111111-1111-4111-8111-111111111111", username: "archive-test", displayName: "合成恢复账号" };
const archiveId = "a".repeat(32);
const archiveKey = "synthetic";
const space = `${archiveId}.${archiveKey}`;
const ownerPrefix = `betterme.owner.v1:${principal.id}:`;
const archivePrefix = `${ownerPrefix}betterme.document-space.v1:${space}:`;
const mainKey = `${ownerPrefix}${STORAGE_KEY}`;
const archivedOfficialKey = `${archivePrefix}${STORAGE_KEY}`;
const archiveDatabase = `${archivePrefix}better-me:document-draft:v1`;
const savedOriginal = '{\r\n"damaged official": "档案原件"';
const draftOriginal = '{\r\n"damaged draft": "档案草稿"';

async function downloadedBytes(page: Page, button: string) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: button, exact: true }).click(),
  ]);
  return readFile(await download.path(), "utf8");
}

test("recovery archive downloads its own damaged records and restores a backup without changing the main workspace", { timeout: 120_000 }, async t => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "betterme-archive-browser-"));
  const server = await createServer({
    root: webRoot, configFile: false, envFile: false, cacheDir, logLevel: "silent",
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": path.join(webRoot, "src") } },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null, fs: { allow: [repositoryRoot] } },
  });
  t.after(async () => {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true, maxRetries: 3 });
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"],
  });
  t.after(() => browser.close());
  const sourceDocument = createInitialDocument();
  const restoredDocument = createInitialDocument();
  const mainDocument = JSON.stringify(createInitialDocument());

  for (const [name, mainBytes] of [["with a main workspace", mainDocument], ["without a main workspace", null]] as const) {
    await t.test(name, async () => {
      const context = await browser.newContext({ acceptDownloads: true, locale: "zh-CN", serviceWorkers: "block" });
      try {
        await context.route("**/*", async route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) return route.abort("blockedbyclient");
          if (url.pathname === "/archive-fixture-setup") return route.fulfill({ contentType: "text/html", body: "<title>Recovery archive test</title>" });
          if (url.pathname === "/api/v1/agent/identity/session") return route.fulfill({ json: { principal } });
          if (url.pathname === `/api/v1/agent/recovery/${archiveId}/documents/${archiveKey}`) {
            return route.fulfill({ json: { ownerId: principal.id, document: sourceDocument } });
          }
          if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 503, json: { error: "synthetic fixture" } });
          return route.continue();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(25_000);
        await page.goto(`${origin}/archive-fixture-setup`);
        await page.evaluate(async ({ mainKey, archivedOfficialKey, archiveDatabase, mainBytes, savedOriginal, draftOriginal }) => {
          if (mainBytes !== null) localStorage.setItem(mainKey, mainBytes);
          localStorage.setItem(archivedOfficialKey, savedOriginal);
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(archiveDatabase, 1);
            request.onupgradeneeded = () => request.result.createObjectStore("drafts");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            await new Promise<void>((resolve, reject) => {
              const transaction = database.transaction("drafts", "readwrite");
              transaction.objectStore("drafts").put(draftOriginal, "active");
              transaction.oncomplete = () => resolve();
              transaction.onerror = () => reject(transaction.error);
            });
          } finally { database.close(); }
        }, { mainKey, archivedOfficialKey, archiveDatabase, mainBytes, savedOriginal, draftOriginal });

        await page.goto(`${origin}/?recovery=${space}`, { waitUntil: "domcontentloaded" });
        assert.equal(await downloadedBytes(page, "下载原始数据"), savedOriginal);
        assert.equal(await downloadedBytes(page, "下载原始草稿"), draftOriginal);
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "恢复 JSON 备份", exact: true }).click();
        await (await chooser).setFiles({
          name: "synthetic-restored.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(restoredDocument)),
        });
        await page.getByRole("combobox", { name: "切换简历" }).waitFor();
        const records = await page.evaluate(({ mainKey, archivedOfficialKey }) => ({
          main: localStorage.getItem(mainKey),
          archive: localStorage.getItem(archivedOfficialKey),
        }), { mainKey, archivedOfficialKey });
        assert.equal(records.main, mainBytes);
        assert.equal(JSON.parse(records.archive ?? "null")?.documentId, restoredDocument.documentId);
      } finally { await context.close(); }
    });
  }
});
