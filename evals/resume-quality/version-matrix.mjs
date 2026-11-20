import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { localCatalog, localOllamaOrigin } from "./ollama-context.mjs";
import { comparisonModelIdentity } from "./comparison.mjs";
import { readRegular } from "./freeze.mjs";
import { digest } from "./gold/extract.mjs";
import { contrasts, fixtureSchema, generationOptions, grade, makeTurn, profileSchema, sha, summarize } from "./version-matrix/experiment.mjs";

const json = v => JSON.stringify(v, null, 2) + "\n";
const read = async file => JSON.parse(await readRegular(file));
const here = fileURLToPath(new URL(".", import.meta.url));
const repository = path.resolve(here, "../..");
const sourcePaths = ["apps/agent-host/src/kernel/evidence-retrieval.ts", "apps/agent-host/src/kernel/evidence-vectors.ts",
  "evals/resume-quality/version-matrix.mjs",
  "evals/resume-quality/version-matrix/experiment.mjs", "evals/resume-quality/runtime-quality.mjs"];
async function write(file, value) {
  const stage = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(stage, json(value), { flag: "wx", mode: 0o600 });
  await fs.rename(stage, file);
}
function select(items, ids) {
  const selected = ids?.length ? ids.map(id => items.find(item => item.id === id)) : items;
  if (selected.some(s => !s) || new Set(selected.map(s => s.id)).size !== selected.length) throw Error("invalid_or_duplicate_matrix_selection");
  return selected;
}
function verifiedModel(catalog) {
  const { name:id, digest:revision } = catalog.entry;
  const identity = comparisonModelIdentity({provider:"ollama",id,revision}, catalog);
  if (!identity.key || catalog.entry.remote_host || catalog.entry.remote_model || catalog.show.remote_model
      || catalog.show.remote_host || !/^[a-f0-9]{64}$/.test(revision)) throw Error("local_model_weight_identity_required");
  return {id, revision, key:identity.key};
}
function cellsFor(plan) {
  const cells=[];
  for (const catalog of plan.catalogs) for (const prompt of plan.prompts) for (const agent of plan.agents) {
    const model=verifiedModel(catalog);
    cells.push({cell:"cell-"+String(cells.length+1).padStart(3,"0"), model:model.id, revision:model.revision,
      modelKey:model.key, prompt:prompt.id, agent:agent.id, taskId:plan.fixture.id, taskInputSha256:sha([plan.fixture.query,plan.fixture.sources]),
      promptSha256:sha(prompt), agentSha256:sha([agent,plan.sourceHashes["apps/agent-host/src/kernel/evidence-retrieval.ts"],
        agent.id === "hybrid-tfidf-v2" ? plan.sourceHashes["apps/agent-host/src/kernel/evidence-vectors.ts"] : null,
        plan.sourceHashes["evals/resume-quality/version-matrix/experiment.mjs"]])});
  }
  return cells;
}
async function observation(request, endpoint) {
  const start=performance.now();
  let body=null, error=null;
  try {
    const response=await fetch(endpoint+"/api/chat", { method:"POST", redirect:"error", signal:AbortSignal.timeout(120000),
      headers:{"Content-Type":"application/json"},body:JSON.stringify(request)});
    if (!response.ok) error="http_"+response.status;
    else {
      body=await response.json();
      if (body?.model!==request.model) error="response_model_mismatch";
    }
  } catch (e) { error=e.name==="TimeoutError" ? "timeout" : "response_unavailable"; }
  return {body,error,wallMs:Math.round(performance.now()-start)};
}
async function optional(file) {
  try { return await read(file); }
  catch(e) { if (e.code==="ENOENT") return null; throw e; }
}
function requireBinding(condition) {
  if (!condition) throw Error("matrix_archive_binding_changed");
}
function checkTurn(plan, spec, turn) {
  const prompt=plan.prompts.find(p => p.id===spec.prompt), agent=plan.agents.find(a=>a.id===spec.agent);
  const available = plan.fixture.sources;
  requireBinding(Array.isArray(turn.selected) && turn.selected.length <= agent.topK
    && new Set(turn.selected.map(s=>s.id)).size===turn.selected.length
    && turn.selected.every(s => available.some(a=>a.id===s.id && a.text===s.text)));
  const req=turn.request;
  requireBinding(req.model===spec.model && req.stream===false && req.think===false && sha(req.options)===sha(plan.options)
    && sha(req.format)===plan.formatSha256 && sha(req.messages)===sha([{role:"system",content:prompt.system},
    {role:"user",content:JSON.stringify({question:plan.fixture.query,sources:turn.selected})}]));
}
export async function replayMatrix(directory) {
  directory=await fs.realpath(directory);
  const plan=await read(path.join(directory,"plan.json")), planSha256=sha(plan);
  requireBinding(plan.protocol==="warehouse-evidence-matrix-v1" && await read(path.join(directory,"plan.sha256.json"))===planSha256);
  fixtureSchema.parse(plan.fixture);
  profileSchema.parse({prompts:plan.prompts,agents:plan.agents});
  requireBinding(plan.catalogs.length>0 && new Set(plan.catalogs.map(c=>verifiedModel(c).key)).size===plan.catalogs.length);
  const sourceHashes={};
  for (const source of sourcePaths) {
    const snapshot=await readRegular(path.join(directory,"source",source));
    requireBinding(plan.sourceHashes[source]===digest(snapshot));
    sourceHashes[source]=digest(await fs.readFile(path.join(repository,source)));
  }
  const sameSource=sha(sourceHashes)===sha(plan.sourceHashes);
  // Replaying old snapshots never executes their source files.
  const rows=[];
  for (const spec of cellsFor(plan)) {
    const intent=await optional(path.join(directory,spec.cell+".intent.json"));
    const result=await optional(path.join(directory,spec.cell+".result.json"));
    const row={...spec, state:"unresolved", retrieval:null,modelAttempted:false, observation:null,grade:{passed:false,reason:"no_observed_result"}};
    if (intent) {
      requireBinding(intent.planSha256===planSha256 && sha(intent.spec)===sha(spec)
        && intent.requestSha256===sha(intent.turn.request));
      checkTurn(plan,spec,intent.turn);
      if (sameSource) {
        const turn=makeTurn(plan.fixture,plan.prompts.find(p=>p.id===spec.prompt),plan.agents.find(a=>a.id===spec.agent),spec.model);
        requireBinding(sha(intent.turn)===sha(turn));
      }
      row.retrieval="succeeded"; row.modelAttempted=true;
      row.trace={retrievedSourceIds:intent.turn.selected.map(s=>s.id), requestSha256:intent.requestSha256,
        dispatchFile:spec.cell+".intent.json",resultFile:result ? spec.cell+".result.json" : null};
    }
    if (result) {
      requireBinding(result.planSha256===planSha256 && result.cell===spec.cell);
      if (result.stage==="retrieval_error") {
        requireBinding(!intent && result.error==="retrieval_failed"); row.retrieval="failed";
        row.grade={passed:false,reason:result.error};
      } else if (result.stage==="catalog_error") {
        requireBinding(!intent && result.error==="local_model_changed_or_unavailable"); row.grade={passed:false,reason:result.error};
      } else {
        requireBinding(result.stage==="response" && intent && result.intentSha256===sha(intent)
          && Number.isSafeInteger(result.wallMs) && result.wallMs>=0
          && (result.error===null || typeof result.error==="string")
          && (result.body===null ? result.error!==null : result.error!==null || result.body.model===spec.model));
        const obs={wallMs:result.wallMs};
        if (result.body?.model===spec.model) for (const [field, name] of [["prompt_eval_count","inputTokens"],["eval_count","outputTokens"]]) {
          const value=result.body[field]; if(Number.isSafeInteger(value)&&value>=0) obs[name]=value;
        }
        row.observation=obs;
        row.grade=result.error ? {passed:false,reason:result.error} : grade(plan.fixture,intent.turn.selected,result.body);
      }
      row.resultSha256=sha(result);
      row.state=row.grade.passed ? "passed" : "failed";
    }
    rows.push(row);
  }
  return {protocol:plan.protocol, planSha256, sourceMatchesCurrentCheckout:sameSource, distinctModels:plan.catalogs.length,
    datasetSha256:sha(plan.fixture), generationOptions:plan.options, ...summarize(rows), contrasts:contrasts(rows), rows};
}
export async function runMatrix({models, prompts, agents, directory, endpoint}) {
  endpoint = localOllamaOrigin(endpoint);
  if (!models?.length || new Set(models).size!==models.length || models.length>8) throw Error("choose_one_to_eight_distinct_installed_local_models");
  const fixture=fixtureSchema.parse(await read(path.join(here,"gold/warehouse-replay-v1.json")));
  const profiles=profileSchema.parse(await read(path.join(here,"version-matrix/profiles.json")));
  const catalogs=[];
  for (const model of models) {
    const {entry,show}=await localCatalog(model,endpoint);
    catalogs.push({entry:{name:entry.name,digest:entry.digest},show:{modelfile:show.modelfile}});
  }
  if (new Set(catalogs.map(c=>verifiedModel(c).key)).size!==models.length) throw Error("model_aliases_share_weights");
  const selectedPrompts=select(profiles.prompts,prompts), selectedAgents=select(profiles.agents,agents);
  const sourceHashes={}, sourceBytes=new Map();
  for(const file of sourcePaths) {
    const bytes=await fs.readFile(path.join(repository,file)); sourceBytes.set(file,bytes); sourceHashes[file]=digest(bytes);
  }
  const plan={ protocol:"warehouse-evidence-matrix-v1",endpoint,fixture,catalogs,prompts:selectedPrompts,agents:selectedAgents,
    options:generationOptions,formatSha256:sha(makeTurn(fixture,selectedPrompts[0],selectedAgents[0],models[0]).request.format),sourceHashes };
  const planSha256=sha(plan);
  await fs.mkdir(directory,{mode:0o700}); directory=await fs.realpath(directory);
  for(const [file,bytes] of sourceBytes) {
    const target=path.join(directory,"source",file);
    await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700}); await fs.writeFile(target,bytes,{flag:"wx",mode:0o600});
  }
  await write(path.join(directory,"plan.json"),plan); await write(path.join(directory,"plan.sha256.json"),planSha256);
  for(const spec of cellsFor(plan)) {
    const target=path.join(directory,spec.cell+".result.json");
    try { if (verifiedModel(await localCatalog(spec.model,endpoint)).revision!==spec.revision) throw Error(); }
    catch { await write(target,{cell:spec.cell,planSha256,stage:"catalog_error",error:"local_model_changed_or_unavailable"}); continue; }
    let turn;
    try { turn=makeTurn(fixture,selectedPrompts.find(p=>p.id===spec.prompt),selectedAgents.find(a=>a.id===spec.agent),spec.model); }
    catch { await write(target,{cell:spec.cell,planSha256,stage:"retrieval_error",error:"retrieval_failed"}); continue; }
    const intent={planSha256,spec,turn,requestSha256:sha(turn.request)};
    await write(path.join(directory,spec.cell+".intent.json"),intent);
    const result=await observation(turn.request,endpoint);
    try { if(verifiedModel(await localCatalog(spec.model,endpoint)).revision!==spec.revision) throw Error(); }
    catch { result.error="local_model_changed_or_unavailable"; }
    await write(target,{cell:spec.cell,planSha256,stage:"response",intentSha256:sha(intent),...result});
  }
  const report=await replayMatrix(directory);
  await write(path.join(directory,"report.json"),report);
  return report;
}

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const {values}=parseArgs({options:{verify:{type:"string"},model:{type:"string",multiple:true},out:{type:"string"},endpoint:{type:"string"},
    prompt:{type:"string",multiple:true},agent:{type:"string",multiple:true}}});
  let report;
  if(values.verify && Object.keys(values).length===1) report=await replayMatrix(values.verify);
  else if(!values.verify && values.out && values.model?.length) report=await runMatrix({models:values.model,endpoint:values.endpoint,prompts:values.prompt,agents:values.agent,directory:path.resolve(values.out)});
  else throw Error("Usage: --model INSTALLED_MODEL [--model OTHER] [--prompt VERSION] [--agent VERSION] [--endpoint LOOPBACK_ORIGIN] --out NEW_DIR | --verify ARCHIVE_DIR");
  console.log(json(report));
}
