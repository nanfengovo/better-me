import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CapabilityTaskRequest as RequestSchema, type CapabilityTaskRequest, type CapabilityTask, type CapabilitySnapshot,
    JobComparisonInput, EvidenceReviewInput, EvidenceReviewCommand, EvidenceProposalCommand, type CapabilityAssessment, type CapabilityStage } from "@better-me/agent-contracts";
import { privateDirectory, readPrivateJson, writePrivateJson } from "../identity/private-json.js";
import { IdentityError } from "../identity/service.js";
import { executeTransform } from "./sandbox.js";
import { CONTRACT, ENVIRONMENT, VERIFIER, hash, qualify, verifyTaskOutput, compareJobs, receipt } from "./verification.js";
import { ollamaBuilder, localModelAvailable, type ToolBuilder } from "./ollama.js";
import { EVIDENCE_RECIPE, EVIDENCE_VERIFIER, prepareEvidenceReview, verifyEvidenceReview } from "./evidence-review.js";
import { emptyEvidenceWorkspace, recordPersonalReview, proposePersonalEvidence, evidenceProposalEligibility } from "../workspace/evidence-proposals.js";
import { CreateSyntheticResumeCommand, ResumeChangeRequest, SaveResumeChangeCommand, RevokeResumePreviewCommand } from "@better-me/agent-contracts";
import { createSyntheticResume, prepareResumeChange, savePreparedResumeChange, priorResumeReceipt, revokeResumePreview } from "../workspace/resume-adoption.js";

export type TaskAccess = { session: string; valid: () => Promise<boolean> };
type State = CapabilitySnapshot & { schema: 1; closedSessions: string[] };
const terminal = new Set<CapabilityStage>(["completed", "failed", "cancelled", "interrupted", "partial"]);
const inputHash = (task: Pick<CapabilityTask, "input" | "intent" | "evidence">) => hash(task.intent === "prepare-evidence-review"
  ? { input: task.input, intent: task.intent, evidence: task.evidence } : task.input);
const artifact = (task: CapabilityTask) => task.intent === "prepare-evidence-review" ? task.evidenceReport : task.output;
const isSameDependency = (task: CapabilityTask) => task.selected && task.composition?.dependency.id === task.selected.id
  && task.composition.dependency.version === task.selected.version && task.composition.dependency.codeHash === task.selected.codeHash;
