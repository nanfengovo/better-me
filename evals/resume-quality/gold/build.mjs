import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resumes, jobs, permissionFiles } from "./sources.mjs";
import { recipes, labelVersion } from "./labels.mjs";
import { digest, extractResume, piiFindings, jobLinkFindings, sourceSpan } from "./extract.mjs";
import { goldModelMaterial } from "./material.mjs";
import { validateResumeQualityCase, ResumeQualityRunSchema } from "../../../packages/core/src/career-intelligence/resume-quality.ts";
import { FactBaseSchema } from "../../../packages/core/src/schema/fact.ts";
import { ResumeViewSchema } from "../../../packages/core/src/schema/resume.ts";

const retrievedAt = "2026-11-12T00:00:00.000Z";
const anonymization = "Deterministic pseudonymization v1: omit contact/identity metadata; replace employer/client/school/product names; retain all selected professional units and qualifiers. Source attribution is separate. Public source links allow re-identification; not irreversible anonymity.";
const provenance = source => ({ url: source.url, revision: source.revision, license: source.license, licenseUrl: source.licenseUrl,
  retrievedAt, originalSha256: source.originalSha256, anonymization });
async function regular(file) {
  if (!(await fs.lstat(file)).isFile() || await fs.realpath(file) !== file) throw Error("Source must be an explicit regular file, not a symlink.");
  return fs.readFile(file);
}
const entityLexicon = ["Chef", "Ansible", "Terraform", "Kubernetes", "Ruby", "Ruby on Rails", "Go", "Golang", "Redis", "Kafka", "React", "React Native", "Vue.js", "JavaScript", "GitLab", "Snowflake", "Airflow", "SQL", "Docker", "Django", "C#", ".NET"];
function selectedJob(raw, recipe) {
  const start = raw.indexOf(recipe.start), end = raw.indexOf(recipe.end, start + recipe.start.length);
  if (start < 0 || end <= start) throw Error("missing_role_scope");
  let text = ""; const mappings = [];
  const selected = raw.slice(start, end);
  for (const match of selected.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    if (recipe.exclude?.some(term => match[0].includes(term))) continue;
    const derivedStart = text.length; text += match[0];
    mappings.push({ derivedStart, derivedEnd: text.length, original: sourceSpan(raw, start + match.index, start + match.index + match[0].length) });
  }
  return { text, mappings };
}
function requirementLabels(job, recipe, units) {
  const used = new Set(), annotations = [];
  const requirements = [...job.matchAll(/^- ([^\n]+(?:\n  [^\n]+)*)/gm)].map((m, index) => {
    const quote = m[1], ruleIndex = recipe.rules.findIndex(rule => quote.startsWith(rule[0]));
    const rule = recipe.rules[ruleIndex]; if (rule) used.add(ruleIndex);
    const [, anchorGroups, evidenceIds, weight, reason, status] = rule ?? [null, [[quote]], [], 1,
      "No direct complete support in the selected professional source. This means not evidenced, not proof the person lacks the ability."];
    if (evidenceIds.some(id => !units.some(u => u.id === id))) throw Error(`unknown_label_evidence:${recipe.id}`);
    const id = `requirement-${String(index + 1).padStart(2, "0")}`;
    const support = status ?? (evidenceIds.length ? "supported" : "not_evidenced");
    annotations.push({ id, support, reason, sourceReview: "Codex reviewed against fixed source; no external human adjudication claimed" });
    return { id, original: { start: m.index + 2, end: m.index + 2 + quote.length, quote }, weight, support, anchorGroups, evidenceIds };
  });
  if (used.size !== recipe.rules.length) throw Error(`unused_label_rule:${recipe.id}:${recipe.rules.filter((_, i) => !used.has(i)).map(r => r[0]).join(",")}`);
  return { requirements, annotations };
}
// Baselines only use dates that the source supplies to month precision. Ambiguous/year-only
// records stay in Gold evidence and are not silently repaired to January or invented epochs.
const baselineSelections = {
  "gold-sre": [
    { id: "work-0", org: "Employer A", title: "System / DevOps Engineer", start: "2025-06", end: null, claims: ["work-0-action-2", "work-0-action-4", "work-0-action-7"] },
    { id: "work-1", org: "Employer B", title: "System / SRE / DevOps Engineering", start: "2023-11", end: "2024-12", claims: ["work-1-action-1", "work-1-action-3"] },
    { id: "work-2", org: "Employer C", title: "SRE / DevOps / Cloud Engineering", start: "2021-11", end: "2023-04", claims: ["work-2-action-2"] },
  ],
  "gold-fullstack": [{ id: "freelance", org: "Self-employed", title: "Web Developer & Designer", start: "2017-01", end: null,
    claims: ["freelance-action-4", "freelance-action-10", "freelance-action-11", "freelance-action-16", "freelance-action-18", "freelance-action-19"] }],
  "gold-data-engineer": [
    { id: "internship-data", org: "Employer R", title: "Data Engineer internship", start: "2018-04", end: "2018-08", claims: ["item-19", "item-20", "item-21"] },
    { id: "internship-web", org: "Employer S", title: "Web Developer internship", start: "2013-07", end: "2013-09", claims: ["item-22", "item-23"] },
  ],
};
async function baseline(test) {
  const selected = baselineSelections[test.id]; if (!selected) return null;
  const factBase = FactBaseSchema.parse({ schemaVersion: 1, updatedAt: retrievedAt,
    profile: { displayName: { zh: test.id.replace("gold-", "Candidate - "), en: test.id.replace("gold-", "Candidate - ") } },
    experiences: selected.map(group => ({ id: group.id, type: "work", org: { zh: group.org }, title: { zh: group.title }, start: group.start, end: group.end,
      claims: group.claims.map(id => ({ id, kind: "action", text: { zh: test.evidence.find(e => e.id === id).text } })) })) });
  const view = ResumeViewSchema.parse({ id: `${test.id}-extractive`, name: "Deterministic extractive baseline; not a model", locale: "en", templateId: "zh-classic", updatedAt: retrievedAt,
    layout: { pageMargin: 16, bodyFontSize: 10, lineHeight: 1.6 } });
  return ResumeQualityRunSchema.parse({ schemaVersion: 1, caseId: test.id, caseSha256: digest(JSON.stringify(test)),
    origin: { kind: "extractive_baseline", label: "Deterministic full-unit extraction with source-month dates; not a model or human-authored resume" },
    model: { provider: "none", id: "source-extraction", revision: labelVersion, runtimeId: "offline-no-runtime" }, protocolVersion: labelVersion,
    budget: { maxModelCalls: 0, maxToolCalls: 0, maxActiveMs: 0 }, observed: { modelCalls: 0, toolCalls: 0, activeMs: 0 }, factBase, view, locale: "en",
    citations: selected.flatMap(g => g.claims).map(id => { const e = test.evidence.find(e => e.id === id); return { claimId: id, evidenceId: id, sourceSha256: e.sha256, original: { start: 0, end: e.text.length, quote: e.text } }; }) });
}
/** Generate licensed derived data only. Explicit verified raw source directory; new output only. */
export async function buildGold({ sourceDirectory, outputDirectory }) {
  sourceDirectory = await fs.realpath(sourceDirectory);
  const rawSources = new Map(), permissions = new Map();
  for (const source of [...resumes, ...jobs]) {
    const bytes = await regular(path.join(sourceDirectory, source.file));
    if (digest(bytes) !== source.originalSha256) throw Error(`original_hash_changed:${source.id}`);
    rawSources.set(source.id, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  }
  for (const [name, hash] of Object.entries(permissionFiles)) {
    const bytes = await regular(path.join(sourceDirectory, name));
    if (digest(bytes) !== hash) throw Error(`permission_hash_changed:${name}`);
    permissions.set(name, bytes);
  }
  const prepared = [];
  for (let i = 0; i < resumes.length; i++) {
    const source = resumes[i], jd = jobs[i], recipe = recipes[i], extracted = extractResume(source, rawSources.get(source.id));
    const job = selectedJob(rawSources.get(jd.id), recipe);
    const { requirements, annotations } = requirementLabels(job.text, recipe, extracted.units);
    const test = await validateResumeQualityCase({ schemaVersion: 1, id: recipe.id, dataKind: "real_anonymized", role: recipe.role,
      job: { text: job.text, sha256: digest(job.text), provenance: provenance(jd) },
      evidence: extracted.units.map(unit => ({ id: unit.id, text: unit.text, sha256: digest(unit.text), provenance: provenance(source),
        star: recipe.star[unit.id] ?? { situation: [], task: [], action: [], result: [] } })),
      requirements, entityLexicon, approvedParaphrases: [] });
    for (const id of Object.keys(recipe.star)) if (!extracted.units.some(u => u.id === id)) throw Error(`unused_star_annotation:${id}`);
    const text = extracted.units.map(unit => `[${unit.id}; ${unit.kind}; self_reported]\n${unit.text}`).join("\n\n");
    const promptData = JSON.stringify({ role: test.role, groups: extracted.groups, evidenceText: text });
    if (piiFindings(promptData).length) throw Error(`model_material_pii:${recipe.id}`);
    if (jobLinkFindings(test.job.text).length) throw Error(`job_link_or_pii:${recipe.id}`);
    await goldModelMaterial(test, extracted.groups);
    let cursor = 0;
    const units = extracted.map.map((entry, n) => {
      const unit = extracted.units[n], marker = `[${unit.id}; ${unit.kind}; self_reported]\n`;
      const start = cursor + marker.length, end = start + unit.text.length; cursor = end + 2;
      return { ...entry, derivedStart: start, derivedEnd: end, derivedStartLine: text.slice(0, start).split("\n").length,
        contextOriginals: extracted.groups.find(g => g.id === unit.group)?.originals ?? [],
        group: unit.group, kind: unit.kind, verification: "self_reported", starLabelState: recipe.star[unit.id] ? "source_reviewed" : "not_adjudicated_no_credit" };
    });
    prepared.push({ test, text, groups: extracted.groups, units, jobMap: job.mappings, annotations, baseline: await baseline(test), source, jd });
  }
  await fs.mkdir(outputDirectory, { mode: 0o700 });
  for (const name of ["cases", "materials", "mappings", "baselines", "licenses"]) await fs.mkdir(path.join(outputDirectory, name));
  const files = [];
  async function write(relative, content) {
    const bytes = typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2) + "\n";
    await fs.writeFile(path.join(outputDirectory, relative), bytes, { flag: "wx", mode: 0o600 });
    files.push({ path: relative, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) });
  }
  for (const p of prepared) {
    const id = p.test.id;
    await write(`cases/${id}.case.json`, p.test);
    await write(`materials/${id}.candidate.txt`, p.text);
    await write(`materials/${id}.groups.json`, p.groups);
    await write(`mappings/${id}.source-map.json`, { schemaVersion: 1, labelVersion, caseSha256: digest(JSON.stringify(p.test)),
      source: p.source, jobSource: p.jd, candidateTextSha256: digest(p.text), coordinateSystem: "UTF-16 code units, zero-based half-open; lines one-based; hashes UTF-8 bytes",
      mappingGranularity: "Selected complete source tokens/markup units; derived strings are transformed. Never equate derived offsets with original offsets.",
      units: p.units, selectedJob: p.jobMap, requirements: p.annotations,
      dates: p.groups.map(g => ({ group: g.id, originalPeriod: g.dates, policy: "Source text retained; year-only/ambiguous chronology not repaired for baseline." })) });
    if (p.baseline) await write(`baselines/${id}.run.json`, p.baseline);
  }
  for (let i = 1; i <= 4; i++) await write(`licenses/C0${i}-MIT.txt`, permissions.get(`C0${i}-LICENSE.txt`));
  const notice = `# Third-party content notices\n\nSource-selected and deterministically pseudonymized on 2026-11-12. Public attribution permits re-identification; this is not irreversible anonymity. All statements remain author self-report. The JD/CV pairing is a benchmark construction, not an application or hiring outcome. No photos, logos, third-party images or source code are used.\n\n${[...resumes, ...jobs].map(s => `## ${s.id}\n\nAuthor: ${s.author}\n\nSource: ${s.url}\n\nRevision: ${s.revision}; full original SHA-256: ${s.originalSha256}\n\nText license: ${s.license} (${s.licenseUrl}). ${s.license === "MIT" ? `Original copyright and permission notice: licenses/${s.id.toUpperCase()}-MIT.txt.` : "Attribution retained here; no endorsement by the original author."}\n\nModifications: selected professional/role-level text; decoded markup; whitespace normalized; contact/identity metadata omitted and identifying employer/client/school/product names replaced. GitLab JD-derived text and adaptations remain CC-BY-SA-4.0; resume-derived text retains its own listed license. Collection tooling does not relicense these texts.\n`).join("\n")}\n`;
  await write("NOTICES.md", notice);
  const manifest = { schemaVersion: 1, datasetVersion: labelVersion, createdFromRetrievedAt: retrievedAt, realPairs: prepared.length,
    independentAuthors: resumes.length, roles: prepared.map(p => p.test.role), modelCalls: 0,
    labeling: "Source-reviewed by Codex independently of candidate generation; external human adjudication not claimed. Unadjudicated STAR units receive no credit.",
    scope: "GitLab common job-family definitions; selected level only, not current vacancies. Five distinct public self-reported resume bases, not independently verified personal facts.",
    limitations: ["Employer/language/region bias: all JDs from one employer, English-language sources.", "No claim of cloud-architect seniority or C# industrial-software representativeness.",
      "Historical Rails is partial professional support, not absent; mobile latency is not Web performance; fictional projects are not commercial delivery.",
      "Year-only/ambiguous dates prevent two baselines under current month-required FactBase; no January/epoch dates invented.",
      "Full-unit extractive baselines test source preservation and layout, not generated resume quality or model ranking."],
    cases: prepared.map(p => ({ id: p.test.id, canonicalSha256: digest(JSON.stringify(p.test)), evidenceUnits: p.test.evidence.length, requirements: p.test.requirements.length,
      supported: p.test.requirements.filter(r => r.support === "supported").length, partial: p.test.requirements.filter(r => r.support === "partial").length,
      notEvidenced: p.test.requirements.filter(r => r.support === "not_evidenced").length, baseline: !!p.baseline })),
    files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  await fs.writeFile(path.join(outputDirectory, "dataset-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--sources" || args[2] !== "--out") throw Error("Usage: node --import tsx gold/build.mjs --sources /explicit/raw-snapshots --out /new/dataset");
  const manifest = await buildGold({ sourceDirectory: path.resolve(args[1]), outputDirectory: path.resolve(args[3]) });
  console.log(JSON.stringify({ realPairs: manifest.realPairs, cases: manifest.cases, files: manifest.files.length, modelCalls: 0 }));
}
