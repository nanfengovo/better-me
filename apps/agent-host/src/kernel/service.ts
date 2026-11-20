import fs from "node:fs/promises";
import { ResumeReplacementSelectionSchema } from "@better-me/core";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_TASK_SUMMARY_LIMIT, AGENT_TASK_STAGE_SUMMARY_LIMIT, type AgentTaskSummary, inventoryProbeTaskId, InventoryTaskCreateSchema, InventoryProbeResultSchema, type AgentTaskListSummary, type InventoryTask, type InventoryTaskCreate } from "@better-me/agent-contracts";
import { DatabaseSync } from "node:sqlite";
import { CareerTaskBudgetSchema, CareerTaskCreateSchema, CareerTaskDecisionSchema, CareerTaskReceiptSchema, AgentTaskRunSchema, AgentTaskSchema, FreeChatTaskCreateSchema, ExperienceRefineTaskCreateSchema, FreeChatReplyDecisionSchema, ResumeCandidateSchema, resumeCandidateSource, resumeCandidateBoundSchema, reviewResumeCandidateAttribution, reviewResumeCandidateWorkCoverage, isCareerTask, agentTaskSourceFingerprint,
  ProjectUnderstandingTaskCreateSchema, UnderstandingTurnSchema, isConversationTask,
  JdMatchTaskCreateSchema,JdMatchReviewSchema,type JdMatchTask,type JdMatchTaskCreate,
  MockInterviewTaskCreateSchema,type MockInterviewTask,type MockInterviewTaskCreate,
  CoachGuidanceTaskCreateSchema,type CoachGuidanceTask,type CoachGuidanceTaskCreate,
  JdIntakeTaskCreateSchema,jdIntakePrompt,parseJdIntakeResult,type JdIntakeTask,type JdIntakeTaskCreate,
  JdOcrTaskCreateSchema,JdOcrUploadSchema,jdOcrPrompt,parseJdOcrResult,type JdOcrTask,type JdOcrTaskCreate,type JdOcrUpload,
  StudioAnalysisTaskCreateSchema,studioAnalysisOutputSchema,studioAnalysisPrompt,type StudioAnalysisTask,type StudioAnalysisTaskCreate,
  StudioCommitteeTaskCreateSchema,type StudioCommitteeTask,type StudioCommitteeTaskCreate,
  GrowthPracticeTaskCreateSchema,GrowthPracticeStepSchema,growthPracticeVerificationHash,type GrowthPracticeTask,type GrowthPracticeTaskCreate,type GrowthPracticeStep,
  type ProjectUnderstandingTask, type ProjectUnderstandingTaskCreate, type UnderstandingTurnInput,
  type AgentTask, type AgentTaskCreate, type ConversationTask, type ExperienceRefineTask, type ExperienceRefineTaskCreate, type FreeChatTask, type FreeChatTaskCreate, type CareerTask, type CareerTaskBudget, type CareerTaskCreate, type CareerToolArtifact, type UnderstandingGrant } from "@better-me/agent-contracts";
import type { WritingReply } from "@better-me/core/experience-writing";
import type { StudioContext } from "@better-me/agent-contracts/career-studio";
import { modelOutputText, modelOutputIncomplete, modelFinishReason, projectSourceDiscovery, RejectedTaskModelOutput, type CareerTaskModelOutput } from "./model-protocol.js";
import { providerJournalFields } from "../tasks/provider-observation.js";
import type { z } from "zod";
import { privateDirectory, readPrivateJson, writePrivateJson } from "../identity/private-json.js";
import { EvidenceBroker } from "../understanding/evidence-broker.js";
import { CareerTaskError, digest, evidence, requireEvidence, safeCode, validateDraft } from "../tasks/evidence.js";
import { executeTaskTool, taskTools } from "./tools.js";
import { taskContext } from "./context.js";
import { buildTaskTool, invokeTaskTool, parseArtifact, type Reserve } from "./tool-builder.js";
import { freeChatActions, freeChatPrompt, freeChatImages } from "./free-chat.js";
import { experienceRefinePrompt, experienceRefineReply } from "./experience-refine.js";
import { checkQuoteProvenance, verifyProjectQuoteReview, type ProjectQuoteReview } from "./project-quote-review.js";
import { activeProjectEvidence, beginProjectTurn, collectProjectEvidence, invalidateProject, mountProjectContext, projectDecision, projectHandle, projectPrivate, projectPrompt, projectProtocol, projectQuoteTurn, preserveConfirmedUnderstanding, projectReplay, projectReplyContract, protocolState, understandingHash, type ProjectStore } from "./project-understanding.js";
import type { EvidenceResult } from "../understanding/evidence-broker.js";
import { jdMatchContext,jdMatchDecision,jdMatchEvidence,jdMatchItems,jdMatchPrompt,readJdMatchEvidence,structureMatchJd } from "./jd-match.js";
import { interviewContext,interviewDecision,interviewPrompt,interviewReceiptText,interviewSources,readInterviewEvidence } from "./mock-interview.js";
import { validChatMaterial } from "@better-me/agent-contracts";
import { buildCoachMessages, parseCoachPayload, validateCoachRequest } from "@better-me/agent-contracts/career-coach-protocol";
import { JdOcrImageStore } from "./jd-ocr-images.js";
import { TaskScopeAssociationRequestSchema, TaskRootScopeKeySchema, type LegacyTaskScopeCandidate, type TaskScopeAssociationRequest, type TaskScopeAssociation } from "@better-me/agent-contracts";
import { TaskScopeAssociations } from "./task-scope-associations.js";
import { containsGitEvidenceSecret } from "../evidence-harvester/git-source.js";
import { CommitteeReportSchema, validateCommitteeSnapshot, runHiringCommittee } from "@better-me/core/career-intelligence";
import { committeeModelRequest } from "../career-studio/committee-model.js";
import { prepareCommitteeTask, revalidateCommitteeSources } from "./studio-committee.js";
import { growthPracticeInput, isVerifiedGrowthPractice, lookupGrowthPracticeSource, runGrowthPracticeDecision, verifyGrowthPractice } from "./growth-practice.js";
import { writingEvidence, writingPrompt, writingPlan, writingConfirmation, writingAnswerEvidence, writingDraft, writingModelContract } from "./resume-text.js";
import {
  activeLeaseMs,
  careerStore,
  charge,
  checkRevision,
  collectEvidence,
  date,
  event,
  fail,
  growthPracticeStore,
  hold,
  interviewStore,
  jdStore,
  nextAction,
  projectStore,
  prompt,
  stage,
  stoppable,
  type Active,
  type AgentTaskCommand,
  type AnyChange,
  type AnyStore,
  type CareerTaskAccess,
  type CareerTaskRun,
  type CareerTaskRuntime,
  type Change,
  type Store,
} from "./kernel-helpers.js";
export { CareerTaskError };
export type { AgentTaskCommand, CareerTaskAccess, CareerTaskRun, CareerTaskRuntime };