export class CareerCapabilities {
  private state!: State;
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private jobs: Promise<unknown> = Promise.resolve();
  private controllers = new Map<string, AbortController>();
  private filename: string;
  private writerLease: DatabaseSync | undefined;
  private closing = false;
  private storageError: string | undefined;
  private builder: ToolBuilder;
  constructor(private options: { directory: string; ownerId: string; builder?: ToolBuilder; localModelAvailable?: () => Promise<boolean>;
    /** Trusted checkpoint observer; runs outside the acceptance lock, never exposed through HTTP. */
    onCheckpoint?: (event: { taskId: string; stage: CapabilityStage; detail: string }) => Promise<void> }) {
    this.filename = path.join(options.directory, "career-capabilities-v1.json");
    this.builder = options.builder ?? ollamaBuilder();
    this.ready = this.initialize();
  }
  private async initialize() {
    await privateDirectory(this.options.directory);
    // Reuse the workspace's Node SQLite primitive for a crash-released OS lease.
    // A PID lock with stale-file deletion has a two-startup race; never use it.
    const leasePath = path.join(this.options.directory, "writer-lease.sqlite");
    try { const handle = await fs.open(leasePath, "wx", 0o600); await handle.close(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await fs.lstat(leasePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe_writer_lease");
    await fs.chmod(leasePath, 0o600);
    const lease = new DatabaseSync(leasePath);
    try { lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;"); this.writerLease = lease; }
    catch (error) { lease.close(); throw new Error("single_writer_required", { cause: error }); }
    const raw = await readPrivateJson(this.filename);
    if (raw !== undefined) {
      const saved = raw as State;
      if (saved.schema !== 1 || saved.ownerId !== this.options.ownerId || !Array.isArray(saved.tasks) || !Array.isArray(saved.versions)
        || !Array.isArray(saved.closedSessions) || !Number.isSafeInteger(saved.catalogRevision)) throw new Error("capability_store_invalid");
      this.state = saved;
      for (const version of this.state.versions) {
        if (version.codeHash !== hash(version.source) || version.environment !== ENVIRONMENT || version.contract !== CONTRACT
          || version.qualification.targetHash !== version.codeHash || version.qualification.verifierVersion !== VERIFIER || version.qualification.status !== "passed") {
          version.state = "disabled"; version.disabledReason = "implementation_or_verification_invalidated"; this.state.catalogRevision++;
          for (const task of this.state.tasks) if (task.selected?.version === version.version) task.reviewReason = "能力实现或验证已失效；历史产物待核对，原回执保留";
        }
      }
      for (const task of this.state.tasks) if (!terminal.has(task.stage)) {
        task.stage = "interrupted"; task.error = "host_restarted_check_receipt_no_automatic_replay";
        task.grant.revoked = true; task.grant.revision++;
      }
      for (const task of this.state.tasks) if (task.intent === "prepare-evidence-review" && task.composition?.recipeHash !== EVIDENCE_RECIPE.recipeHash)
        task.reviewReason = "证据核对配方已变更；历史报告及回执保留，不自动认定个人贡献";
      await writePrivateJson(this.filename, this.state);
    } else this.state = { schema: 1, ownerId: this.options.ownerId, catalogRevision: 0, tasks: [], versions: [], closedSessions: [] };
  }
  /** All authorization/revision checks and effects share this durable serial acceptance point. */
  private atomic<T>(change: (state: State) => Promise<T> | T): Promise<T> {
    const run = this.queue.then(async () => {
      await this.ready;
      const draft = structuredClone(this.state), result = await change(draft);
      try { await writePrivateJson(this.filename, draft); }
      catch { this.storageError = "private_store_unavailable_no_new_receipt"; throw new Error(this.storageError); }
      this.storageError = undefined; this.state = draft; return structuredClone(result);
    });
    this.queue = run.catch(() => undefined); return run;
  }
  async snapshot(): Promise<CapabilitySnapshot> {
    await this.ready; await this.queue;
    return structuredClone({ ownerId: this.state.ownerId, catalogRevision: this.state.catalogRevision,
      tasks: this.state.tasks.map(task => this.storageError && !terminal.has(task.stage)
        ? { ...task, stage: artifact(task) ? "partial" : "interrupted", error: this.storageError } : task),
      versions: this.state.versions, ...(this.state.workspace ? { workspace: { ...this.state.workspace,
        proposals: this.state.workspace.proposals.map(proposal => ({ ...proposal, eligibility: evidenceProposalEligibility(this.state.workspace!, proposal,
          this.state.tasks.find(task => task.id === proposal.source.taskId)) })) } } : {}),
      ...(this.storageError ? { storageError: this.storageError } : {}) });
  }
  private async guard(state: State, task: CapabilityTask, access: TaskAccess) {
    if (this.closing || task.session !== access.session || state.closedSessions.includes(access.session) || task.grant.revoked
      || task.grant.expiresAt <= Date.now() || task.contract.deadline <= Date.now() || terminal.has(task.stage) || !await access.valid())
      throw new IdentityError(403, "task_grant_expired_or_revoked");
  }
  async assess(request: { input?: unknown; evidence?: unknown; consent?: boolean; intent?: string; idempotencyKey?: string }, access: TaskAccess): Promise<CapabilityAssessment> {
    if (request.intent && !["compare-job-exports", "prepare-evidence-review"].includes(request.intent)) return { kind: "prohibited", reason: "此档位不允许安装、外部行动或改写职业事实" };
    const parsed = JobComparisonInput.safeParse(request.input);
    if (!parsed.success) return { kind: "missing_input", reason: "需要符合 board-v1 / board-v2 契约的两批岗位快照；不强行套用工具" };
    const evidence = request.intent === "prepare-evidence-review" ? EvidenceReviewInput.safeParse(request.evidence) : undefined;
    if (evidence && !evidence.success) return { kind: "missing_input", reason: "需要本次明确提供的项目线索；空线索清单也允许，不读取旧记录补齐" };
    const state = await this.snapshot();
    if (!request.consent || this.state.closedSessions.includes(access.session) || !await access.valid()) return { kind: "needs_grant", reason: "需要本次输入及私人报告的有效交互授权" };
    const requestedHash = inputHash({ input: parsed.data, intent: request.intent === "prepare-evidence-review" ? request.intent : undefined,
      evidence: evidence?.success ? evidence.data : undefined });
    const saved = state.tasks.find(task => task.logicalKey === request.idempotencyKey && task.inputHash === requestedHash && task.receipt);
    if (saved?.receipt) return { kind: "ready", reason: "相同逻辑操作已有持久回执，直接核对，不重复生成或保存", receiptId: saved.receipt.id };
    const version = [...state.versions].reverse().find(item => item.state === "reusable" && item.contract === CONTRACT && item.environment === ENVIRONMENT
      && item.codeHash === hash(item.source) && item.qualification.status === "passed" && item.qualification.targetHash === item.codeHash && item.qualification.verifierVersion === VERIFIER);
    if (version) return { kind: "compose", reason: "复用已验证转换工具，与可信差异/报告命令组合；不再构建", version: version.version };
    const available = await (this.options.localModelAvailable?.() ?? (this.options.builder ? Promise.resolve(true) : localModelAvailable()));
    if (!available) return { kind: "temporary_unavailable", reason: "本地权重或 Ollama 暂不可用；不改收费通道、不把故障当新能力缺口" };
    return { kind: "gap", reason: "目录缺少该契约的合格转换工具，可在当前授权与预算内生成候选" };
  }
  async start(raw: CapabilityTaskRequest, access: TaskAccess): Promise<CapabilityTask> {
    const request = RequestSchema.parse(raw);
    if (Buffer.byteLength(JSON.stringify({ input: request.input, evidence: request.evidence })) > 2 * 1024 * 1024) throw new IdentityError(413, "input_too_large");
    const requestHash = hash({ input: request.input, model: request.model, consent: request.consent,
      ...(request.intent === "prepare-evidence-review" ? { intent: request.intent, evidence: request.evidence } : {}) });
    const result = await this.atomic(async state => {
      if (this.closing || state.closedSessions.includes(access.session) || !await access.valid()) throw new IdentityError(403, "interaction_lease_invalid");
      const prior = state.tasks.find(task => task.logicalKey === request.idempotencyKey);
      if (prior) {
        if (prior.requestHash !== requestHash) throw new IdentityError(409, "idempotency_input_conflict");
        return { task: prior, fresh: false };
      }
      if (state.catalogRevision !== request.expectedCatalogRevision) throw new IdentityError(409, "catalog_revision_conflict");
      const task: CapabilityTask = { id: randomUUID(), ownerId: state.ownerId, stage: "assessing", input: request.input,
        ...(request.intent === "prepare-evidence-review" ? { intent: request.intent, evidence: request.evidence } : {}),
        inputHash: inputHash(request), logicalKey: request.idempotencyKey, requestHash, session: access.session,
        grant: { revision: 1, revoked: false, expiresAt: Date.now() + 600_000 },
        contract: { version: CONTRACT, deliverable: request.intent === "prepare-evidence-review" ? "private-evidence-review" : "private-job-comparison-report",
          acceptance: request.intent === "prepare-evidence-review" ? ["source-faithful", "explicit-current-input-links", "pending-personal-claims", "durable-private-report"]
            : ["source-faithful", "same-namespace-and-id", "durable-private-report"],
          buildLimit: 3, deadline: Date.now() + 540_000 }, builds: [], builderCalls: 0, events: [], createdAt: new Date().toISOString() };
      state.tasks.push(task); return { task, fresh: true };
    });
    if (result.fresh) {
      // One active build per owner; queued work re-assesses the now-current catalogue.
      const job = this.jobs.then(() => this.run(result.task.id, access)); this.jobs = job.catch(() => undefined);
    }
    return result.task;
  }
  private async step(id: string, access: TaskAccess, stage: CapabilityStage, detail: string,
    change?: (state: State, task: CapabilityTask) => void) {
    const result = await this.atomic(async state => {
      const task = state.tasks.find(task => task.id === id)!;
      await this.guard(state, task, access);
      change?.(state, task); task.stage = stage; task.events.push({ stage, detail, at: new Date().toISOString() });
      return task;
    });
    await this.options.onCheckpoint?.({ taskId: id, stage, detail });
    return result;
  }
  private async run(id: string, access: TaskAccess) {
    const controller = new AbortController(); this.controllers.set(id, controller);
    let candidateHash: string | undefined;
    try {
      let task = await this.step(id, access, "assessing", "核对当前账号、输入契约与可复用版本");
      const assessment = await this.assess({ input: task.input, intent: task.intent, evidence: task.evidence, consent: true, idempotencyKey: task.logicalKey }, access);
      if (assessment.kind === "temporary_unavailable") throw new Error("local_model_temporarily_unavailable");
      if (["needs_grant", "missing_input", "prohibited"].includes(assessment.kind)) throw new Error("task_preconditions_unsatisfied");
      const catalog = await this.snapshot();
      let version = [...catalog.versions].reverse().find(item => item.state === "reusable" && item.contract === CONTRACT && item.environment === ENVIRONMENT
        && item.codeHash === hash(item.source) && item.qualification.status === "passed" && item.qualification.targetHash === item.codeHash
        && item.qualification.verifierVersion === VERIFIER);
      const expectedRevision = catalog.catalogRevision;
      if (!version) {
        task = await this.step(id, access, "acquiring", "缺少两种岗位导出格式的合格转换工具；仅向本地 Ollama 发送通用规格", (_state, current) => {
          current.acquisition = { gap: CONTRACT, method: "generate-json-transform", verifier: VERIFIER, scope: "JSON-only; no installation/network/host access" };
        });
        let feedback: string | undefined;
        for (let attempt = 1; attempt <= task.contract.buildLimit; attempt++) {
          const buildId = randomUUID();
          await this.step(id, access, "acquiring", `正在真实生成候选 ${attempt}/${task.contract.buildLimit}`, (_state, current) => {
            current.builderCalls++; current.builds.push({ id: buildId, attempt, provider: "ollama-local", model: "gemma4:e2b-it-qat", status: "requested" });
          });
          let built;
          try { built = await this.builder(feedback, controller.signal); }
          catch {
            feedback = "generation_failed_or_invalid_json";
            await this.step(id, access, "acquiring", "生成请求失败或未返回完整源码，按剩余预算重试", (_state, current) => {
              const build = current.builds.find(item => item.id === buildId)!; build.status = "rejected"; build.error = feedback;
            }); continue;
          }
          candidateHash = hash(built.source);
          await this.step(id, access, "qualifying", "在受限运行器执行独立留出与反例测试", (_state, current) => {
            Object.assign(current.builds.find(item => item.id === buildId)!, built, { codeHash: hash(built.source), status: "generated" });
          });
          const qualification = await qualify(built.source, controller.signal);
          task = await this.step(id, access, "qualifying", qualification.status === "passed" ? "工具资格验证通过" : "候选未通过独立验证，不启用", (_state, current) => {
            const build = current.builds.find(item => item.id === buildId)!;
            build.qualification = qualification; build.status = qualification.status === "passed" ? "qualified" : "rejected";
          });
          if (qualification.status === "passed") {
            version = { id: CONTRACT, version: Math.max(0, ...catalog.versions.map(item => item.version)) + 1, codeHash: hash(built.source), source: built.source,
              contract: CONTRACT, environment: ENVIRONMENT, state: "qualified", qualification, sourceTask: id,
              provenance: { provider: built.provider, model: built.model, modelDigest: built.modelDigest, redistribution: "not-reviewed-private-only" } };
            const candidate = version;
            await this.step(id, access, "executing", "资格通过；固定源码 hash，仅用于本次已授权任务", (state, current) => {
              if (state.catalogRevision !== expectedRevision) throw new IdentityError(409, "catalog_revision_conflict");
              state.versions.push(candidate); state.catalogRevision++; current.qualification = qualification;
            });
            break;
          }
          feedback = qualification.checks.at(-1);
        }
      }
      if (!version) throw new Error("build_budget_exhausted");
      const selected = version;
      task = await this.step(id, access, "executing", task.builderCalls ? "执行本次生成的固定版本" : "命中同版本工具，零构建处理新输入", (state, current) => {
        const active = state.versions.find(item => item.version === selected.version && item.codeHash === selected.codeHash);
        if (!active || active.state === "disabled" || active.environment !== ENVIRONMENT || hash(active.source) !== active.codeHash) throw new Error("capability_invalidated");
        current.selected = { id: selected.id, version: selected.version, codeHash: selected.codeHash }; current.qualification = selected.qualification;
        if (current.intent === "prepare-evidence-review") current.composition = { ...EVIDENCE_RECIPE, dependency: current.selected };
      });
      const output = await executeTransform(selected.source, task.input, controller.signal);
      await this.step(id, access, "verifying", "独立复核每行来源、覆盖与同岗身份，计算要求原文差异");
      const rows = verifyTaskOutput(task.input, output);
      const evidenceReport = task.intent === "prepare-evidence-review" ? prepareEvidenceReview(rows, EvidenceReviewInput.parse(task.evidence)) : undefined;
      if (evidenceReport) verifyEvidenceReview(task.input, EvidenceReviewInput.parse(task.evidence), evidenceReport);
      const report = evidenceReport ? undefined : compareJobs(rows), outputHash = hash(evidenceReport ?? report);
      await this.step(id, access, "verifying", "本次结果通过；正在等待业务系统接受私人报告", (_state, current) => {
        current.output = report; current.outputHash = outputHash;
        if (evidenceReport) current.evidenceReport = evidenceReport;
        current.taskVerification = receipt("task", outputHash, true, evidenceReport
          ? ["all-current-requirements:passed", "explicit-source-links:passed", "pending-personal-claims-only:passed"]
          : ["all-rows-and-source-values:passed", "namespace-plus-id:passed", "requirements-text-only:passed"], evidenceReport ? EVIDENCE_VERIFIER : VERIFIER);
      });
      // No await between authorization/CAS checks and the logical acceptance in
      // the same owner queue; revocation cannot slip into a check-then-write gap.
      await this.step(id, access, "completed", "私人报告及业务回执已原子保存；能力可供后续同格式任务复用", (state, current) => {
        const active = state.versions.find(item => item.version === selected.version && item.codeHash === selected.codeHash);
        if (!active || active.state === "disabled" || active.environment !== ENVIRONMENT || hash(active.source) !== active.codeHash) throw new Error("capability_invalidated");
        current.receipt = { id: randomUUID(), reportId: current.id, revision: 1, inputHash: current.inputHash, codeHash: selected.codeHash, at: new Date().toISOString() };
        active.state = "reusable";
      });
    } catch (error) {
      await this.atomic(state => {
        const task = state.tasks.find(item => item.id === id)!;
        if (task.stage === "completed") return;
        if (task.stage === "cancelled") {
          task.events.push({ stage: "cancelled", detail: "迟到结果已拒绝；只在原账号留审计，未晋级或保存报告", at: new Date().toISOString() });
          const build = task.builds.at(-1);
          if (build?.status === "requested" && candidateHash) { build.codeHash = candidateHash; build.status = "rejected"; build.error = "late_candidate_discarded"; }
          return;
        }
        task.stage = artifact(task) ? "partial" : "failed";
        task.error = error instanceof IdentityError ? error.code : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "task_failed";
        task.events.push({ stage: task.stage, detail: task.error, at: new Date().toISOString() });
      }).catch(() => undefined); // a broken disk cannot manufacture a saved receipt
    } finally { this.controllers.delete(id); }
  }
  async revoke(id: string, access: TaskAccess) {
    await this.atomic(async state => {
      if (this.closing || state.closedSessions.includes(access.session) || !await access.valid()) throw new IdentityError(403, "interaction_lease_invalid");
      const task = state.tasks.find(item => item.id === id);
      if (!task) throw new IdentityError(404, "task_not_found");
      task.grant.revoked = true; task.grant.revision++;
      if (!terminal.has(task.stage)) { task.stage = "cancelled"; task.error = "grant_revoked"; }
    });
    this.controllers.get(id)?.abort();
  }
  async invalidateSession(session: string) {
    const ids = await this.atomic(state => {
      if (!state.closedSessions.includes(session)) state.closedSessions.push(session);
      const affected = state.tasks.filter(task => task.session === session && !terminal.has(task.stage));
      for (const task of affected) { task.grant.revoked = true; task.grant.revision++; task.stage = "cancelled"; task.error = "interaction_lease_invalid"; }
      return affected.map(task => task.id);
    });
    ids.forEach(id => this.controllers.get(id)?.abort());
  }
  async disable(version: number, expectedRevision: number, access: TaskAccess) {
    await this.atomic(async state => {
      if (this.closing || state.closedSessions.includes(access.session) || !await access.valid()) throw new IdentityError(403, "interaction_lease_invalid");
      if (state.catalogRevision !== expectedRevision) throw new IdentityError(409, "catalog_revision_conflict");
      const entry = state.versions.find(item => item.version === version);
      if (!entry) throw new IdentityError(404, "capability_not_found");
      entry.state = "disabled"; entry.disabledReason = "owner_disabled"; state.catalogRevision++;
      for (const task of state.tasks) if (task.selected?.version === version) task.reviewReason = "使用的能力版本已停用；历史原文及回执保留，后续使用需重新核对";
    });
  }
  private async workspaceAccess(state: State, access: TaskAccess) {
    if (this.closing || state.closedSessions.includes(access.session) || !await access.valid())
      throw new IdentityError(403, "interaction_lease_invalid");
  }
  private evidenceTask(state: State, id: string) {
    const task = state.tasks.find(item => item.id === id);
    if (!task) throw new IdentityError(404, "task_not_found");
    if (task.grant.revoked) throw new IdentityError(403, "source_grant_revoked");
    if (task.stage !== "completed" || !task.receipt || task.reviewReason || !task.evidenceReport || !task.evidence || !task.selected
      || task.taskVerification?.status !== "passed" || task.taskVerification.verifierVersion !== EVIDENCE_VERIFIER
      || task.taskVerification.targetHash !== hash(task.evidenceReport) || task.outputHash !== hash(task.evidenceReport)
      || task.inputHash !== inputHash(task) || task.receipt.inputHash !== task.inputHash || task.receipt.codeHash !== task.selected.codeHash
      || task.composition?.recipeHash !== EVIDENCE_RECIPE.recipeHash || !isSameDependency(task)) throw new IdentityError(409, "current_verified_evidence_report_required");
    verifyEvidenceReview(task.input, task.evidence, task.evidenceReport); return task;
  }
  /** Fresh, explicit interactive commands; never inherit an analysis grant or write a resume. */
  async reviewEvidence(raw: EvidenceReviewCommand, access: TaskAccess) {
    const command = EvidenceReviewCommand.parse(raw);
    await this.options.onCheckpoint?.({ taskId: command.taskId, stage: "verifying", detail: "workspace-review-before-acceptance" });
    return this.atomic(async state => {
      await this.workspaceAccess(state, access);
      const task = this.evidenceTask(state, command.taskId);
      return recordPersonalReview(state.workspace ??= emptyEvidenceWorkspace(), command, task);
    });
  }
  async proposeEvidence(raw: EvidenceProposalCommand, access: TaskAccess) {
    const command = EvidenceProposalCommand.parse(raw);
    await this.options.onCheckpoint?.({ taskId: command.reviewId, stage: "verifying", detail: "workspace-proposal-before-acceptance" });
    return this.atomic(async state => {
      await this.workspaceAccess(state, access);
      const workspace = state.workspace ??= emptyEvidenceWorkspace();
      const review = workspace.reviews.find(item => item.id === command.reviewId);
      if (!review) throw new IdentityError(404, "personal_review_not_found");
      const task = this.evidenceTask(state, review.source.taskId);
      if (task.receipt!.id !== review.source.reportReceiptId || task.outputHash !== review.source.reportHash)
        throw new IdentityError(409, "evidence_report_binding_changed");
      const proposal = proposePersonalEvidence(workspace, command);
      return { ...proposal, eligibility: evidenceProposalEligibility(workspace, proposal, task) };
    });
  }
  /** Synthetic Workspace documents only; no browser/default resume import or mutation. */
  async createSyntheticResume(raw: CreateSyntheticResumeCommand, access: TaskAccess) {
    const command = CreateSyntheticResumeCommand.parse(raw);
    return this.atomic(async state => { await this.workspaceAccess(state, access);
      return createSyntheticResume(state.workspace ??= emptyEvidenceWorkspace(), command); });
  }
  private prepareResume(state: State, request: ResumeChangeRequest, access: TaskAccess) {
    const workspace = state.workspace ?? emptyEvidenceWorkspace();
    let proposal;
    if (request.kind === "adopt") {
      proposal = workspace.proposals.find(item => item.id === request.proposalId);
      if (!proposal) throw new IdentityError(404, "evidence_proposal_not_found");
      const task = this.evidenceTask(state, proposal.source.taskId);
      if (evidenceProposalEligibility(workspace, proposal, task) !== "current") throw new IdentityError(409, "personal_review_superseded");
    }
    return prepareResumeChange(workspace, request, `${state.ownerId}:${access.session}`, proposal);
  }
  async previewResumeChange(raw: ResumeChangeRequest, access: TaskAccess) {
    const request = ResumeChangeRequest.parse(raw); await this.ready; await this.queue;
    await this.workspaceAccess(this.state, access);
    return structuredClone(this.prepareResume(this.state, request, access).preview);
  }
  async saveResumeChange(raw: SaveResumeChangeCommand, access: TaskAccess) {
    const command = SaveResumeChangeCommand.parse(raw);
    await this.options.onCheckpoint?.({ taskId: command.preview.assetId, stage: "verifying", detail: `workspace-resume-${command.preview.kind}-before-acceptance` });
    return this.atomic(async state => {
      await this.workspaceAccess(state, access);
      const workspace = state.workspace ??= emptyEvidenceWorkspace();
      const saved = priorResumeReceipt(workspace, command.idempotencyKey, hash({ kind: "save-resume-change", ...command }));
      if (saved) return saved;
      return savePreparedResumeChange(workspace, command, this.prepareResume(state, command.preview, access));
    });
  }
  async revokeResumePreview(raw: RevokeResumePreviewCommand, access: TaskAccess) {
    const command = RevokeResumePreviewCommand.parse(raw);
    return this.atomic(async state => { await this.workspaceAccess(state, access);
      return revokeResumePreview(state.workspace ??= emptyEvidenceWorkspace(), command); });
  }
  /** Explicit save-only recovery. Never regenerates or repeats execution/model calls. */
  async retrySave(id: string, access: TaskAccess) {
    return this.atomic(async state => {
      const task = state.tasks.find(item => item.id === id);
      if (!task) throw new IdentityError(404, "task_not_found");
      if (this.closing || state.closedSessions.includes(access.session) || !await access.valid()) throw new IdentityError(403, "interaction_lease_invalid");
      if (task.receipt) return task.receipt;
      const output = artifact(task);
      if (!output || !task.selected || task.taskVerification?.status !== "passed" || task.taskVerification.targetHash !== hash(output)
        || task.outputHash !== hash(output) || task.inputHash !== inputHash(task)) throw new IdentityError(409, "verified_artifact_required");
      if (task.intent === "prepare-evidence-review") {
        if (task.composition?.recipeHash !== EVIDENCE_RECIPE.recipeHash || task.taskVerification.verifierVersion !== EVIDENCE_VERIFIER
          || !task.evidenceReport || !task.evidence || !isSameDependency(task)) throw new IdentityError(409, "composition_invalidated");
        verifyEvidenceReview(task.input, task.evidence, task.evidenceReport);
      }
      const version = state.versions.find(item => item.version === task.selected!.version && item.codeHash === task.selected!.codeHash);
      if (!version || version.state === "disabled" || version.environment !== ENVIRONMENT || hash(version.source) !== version.codeHash) throw new IdentityError(409, "capability_invalidated");
      task.events.push({ stage: "completed", detail: `本人重新授权，仅恢复报告保存；原授权代次 ${task.grant.revision}，没有重新生成或执行`, at: new Date().toISOString() });
      task.session = access.session; task.grant = { revision: task.grant.revision + 1, revoked: false, expiresAt: Date.now() + 60_000 };
      task.receipt = { id: randomUUID(), reportId: task.id, revision: 1, inputHash: task.inputHash, codeHash: version.codeHash, at: new Date().toISOString() };
      task.stage = "completed"; delete task.error; version.state = "reusable"; return task.receipt;
    });
  }
  /** Requalification can restore an unchanged owner-disabled version, not a tampered or incompatible one. */
  async revalidate(versionNumber: number, expectedRevision: number, access: TaskAccess) {
    const before = await this.snapshot(), entry = before.versions.find(item => item.version === versionNumber);
    if (!entry || entry.codeHash !== hash(entry.source) || entry.environment !== ENVIRONMENT || entry.contract !== CONTRACT)
      throw new IdentityError(409, "immutable_version_incompatible");
    if (before.catalogRevision !== expectedRevision || this.state.closedSessions.includes(access.session) || !await access.valid())
      throw new IdentityError(409, "catalog_or_interaction_changed");
    const evidence = await qualify(entry.source);
    return this.atomic(async state => {
      if (this.closing || state.catalogRevision !== expectedRevision || state.closedSessions.includes(access.session) || !await access.valid())
        throw new IdentityError(409, "catalog_or_interaction_changed");
      const current = state.versions.find(item => item.version === versionNumber)!;
      if (current.codeHash !== entry.codeHash || hash(current.source) !== entry.codeHash || current.environment !== ENVIRONMENT) throw new IdentityError(409, "immutable_version_incompatible");
      current.revalidations = [...current.revalidations ?? [], evidence];
      if (evidence.status !== "passed") { current.state = "disabled"; current.disabledReason = "revalidation_failed"; }
      else {
        const witnessed = state.tasks.some(task => task.receipt && task.selected?.version === versionNumber && task.selected.codeHash === entry.codeHash
          && task.taskVerification?.status === "passed");
        current.state = witnessed ? "reusable" : "qualified"; delete current.disabledReason;
      }
      state.catalogRevision++; return current;
    });
  }
  async settled() { await this.jobs; await this.queue; }
  async close() {
    this.closing = true; this.controllers.forEach(controller => controller.abort());
    await this.jobs; await this.queue; await this.ready.catch(() => undefined);
    if (this.writerLease) { this.writerLease.close(); this.writerLease = undefined; }
  }
}
