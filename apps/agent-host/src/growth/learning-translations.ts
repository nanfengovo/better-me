import type { DatabaseSync } from "node:sqlite";
import {
  TRANSLATION_LIMITS as limits,
  PDF_CLOUD_BACKEND, PDF_CLOUD_ORIGIN,
  TranslationBackendSchema,
  TranslationCreateSchema,
  TranslationJobSchema,
  TranslationReviewSchema,
  type TranslationBackend,
  type TranslationCreate,
  type TranslationJob,
  type TranslationArtifact,
} from "@better-me/agent-contracts";
import type { CareerTaskAccess } from "../kernel/service.js";
import { LearningStore, learningFail } from "./learning-store.js";
import {
  documentRecord,
  materialBytes,
  learningFingerprint,
  learningHash,
} from "./learning-materials.js";
import { extractLearningPdf } from "./learning-pdf.js";

/** A trusted document-converter adapter, NOT another Agent/runtime or an HTTP
 * supplied executable. Every model request (including upstream retries) must
 * cross modelCall before dispatch. No runtime is selected by reading history. */
export interface LearningTranslationEngine {
  /** Native adapters settle run() only after their owned process tree closes. */
  abortSettles?: true;
  backend(location?: "local"|"cloud"): Promise<TranslationBackend>;
  run(input: {
    request: TranslationCreate;
    source: Uint8Array;
    signal: AbortSignal;
    cloudKey?: string; // Authenticated owner's in-memory, one-job credential. Never journalled or passed to Python.
    progress(
      stage: "parsing" | "translating" | "typesetting",
      percent: number | null,
    ): Promise<void>;
    modelCall(
      prompt: string,
      complete: (signal: AbortSignal) => Promise<string>,
    ): Promise<string>;
  }): Promise<{ mono: Uint8Array; dual?: Uint8Array }>;
}
export const unavailableTranslationBackend: TranslationBackend = {
  id: "pdf2zh-local-v1",
  engine: "PDF2zh-next 2.10.2 / BabelDOC 0.7.1",
  location: "local",
  ready: false,
  simulation: false,
  models: [],
  reason:
    "尚未配置并验证本机 PDF 翻译引擎。不会自动安装依赖、下载权重或改用云端模型。",
};
const activeStates = new Set(["queued", "running"]);
const date = () => new Date().toISOString();
type Active = {
  materialId: string;
  controller: AbortController;
  access: CareerTaskAccess;
  finished: Promise<void>;
};
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new Error("translation_cancelled"));
    if (signal.aborted) {
      void pending.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {});
  });
}

