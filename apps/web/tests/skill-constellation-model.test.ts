import assert from "node:assert/strict";
import test from "node:test";
import {
  SKILL_CONSTELLATION_LIMITS, constellationArc, constellationUnitVector, prepareSkillConstellation,
  sameSkillConstellationBinding, skillConstellationFingerprint, type SkillConstellationInput, type VerifiedSkillJobLink,
} from "../src/lib/skill-constellation";

const digest = "a".repeat(64), jobDigest = "b".repeat(64);
const binding = { ownerId: "synthetic-owner", sessionGeneration: 2, contextId: "synthetic-spatial-context", revision: "snapshot-1" };
function link(jobId = "job-1", overrides: Partial<VerifiedSkillJobLink> = {}): VerifiedSkillJobLink {
  return { id: `badge-1:${jobId}`, badgeId: "badge-1", jobId, skillIds: ["sqlite"], sourceHash: jobDigest,
    longitude: 121.5, latitude: 31.2, strength: .5, meaning: "explicit_skill_evidence_overlap_not_hiring_probability", ...overrides };
}
function input(overrides: Partial<SkillConstellationInput> = {}): SkillConstellationInput {
  return { binding, badge: { id: "badge-1", label: "合成并发实践", verificationReceiptId: "receipt-1", sourceHash: digest, skillIds: ["sqlite", "typescript"] },
    links: [link()], excludedJobs: 4, jobMetadata: [{ jobId: "job-1", label: "合成平台工程岗位", company: "合成公司", officeLabel: "来源办公坐标" }], ...overrides };
}

test("only valid receipt-bound skill intersections reach the scene, with independent source hashes and original coordinates", () => {
  const original = input(), model = prepareSkillConstellation(original);
  assert.equal(model.status, "ready"); assert.equal(model.entries.length, 1); assert.equal(model.entries[0]!.longitude, 121.5);
  assert.equal(model.entries[0]!.latitude, 31.2); assert.equal(model.entries[0]!.label, "合成平台工程岗位"); assert.equal(model.entries[0]!.sourceHash, jobDigest);
  assert.equal(model.badge.sourceHash, digest); assert.equal(model.excludedJobs, 4); assert.ok(model.limitations.some(value => value.includes("不是录用概率")));
  assert.equal(model.virtualNode.kind, "virtual"); assert.ok(Math.hypot(...model.virtualNode.position) > 1);
  original.links[0]!.skillIds = ["mutated"]; original.binding.revision = "mutated";
  assert.deepEqual(model.entries[0]!.skillIds, ["sqlite"]); assert.equal(model.binding.revision, "snapshot-1");
  binding.revision = "snapshot-1";
});

test("metadata cannot supply office coordinates and missing coordinates are not replaced by a city or a default point", () => {
  const raw = input({ links: [link("missing", { longitude: Number.NaN }), link("city-text", { latitude: Number.POSITIVE_INFINITY })],
    jobMetadata: [{ jobId: "missing", label: "杭州岗位", officeLabel: "杭州" }, { jobId: "city-text", label: "城市中心" }] });
  const model = prepareSkillConstellation(raw); assert.equal(model.status, "empty"); assert.equal(model.entries.length, 0); assert.equal(model.rejectedLinks.length, 2);
});

test("wrong badge, malformed hashes, invented skills and probability claims are rejected instead of reinterpreted", () => {
  const bad = [link("wrong-badge", { badgeId: "other" }), link("bad-hash", { sourceHash: "hash" }), link("invented", { skillIds: ["rust"] }),
    link("empty-skills", { skillIds: [] }), link("range", { longitude: 180.1 }), link("negative", { strength: -.1 }), link("nan", { strength: Number.NaN }),
    link("claim", { meaning: "hiring_probability" as VerifiedSkillJobLink["meaning"] })];
  const model = prepareSkillConstellation(input({ links: bad })); assert.equal(model.entries.length, 0); assert.equal(model.rejectedLinks.length, bad.length);
});

