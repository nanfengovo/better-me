import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type {
  TranslationBackend,
  TranslationCreate,
} from "@better-me/agent-contracts";
import { AgentTaskKernel } from "../src/kernel/service.js";
import { LearningPaths } from "../src/growth/learning-service.js";
import type { LearningTranslationEngine } from "../src/growth/learning-translations.js";

const backend: TranslationBackend = {
  id: "synthetic-converter",
  engine: "Synthetic PDF job protocol fixture - NOT translated English",
  location: "local",
  ready: true,
  simulation: true,
  models: [{ name: "fixture-local", digest: "a".repeat(64) }],
};
const fixturePdf = () =>
  readFile(
    new URL("./fixtures/learning/checkpoint-notes-v1.pdf", import.meta.url),
  );
async function fixture(engine?: LearningTranslationEngine) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "betterme-translation-"),
  );
  const access = { session: "translation-session", valid: async () => true };
  let kernel = new AgentTaskKernel({
    ownerId: "translation-owner",
    directory: path.join(directory, "tasks"),
  });
  let service = new LearningPaths({
    ownerId: "translation-owner",
    directory: path.join(directory, "learning"),
    kernel,
    translationEngine: engine,
  });
  const bytes = await fixturePdf();
  const material = await service.importMaterial(
    {
      requestId: "source-original",
      consent: true,
      name: "原创讲义.pdf",
      mediaType: "application/pdf",
      base64: bytes.toString("base64"),
    },
    access,
  );
  const input: TranslationCreate = {
    requestId: "translate-once",
    consent: true,
    materialId: material.id,
    materialHash: material.hash,
    materialRevision: material.revision,
    backendId: backend.id,
    model: backend.models[0]!,
    sourceLanguage: "zh",
    targetLanguage: "en",
    bilingual: false,
    glossary: [{ source: "回执", target: "receipt" }],
  };
  return {
    get service() {
      return service;
    },
    access,
    material,
    bytes,
    input,
    restart: async () => {
      await service.close();
      await kernel.close();
      kernel = new AgentTaskKernel({
        ownerId: "translation-owner",
        directory: path.join(directory, "tasks"),
      });
      service = new LearningPaths({
        ownerId: "translation-owner",
        directory: path.join(directory, "learning"),
        kernel,
        translationEngine: engine,
      });
    },
    close: async () => {
      await service.close();
      await kernel.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function settled(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  for (let index = 0; index < 200; index++) {
    const job = await f.service.translations.get(id, f.access);
    if (!["queued", "running"].includes(job.state)) return job;
    await delay(10);
  }
  throw new Error("translation fixture did not settle");
}

test("a saved PDF job is started once, cancellation rejects late output, and reopen only reads the original receipt", async () => {
  let runs = 0,
    calls = 0;
  const entered = Promise.withResolvers<void>(),
    late = Promise.withResolvers<string>();
  const f = await fixture({
    backend: async () => backend,
    run: async (input) => {
      runs++;
      await input.progress("translating", 21);
      await input.modelCall(
        "synthetic paragraph, never a real provider",
        async () => {
          calls++;
          entered.resolve();
          return late.promise;
        },
      );
      return { mono: await fixturePdf() };
    },
  });
  try {
    const first = await f.service.translations.create(f.input, f.access);
    await entered.promise;
    const duplicate = await f.service.translations.create(f.input, f.access);
    assert.equal(duplicate.id, first.id);
    assert.equal(calls, 1);
    assert.equal(runs, 1);
    await assert.rejects(
      f.service.translations.create({ ...f.input, bilingual: true }, f.access),
      /translation_idempotency_conflict/,
    );
    const cancelled = await f.service.translations.cancel(first.id, f.access);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.usage.modelCalls, 1);
    late.resolve("late model text must not become a new artifact");
    await f.restart();
    const restored = await f.service.translations.byRequest(
      f.input.requestId,
      f.access,
    );
    assert.equal(restored.id, first.id);
    assert.equal(restored.state, "cancelled");
    assert.equal(restored.usage.modelCalls, 1);
    assert.deepEqual(restored.artifacts, []);
    await f.service.translations.create(f.input, f.access);
    assert.equal(runs, 1);
    assert.equal(calls, 1);
    await assert.rejects(
      f.service.translations.bytes(first.id, "mono", f.access),
      /translation_artifact_not_found/,
    );
  } finally {
    late.resolve("cleanup");
    await f.close();
  }
});

test("Host interruption preserves reserved usage, never requeues on GET, and closes even when an adapter ignores abort", async () => {
  let calls = 0;
  const entered = Promise.withResolvers<void>(),
    never = Promise.withResolvers<string>();
  const f = await fixture({
    backend: async () => backend,
    run: async (input) => {
      await input.modelCall("reserved before the real send", async () => {
        calls++;
        entered.resolve();
        return never.promise;
      });
      return { mono: await fixturePdf() };
    },
  });
  try {
    const first = await f.service.translations.create(f.input, f.access);
    await entered.promise;
    await f.restart();
    const restored = await f.service.translations.get(first.id, f.access);
    assert.equal(restored.state, "interrupted");
    assert.equal(restored.usage.modelCalls, 1);
    for (let i = 0; i < 3; i++) await f.service.translations.list(f.access);
    await f.service.translations.create(f.input, f.access);
    assert.equal(calls, 1);
    assert.deepEqual(restored.artifacts, []);
  } finally {
    never.resolve("cleanup");
    await f.close();
  }
});

test("every converter retry is charged before dispatch; call 33 is refused and a new ID cannot rewrite the old budget", async () => {
  let dispatches = 0;
  const f = await fixture({
    backend: async () => backend,
    run: async (input) => {
      for (let i = 0; i < 33; i++)
        await input.modelCall(`synthetic request ${i}`, async () => {
          dispatches++;
          return "fixture";
        });
      return { mono: await fixturePdf() };
    },
  });
  try {
    const first = await f.service.translations.create(f.input, f.access),
      job = await settled(f, first.id);
    assert.equal(job.state, "failed");
    assert.equal(job.issue, "translation_model_budget_exhausted");
    assert.equal(job.usage.modelCalls, 32);
    assert.equal(dispatches, 32);
    await f.restart();
    await f.service.translations.create(f.input, f.access);
    assert.equal(dispatches, 32);
    assert.equal(
      (await f.service.translations.get(first.id, f.access)).usage.modelCalls,
      32,
    );
  } finally {
    await f.close();
  }
});

test("a generated PDF is only an unreviewed draft; simulated outputs can never pass as accepted translations and revocation keeps usage", async () => {
  const f = await fixture({
    backend: async () => backend,
    run: async (input) => {
      await input.modelCall(
        "fixture source",
        async () => "fixture response, NOT a translation",
      );
      await input.progress("typesetting", 80);
      return { mono: await fixturePdf() };
    },
  });
  try {
    const first = await f.service.translations.create(f.input, f.access),
      job = await settled(f, first.id);
    assert.equal(job.state, "review_required");
    assert.equal(job.artifacts[0]!.pages, 3);
    assert.deepEqual(
      (await f.service.translations.bytes(first.id, "mono", f.access)).bytes,
      new Uint8Array(f.bytes),
    );
    const review = {
      requestId: "review-once",
      consent: true,
      decision: "accept",
      checks: {
        pages: "pass",
        numbers_units: "pass",
        negations: "pass",
        formulas: "not_applicable",
        reading_order: "pass",
        overflow: "pass",
      },
      renderedPagesReviewed: true,
      extractedTextReviewed: true,
      notes: "Control-flow fixture only; no translation quality claim.",
    };
    await assert.rejects(
      f.service.translations.review(first.id, review, f.access),
      /translation_quality_not_accepted/,
    );
    const rejected = await f.service.translations.review(
      first.id,
      { ...review, decision: "reject" },
      f.access,
    );
    assert.equal(rejected.state, "rejected");
    assert.equal(
      (
        await f.service.translations.review(
          first.id,
          { ...review, decision: "reject" },
          f.access,
        )
      ).review!.requestId,
      "review-once",
    );
    await assert.rejects(
      f.service.translations.review(
        first.id,
        { ...review, notes: "replace frozen review" },
        f.access,
      ),
      /translation_review_frozen/,
    );
    await f.service.revoke(f.material.id, "revoke-draft", f.access);
    const revoked = await f.service.translations.get(first.id, f.access);
    assert.equal(revoked.state, "source_revoked");
    assert.equal(revoked.usage.modelCalls, 1);
    assert.deepEqual(revoked.artifacts, []);
    assert.deepEqual(revoked.request.glossary, []);
    await assert.rejects(
      f.service.translations.bytes(first.id, "mono", f.access),
      /learning_material_revoked/,
    );
    await assert.rejects(
      f.service.translations.create(
        { ...f.input, requestId: "new-after-revoke" },
        f.access,
      ),
      /learning_material_revoked/,
    );
  } finally {
    await f.close();
  }
});

test("missing engines do not dispatch; scanned/column pages and changed source versions fail closed", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.translations.backend(f.access)).ready, false);
    await assert.rejects(
      f.service.translations.create(f.input, f.access),
      /translation_backend_unavailable/,
    );
    assert.deepEqual(await f.service.translations.list(f.access), []);
  } finally {
    await f.close();
  }
  let runs = 0;
  const g = await fixture({
    backend: async () => backend,
    run: async () => {
      runs++;
      return { mono: await fixturePdf() };
    },
  });
  try {
    await assert.rejects(
      g.service.translations.create(
        { ...g.input, materialHash: "b".repeat(64) },
        g.access,
      ),
      /learning_material_version_conflict/,
    );
    for (const name of [
      "checkpoint-notes-mixed.pdf",
      "checkpoint-notes-columns.pdf",
    ]) {
      const bytes = await readFile(
        new URL(`./fixtures/learning/${name}`, import.meta.url),
      );
      const material = await g.service.importMaterial(
        {
          requestId: name,
          consent: true,
          name,
          mediaType: "application/pdf",
          base64: bytes.toString("base64"),
        },
        g.access,
      );
      await assert.rejects(
        g.service.translations.create(
          {
            ...g.input,
            requestId: name,
            materialId: material.id,
            materialHash: material.hash,
          },
          g.access,
        ),
        /translation_text_pdf_required/,
      );
    }
    assert.equal(runs, 0);
  } finally {
    await g.close();
  }
});

