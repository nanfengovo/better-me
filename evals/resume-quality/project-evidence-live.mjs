import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { careerRuntimeBinding } from "../../packages/agent-contracts/src/index.ts";
import { createAgentServer } from "../../apps/agent-host/src/server.ts";
import { registerTestIdentity } from "../../apps/agent-host/tests/fixtures/identity.ts";
import { MemorySaver } from "../../apps/agent-host/tests/fixtures/checkpointer.ts";
import { localCatalog, localOllamaOrigin } from "./ollama-context.mjs";
import { observedRuntime, summarizeProviderObservations } from "./runtime-quality.mjs";

const materialText = source => "历史项目记录\n" + source.text;
const digest = value => createHash("sha256").update(value).digest("hex");
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const cases = { warehouse:"warehouse-replay-v1.json", interface:"interface-scope-holdout-v2.json", inventory:"inventory-verify-holdout-v2.json" };

/** A reference must reopen on the synthetic input file at the recorded coordinates. */
export function gradeProjectEvidence(gold, task) {
  const files = new Map(gold.sources.map(s => [s.id + ".md", materialText(s)]));
  const grants = new Set(task.project.grants.filter(g => !g.revokedAt).map(g => g.id));
  const evidence = new Map();
  for (const item of task.project.evidence) {
    const file = files.get(item.path);
    if (file === undefined || !grants.has(item.grantId) || digest(file) !== item.hash) continue;
    const { startOffset: start, endOffset: end } = item;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > file.length) continue;
    const startLine=file.slice(0,start).split("\n").length, endLine=file.slice(0,end).split("\n").length;
    if (file.slice(start, end) === item.excerpt && item.startLine===startLine && item.endLine===endLine) evidence.set(item.id, item);
  }
  const claims = task.project.understanding?.claims ?? [];
  function cites(claim, wanted) {
    return claim.evidenceIds.some(id => {
      const span = evidence.get(id);
      return span?.path === wanted.sourceId + ".md" && span.excerpt.includes(wanted.quote);
    });
  }
  function quotes(claim, fact) {
    const text = claim.text.trim().replace(/^(?:材料记录|文档记录|材料原句|原文)[：:]\s*/, "");
    return [fact.quote, "“" + fact.quote + "”", "「" + fact.quote + "」"].includes(text) && cites(claim, fact);
  }
  const facts = gold.expectedFacts.map(f => ({ sourceId: f.sourceId, supported: claims.some(c =>
    c.kind === "documentation" && quotes(c, f)) }));
  const expectedInference = gold.expectedInference ?? {basisSourceId:"warehouse-dedup",termGroups:[["重复"],["减少","避免","防止","降低","防重","抑制"]]};
  const expectedUnknown = gold.expectedUnknown ?? {terms:["上线","收益","生产"]};
  const premise = gold.expectedFacts.find(f => f.sourceId === expectedInference.basisSourceId);
  const inference = claims.some(c => c.kind === "inference" && !/[?？]\s*$/.test(c.text)
    && expectedInference.termGroups.every(terms=>terms.some(term=>c.text.includes(term))) && premise && cites(c, premise));
  const benefitUnknown = claims.some(c => c.kind === "unknown" && expectedUnknown.terms.some(term=>c.text.includes(term))
    && /未知|无法|不能|不明|尚无|缺少|缺乏|不足|没有|未.{0,7}(提供|证实|验证|确认|记录|说明|衡量|知晓)/.test(c.text));
  const actualFacts = claims.filter(c => !["unknown", "inference"].includes(c.kind));
  const onlyRequestedFacts = actualFacts.length === facts.length && actualFacts.every(c => c.kind === "documentation"
    && gold.expectedFacts.some(f => quotes(c, f)));
  const passed = ["awaiting_review","completed"].includes(task.status) && facts.every(f => f.supported)
    && onlyRequestedFacts && inference && benefitUnknown;
  return { passed, facts, onlyRequestedFacts, inference, benefitUnknown };
}

