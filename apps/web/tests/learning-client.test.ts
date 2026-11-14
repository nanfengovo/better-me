import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createHash } from "node:crypto";
import { activatePrincipal, IdentityBoundaryError } from "../src/lib/identity";
import { createLearningClient } from "../src/services/learning-client";
import { PDF_CLOUD_BACKEND, PDF_CLOUD_ORIGIN, pdfCloudModel, TranslationJobSchema } from "@better-me/agent-contracts";

const alice = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "learning-a",
  displayName: "Learning A",
};
const bob = {
  id: "22222222-2222-4222-8222-222222222222",
  username: "learning-b",
  displayName: "Learning B",
};
const bytes = new TextEncoder().encode("原创资料：已有成功回执不重复派送。");
const hash = createHash("sha256").update(bytes).digest("hex");
const material = {
  id: "lm_" + "a".repeat(64),
  ownerId: alice.id,
  name: "原创讲义.txt",
  mediaType: "text/plain" as const,
  hash,
  bytes: bytes.length,
  importedAt: "2026-11-14T00:00:00.000Z",
  parser: "utf8-paragraphs-v1",
  pages: [
    {
      number: 1,
      width: 80,
      height: 1,
      coordinateSystem: "text_lines_top_left" as const,
      status: "text" as const,
      blocks: [{ id: "b1", text: new TextDecoder().decode(bytes), hash }],
    },
  ],
  revoked: false,
  revision: 1,
  modelConsent: false as const,
};
afterEach(() => activatePrincipal(undefined));

test("PDF cloud credentials require secure Host transport and never follow a redirect",async()=>{
  activatePrincipal(alice);const model=pdfCloudModel("deepseek-v4-pro"),key="SYNTHETIC_ONLY_PDF_KEY";
  const input={requestId:"cloud-secure-post",consent:true,materialId:material.id,materialHash:hash,materialRevision:1,backendId:PDF_CLOUD_BACKEND,
    model,sourceLanguage:"zh",targetLanguage:"en",bilingual:true,glossary:[],cloudGrant:{recipientOrigin:PDF_CLOUD_ORIGIN,
      model:"deepseek-v4-pro",materialHash:hash,scope:"document_text_and_glossary",maxCalls:3}} as const;
  let calls=0;
  const make=(baseUrl:string)=>createLearningClient({baseUrl,fetch:async(url,init)=>{
    calls++;assert.equal(String(url),"https://trusted.invalid/api/v1/agent/growth/learning/translations");assert.equal(init?.redirect,"error");
    assert.equal(new Headers(init?.headers).get("X-BetterMe-Owner"),alice.id);
    const body=JSON.parse(String(init?.body));assert.equal(body.credential,key);assert.ok(!JSON.stringify(body.request).includes(key));
    return Response.json({error:"synthetic_boundary_stop"},{status:400});
  }});
  const request={...input,glossary:[]};
  await assert.rejects(make("http://untrusted.invalid").createTranslation(request,undefined,key),/HTTPS/);
  await assert.rejects(make("https://trusted.invalid").createTranslation(request),/HTTPS/);assert.equal(calls,0);
  await assert.rejects(make("https://trusted.invalid").createTranslation(request,undefined,key),/synthetic_boundary_stop/);assert.equal(calls,1);
});

test("learning file encoding remains bound to the owner who selected it, even if accounts switch before encoding completes", async () => {
  activatePrincipal(alice);
  let calls = 0;
  const encoded = Promise.withResolvers<ArrayBuffer>();
  class SlowFile extends File {
    override arrayBuffer() {
      return encoded.promise;
    }
  }
  const client = createLearningClient({
    baseUrl: "http://learning-client.invalid",
    fetch: async () => {
      calls++;
      return Response.json({ material });
    },
  });
  const pending = client.importMaterial(
    new SlowFile([bytes], "原创讲义.txt"),
    "import-original",
  );
  activatePrincipal(bob);
  encoded.resolve(new Uint8Array(bytes).buffer);
  await assert.rejects(pending, IdentityBoundaryError);
  assert.equal(
    calls,
    0,
    "old-owner source bytes must not be sent as the next owner",
  );
});

