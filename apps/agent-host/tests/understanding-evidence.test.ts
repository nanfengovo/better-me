import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceBroker } from "../src/understanding/evidence-broker.ts";

test("explicit grants expose bounded source evidence but reject secrets, traversal and symlinks", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-evidence-"));
  try {
    await fs.mkdir(path.join(fixture, "project"));
    await fs.writeFile(path.join(fixture, "project", "flow.ts"), "export const accepted = 1;\nexport const finished = 2;\n");
    await fs.writeFile(path.join(fixture, "project", ".env"), "SYNTHETIC_SECRET=not-real");
    await fs.writeFile(path.join(fixture, "outside.ts"), "outside fixture");
    await fs.symlink(path.join(fixture, "outside.ts"), path.join(fixture, "project", "escape.ts"));
    const broker = new EvidenceBroker();
    await assert.rejects(broker.grant(os.homedir()));
    const grant = await broker.grant(path.join(fixture, "project"));
    const result = await broker.execute(grant, { operation: "read", path: "flow.ts", startLine: 2, endLine: 2 });
    assert.equal(result.evidence[0]?.excerpt, "export const finished = 2;");
    assert.match(result.evidence[0]?.hash ?? "", /^[a-f0-9]{64}$/);
    for (const denied of [".env", "../outside.ts", "escape.ts"]) {
      await assert.rejects(broker.execute(grant, { operation: "read", path: denied }));
    }
    assert.deepEqual((await broker.execute(grant, { operation: "list", path: "" })).entries?.map(x => x.path), ["flow.ts"]);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test("exact-file grants never expand to siblings or a replacement directory", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-file-grant-"));
  try {
    const filename = path.join(fixture, "flow.ts");
    await fs.writeFile(filename, "const flow = 'synthetic';\n");
    await fs.writeFile(path.join(fixture, "sibling.ts"), "const sibling = true;");
    const broker = new EvidenceBroker();
    const grant = await broker.grant(filename);
    assert.equal(grant.path, await fs.realpath(filename));
    assert.match((await broker.execute(grant, { operation: "read", path: "" })).evidence[0]?.excerpt ?? "", /synthetic/);
    assert.deepEqual((await broker.execute(grant, { operation: "list" })).entries?.map(item => item.path), ["flow.ts"]);
    await assert.rejects(broker.execute(grant, { operation: "read", path: "sibling.ts" }));
    await fs.rename(filename, path.join(fixture, "original.ts"));
    await fs.mkdir(filename);
    await fs.writeFile(path.join(filename, "sibling.ts"), "const unexpected = true;");
    await assert.rejects(broker.execute(grant, { operation: "list" }));
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
});

test("sensitive content, binaries, oversized text, hard links and ancestor aliases are denied", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-screening-"));
  try {
    const project = path.join(fixture, "source");
    await fs.mkdir(project);
    const samples = [
      '{"password":"synthetic123"}',
      'Server=fixture;Password=abc;User ID=test;',
      '{"connectionStrings":{"Main":"not-a-real-database"}}',
      'postgres://fixture:synthetic@invalid.example/test',
      'const apiKey = "synthetic-fixture-value";',
    ];
    for (const [index, sample] of samples.entries()) await fs.writeFile(path.join(project, `sample${index}.json`), sample);
    await fs.writeFile(path.join(project, "binary.ts"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(project, "large.ts"), "x".repeat(300000));
    await fs.writeFile(path.join(project, "plain.ts"), "const noSecret = 1;");
    await fs.link(path.join(project, "plain.ts"), path.join(project, "linked.ts"));
    await fs.symlink(project, path.join(fixture, "alias"));
    const broker = new EvidenceBroker();
    const grant = await broker.grant(project);
    for (const name of [...samples.map((_, index) => `sample${index}.json`), "binary.ts", "large.ts", "linked.ts"]) await assert.rejects(broker.execute(grant, { operation: "read", path: name }), name);
    await assert.rejects(broker.grant(path.join(fixture, "alias", "plain.ts")));
    assert.equal((await broker.execute(grant, { operation: "search", query: "fixture" })).evidence.length, 0);
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
});

test("private owner stores cannot be read through direct, nested, cached or exact-file grants", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "understanding-private-boundary-"));
  try {
    const project = path.join(fixture, "project"), privateRoot = path.join(project, "accounts-v1");
    await fs.mkdir(privateRoot, { recursive: true });
    await fs.writeFile(path.join(project, "flow.ts"), "export const fixtureFlow = 1;");
    const record = path.join(privateRoot, "record.json"); await fs.writeFile(record, '{"private":"A-secret-fixture"}');
    const oldBroker = new EvidenceBroker(), cached = await oldBroker.grant(privateRoot), cachedFile = await oldBroker.grant(record);
    const broker = new EvidenceBroker({ forbiddenRoots: [privateRoot] });
    await assert.rejects(broker.grant(privateRoot), /不能作为项目源码/);
    await assert.rejects(broker.grant(record), /不能作为项目源码/);
    await assert.rejects(broker.execute(cached, { operation: "list" }), /不能作为项目源码/);
    await assert.rejects(broker.execute(cachedFile, { operation: "list" }), /不能作为项目源码/);
    await assert.rejects(broker.execute(cachedFile, { operation: "read" }), /不能作为项目源码/);
    const ancestor = await broker.grant(project);
    assert.deepEqual((await broker.execute(ancestor, { operation: "list" })).entries?.map(entry => entry.path), ["flow.ts"]);
    assert.equal((await broker.execute(ancestor, { operation: "search", query: "A-secret-fixture" })).evidence.length, 0);
    await assert.rejects(broker.execute(ancestor, { operation: "read", path: "accounts-v1/record.json" }), /不能作为项目源码/);
    await assert.rejects(broker.directoryVersion(cached), /不能作为项目源码/);
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
});
