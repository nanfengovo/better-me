import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { createAtlasLeadClient } from "../src/components/atlas/lead-client.ts";
import {
  atlasLeadRecoveryScope, beginAtlasLeadRecovery, endAtlasLeadRecovery,
  readAtlasLeadRecovery, writeAtlasLeadRecovery, type AtlasLeadWrite,
} from "../src/components/atlas/lead-recovery.ts";
import { leadImport, leadPreview, leadReceipt } from "./fixtures/atlas-leads.ts";

let serial = 0;
const scope = () => atlasLeadRecoveryScope("http://127.0.0.1:5178", `synthetic-recovery-${++serial}`);
const command = (): AtlasLeadWrite => ({ input: structuredClone(leadImport), key: "synthetic-original-command", jobId: leadPreview.canonicalJobId });
function edit(action: () => void) {
  try { action(); } catch (problem) { assert.ok(problem instanceof TypeError, "Only immutable-value rejection may interrupt the simulated editor."); }
}
afterEach(() => mock.restoreAll());

test("retaining a command detaches it from subsequent edits to the preview and caller-owned request", () => {
  const identity = scope(), original = command(), expected = structuredClone(original);
  try {
    writeAtlasLeadRecovery(identity, { pending: original });
    original.input.capture.record.description = "Synthetic unsaved editor change";
    original.input.capture.record.evidence[0]!.quote = "Synthetic changed quote";
    original.input.previewFingerprint = "0".repeat(64); original.key = "synthetic-replacement-key";
    assert.deepEqual(readAtlasLeadRecovery(identity).pending, expected);
  } finally { writeAtlasLeadRecovery(identity, {}); }
});

test("reading a pending command cannot change the exact body or key sent by receipt recovery", async () => {
  const identity = scope(), original = command(), bodies: string[] = [], keys: Array<string | null> = [];
  mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init: RequestInit = {}) => {
    bodies.push(String(init.body)); keys.push(new Headers(init.headers).get("Idempotency-Key"));
    return new Response(JSON.stringify({ ok: true, requestId: "synthetic-recovery-reply", value: leadReceipt }));
  });
  const client = createAtlasLeadClient("http://127.0.0.1:5178", "synthetic-recovery-token");
  const sendRetained = async () => {
    const held = readAtlasLeadRecovery(identity).pending!;
    return client.importOriginal(held.input, { idempotencyKey: held.key, jobId: held.jobId });
  };
  try {
    writeAtlasLeadRecovery(identity, { pending: original });
    await sendRetained();
    const exposed = readAtlasLeadRecovery(identity).pending!;
    edit(() => { exposed.input.capture.record.description = "Synthetic another pane edited the JD"; });
    edit(() => { exposed.input.capture.record.evidence[0]!.quote = "Synthetic changed source evidence"; });
    edit(() => { exposed.input.capture.record.warnings.push("Synthetic accidental mutation"); });
    edit(() => { exposed.input.capture.proof = "0".repeat(64); });
    edit(() => { exposed.key = "synthetic-another-command"; });
    await sendRetained();
    assert.deepEqual(bodies.map(body => JSON.parse(body)), [original.input, original.input], "A recovered save must retain the originally reviewed body.");
    assert.deepEqual(keys, [original.key, original.key], "A recovered save must reuse the original idempotency key.");
  } finally { writeAtlasLeadRecovery(identity, {}); }
});

test("saved receipt and original identity remain intact when another consumer edits its snapshot", () => {
  const identity = scope(), saved = { receipt: structuredClone(leadReceipt), leadId: leadImport.capture.leadId,
    original: { sourceId: leadImport.capture.originalSourceId, sourceRecordId: leadImport.capture.record.sourceRecordId!, url: leadImport.capture.url } };
  const expected = structuredClone(saved);
  try {
    writeAtlasLeadRecovery(identity, { saved });
    saved.receipt.jobIds.push("synthetic-caller-owned-change"); saved.original.sourceRecordId = "synthetic-caller-owned-record";
    assert.deepEqual(readAtlasLeadRecovery(identity).saved, expected);
    const exposed = readAtlasLeadRecovery(identity).saved!;
    edit(() => { exposed.receipt.jobIds.splice(0, 1, "synthetic-different-owner"); });
    edit(() => { exposed.receipt.counts.newJobs = 999; });
    edit(() => { exposed.original.sourceRecordId = "synthetic-another-posting"; });
    assert.deepEqual(readAtlasLeadRecovery(identity).saved, expected, "An index retry must retain the saved posting identity and accepted receipt.");
  } finally { writeAtlasLeadRecovery(identity, {}); }
});

test("a scope permits one recovery lease and a stale lease cannot release its successor", () => {
  const identity = scope(), retained = command(); let owner: string | undefined;
  try {
    writeAtlasLeadRecovery(identity, { pending: retained }); owner = beginAtlasLeadRecovery(identity); assert.ok(owner);
    assert.equal(readAtlasLeadRecovery(identity).active, true); assert.equal(beginAtlasLeadRecovery(identity), undefined);
    endAtlasLeadRecovery(identity, "synthetic-unrelated-owner"); assert.equal(readAtlasLeadRecovery(identity).active, true);
    endAtlasLeadRecovery(identity, owner); assert.equal(readAtlasLeadRecovery(identity).active, undefined);
    assert.deepEqual(readAtlasLeadRecovery(identity).pending, retained, "Ending a lease must not discard the unconfirmed command.");
    const previous = owner; owner = beginAtlasLeadRecovery(identity); assert.ok(owner); assert.notEqual(owner, previous);
    endAtlasLeadRecovery(identity, previous); assert.equal(readAtlasLeadRecovery(identity).active, true);
  } finally { if (owner) endAtlasLeadRecovery(identity, owner); writeAtlasLeadRecovery(identity, {}); }
});

test("connection scopes isolate pending commands and reads remain stable until a state transition", () => {
  const a = scope(), b = scope(), retained = command(); let owner: string | undefined;
  try {
    assert.notEqual(a, b); assert.notEqual(atlasLeadRecoveryScope("ab", "c"), atlasLeadRecoveryScope("a", "bc"));
    const empty = readAtlasLeadRecovery(a); assert.equal(readAtlasLeadRecovery(a), empty);
    writeAtlasLeadRecovery(a, { pending: retained });
    const held = readAtlasLeadRecovery(a); assert.equal(readAtlasLeadRecovery(a), held);
    assert.deepEqual(readAtlasLeadRecovery(b), {}); owner = beginAtlasLeadRecovery(b); assert.ok(owner);
    assert.equal(readAtlasLeadRecovery(a), held, "Another connection cannot invalidate the current useSyncExternalStore snapshot.");
    assert.deepEqual(readAtlasLeadRecovery(a).pending, retained); assert.equal(readAtlasLeadRecovery(a).active, undefined);
  } finally { if (owner) endAtlasLeadRecovery(b, owner); writeAtlasLeadRecovery(a, {}); writeAtlasLeadRecovery(b, {}); }
});
