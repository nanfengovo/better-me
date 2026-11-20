import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs, {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {careerRuntimeBinding,type FreeChatTaskCreate} from "@better-me/agent-contracts";
import {AgentTaskKernel} from "../src/kernel/service.js";

const access={session:"synthetic-scope",valid:async()=>true},runtimeBinding=careerRuntimeBinding({kind:"native",runtimeId:"codex"});
const chat=(key:string):FreeChatTaskCreate=>({kind:"free_chat",workspaceKey:key,rootScopeKey:"synthetic-resume-scope",objective:"合成连续对话",runtimeBinding,consent:true,idempotencyKey:`synthetic-scope-${key}`,conversation:{messages:[{id:"u1",role:"user",content:"只参与测试。"}]}});

test("settings can inspect only the public workspace binding, without reconciling an interrupted archive",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-inspect-binding-")),ownerId="synthetic-owner";
  let kernel=new AgentTaskKernel({ownerId,directory});t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  const root=await kernel.createTask(chat("pinned"),access),scope=root.rootScopeKey!;
  await kernel.close();
  // Simulate a process exiting without a final heartbeat, using only the temporary owner.
  const file=path.join(directory,`${root.id}.json`),store=JSON.parse(await readFile(file,"utf8"));store.task.status="running";store.lastActiveAt=Date.now()-60_000;
  const bytes=JSON.stringify(store);await writeFile(file,bytes);
  kernel=new AgentTaskKernel({ownerId,directory});
  await assert.rejects(kernel.workspaceBinding(scope,{...access,valid:async()=>false}),/interaction_lease_invalid/);
  assert.deepEqual(await kernel.workspaceBinding("unbound",access),{ownerId,rootScopeKey:"unbound",binding:null});
  for(let i=0;i<2;i++)assert.deepEqual(await kernel.workspaceBinding(scope,access),{ownerId,rootScopeKey:scope,binding:runtimeBinding});
  assert.equal(await readFile(file,"utf8"),bytes,"even cached reads must not recover, dispatch, or change usage");
  assert.equal((await kernel.readTask(root.id)).status,"interrupted","normal recovery remains authoritative");
});

test("concurrent distinct facades atomically select one workspace root and inherit its non-default ceiling",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-scope-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  const budget={maxModelCalls:2,maxToolCalls:7,maxActiveMs:60000};
  const root=await kernel.createTask({...chat("advisor"),budget},access);
  const children=await Promise.all([
    kernel.createTask(chat("companion"),access),
    kernel.createTask({kind:"project_understanding",workspaceKey:"project-field",rootScopeKey:root.rootScopeKey,objective:"合成项目理解",project:{projectKey:"field",label:"合成项目",sourceText:"项目语义待确认。"},runtimeBinding,consent:true,idempotencyKey:"synthetic-project-scope"},access),
    kernel.createTask({kind:"experience_refine",workspaceKey:"writing-note",rootScopeKey:root.rootScopeKey,objective:"合成字段润色",refinement:{source:{targetRef:{kind:"profile_headline",locale:"zh"},text:"参与测试。",label:"合成原文"}},conversation:{messages:[{id:"u1",role:"user",content:""}]},runtimeBinding,consent:true,supplementConfirmed:true,idempotencyKey:"synthetic-refine-scope"},access),
  ]);
  assert.ok(children.every(task=>task.parentTaskId===root.id&&task.rootTaskId===root.id&&task.rootScopeKey===root.rootScopeKey));
  assert.ok(children.every(task=>JSON.stringify(task.budget)===JSON.stringify(budget)));
  assert.equal((await kernel.readTask(root.id)).rootLedger!.memberCount,4);
  // A scope is only a ledger association: none of the parent's text becomes a
  // project evidence grant, a conversation message, or a personal assertion.
  const project=children.find(task=>task.kind==="project_understanding")!;assert.equal(project.kind,"project_understanding");
  assert.deepEqual(project.project.grants,[]);assert.deepEqual(project.project.evidence,[]);assert.equal(project.project.messages.length,1);
  await assert.rejects(kernel.createTask({...chat("oversize"),budget:{...budget,maxModelCalls:12}},access),/child_budget_must_inherit_root/);
  await assert.rejects(kernel.createTask({...chat("other-model"),runtimeBinding:careerRuntimeBinding({kind:"native",runtimeId:"claude-code"})},access),/root_runtime_binding_changed/);
});

test("simultaneous first creates cannot fork a scope, and reopening keeps the same parent without replay",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-scope-first-"));let kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});t.after(async()=>{await kernel.close();await rm(directory,{recursive:true,force:true});});
  const tasks=await Promise.all(["a","b","c"].map(key=>kernel.createTask(chat(key),access)));
  const roots=tasks.filter(task=>!task.parentTaskId);assert.equal(roots.length,1);assert.ok(tasks.every(task=>task.rootTaskId===roots[0]!.id));
  await kernel.close();kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory});
  const next=await kernel.createTask(chat("after-reopen"),access);assert.equal(next.parentTaskId,roots[0]!.id);assert.equal(next.rootLedger!.memberCount,4);assert.equal(next.rootLedger!.usage.modelCalls,0);
  const ancestor=await kernel.readTask(roots[0]!.id);await kernel.stop(ancestor.id,ancestor.revision,true,access);
  await assert.rejects(kernel.createTask(chat("revoked-scope"),access),/root_task_revoked/);
});