test("learning bytes validate hash, length and MIME, and foreign or late bodies are rejected", async () => {
  activatePrincipal(alice);
  let calls = 0;
  const client = createLearningClient({
    baseUrl: "http://learning-client.invalid",
    fetch: async (_url, init) => {
      calls++;
      assert.equal(
        new Headers(init?.headers).get("X-BetterMe-Owner"),
        alice.id,
      );
      assert.equal(init?.credentials, "include");
      return new Response(bytes, {
        headers: { "Content-Type": "text/plain", "X-Content-SHA256": hash },
      });
    },
  });
  assert.deepEqual(await client.bytes(material), bytes);
  const tampered = createLearningClient({
    baseUrl: "http://learning-client.invalid",
    fetch: async () =>
      new Response("different", {
        headers: { "Content-Type": "text/plain", "X-Content-SHA256": hash },
      }),
  });
  await assert.rejects(tampered.bytes(material), /不一致/);
  const foreign = createLearningClient({
    baseUrl: "http://learning-client.invalid",
    fetch: async () =>
      Response.json({ material: { ...material, ownerId: bob.id } }),
  });
  await assert.rejects(foreign.material(material.id), IdentityBoundaryError);
  let release!: (response: Response) => void;
  const late = createLearningClient({
    baseUrl: "http://learning-client.invalid",
    fetch: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const reading = late.material(material.id);
  activatePrincipal(bob);
  release(Response.json({ material }));
  await assert.rejects(reading, IdentityBoundaryError);
  assert.equal(calls, 1);
});

test("selected citations must match exactly and denied mutations are never retried by the learning client", async () => {
  activatePrincipal(alice);
  let calls = 0;
  const citation = {
    materialId: material.id,
    materialHash: hash,
    materialRevision: 1,
    page: 1,
    blockId: "b1",
    textHash: hash,
  };
  const wrong = createLearningClient({
    baseUrl: "http://learning-client.invalid",
    fetch: async () =>
      Response.json({
        ownerId: alice.id,
        citation: { ...citation, page: 2 },
        block: material.pages[0]!.blocks[0],
      }),
  });
  await assert.rejects(wrong.passage(citation), /变化/);
  const denied = createLearningClient({
    baseUrl: "http://learning-client.invalid",
    fetch: async () => {
      calls++;
      return Response.json(
        { error: "learning_material_revoked" },
        { status: 403 },
      );
    },
  });
  await assert.rejects(
    denied.revoke(material.id, "stable-revoke"),
    /learning_material_revoked/,
  );
  assert.equal(calls, 1);
});

function translationFixture() {
  const bytes = new TextEncoder().encode(
    "%PDF-1.7\nsynthetic transport bytes, not a renderable or translated document",
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  const job = TranslationJobSchema.parse({
    id: "lt_" + "a".repeat(32),
    ownerId: alice.id,
    request: {
      requestId: "translation-request",
      consent: true,
      materialId: material.id,
      materialHash: material.hash,
      materialRevision: 1,
      backendId: "simulation",
      model: { name: "synthetic-local", digest: "c".repeat(64) },
      sourceLanguage: "zh",
      targetLanguage: "en",
      bilingual: false,
      glossary: [],
    },
    backend: {
      id: "simulation",
      engine: "Transport fixture, no translation",
      ready: true,
      simulation: true,
      location: "local",
      models: [],
    },
    materialName: "synthetic.pdf",
    sourcePages: 1,
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    state: "review_required",
    stage: "finished",
    progress: 100,
    usage: { modelCalls: 1, inputBytes: 10, outputBytes: 20 },
    artifacts: [
      {
        kind: "mono",
        hash: digest,
        bytes: bytes.length,
        pages: 1,
        emptyTextPages: [],
      },
    ],
  });
  return { job, bytes, digest };
}

test("translation restores are GET only and frozen owner/request bindings are checked without retries", async () => {
  activatePrincipal(alice);
  const { job } = translationFixture();
  const methods: string[] = [];
  const client = createLearningClient({
    baseUrl: "http://translation.invalid",
    fetch: async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json({ job });
    },
  });
  await client.translation(job.id);
  await client.translationByRequest(job.request.requestId);
  assert.deepEqual(methods, ["GET", "GET"]);
  const swapped = createLearningClient({
    baseUrl: "http://translation.invalid",
    fetch: async () =>
      Response.json({
        job: {
          ...job,
          request: { ...job.request, materialHash: "f".repeat(64) },
        },
      }),
  });
  await assert.rejects(swapped.createTranslation(job.request), /没有绑定/);
  const foreign = createLearningClient({
    baseUrl: "http://translation.invalid",
    fetch: async () => Response.json({ job: { ...job, ownerId: bob.id } }),
  });
  await assert.rejects(foreign.translation(job.id), IdentityBoundaryError);
  let posts = 0;
  const lost = createLearningClient({
    baseUrl: "http://translation.invalid",
    fetch: async () => {
      posts++;
      return Response.json(
        { error: "lost_translation_receipt" },
        { status: 502 },
      );
    },
  });
  await assert.rejects(
    lost.createTranslation(job.request),
    /lost_translation_receipt/,
  );
  assert.equal(posts, 1);
});

test("translation artifact transport bounds bytes, hash and type and refuses late owner changes", async () => {
  activatePrincipal(alice);
  const { job, bytes, digest } = translationFixture();
  const headers = {
    "Content-Type": "application/pdf",
    "X-Content-SHA256": digest,
  };
  const client = createLearningClient({
    baseUrl: "http://translation.invalid",
    fetch: async () => new Response(bytes, { headers }),
  });
  assert.deepEqual(await client.translationBytes(job, "mono"), bytes);
  const large = createLearningClient({
    baseUrl: "http://translation.invalid",
    fetch: async () =>
      new Response(new Uint8Array(bytes.length + 1), { headers }),
  });
  await assert.rejects(large.translationBytes(job, "mono"), /超过/);
  const changed = createLearningClient({
    baseUrl: "http://translation.invalid",
    fetch: async () => new Response(new Uint8Array(bytes.length), { headers }),
  });
  await assert.rejects(changed.translationBytes(job, "mono"), /不一致/);
  let release!: (response: Response) => void;
  const late = createLearningClient({
    baseUrl: "http://translation.invalid",
    fetch: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const pending = late.translationBytes(job, "mono");
  activatePrincipal(bob);
  release(new Response(bytes, { headers }));
  await assert.rejects(pending, IdentityBoundaryError);
});