export class LearningTranslations {
  private active = new Map<string, Active>();
  private closed = false;
  constructor(
    private store: LearningStore,
    private engine?: LearningTranslationEngine,
  ) {}
  async backend(access: CareerTaskAccess, location:"local"|"cloud"="local") {
    await this.store.assert(access);
    const backend = TranslationBackendSchema.parse(
      this.engine ? await this.engine.backend(location) : location==="local" ? unavailableTranslationBackend :
        {...unavailableTranslationBackend,id:PDF_CLOUD_BACKEND,location,recipientOrigin:PDF_CLOUD_ORIGIN,reason:"translation_backend_unavailable"},
    );
    await this.store.assert(access);
    return backend;
  }
  private load(database: DatabaseSync, id: string) {
    const row = database
      .prepare("SELECT body FROM translations WHERE id=?")
      .get(id);
    if (!row) learningFail("translation_not_found", 404);
    const job = TranslationJobSchema.parse(JSON.parse(String(row.body)));
    if (job.id !== id || job.ownerId !== this.store.ownerId)
      learningFail("learning_owner_mismatch", 403);
    return job;
  }
  private save(database: DatabaseSync, job: TranslationJob) {
    job.updatedAt = date();
    database
      .prepare(
        "INSERT INTO translations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(job.id, JSON.stringify(TranslationJobSchema.parse(job)));
  }
  private view(database: DatabaseSync, id: string) {
    const job = this.load(database, id),
      material = documentRecord(database, job.request.materialId);
    if (material.revoked) {
      if (job.state !== "source_revoked") {
        this.active.get(id)?.controller.abort();
        job.state = "source_revoked";
        job.stage = "stopped";
        job.issue = "learning_material_revoked";
        this.save(database, job);
      }
      // Historical counters survive; derived text/bytes and glossary are no longer served.
      return {
        ...job,
        review: undefined,
        artifacts: [],
        request: { ...job.request, glossary: [] },
      };
    }
    if (activeStates.has(job.state) && !this.active.has(id)) {
      job.state = "interrupted";
      job.stage = "stopped";
      job.issue = "translation_host_interrupted";
      this.save(database, job);
    }
    return job;
  }
  list(access: CareerTaskAccess) {
    return this.store.run(access, (database) =>
      database
        .prepare("SELECT id FROM translations ORDER BY rowid DESC")
        .all()
        .map((row) => this.view(database, String(row.id))),
    );
  }
  get(id: string, access: CareerTaskAccess) {
    return this.store.run(access, (database) => this.view(database, id));
  }
  byRequest(requestId: string, access: CareerTaskAccess) {
    return this.get(this.id(requestId), access);
  }
  private id(requestId: string) {
    return `lt_${learningHash(`${this.store.ownerId}:${requestId}`).slice(0, 32)}`;
  }
  async create(raw: unknown, access: CareerTaskAccess, cloudKey?:string) {
    const request = TranslationCreateSchema.parse(raw),
      id = this.id(request.requestId);
    // Idempotent receipt lookup precedes readiness. An engine going offline must
    // not make a saved result disappear or start it again.
    const previous = await this.store.run(access, (database) => {
      if (!database.prepare("SELECT id FROM translations WHERE id=?").get(id))
        return undefined;
      const job = this.load(database, id);
      if (learningFingerprint(job.request) !== learningFingerprint(request))
        learningFail("translation_idempotency_conflict");
      return this.view(database, id);
    });
    if (previous) return previous;
    const location=request.cloudGrant?"cloud":"local";
    if (location==="cloud" ? !cloudKey || !/^[!-~]{4,512}$/.test(cloudKey) : cloudKey!==undefined)
      learningFail("translation_cloud_credential_required",422);
    const backend = await this.backend(access,location);
    if (!backend.ready || !this.engine)
      learningFail("translation_backend_unavailable", 503);
    if (!backend.simulation && !this.engine.abortSettles)
      learningFail("translation_cleanup_unverified", 503);
    if (
      backend.location !== location || backend.id !== request.backendId ||
      !backend.models.some(
        (model) =>
          model.name === request.model.name &&
          model.digest === request.model.digest,
      )
    )
      learningFail("translation_model_unavailable", 422);
    if (
      new Set(request.glossary.map((entry) => entry.source)).size !==
      request.glossary.length
    )
      learningFail("translation_glossary_duplicate", 422);
    if (this.closed) learningFail("learning_closed", 503);
    const entry: Active = {
      materialId: request.materialId,
      controller: new AbortController(),
      access,
      finished: Promise.resolve(),
    };
    let claimed = false;
    try {
      const result = await this.store.run(access, (database) => {
        if (
          database.prepare("SELECT id FROM translations WHERE id=?").get(id)
        ) {
          const job = this.load(database, id);
          if (learningFingerprint(job.request) !== learningFingerprint(request))
            learningFail("translation_idempotency_conflict");
          return this.view(database, id);
        }
        if (this.active.size) learningFail("translation_already_running");
        if (
          Number(
            database.prepare("SELECT count(*) AS n FROM translations").get()!.n,
          ) >= limits.jobs
        )
          learningFail("translation_job_capacity", 413);
        const { material } = materialBytes(database, request.materialId);
        if (
          material.hash !== request.materialHash ||
          material.revision !== request.materialRevision
        )
          learningFail("learning_material_version_conflict");
        if (
          material.mediaType !== "application/pdf" ||
          material.pages.length > limits.pages ||
          material.pages.some((page) => page.status !== "text")
        )
          learningFail("translation_text_pdf_required", 422);
        const job = TranslationJobSchema.parse({
          id,
          ownerId: this.store.ownerId,
          request,
          backend,
          materialName: material.name,
          sourcePages: material.pages.length,
          createdAt: date(),
          updatedAt: date(),
          state: "queued",
          stage: "prepared",
          progress: null,
          usage: { modelCalls: 0, inputBytes: 0, outputBytes: 0 },
          artifacts: [],
        });
        this.save(database, job);
        this.active.set(id, entry);
        claimed = true;
        return job;
      });
      if (claimed)
        entry.finished = this.run(id, entry, cloudKey)
          .catch(() => {})
          .finally(() => this.active.delete(id));
      return result;
    } catch (error) {
      if (claimed) this.active.delete(id); // Saved queued record becomes interrupted, never an auto-retry.
      throw error;
    }
  }
  private async guard(database: DatabaseSync, id: string, entry: Active) {
    entry.controller.signal.throwIfAborted();
    await this.store.assert(entry.access);
    const job = this.load(database, id);
    if (!activeStates.has(job.state)) learningFail("translation_stopped");
    const { material } = materialBytes(database, job.request.materialId);
    if (
      material.hash !== job.request.materialHash ||
      material.revision !== job.request.materialRevision
    )
      learningFail("learning_material_version_conflict");
    return job;
  }
  private async run(id: string, entry: Active, cloudKey?:string) {
    const deadline = setTimeout(
      () => entry.controller.abort(new Error("translation_time_limit")),
      limits.activeMs,
    );
    const signal = entry.controller.signal;
    try {
      const { request, source } = await this.store.run(
        entry.access,
        async (database) => {
          const job = await this.guard(database, id, entry);
          job.state = "running";
          job.stage = "parsing";
          this.save(database, job);
          return {
            request: job.request,
            source: materialBytes(database, job.request.materialId).bytes,
          };
        },
      );
      const pendingOutput = this.engine!.run({
        request,
        source,
        signal,
        ...(cloudKey ? {cloudKey} : {}),
        progress: async (stage, percent) => {
          await this.store.run(entry.access, async (database) => {
            const job = await this.guard(database, id, entry);
            job.stage = stage;
            if (percent !== null && Number.isFinite(percent))
              job.progress = Math.max(
                job.progress ?? 0,
                Math.min(99, Math.max(0, Math.floor(percent))),
              );
            this.save(database, job);
          });
        },
        modelCall: async (prompt, complete) => {
          if (!prompt.trim() || Buffer.byteLength(prompt) > limits.inputBytes)
            learningFail("translation_input_limit", 413);
          await this.store.run(entry.access, async (database) => {
            const job = await this.guard(database, id, entry);
            if (job.usage.modelCalls >= (job.request.cloudGrant?.maxCalls ?? limits.calls))
              learningFail("translation_model_budget_exhausted");
            job.usage.modelCalls++;
            job.usage.inputBytes += Buffer.byteLength(prompt);
            this.save(database, job); // FULL sync, reserve before every external request/retry.
          });
          const text = await abortable(complete(signal), signal);
          if (
            typeof text !== "string" ||
            Buffer.byteLength(text) > limits.outputBytes
          )
            learningFail("translation_output_limit", 413);
          await this.store.run(entry.access, async (database) => {
            const job = await this.guard(database, id, entry);
            job.usage.outputBytes += Buffer.byteLength(text);
            this.save(database, job);
          });
          return text;
        },
      });
      const output = await (this.engine!.abortSettles
        ? pendingOutput
        : abortable(pendingOutput, signal));
      const artifacts: {
        descriptor: TranslationArtifact;
        bytes: Uint8Array;
      }[] = [];
      if (
        !output.mono ||
        (request.bilingual && !output.dual) ||
        (!request.bilingual && output.dual)
      )
        learningFail("translation_missing_output");
      for (const kind of ["mono", "dual"] as const) {
        const bytes = output[kind];
        if (!bytes) continue;
        signal.throwIfAborted();
        if (
          !(bytes instanceof Uint8Array) ||
          !bytes.length ||
          bytes.length > limits.artifactBytes ||
          Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-"
        )
          learningFail("translation_invalid_output", 422);
        const pages = await extractLearningPdf(bytes);
        if (pages.length > limits.pages * 2)
          learningFail("translation_invalid_output", 422);
        artifacts.push({
          bytes,
          descriptor: {
            kind,
            hash: learningHash(bytes),
            bytes: bytes.length,
            pages: pages.length,
            emptyTextPages: pages
              .filter((page) => !page.blocks.some((block) => block.text.trim()))
              .map((page) => page.number),
          },
        });
      }
      await this.store.run(entry.access, async (database) => {
        const job = await this.guard(database, id, entry);
        if (
          !job.backend.simulation &&
          artifacts[0]?.descriptor.hash === job.request.materialHash
        )
          learningFail("translation_unchanged_output");
        const total = Number(
          database
            .prepare(
              "SELECT coalesce(sum(length(bytes)),0) AS n FROM translation_artifacts",
            )
            .get()!.n,
        );
        if (
          total + artifacts.reduce((sum, item) => sum + item.bytes.length, 0) >
          limits.libraryBytes
        )
          learningFail("translation_artifact_capacity", 413);
        job.state = "review_required";
        job.stage = "finished";
        job.progress = 100;
        job.artifacts = artifacts.map((item) => item.descriptor);
        database.exec("BEGIN IMMEDIATE");
        try {
          for (const artifact of artifacts)
            database
              .prepare("INSERT INTO translation_artifacts VALUES(?,?,?)")
              .run(id, artifact.descriptor.kind, artifact.bytes);
          this.save(database, job);
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });
    } catch (error) {
      await this.store
        .run(entry.access, (database) => {
          const job = this.load(database, id);
          if (!activeStates.has(job.state)) return;
          job.state = signal.aborted ? "cancelled" : "failed";
          job.stage = "stopped";
          const code = error instanceof Error ? error.message : "";
          job.issue = /^translation_[a-z_]+$/.test(code)
            ? code
            : "translation_engine_failed";
          this.save(database, job);
        })
        .catch(() => {});
    } finally {
      clearTimeout(deadline);
    }
  }
  async cancel(id: string, access: CareerTaskAccess) {
    // Only the authenticated owner can reach this map; don't abort before checking ownership.
    return this.store.run(access, (database) => {
      const job = this.view(database, id);
      if (activeStates.has(job.state)) {
        job.state = "cancelled";
        job.stage = "stopped";
        job.issue = "translation_cancelled";
        this.save(database, job);
        this.active.get(id)?.controller.abort();
      }
      return job;
    });
  }
  review(id: string, raw: unknown, access: CareerTaskAccess) {
    const input = TranslationReviewSchema.parse(raw);
    return this.store.run(access, (database) => {
      const job = this.view(database, id);
      if (job.review) {
        const { reviewedAt: _at, ...previous } = job.review;
        if (learningFingerprint(input) !== learningFingerprint(previous))
          learningFail("translation_review_frozen");
        return job;
      }
      if (job.state !== "review_required")
        learningFail("translation_not_reviewable");
      if(job.backend.location==="cloud" && (!input.terminology ||
          (job.request.glossary.length>0 && input.terminology==="not_applicable")))
        learningFail("translation_terminology_review_required",422);
      if (
        input.decision === "accept" &&
        (job.backend.simulation ||
          input.terminology === "fail" ||
          input.checks.pages !== "pass" ||
          input.checks.overflow !== "pass" ||
          Object.values(input.checks).includes("fail") ||
          job.artifacts.some(
            (artifact) =>
              artifact.emptyTextPages.length ||
              artifact.pages !==
                job.sourcePages * (artifact.kind === "dual" ? 2 : 1),
          ))
      )
        learningFail("translation_quality_not_accepted", 422);
      // Verify each exact byte artifact again; a metadata receipt is not a PDF.
      for (const artifact of job.artifacts)
        this.artifact(database, job, artifact.kind);
      job.review = { ...input, reviewedAt: date() };
      job.state = input.decision === "accept" ? "accepted" : "rejected";
      this.save(database, job);
      return job;
    });
  }
  private artifact(
    database: DatabaseSync,
    job: TranslationJob,
    kind: "mono" | "dual",
  ) {
    const artifact = job.artifacts.find((item) => item.kind === kind);
    if (!artifact) learningFail("translation_artifact_not_found", 404);
    const value = database
      .prepare(
        "SELECT bytes FROM translation_artifacts WHERE job_id=? AND kind=?",
      )
      .get(job.id, kind)?.bytes;
    if (
      !(value instanceof Uint8Array) ||
      value.length !== artifact.bytes ||
      learningHash(value) !== artifact.hash
    )
      learningFail("translation_artifact_integrity_failed", 503);
    return { artifact, bytes: value };
  }
  bytes(id: string, kind: "mono" | "dual", access: CareerTaskAccess) {
    return this.store.run(access, (database) => {
      const job = this.view(database, id);
      if (job.state === "source_revoked")
        learningFail("learning_material_revoked", 403);
      materialBytes(database, job.request.materialId);
      return this.artifact(database, job, kind);
    });
  }
  stopMaterial(id: string) {
    // Called only after the owning material revoke transaction commits.
    for (const entry of this.active.values())
      if (entry.materialId === id) entry.controller.abort();
  }
  invalidate(session: string) {
    for (const entry of this.active.values())
      if (entry.access.session === session) entry.controller.abort();
  }
  async close() {
    this.closed = true;
    for (const [id, entry] of this.active) {
      await this.store
        .run(entry.access, (database) => {
          const job = this.load(database, id);
          if (!activeStates.has(job.state)) return;
          job.state = "interrupted";
          job.stage = "stopped";
          job.issue = "translation_host_interrupted";
          this.save(database, job);
        })
        .catch(() => {});
      entry.controller.abort();
    }
    await Promise.all([...this.active.values()].map((entry) => entry.finished));
  }
}
