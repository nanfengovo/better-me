import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readPrivateJson, writePrivateJson } from "./private-json.js";

export const PrincipalSchema = z.object({ id: z.string().uuid(), username: z.string(), displayName: z.string() }).strict();
export type Principal = z.infer<typeof PrincipalSchema>;
const User = PrincipalSchema.extend({ salt: z.string(), passwordHash: z.string() }).strict();
const Session = z.object({ digest: z.string(), ownerId: z.string().uuid(), expiresAt: z.number(), lastUsedAt: z.number() }).strict();
const Binding = z.object({ issuer: z.string().url(), subject: z.string().min(1).max(512), ownerId: z.string().uuid(), createdAt: z.number() }).strict();
const ExternalProof = z.object({ issuer: z.string().url(), subject: z.string().min(1).max(512), displayName: z.string().trim().min(1).max(60) }).strict();
export type ExternalIdentity = z.infer<typeof ExternalProof>;
const State = z.object({ version: z.literal(1), users: z.array(User).max(10000), sessions: z.array(Session).max(10000), bindings: z.array(Binding).max(10000).default([]) }).strict();
const Credentials = z.object({ username: z.string().trim().min(3).max(48).regex(/^[A-Za-z0-9_.-]+$/).transform(value => value.toLowerCase()),
  password: z.string().min(12).max(128).refine(value => Buffer.byteLength(value) <= 256), displayName: z.string().trim().min(1).max(60).optional() }).strict();
export class IdentityError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const publicUser = (user: Principal): Principal => ({ id: user.id, username: user.username, displayName: user.displayName });
const SESSION_TTL = 8 * 60 * 60_000;
const IDLE_TTL = 60 * 60_000;
const LAST_USED_FLUSH_MS = 10_000;
const COOKIE = "betterme_session";

type StoreMeta = { ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };

