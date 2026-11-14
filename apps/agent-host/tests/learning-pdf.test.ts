import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { AgentTaskKernel } from "../src/kernel/service.js";
import { LearningPaths } from "../src/growth/learning-service.js";

test("original Chinese PDFs retain page and paragraph coordinates; mixed and column pages are not silent successes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-learning-pdf-"));
  const kernel = new AgentTaskKernel({ ownerId: "pdf-owner", directory: path.join(directory, "tasks") });
  const service = new LearningPaths({ ownerId: "pdf-owner", directory: path.join(directory, "learning"), kernel });
  const access = { session: "pdf-session", valid: async () => true };
  try {
    const load = async (name: string) => service.importMaterial({ requestId: name, consent: true, name: "同名原创讲义.pdf", mediaType: "application/pdf",
      base64: (await readFile(new URL(`./fixtures/learning/${name}.pdf`, import.meta.url))).toString("base64") }, access);
    const first = await load("checkpoint-notes-v1");
    assert.deepEqual(first.pages.map(page => page.status), ["text", "text", "text"]);
    const paragraph = first.pages[1]!.blocks.find(block => block.text.includes("已有成功回执"))!;
    assert.ok(paragraph); assert.ok(paragraph.box); assert.equal(first.pages[1]!.coordinateSystem, "pdf_points_bottom_left");
    const selected = await service.passage(first.id, 2, paragraph.id, access);
    assert.equal(selected.citation.textHash, paragraph.hash); assert.equal(selected.block.text, paragraph.text);
    assert.equal((await service.bytes(first.id, access)).bytes.length, first.bytes);
    const second = await load("checkpoint-notes-v2");
    assert.notEqual(second.id, first.id);
    assert.equal((await service.passage(first.id, 2, paragraph.id, access)).block.text, paragraph.text);
    assert.deepEqual((await load("checkpoint-notes-mixed")).pages.map(page => page.status), ["text", "needs_recognition", "needs_recognition"]);
    const columns = await load("checkpoint-notes-columns");
    assert.equal(columns.pages[1]!.status, "needs_review");
    const dubious = columns.pages[1]!.blocks[0]!;
    await assert.rejects(() => service.passage(columns.id, 2, dubious.id, access), /learning_passage_requires_review/);
    await assert.rejects(() => service.importMaterial({ requestId: "broken-pdf", consent: true, name: "broken.pdf", mediaType: "application/pdf",
      base64: Buffer.from("%PDF-1.7 broken content").toString("base64") }, access), /learning_pdf_unreadable/);
  } finally { await service.close(); await kernel.close(); await rm(directory, { recursive: true, force: true }); }
});
