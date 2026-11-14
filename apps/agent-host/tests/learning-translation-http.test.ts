import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";
import { registerTestIdentity } from "./fixtures/identity.js";
import { createPdf2zhEngine } from "../src/growth/pdf2zh-engine.js";

test("authenticated PDF conversion keeps source versions, draft bytes, review and cancellation private to the owner", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "betterme-translation-http-"),
  );
  const token = "synthetic-translation-http-only",
    pdf = await readFile(
      new URL("./fixtures/learning/checkpoint-notes-v1.pdf", import.meta.url),
    );
  let runs = 0;
  const backend = {
    id: "synthetic-pdf-engine",
    engine: "Protocol fixture, not a translator",
    ready: true,
    simulation: true,
    location: "local" as const,
    models: [{ name: "synthetic-local", digest: "e".repeat(64) }],
  };
  const server = createAgentServer({
    host: "127.0.0.1",
    port: 0,
    authToken: token,
    allowedOrigins: [],
    runtimeDefinitions: [],
    identityDirectory: path.join(directory, "identity"),
    runsDirectory: path.join(directory, "runs"),
    understandingDirectory: path.join(directory, "understanding"),
    checkpointer: new MemorySaver() as never,
    learningTranslationEngine: {
      backend: async () => backend,
      run: async (input) => {
        runs++;
        await input.modelCall(
          "synthetic paragraph",
          async () => "not a real translation",
        );
        return { mono: pdf };
      },
    },
  });
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const alice = await registerTestIdentity(
        origin,
        token,
        "translation-alice",
      ),
      bob = await registerTestIdentity(origin, token, "translation-bob");
    const call = (
      headers: Record<string, string>,
      suffix: string,
      body?: unknown,
    ) =>
      fetch(`${origin}/api/v1/agent/growth/learning${suffix}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...headers,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const imported = await call(alice.headers, "/materials", {
      requestId: "translation-source",
      consent: true,
      name: "原创样本.pdf",
      mediaType: "application/pdf",
      base64: pdf.toString("base64"),
    });
    assert.equal(imported.status, 201);
    const { material } = await imported.json();
    const input = {
      requestId: "http-job-once",
      consent: true,
      materialId: material.id,
      materialHash: material.hash,
      materialRevision: material.revision,
      backendId: backend.id,
      model: backend.models[0],
      sourceLanguage: "zh",
      targetLanguage: "en",
      bilingual: false,
      glossary: [],
    };
    assert.equal(
      (
        await call(alice.headers, "/translations", {
          ...input,
          python: "/tmp/untrusted-executable",
        })
      ).status,
      400,
    );
    assert.equal(
      (await call(alice.headers, "/translations", { ...input, consent: false }))
        .status,
      400,
    );
    assert.equal(
      (
        await call(alice.headers, "/translations", {
          ...input,
          targetLanguage: "de",
        })
      ).status,
      400,
    );
    assert.equal(runs, 0);
    const started = await call(alice.headers, "/translations", input);
    assert.equal(started.status, 201, await started.clone().text());
    const { job } = await started.json();
    for (let i = 0; i < 100; i++) {
      const value = (
        await (await call(alice.headers, `/translations/${job.id}`)).json()
      ).job;
      if (value.state === "review_required") break;
      await delay(20);
    }
    assert.equal(
      (await (await call(alice.headers, "/translations", input)).json()).job.id,
      job.id,
    );
    assert.equal(runs, 1);
    assert.equal(
      (await call(bob.headers, `/translations/${job.id}`)).status,
      404,
    );
    assert.equal(
      (await call(bob.headers, `/translations/requests/${input.requestId}`))
        .status,
      404,
    );
    assert.equal(
      (await call(bob.headers, `/translations/${job.id}/artifacts/mono`))
        .status,
      404,
    );
    assert.equal(
      (
        await call(bob.headers, `/translations/${job.id}/cancel`, {
          consent: true,
        })
      ).status,
      404,
    );
    assert.deepEqual(
      (await (await call(bob.headers, "/translations")).json()).jobs,
      [],
    );
    const bytes = await call(
      alice.headers,
      `/translations/${job.id}/artifacts/mono`,
    );
    assert.equal(bytes.status, 200);
    assert.equal(bytes.headers.get("Content-Type"), "application/pdf");
    assert.match(bytes.headers.get("Cache-Control")!, /no-store/);
    assert.equal(bytes.headers.get("X-Content-SHA256"), material.hash);
    assert.deepEqual(
      new Uint8Array(await bytes.arrayBuffer()),
      new Uint8Array(pdf),
    );
    await call(alice.headers, `/materials/${material.id}/revoke`, {
      requestId: "revoke-source-and-derived",
      consent: true,
    });
    assert.equal(
      (await call(alice.headers, `/translations/${job.id}/artifacts/mono`))
        .status,
      403,
    );
    const revoked = (
      await (await call(alice.headers, `/translations/${job.id}`)).json()
    ).job;
    assert.equal(revoked.state, "source_revoked");
    assert.equal(revoked.usage.modelCalls, 1);
    assert.deepEqual(revoked.artifacts, []);
    const career = await fetch(`${origin}/api/v1/agent/tasks`, {
      headers: { ...alice.headers, Authorization: `Bearer ${token}` },
    });
    assert.deepEqual((await career.json()).tasks, []);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test("the native PDF engine has no implicit installation and rejects an unverified interpreter before touching a model", async () => {
  assert.equal(createPdf2zhEngine(), undefined);
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "betterme-translation-probe-"),
  );
  try {
    await mkdir(path.join(directory, "fonts"));
    await writeFile(
      path.join(directory, "fonts", "synthetic.txt"),
      "not a font, metadata probe must still reject Node as Python",
    );
    const engine = createPdf2zhEngine({
      python: process.execPath,
      assets: directory,
    })!;
    const backend = await engine.backend();
    assert.equal(backend.ready, false);
    assert.equal(backend.simulation, false);
    assert.deepEqual(backend.models, []);
    assert.match(
      backend.reason!,
      /^translation_(?:windows_isolation_unreviewed|python_or_packages_unavailable)$/,
    );
    let calls = 0;
    await assert.rejects(
      engine.run({
        request: {} as never,
        source: new Uint8Array(),
        signal: new AbortController().signal,
        progress: async () => {},
        modelCall: async () => {
          calls++;
          return "";
        },
      }),
      /translation_backend_unavailable/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