/** Installation-local identity, not an LLM account. No client-supplied owner is accepted. */
export class IdentityService {
  private queue: Promise<unknown> = Promise.resolve();
  private attempts = new Map<string, { count: number; until: number }>();
  private hashing = 0;
  private cache?: StoreMeta & { state: z.infer<typeof State> };
  private lastFlushed = new Map<string, number>();
  constructor(readonly directory: string, private clock: () => number = Date.now) {}
  private filePath() { return path.join(this.directory, "identities.json"); }
  private async statMeta(filePath: string): Promise<StoreMeta | null> {
    try {
      const st = await fs.lstat(filePath, { bigint: true });
      const safe = st.isFile() && !st.isSymbolicLink() && st.nlink === 1n && st.size <= 16n * 1024n * 1024n
        && (process.platform === "win32" || (st.mode & 0o777n) === 0o600n);
      return safe ? { ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs } : null;
    } catch { return null; }
  }
  private async loadState(): Promise<z.infer<typeof State>> {
    const file = this.filePath();
    const meta = await this.statMeta(file);
    if (this.cache && meta && this.cache.ino === meta.ino && this.cache.size === meta.size
      && this.cache.mtimeNs === meta.mtimeNs && this.cache.ctimeNs === meta.ctimeNs) {
      return structuredClone(this.cache.state);
    }
    this.cache = undefined;
    const raw = await readPrivateJson(file);
    const state = raw === undefined ? State.parse({ version: 1, users: [], sessions: [] }) : State.parse(raw);
    if (meta) {
      this.cache = { ...meta, state: structuredClone(state) };
      for (const s of state.sessions) {
        if (!this.lastFlushed.has(s.digest)) this.lastFlushed.set(s.digest, s.lastUsedAt);
      }
    }
    return state;
  }
  private async commitState(state: z.infer<typeof State>): Promise<void> {
    const file = this.filePath();
    const parsed = State.parse(state);
    this.cache = undefined;
    await writePrivateJson(file, parsed);
    const meta = await this.statMeta(file);
    if (meta) this.cache = { ...meta, state: structuredClone(parsed) };
    const activeDigests = new Set<string>();
    for (const s of parsed.sessions) {
      activeDigests.add(s.digest);
      this.lastFlushed.set(s.digest, s.lastUsedAt);
    }
    for (const key of this.lastFlushed.keys()) {
      if (!activeDigests.has(key)) this.lastFlushed.delete(key);
    }
  }
  private transaction<T>(action: (state: z.infer<typeof State>) => Promise<T> | T, options?: { write?: boolean }): Promise<T> {
    const run = this.queue.then(async () => {
      const state = await this.loadState();
      const result = await action(state);
      if (options?.write !== false) await this.commitState(state);
      return result;
    });
    this.queue = run.catch(() => undefined); return run;
  }
  private async hash(password: string, salt: string): Promise<Buffer> {
    if (this.hashing >= 2) throw new IdentityError(429, "identity_busy");
    this.hashing++;
    try {
      return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64,
        { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
    } finally { this.hashing--; }
  }
  async signIn(input: unknown, register: boolean, client: string) {
    const credentials = Credentials.parse(input);
    const now = this.clock();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    const limit = this.attempts.get(client) ?? { count: 0, until: now + 60_000 };
    if (++limit.count > 10 || this.attempts.size >= 1000 && !this.attempts.has(client)) throw new IdentityError(429, "identity_rate_limited");
    this.attempts.set(client, limit);
    // Password work is outside the store lock; a second uniqueness check inside closes registration races.
    const raw = await readPrivateJson(path.join(this.directory, "identities.json"));
    const existing = raw === undefined ? undefined : State.parse(raw).users.find(user => user.username === credentials.username);
    const salt = register ? randomBytes(24).toString("hex") : existing?.salt ?? "betterme-unknown-account-dummy-salt";
    const key = await this.hash(credentials.password, salt);
    if (register && existing || !register && (!existing || !timingSafeEqual(key, Buffer.from(existing.passwordHash, "hex")))) {
      throw new IdentityError(401, "identity_credentials_rejected");
    }
    return this.transaction(state => {
      if (register && state.users.some(user => user.username === credentials.username)) throw new IdentityError(401, "identity_credentials_rejected");
      const user = register ? { id: randomUUID(), username: credentials.username, displayName: credentials.displayName ?? credentials.username,
        salt, passwordHash: key.toString("hex") } : state.users.find(user => user.id === existing?.id);
      if (!user) throw new IdentityError(401, "identity_credentials_rejected");
      if (register) state.users.push(user);
      state.sessions = state.sessions.filter(session => session.expiresAt > now && session.lastUsedAt + IDLE_TTL > now);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now + SESSION_TTL;
      state.sessions.push({ digest: digest(token), ownerId: user.id, expiresAt, lastUsedAt: now });
      return { principal: publicUser(user), token, expiresAt };
    });
  }
  token(cookie: string | undefined): string | undefined {
    const values = cookie?.split(";").map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`)) ?? [];
    if (values.length !== 1) return undefined;
    const value = values[0]!.slice(COOKIE.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  }
  async authenticate(cookie: string | undefined): Promise<Principal | undefined> {
    const token = this.token(cookie); if (!token) return undefined;
    const tokenDigest = digest(token);
    const run = this.queue.then(async () => {
      const state = await this.loadState();
      const now = this.clock(), session = state.sessions.find(item => item.digest === tokenDigest);
      if (!session || session.expiresAt <= now || session.lastUsedAt + IDLE_TTL <= now) return undefined;
      const user = state.users.find(item => item.id === session.ownerId);
      if (!user) return undefined;
      session.lastUsedAt = now;
      if (this.cache) {
        const cachedSession = this.cache.state.sessions.find(item => item.digest === tokenDigest);
        if (cachedSession) cachedSession.lastUsedAt = now;
      }
      const flushedAt = this.lastFlushed.get(tokenDigest) ?? -Infinity;
      if (now - flushedAt >= LAST_USED_FLUSH_MS) {
        await this.commitState(state);
      }
      return publicUser(user);
    });
    this.queue = run.catch(() => undefined); return run;
  }
  async signOut(cookie: string | undefined): Promise<void> {
    const token = this.token(cookie); if (!token) return;
    await this.transaction(state => { state.sessions = state.sessions.filter(item => item.digest !== digest(token)); });
  }
  /** Only booleans are public. Subjects, issuer bindings, hashes and credentials stay in the Host. */
  async loginMethods(cookie: string | undefined, expectedOwner: string, issuer?: string) {
    const token = this.token(cookie);
    return this.transaction(state => {
      const now = this.clock(), session = token && state.sessions.find(item => item.digest === digest(token));
      if (!session || session.ownerId !== expectedOwner || session.expiresAt <= now || session.lastUsedAt + IDLE_TTL <= now) throw new IdentityError(401, "identity_required");
      const user = state.users.find(item => item.id === expectedOwner);
      if (!user) throw new IdentityError(401, "identity_required");
      // External-only users have an unguessable dummy password and this reserved generated username.
      return { localPassword: user.username !== `oidc-${user.id}`,
        unifiedLinked: Boolean(issuer && state.bindings.some(binding => binding.ownerId === user.id && binding.issuer === issuer)) };
    }, { write: false });
  }
  /** Management re-authentication must prove an already bound subject; it cannot create or link one. */
  async verifyExternalOwner(cookie: string | undefined, expectedOwner: string, input: ExternalIdentity, active: () => boolean): Promise<Principal> {
    const proof = ExternalProof.parse(input), token = this.token(cookie);
    return this.transaction(state => {
      if (!active()) throw new IdentityError(409, "oidc_flow_cancelled");
      const now = this.clock(), session = token && state.sessions.find(item => item.digest === digest(token));
      if (!session || session.ownerId !== expectedOwner || session.expiresAt <= now || session.lastUsedAt + IDLE_TTL <= now) throw new IdentityError(401, "identity_required");
      if (!state.bindings.some(binding => binding.ownerId === expectedOwner && binding.issuer === proof.issuer && binding.subject === proof.subject)) throw new IdentityError(409, "external_identity_not_linked");
      const user = state.users.find(item => item.id === expectedOwner);
      if (!user) throw new IdentityError(401, "identity_required");
      return publicUser(user);
    }, { write: false });
  }
  /** Only called with an OIDC proof verified by the server, never a browser-supplied profile. */
  async signInExternal(input: ExternalIdentity, active: () => boolean) {
    const proof = ExternalProof.parse(input);
    return this.transaction(state => {
      if (!active()) throw new IdentityError(409, "oidc_flow_cancelled");
      const binding = state.bindings.find(item => item.issuer === proof.issuer && item.subject === proof.subject);
      let user = binding && state.users.find(item => item.id === binding.ownerId);
      if (binding && !user) throw new IdentityError(409, "external_identity_owner_missing");
      if (!user) {
        const id = randomUUID();
        user = { id, username: `oidc-${id}`, displayName: proof.displayName,
          salt: randomBytes(24).toString("hex"), passwordHash: randomBytes(64).toString("hex") };
        state.users.push(user);
        state.bindings.push({ issuer: proof.issuer, subject: proof.subject, ownerId: id, createdAt: this.clock() });
      }
      const now = this.clock(), token = randomBytes(32).toString("base64url"), expiresAt = now + SESSION_TTL;
      state.sessions = state.sessions.filter(session => session.expiresAt > now && session.lastUsedAt + IDLE_TTL > now);
      state.sessions.push({ digest: digest(token), ownerId: user.id, expiresAt, lastUsedAt: now });
      return { principal: publicUser(user), token, expiresAt };
    });
  }
  /** Binding needs both the original live session and a fresh local password check at flow start. */
  async verifyLocal(cookie: string | undefined, password: string): Promise<Principal> {
    if (typeof password !== "string" || password.length < 12 || password.length > 128) throw new IdentityError(401, "identity_credentials_rejected");
    const principal = await this.authenticate(cookie);
    if (!principal) throw new IdentityError(401, "identity_required");
    const state = State.parse(await readPrivateJson(path.join(this.directory, "identities.json")));
    const user = state.users.find(item => item.id === principal.id);
    if (!user || !timingSafeEqual(await this.hash(password, user.salt), Buffer.from(user.passwordHash, "hex"))) throw new IdentityError(401, "identity_credentials_rejected");
    return principal;
  }
  async linkExternal(cookie: string | undefined, expectedOwner: string, input: ExternalIdentity, active: () => boolean): Promise<Principal> {
    const proof = ExternalProof.parse(input), token = this.token(cookie);
    return this.transaction(state => {
      if (!active()) throw new IdentityError(409, "oidc_flow_cancelled");
      const now = this.clock(), session = token && state.sessions.find(item => item.digest === digest(token));
      if (!session || session.ownerId !== expectedOwner || session.expiresAt <= now || session.lastUsedAt + IDLE_TTL <= now) throw new IdentityError(401, "identity_required");
      const user = state.users.find(item => item.id === expectedOwner);
      if (!user) throw new IdentityError(401, "identity_required");
      const existing = state.bindings.find(item => item.issuer === proof.issuer && item.subject === proof.subject);
      if (existing && existing.ownerId !== expectedOwner) throw new IdentityError(409, "external_identity_already_linked");
      if (!existing) state.bindings.push({ issuer: proof.issuer, subject: proof.subject, ownerId: expectedOwner, createdAt: now });
      return publicUser(user);
    });
  }
  cookie(token: string, secure: boolean): string {
    return `${COOKIE}=${token}; Path=/api/v1/agent; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}${secure ? "; Secure" : ""}`;
  }
  clearCookie(): string { return `${COOKIE}=; Path=/api/v1/agent; HttpOnly; SameSite=Strict; Max-Age=0`; }
}
