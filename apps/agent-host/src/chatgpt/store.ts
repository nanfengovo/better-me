import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { failure } from "./errors.js";

const Tokens = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1).optional(),
  idToken: z.string().min(1), expiresAt: z.number().finite(), scopes: z.array(z.string()) });
const Profile = z.object({ id: z.string(), clientId: z.string(), subject: z.string().optional(), email: z.string().optional(),
  tokens: Tokens.optional(), needsReauth: z.boolean().optional() });
const State = z.object({ version: z.literal(1), hostId: z.string().startsWith("urn:uuid:"), profiles: z.array(Profile).max(100) }).strict();
export type StoredChatGpt = z.infer<typeof State>;
export type ChatGptProfile = z.infer<typeof Profile>;
export type ChatGptTokens = z.infer<typeof Tokens>;

/** One Agent Host owns this directory. Never use a Codex/CLI credential file. */
export class ChatGptStore {
  private state?: StoredChatGpt;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  async read(): Promise<StoredChatGpt> { return this.transaction(state => structuredClone(state), false); }
  async transaction<T>(action: (state: StoredChatGpt) => T | Promise<T>, save = true): Promise<T> {
    const run = this.queue.then(async () => {
      this.state ??= await this.load();
      const next = structuredClone(this.state);
      const result = await action(next);
      if (save) { await this.save(next); this.state = next; }
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async load(): Promise<StoredChatGpt> {
    try {
      const directory = await fs.lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("unsafe_directory");
      const filename = path.join(this.directory, "accounts.json");
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2_000_000 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("unsafe_store");
      return State.parse(JSON.parse(await fs.readFile(filename, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, hostId: `urn:uuid:${randomUUID()}`, profiles: [] };
      throw failure("unavailable", "credential_store_unavailable", "ChatGPT 独立授权存储无法安全读取，原文件未被覆盖。请检查本机目录权限。");
    }
  }
  private async save(state: StoredChatGpt): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("unavailable", "unsafe_credential_directory", "ChatGPT 授权目录不安全，未保存凭据。");
    await fs.chmod(this.directory, 0o700);
    const filename = path.join(this.directory, "accounts.json");
    const prior = await fs.lstat(filename).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    if (prior && (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1)) throw failure("unavailable", "unsafe_credential_file", "ChatGPT 授权文件不安全，未覆盖原文件。");
    const temporary = path.join(this.directory, `.accounts-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(State.parse(state)), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, filename);
    } catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
  }
}
