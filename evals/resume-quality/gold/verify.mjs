import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resumes, jobs, permissionFiles } from "./sources.mjs";
import { digest, piiFindings, jobLinkFindings, sourceSpan } from "./extract.mjs";
import { validateResumeQualityCase, ResumeQualityRunSchema } from "../../../packages/core/src/career-intelligence/resume-quality.ts";

const read = async file => {
  assert.ok((await fs.lstat(file)).isFile() && await fs.realpath(file) === file, "Regular files only, no symlinks.");
  return fs.readFile(file);
};
const json = async file => JSON.parse((await read(file)).toString("utf8"));
/**
 * @param {string} directory
 * @param {{ paths?: Pick<typeof path, "join">,
 *   readDirectory?: (directory: string) => Promise<string[]>,
 *   inspect?: (file: string) => Promise<Pick<import("node:fs").Stats, "isSymbolicLink" | "isDirectory" | "isFile">> }} [access]
 */
export async function goldFileList(directory, { paths = path, readDirectory = fs.readdir, inspect = fs.lstat } = {}) {
  const walk = async (relative = "") => {
    const files = [];
    for (const entry of (await readDirectory(paths.join(directory, relative))).sort()) {
      // Manifest keys are POSIX identifiers on every OS; only physical access
      // uses the native path implementation. Never rewrite the frozen manifest.
      const name = path.posix.join(relative, entry), stat = await inspect(paths.join(directory, name));
      assert.ok(!stat.isSymbolicLink(), "Dataset links are rejected.");
      if (stat.isDirectory()) files.push(...await walk(name));
      else { assert.ok(stat.isFile(), "Dataset entries must be regular files."); files.push(name); }
    }
    return files;
  };
  return walk();
}
/** Offline derived-data integrity; optional full raw-snapshot coordinate verification. */
export async function verifyGold({ datasetDirectory, sourceDirectory }) {
  datasetDirectory = await fs.realpath(datasetDirectory);
  const manifest = await json(path.join(datasetDirectory, "dataset-manifest.json"));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.realPairs, 5); assert.equal(manifest.modelCalls, 0);
  const names = manifest.files.map(f => f.path);
  assert.equal(new Set(names).size, names.length, "Duplicate manifest path.");
  assert.deepEqual((await goldFileList(datasetDirectory)).filter(f => f !== "dataset-manifest.json").sort(), [...names].sort(), "Unlisted/missing dataset file.");
  for (const file of manifest.files) {
    assert.ok(!path.isAbsolute(file.path) && !file.path.split(/[\\/]/).some(p => p === ".."), "Unsafe manifest path.");
    const bytes = await read(path.join(datasetDirectory, file.path));
    assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.sha256, `Derived file hash changed: ${file.path}`);
  }
  const raw = new Map();
  if (sourceDirectory) {
    sourceDirectory = await fs.realpath(sourceDirectory);
    for (const source of [...resumes, ...jobs]) {
      const bytes = await read(path.join(sourceDirectory, source.file)); assert.equal(digest(bytes), source.originalSha256, `Original source changed: ${source.id}`);
      raw.set(source.id, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    }
    for (const [file, hash] of Object.entries(permissionFiles)) assert.equal(digest(await read(path.join(sourceDirectory, file))), hash, "Permission evidence changed.");
  }
  let evidenceUnits = 0, requirements = 0, originalSpans = 0, baselines = 0;
  const sourceHashes = new Set(), authorIds = new Set();
  for (let n = 0; n < manifest.cases.length; n++) {
    const entry = manifest.cases[n], test = await validateResumeQualityCase(await json(path.join(datasetDirectory, `cases/${entry.id}.case.json`)));
    const mapping = await json(path.join(datasetDirectory, `mappings/${entry.id}.source-map.json`));
    const material = (await read(path.join(datasetDirectory, `materials/${entry.id}.candidate.txt`))).toString("utf8");
    const groups = await json(path.join(datasetDirectory, `materials/${entry.id}.groups.json`));
    const source = resumes[n], job = jobs[n];
    assert.equal(test.dataKind, "real_anonymized"); assert.equal(test.id, entry.id);
    assert.equal(digest(JSON.stringify(test)), entry.canonicalSha256); assert.equal(mapping.caseSha256, entry.canonicalSha256);
    assert.deepEqual(mapping.source, source); assert.deepEqual(mapping.jobSource, job);
    assert.deepEqual(piiFindings(JSON.stringify({ material, groups })), []); assert.deepEqual(jobLinkFindings(test.job.text), []);
    assert.equal(mapping.candidateTextSha256, digest(material));
    assert.equal(mapping.units.length, test.evidence.length); assert.equal(test.evidence.length, entry.evidenceUnits);
    assert.equal(mapping.requirements.length, test.requirements.length); assert.equal(test.requirements.length, entry.requirements);
    assert.equal(new Set(mapping.units.map(u => u.id)).size, mapping.units.length);
    assert.deepEqual(test.job.provenance, { url: job.url, revision: job.revision, license: job.license, licenseUrl: job.licenseUrl,
      retrievedAt: manifest.createdFromRetrievedAt, originalSha256: job.originalSha256, anonymization: test.job.provenance.anonymization });
    for (const unit of mapping.units) {
      const e = test.evidence.find(e => e.id === unit.id); assert.ok(e);
      assert.equal(material.slice(unit.derivedStart, unit.derivedEnd), e.text);
      assert.equal(unit.derivedStartLine, material.slice(0, unit.derivedStart).split("\n").length);
      assert.equal(unit.derivedSha256, e.sha256); assert.equal(unit.verification, "self_reported");
      assert.equal(e.provenance.originalSha256, source.originalSha256); assert.equal(e.provenance.url, source.url);
      assert.equal(e.provenance.license, source.license); assert.ok(unit.originals.length);
      for (const span of [...unit.originals, ...unit.contextOriginals]) {
        assert.ok(span.start >= 0 && span.end > span.start && span.startLine >= 1 && span.endLine >= span.startLine);
        if (raw.size) assert.deepEqual(sourceSpan(raw.get(source.id), span.start, span.end), span, "Original coordinate/line/hash mismatch.");
        originalSpans++;
      }
      if (unit.kind === "fictional_practice") assert.ok(e.text.includes("fictional"), "Keep the fictional-company qualifier.");
    }
    let cursor = 0;
    for (const part of mapping.selectedJob) {
      assert.equal(part.derivedStart, cursor); assert.ok(part.derivedEnd > cursor);
      const derived = test.job.text.slice(part.derivedStart, part.derivedEnd);
      assert.equal(digest(derived), part.original.sha256);
      if (raw.size) assert.deepEqual(sourceSpan(raw.get(job.id), part.original.start, part.original.end), part.original);
      cursor = part.derivedEnd; originalSpans++;
    }
    assert.equal(cursor, test.job.text.length);
    for (const requirement of test.requirements) {
      assert.equal(mapping.requirements.find(r => r.id === requirement.id)?.support, requirement.support);
      if (requirement.support === "not_evidenced") assert.deepEqual(requirement.evidenceIds, []);
      else assert.ok(requirement.evidenceIds.length > 0);
      assert.ok(requirement.evidenceIds.every(id => mapping.units.find(u => u.id === id)?.kind !== "fictional_practice"), "Practice project is not professional evidence.");
    }
    assert.equal(entry.supported, test.requirements.filter(r => r.support === "supported").length);
    assert.equal(entry.partial, test.requirements.filter(r => r.support === "partial").length);
    assert.equal(entry.notEvidenced, test.requirements.filter(r => r.support === "not_evidenced").length);
    if (entry.baseline) {
      const run = ResumeQualityRunSchema.parse(await json(path.join(datasetDirectory, `baselines/${test.id}.run.json`)));
      assert.equal(run.origin.kind, "extractive_baseline"); assert.equal(run.caseSha256, entry.canonicalSha256);
      assert.equal(run.observed.modelCalls, 0); assert.equal(run.budget.maxModelCalls, 0); baselines++;
    }
    sourceHashes.add(source.originalSha256); authorIds.add(source.id); evidenceUnits += test.evidence.length; requirements += test.requirements.length;
  }
  assert.equal(sourceHashes.size, 5); assert.equal(authorIds.size, 5);
  return { realPairs: manifest.cases.length, evidenceUnits, requirements, baselines, originalSpans,
    fullOriginalVerification: raw.size === 10, modelCalls: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (![2, 4].includes(args.length) || args[0] !== "--dataset" || (args.length === 4 && args[2] !== "--sources")) throw Error("Usage: node --import tsx gold/verify.mjs --dataset /dataset [--sources /raw-snapshots]");
  console.log(JSON.stringify(await verifyGold({ datasetDirectory: path.resolve(args[1]), sourceDirectory: args[3] && path.resolve(args[3]) })));
}