export async function runLiveProject({ model, endpoint, out, case:caseName="warehouse" }) {
  if (!model || !out) throw Error("required arguments: --model EXACT_LOCAL_MODEL --out NEW_DIRECTORY");
  if(!Object.hasOwn(cases,caseName))throw Error("unknown_project_case");
  endpoint = localOllamaOrigin(endpoint);
  const { entry } = await localCatalog(model, endpoint);
  const rawGold = await readFile(new URL("./gold/"+cases[caseName], import.meta.url), "utf8");
  const gold = JSON.parse(rawGold);
  const question = gold.query + " 资料在这次授权的目录内，文件为 " + gold.sources.map(s => s.id + ".md").join("、")
    + "。请先用工具阅读相关文件。按每项材料的原句逐字引用，再单列推断和未知；每个有依据的结论请带相应的记录引用。";
  const runtime = { kind: "model", modelSettings: { model, provider: "ollama", baseUrl: endpoint + "/v1", temperature: 0 } };
  const runtimeBinding = careerRuntimeBinding(runtime);
  const budget = { maxModelCalls: 6, maxToolCalls: 38, maxActiveMs: 300_000 };
  const files = ["evals/resume-quality/project-evidence-live.mjs", "apps/agent-host/src/kernel/project-quote-review.ts",
    "apps/agent-host/src/kernel/project-understanding.ts", "apps/agent-host/src/kernel/service.ts",
    "apps/agent-host/src/kernel/model-protocol.ts", "apps/agent-host/src/tasks/runtime.ts", "evals/resume-quality/runtime-quality.mjs"];
  const sources = Object.fromEntries(await Promise.all(files.map(async file =>
    [file, digest(await readFile(new URL("../../" + file, import.meta.url)))])));
  await mkdir(out, { mode: 0o700 });
  await save(path.join(out, "plan.json"), { protocol: "live-project-evidence-v2", caseId: gold.id, goldSha256: digest(rawGold),
    model, revision: entry.digest, endpoint, question, budget, sources });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "betterme-live-project-"));
  let server;
  try {
    const identityDirectory = path.join(tmp, "identities"), materialDirectory = path.join(tmp, "notes"), token = randomUUID();
    await mkdir(materialDirectory);
    for (const source of gold.sources) await writeFile(path.join(materialDirectory, source.id + ".md"), materialText(source));
    server = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [], runtimeDefinitions: [],
      identityDirectory, runsDirectory: path.join(tmp,"runs"), understandingDirectory: path.join(tmp,"understanding"), checkpointer: new MemorySaver() });
    await once(server, "listening");
    const origin = "http://127.0.0.1:" + server.address().port;
    const identity = await registerTestIdentity(origin, token, "synthetic-project-reader");
    const signal = AbortSignal.timeout(budget.maxActiveMs + 30_000);
    async function call(suffix, body) {
      const response = await fetch(origin + "/api/v1/agent/tasks" + suffix, { signal, redirect: "error",
        method: body ? "POST" : "GET", headers: { ...identity.headers, Authorization: "Bearer " + token, "Content-Type": "application/json" },
        ...(body ? {body: JSON.stringify(body)} : {}) });
      if (!response.ok) throw Error("project_host_http_" + response.status);
      return (await response.json()).task;
    }
    const originalCase=caseName==="warehouse";
    let task = await call("", { kind: "project_understanding", workspaceKey: originalCase?"warehouse-synthetic":gold.id, objective: gold.query,
      project: originalCase?{projectKey:"warehouse",label:"仓储联调历史材料",sourceText:"请核对仓储项目留下的历史联调材料，整理可以写入项目理解的依据。"}:
        { projectKey: gold.id, label: "合成历史项目材料", sourceText: "请核对历史项目材料，整理可以写入项目理解的依据。" },
      budget, runtimeBinding, consent: true, idempotencyKey: originalCase?"warehouse-project":gold.id+"-project" });
    const route = "/" + task.id;
    task = await call(route + "/project/grants", { expectedRevision: task.revision, path: materialDirectory });
    task = await call(route + "/start", { expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding, runtime, consent: true,
      projectTurn: { expectedRevision: task.revision, idempotencyKey: "warehouse-question", answer: question, selectedOptionIds: [], consentToSend: true } });
    while (task.status === "running") {
      await delay(350, undefined, { signal });
      task = await call(route);
    }
    const state = JSON.parse(await readFile(path.join(identityDirectory, "owners", identity.principal.id, "career-tasks-v1", task.id + ".json"), "utf8"));
    const { entry: after } = await localCatalog(model, endpoint);
    const grade = gradeProjectEvidence(gold, task);
    const observed=observedRuntime(task,[{task,recent:state.recent}],"model");
    const telemetry={tools:{succeeded:observed.succeeded,failed:observed.failed,charged:observed.toolCalls,
      coverageComplete:observed.succeeded+observed.failed===observed.toolCalls},provider:summarizeProviderObservations(observed.providerObservations,observed.modelCalls)};
    const result = { model, revision: entry.digest, endRevision: after.digest, caseId: gold.id, taskId: task.id, status: task.status,
      error: task.error ?? null, usage: task.usage, grade, telemetry, passed: grade.passed && after.digest === entry.digest && telemetry.tools.coverageComplete
        && telemetry.tools.failed===0 && telemetry.provider.tokenCoverage.numerator===observed.modelCalls,
      events: task.events, output: task.project.understanding ?? null, partialOutput: task.partialOutput ?? null,
      citations: task.project.evidence, trace: state.recent };
    await save(path.join(out, "result.json"), result);
    return result;
  } finally {
    try { if (server?.listening) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
    finally { await rm(tmp, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {model:{type:"string"}, endpoint:{type:"string"}, out:{type:"string"},case:{type:"string"}} });
  const result = await runLiveProject(values);
  console.log(JSON.stringify({ model:result.model, status:result.status, usage:result.usage, grade:result.grade, telemetry:result.telemetry, passed:result.passed }, null, 2));
  if (!result.passed) process.exitCode = 1;
}