test("scope association rejects mismatched explicit parents and leaves legacy and another owner untouched",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-scope-owner-")),otherDirectory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-scope-other-"));
  const kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory}),other=new AgentTaskKernel({ownerId:"other-owner",directory:otherDirectory});t.after(async()=>{await kernel.close();await other.close();await rm(directory,{recursive:true,force:true});await rm(otherDirectory,{recursive:true,force:true});});
  const legacy=await kernel.createTask({...chat("legacy"),rootScopeKey:undefined},access),root=await kernel.createTask(chat("root"),access);
  await assert.rejects(kernel.createTask({...chat("mismatch"),parentTaskId:legacy.id},access),/root_scope_changed/);
  await assert.rejects(kernel.createTask({...chat("different-scope"),rootScopeKey:"different-workspace",parentTaskId:root.id},access),/root_scope_changed/);
  const child=await kernel.createTask({...chat("explicit"),rootScopeKey:undefined,parentTaskId:root.id},access);assert.equal(child.rootScopeKey,root.rootScopeKey);
  const isolated=await other.createTask(chat("root"),access);assert.notEqual(isolated.id,root.id);assert.equal(isolated.rootTaskId,isolated.id);assert.equal(isolated.parentTaskId,undefined);
  assert.equal((await kernel.readTask(legacy.id)).rootScopeKey,undefined);assert.equal((await kernel.readTask(legacy.id)).rootTaskId,legacy.id);
});

test("task summary stays bounded and reports abandoned work without rewriting private archives", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-task-summary-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-owner", directory });
  t.after(async () => { await kernel.close(); await rm(directory, { recursive: true, force: true }); });
  const older = await kernel.createTask({
    kind: "project_understanding", workspaceKey: "summary-project", rootScopeKey: "summary-project",
    objective: "PRIVATE_SUMMARY_FIXTURE", project: { projectKey: "summary", label: "Synthetic", sourceText: "Synthetic project" },
    runtimeBinding, consent: true, idempotencyKey: "summary-project-fixture",
  }, access);
  const olderFile = path.join(directory, older.id + ".json");
  const olderArchive = JSON.parse(await readFile(olderFile, "utf8"));
  olderArchive.task.updatedAt = "2020-01-01T00:00:00.000Z";
  olderArchive.task.project.updatedAt = olderArchive.task.updatedAt;
  await writeFile(olderFile, JSON.stringify(olderArchive), { mode: 0o600 });

  const tasks = [];
  for (let index = 0; index < 8; index++) {
    tasks.push(await kernel.createTask({ ...chat(`summary-${index}`), objective: "PRIVATE_SUMMARY_FIXTURE" }, access));
  }
  const latest = tasks.at(-1)!;
  const file = path.join(directory, latest.id + ".json");
  const archive = JSON.parse(await readFile(file, "utf8"));
  archive.task.status = "running";
  archive.task.updatedAt = "2099-01-01T00:00:00.000Z";
  const before = JSON.stringify(archive);
  await writeFile(file, before, { mode: 0o600 });

  const summary = await kernel.listTaskSummary();
  assert.equal(summary.totalTasks, 9);
  assert.equal(summary.readyCount, 8);
  assert.equal(summary.runningCount, 0);
  assert.equal(summary.recentByKind.length, 4);
  assert.ok(!summary.tasks.some(task => task.id === older.id));
  assert.ok(summary.recentByKind.some(task => task.id === older.id && task.kind === "project_understanding"));
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.tasks.length, 6);
  assert.equal(summary.tasks[0]!.id, latest.id);
  assert.equal(summary.tasks[0]!.status, "interrupted");
  assert.deepEqual(Object.keys(summary.tasks[0]!).sort(), ["id", "kind", "status", "title", "updatedAt"]);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_SUMMARY_FIXTURE|rootLedger/);
  assert.equal(await readFile(file, "utf8"), before);
});

