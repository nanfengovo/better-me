import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readPrivateJson, writePrivateJson } from "./private-json.js";
import { IdentityError } from "./service.js";

const Envelope = z.object({ ownerId: z.string().uuid(), namespace: z.enum(["continuity", "growth"]), key: z.string().max(512),
  revision: z.number().int().positive(), value: z.unknown() }).strict();
export type OwnedNamespace = z.infer<typeof Envelope>["namespace"];
/** Per-owner durable records with CAS. Caller gets a store only after authenticating. */
export class OwnedStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private ownerId: string, private recovered?: (namespace: OwnedNamespace, key: string) => Promise<unknown | undefined>) {}
  private filename(namespace: OwnedNamespace, key: string) {
    if (!key || key.length > 512) throw new IdentityError(400, "invalid_record_key");
    return path.join(this.directory, namespace, `${createHash("sha256").update(key).digest("hex")}.json`);
  }
  async read(namespace: OwnedNamespace, key: string) {
    const raw = await readPrivateJson(this.filename(namespace, key));
    if (raw === undefined) {
      const value = await this.recovered?.(namespace, key);
      return value === undefined ? undefined : Envelope.parse({ ownerId: this.ownerId, namespace, key, revision: 1, value });
    }
    const saved = Envelope.parse(raw);
    if (saved.ownerId !== this.ownerId || saved.namespace !== namespace || saved.key !== key) throw new IdentityError(409, "record_owner_mismatch");
    return saved;
  }
  async write(namespace: OwnedNamespace, key: string, expectedRevision: number, value: unknown): Promise<void> {
    const run = this.queue.then(async () => {
      const prior = await this.read(namespace, key);
      if ((prior?.revision ?? 0) !== expectedRevision) throw new IdentityError(409, "record_revision_conflict");
      const shape = z.object({ workspaceKey: z.literal(key), revision: z.literal(expectedRevision + 1), ownerId: z.literal(this.ownerId).optional() }).passthrough().parse(value);
      if (Buffer.byteLength(JSON.stringify(shape)) > 8 * 1024 * 1024) throw new IdentityError(413, "record_too_large");
      await writePrivateJson(this.filename(namespace, key), Envelope.parse({ ownerId: this.ownerId, namespace, key, revision: expectedRevision + 1, value: shape }));
    });
    this.queue = run.catch(() => undefined); return run;
  }
}