test("cloud PDF quality review records terminology separately from formulas",async()=>{
  const {pdfCloudModel,PDF_CLOUD_BACKEND,PDF_CLOUD_ORIGIN}=await import("@better-me/agent-contracts");
  const model=pdfCloudModel("deepseek-v4-pro");
  const f=await fixture({abortSettles:true,backend:async()=>({...backend,id:PDF_CLOUD_BACKEND,
    location:"cloud",recipientOrigin:PDF_CLOUD_ORIGIN,models:[model]}),run:async()=>({mono:await fixturePdf()})});
  try{
    const job=await f.service.translations.create({...f.input,backendId:PDF_CLOUD_BACKEND,model,cloudGrant:{recipientOrigin:PDF_CLOUD_ORIGIN,
      model:model.name,materialHash:f.material.hash,scope:"document_text_and_glossary",maxCalls:1}},f.access,"synthetic-credential");
    assert.equal((await settled(f,job.id)).state,"review_required");
    const review={requestId:"review-once",decision:"reject",consent:true,renderedPagesReviewed:true,extractedTextReviewed:true,
      notes:"Synthetic fixture to verify terminology receipt",checks:{pages:"pass",overflow:"pass",formulas:"fail",numbers_units:"pass",
        reading_order:"pass",negations:"pass"}};
    await assert.rejects(f.service.translations.review(job.id,review,f.access),/translation_terminology_review_required/);
    assert.equal((await f.service.translations.review(job.id,{...review,terminology:"fail"},f.access)).review?.terminology,"fail");
  }finally{await f.close();}
});

