import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DocumentSchema, type RecoveryDocument } from "@better-me/core/document";
import { UnderstandingSessionSchema } from "@better-me/agent-contracts";
import { privateDirectory, readPrivateJson, writePrivateJson } from "./private-json.js";
import { IdentityError } from "./service.js";

const Id = z.string().regex(/^[a-f0-9]{32}$/);
const Key = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const File = z.object({ file: z.string().regex(/^[a-f0-9]{64}\.json$/), hash: z.string().regex(/^[a-f0-9]{64}$/) });
const Manifest = z.object({ version: z.literal(1), id: Id, ownerId: z.string().uuid(), fingerprint: z.string(), label: z.string(), createdAt: z.string(),
  documents: z.array(File.extend({ key: Key, label: z.string(), source: z.string(), documentId: z.string() })),
  artifacts: z.array(File.extend({ label: z.string() })),
  continuity: z.array(File.extend({ workspaceKey: z.string() })), sessions: z.array(File.extend({ id: z.string() })),
}).strict();
type ManifestValue = z.infer<typeof Manifest>;
export type RecoveryPlan = {
  id: string; ownerId: string; label: string; createdAt: string;
  documents: { key: string; label: string; source: string; document: RecoveryDocument }[];
  artifacts: { label: string; bytes: Buffer }[];
  continuity: Record<string, unknown>[]; sessions: { session: unknown }[];
};
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Immutable append-only archives. Installation is local/admin-only; HTTP exposes owner-derived reads. */
export class RecoveryCatalog {
  private readonly root: string;
  constructor(ownerDirectory: string, private readonly ownerId: string) {
    z.string().uuid().parse(ownerId); this.root = path.join(ownerDirectory, "recovery");
  }
  private async manifest(id: string): Promise<ManifestValue> {
    if (!Id.safeParse(id).success) throw new IdentityError(404, "recovery_not_found");
    const directory = path.join(this.root, id);
    const stat = await fs.lstat(directory).catch(() => undefined);
    if (!stat) throw new IdentityError(404, "recovery_not_found");
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new IdentityError(409, "unsafe_recovery_directory");
    const value = await readPrivateJson(path.join(directory, "manifest.json"));
    if (!value) throw new IdentityError(404, "recovery_not_found");
    const parsed = Manifest.parse(value);
    if (parsed.ownerId !== this.ownerId || parsed.id !== id) throw new IdentityError(409, "recovery_owner_mismatch");
    return parsed;
  }
  async list() {
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    const values = await Promise.all(entries.filter(entry => Id.safeParse(entry.name).success).map(entry => this.manifest(entry.name)));
    return Promise.all(values.map(async ({ id, label, createdAt, documents, artifacts, continuity, sessions }) => ({ id, label, createdAt,
      documents: documents.map(({ key, label, source, documentId }) => ({ key, label, source, documentId })),
      artifactCount: artifacts.length, agentWorkspaces: continuity.length, sessionCount: sessions.length,
      sessions: await Promise.all(sessions.map(async entry => {
        const { session } = z.object({ session: UnderstandingSessionSchema }).parse(await this.read(id, entry));
        return { id: session.id, label: session.label, messageCount: session.messages.length, phase: session.phase };
      })),
    })));
  }
  private async read(id: string, entry: z.infer<typeof File>) {
    const value = await readPrivateJson(path.join(this.root, id, entry.file));
    if (value === undefined || sha(JSON.stringify(value)) !== entry.hash) throw new IdentityError(409, "recovery_integrity_failed");
    return value;
  }
  async document(id: string, key: string): Promise<RecoveryDocument> {
    const manifest = await this.manifest(id), entry = manifest.documents.find(item => item.key === key);
    if (!entry) throw new IdentityError(404, "recovery_not_found");
    return DocumentSchema.parse(await this.read(id, entry));
  }
  async artifact(id: string, index: number): Promise<Buffer> {
    const manifest = await this.manifest(id), entry = Number.isSafeInteger(index) ? manifest.artifacts[index] : undefined;
    if (!entry) throw new IdentityError(404, "recovery_not_found");
    return Buffer.from(z.object({ base64: z.string() }).parse(await this.read(id, entry)).base64, "base64");
  }
  async continuity(workspaceKey: string): Promise<unknown | undefined> {
    return this.find("continuity", workspaceKey);
  }
  async session(id: string): Promise<unknown | undefined> { return this.find("sessions", id); }
  async archivedSession(archiveId: string, sessionId: string) {
    const manifest = await this.manifest(archiveId), entry = manifest.sessions.find(item => item.id === sessionId);
    if (!entry) throw new IdentityError(404, "recovery_not_found");
    return z.object({ session: UnderstandingSessionSchema }).parse(await this.read(archiveId, entry)).session;
  }
  private async find(kind: "continuity" | "sessions", key: string) {
    const matches: { id: string; entry: z.infer<typeof File> }[] = [];
    for (const item of await this.list()) {
      const manifest = await this.manifest(item.id);
      for (const entry of manifest[kind]) if (("workspaceKey" in entry ? entry.workspaceKey : entry.id) === key) matches.push({ id: item.id, entry });
    }
    if (matches.length > 1) throw new IdentityError(409, "recovery_ambiguous_record");
    const match = matches[0]; return match ? this.read(match.id, match.entry) : undefined;
  }
  async install(plan: RecoveryPlan) {
    Id.parse(plan.id);
    if (plan.ownerId !== this.ownerId) throw new IdentityError(409, "recovery_owner_mismatch");
    if (plan.documents.length > 100 || plan.artifacts.length > 500 || plan.sessions.length > 100 || plan.continuity.length > 100) throw new IdentityError(413, "recovery_too_large");
    const fingerprint = sha(JSON.stringify({ ...plan, artifacts: plan.artifacts.map(item => ({ label: item.label, hash: sha(item.bytes) })) }));
    const existing = await this.manifest(plan.id).catch(error => { if (error instanceof IdentityError && error.status === 404) return undefined; throw error; });
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new IdentityError(409, "recovery_conflict");
      return { id: plan.id, alreadyInstalled: true };
    }
    const documents = plan.documents.map(item => ({ ...item, key: Key.parse(item.key), document: DocumentSchema.parse(item.document) }));
    if (new Set(documents.map(item => item.key)).size !== documents.length) throw new IdentityError(409, "recovery_duplicate_key");
    await privateDirectory(this.root);
    const stage = path.join(this.root, `.stage-${randomUUID()}`); await fs.mkdir(stage, { mode: 0o700 });
    let bytes = 0;
    const save = async (value: unknown) => {
      const raw = JSON.stringify(value); bytes += Buffer.byteLength(raw);
      if (Buffer.byteLength(raw) > 15 * 1024 * 1024 || bytes > 128 * 1024 * 1024) throw new IdentityError(413, "recovery_too_large");
      const hash = sha(raw), file = `${hash}.json`;
      if (!await readPrivateJson(path.join(stage, file))) await writePrivateJson(path.join(stage, file), value);
      return { hash, file };
    };
    try {
      const manifest: ManifestValue = { version: 1, id: plan.id, ownerId: this.ownerId, fingerprint, label: plan.label.slice(0, 200), createdAt: plan.createdAt,
        documents: [], artifacts: [], continuity: [], sessions: [] };
      for (const item of documents) manifest.documents.push({ ...await save(item.document), key: item.key, label: item.label, source: item.source, documentId: item.document.documentId ?? "" });
      for (const item of plan.artifacts) manifest.artifacts.push({ ...await save({ base64: item.bytes.toString("base64") }), label: item.label });
      for (const raw of plan.continuity) {
        const value = structuredClone(raw);
        const base = z.object({ workspaceKey: z.string().min(1), messages: z.array(z.record(z.unknown())), memories: z.array(z.record(z.unknown())), tasks: z.array(z.record(z.unknown())) }).passthrough().parse(value);
        Object.assign(value, { ownerId: this.ownerId, revision: 1, tracking: false, selection: { kind: "current", profileId: "", model: "" },
          messages: base.messages.map(message => ({ ...message, archived: true, resumeShared: false })),
          memories: base.memories.map(memory => ({ ...memory, valid: false, shared: false, reason: "旧资料恢复；复用前请重新核对并授权。" })),
          tasks: base.tasks.map(task => { const copy: Record<string, unknown> = { ...task, status: ["running", "waiting"].includes(String(task.status)) ? "interrupted" : task.status }; delete copy.remote; return copy; }),
        });
        manifest.continuity.push({ ...await save(value), workspaceKey: base.workspaceKey });
      }
      for (const raw of plan.sessions) {
        const session = UnderstandingSessionSchema.parse(raw.session);
        session.grants = session.grants.map(grant => ({ ...grant, revokedAt: grant.revokedAt ?? plan.createdAt }));
        if (session.phase === "running") session.phase = "cancelled";
        manifest.sessions.push({ ...await save({ session, receipts: {}, directories: [], agentContextFloor: session.messages.length }), id: session.id });
      }
      await writePrivateJson(path.join(stage, "manifest.json"), Manifest.parse(manifest));
      try { await fs.rename(stage, path.join(this.root, plan.id)); }
      catch (error) {
        const installed = await this.manifest(plan.id).catch(() => undefined);
        if (!installed || installed.fingerprint !== fingerprint) throw error;
      }
      return { id: plan.id, alreadyInstalled: false };
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
}