test("manual group pause stops a pending descendant without overwriting its waiting root or accepting a late reply",async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-root-scope-stop-")),kernel=new AgentTaskKernel({ownerId:"synthetic-owner",directory}),entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<string>();t.after(async()=>{finish.resolve(JSON.stringify({kind:"reply",content:"迟到输出"}));await kernel.close();await rm(directory,{recursive:true,force:true});});
  let root=await kernel.createTask(chat("waiting-root"),access);
  const command=(task:typeof root)=>({expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding,consent:true as const});
  await kernel.run(root.id,"start",command(root),{runtimeFingerprint:"one-scope-runtime",reasoner:async()=>JSON.stringify({kind:"reply",content:"已完成根首问"})},access);
  for(let i=0;i<200;i++){root=await kernel.readTask(root.id) as typeof root;if(root.status!=="running")break;await delay(5);}assert.equal(root.status,"awaiting_answer");
  const child=await kernel.createTask(chat("pending-child"),access);await kernel.run(child.id,"start",command(child),{runtimeFingerprint:"one-scope-runtime",reasoner:async()=>{entered.resolve();return finish.promise;}},access);await entered.promise;
  const runningSummary=await kernel.listTaskSummary();assert.equal(runningSummary.runningCount,1);assert.equal(runningSummary.awaitingCount,1);assert.equal(runningSummary.readyCount,0);
  await assert.rejects(kernel.pauseGroup(child.id,child.revision+1,access),/root_task_required|task_revision_conflict/);
  root=await kernel.readTask(root.id) as typeof root;const paused=await kernel.pauseGroup(root.id,root.revision,access);assert.equal(paused.status,"awaiting_answer");assert.equal((paused as typeof root).reply?.content,"已完成根首问");assert.equal(paused.rootLedger!.usage.modelCalls,2);
  finish.resolve(JSON.stringify({kind:"reply",content:"迟到输出"}));await delay(20);const result=await kernel.readTask(child.id);assert.equal(result.status,"paused");assert.equal((result as typeof root).reply,undefined);
});

test("a cold many-task summary does not hold back pause and cannot overwrite its committed status", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-task-summary-pause-"));
  const kernel = new AgentTaskKernel({ ownerId: "synthetic-owner", directory });
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  const summaryEntered = Promise.withResolvers<void>();
  const summaryRelease = Promise.withResolvers<void>();
  t.after(async () => {
    summaryRelease.resolve();
    finish.resolve(JSON.stringify({ kind: "reply", content: "Late reply" }));
    await kernel.close();
    await rm(directory, { recursive: true, force: true });
  });
  const task = await kernel.createTask({ ...chat("summary-pause"), rootScopeKey: undefined }, access);
  const seed = JSON.parse(await readFile(path.join(directory, task.id + ".json"), "utf8"));
  const fixtureFiles = [];
  for (let index = 0; index < 100; index++) {
    const archive = structuredClone(seed);
    archive.task.id = "ct_" + index.toString(16).padStart(32, "0");
    archive.task.rootTaskId = archive.task.id;
    archive.task.updatedAt = "2020-01-01T00:00:00.000Z";
    const filename = path.join(directory, archive.task.id + ".json");
    fixtureFiles.push(filename);
    await writeFile(filename, JSON.stringify(archive), { mode: 0o600 });
  }
  await kernel.run(task.id, "start", {
    expectedRevision: task.revision, sourceFingerprint: task.sourceFingerprint, runtimeBinding, consent: true,
  }, { runtimeFingerprint: "summary-pause-runtime", reasoner: async () => {
    entered.resolve();
    return finish.promise;
  } }, access);
  await entered.promise;
  const current = await kernel.readTask(task.id);
  assert.equal(current.status, "running");

  const reads = new Set(fixtureFiles);
  const originalRead = fs.readFile;
  let enteredScan = false;
  let archivedReads = 0;
  t.mock.method(fs, "readFile", (async (filename: string, ...args: unknown[]) => {
    if (reads.has(filename)) {
      archivedReads++;
      if (!enteredScan) {
        enteredScan = true;
        summaryEntered.resolve();
        await summaryRelease.promise;
      }
    }
    return Reflect.apply(originalRead, fs, [filename, ...args]);
  }) as typeof fs.readFile);
  const scan = kernel.listTaskSummary();
  await summaryEntered.promise;
  assert.equal(kernel.listTaskSummary(), scan, "concurrent status requests share a scan");

  const timeout = new AbortController();
  try {
    const paused = await Promise.race([
      kernel.stop(task.id, current.revision, false, access),
      delay(10000, undefined, { signal: timeout.signal }).then(() => assert.fail("summary blocked task pause")),
    ]);
    assert.equal(paused.status, "paused");
  } finally {
    timeout.abort();
    summaryRelease.resolve();
  }
  const summary = await scan;
  assert.equal(summary.totalTasks, 101);
  assert.equal(summary.readyCount, 100);
  assert.equal(summary.runningCount, 0);
  assert.equal(summary.pausedCount, 1);
  assert.equal(summary.tasks[0]?.id, task.id);
  assert.equal(summary.tasks[0]?.status, "paused");
  assert.ok(archivedReads >= 100);
  archivedReads = 0;
  assert.deepEqual(await kernel.listTaskSummary(), summary);
  assert.equal(archivedReads, 0, "unchanged archives reuse validated summary metadata");
  finish.resolve(JSON.stringify({ kind: "reply", content: "Late reply" }));
  await delay(20);
  assert.equal((await kernel.readTask(task.id)).status, "paused");
});