test("a PDF cloud job binds the recipient, material and per-job budget; a local grant or a reload cannot send it", async () => {
  const { pdfCloudModel, PDF_CLOUD_BACKEND, PDF_CLOUD_ORIGIN } = await import("@better-me/agent-contracts");
  const model=pdfCloudModel("deepseek-v4-pro"), key="synthetic-only-pdf-key";
  let sends=0;
  const f=await fixture({abortSettles:true,
    backend:async()=>({...backend,id:PDF_CLOUD_BACKEND,location:"cloud",recipientOrigin:PDF_CLOUD_ORIGIN,models:[model]}),
    run:async input=>{ assert.equal(input.cloudKey,key);for(let n=0;n<3;n++)
      await input.modelCall("合成段落",async()=>{sends++;return "translation";});return {mono:await fixturePdf()};},
  });
  try {
    const job={...f.input,backendId:PDF_CLOUD_BACKEND,model};
    const cloudGrant={recipientOrigin:PDF_CLOUD_ORIGIN,model:model.name,materialHash:f.material.hash,
      scope:"document_text_and_glossary" as const,maxCalls:2};
    await assert.rejects(f.service.translations.create(job,f.access,key));
    await assert.rejects(f.service.translations.create({...job,cloudGrant:{...cloudGrant,materialHash:"d".repeat(64)}},f.access,key));
    await assert.rejects(f.service.translations.create({...job,cloudGrant},f.access));
    assert.equal(sends,0);
    const first=await f.service.translations.create({...job,cloudGrant},f.access,key);
    const result=await settled(f,first.id);assert.equal(result.issue,"translation_model_budget_exhausted");
    assert.equal(sends,2);assert.equal(result.usage.modelCalls,2);assert.ok(!JSON.stringify(result).includes(key));
    await f.restart();assert.equal((await f.service.translations.byRequest(job.requestId,f.access)).id,first.id);
    assert.equal(sends,2);
  } finally { await f.close(); }
});