test("conflicting snapshots or office positions for the same job remain unknown; exact duplicates are not extra opportunities", () => {
  const a = link("a"), b = link("b");
  const model = prepareSkillConstellation(input({ links: [a, { ...a }, b, { ...b, longitude: -122 }, link("b", { sourceHash: "c".repeat(64) })] }));
  assert.deepEqual(model.entries.map(entry => entry.jobId), ["a"]); assert.equal(model.rejectedLinks.length, 4);
  assert.ok(model.rejectedLinks.some(item => item.reason.includes("去重"))); assert.ok(model.rejectedLinks.some(item => item.reason.includes("冲突")));
});

test("scene inputs are explicitly bounded, not silently truncated into a supposedly complete cohort", () => {
  const tooMany = Array.from({ length: SKILL_CONSTELLATION_LIMITS.links + 1 }, (_, index) => link(`j-${index}`));
  const model = prepareSkillConstellation(input({ links: tooMany })); assert.equal(model.status, "invalid"); assert.equal(model.entries.length, 0); assert.match(model.detail!, /不会静默截断/);
  assert.equal(prepareSkillConstellation(input({ badge: { ...input().badge, sourceHash: "unknown" } })).status, "invalid");
  assert.equal(prepareSkillConstellation(input({ binding: { ...binding, sessionGeneration: -1 } })).status, "invalid");
  assert.equal(prepareSkillConstellation(input({ excludedJobs: Number.NaN })).excludedJobs, null);
});

test("payload identity includes authority, receipt, coordinates and job snapshots, but is not a permission credential", () => {
  const model = prepareSkillConstellation(input()), key = skillConstellationFingerprint(model);
  assert.notEqual(key, skillConstellationFingerprint(prepareSkillConstellation(input({ links: [link("job-1", { longitude: 0 })] }))));
  assert.notEqual(key, skillConstellationFingerprint(prepareSkillConstellation(input({ binding: { ...binding, sessionGeneration: 3 } }))));
  assert.equal(sameSkillConstellationBinding(binding, { ...binding }), true); assert.equal(sameSkillConstellationBinding(binding, { ...binding, ownerId: "other" }), false);
});

test("virtual node placement uses geocentric vectors across the antimeridian, not a false office longitude average", () => {
  const model = prepareSkillConstellation(input({ links: [link("east", { longitude: 179, latitude: 0 }), link("west", { longitude: -179, latitude: 0 })] }));
  assert.ok(model.virtualNode.position[0] < -1); assert.ok(Math.abs(model.virtualNode.position[1]) < 1e-8);
  assert.equal("longitude" in model.virtualNode, false); assert.equal(model.virtualNode.meaning, "evidence_node_not_a_geographic_location");
  const antipodal = prepareSkillConstellation(input({ links: [link("one", { longitude: 0, latitude: 0 }), link("opposite", { longitude: 180, latitude: 0 })] }));
  assert.deepEqual(antipodal.virtualNode.position, [0, 0, 1.65]);
});

test("bounded arcs are presentation geometry above the globe, ending at the exact original direction including poles and antipodes", () => {
  const origin = { kind: "virtual" as const, position: [1.65, 0, 0] as const, meaning: "evidence_node_not_a_geographic_location" as const };
  for (const [longitude, latitude] of [[180, 0], [0, 0], [0, 90], [-179, -50]]) {
    const arc = constellationArc({ longitude: longitude!, latitude: latitude! }, origin);
    assert.equal(arc.length, 33); assert.deepEqual(arc[0], origin.position);
    assert.deepEqual(arc.at(-1), constellationUnitVector(longitude!, latitude!));
    assert.ok(arc.every(point => point.every(Number.isFinite) && Math.hypot(...point) >= 1 - 1e-10));
  }
  assert.throws(() => constellationArc({ longitude: 0, latitude: 0 }, origin, 1000));
  assert.throws(() => constellationArc({ longitude: 0, latitude: 91 }, origin));
});