type TaskFileMetadata = { ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
type TaskSummaryEntry = { meta: TaskFileMetadata | null; task: AgentTaskSummary };
function sameTaskFile(a: TaskFileMetadata | null, b: TaskFileMetadata | null): boolean {
  return !!a && !!b && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function taskSummary(task: AgentTask): AgentTaskSummary {
  const kind = task.kind ?? "resume_tailor";
  return { id: task.id, kind, title: isCareerTask(task) ? task.job.title.slice(0, 160) : kind, status: task.status, updatedAt: task.updatedAt };
}

/** One instance per authenticated owner (never per tab). Operations serialize before publication; no credential is part of Store. */
export class AgentTaskKernel{
  private readonly active=new Map<string,Active>();
  private readonly storeCache=new Map<string,{ino:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint;store:AnyStore}>();
  private readonly rootIndex=new Map<string,{ino:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint;rootTaskId?:string}>();
  // Only bounded summary fields enter this index. Interactive task reads maintain
  // the separate full-store cache and remain serialized in the writer queue.
  private readonly summaryIndex = new Map<string, TaskSummaryEntry>();
  private summaryRefresh?: Promise<AgentTaskListSummary>;
  private writes:Promise<unknown>=Promise.resolve();
  private closed=false;
  private revoked=new Set<string>();
  private writer?:DatabaseSync;
  private broker:EvidenceBroker;
  private images:JdOcrImageStore;
  private scopes:TaskScopeAssociations;
  constructor(private opts:{ownerId:string;directory:string;broker?:EvidenceBroker;validateStudioAnalysis?:(task:StudioAnalysisTask,access:CareerTaskAccess)=>Promise<void>;
    validateStudioCommittee?:(task:StudioCommitteeTask,access:CareerTaskAccess)=>Promise<StudioContext>;
    growthPracticeLookup?:(input:{taskId:string;sourceId:string;sourceText:string;sourceHash:string})=>Promise<string>}){
    this.broker=opts.broker??new EvidenceBroker({forbiddenRoots:[opts.directory]});
    this.images=new JdOcrImageStore(opts.directory,opts.ownerId);
    this.scopes=new TaskScopeAssociations(opts.directory,opts.ownerId);
  }
  private async lockWriter(){
    if(this.writer)return;
    if(this.closed)fail("host_stopped",503);
    await privateDirectory(this.opts.directory);
    const file=path.join(this.opts.directory,"career-task-writer.sqlite");
    try{const h=await fs.open(file,"wx",0o600);await h.close();}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
    const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)fail("unsafe_task_lock",503);
    await fs.chmod(file,0o600);const db=new DatabaseSync(file);
    try{db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");this.writer=db;}catch{db.close();fail("task_single_writer_required",503);}
  }
  private atomic<T>(fn:()=>Promise<T>):Promise<T>{const run=async()=>{await this.lockWriter();return fn();};const q=this.writes.then(run,run);this.writes=q.catch(()=>{});return q;}
  private async assertAccess(access?:CareerTaskAccess){if(this.closed||access&&(this.revoked.has(access.session)||!await access.valid()||this.revoked.has(access.session)))fail("interaction_lease_invalid",403);}
  private file(id:string){if(!/^ct_[a-f0-9]{32}$/.test(id))fail("task_not_found",404);return path.join(this.opts.directory,`${id}.json`);}
  private async statPrivateStore(filePath:string){
    try{
      const st=await fs.lstat(filePath,{bigint:true});
      const safe=st.isFile()&&!st.isSymbolicLink()&&st.nlink===1n&&st.size<=16n*1024n*1024n
        &&(process.platform==="win32"||(st.mode&0o777n)===0o600n);
      return safe?{ino:st.ino,size:st.size,mtimeNs:st.mtimeNs,ctimeNs:st.ctimeNs}:null;
    }catch{return null;}
  }
  private async save(s:AnyStore){delete s.task.rootLedger;s.task.updatedAt=date();s.task.revision++;
    if(s.task.kind==="project_understanding"){s.task.project.revision=s.task.revision;s.task.project.updatedAt=s.task.updatedAt;s.task.project.grants=structuredClone(s.grants);}
    const filePath=this.file(s.task.id);
    this.storeCache.delete(s.task.id);
    this.rootIndex.delete(s.task.id);
    await writePrivateJson(filePath,s);
    const meta=await this.statPrivateStore(filePath);
    if(meta){
      this.storeCache.set(s.task.id,{...meta,store:structuredClone(s)});
      this.rootIndex.set(s.task.id,{...meta,rootTaskId:s.task.rootTaskId});
    }
    this.summaryIndex.set(s.task.id, { meta, task: taskSummary(s.task) });
  }
  private checkedPrivateStore(id:string,raw:unknown):AnyStore{
    if(!raw||typeof raw!=="object")fail("invalid_private_task",503);
    const s=raw as AnyStore;
    if(s.schema!==1||s.task?.id!==id||s.task?.ownerId!==this.opts.ownerId||!Array.isArray(s.recent)||!Array.isArray(s.grants)||!AgentTaskSchema.safeParse(s.task).success)fail("invalid_private_task",503);
    if(s.task.kind==="project_understanding"){
      const metaState=s.projectState,session=s.task.project;
      if(session.id!==id||session.workspaceKey!==s.task.workspaceKey||session.revision!==s.task.revision||digest(session.grants)!==digest(s.grants)||!metaState||!Number.isSafeInteger(metaState.agentContextFloor)||metaState.agentContextFloor<0||metaState.agentContextFloor>session.messages.length||!Number.isSafeInteger(metaState.recentContextFloor)||metaState.recentContextFloor<0||metaState.recentContextFloor>s.recent.length||!metaState.receipts||typeof metaState.receipts!=="object")fail("invalid_private_task",503);
    }
    return s;
  }
  private async loadAny(id:string, mode:"recover"|"inspect"="recover"):Promise<AnyStore>{
    const filePath=this.file(id);
    const cached=this.storeCache.get(id);
    const meta=await this.statPrivateStore(filePath);
    if(cached&&meta&&cached.ino===meta.ino&&cached.size===meta.size&&cached.mtimeNs===meta.mtimeNs&&cached.ctimeNs===meta.ctimeNs){
      const s=structuredClone(cached.store);
      if(mode==="recover"&&s.task.status==="running"&&!this.active.has(id)){
        if(s.lastActiveAt!==undefined)s.task.usage.activeMs=Math.min(s.task.budget.maxActiveMs,s.task.usage.activeMs+Math.min(activeLeaseMs,Math.max(0,Date.now()-s.lastActiveAt)));
        delete s.lastActiveAt;stage(s.task,"interrupted","host_restarted");event(s.task,"stopped","Host restarted; previous requests are not replayed. Recheck consent to resume.");await this.save(s);
      }
      return s;
    }
    this.storeCache.delete(id);
    this.rootIndex.delete(id);
    const raw=await readPrivateJson(filePath);if(!raw)fail("task_not_found",404);
    const s=this.checkedPrivateStore(id,raw);
    if(mode==="recover"&&s.task.status==="running"&&!this.active.has(id)){
      // A missing final heartbeat forfeits its last leased interval (not all wall time while offline).
      // Repeated forced restarts cannot refund the elapsed active interval.
      if(s.lastActiveAt!==undefined)s.task.usage.activeMs=Math.min(s.task.budget.maxActiveMs,s.task.usage.activeMs+Math.min(activeLeaseMs,Math.max(0,Date.now()-s.lastActiveAt)));
      delete s.lastActiveAt;stage(s.task,"interrupted","host_restarted");event(s.task,"stopped","Host restarted; previous requests are not replayed. Recheck consent to resume.");await this.save(s);
    }else if(meta){
      this.storeCache.set(id,{...meta,store:structuredClone(s)});
      this.rootIndex.set(id,{...meta,rootTaskId:s.task.rootTaskId});
    }
    return s;
  }
  private async load(id:string):Promise<Store>{return careerStore(await this.loadAny(id));}
  /** Called only under the owner writer lock. Durable per-task charges are the single
   * journal; derive totals instead of maintaining a second crash-inconsistent counter. */
  private async rootState(current:AnyStore){
    const rootId=current.task.rootTaskId??current.task.id;
    const root=rootId===current.task.id?current:await this.loadAny(rootId);
    const associations=await this.scopes.read(),scope=this.scopes.scope(root.task,associations);
    if(root.task.parentTaskId||(root.task.rootTaskId??root.task.id)!==rootId)fail("invalid_task_lineage",503);
    const members=new Map<string,AnyStore>([[rootId,root],[current.task.id,current]]);
    const names=await fs.readdir(this.opts.directory);
    for(const name of names.filter(name=>/^ct_[a-f0-9]{32}\.json$/.test(name))){
      const memberId=name.slice(0,-5);if(members.has(memberId))continue;
      const filePath=this.file(memberId);
      const meta=await this.statPrivateStore(filePath);
      const cached=this.storeCache.get(memberId);
      if(cached&&meta&&cached.ino===meta.ino&&cached.size===meta.size&&cached.mtimeNs===meta.mtimeNs&&cached.ctimeNs===meta.ctimeNs){
        if(cached.store.task.rootTaskId===rootId)members.set(memberId,await this.loadAny(memberId));
        continue;
      }
      const indexed=this.rootIndex.get(memberId);
      if(indexed&&meta&&indexed.ino===meta.ino&&indexed.size===meta.size&&indexed.mtimeNs===meta.mtimeNs&&indexed.ctimeNs===meta.ctimeNs){
        if(indexed.rootTaskId===rootId)members.set(memberId,await this.loadAny(memberId));
        continue;
      }
      const raw=await readPrivateJson(filePath) as AnyStore|undefined;
      if(meta&&raw?.task)this.rootIndex.set(memberId,{...meta,rootTaskId:raw.task.rootTaskId});
      if(raw?.task?.rootTaskId===rootId)members.set(memberId,await this.loadAny(memberId));
    }
    const usage={modelCalls:0,toolCalls:0,activeMs:0},time=Date.now();
    for(const member of members.values()){
      if(this.scopes.scope(member.task,associations)!==scope)fail("invalid_task_lineage",503);
      const seen=new Set<string>();let ancestor=member;
      while(ancestor.task.id!==rootId){
        if(seen.has(ancestor.task.id)||!ancestor.task.parentTaskId)fail("invalid_task_lineage",503);
        seen.add(ancestor.task.id);const parent=members.get(ancestor.task.parentTaskId!);if(!parent)fail("invalid_task_lineage",503);ancestor=parent!;
      }
      usage.modelCalls+=member.task.usage.modelCalls;usage.toolCalls+=member.task.usage.toolCalls;
      usage.activeMs+=member.task.usage.activeMs+(member.lastActiveAt===undefined?0:Math.max(0,time-member.lastActiveAt));
    }
    return {root,members,scope,ledger:{rootTaskId:rootId,budget:structuredClone(root.task.budget),usage,memberCount:members.size}};
  }
  private async view<T extends AgentTask>(s:Store<T>):Promise<T>{
    const {ledger,scope}=await this.rootState(s);return structuredClone({...s.task,rootTaskId:ledger.rootTaskId,...(scope?{rootScopeKey:scope}:{}),budget:ledger.budget,rootLedger:ledger});
  }
  private async lineage(id:string,parentId:string|undefined,binding:AgentTask["runtimeBinding"],requestedBudget?:CareerTaskBudget,rootScopeKey?:string){
    // Scope selection and creation share the owner writer. Concurrent views cannot
    // both observe an empty scope and create separate fresh-budget roots.
    if(rootScopeKey){
      const associations=await this.scopes.read();
      const existing=await this.scopedRoots(rootScopeKey);
      if(parentId){const parent=await this.loadAny(parentId);if(this.scopes.scope(parent.task,associations)!==rootScopeKey||existing&&(parent.task.rootTaskId??parent.task.id)!==existing)fail("root_scope_changed");}
      else parentId=existing;
    }
    if(!parentId)return {rootTaskId:id,...(rootScopeKey?{rootScopeKey}:{})};
    const parent=await this.loadAny(parentId),{root,members,ledger,scope}=await this.rootState(parent);
    await this.checkRoot(parent);
    if(members.size>=100)fail("root_task_capacity",422);
    if(root.task.status==="revoked"||parent.task.status==="revoked")fail("root_task_revoked",403);
    if(JSON.stringify(binding)!==JSON.stringify(root.task.runtimeBinding))fail("root_runtime_binding_changed");
    if(requestedBudget&&digest(requestedBudget)!==digest(root.task.budget))fail("child_budget_must_inherit_root");
    nextAction({budget:ledger.budget,usage:ledger.usage});
    return {rootTaskId:root.task.id,parentTaskId:parentId,...(scope?{rootScopeKey:scope}:{}),budget:structuredClone(root.task.budget)};
  }
  private async scopedRoots(rootScopeKey:string, mode:"recover"|"inspect"="recover"){
    const associations=await this.scopes.read(),roots=new Set<string>();
    for(const name of (await fs.readdir(this.opts.directory)).filter(name=>/^ct_[a-f0-9]{32}\.json$/.test(name))){
      const stored=await this.loadAny(name.slice(0,-5),mode);
      if(this.scopes.scope(stored.task,associations)===rootScopeKey)roots.add(stored.task.rootTaskId??stored.task.id);
    }
    if(roots.size>1)fail("root_scope_ambiguous",503);
    return [...roots][0];
  }
  /** Settings needs the public model identity only, never task contents or grants.
   * Inspecting the selection must not reconcile an interrupted run or create a task. */
  async workspaceBinding(scope:string,access:CareerTaskAccess){
    const rootScopeKey=TaskRootScopeKeySchema.parse(scope);
    return this.atomic(async()=>{
      await this.assertAccess(access);
      const rootId=await this.scopedRoots(rootScopeKey,"inspect");
      const root=rootId?(await this.loadAny(rootId,"inspect")).task:undefined;
      if(root&&(root.parentTaskId||(root.rootTaskId??root.id)!==root.id||this.scopes.scope(root,await this.scopes.read())!==rootScopeKey))fail("invalid_task_lineage",503);
      await this.assertAccess(access);
      return {ownerId:this.opts.ownerId,rootScopeKey,binding:root?.runtimeBinding??null};
    });
  }
  private async legacyCandidate(current:AnyStore,rootScopeKey:string,existingRootTaskId?:string):Promise<LegacyTaskScopeCandidate>{
    const state=await this.rootState(current),{root,members,ledger}=state;
    if(root.task.id!==current.task.id||state.scope!==undefined)fail("legacy_root_scope_required");
    const blockedBy=existingRootTaskId?"root_scope_occupied":[...members.values()].some(member=>member.task.status==="revoked")?"root_task_revoked":[...members.values()].some(member=>this.active.has(member.task.id)||member.task.status==="running")?"pause_before_scope_association":undefined;
    // The full original stores (not just root revision) pin every member, source,
    // grant, receipt, runtime generation and charge shown by this preview.
    const previewToken=blockedBy?undefined:digest({ownerId:this.opts.ownerId,rootScopeKey,members:[...members.values()].sort((a,b)=>a.task.id.localeCompare(b.task.id))});
    return {rootTaskId:root.task.id,objective:root.task.objective,workspaceKey:root.task.workspaceKey,status:root.task.status,updatedAt:root.task.updatedAt,runtimeBinding:root.task.runtimeBinding,ledger,...(blockedBy?{blockedBy}:{}),...(previewToken?{previewToken}:{})};
  }
  async previewLegacyScopes(scope:string,access?:CareerTaskAccess){const rootScopeKey=TaskRootScopeKeySchema.parse(scope);return this.atomic(async()=>{
    await this.assertAccess(access);const existingRootTaskId=await this.scopedRoots(rootScopeKey),associations=await this.scopes.read(),candidates:LegacyTaskScopeCandidate[]=[];
    for(const name of (await fs.readdir(this.opts.directory)).filter(name=>/^ct_[a-f0-9]{32}\.json$/.test(name))){
      const stored=await this.loadAny(name.slice(0,-5));
      if(!stored.task.parentTaskId&&(stored.task.rootTaskId??stored.task.id)===stored.task.id&&this.scopes.scope(stored.task,associations)===undefined)candidates.push(await this.legacyCandidate(stored,rootScopeKey,existingRootTaskId));
    }
    await this.assertAccess(access);return {ownerId:this.opts.ownerId,rootScopeKey,...(existingRootTaskId?{existingRootTaskId}:{}),candidates:candidates.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.rootTaskId.localeCompare(b.rootTaskId))};
  });}
  async associateLegacyScope(id:string,input:TaskScopeAssociationRequest,access?:CareerTaskAccess){const data=TaskScopeAssociationRequestSchema.parse(input);return this.atomic(async()=>{
    await this.assertAccess(access);const registry=await this.scopes.read(),saved=registry.associations.find(item=>item.rootTaskId===id);
    if(saved){
      if(saved.rootScopeKey!==data.rootScopeKey||saved.previewToken!==data.previewToken)fail("task_scope_already_associated");
      const task=await this.view(await this.loadAny(id));await this.assertAccess(access);return {association:saved,task};
    }
    const current=await this.loadAny(id),candidate=await this.legacyCandidate(current,data.rootScopeKey,await this.scopedRoots(data.rootScopeKey));
    if(candidate.blockedBy)fail(candidate.blockedBy,candidate.blockedBy==="root_task_revoked"?403:409);
    if(candidate.previewToken!==data.previewToken)fail("scope_association_preview_changed");
    const {members}=await this.rootState(current);
    if(members.size>100)fail("root_task_capacity",422);
    const association:TaskScopeAssociation={ownerId:this.opts.ownerId,rootTaskId:id,rootScopeKey:data.rootScopeKey,previewToken:data.previewToken,associatedAt:date(),memberIds:[...members.keys()].sort(),effect:"records_and_usage_only"};
    await this.assertAccess(access);await this.scopes.append(registry,association);
    return {association,task:await this.view(current)};
  });}
  private async checkRoot(s:AnyStore,runtimeHash?:string,admission=false){
    const state=await this.rootState(s);let ancestor=s;
    while(ancestor.task.parentTaskId){ancestor=state.members.get(ancestor.task.parentTaskId)!;if(ancestor.task.status==="revoked")fail("root_task_revoked",403);}
    if(runtimeHash&&[...state.members.values()].some(member=>member.runtimeHash&&member.runtimeHash!==runtimeHash))fail("root_runtime_authorization_changed");
    s.task.budget=state.ledger.budget;
    if(admission)nextAction({budget:state.ledger.budget,usage:state.ledger.usage});
    else if(state.ledger.usage.activeMs>=state.ledger.budget.maxActiveMs)fail("active_time_budget");
    return state;
  }
  private async reserve(s:AnyStore,kind:"model"|"tool"){
    const {ledger}=await this.checkRoot(s);
    if(kind==="model"&&ledger.usage.modelCalls>=ledger.budget.maxModelCalls)fail("model_call_budget");
    if(kind==="tool"&&ledger.usage.toolCalls>=ledger.budget.maxToolCalls)fail("tool_call_budget");
    s.task.usage[kind==="model"?"modelCalls":"toolCalls"]++;
    if(kind==="tool"&&s.task.kind==="project_understanding"&&s.task.project.checkpoint)s.task.project.checkpoint.used=s.task.usage.toolCalls-projectPrivate(projectStore(s)).turnToolStart;
  }
  private armRootTimers(state:Awaited<ReturnType<AgentTaskKernel["rootState"]>>){
    const running=[...state.members.values()].filter(member=>member.lastActiveAt!==undefined&&member.task.status==="running"&&this.active.has(member.task.id));
    // Concurrent turns consume aggregate active time, not a fresh wall clock per child.
    const remaining=Math.max(1,Math.floor((state.ledger.budget.maxActiveMs-state.ledger.usage.activeMs)/Math.max(1,running.length)));
    for(const member of running){const active=this.active.get(member.task.id)!;clearTimeout(active.elapsedTimer);
      active.elapsedTimer=setTimeout(()=>void this.stopActive(member.task.id,active,"budget_exhausted","active_time_budget"),remaining);active.elapsedTimer.unref?.();}
  }
  private async changeAny(id:string,fn:AnyChange,access?:CareerTaskAccess){return this.atomic(async()=>{await this.assertAccess(access);const s=await this.loadAny(id);const change=await fn(s);await this.assertAccess(access);if(change!==false)await this.save(s);return this.view(s);});}
  private async change(id:string,fn:Change,access?:CareerTaskAccess){return this.atomic(async()=>{await this.assertAccess(access);const s=await this.load(id);const change=await fn(s);await this.assertAccess(access);if(change!==false)await this.save(s);return this.view(s);});}
  async get(id:string){return this.atomic(async()=>this.view(await this.load(id)));}
  createTask(input:CareerTaskCreate,access?:CareerTaskAccess):Promise<CareerTask>;
  createTask(input:FreeChatTaskCreate,access?:CareerTaskAccess):Promise<FreeChatTask>;
  createTask(input:ExperienceRefineTaskCreate,access?:CareerTaskAccess):Promise<ExperienceRefineTask>;
  createTask(input:ProjectUnderstandingTaskCreate,access?:CareerTaskAccess):Promise<ProjectUnderstandingTask>;
  createTask(input:JdMatchTaskCreate,access?:CareerTaskAccess):Promise<JdMatchTask>;
  createTask(input:MockInterviewTaskCreate,access?:CareerTaskAccess):Promise<MockInterviewTask>;
  createTask(input:CoachGuidanceTaskCreate,access?:CareerTaskAccess):Promise<CoachGuidanceTask>;
  createTask(input:InventoryTaskCreate,access?:CareerTaskAccess):Promise<InventoryTask>;
  createTask(input:JdIntakeTaskCreate,access?:CareerTaskAccess):Promise<JdIntakeTask>;
  createTask(input:JdOcrTaskCreate,access?:CareerTaskAccess):Promise<JdOcrTask>;
  createTask(input:StudioCommitteeTaskCreate,access?:CareerTaskAccess):Promise<StudioCommitteeTask>;
  createTask(input:GrowthPracticeTaskCreate,access?:CareerTaskAccess):Promise<GrowthPracticeTask>;
  createTask(input:AgentTaskCreate,access?:CareerTaskAccess):Promise<AgentTask>;
  createTask(input:AgentTaskCreate,access?:CareerTaskAccess){
    if(input.kind==="career_inventory")return this.createInventory(input,access);
    return input.kind==="growth_practice"?this.createGrowthPractice(input,access):input.kind==="studio_committee"?this.createStudioCommittee(input,access):input.kind==="studio_analysis"?this.createStudioAnalysis(input,access):input.kind==="jd_ocr"?this.createOcr(input,access):input.kind==="jd_intake"?this.createIntake(input,access):input.kind==="career_coach"?this.createCoach(input,access):input.kind==="mock_interview"?this.createInterview(input,access):input.kind==="jd_match"?this.createJdMatch(input,access):input.kind==="project_understanding"?this.createProject(input,access):input.kind==="free_chat"||input.kind==="experience_refine"?this.createConversation(input,access):this.create(input as CareerTaskCreate,access);}
  private async createInventory(input:InventoryTaskCreate,access?:CareerTaskAccess){
    const data=InventoryTaskCreateSchema.parse(input), id=inventoryProbeTaskId(this.opts.ownerId,data.idempotencyKey), inputHash=digest(data);
    return this.atomic(async()=>{
      await this.assertAccess(access);const prior=await readPrivateJson(this.file(id));
      if(prior){const s=await this.loadAny(id);if(s.inputHash!==inputHash || s.task.kind!=="career_inventory")fail("idempotency_conflict");return this.view(s as Store<InventoryTask>);}
      const lineage=await this.lineage(id,data.parentTaskId,data.runtimeBinding,input.budget,data.rootScopeKey),at=date();
      const task:InventoryTask={kind:"career_inventory",id,ownerId:this.opts.ownerId,workspaceKey:data.workspaceKey,objective:data.objective,
        revision:0,status:"ready",createdAt:at,updatedAt:at,request:data.request,sourceFingerprint:digest(data.request),runtimeBinding:data.runtimeBinding,
        budget:data.budget,...lineage,turn:1,events:[],usage:{modelCalls:0,toolCalls:0,activeMs:0}};
      event(task,"created","One selected question and draft response only; no ledger, resume write or tools.");
      const s:Store<InventoryTask>={schema:1,task,grants:[],inputHash,recent:[],runGeneration:0};await this.save(s);return this.view(s);
    });
  }
  private async validateCommittee(task:StudioCommitteeTask,access?:CareerTaskAccess){
    if(!access||!this.opts.validateStudioCommittee)fail("studio_committee_authority_required",422);
    const context=await this.opts.validateStudioCommittee(task,access);await this.assertAccess(access);return context;
  }
  private async createStudioCommittee(input:StudioCommitteeTaskCreate,access?:CareerTaskAccess){
    const data=StudioCommitteeTaskCreateSchema.parse(input),id=`ct_${digest([this.opts.ownerId,data.idempotencyKey]).slice(0,32)}`,inputHash=digest(data);
    if(Buffer.byteLength(JSON.stringify(data.request))>600_000||containsGitEvidenceSecret(JSON.stringify(data.request)))fail("studio_sensitive_or_large_model_input",400);
    return this.atomic(async()=>{
      await this.assertAccess(access);const previous=await readPrivateJson(this.file(id)) as AnyStore|undefined;
      if(previous){if(previous.inputHash!==inputHash)fail("idempotency_conflict");const stored=await this.loadAny(id);if(stored.task.kind!=="studio_committee")fail("task_kind_not_supported_by_operation",422);return this.view(stored as Store<StudioCommitteeTask>);}
      const at=date(),task:StudioCommitteeTask={id,ownerId:this.opts.ownerId,kind:"studio_committee",workspaceKey:data.workspaceKey,rootScopeKey:data.rootScopeKey,objective:data.objective,status:"ready",revision:0,createdAt:at,updatedAt:at,
        request:data.request,turn:1,sourceFingerprint:digest(data.request),runtimeBinding:data.runtimeBinding,budget:data.budget,usage:{modelCalls:0,toolCalls:0,activeMs:0},events:[]};
      await this.validateCommittee(task,access);Object.assign(task,await this.lineage(id,data.parentTaskId,data.runtimeBinding,input.budget,data.rootScopeKey));
      event(task,"created","Frozen committee selection; every role, repair, grant and evidence read belongs to the existing root ledger. No review or adoption yet.");
      const stored:Store<StudioCommitteeTask>={schema:1,task,grants:[],inputHash,recent:[],runGeneration:0};await this.save(stored);return this.view(stored);
    });
  }
  private async committeeCurrent(id:string,access:CareerTaskAccess,requireCompleted:boolean,readSources=true){return this.atomic(async()=>{
    await this.assertAccess(access);const stored=await this.loadAny(id);
    if(stored.task.kind!=="studio_committee")fail("task_kind_not_supported_by_operation",422);
    const context=await this.validateCommittee(stored.task,access);
    if(requireCompleted&&(stored.task.status!=="completed"||stored.task.result?.status!=="completed"||!stored.committeeState))fail("studio_committee_completed_required",409);
    const prepared=stored.committeeState;
    let reads:Awaited<ReturnType<typeof revalidateCommitteeSources>>=[];
    if(prepared){await validateCommitteeSnapshot(prepared.snapshot);
      const snapshot=prepared.snapshot;
      if(snapshot.binding.ownerId!==stored.task.ownerId||snapshot.binding.workspaceId!==context.workspaceKey||snapshot.binding.resumeId!==context.resumeId
        ||snapshot.binding.resumeRevision!==context.sourceFingerprint||snapshot.binding.sessionGeneration!==context.session||snapshot.authorization.grantId!==id
        ||Date.parse(snapshot.authorization.expiresAt)<=Date.now()||stored.task.result&&(stored.task.result.snapshotFingerprint!==snapshot.fingerprint||digest(stored.task.result.binding)!==digest(snapshot.binding)))fail("invalid_committee_checkpoint",503);
      if(readSources)reads=await revalidateCommitteeSources(prepared.sources,this.broker,new AbortController().signal,async detail=>{
        await this.reserve(stored,"tool");event(stored.task,"tool_call",detail);await this.save(stored);
      });}
    await this.validateCommittee(stored.task,access);return {task:await this.view(stored as Store<StudioCommitteeTask>),snapshot:prepared?.snapshot,reads};
  });}
  async currentStudioCommittee(id:string,access:CareerTaskAccess){return (await this.committeeCurrent(id,access,false)).task;}
  /** Authorized frozen catalog, not a source reread or an adoption receipt. */
  async describeStudioCommittee(id:string,access:CareerTaskAccess){const current=await this.committeeCurrent(id,access,true,false);return {task:current.task,snapshot:current.snapshot!};}
  /** Trusted in-process handoff; no copied SQLite record can authorize adoption. */
  async reviewStudioCommittee(id:string,access:CareerTaskAccess){const current=await this.committeeCurrent(id,access,true);return {...current,snapshot:current.snapshot!};}
  private async validateStudio(task:StudioAnalysisTask,access?:CareerTaskAccess){
    if(!access||!this.opts.validateStudioAnalysis)fail("studio_analysis_authority_required",422);
    await this.opts.validateStudioAnalysis(task,access);await this.assertAccess(access);
  }
  async currentStudioAnalysis(id:string,access:CareerTaskAccess){return this.atomic(async()=>{
    await this.assertAccess(access);const stored=await this.loadAny(id);
    if(stored.task.kind!=="studio_analysis")fail("task_kind_not_supported_by_operation",422);
    await this.validateStudio(stored.task,access);return this.view(stored);
  });}
  private async createStudioAnalysis(input:StudioAnalysisTaskCreate,access?:CareerTaskAccess){
    const data=StudioAnalysisTaskCreateSchema.parse(input),id=`ct_${digest([this.opts.ownerId,data.idempotencyKey]).slice(0,32)}`,inputHash=digest(data);
    if(Buffer.byteLength(JSON.stringify(data.request.payload))>96_000||containsGitEvidenceSecret(JSON.stringify(data.request.payload)))fail("studio_sensitive_or_large_model_input",400);
    try{studioAnalysisOutputSchema(data.request.payload.contract);}catch{fail("invalid_studio_output_contract",400);}
    return this.atomic(async()=>{
      await this.assertAccess(access);const previous=await readPrivateJson(this.file(id)) as AnyStore|undefined;
      if(previous){if(previous.inputHash!==inputHash)fail("idempotency_conflict");const stored=await this.loadAny(id);if(stored.task.kind!=="studio_analysis")fail("task_kind_not_supported_by_operation",422);return this.view(stored as Store<StudioAnalysisTask>);}
      const at=date(),task:StudioAnalysisTask={id,ownerId:this.opts.ownerId,kind:"studio_analysis",workspaceKey:data.workspaceKey,rootScopeKey:data.rootScopeKey,objective:data.objective,status:"ready",revision:0,createdAt:at,updatedAt:at,
        request:data.request,turn:1,sourceFingerprint:digest(data.request),runtimeBinding:data.runtimeBinding,budget:data.budget,usage:{modelCalls:0,toolCalls:0,activeMs:0},events:[]};
      await this.validateStudio(task,access);
      Object.assign(task,await this.lineage(id,data.parentTaskId,data.runtimeBinding,input.budget,data.rootScopeKey));
      event(task,"created","Frozen Studio purpose, complete data and output contract; original workspace root owns all execution charges. No analysis or business adoption.");
      const stored:Store<StudioAnalysisTask>={schema:1,task,grants:[],inputHash,recent:[],runGeneration:0};await this.save(stored);return this.view(stored);
    });
  }
  readTask(id:string){return this.atomic(async()=>this.view(await this.loadAny(id)));}
  dispatch(id:string,command:AgentTaskCommand,expectedRevision:number,access:CareerTaskAccess){
    if(command.kind==="pause"||command.kind==="revoke")return this.stop(id,expectedRevision,command.kind==="revoke",access);
    if(command.kind==="budget")return this.budget(id,expectedRevision,command.budget,access);
    if("input" in command)return this.run(id,command.kind,{...command.input,expectedRevision},command.runtime,access);
    return fail("invalid_task_command",422);
  }
  async watch(id:string,afterSequence=0){
    if(!Number.isSafeInteger(afterSequence)||afterSequence<0)fail("invalid_event_cursor",422);
    const task=await this.readTask(id);return {task,taskId:id,cursor:task.events.at(-1)?.sequence??0,events:task.events.filter(e=>e.sequence>afterSequence)};
  }
  async list(){return this.atomic(async()=>{const names=await fs.readdir(this.opts.directory).catch((e:NodeJS.ErrnoException)=>{if(e.code==="ENOENT")return [];throw e;});
    const tasks:CareerTask[]=[];for(const name of names.filter(s=>/^ct_[a-f0-9]{32}\.json$/.test(s))){const s=await this.loadAny(name.slice(0,-5));if(isCareerTask(s.task))tasks.push(await this.view(s as Store));}
    return tasks.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));});}
  async listTasks(){return this.atomic(async()=>{const names=await fs.readdir(this.opts.directory).catch((e:NodeJS.ErrnoException)=>{if(e.code==="ENOENT")return [];throw e;});
    const tasks:AgentTask[]=[];for(const name of names.filter(s=>/^ct_[a-f0-9]{32}\.json$/.test(s)))tasks.push(await this.view(await this.loadAny(name.slice(0,-5))));
    return tasks.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));});}
  private async readSummaryEntry(id: string, cached?: TaskSummaryEntry): Promise<TaskSummaryEntry | undefined> {
    const filename = this.file(id);
    let meta = await this.statPrivateStore(filename);
    if (cached && sameTaskFile(cached.meta, meta)) return cached;
    // A write replaces the file atomically. If the file changed while it was
    // being read, refresh once. The writer's committed index entry wins below.
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await readPrivateJson(filename);
      if (raw === undefined) return undefined;
      const row = taskSummary(this.checkedPrivateStore(id, raw).task);
      const observed = await this.statPrivateStore(filename);
      if (sameTaskFile(meta, observed) || !meta && !observed) return { meta: observed, task: row };
      const committed = this.summaryIndex.get(id);
      if (committed && sameTaskFile(committed.meta, observed)) return committed;
      meta = observed;
    }
    fail("task_summary_changed", 503);
  }
  private async refreshTaskSummary(): Promise<AgentTaskListSummary> {
    if (this.closed) fail("host_stopped", 503);
    // The per-owner writer lease is needed to attribute live runs to this host.
    // Acquire it before a cold read, not once per archive or poll.
    if (!this.writer) await this.atomic(async () => {});
    const baseline = new Map(this.summaryIndex);
    const names = (await fs.readdir(this.opts.directory)).filter(name => /^ct_[a-f0-9]{32}\.json$/.test(name));
    const seen = new Set<string>();
    // Sequential async file reads bound I/O and never occupy the mutation queue.
    // A warm entry needs only metadata validation, no full-store parse or clone.
    for (const name of names) {
      const id = name.slice(0, -5);
      seen.add(id);
      const entry = await this.readSummaryEntry(id, this.summaryIndex.get(id));
      if (this.closed) fail("host_stopped", 503);
      // Preserve newer entries published by the writer during the scan.
      if (this.summaryIndex.get(id) === baseline.get(id)) {
        if (entry) this.summaryIndex.set(id, entry);
        else this.summaryIndex.delete(id);
      }
    }
    for (const [id, previous] of baseline) {
      if (!seen.has(id) && this.summaryIndex.get(id) === previous) this.summaryIndex.delete(id);
    }
    if (this.closed) fail("host_stopped", 503);
    const summary: AgentTaskListSummary = {
      ownerId: this.opts.ownerId, totalTasks: 0, readyCount: 0, runningCount: 0, awaitingCount: 0,
      completedCount: 0, pausedCount: 0, failedCount: 0, tasks: [], recentByKind: [],
    };
    const rows = [...this.summaryIndex.values()].map(({ task }) => ({
      ...task,
      status: task.status === "running" && !this.active.has(task.id) ? "interrupted" as const : task.status,
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const kindCounts = new Map<AgentTaskSummary["kind"], number>();
    for (const row of rows) {
      summary.totalTasks++;
      if (row.status === "ready") summary.readyCount++;
      else if (row.status === "running") summary.runningCount++;
      else if (row.status === "awaiting_answer" || row.status === "awaiting_review") summary.awaitingCount++;
      else if (row.status === "completed") summary.completedCount++;
      else if (row.status === "paused") summary.pausedCount++;
      else summary.failedCount++;
      const count = kindCounts.get(row.kind) ?? 0;
      if (count < AGENT_TASK_STAGE_SUMMARY_LIMIT) {
        summary.recentByKind.push(row);
        kindCounts.set(row.kind, count + 1);
      }
    }
    summary.tasks = rows.slice(0, AGENT_TASK_SUMMARY_LIMIT);
    return summary;
  }
  listTaskSummary(): Promise<AgentTaskListSummary> {
    if (this.summaryRefresh) return this.summaryRefresh;
    const result = this.refreshTaskSummary().finally(() => { this.summaryRefresh = undefined; });
    this.summaryRefresh = result;
    return result;
  }
  private async createOcr(input:JdOcrTaskCreate,access?:CareerTaskAccess){
    const data=JdOcrTaskCreateSchema.parse(input),id=`ct_${digest([this.opts.ownerId,data.idempotencyKey]).slice(0,32)}`,inputHash=digest(data);
    return this.atomic(async()=>{
      await this.assertAccess(access);const previous=await readPrivateJson(this.file(id)) as AnyStore|undefined;
      if(previous){if(previous.inputHash!==inputHash)fail("idempotency_conflict");const stored=await this.loadAny(id);if(stored.task.kind!=="jd_ocr")fail("task_kind_not_supported_by_operation",422);return this.view(stored as Store<JdOcrTask>);}
      const lineage=await this.lineage(id,data.parentTaskId,data.runtimeBinding,input.budget,data.rootScopeKey),at=date();
      const task:JdOcrTask={id,ownerId:this.opts.ownerId,kind:"jd_ocr",workspaceKey:data.workspaceKey,objective:data.objective,status:"ready",revision:0,createdAt:at,updatedAt:at,
        request:data.request,uploadedImageIds:[],turn:1,sourceFingerprint:digest(data.request),runtimeBinding:data.runtimeBinding,budget:data.budget,...lineage,usage:{modelCalls:0,toolCalls:0,activeMs:0},events:[]};
      event(task,"created","Frozen complete screenshot manifest; private task-owned uploads required before inference. No source or business record is adopted.");
      const stored:Store<JdOcrTask>={schema:1,task,grants:[],inputHash,recent:[],runGeneration:0};await this.save(stored);return this.view(stored);
    });
  }
  async uploadOcrImage(id:string,imageId:string,input:JdOcrUpload,access:CareerTaskAccess){
    const data=JdOcrUploadSchema.parse(input);
    return this.changeAny(id,async s=>{
      const task=s.task;if(task.kind!=="jd_ocr")fail("task_kind_not_supported_by_operation",422);
      checkRevision(s,data.expectedRevision);if(task.sourceFingerprint!==data.sourceFingerprint)fail("source_changed_new_comparison_required");
      if(this.active.has(id)||!["ready","paused","interrupted","failed","budget_exhausted"].includes(task.status))fail("task_image_upload_not_allowed");
      const image=task.request.images.find(item=>item.id===imageId);if(!image)fail("task_image_not_found",404);
      if(task.uploadedImageIds.includes(imageId)){
        if((await this.images.read(id,image!)).dataUrl!==data.dataUrl)fail("task_image_manifest_mismatch",422);
        return false;
      }
      await this.images.put(id,image!,data.dataUrl);await this.assertAccess(access);
      task.uploadedImageIds.push(imageId);event(task,"decision",`Verified immutable original image ${imageId}; no inference or model charge.`);
    },access);
  }
  async readOcrImage(id:string,imageId:string,access:CareerTaskAccess){return this.atomic(async()=>{
    await this.assertAccess(access);const task=(await this.loadAny(id)).task;
    if(task.kind!=="jd_ocr")fail("task_kind_not_supported_by_operation",422);
    const image=task.request.images.find(item=>item.id===imageId);if(!image||!task.uploadedImageIds.includes(imageId))fail("task_image_not_found",404);
    const input=await this.images.read(id,image!);await this.assertAccess(access);return {image:image!,dataUrl:input.dataUrl};
  });}
  private async createGrowthPractice(input:GrowthPracticeTaskCreate,access?:CareerTaskAccess){
    const data=GrowthPracticeTaskCreateSchema.parse(input),id=`ct_${digest([this.opts.ownerId,data.idempotencyKey]).slice(0,32)}`,inputHash=digest(data);
    return this.atomic(async()=>{
      await this.assertAccess(access);const previous=await readPrivateJson(this.file(id)) as AnyStore|undefined;
      if(previous){if(previous.inputHash!==inputHash)fail("idempotency_conflict");return this.view(growthPracticeStore(await this.loadAny(id)));}
      const lineage=await this.lineage(id,data.parentTaskId,data.runtimeBinding,input.budget,data.rootScopeKey),at=date();
      const task:GrowthPracticeTask={id,ownerId:this.opts.ownerId,kind:"growth_practice",workspaceKey:data.workspaceKey,objective:data.objective,status:"ready",revision:0,createdAt:at,updatedAt:at,
        request:data.request,sourceFingerprint:digest(data.request),runtimeBinding:data.runtimeBinding,budget:data.budget,...lineage,
        usage:{modelCalls:0,toolCalls:0,activeMs:0},events:[],practice:{phase:"ready"}};
      event(task,"created","Frozen synthetic source, learner answer, code and acceptance contract; no model, career data or lookup executed.");
      const stored:Store<GrowthPracticeTask>={schema:1,task,grants:[],inputHash,recent:[],runGeneration:0};await this.save(stored);return this.view(stored);
    });
  }
  async stepGrowthPractice(id:string,input:GrowthPracticeStep,access?:CareerTaskAccess){
    const data=GrowthPracticeStepSchema.parse(input);
    return this.atomic(async()=>{
      await this.assertAccess(access);const s=growthPracticeStore(await this.loadAny(id)),task=s.task;
      checkRevision(s,data.expectedRevision);if(data.sourceFingerprint!==task.sourceFingerprint)fail("source_changed_new_comparison_required");
      if(task.practice.phase==="outcome_unknown")fail("growth_practice_lookup_outcome_unknown",409);
      const failed=async(code:string,status:"failed"|"budget_exhausted"="failed")=>{charge(s);delete s.lastActiveAt;task.practice.phase="failed";task.practice.error=code;stage(task,status,code);event(task,"stopped",code);await this.save(s);return this.view(s);};
      const interrupted=async(error:unknown):Promise<never>=>{const code=safeCode(error);charge(s);delete s.lastActiveAt;task.practice.error=code;
        stage(task,"interrupted",code);event(task,"stopped","Authorization ended before the bounded synthetic step could be committed; no later result was adopted.");await this.save(s);throw error;};
      try{
      if(task.practice.phase==="ready"){
        if(!["ready","paused","interrupted"].includes(task.status))fail("growth_practice_not_runnable");
        await this.checkRoot(s,undefined,true);s.runGeneration++;s.lastActiveAt=Date.now();stage(task,"running");delete task.practice.error;
        event(task,"started","Synthetic practice decision started in QuickJS; no model, filesystem, network or career source is available.");
        await this.reserve(s,"tool");event(task,"tool_call","Evaluate the frozen learner source in the bounded QuickJS profile.");await this.save(s);
        try{await this.assertAccess(access);}catch(error){return interrupted(error);}
        let decision;
        try{decision=await runGrowthPracticeDecision(task.request.sourceCode,growthPracticeInput(task,null));}
        catch{return failed("growth_practice_source_rejected");}
        if(decision.kind!=="lookup"||decision.noteId!==task.request.sourceId)return failed("growth_practice_lookup_required");
        try{await this.assertAccess(access);}catch(error){return interrupted(error);}
        task.practice.phase="outcome_unknown";
        await this.reserve(s,"tool");event(task,"tool_call",`Dispatch the one allowlisted read-only lookup ${task.request.sourceId}; an unconfirmed outcome is never retried automatically.`);await this.save(s);
        let result:string,dispatched=false;
        try{await this.assertAccess(access);dispatched=true;
          result=await (this.opts.growthPracticeLookup?.({taskId:task.id,sourceId:task.request.sourceId,sourceText:task.request.sourceText,sourceHash:task.request.sourceHash})??Promise.resolve(lookupGrowthPracticeSource(task,decision.noteId)));await this.assertAccess(access);}
        catch(error){if(!dispatched){task.practice.phase="ready";return interrupted(error);}
          charge(s);delete s.lastActiveAt;task.practice.error="growth_practice_lookup_outcome_unknown";stage(task,"interrupted","growth_practice_lookup_outcome_unknown");event(task,"stopped","Lookup was dispatched but no durable result was confirmed; retained as unknown and not retried.");await this.save(s);return this.view(s);}
        if(result!==task.request.sourceText||digest(result)!==task.request.sourceHash)return failed("growth_practice_lookup_result_mismatch");
        task.practice={phase:"lookup_saved",checkpoint:{stepId:"lookup-note-v1",noteId:task.request.sourceId,result,resultHash:digest(result),lookupCalls:1,savedAt:date()}};
        charge(s);delete s.lastActiveAt;stage(task,"awaiting_review");event(task,"tool_result","Exact synthetic note and hash saved as a checkpoint; reopening performs GET only and cannot dispatch lookup again.");await this.save(s);return this.view(s);
      }
      if(task.practice.phase!=="lookup_saved"||!["awaiting_review","interrupted"].includes(task.status)||!task.practice.checkpoint)fail("growth_practice_not_runnable");
      const checkpoint=structuredClone(task.practice.checkpoint);s.runGeneration++;s.lastActiveAt=Date.now();stage(task,"running");
      event(task,"started","Independent frozen verification started from the saved checkpoint; the original lookup is not available to this phase.");await this.save(s);
      try{
        const verification=await verifyGrowthPractice(task,checkpoint,async(decisionInput,label)=>{
          await this.assertAccess(access);
          await this.reserve(s,"tool");event(task,"tool_call",`QuickJS frozen check: ${label}`);await this.save(s);
          await this.assertAccess(access);
          return runGrowthPracticeDecision(task.request.sourceCode,decisionInput);
        });
        await this.assertAccess(access);charge(s);delete s.lastActiveAt;task.practice.verification=verification;task.practice.verificationHash=growthPracticeVerificationHash(verification);
        if(isVerifiedGrowthPractice(verification)){task.practice.phase="verified";delete task.practice.error;stage(task,"completed");event(task,"receipt","All four frozen checks passed against the exact code, answer, source and checkpoint; this is practice evidence, not production experience.");}
        else{task.practice.phase="failed";task.practice.error="growth_practice_verification_failed";stage(task,"failed","growth_practice_verification_failed");event(task,"receipt","Frozen verification failed; no competency or project acceptance may be claimed.");}
        await this.save(s);return this.view(s);
      }catch(error){const code=safeCode(error);if(["tool_call_budget","model_call_budget","active_time_budget"].includes(code))throw error;
        return code==="interaction_lease_invalid"?interrupted(error):failed("growth_practice_verifier_failed");}
      }catch(error){const code=safeCode(error);if(["tool_call_budget","model_call_budget","active_time_budget"].includes(code))return failed(code,"budget_exhausted");throw error;}
    });
  }
  private async createIntake(input:JdIntakeTaskCreate,access?:CareerTaskAccess){
    const data=JdIntakeTaskCreateSchema.parse(input),id=`ct_${digest([this.opts.ownerId,data.idempotencyKey]).slice(0,32)}`,inputHash=digest(data);
    return this.atomic(async()=>{
      await this.assertAccess(access);const previous=await readPrivateJson(this.file(id)) as AnyStore|undefined;
      if(previous){if(previous.inputHash!==inputHash)fail("idempotency_conflict");const stored=await this.loadAny(id);if(stored.task.kind!=="jd_intake")fail("task_kind_not_supported_by_operation",422);return this.view(stored as Store<JdIntakeTask>);}
      const lineage=await this.lineage(id,data.parentTaskId,data.runtimeBinding,input.budget,data.rootScopeKey),at=date();
      const task:JdIntakeTask={id,ownerId:this.opts.ownerId,kind:"jd_intake",workspaceKey:data.workspaceKey,objective:data.objective,status:"ready",revision:0,createdAt:at,updatedAt:at,
        request:data.request,turn:1,sourceFingerprint:digest(data.request),runtimeBinding:data.runtimeBinding,budget:data.budget,...lineage,usage:{modelCalls:0,toolCalls:0,activeMs:0},events:[]};
      event(task,"created","Frozen complete job source; no inference, browser access or business adoption.");
      const stored:Store<JdIntakeTask>={schema:1,task,grants:[],inputHash,recent:[],runGeneration:0};await this.save(stored);return this.view(stored);
    });
  }
  private async createCoach(input:CoachGuidanceTaskCreate,access?:CareerTaskAccess){
    const data=CoachGuidanceTaskCreateSchema.parse(input),id=`ct_${digest([this.opts.ownerId,data.idempotencyKey]).slice(0,32)}`,inputHash=digest(data);
    try{data.request=validateCoachRequest(data.request);}catch{fail("invalid_coach_request",422);}
    if(!data.request.settings.goal.trim())fail("coach_goal_required",422);
    if(data.request.mode==="plan"&&!data.request.confirmedGoal)fail("coach_goal_confirmation_required",422);
    return this.atomic(async()=>{
      await this.assertAccess(access);const previous=await readPrivateJson(this.file(id)) as AnyStore|undefined;
      if(previous){if(previous.inputHash!==inputHash)fail("idempotency_conflict");const stored=await this.loadAny(id);if(stored.task.kind!=="career_coach")fail("task_kind_not_supported_by_operation",422);return this.view(stored as Store<CoachGuidanceTask>);}
      const lineage=await this.lineage(id,data.parentTaskId,data.runtimeBinding,input.budget,data.rootScopeKey),at=date();
      const task:CoachGuidanceTask={id,ownerId:this.opts.ownerId,kind:"career_coach",workspaceKey:data.workspaceKey,objective:data.objective,status:"ready",revision:0,createdAt:at,updatedAt:at,
        request:data.request,turn:1,sourceFingerprint:digest(data.request),runtimeBinding:data.runtimeBinding,budget:data.budget,...lineage,usage:{modelCalls:0,toolCalls:0,activeMs:0},events:[]};
      event(task,"created","Frozen coaching operation and explicitly shared material; no inference, tools, certification or business adoption.");
      const stored:Store<CoachGuidanceTask>={schema:1,task,grants:[],inputHash,recent:[],runGeneration:0};await this.save(stored);return this.view(stored);
    });
  }
  private async createProject(input:ProjectUnderstandingTaskCreate,access?:CareerTaskAccess){
    const data=ProjectUnderstandingTaskCreateSchema.parse(input),id=`ct_${digest([this.opts.ownerId,data.idempotencyKey]).slice(0,32)}`,inputHash=digest(data);
    return this.atomic(async()=>{
      await this.assertAccess(access);const previous=await readPrivateJson(this.file(id)) as AnyStore|undefined;
      if(previous){if(previous.inputHash!==inputHash)fail("idempotency_conflict");return this.view(projectStore(await this.loadAny(id)));}
      const lineage=await this.lineage(id,data.parentTaskId,data.runtimeBinding,input.budget,data.rootScopeKey),at=date();
      const task:ProjectUnderstandingTask={id,ownerId:this.opts.ownerId,kind:"project_understanding",workspaceKey:data.workspaceKey,objective:data.objective,status:"ready",revision:0,createdAt:at,updatedAt:at,
        sourceFingerprint:digest(data.project),runtimeBinding:data.runtimeBinding,budget:data.budget,...lineage,usage:{modelCalls:0,toolCalls:0,activeMs:0},events:[],
        project:{version:1,id,workspaceKey:data.workspaceKey,...data.project,revision:0,phase:"idle",turnCount:0,createdAt:at,updatedAt:at,grants:[],evidence:[],events:[],messages:[{id:`msg_${randomUUID()}`,role:"user",text:data.project.sourceText,at}]}};
      event(task,"created","Exact project source granted; no filesystem read, model send or personal claim confirmed.");
      const stored:Store<ProjectUnderstandingTask>={schema:1,task,grants:[],inputHash,recent:[],runGeneration:0};projectPrivate(stored);await this.save(stored);return this.view(stored);
    });
  }
  private async createJdMatch(input:JdMatchTaskCreate,access?:CareerTaskAccess){
    const data=JdMatchTaskCreateSchema.parse(input),id=`ct_${digest([this.opts.ownerId,data.idempotencyKey]).slice(0,32)}`,inputHash=digest(data);
    return this.atomic(async()=>{
      await this.assertAccess(access);const previous=await readPrivateJson(this.file(id)) as AnyStore|undefined;
      if(previous){if(previous.inputHash!==inputHash)fail("idempotency_conflict");return this.view(jdStore(await this.loadAny(id)));}
      const lineage=await this.lineage(id,data.parentTaskId,data.runtimeBinding,input.budget,data.rootScopeKey),at=date();
      const task:JdMatchTask={id,ownerId:this.opts.ownerId,kind:"jd_match",workspaceKey:data.workspaceKey,objective:data.objective,status:"ready",revision:0,createdAt:at,updatedAt:at,
        matching:data.matching,structuredJd:structureMatchJd(data.matching.rawJd),evidence:jdMatchEvidence(data.matching),sourceFingerprint:digest(data.matching),
        runtimeBinding:data.runtimeBinding,budget:data.budget,...lineage,usage:{modelCalls:0,toolCalls:0,activeMs:0},events:[]};
      if(!jdMatchItems(task).length)fail("jd_body_required",422);
      event(task,"created","Exact JD and self-reported claims granted. Deterministic decomposition, no model call or independent verification.");
      const s:Store<JdMatchTask>={schema:1,task,grants:[],inputHash,recent:[],runGeneration:0};await this.save(s);return this.view(s);
    });
  }
  private async createInterview(input:MockInterviewTaskCreate,access?:CareerTaskAccess){
    const data=MockInterviewTaskCreateSchema.parse(input),id=`ct_${digest([this.opts.ownerId,data.idempotencyKey]).slice(0,32)}`,inputHash=digest(data);
    return this.atomic(async()=>{
      await this.assertAccess(access);const previous=await readPrivateJson(this.file(id)) as AnyStore|undefined;
      if(previous){if(previous.inputHash!==inputHash)fail("idempotency_conflict");return this.view(interviewStore(await this.loadAny(id)));}
      const parent=jdStore(await this.loadAny(data.parentTaskId));
      if(parent.task.sourceFingerprint!==data.parentSourceFingerprint)fail("interview_parent_source_changed");
      const lineage=await this.lineage(id,parent.task.id,data.runtimeBinding,input.budget,data.rootScopeKey),at=date();
      const matching=structuredClone(parent.task.matching),focus=structuredClone(data.focus);
      const task:MockInterviewTask={id,ownerId:this.opts.ownerId,kind:"mock_interview",workspaceKey:data.workspaceKey,objective:data.objective,status:"ready",revision:0,createdAt:at,updatedAt:at,
        runtimeBinding:data.runtimeBinding,budget:data.budget,...lineage,usage:{modelCalls:0,toolCalls:0,activeMs:0},events:[],
        matching,sourceFingerprint:digest([parent.task.id,parent.task.sourceFingerprint,focus]),conversation:{messages:[]},turn:1,evidence:jdMatchEvidence(matching),
        interview:{focus,parentSourceFingerprint:parent.task.sourceFingerprint,phase:"interview"}};
      event(task,"created","Explicit interview grant copied the exact parent JD/self-report material; no model call, new root, fact or resume write.");
      const s:Store<MockInterviewTask>={schema:1,task,grants:[],inputHash,recent:[],runGeneration:0};await this.save(s);return this.view(s);
    });
  }
  async reviewJdMatch(id:string,revision:number,decisions:z.infer<typeof JdMatchReviewSchema>,access?:CareerTaskAccess){
    const parsed=JdMatchReviewSchema.parse(decisions);
    return this.changeAny(id,raw=>{const s=jdStore(raw);checkRevision(s,revision);
      if(s.task.status!=="awaiting_review"||!s.task.result)fail("jd_review_not_ready");
      const ids=s.task.result!.proposals.map(item=>item.id);
      if(ids.length!==Object.keys(parsed).length||ids.some(id=>!Object.hasOwn(parsed,id)))fail("review_decisions_must_match_proposals",422);
      s.task.review=parsed;hold(s,"completed");event(s.task,"receipt","User reviewed all JD proposals; no resume or FactBase write, inference, or automatic adoption.");
    },access);
  }
  async replayProjectTurn(id:string,input:UnderstandingTurnInput,access?:CareerTaskAccess){
    const turn=UnderstandingTurnSchema.parse(input);return this.atomic(async()=>{await this.assertAccess(access);const s=projectStore(await this.loadAny(id));return projectReplay(s,turn)?this.view(s):undefined;});
  }
  private fenceProject(s:Store<ProjectUnderstandingTask>){
    const active=this.active.get(s.task.id);if(active){active.controller.abort("project_context_changed");this.drop(s.task.id,active);}
    charge(s);delete s.lastActiveAt;s.runGeneration++;
  }
  async updateProjectSource(id:string,revision:number,sourceText:string,access?:CareerTaskAccess){
    if(typeof sourceText!=="string"||!sourceText.trim()||sourceText.length>16000)fail("invalid_project_source",422);
    return this.changeAny(id,raw=>{const s=projectStore(raw);checkRevision(s,revision);if(s.task.status==="revoked")fail("task_revoked",403);
      if(s.task.project.sourceText===sourceText)return false;
      this.fenceProject(s);projectProtocol(s).replaceSource(s.task.project,sourceText);
      invalidateProject(s);s.task.sourceFingerprint=digest({projectKey:s.task.project.projectKey,label:s.task.project.label,sourceText});stage(s.task,"ready");event(s.task,"answer","User explicitly replaced project source on the same ledger; previous confirmation invalidated.");
    },access);
  }
  async grantProject(id:string,revision:number,explicitPath:string,access?:CareerTaskAccess){
    await this.assertAccess(access);const grant=await this.broker.grant(explicitPath);
    return this.changeAny(id,raw=>{const s=projectStore(raw);checkRevision(s,revision);if(s.task.status==="revoked")fail("task_revoked",403);
      if(s.grants.some(item=>!item.revokedAt&&item.path===grant.path))return false;
      this.fenceProject(s);s.grants.push(grant);s.task.project.grants=structuredClone(s.grants);invalidateProject(s);stage(s.task,"ready");event(s.task,"decision","User granted an exact source scope; no source content read or model dispatched.");
    },access);
  }
  async revokeProjectGrant(id:string,revision:number,grantId:string,access?:CareerTaskAccess){
    return this.changeAny(id,raw=>{const s=projectStore(raw);checkRevision(s,revision);const grant=s.grants.find(item=>item.id===grantId);if(!grant)fail("grant_unavailable",404);if(grant!.revokedAt)return false;
      this.fenceProject(s);grant!.revokedAt=date();s.task.project.grants=structuredClone(s.grants);invalidateProject(s);stage(s.task,"ready");
      event(s.task,"stopped","Source revoked. Complete private audit retained, but revoked evidence and derived agent/tool/model context excluded from future reasoning.");
    },access);
  }
  async cancelProject(id:string,expectedTurnCount:number,access?:CareerTaskAccess){
    return this.changeAny(id,raw=>{const s=projectStore(raw);if(s.task.project.turnCount!==expectedTurnCount)fail("stale_project_turn");
      if(s.task.status!=="running")return false;this.fenceProject(s);stage(s.task,"paused");event(s.task,"stopped","Project turn explicitly stopped; late output fenced and root usage retained.");
    },access);
  }
  async confirmProject(id:string,revision:number,summaryHash:string,access?:CareerTaskAccess){
    return this.changeAny(id,async raw=>{
      const s=projectStore(raw),session=s.task.project;checkRevision(s,revision);await this.checkRoot(s);
      if(s.task.status!=="awaiting_review"||session.phase!=="awaiting-confirmation"||session.question||!session.understanding||session.summaryHash!==summaryHash||understandingHash(session.understanding)!==summaryHash)fail("project_confirmation_changed");
      // Confirmation is also a source-sensitive boundary. Each verification is
      // durably charged before I/O, even if it fails or the owner signs out.
      for(const item of this.projectFiles(s)){
        const grant=s.grants.find(grant=>grant.id===item.grantId&&!grant.revokedAt);if(!grant)fail("source_changed_new_comparison_required");
        await this.reserve(s,"tool");event(s.task,"tool_call","Revalidate project source before human confirmation.");await this.save(s);
        let result:EvidenceResult|undefined;
        try{result=await this.broker.execute(grant!,{operation:"read",path:item.path,startLine:item.startLine,endLine:item.startLine});}catch{/* A missing or inaccessible source cannot be confirmed. */}
        await this.assertAccess(access);
        const verified=Boolean(result?.evidence.some(value=>value.hash===item.hash));
        this.recordProjectVerification(s,item,s.task.usage.toolCalls,"human_confirmation",verified);
        if(!verified){
          invalidateProject(s);hold(s,"paused","source_changed_new_comparison_required");await this.save(s);fail("source_changed_new_comparison_required");
        }
      }
      // Internal verification revisions never bypass the submitted human token;
      // the complete summary has not changed during these serialized checks.
      session.confirmation={revision:s.task.revision+1,summaryHash,confirmedAt:date()};hold(s,"completed");event(s.task,"receipt","User confirmed this exact complete project understanding, not personal contribution or production adoption.");
    },access);
  }
  private projectFiles(s:ProjectStore){
    return [...new Map(activeProjectEvidence(s).filter(item=>item.grantId!=="conversation").map(item=>[JSON.stringify([item.grantId,item.path,item.hash]),item])).values()];
  }
  private async createConversation(input:FreeChatTaskCreate|ExperienceRefineTaskCreate,access?:CareerTaskAccess){
    const data=input.kind==="experience_refine"?ExperienceRefineTaskCreateSchema.parse(input):FreeChatTaskCreateSchema.parse(input),id=`ct_${digest([this.opts.ownerId,data.idempotencyKey]).slice(0,32)}`,inputHash=digest(data);
    return this.atomic(async()=>{
      await this.assertAccess(access);const previous=await readPrivateJson(this.file(id)) as AnyStore|undefined;
      if(previous){if(previous.inputHash!==inputHash)fail("idempotency_conflict");const stored=await this.loadAny(id);if(!isConversationTask(stored.task))return fail("idempotency_conflict");return this.view(stored as Store<ConversationTask>);}
      const lineage=await this.lineage(id,data.parentTaskId,data.runtimeBinding,input.budget,data.rootScopeKey);
      const contract=data.kind==="free_chat"?data.responseContract:undefined;
      const candidateSource=data.kind==="free_chat"?data.candidateSource:undefined;
      const contractData={...(contract?{responseContract:contract}:{}),...(candidateSource?{candidateSource}:{})};
      const now=date(),task:ConversationTask={id,ownerId:this.opts.ownerId,...(data.kind==="experience_refine"?{kind:data.kind,refinement:data.refinement}:{kind:data.kind,...contractData}),workspaceKey:data.workspaceKey,objective:data.objective,status:"ready",revision:0,createdAt:now,updatedAt:now,
        conversation:data.conversation,sourceFingerprint:digest(data.kind==="experience_refine"?data.refinement:contract?{conversation:data.conversation,...contractData}:data.conversation),turn:1,runtimeBinding:data.runtimeBinding,budget:data.budget,...lineage,usage:{modelCalls:0,toolCalls:0,activeMs:0},events:[]};
      event(task,"created","Conversation and exact context granted; no fabricated JD, model request, tool or record write.");
      const stored={schema:1 as const,task,grants:[],inputHash,recent:[],runGeneration:0};await this.save(stored);return this.view(stored);
    });
  }
  async create(input:CareerTaskCreate,access?:CareerTaskAccess){
    const data=CareerTaskCreateSchema.parse(input),id=`ct_${digest([this.opts.ownerId,data.idempotencyKey]).slice(0,32)}`,inputHash=digest(data);
    if(data.workflow&&data.directories.length)fail("writing_text_only_no_directory",422);
    return this.atomic(async()=>{
      await this.assertAccess(access);
      const previous=await readPrivateJson(this.file(id)) as Store|undefined;
      if(previous){if(previous.inputHash!==inputHash)fail("idempotency_conflict");return this.view(await this.load(id));}
      const lineage=await this.lineage(id,data.parentTaskId,data.runtimeBinding,input.budget,data.rootScopeKey);
      const grants:UnderstandingGrant[]=[];
      for(const versionId of data.toolPolicy.installedVersionIds)if((await this.toolRecord(versionId))?.status!=="installed")fail("tool_not_installed",403);
      for(const folder of data.directories){const grant=await this.broker.grant(folder.path);grants.push({...grant,label:folder.label});}
      await this.assertAccess(access);
      const now=date(), task:CareerTask={id,ownerId:this.opts.ownerId,kind:"resume_tailor",workspaceKey:data.workspaceKey,objective:data.objective,status:"ready",revision:0,createdAt:now,updatedAt:now,
        job:data.job,resume:data.resume,materials:data.materials,directories:grants.map(({id,label})=>({id,label})),runtimeBinding:data.runtimeBinding,budget:data.budget,...lineage,
        usage:{modelCalls:0,toolCalls:0,activeMs:0},evidence:[],events:[],facts:[],toolPolicy:data.toolPolicy,tools:[],toolUsage:{builds:0,executions:0},...(data.workflow?{workflow:data.workflow}:{})};
      if(task.workflow)task.evidence=writingEvidence(task);
      event(task,"created","Task and exact material scope granted. No model call yet.");const stored={schema:1 as const,task,grants,inputHash,recent:[],runGeneration:0};await this.save(stored);return this.view(stored);
    });
  }
  private drop(id:string,a:Active){if(a.released)return;a.released=true;clearTimeout(a.elapsedTimer);clearInterval(a.heartbeat);if(this.active.get(id)===a)this.active.delete(id);try{a.runtime.release?.();}catch{/* already revoked */}}
  private owned(s:AnyStore,a:Active){if(this.closed||this.active.get(s.task.id)!==a||s.runGeneration!==a.token||s.task.status!=="running"||a.controller.signal.aborted)fail("stale_task_turn");}
  private async checkedAny(id:string,a:Active,fn:AnyChange){
    return this.atomic(async()=>{const s=await this.loadAny(id);this.owned(s,a);await this.assertAccess(a.access);this.owned(s,a);charge(s);
      await this.checkRoot(s,digest(a.runtime.runtimeFingerprint));
      await fn(s);this.ownedOrFinal(s,a);await this.save(s);const root=await this.rootState(s);s.task.rootLedger=root.ledger;this.armRootTimers(root);return s;});
  }
  private async checked(id:string,a:Active,fn:Change){return careerStore(await this.checkedAny(id,a,s=>fn(careerStore(s))));}
  private ownedOrFinal(s:AnyStore,a:Active){if(this.closed||this.active.get(s.task.id)!==a||s.runGeneration!==a.token||a.controller.signal.aborted)fail("stale_task_turn");}
  async run(id:string,op:"start"|"resume"|"answer",input:CareerTaskRun,runtime:CareerTaskRuntime,access:CareerTaskAccess){
    let a:Active|undefined;let accepted=false;
    try{
      const data=AgentTaskRunSchema.parse(input);
      const task=await this.atomic(async()=>{
        const s=await this.loadAny(id),t=s.task;
        await this.assertAccess(access);
        if(t.kind==="growth_practice")fail("growth_practice_use_step",422);
        if(t.kind==="project_understanding"&&data.projectTurn&&projectReplay(projectStore(s),data.projectTurn))return this.view(s);
        checkRevision(s,data.expectedRevision);
        if(JSON.stringify(data.runtimeBinding)!==JSON.stringify(t.runtimeBinding))fail("runtime_binding_changed");
        if(!runtime.runtimeFingerprint || (s.runtimeHash&&s.runtimeHash!==digest(runtime.runtimeFingerprint)))fail("runtime_authorization_changed_new_task_required");
        if(data.sourceFingerprint!==agentTaskSourceFingerprint(t))fail("source_changed_new_comparison_required");
        if(this.active.has(id)||op==="start"&&t.status!=="ready"||op==="answer"&&t.status!=="awaiting_answer"||
          op==="resume"&&!(["paused","interrupted","budget_exhausted","failed",...(t.kind==="project_understanding"?["awaiting_review","completed"]:[])] as string[]).includes(t.status))fail("task_not_runnable");
        if(t.kind!=="project_understanding"&&data.projectTurn)fail("task_kind_not_supported_by_operation",422);
        if(t.kind!=="mock_interview"&&data.interviewAction)fail("task_kind_not_supported_by_operation",422);
        if(t.kind==="free_chat" && t.responseContract==="resume_replacement_v1" && (op==="answer" || data.message || data.answer))
          fail("task_kind_not_supported_by_operation",422);
        if(t.kind==="career_inventory" && (op!=="start" || data.answer || data.message || t.usage.modelCalls>0))fail("inventory_single_dispatch_only",422);
        if(t.kind==="jd_match"&&(data.message||data.answer||op==="answer"))fail("task_kind_not_supported_by_operation",422);
        if((t.kind==="career_coach"||t.kind==="jd_intake"||t.kind==="jd_ocr"||t.kind==="studio_analysis"||t.kind==="studio_committee")&&(data.message||data.answer||op==="answer"))fail("task_kind_not_supported_by_operation",422);
        if(t.kind==="studio_analysis")await this.validateStudio(t,access);
        if(t.kind==="studio_committee")await this.validateCommittee(t,access);
        if(t.kind==="project_understanding"&&(!data.projectTurn||data.answer||data.message))fail("project_turn_required",422);
        if(isCareerTask(t)&&data.message)fail("task_kind_not_supported_by_operation",422);
        if(t.kind!=="project_understanding"&&t.kind!=="mock_interview"&&(op==="answer")!==Boolean(isCareerTask(t)?data.answer?.trim():data.message))fail("answer_required_or_unexpected",422);
        if(!isCareerTask(t)&&data.answer)fail("use_conversation_message",422);
        if(!isCareerTask(t)&&t.kind==="experience_refine"&&data.message&&(!data.supplementConfirmed||data.message.attachments?.length||data.message.references?.length))fail("confirmed_supplement_required",422);
        if(isConversationTask(t)&&!runtime.supportsImages&&(freeChatImages(t).length||data.message?.attachments?.length))fail("task_images_not_supported",422);
        if(t.kind==="jd_ocr"){
          if(!runtime.supportsImages)fail("task_images_not_supported",422);
          if(t.uploadedImageIds.length!==t.request.images.length||t.request.images.some(image=>!t.uploadedImageIds.includes(image.id)))fail("task_images_not_ready",422);
        }
        await this.checkRoot(s,digest(runtime.runtimeFingerprint),true);
        if(t.kind==="mock_interview"){
          if(op!=="answer"&&(data.message||data.interviewAction))fail("interview_action_unexpected",422);
          if(op==="answer"){
            if(t.interview.phase!=="interview"||!data.interviewAction)fail("interview_action_required",422);
            if(data.interviewAction==="finish"){
              if(data.message)fail("interview_finish_has_no_answer",422);
              t.interview.phase="evaluation";event(t,"answer","User explicitly ended this interview and requested a coaching receipt; no career fact is adopted.");
            }else{
              const message=data.message;
              if(!message||message.role!=="user"||!message.id.trim()||!message.content.trim()||message.attachments?.length||message.references?.length||message.actions?.length||message.meta)fail("interview_plain_answer_required",422);
              if(t.conversation.messages.some(previous=>previous.id===message!.id))fail("duplicate_message_identity",422);
              if(!validChatMaterial({messages:[...t.conversation.messages,message!]}))fail("conversation_material_budget",422);
              t.conversation.messages.push(message!);t.turn++;delete t.reply;
              t.evidence=Array.from(new Map([...t.evidence,...interviewSources(t)].map(item=>[item.id,item])).values());
              event(t,"answer","Complete answer recorded as unverified interview self-report; shared root usage retained.");
            }
          }
        }
        if(t.kind==="project_understanding")beginProjectTurn(projectStore(s),data.projectTurn!);
        if(isConversationTask(t)&&data.message){
          if(data.message.role!=="user"||t.kind!=="experience_refine"&&!data.message.content.trim()&&!data.message.references?.length&&!data.message.attachments?.length)fail("invalid_conversation_message",422);
          if(t.conversation.messages.some(message=>message.id===data.message!.id))fail("duplicate_message_identity",422);
          if(!validChatMaterial({...t.conversation,messages:[...t.conversation.messages,data.message]}))fail("conversation_material_budget",422);
          t.conversation.messages.push(data.message);t.turn++;delete t.reply;if(t.kind==="experience_refine")delete t.refinementReply;event(t,"answer","User explicitly continued this same conversation; root usage retained.");
        }
        if(isCareerTask(t)&&data.answer&&t.workflow){
          const confirmed=writingConfirmation(t,data.answer);t.writingConfirmation=confirmed;
          for(const item of writingAnswerEvidence(t,confirmed))collectEvidence(t,item);
          delete t.question;delete t.questionEvidenceIds;event(t,"answer","Exact plan, selection and personal answers explicitly confirmed for this task only; no long-term fact adopted.");
        }else if(isCareerTask(t)&&data.answer){const item=evidence("user_statement",`answer:${randomUUID()}`,"本人本次回答（未经独立核验）",data.answer);
          (s.statements??={})[item.sourceId]=data.answer;t.evidence.push(item);s.recent.push({question:t.question,answerEvidence:item.id});delete t.question;delete t.questionEvidenceIds;event(t,"answer","User statement recorded for this task only.");}
        s.runtimeHash=digest(runtime.runtimeFingerprint);s.runGeneration++;s.lastActiveAt=Date.now();stage(t,"running");
        event(t,"started",op==="start"?"Bounded execution started.":"Runtime, source fingerprint and consent checked before continuing.");
        a={token:s.runGeneration,startRevision:t.revision+1,session:access.session,controller:new AbortController(),access,runtime,released:false};this.active.set(id,a);
        await this.save(s);const root=await this.rootState(s);this.armRootTimers(root);return this.view(s);
      });
      if(!a)return task;
      const current=a!;accepted=true;
      current.heartbeat=setInterval(()=>{void this.atomic(async()=>{if(this.active.get(id)!==current)return;const s=await this.loadAny(id);this.owned(s,current);charge(s);
        // Heartbeats don't invalidate human control revisions.
        await writePrivateJson(this.file(id),s);this.armRootTimers(await this.rootState(s));}).catch(()=>{});},activeLeaseMs);current.heartbeat.unref?.();
      void (isCareerTask(task)?this.execute(id,current,op!=="start"):task.kind==="career_inventory"?this.executeInventory(id,current):task.kind==="studio_committee"?this.executeStudioCommittee(id,current):task.kind==="studio_analysis"?this.executeStudioAnalysis(id,current):task.kind==="jd_ocr"?this.executeOcr(id,current):task.kind==="jd_intake"?this.executeIntake(id,current):task.kind==="career_coach"?this.executeCoach(id,current):task.kind==="project_understanding"?this.executeProject(id,current):task.kind==="jd_match"?this.executeJdMatch(id,current):task.kind==="mock_interview"?this.executeInterview(id,current):this.executeConversation(id,current)).catch(()=>{});return task;
    }finally{if(!accepted){if(a)this.drop(id,a);else runtime.release?.();}}
  }
  private async stopActive(id:string,a:Active,status:CareerTask["status"],code:string){
    if(this.active.get(id)!==a)return;
    a.controller.abort(code);
    try{await this.atomic(async()=>{if(this.active.get(id)!==a)return;const s=await this.loadAny(id);if(s.task.status!=="running"||s.runGeneration!==a.token)return;
      hold(s,status,code);event(s.task,"stopped",code);await this.save(s);this.armRootTimers(await this.rootState(s));});}
    finally{this.drop(id,a);}
  }
  async cancelActive(id:string,expectedStartRevision?:number){const a=this.active.get(id);if(a&&(expectedStartRevision===undefined||a.startRevision===expectedStartRevision))await this.stopActive(id,a,"paused","authorization_changed");}
  async invalidateSession(session:string){this.revoked.add(session);await Promise.all([...this.active].filter(([,a])=>a.session===session).map(([id,a])=>this.stopActive(id,a,"paused","interaction_lease_invalid")));}
  async close(){this.closed=true;await Promise.all([...this.active].map(([id,a])=>this.stopActive(id,a,"interrupted","host_stopped")));await this.writes;this.writer?.close();this.writer=undefined;}
  private async preserveOverflowOutput(s:AnyStore,text:string,runGeneration=s.runGeneration,providerFields:ReturnType<typeof providerJournalFields>={}){
    if(isCareerTask(s.task)||s.task.kind==="growth_practice")fail("task_kind_not_supported_by_operation",422);
    const task=s.task,hash=digest(text),outputId=`out_${digest([task.id,runGeneration,task.usage.modelCalls,hash]).slice(0,32)}`;
    const directory=path.join(this.opts.directory,"outputs",task.id);await privateDirectory(directory);
    const handle=await fs.open(path.join(directory,`${outputId}.txt`),"wx",0o600);
    try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
    const artifact={id:outputId,bytes:Buffer.byteLength(text),hash,createdAt:date()};(task.outputArtifacts??=[]).push(artifact);
    s.recent.push({kind:`${task.kind}_output_artifact`,turn:task.kind==="project_understanding"?task.project.turnCount:task.kind==="jd_match"?1:task.turn,artifact,...providerFields});event(task,"decision",`Complete oversized output preserved as ${outputId}; no clipped success or automatic retry.`);
  }
  async readOutput(id:string,outputId:string){return this.atomic(async()=>{
    const task=(await this.loadAny(id)).task;
    if(isCareerTask(task)||task.kind==="growth_practice"||!/^out_[a-f0-9]{32}$/.test(outputId)||!task.outputArtifacts?.some(item=>item.id===outputId))fail("task_output_not_found",404);
    const artifact=task.outputArtifacts!.find(item=>item.id===outputId)!;
    const file=path.join(this.opts.directory,"outputs",id,`${outputId}.txt`),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==artifact.bytes||process.platform!=="win32"&&(stat.mode&0o077)!==0)fail("unsafe_task_output",503);
    const text=await fs.readFile(file,"utf8");if(digest(text)!==artifact.hash)fail("task_output_changed",409);return {artifact,text};
  });}
  private async executeOcr(id:string,a:Active){
    try{
      for(;;){
        let images:import("./model-protocol.js").TaskImage[]=[];
        const state=await this.checkedAny(id,a,async s=>{
          if(s.task.kind!=="jd_ocr")fail("task_kind_not_supported_by_operation",422);
          if(Buffer.byteLength(JSON.stringify(s))>8*1024*1024)fail("task_storage_budget");
          // Verify all immutable original bytes before charging or sending this attempt.
          for(const image of s.task.request.images)images.push(await this.images.read(id,image));
          await this.assertAccess(a.access);await this.reserve(s,"model");event(s.task,"model",`jd_ocr send ${s.task.usage.modelCalls}; original images, same root/runtime/ledger.`);
        });
        const task=state.task as JdOcrTask,prompt=jdOcrPrompt(task.request)+"\n\nHost validation observations (data):\n"+JSON.stringify(state.recent);
        const response=await a.runtime.reasoner(prompt,a.controller.signal,"jd_ocr",images);images=[];
        const output=modelOutputText(response),finishReason=modelFinishReason(response);
        const incomplete=modelOutputIncomplete(response)||Boolean(finishReason&&!["stop","end_turn","eos","complete","completed"].includes(finishReason));
        await this.checkedAny(id,a,async s=>{
          if(output.length>1_000_000){await this.preserveOverflowOutput(s,output);return;}
          s.recent.push({kind:"jd_ocr_output",output,finishReason});
          if(s.task.kind==="jd_ocr"&&incomplete)s.task.partialOutput={text:output,finishReason};
        });
        if(output.length>1_000_000)fail("decision_output_budget",413);
        if(incomplete)fail("model_output_incomplete",422);
        let result:ReturnType<typeof parseJdOcrResult>;
        try{result=parseJdOcrResult(output);}catch(error){
          const rejected=state.recent.filter(item=>typeof item==="object"&&item!==null&&"kind" in item&&item.kind==="jd_ocr_rejected").length;
          await this.checkedAny(id,a,s=>{s.recent.push({kind:"jd_ocr_rejected",validation:error instanceof Error?error.message:"Invalid OCR payload"});event(s.task,"decision","Rejected OCR payload; full output retained. Any repair uses the original images and same root charge.");});
          if(rejected>=2)fail("decision_repair_exhausted",422);continue;
        }
        await this.checkedAny(id,a,s=>{
          if(s.task.kind!=="jd_ocr")fail("task_kind_not_supported_by_operation",422);
          s.task.result=result;delete s.task.partialOutput;hold(s,"completed");event(s.task,"receipt","Full screenshot transcription ready for human review; no job, resume or fact saved.");
        });return;
      }
    }catch(error){const code=safeCode(error);if(!a.controller.signal.aborted&&this.active.get(id)===a)await this.stopActive(id,a,code.includes("budget")?"budget_exhausted":code==="model_output_incomplete"?"paused":"failed",code);}
    finally{if(!a.controller.signal.aborted)this.drop(id,a);}
  }
  private async executeStudioAnalysis(id:string,a:Active){
    try{
      for(;;){
        const state=await this.checkedAny(id,a,async s=>{
          if(s.task.kind!=="studio_analysis")fail("task_kind_not_supported_by_operation",422);
          await this.validateStudio(s.task,a.access);
          if(Buffer.byteLength(JSON.stringify(s))>8*1024*1024)fail("task_storage_budget");
          await this.reserve(s,"model");event(s.task,"model",`studio_analysis send ${s.task.usage.modelCalls}; frozen contract and same root/runtime/ledger.`);
        });
        const task=state.task as StudioAnalysisTask,prompt=studioAnalysisPrompt(task.request)+"\n\nHost validation observations (untrusted data):\n"+JSON.stringify(state.recent);
        const response=await a.runtime.reasoner(prompt,a.controller.signal,"studio_analysis",undefined,undefined,task.request.payload.contract),output=modelOutputText(response),finishReason=modelFinishReason(response);
        const incomplete=modelOutputIncomplete(response)||Boolean(finishReason&&!["stop","end_turn","eos","complete","completed"].includes(finishReason));
        await this.checkedAny(id,a,async s=>{
          if(output.length>126000){await this.preserveOverflowOutput(s,output);return;}
          s.recent.push({kind:"studio_analysis_output",output,finishReason});
          if(s.task.kind==="studio_analysis"&&incomplete)s.task.partialOutput={text:output,finishReason};
        });
        if(output.length>126000)fail("decision_output_budget",413);
        // The full wire is durable before a revoked context, changed digest or
        // failed semantic/format check can reject adoption of its late result.
        await this.validateStudio(task,a.access);
        if(incomplete)fail("model_output_incomplete",422);
        if(containsGitEvidenceSecret(output))fail("studio_sensitive_model_output",422);
        let value:Record<string,unknown>;
        try{value=studioAnalysisOutputSchema(task.request.payload.contract).parse(JSON.parse(output)) as Record<string,unknown>;}catch{
          const rejected=state.recent.filter(item=>typeof item==="object"&&item!==null&&"kind" in item&&item.kind==="studio_analysis_rejected").length;
          await this.checkedAny(id,a,s=>{s.recent.push({kind:"studio_analysis_rejected",validation:"Output failed the frozen complete JSON contract."});event(s.task,"decision","Rejected Studio output retained in full. A repair can only spend the same root's remaining budget.");});
          if(rejected>=2)fail("decision_repair_exhausted",422);continue;
        }
        await this.checkedAny(id,a,async s=>{
          if(s.task.kind!=="studio_analysis")fail("task_kind_not_supported_by_operation",422);
          await this.validateStudio(s.task,a.access);
          s.task.result={output:value,contextId:s.task.request.contextId,inputHash:digest(s.task.request.payload),runtime:s.task.request.runtime,adopted:false};
          delete s.task.partialOutput;hold(s,"completed");event(s.task,"receipt","Complete Studio analysis is a reviewable proposal, not verified facts or a Workspace write.");
        });return;
      }
    }catch(error){const code=safeCode(error);if(!a.controller.signal.aborted&&this.active.get(id)===a)await this.stopActive(id,a,code.includes("budget")?"budget_exhausted":code==="model_output_incomplete"?"paused":"failed",code);}
    finally{if(!a.controller.signal.aborted)this.drop(id,a);}
  }
  private async executeStudioCommittee(id:string,a:Active){
    let fatal:unknown;
    const guarded=async<T>(work:()=>Promise<T>):Promise<T>=>{if(fatal)throw fatal;try{return await work();}catch(error){fatal=error;throw error;}};
    const validate=()=>guarded(async()=>{
      const state=await this.checkedAny(id,a,async s=>{if(s.task.kind!=="studio_committee")fail("task_kind_not_supported_by_operation",422);await this.validateCommittee(s.task,a.access);});
      return state;
    });
    const tool=(detail:string)=>guarded(async()=>{await this.checkedAny(id,a,async s=>{
      if(s.task.kind!=="studio_committee")fail("task_kind_not_supported_by_operation",422);
      await this.validateCommittee(s.task,a.access);await this.reserve(s,"tool");event(s.task,"tool_call",detail);
    });});
    try{
      let state=await validate();const task=state.task as StudioCommitteeTask;
      if(!state.committeeState){
        const context=await this.validateCommittee(task,a.access),prepared=await prepareCommitteeTask(task,context,this.broker,a.controller.signal,tool);
        state=await this.checkedAny(id,a,async s=>{await this.validateCommittee(task,a.access);s.committeeState=prepared;event(s.task,"tool_result","Complete selected committee snapshot frozen with exact source versions; no model judgment yet.");});
      }
      const prepared=state.committeeState!;
      await validateCommitteeSnapshot(prepared.snapshot);
      if(prepared.snapshot.binding.ownerId!==task.ownerId||prepared.snapshot.binding.workspaceId!==task.rootScopeKey||prepared.snapshot.authorization.grantId!==id)fail("invalid_committee_checkpoint",503);
      const cached=prepared.completed.slice();let cursor=0;
      const sources=()=>guarded(()=>revalidateCommitteeSources(prepared.sources,this.broker,a.controller.signal,tool));
      await sources();
      const report=await runHiringCommittee(prepared.snapshot,{
        signal:a.controller.signal,
        // These are protocol bounds, never a second allowance. Every actual
        // effect below reserves the authoritative (possibly smaller) root first.
        budget:{maxModelCalls:100,maxToolCalls:500,maxTurnsPerRole:4,maxCrossRounds:1,maxDurationMs:3_600_000,maxOutputCharacters:2_000_000},
        isCurrent:async()=>{await validate();return true;},
        beforeEvidenceRead:request=>tool(`Read frozen committee evidence ${request.evidenceId}:${request.startLine}-${request.endLine}; invalid requests are charged too.`),
        reasoner:async(request,signal)=>guarded(async()=>{
          const wire=committeeModelRequest(request,prepared.snapshot,{allowEvidencePaging:true}),key=digest([request.role,request.stage,request.round,request.turn,wire]);
          if(cursor<cached.length){const previous=cached[cursor++]!;if(previous.key!==key)fail("committee_resume_checkpoint_mismatch");return previous.output;}
          await sources();
          await this.checkedAny(id,a,async s=>{
            await this.validateCommittee(task,a.access);if(Buffer.byteLength(JSON.stringify(s))>8*1024*1024)fail("task_storage_budget");
            await this.reserve(s,"model");s.recent.push({kind:"studio_committee_request",key,role:request.role,stage:request.stage,round:request.round,turn:request.turn,...wire});
            event(s.task,"model",`Committee ${request.role}/${request.stage}/${request.turn}; actual send ${s.task.usage.modelCalls}, original root/runtime.`);
          });
          let response:CareerTaskModelOutput,rejected:RejectedTaskModelOutput|undefined;
          try{response=await a.runtime.reasoner(wire.prompt,signal,"studio_committee",undefined,undefined,wire.jsonSchema);}
          catch(error){if(!(error instanceof RejectedTaskModelOutput))throw error;response=error.output;rejected=error;}
          const output=modelOutputText(response),finishReason=modelFinishReason(response);
          const incomplete=modelOutputIncomplete(response)||Boolean(finishReason&&!["stop","end_turn","eos","complete","completed"].includes(finishReason));
          // Archiving is not execution/adoption. A stopped or revoked turn may
          // still return bytes; preserve them in its owner's private journal,
          // tagged with the original generation, without reviving that turn.
          await this.atomic(async()=>{
            const s=await this.loadAny(id),current=!rejected&&this.active.get(id)===a&&s.runGeneration===a.token&&s.task.status==="running"&&!a.controller.signal.aborted&&!signal.aborted;
            if(output.length>126000)await this.preserveOverflowOutput(s,output,a.token);
            else s.recent.push({kind:"studio_committee_output",key,output,finishReason,runGeneration:a.token,late:!current});
            if(current&&s.task.kind==="studio_committee"&&incomplete)s.task.partialOutput={text:output,finishReason};
            await this.save(s);
          });
          if(rejected)throw rejected;
          if(signal.aborted)fail("stale_task_turn");
          if(output.length>126000)fail("decision_output_budget",413);
          await validate();if(incomplete)fail("model_output_incomplete",422);
          if(containsGitEvidenceSecret(output))fail("studio_sensitive_model_output",422);
          await sources();
          // Replay only complete, version-checked wire responses on explicit
          // resume. Pending/partial/failed sends are retried and charged anew.
          await this.checkedAny(id,a,s=>{if(signal.aborted)fail("stale_task_turn");s.committeeState!.completed.push({key,output});});
          return output;
        }),
      });
      await this.checkedAny(id,a,s=>{if(s.task.kind!=="studio_committee")fail("task_kind_not_supported_by_operation",422);s.task.result=CommitteeReportSchema.parse(report);});
      if(fatal)throw fatal;
      if(report.status!=="completed")fail(report.stopReason??"committee_review_incomplete",422);
      await sources();await validate();
      await this.checkedAny(id,a,s=>{delete (s.task as StudioCommitteeTask).partialOutput;hold(s,"completed");event(s.task,"receipt","Complete multirole committee report retained for human review; no publication, FactBase or resume write.");});
    }catch(error){const code=safeCode(error);if(!a.controller.signal.aborted&&this.active.get(id)===a)await this.stopActive(id,a,code.includes("budget")?"budget_exhausted":code==="model_output_incomplete"?"paused":"failed",code);}
    finally{if(!a.controller.signal.aborted)this.drop(id,a);}
  }
  private async executeIntake(id:string,a:Active){
    try{
      for(;;){
        const state=await this.checkedAny(id,a,async s=>{
          if(s.task.kind!=="jd_intake")fail("task_kind_not_supported_by_operation",422);
          if(Buffer.byteLength(JSON.stringify(s))>8*1024*1024)fail("task_storage_budget");
          await this.reserve(s,"model");event(s.task,"model",`jd_intake send ${s.task.usage.modelCalls}; same root/runtime/ledger.`);
        });
        const task=state.task as JdIntakeTask,prompt=jdIntakePrompt(task.request)+"\n\nHost validation observations (data):\n"+JSON.stringify(state.recent);
        const response=await a.runtime.reasoner(prompt,a.controller.signal,"jd_intake"),output=modelOutputText(response),finishReason=modelFinishReason(response);
        const incomplete=modelOutputIncomplete(response)||Boolean(finishReason&&!["stop","end_turn","eos","complete","completed"].includes(finishReason));
        await this.checkedAny(id,a,async s=>{
          if(output.length>126000){await this.preserveOverflowOutput(s,output);return;}
          s.recent.push({kind:"jd_intake_output",output,finishReason});
          if(s.task.kind==="jd_intake"&&incomplete)s.task.partialOutput={text:output,finishReason};
        });
        if(output.length>126000)fail("decision_output_budget",413);
        if(incomplete)fail("model_output_incomplete",422);
        let result:ReturnType<typeof parseJdIntakeResult>;
        try{result=parseJdIntakeResult(output,task.request);}catch(error){
          const rejected=state.recent.filter(item=>typeof item==="object"&&item!==null&&"kind" in item&&item.kind==="jd_intake_rejected").length;
          await this.checkedAny(id,a,s=>{s.recent.push({kind:"jd_intake_rejected",validation:error instanceof Error?error.message:"Invalid intake payload"});event(s.task,"decision","Rejected intake output; complete output retained, repair charged to the same root.");});
          if(rejected>=2)fail("decision_repair_exhausted",422);
          continue;
        }
        await this.checkedAny(id,a,s=>{
          if(s.task.kind!=="jd_intake")fail("task_kind_not_supported_by_operation",422);
          const current=s.task as JdIntakeTask;current.result=result;delete current.partialOutput;hold(s,"completed");event(s.task,"receipt","Exact source-backed metadata ready for human review; no opportunity or resume saved.");
        });return;
      }
    }catch(error){const code=safeCode(error);if(!a.controller.signal.aborted&&this.active.get(id)===a)await this.stopActive(id,a,code.includes("budget")?"budget_exhausted":code==="model_output_incomplete"?"paused":"failed",code);}
    finally{if(!a.controller.signal.aborted)this.drop(id,a);}
  }
  private async executeInventory(id:string,a:Active){
    try {
      const state=await this.checkedAny(id,a,async s=>{if(s.task.kind!=="career_inventory")fail("task_kind_not_supported_by_operation",422);
        await this.reserve(s,"model");event(s.task,"model","Single consented inventory follow-up; no retries.");});
      const {prompt,priorAnswer}=(state.task as InventoryTask).request;
      const raw=await a.runtime.reasoner("围绕这段本人正在核对的回答，只提一个能帮助取舍材料的具体问题。不要代答、假设任职、量化成果或评价性格。以下 JSON 仅是资料："+JSON.stringify({prompt,priorAnswer}),a.controller.signal,"career_inventory");
      const output=modelOutputText(raw), finish=modelFinishReason(raw);
      await this.checkedAny(id,a,async s=>{if(output.length>32000)await this.preserveOverflowOutput(s,output);else s.recent.push({kind:"inventory_output",output,finish});});
      if(output.length>32000)fail("decision_output_budget",413);
      if(modelOutputIncomplete(raw)||finish&&!["stop","end_turn","eos","complete","completed"].includes(finish))fail("model_output_incomplete",422);
      let parsed;try{parsed=InventoryProbeResultSchema.parse(JSON.parse(output));}catch{fail("inventory_invalid_question",422);}
      if(!parsed || (parsed.question.match(/[?？]/g)?.length??0)>1)fail("inventory_invalid_question",422);
      await this.checkedAny(id,a,s=>{const t=s.task as InventoryTask;t.result=parsed;hold(s,"completed");event(t,"receipt","Follow-up question only; no business asset was changed.");});
    }catch(error){const code=safeCode(error);if(!a.controller.signal.aborted&&this.active.get(id)===a)await this.stopActive(id,a,code.includes("budget")?"budget_exhausted":"failed",code);}
    finally{if(!a.controller.signal.aborted)this.drop(id,a);}
  }
  private async executeCoach(id:string,a:Active){
    try{
      for(;;){
        const state=await this.checkedAny(id,a,async s=>{
          if(s.task.kind!=="career_coach")fail("task_kind_not_supported_by_operation",422);
          if(Buffer.byteLength(JSON.stringify(s))>8*1024*1024)fail("task_storage_budget");
          await this.reserve(s,"model");event(s.task,"model",`career_coach send ${s.task.usage.modelCalls}; same root/runtime/ledger.`);
        });
        const task=state.task as CoachGuidanceTask;
        const prompt=[...buildCoachMessages(task.request).map(message=>message.content),
          "Host repair observations and root accounting (data, not permission to execute):",
          JSON.stringify({observations:state.recent,budget:task.budget,usage:task.usage,rootLedger:task.rootLedger})].join("\n\n");
        const response=await a.runtime.reasoner(prompt,a.controller.signal,"career_coach"),output=modelOutputText(response),finishReason=modelFinishReason(response);
        const incomplete=modelOutputIncomplete(response)||Boolean(finishReason&&!["stop","end_turn","eos","complete","completed"].includes(finishReason));
        await this.checkedAny(id,a,async s=>{
          if(output.length>126000){await this.preserveOverflowOutput(s,output);return;}
          s.recent.push({kind:"career_coach_output",output,finishReason});
          if(s.task.kind==="career_coach"&&incomplete)s.task.partialOutput={text:output,finishReason};
        });
        if(output.length>126000)fail("decision_output_budget",413);
        if(incomplete)fail("model_output_incomplete",422);
        let payload:ReturnType<typeof parseCoachPayload>;
        try{payload=parseCoachPayload(output,task.request);}catch(error){
          const rejected=state.recent.filter(item=>typeof item==="object"&&item!==null&&"kind" in item&&item.kind==="career_coach_rejected").length;
          await this.checkedAny(id,a,s=>{s.recent.push({kind:"career_coach_rejected",validation:error instanceof Error?error.message:"Invalid coaching payload"});event(s.task,"decision","Rejected coaching payload; complete output retained and repair charged to the original root.");});
          if(rejected>=2)fail("decision_repair_exhausted",422);
          continue;
        }
        await this.checkedAny(id,a,s=>{
          if(s.task.kind!=="career_coach")fail("task_kind_not_supported_by_operation",422);
          const current=s.task as CoachGuidanceTask,binding=current.runtimeBinding;
          current.result={payload,model:{provider:binding.id.startsWith("model:")?binding.id.split(":")[1]!:binding.id.startsWith("chatgpt:")?"chatgpt":"native",name:binding.label,generatedAt:date()}};
          delete current.partialOutput;hold(s,"completed");event(current,"receipt","Complete coaching reference ready; no plan adopted, resume written or fact certified.");
        });return;
      }
    }catch(error){const code=safeCode(error);if(!a.controller.signal.aborted&&this.active.get(id)===a)await this.stopActive(id,a,code.includes("budget")?"budget_exhausted":code==="model_output_incomplete"?"paused":"failed",code);}
    finally{if(!a.controller.signal.aborted)this.drop(id,a);}
  }
  private async executeInterview(id:string,a:Active){
    try{
      for(;;){
        const state=interviewStore(await this.checkedAny(id,a,async raw=>{
          const s=interviewStore(raw);
          if(Buffer.byteLength(JSON.stringify(s))>8*1024*1024)fail("task_storage_budget");
          const context=interviewContext(s.task,s.recent);
          for(const item of context.evidence)if(!s.task.evidence.some(previous=>previous.id===item.id))s.task.evidence.push(item);
          if(s.task.evidence.length>2000)fail("task_evidence_budget");
          s.exposedEvidenceIds=[...new Set([...(s.exposedEvidenceIds??[]),...context.evidence.map(item=>item.id)])];
          await this.reserve(s,"model");event(s.task,"model",`mock_interview ${s.task.interview.phase} send ${s.task.usage.modelCalls}; same parent root/runtime/ledger.`);
        }));
        const response=await a.runtime.reasoner(interviewPrompt(state.task,state.recent,state.exposedEvidenceIds??[]),a.controller.signal,"mock_interview"),output=modelOutputText(response),finishReason=modelFinishReason(response);
        await this.checkedAny(id,a,raw=>{
          const s=interviewStore(raw);
          if(output.length>126000)return this.preserveOverflowOutput(s,output);
          s.recent.push({kind:"mock_interview_output",turn:s.task.turn,phase:s.task.interview.phase,output,finishReason});
          if(modelOutputIncomplete(response))s.task.partialOutput={text:output,finishReason};
        });
        if(output.length>126000)fail("decision_output_budget",413);
        if(modelOutputIncomplete(response))fail("model_output_incomplete",422);
        let decision:ReturnType<typeof interviewDecision>;
        try{decision=interviewDecision(state.task,output,state.exposedEvidenceIds??[]);}
        catch(error){
          const code=error instanceof SyntaxError?"invalid_json":error instanceof CareerTaskError?error.code:"invalid_interview_output";
          const rejected=state.recent.filter(item=>typeof item==="object"&&item!==null&&"kind" in item&&item.kind==="mock_interview_rejected"&&"turn" in item&&item.turn===state.task.turn&&"phase" in item&&item.phase===state.task.interview.phase).length;
          await this.checkedAny(id,a,s=>{s.recent.push({kind:"mock_interview_rejected",turn:state.task.turn,phase:state.task.interview.phase,code});event(s.task,"decision",`Rejected interview output: ${code}; full output retained.`);});
          if(rejected>=2)fail("decision_repair_exhausted",422);
          continue;
        }
        if(decision.kind==="read_evidence"){
          const request=decision;
          await this.checkedAny(id,a,async s=>{await this.reserve(s,"tool");event(s.task,"tool_call","Read one exact frozen parent/answer evidence page for this interview.");});
          await this.checkedAny(id,a,raw=>{
            const s=interviewStore(raw),item=readInterviewEvidence(s.task,request.handle,request.offset,request.length);
            if(!s.task.evidence.some(previous=>previous.id===item.id))s.task.evidence.push(item);
            if(s.task.evidence.length>2000)fail("task_evidence_budget");
            s.recent.push({kind:"mock_interview_read",evidenceId:item.id,requested:request,actual:{startOffset:item.startOffset,endOffset:item.endOffset,sourceLength:item.sourceLength}});
            event(s.task,"tool_result",`Exact interview evidence page retained: ${item.id}`);
          });continue;
        }
        const result=decision;
        await this.checkedAny(id,a,raw=>{
          const s=interviewStore(raw),task=s.task,reply={id:`msg_${randomUUID()}`,role:"assistant" as const,content:result.kind==="question"?result.content:interviewReceiptText(result.receipt),createdAt:date()};
          task.conversation.messages.push(reply);task.reply=reply;delete task.partialOutput;
          if(result.kind==="question"){hold(s,"awaiting_answer");event(task,"question","One interview question is ready; next answer or finish requires a new explicit human action.");}
          else{task.interview.receipt=result.receipt;hold(s,"completed");event(task,"receipt","Human-ended interview receipt covers all recorded answers; no ability certification, automatic resume edit or FactBase write.");}
        });return;
      }
    }catch(error){
      const code=safeCode(error);
      if(!a.controller.signal.aborted&&this.active.get(id)===a)await this.stopActive(id,a,code.includes("budget")?"budget_exhausted":code==="model_output_incomplete"?"paused":"failed",code);
    }finally{if(!a.controller.signal.aborted)this.drop(id,a);}
  }
  private async executeJdMatch(id:string,a:Active){
    try{
      for(;;){
        const state=jdStore(await this.checkedAny(id,a,async raw=>{
          const s=jdStore(raw);
          if(Buffer.byteLength(JSON.stringify(s))>8*1024*1024)fail("task_storage_budget");
          const context=jdMatchContext(s.task,s.recent);
          for(const item of context.evidence)if(!s.task.evidence.some(previous=>previous.id===item.id))s.task.evidence.push(item);
          if(s.task.evidence.length>2000)fail("task_evidence_budget");
          s.exposedEvidenceIds=[...new Set([...(s.exposedEvidenceIds??[]),...context.evidence.map(item=>item.id)])];
          await this.reserve(s,"model");event(s.task,"model",`jd_match send ${s.task.usage.modelCalls}/${s.task.budget.maxModelCalls}; same root/runtime/ledger.`);
        }));
        const response=await a.runtime.reasoner(jdMatchPrompt(state.task,state.recent,state.exposedEvidenceIds??[]),a.controller.signal,"jd_match"),output=modelOutputText(response),finishReason=modelFinishReason(response);
        await this.checkedAny(id,a,async s=>{
          if(output.length>126000){await this.preserveOverflowOutput(s,output);return;}
          s.recent.push({kind:"jd_match_output",output,finishReason});
          if(s.task.kind==="jd_match"&&modelOutputIncomplete(response))s.task.partialOutput={text:output,finishReason};
        });
        if(output.length>126000)fail("decision_output_budget",413);
        if(modelOutputIncomplete(response))fail("model_output_incomplete",422);
        let decision:ReturnType<typeof jdMatchDecision>;
        try{decision=jdMatchDecision(state.task,output,state.exposedEvidenceIds??[]);}
        catch(error){
          const code=error instanceof SyntaxError?"invalid_json":error instanceof CareerTaskError?error.code:"invalid_jd_match_output";
          const rejected=state.recent.filter(item=>typeof item==="object"&&item!==null&&"kind" in item&&item.kind==="jd_match_rejected").length;
          await this.checkedAny(id,a,s=>{s.recent.push({kind:"jd_match_rejected",code});event(s.task,"decision",`Rejected JD output: ${code}; complete output retained.`);});
          if(rejected>=2)fail("decision_repair_exhausted",422);
          continue;
        }
        if(decision.kind==="read_evidence"){
          const request=decision;
          await this.checkedAny(id,a,async s=>{await this.reserve(s,"tool");event(s.task,"tool_call","Read an exact frozen JD-match evidence page.");});
          // Even an invalid page request is charged. A handle cannot widen the
          // material grant or access a filesystem path.
          await this.checkedAny(id,a,raw=>{
            const s=jdStore(raw),item=readJdMatchEvidence(s.task,request.handle,request.offset,request.length);
            if(!s.task.evidence.some(previous=>previous.id===item.id))s.task.evidence.push(item);
            if(s.task.evidence.length>2000)fail("task_evidence_budget");
            s.recent.push({kind:"jd_match_read",evidenceId:item.id,requested:request,actual:{startOffset:item.startOffset,endOffset:item.endOffset,sourceLength:item.sourceLength}});
            event(s.task,"tool_result",`Exact page retained: ${item.id}`);
          });continue;
        }
        const result=decision;
        await this.checkedAny(id,a,raw=>{const s=jdStore(raw);s.task.result={proposals:result.proposals,...(result.report?{report:result.report}:{})};delete s.task.partialOutput;hold(s,"awaiting_review");
          event(s.task,"decision","All original JD items matched for human review; self-report is not independent verification. No automatic adoption or business write.");});return;
      }
    }catch(error){
      const code=safeCode(error);
      if(!a.controller.signal.aborted&&this.active.get(id)===a)await this.stopActive(id,a,code.includes("budget")?"budget_exhausted":code==="model_output_incomplete"?"paused":"failed",code);
    }finally{if(!a.controller.signal.aborted)this.drop(id,a);}
  }
  private async refinementProject(s:AnyStore){
    if(s.task.kind!=="experience_refine"||!s.task.refinement.projectContext)return;
    const context=s.task.refinement.projectContext;
    // Legacy sessions retain the explicit browser compatibility check until
    // their own migration; a new kernel consensus has one Host authority.
    if(!/^ct_[a-f0-9]{32}$/.test(context.sessionId))return;
    const project=projectStore(await this.loadAny(context.sessionId)),session=project.task.project;
    await this.checkRoot(project);
    if(project.task.status!=="completed"||session.phase!=="confirmed"||session.revision!==context.revision||session.summaryHash!==context.summaryHash||session.confirmation?.revision!==context.revision||session.confirmation.summaryHash!==context.summaryHash||!session.understanding||understandingHash(session.understanding)!==context.summaryHash||understandingHash(context.understanding)!==context.summaryHash)fail("project_context_changed");
    return project;
  }
  private async recheckRefinementProject(id:string,a:Active){
    let project:Store<ProjectUnderstandingTask>|undefined;
    await this.checkedAny(id,a,async s=>{project=await this.refinementProject(s);});
    if(!project)return;
    for(const item of this.projectFiles(project)){
      const grant=project.grants.find(grant=>grant.id===item.grantId&&!grant.revokedAt);if(!grant)fail("project_context_changed");
      await this.checkedAny(id,a,async s=>{await this.refinementProject(s);await this.reserve(s,"tool");event(s.task,"tool_call","Revalidate confirmed kernel project background; not personal evidence.");});
      let result:EvidenceResult;
      try{result=await this.broker.execute(grant!,{operation:"read",path:item.path,startLine:item.startLine,endLine:item.startLine},a.controller.signal);}
      catch{a.controller.signal.throwIfAborted();fail("project_context_changed");}
      if(!result!.evidence.some(value=>value.hash===item.hash))fail("project_context_changed");
    }
    await this.checkedAny(id,a,async s=>{await this.refinementProject(s);});
  }
  private async executeConversation(id:string,a:Active){
    try{
      for(;;){
        await this.recheckRefinementProject(id,a);
        const state=await this.checkedAny(id,a,async s=>{
          if(Buffer.byteLength(JSON.stringify(s))>8*1024*1024)fail("task_storage_budget");
          await this.reserve(s,"model");event(s.task,"model",`${s.task.kind} send ${s.task.usage.modelCalls}/${s.task.budget.maxModelCalls}; same root/runtime/ledger.`);
        });
        if(!isConversationTask(state.task))fail("task_kind_not_supported_by_operation",422);
        const task=state.task as ConversationTask;
        const prompt=task.kind==="experience_refine"?experienceRefinePrompt(task,state.recent):freeChatPrompt(task,state.recent);
        const boundSource=task.kind==="free_chat"?resumeCandidateSource(task):undefined;
        const contract=task.kind==="free_chat"?task.responseContract:undefined;
        const phase=contract==="resume_replacement_v1"?"resume_replacement":contract==="resume_candidate_v1"?"resume_candidate":contract?"resume_candidate_bound":task.kind;
        const response=await a.runtime.reasoner(prompt,a.controller.signal,phase,freeChatImages(task),boundSource),output=modelOutputText(response),finishReason=modelFinishReason(response);
        const providerFields=task.kind==="free_chat"?providerJournalFields(response,task.usage.modelCalls):{};
        // Preserve the complete transport output before parsing or rejecting it.
        await this.checkedAny(id,a,async s=>{
          if(output.length>126000){await this.preserveOverflowOutput(s,output,s.runGeneration,providerFields);return;}
          s.recent.push({kind:`${task.kind}_output`,turn:task.turn,output,finishReason,...providerFields});
          if(!isCareerTask(s.task)&&s.task.kind!=="growth_practice"&&modelOutputIncomplete(response))s.task.partialOutput={text:output,finishReason};});
        if(output.length>126000)fail("decision_output_budget",413);
        if(modelOutputIncomplete(response))fail("model_output_incomplete",422);
        await this.recheckRefinementProject(id,a);
        let decision:z.infer<typeof FreeChatReplyDecisionSchema>;
        let refinementReply:WritingReply|undefined;
        let attribution:ReturnType<typeof reviewResumeCandidateAttribution>|undefined;
        let workCoverage:ReturnType<typeof reviewResumeCandidateWorkCoverage>|undefined;
        try{
          if(task.kind==="experience_refine"){
            refinementReply=experienceRefineReply(task,output);decision={kind:"reply",content:JSON.stringify(refinementReply)};
          }else if(task.responseContract==="resume_replacement_v1"){
            if(!ResumeReplacementSelectionSchema.safeParse(JSON.parse(output)).success)fail("invalid_resume_replacement",422);
            decision={kind:"reply",content:output};
          }else if(task.responseContract){
            const schema=task.responseContract==="resume_candidate_v1"?ResumeCandidateSchema:resumeCandidateBoundSchema(boundSource);
            const candidate=JSON.parse(output);
            if(!schema.safeParse(candidate).success)fail("invalid_resume_candidate",422);
            if(task.responseContract==="resume_candidate_v4"||task.responseContract==="resume_candidate_v5"){
              attribution=reviewResumeCandidateAttribution(boundSource,candidate);
              if(task.responseContract==="resume_candidate_v5")workCoverage=reviewResumeCandidateWorkCoverage(boundSource,candidate);
              if(attribution.length)fail("candidate_source_attribution_conflict",422);
              if(workCoverage?.missingCurrentGroups.length)fail("candidate_current_work_omitted",422);
            }
            // Preserve the exact full wire, including whitespace. No exporter repairs.
            decision={kind:"reply",content:output};
          }else{
          const clean=output.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,"").replace(/\s*\x60\x60\x60$/,"");
          const parsed=FreeChatReplyDecisionSchema.safeParse(JSON.parse(clean)),reply=parsed.success?parsed.data:fail("invalid_free_chat_reply",422);
          decision={...reply,actions:freeChatActions(task,reply)};
          }
        }catch(error){
          if(error instanceof CareerTaskError&&error.status!==422)throw error;
          const rejected=state.recent.filter(item=>typeof item==="object"&&item!==null&&"kind" in item&&item.kind===`${task.kind}_rejected`&&"turn" in item&&item.turn===task.turn).length;
          const code=error instanceof SyntaxError?"invalid_json":task.kind==="experience_refine"?"invalid_experience_reply":safeCode(error);
          await this.checkedAny(id,a,s=>{s.recent.push({kind:`${task.kind}_rejected`,turn:task.turn,code,...(attribution?.length?{attribution}:{}),...(workCoverage?.missingCurrentGroups.length?{workCoverage}:{}),...(task.kind==="experience_refine"&&error instanceof Error?{validation:error.message}:{})});event(s.task,"decision",`Rejected conversational output: ${code}; complete output retained.`);});
          if(contract==="resume_replacement_v1")fail("invalid_resume_replacement",422);
          if(rejected>=2)fail("decision_repair_exhausted",422);
          continue;
        }
        await this.checkedAny(id,a,s=>{
          if(!isConversationTask(s.task))fail("task_kind_not_supported_by_operation",422);
          const current=s.task as ConversationTask;
          const reply:NonNullable<FreeChatTask["reply"]>={id:`msg_${digest([id,current.turn]).slice(0,28)}`,role:"assistant",content:decision.content,
            ...(decision.actions?.length?{actions:decision.actions}:{}),createdAt:date(),
            meta:{provider:"custom",providerLabel:current.runtimeBinding.label,model:current.runtimeBinding.label,source:"agent-host",status:"ready",observedAt:date(),taskId:current.id,
              ...(finishReason?{finishReason,...(["stop","end_turn"].includes(finishReason)?{completeness:"complete" as const}:{})}:{})}};
          if(current.conversation.messages.some(message=>message.id===reply.id))fail("duplicate_message_identity",422);
          current.conversation.messages.push(reply);current.reply=reply;if(current.kind==="experience_refine")current.refinementReply=refinementReply;delete current.partialOutput;hold(s,"awaiting_answer");event(current,"decision","Conversation reply ready; no tool, resume write or fact adoption executed. Next turn requires explicit user input.");
        });return;
      }
    }catch(error){
      const code=safeCode(error);
      if(!a.controller.signal.aborted&&this.active.get(id)===a)await this.stopActive(id,a,code.includes("budget")?"budget_exhausted":["model_output_incomplete","project_context_changed"].includes(code)?"paused":"failed",code);
    }finally{if(!a.controller.signal.aborted)this.drop(id,a);}
  }
  private async checkedProject(id:string,a:Active,fn:(s:Store<ProjectUnderstandingTask>)=>void|Promise<void>){return projectStore(await this.checkedAny(id,a,s=>fn(projectStore(s))));}
  private recordProjectVerification(s:ProjectStore,item:{grantId:string;path:string;hash:string},call:number,
    check:"model_source_version"|"selected_quote"|"human_confirmation",verified:boolean){
    s.recent.push({kind:"project_verification_result",call,check,grantId:item.grantId,path:item.path,hash:item.hash,
      result:verified?{verified:true}:{error:{code:"source_changed_new_comparison_required"}}});
    event(s.task,"tool_result",`Project ${check} verification: ${verified?"verified":"source_changed_new_comparison_required"}.`);
  }
  private async recheckProjectFiles(id:string,a:Active){
    const current=await this.checkedProject(id,a,()=>{});
    for(const item of this.projectFiles(current)){
      const grant=current.grants.find(grant=>grant.id===item.grantId&&!grant.revokedAt);if(!grant)fail("source_changed_new_comparison_required");
      const reserved=await this.checkedProject(id,a,async s=>{await this.reserve(s,"tool");event(s.task,"tool_call","Revalidate project source before model send.");});
      let result:EvidenceResult|undefined;
      try{result=await this.broker.execute(grant!,{operation:"read",path:item.path,startLine:item.startLine,endLine:item.startLine},a.controller.signal);}
      catch{a.controller.signal.throwIfAborted();}
      const verified=Boolean(result?.evidence.some(value=>value.hash===item.hash));
      await this.checkedProject(id,a,s=>this.recordProjectVerification(s,item,reserved.task.usage.toolCalls,"model_source_version",verified));
      if(!verified)fail("source_changed_new_comparison_required");
    }
  }
  private async verifyProjectQuoteFiles(id:string,a:Active,rows:ProjectQuoteReview["evidence"]){
    for(const row of rows){
      const state=await this.checkedProject(id,a,async s=>{await this.reserve(s,"tool");event(s.task,"tool_call","Verify selected quote at its original file coordinates.");});
      const grant=state.grants.find(item=>item.id===row.grantId&&!item.revokedAt);
      if(!grant||row.startOffset===undefined||row.endOffset===undefined)fail("source_changed_new_comparison_required");
      let reread:EvidenceResult|undefined;
      try { reread=await this.broker.execute(grant!,{operation:"read",path:row.path,offset:row.startOffset,length:row.endOffset!-row.startOffset!},a.controller.signal); }
      catch { a.controller.signal.throwIfAborted(); }
      const verified=Boolean(reread?.evidence.some(item=>item.hash===row.hash&&item.startOffset===row.startOffset&&item.endOffset===row.endOffset&&item.startLine===row.startLine&&item.endLine===row.endLine&&item.excerpt===row.excerpt));
      await this.checkedProject(id,a,s=>this.recordProjectVerification(s,row,state.task.usage.toolCalls,"selected_quote",verified));
      if(!verified)fail("source_changed_new_comparison_required");
    }
  }
  private async executeProject(id:string,a:Active){
    let repairs=0, repeatedReadBatch=false;
    try{
      for(;;){
        await this.recheckProjectFiles(id,a);
        const state=await this.checkedProject(id,a,async s=>{
          if(Buffer.byteLength(JSON.stringify(s))>8*1024*1024)fail("task_storage_budget");
          mountProjectContext(s);await this.reserve(s,"model");event(s.task,"model",`project_understanding send ${s.task.usage.modelCalls}; shared root ledger.`);
        });
        const ledger=state.task.rootLedger??state.task;
        // The current model call has been reserved. A read on the last call
        // would leave the newly acquired evidence without a synthesis turn.
        const synthesisOnly=repeatedReadBatch || ledger.usage.modelCalls>=ledger.budget.maxModelCalls || ledger.usage.toolCalls>=ledger.budget.maxToolCalls;
        const quotation=projectQuoteTurn(state,synthesisOnly);
        const contract=quotation?.contract ?? (synthesisOnly?projectReplyContract(state):activeProjectEvidence(state).length?undefined:projectSourceDiscovery);
        if(quotation?.kind==="review") await this.checkedProject(id,a,s=>{
          s.recent.push({kind:"project_quote_catalog",turn:s.task.project.turnCount,modelCall:s.task.usage.modelCalls,rows:quotation.rows.map(({id,evidence})=>{
            return {selectionId:id,evidenceId:evidence.id,grantId:evidence.grantId,path:evidence.path,hash:evidence.hash,startLine:evidence.startLine,endLine:evidence.endLine,startOffset:evidence.startOffset,endOffset:evidence.endOffset};
          })});
        });
        const response=await a.runtime.reasoner(quotation?.prompt??projectPrompt(state,synthesisOnly),a.controller.signal,"project_understanding",undefined,undefined,contract),output=modelOutputText(response),finishReason=modelFinishReason(response);
        const providerFields=providerJournalFields(response,state.task.usage.modelCalls);
        await this.checkedProject(id,a,async s=>{
          if(output.length>126000){await this.preserveOverflowOutput(s,output,a.token,providerFields);return;}
          s.recent.push({kind:"project_understanding_output",turn:s.task.project.turnCount,output,finishReason,...providerFields});
          if(modelOutputIncomplete(response))s.task.partialOutput={text:output,finishReason};
        });
        if(output.length>126000)fail("decision_output_budget",413);
        if(modelOutputIncomplete(response))fail("model_output_incomplete",422);
        let decision:ReturnType<typeof projectDecision>, verified:ProjectQuoteReview|undefined;
        try{
          if(quotation?.kind==="review") {
            verified=verifyProjectQuoteReview(quotation.rows,JSON.parse(output),quotation.missingFiles);
            decision=verified.reply;
          } else {
            decision=projectDecision(state,output);
            if(quotation?.contract?.mode==="project_quote_sources" && (decision.kind!=="read" ||
              decision.requests.some(request=>request.operation!=="read" || !quotation.contract?.files?.includes(request.path) || !quotation.contract?.grantIds?.includes(request.grantId)))) fail("project_quote_read_expected_files",422);
          }
          if(synthesisOnly&&decision.kind!=="reply")fail("project_synthesis_required",422);
          if(contract===projectSourceDiscovery&&decision.kind==="read"&&decision.requests.some(request=>request.operation==="read_evidence"))fail("project_read_manifest_required",422);
        }
        catch(error){
          const code=error instanceof SyntaxError?"invalid_json":safeCode(error);
          await this.checkedProject(id,a,s=>{s.recent.push({kind:"project_understanding_rejected",turn:s.task.project.turnCount,code,validation:error instanceof Error?error.message:"Invalid project decision"});event(s.task,"decision",`Rejected project output: ${code}; complete output retained.`);});
          if(++repairs>2)fail("decision_repair_exhausted",422);continue;
        }
        if(decision.kind==="reply"){
          const reply=decision;
          if(verified) await this.verifyProjectQuoteFiles(id,a,verified.evidence);
          await this.checkedProject(id,a,s=>{
            if(verified) {
              const exposed=new Set(s.exposedEvidenceIds);
              // The quote catalog itself exposed these exact spans. The full
              // parent records must still be active and the broker reread above
              // must have succeeded, including those outside general Top-K.
              checkQuoteProvenance(verified.evidence,activeProjectEvidence(s));
              for(const item of verified.evidence){collectProjectEvidence(s,item);exposed.add(item.id);}
              s.exposedEvidenceIds=[...exposed];
              reply.understanding=preserveConfirmedUnderstanding(s,reply.understanding);
              s.recent.push({kind:"project_quote_result",turn:s.task.project.turnCount,modelCall:s.task.usage.modelCalls,evidenceIds:verified.evidence.map(item=>item.id)});
            }
            projectProtocol(s).validateReply(protocolState(s),reply);const session=s.task.project;
            session.understanding=reply.understanding;session.summaryHash=understandingHash(reply.understanding);session.question=reply.question;
            session.messages.push({id:`msg_${randomUUID()}`,role:"agent",text:reply.message,at:date(),question:reply.question});
            if(session.checkpoint)session.checkpoint.status="complete";
            hold(s,reply.readyForConfirmation?"awaiting_review":"awaiting_answer");event(s.task,"question",reply.readyForConfirmation?"Complete project understanding is ready for explicit human confirmation, not personal adoption.":reply.question!.text);
          });return;
        }
        let unchangedReads=0;
        for(const request of decision.requests){
          const snapshot=await this.checkedProject(id,a,async s=>{await this.reserve(s,"tool");event(s.task,"tool_call",`project ${request.operation}`);});
          let result:EvidenceResult|{error:{code:string}};
          try{
            if(request.operation==="read_evidence"){
              if(request.grantId!=="evidence"||request.offset===undefined||request.length===undefined)fail("evidence_page_required",422);
              const item=projectHandle(snapshot,request.path);if(!item)fail("evidence_handle_unavailable",422);
              const offset=request.offset!,pageLength=request.length!;
              if(item!.startOffset===undefined||item!.endOffset===undefined||offset<item!.startOffset||offset>=item!.endOffset)fail("evidence_page_out_of_range",422);
              const length=Math.min(pageLength,item!.endOffset!-offset);
              if(item!.grantId==="conversation")result=projectProtocol(snapshot).history(protocolState(snapshot),{operation:"read",path:item!.path,offset,length});
              else{
                const grant=snapshot.grants.find(grant=>grant.id===item!.grantId&&!grant.revokedAt);if(!grant)fail("grant_unavailable",403);
                result=await this.broker.execute(grant!,{operation:"read",path:item!.path,offset,length},a.controller.signal);
              }
              if(!result.evidence.every(value=>value.hash===item!.hash))fail("source_changed_new_comparison_required");
            }else if(request.grantId==="conversation")result=projectProtocol(snapshot).history(protocolState(snapshot),{...request,operation:request.operation});
            else{
              const grant=snapshot.grants.find(grant=>grant.id===request.grantId&&!grant.revokedAt);if(!grant)fail("grant_unavailable",403);
              result=await this.broker.execute(grant!,{...request,operation:request.operation},a.controller.signal);
            }
          }catch(error){a.controller.signal.throwIfAborted();result={error:{code:safeCode(error)}};}
          const observed=result;
          if(request.operation==="read" && "evidence" in observed && observed.evidence.length &&
            observed.evidence.every(item=>snapshot.task.project.evidence.some(previous=>previous.id===item.id&&previous.hash===item.hash))) unchangedReads++;
          await this.checkedProject(id,a,s=>{
            const ids:string[]=[];if("evidence" in observed)for(const item of observed.evidence){collectProjectEvidence(s,item);ids.push(item.id);}
            if("entries" in observed&&observed.entries&&request.grantId!=="conversation"){
              const meta=projectPrivate(s);meta.directories=[...(meta.directories??[]).filter(item=>item.grantId!==request.grantId||item.path!==request.path),{grantId:request.grantId,path:request.path,version:digest(observed.entries),at:Date.now(),entries:observed.entries,truncated:observed.truncated}];
            }
            const session=s.task.project;if(session.checkpoint){session.checkpoint.used=s.task.usage.toolCalls-projectPrivate(s).turnToolStart;session.checkpoint.evidenceIds=[...new Set([...session.checkpoint.evidenceIds,...ids])];}
            // Original excerpts live once in the durable evidence journal. The
            // observation names every record; the manifest can reread each one.
            s.recent.push({call:snapshot.task.usage.toolCalls,operation:request.operation,request,evidenceIds:ids,result:"error" in observed?observed:{entries:observed.entries,truncated:observed.truncated,skipped:observed.skipped}});
            event(s.task,"tool_result",`project ${request.operation}: ${ids.length} evidence records; ${"error" in observed?observed.error.code:"returned"}`);
          });
          if("error" in observed&&observed.error.code==="source_changed_new_comparison_required")fail(observed.error.code);
        }
        repeatedReadBatch=unchangedReads===decision.requests.length;
      }
    }catch(error){
      const code=safeCode(error);
      if(!a.controller.signal.aborted&&this.active.get(id)===a)await this.stopActive(id,a,code.includes("budget")?"budget_exhausted":["model_output_incomplete","source_changed_new_comparison_required","interaction_lease_invalid"].includes(code)?"paused":"failed",code);
    }finally{if(!a.controller.signal.aborted)this.drop(id,a);}
  }
  private async recheckFiles(id:string,a:Active){
    const s=await this.checked(id,a,()=>{}),checked=new Set<string>();
    for(const e of s.task.evidence.filter(x=>x.sourceId.startsWith("dir:"))){
      const key=digest([e.sourceId,e.path,e.hash]);if(checked.has(key))continue;checked.add(key);
      const grant=s.grants.find(g=>`dir:${g.id}`===e.sourceId&&!g.revokedAt);
      if(!grant||!e.path)fail("source_changed_new_comparison_required");
      await this.checked(id,a,async current=>{await this.reserve(current,"tool");event(current.task,"tool_call","Revalidate previously cited file");});
      const result=await this.broker.execute(grant!,{operation:"read",path:e.path,startLine:e.startLine,endLine:e.startLine},a.controller.signal);
      if(!result.evidence.some(x=>x.hash===e.hash))fail("source_changed_new_comparison_required");
    }
  }
  private toolFile(versionId:string){if(!/^tool_[a-f0-9]{32}$/.test(versionId))fail("invalid_tool_version",422);return path.join(this.opts.directory,"tool-library",`${versionId}.json`);}
  private async toolRecord(versionId:string){
    const raw=await readPrivateJson(this.toolFile(versionId));if(!raw)return undefined;
    const record=raw as {artifact:CareerToolArtifact;status:"installed"|"revoked";sourceTaskId:string;approvedAt:string};
    const artifact=parseArtifact(record.artifact);if(artifact.versionId!==versionId||!["installed","revoked"].includes(record.status))fail("invalid_tool_artifact",503);
    return {...record,artifact};
  }
  async listInstalledTools(){return this.atomic(async()=>{
    const directory=path.join(this.opts.directory,"tool-library");const names=await fs.readdir(directory).catch((e:NodeJS.ErrnoException)=>{if(e.code==="ENOENT")return [];throw e;});
    const result:CareerToolArtifact[]=[];for(const file of names.filter(n=>/^tool_[a-f0-9]{32}\.json$/.test(n))){const record=await this.toolRecord(file.slice(0,-5));if(record?.status==="installed")result.push(record.artifact);}return result;
  });}
  async installTool(id:string,revision:number,versionId:string,sourceHash:string,access:CareerTaskAccess){
    return this.change(id,async s=>{checkRevision(s,revision);if(!["awaiting_review","paused","completed"].includes(s.task.status))fail("tool_review_required");
      const artifact=s.task.tools?.find(t=>t.versionId===versionId&&t.sourceHash===sourceHash);if(!artifact)fail("tool_artifact_changed");parseArtifact(artifact!);
      await this.assertAccess(access);await privateDirectory(path.dirname(this.toolFile(versionId)));
      await writePrivateJson(this.toolFile(versionId),{artifact,status:"installed",sourceTaskId:id,approvedAt:date()});
      event(s.task,"decision",`User separately installed ${versionId} (${sourceHash}). New tasks still require an explicit version grant.`);
    },access);
  }
  async revokeTool(versionId:string,sourceHash:string,access:CareerTaskAccess){
    await this.atomic(async()=>{await this.assertAccess(access);const record=await this.toolRecord(versionId);if(!record||record.artifact.sourceHash!==sourceHash)fail("tool_artifact_changed");
      await this.assertAccess(access);await writePrivateJson(this.toolFile(versionId),{...record,status:"revoked"});});
    for(const [id,a] of this.active){const task=await this.readTask(id);if(isCareerTask(task)&&(task.toolPolicy?.installedVersionIds.includes(versionId)||task.tools?.some(t=>t.versionId===versionId)))await this.stopActive(id,a,"paused","tool_version_revoked");}
  }
  private async executeGeneratedTool(id:string,a:Active,s:Store,request:Extract<import("@better-me/agent-contracts").CareerTaskDecision,{kind:"tool"}>){
    if(!taskTools(s.task).some(t=>t.tool===request.tool))fail("tool_not_granted",403);
    const reserve:Reserve=async(kind,detail)=>{await this.checked(id,a,async current=>{await this.reserve(current,kind);event(current.task,kind==="model"?"model":"tool_call",detail);});};
    if(request.tool==="build_tool"){
      await this.checked(id,a,current=>{const used=current.task.toolUsage??={builds:0,executions:0};if(used.builds>=3)fail("tool_build_limit",422);used.builds++;});
      const artifact=await buildTaskTool(request.id??"",a.runtime.reasoner,reserve,a.controller.signal);
      await this.checked(id,a,current=>{const artifacts=current.task.tools??=[];if(!artifacts.some(t=>t.versionId===artifact.versionId))artifacts.push(artifact);event(current.task,"decision",`Qualified task-local ${artifact.versionId}; ${artifact.testsPassed}/${artifact.testsTotal} frozen cases. Not installed.`);});
      const {source:_,...view}=artifact;return {evidence:[],detail:view};
    }
    let artifact=s.task.tools?.find(t=>t.versionId===request.id);
    const installed=await this.toolRecord(request.id??"");if(installed?.status==="revoked")fail("tool_version_revoked",403);
    if(!artifact){if(!s.task.toolPolicy?.installedVersionIds.includes(request.id??"")||installed?.status!=="installed")fail("tool_not_granted",403);artifact=installed!.artifact;}
    const material=s.task.materials.find(m=>m.id===request.materialId);if(!material)fail("material_not_granted",403);
    await this.checked(id,a,current=>{const used=current.task.toolUsage??={builds:0,executions:0};if(used.executions>=8)fail("tool_execution_limit",422);used.executions++;});
    const records=await invokeTaskTool(artifact!,material!.text,reserve,a.controller.signal),offset=request.offset??0,length=Math.min(40,request.length??40),page=records.slice(offset,offset+length);
    // Recheck revocation after the worker resolves, before publishing any observation.
    if((await this.toolRecord(artifact!.versionId))?.status==="revoked")fail("tool_version_revoked",403);
    return {evidence:page.map(row=>evidence(material!.kind,`material:${material!.id}`,material!.label,material!.text,row.line,row.line)),detail:{versionId:artifact!.versionId,sourceHash:artifact!.sourceHash,records:page,total:records.length,nextOffset:offset+length<records.length?offset+length:null,derived:true,actualInputVerified:true}};
  }
  private async execute(id:string,a:Active,recheck:boolean){
    try{
      const initial=await this.atomic(()=>this.load(id));
      if(initial.task.workflow){
        const s=await this.checked(id,a,async s=>{await this.reserve(s,"model");event(s.task,"model",`Text ${s.task.writingConfirmation?"draft":"selection"}; one explicit phase, no automatic retry.`);});
        const phase=s.task.writingConfirmation?"resume_text_draft":"resume_text_plan";
        let response:CareerTaskModelOutput,rejected:RejectedTaskModelOutput|undefined;
        try{response=await a.runtime.reasoner(writingPrompt(s.task),a.controller.signal,phase,undefined,undefined,writingModelContract(s.task));}
        catch(error){if(!(error instanceof RejectedTaskModelOutput))throw error;response=error.output;rejected=error;}
        const out=modelOutputText(response);
        const providerFields=providerJournalFields(response,s.task.usage.modelCalls);
        // Returned bytes belong to the original owner even after a stop. Archival
        // is not permission to publish a plan, adopt a draft, or resume the turn.
        await this.atomic(async()=>{const stored=await this.load(id),current=!rejected&&this.active.get(id)===a&&stored.runGeneration===a.token&&stored.task.status==="running"&&!a.controller.signal.aborted;
          stored.recent.push({writingPhase:phase,output:out,finishReason:modelFinishReason(response),runGeneration:a.token,late:!current,...providerFields});await this.save(stored);});
        if(rejected)throw rejected;
        await this.checked(id,a,()=>{});
        if(out.length>126000)fail("decision_too_large",422);
        const incomplete=modelOutputIncomplete(response);
        let raw;
        if(incomplete){
          // Never parse partial model JSON. An unambiguous, explicitly
          // confirmed field edit can still be assembled mechanically. At
          // planning time offer the complete inventory without model advice.
          raw=s.task.writingConfirmation?{kind:"grounded_edits",selectedIds:[]}:{kind:"field_plan",selections:[],questions:[]};
        }else{try{raw=JSON.parse(out.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,"").replace(/\s*\x60\x60\x60$/,""));}catch{fail("invalid_json",422);}}
        await this.checked(id,a,s=>{
          if(incomplete){
            s.recent.push({kind:"writing_fallback",phase,reason:modelFinishReason(response),runGeneration:a.token});
            event(s.task,"decision",s.task.writingConfirmation?"Incomplete model output retained. Prepared only unambiguous confirmed edits for review.":"Incomplete model output retained. Full field inventory requires manual selection.");
          }
          if(s.task.writingConfirmation){s.task.draft=writingDraft(s.task,raw);hold(s,"awaiting_review");event(s.task,"draft","Confirmed text draft ready; original resume, jobs and long-term facts unchanged.");}
          else{s.task.writingPlan=writingPlan(s.task,raw);s.task.question="请核对选材与实际补充；未知可以明确写未知。";s.task.questionEvidenceIds=[];hold(s,"awaiting_answer");event(s.task,"question","Selection and omissions ready. Explicit answer confirmation is required before drafting.");}
        });return;
      }
      if(recheck)await this.recheckFiles(id,a);
      let repairs=0;
      for(;;){
        // Revalidate Broker-backed sources before EVERY new model send, not
        // only after restart/resume. These reads use the same task tool ledger.
        if(!recheck)await this.recheckFiles(id,a);
        recheck=false;
        const s=await this.checked(id,a,async s=>{
          // Persist exact mounted passage identities before the model can cite them.
          // Source records are retained whole; retrieval never mutates an earlier observation.
          const mounted=taskContext(s.task,s.recent).evidence;
          for(const item of mounted)collectEvidence(s.task,item);
          s.exposedEvidenceIds=[...new Set([...(s.exposedEvidenceIds??[]),...mounted.map(item=>item.id)])];
          await this.reserve(s,"model");event(s.task,"model",`Model decision ${s.task.usage.modelCalls}/${s.task.budget.maxModelCalls}; shared root ledger`);});
        const response=await a.runtime.reasoner(prompt(s),a.controller.signal,"decision"),out=modelOutputText(response);
        if(modelOutputIncomplete(response)){
          await this.checked(id,a,s=>{s.recent.push({incompleteModelOutput:out,finishReason:modelFinishReason(response)});});fail("model_output_incomplete",422);
        }
        let decision;
        try{
          if(out.length>126000)fail("decision_too_large",422);
          const clean=out.trim().replace(/^\x60\x60\x60(?:json)?\s*/i,"").replace(/\s*\x60\x60\x60$/,"");
          const raw=JSON.parse(clean);const parsed=CareerTaskDecisionSchema.safeParse(raw);if(!parsed.success)fail("invalid_decision",422);decision=parsed.data!;
          if(decision.kind==="ask_user"){
            const q=decision;
            if(!s.task.evidence.some(e=>e.kind==="job")||!s.task.evidence.some(e=>e.kind==="resume"))fail("read_job_and_resume_first",422);
            if(s.task.evidence.filter(e=>e.sourceId.startsWith("answer:")).length && s.task.events.some(e=>e.kind==="question"&&e.detail===q.question))fail("question_already_answered",422);
            await this.checked(id,a,s=>{requireEvidence(s.task,q.evidenceIds,s.exposedEvidenceIds);s.task.question=q.question;s.task.questionEvidenceIds=q.evidenceIds;hold(s,"awaiting_answer");event(s.task,"question",q.question);});return;
          }
          if(decision.kind==="draft"){
            const proposal=decision;await this.checked(id,a,s=>{s.task.draft=validateDraft(s.task,proposal,s.exposedEvidenceIds);hold(s,"awaiting_review");event(s.task,"draft","Draft is ready for line-by-line human review; nothing saved to a resume.");});return;
          }
        }catch(e){
          if(e instanceof CareerTaskError&&e.status!==422)throw e;
          if(++repairs>2)fail("decision_repair_exhausted",422);
          const code=e instanceof SyntaxError?"invalid_json":safeCode(e);
          await this.checked(id,a,s=>{s.recent.push({decisionRejected:code});event(s.task,"decision",`Rejected decision: ${code}.`);});continue;
        }
        const request=decision!;
        const reserved = await this.checked(id, a, async current => {
          await this.reserve(current, "tool");
          // The reservation and exact decision reach disk before dispatch. A
          // terminated turn leaves an unobserved call, never a successful read.
          current.recent.push({ request, call: current.task.usage.toolCalls, status: "reserved" });
          event(current.task, "tool_call", request.tool);
        });
        const observationIndex = reserved.recent.length - 1;
        let result:Awaited<ReturnType<typeof executeTaskTool>>;try{result=request.tool==="build_tool"||request.tool==="use_tool"?await this.executeGeneratedTool(id,a,s,request):await executeTaskTool(s.task,s.grants,this.broker,request,a.controller.signal,s.statements);}
        catch(e){a.controller.signal.throwIfAborted();if(["source_changed_new_comparison_required","tool_version_revoked","interaction_lease_invalid"].includes(safeCode(e)))throw e;result={evidence:[],detail:{error:safeCode(e)}};}
        await this.checked(id,a,s=>{
          for(const item of result.evidence)collectEvidence(s.task,item);
          s.recent[observationIndex] = {
            request, call: reserved.task.usage.toolCalls, status: "observed", tool: request.tool,
            evidenceIds: result.evidence.map(item => item.id), result: result.detail,
          };
          event(s.task,"tool_result",`${request.tool}: ${result.evidence.length} evidence item(s); ${typeof result.detail==="object"&&result.detail&&"error" in result.detail?String(result.detail.error):"returned"}`);
        });
      }
    }catch(e){
      const code=safeCode(e);
      if(!a.controller.signal.aborted&&this.active.get(id)===a)await this.stopActive(id,a,code.includes("budget")?"budget_exhausted":["interaction_lease_invalid","source_changed_new_comparison_required","tool_version_revoked"].includes(code)?"paused":"failed",code);
    }finally{if(!a.controller.signal.aborted)this.drop(id,a);}
  }
  async stop(id:string,revision:number,revoke=false,access?:CareerTaskAccess){
    const task=await this.changeAny(id,s=>{
      const a=this.active.get(id),t=s.task;
      if(t.revision!==revision&&!(a&&revision>=a.startRevision&&revision<=t.revision))fail("task_revision_conflict");
      if(!stoppable.includes(t.status))fail("task_already_terminal");
      if(a)a.controller.abort(revoke?"revoked":"paused");
      if(revoke){s.grants.forEach(g=>{g.revokedAt=date();});hold(s,"revoked");}
      else if(t.status==="running"||t.status==="ready")hold(s,"paused");else fail("task_not_running");
      event(t,"stopped",revoke?"Material scope and pending decisions revoked.":"Paused by user; no result from the previous decision will be adopted.");
    },access);const a=this.active.get(id);if(a&&a.controller.signal.aborted)this.drop(id,a);
    const descendants=await this.atomic(async()=>{const state=await this.rootState(await this.loadAny(id));return [...state.members.values()].filter(member=>{
      let parentId=member.task.parentTaskId;while(parentId){if(parentId===id)return true;parentId=state.members.get(parentId)?.task.parentTaskId;}return false;
    }).map(member=>member.task.id);});
    for(const childId of descendants){const child=this.active.get(childId);if(child)await this.stopActive(childId,child,revoke?"revoked":"paused",revoke?"root_task_revoked":"root_task_paused");}
    return task;
  }
  async pauseGroup(id:string,revision:number,access?:CareerTaskAccess){return this.atomic(async()=>{
    await this.assertAccess(access);const current=await this.loadAny(id);checkRevision(current,revision);
    const {root,members}=await this.rootState(current);if(root.task.id!==id)fail("root_task_required");
    for(const member of members.values()){
      const active=this.active.get(member.task.id);if(!active)continue;
      active.controller.abort("root_task_paused");member.runGeneration++;hold(member,"paused");
      event(member.task,"stopped","User explicitly stopped the workspace group; cumulative usage and complete history retained.");
      await this.save(member);this.drop(member.task.id,active);
    }
    // A completed/confirmed or waiting root need not lose its receipt merely
    // because a different running descendant was explicitly stopped.
    return this.view(await this.loadAny(id));
  });}
  async budget(id:string,revision:number,budget:CareerTaskBudget,access?:CareerTaskAccess){const next=CareerTaskBudgetSchema.parse(budget);
    return this.changeAny(id,async s=>{checkRevision(s,revision);const {root,members,ledger}=await this.rootState(s);
      if(root.task.id!==id)fail("adjust_root_budget_only");
      if(s.task.status==="revoked"||[...members.keys()].some(memberId=>this.active.has(memberId)))fail("pause_before_adjusting_budget");
      for(const [key,used] of [["maxModelCalls","modelCalls"],["maxToolCalls","toolCalls"],["maxActiveMs","activeMs"]] as const)
        if(next[key]<ledger.usage[used])fail("budget_below_usage");
      s.task.budget=next;
      if(s.task.kind==="project_understanding"&&s.task.project.confirmation){delete s.task.project.confirmation;stage(s.task,"awaiting_review");}
      event(s.task,"budget","User explicitly set root-wide ceilings. All descendant usage retained; no child receives a fresh budget. A changed project revision requires fresh human confirmation.");},access);}
  async receipt(id:string,input:z.infer<typeof CareerTaskReceiptSchema>,access?:CareerTaskAccess){const data=CareerTaskReceiptSchema.parse(input);
    return this.change(id,s=>{const t=s.task;
      if(t.receipt&&t.receipt.draftHash===data.draftHash&&t.receipt.versionId===data.versionId&&t.receipt.receiptId===data.receiptId&&JSON.stringify(t.receipt.approvedPatchIds)===JSON.stringify(data.approvedPatchIds))return false;
      checkRevision(s,data.expectedRevision);if(t.status!=="awaiting_review"||t.draft?.hash!==data.draftHash)fail("draft_changed");
      if(new Set(data.approvedPatchIds).size!==data.approvedPatchIds.length||!data.approvedPatchIds.every(id=>t.draft!.patches.some(p=>p.id===id)))fail("approved_patch_invalid");
      t.receipt={versionId:data.versionId,...(data.receiptId?{receiptId:data.receiptId}:{}),draftHash:data.draftHash,approvedPatchIds:data.approvedPatchIds,at:date()};stage(t,"completed");event(t,"receipt","Browser reports approved version saved; not independent platform verification.");},access);}
  async fact(id:string,revision:number,text:string,refs:string[],access?:CareerTaskAccess){
    return this.change(id,s=>{checkRevision(s,revision);if(["revoked","running"].includes(s.task.status))fail("task_fact_unavailable");
      const cited=requireEvidence(s.task,refs);if(!text.trim()||text.length>4000||!cited.length||!cited.some(e=>e.kind==="user_statement"&&e.excerpt.includes(text.trim())))fail("personal_statement_quote_required",422);
      const factId=`fact_${digest([id,text,refs]).slice(0,24)}`;if(s.task.facts.some(f=>f.id===factId))return false;
      s.task.facts.push({id:factId,text:text.trim(),evidenceIds:refs,status:"proposed"});event(s.task,"fact","Separate user-statement fact proposal; no shared record changed.");},access);}
  async decideFact(id:string,revision:number,factId:string,approve:boolean,access?:CareerTaskAccess){
    return this.change(id,s=>{checkRevision(s,revision);if(s.task.status==="revoked")fail("task_revoked");const f=s.task.facts.find(v=>v.id===factId);if(!f||f.status!=="proposed")fail("fact_not_pending");f!.status=approve?"approved":"rejected";event(s.task,"fact",approve?"User confirmed this separate statement (not independent verification).":"User rejected the separate fact proposal.");},access);}
}
