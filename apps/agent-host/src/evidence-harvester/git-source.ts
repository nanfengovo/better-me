import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class GitEvidenceError extends Error {
  constructor(readonly code: string) { super(code); this.name = "GitEvidenceError"; }
}

export type GitEvidenceLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  timeoutMs: number;
};
const defaults: GitEvidenceLimits = { maxFiles: 32, maxFileBytes: 128_000, maxTotalBytes: 512_000, timeoutMs: 8_000 };
export type RepositoryPreview = {
  root: string;
  repositoryId: string;
  head: string;
  objectFormat: "sha1" | "sha256";
  metadataIdentity: string;
};
export type GitEvidenceFile = {
  path: string;
  status: "added" | "modified" | "deleted";
  before?: { hash: string; text: string };
  after?: { hash: string; text: string };
  diff: string;
};
export type CapturedCommit = {
  repositoryId: string;
  commit: string;
  parent?: string;
  committedAt: string;
  files: GitEvidenceFile[];
  exclusions: Array<{ path: string; reason: "sensitive_path" | "unsupported_type" | "non_regular_file" | "file_budget" | "binary" | "sensitive_content" | "total_budget" }>;
  truncated: boolean;
  limitations: string[];
};
export type CommitBatch = { commits: string[]; head: string; hasMore: boolean };

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const containsPathControl = (value: string) => [...value].some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
const allowedExtensions = /\.(?:[cm]?[jt]sx?|cs|fs|vb|py|go|rs|java|kt|swift|c|h|cpp|hpp|vue|svelte|html|css|scss|sql|md|txt)$/i;
const deniedSegments = /^(?:\..*|node_modules|vendor|dist|build|coverage|secrets?|credentials?|private[-_]?data)$/i;
const deniedNames = /(?:^|[._-])(?:secrets?|credentials?|tokens?|passwords?|id_rsa|id_ed25519|keychain)(?:[._-]|$)|\.(?:pem|key|p12|pfx|sqlite|db|env)$/i;

/** Conservative exclusion, not a general-purpose PII detector or a claim of DLP. */
export function containsGitEvidenceSecret(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
    || /\b(?:sk-(?:proj-|ant-)?[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/.test(text)
    || /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd|private[_-]?key)\s*[:=]\s*["'`][^"'`\r\n]{8,}["'`]/i.test(text)
    || /\b(?:authorization\s*[:=]\s*["']?bearer|Bearer)\s+[a-zA-Z0-9._~+/-]{12,}/i.test(text);
}

/** Only fixed, read-only Git commands are used. No inherited Git configuration,
 * shell, hooks, diff drivers, textconv, network or credential helper is invoked. */
export class GitEvidenceSource {
  private readonly limits: GitEvidenceLimits;
  constructor(limits: Partial<GitEvidenceLimits> = {}) {
    this.limits = { ...defaults, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > defaults[key as keyof GitEvidenceLimits]) throw new GitEvidenceError("invalid_git_budget");
    }
  }

  async preview(explicitRoot: string, signal?: AbortSignal): Promise<RepositoryPreview> {
    if (!path.isAbsolute(explicitRoot) || containsPathControl(explicitRoot)) throw new GitEvidenceError("explicit_repository_required");
    const root = await fs.realpath(explicitRoot).catch(() => { throw new GitEvidenceError("repository_not_found"); });
    if (path.normalize(explicitRoot) !== root) throw new GitEvidenceError("repository_alias_denied");
    if (root === path.parse(root).root || root === os.homedir() || root.split(path.sep).some(part => part.startsWith("."))) throw new GitEvidenceError("repository_scope_too_broad");
    const metadataIdentity = await this.metadataIdentity(root);
    const signalNow = signal ?? new AbortController().signal;
    const actualRoot = (await this.git(root, ["rev-parse", "--show-toplevel"], signalNow)).toString("utf8").trim();
    // Git for Windows reports forward slashes. Resolve both spellings to the
    // same canonical directory; do not loosen this to prefixes/case folding.
    if (!path.isAbsolute(actualRoot) || containsPathControl(actualRoot) ||
      await fs.realpath(actualRoot).catch(() => undefined) !== root) throw new GitEvidenceError("repository_root_mismatch");
    const head = (await this.git(root, ["rev-parse", "--verify", "HEAD"], signalNow)).toString("utf8").trim();
    if (!oidPattern.test(head)) throw new GitEvidenceError("repository_has_no_commit");
    const format = (await this.git(root, ["rev-parse", "--show-object-format"], signalNow)).toString("utf8").trim();
    if (format !== "sha1" && format !== "sha256") throw new GitEvidenceError("unsupported_object_format");
    return { root, head, objectFormat: format, metadataIdentity, repositoryId: hash(`${root}\0${metadataIdentity}`) };
  }

  async capture(preview: RepositoryPreview, commit: string, signal?: AbortSignal): Promise<CapturedCommit> {
    if (!oidPattern.test(commit) || commit.length !== (preview.objectFormat === "sha1" ? 40 : 64)) throw new GitEvidenceError("exact_commit_required");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new GitEvidenceError("git_capture_timeout")), this.limits.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      await this.assertPreview(preview);
      combined.throwIfAborted();
      const info = (await this.git(preview.root, ["show", "--no-patch", "--format=%H%x00%P%x00%ct", "--no-show-signature", commit], combined)).toString("utf8").trim().split("\0");
      if (info[0] !== commit || !/^\d+$/.test(info[2] ?? "")) throw new GitEvidenceError("invalid_commit");
      const parents = info[1]?.split(" ").filter(Boolean) ?? [];
      if (parents.some(parent => !oidPattern.test(parent))) throw new GitEvidenceError("invalid_commit");
      // A subscription to a preview cannot become permission to scan unrelated history.
      await this.git(preview.root, ["merge-base", "--is-ancestor", preview.head, commit], combined).catch(error => {
        if (combined.aborted) throw combined.reason;
        if (error instanceof GitEvidenceError) throw new GitEvidenceError("commit_outside_subscription");
        throw error;
      });
      const parent = parents[0];
      const records = await this.git(preview.root, ["diff-tree", "--no-commit-id", "--raw", "--no-renames", "--no-ext-diff", "--no-textconv", "--abbrev=64", "-r", "-z", ...(parent ? [parent, commit] : ["--root", commit])], combined);
      const tokens = records.toString("utf8").split("\0");
      const result: CapturedCommit = {
        repositoryId: preview.repositoryId, commit, ...(parent ? { parent } : {}),
        committedAt: new Date(Number(info[2]) * 1000).toISOString(), files: [], exclusions: [], truncated: false,
        limitations: ["源码变更仅是项目线索，不证明本人贡献、上线状态或业务效果。", "敏感内容采用保守排除规则；未命中不构成隐私安全认证。", ...(parents.length > 1 ? ["合并提交仅分析第一父提交差异。"] : [])],
      };
      let total = 0;
      for (let index = 0; index < tokens.length - 1; index += 2) {
        combined.throwIfAborted();
        const metadata = tokens[index] ?? "";
        const filename = tokens[index + 1] ?? "";
        const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([AMD])$/.exec(metadata);
        if (!match || !filename || filename.startsWith("/") || filename.split("/").includes("..") || containsPathControl(filename)) throw new GitEvidenceError("invalid_git_change_record");
        const exclude = (reason: CapturedCommit["exclusions"][number]["reason"]) => { result.exclusions.push({ path: filename, reason }); };
        if (filename.split("/").some(part => deniedSegments.test(part)) || deniedNames.test(filename)) { exclude("sensitive_path"); continue; }
        if (!allowedExtensions.test(filename)) { exclude("unsupported_type"); continue; }
        if ([match[1], match[2]].some(mode => mode !== "000000" && mode !== "100644" && mode !== "100755")) { exclude("non_regular_file"); continue; }
        if (result.files.length >= this.limits.maxFiles) { exclude("file_budget"); result.truncated = true; continue; }
        const load = async (objectId: string): Promise<{ hash: string; text: string } | undefined> => {
          if (/^0+$/.test(objectId)) return undefined;
          if (!oidPattern.test(objectId)) throw new GitEvidenceError("invalid_blob_id");
          const size = Number((await this.git(preview.root, ["cat-file", "-s", objectId], combined)).toString("ascii").trim());
          if (!Number.isSafeInteger(size) || size < 0 || size > this.limits.maxFileBytes) throw new GitEvidenceError("file_budget");
          const bytes = await this.git(preview.root, ["cat-file", "blob", objectId], combined, this.limits.maxFileBytes);
          if (bytes.includes(0)) throw new GitEvidenceError("binary");
          let text: string;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new GitEvidenceError("binary"); }
          if (containsGitEvidenceSecret(text)) throw new GitEvidenceError("sensitive_content");
          return { hash: hash(bytes), text };
        };
        let before: Awaited<ReturnType<typeof load>>;
        let after: Awaited<ReturnType<typeof load>>;
        try { before = await load(match[3]!); after = await load(match[4]!); }
        catch (error) {
          if (error instanceof GitEvidenceError && ["file_budget", "binary", "sensitive_content"].includes(error.code)) {
            exclude(error.code as "file_budget" | "binary" | "sensitive_content"); result.truncated ||= error.code === "file_budget"; continue;
          }
          throw error;
        }
        const bytes = Buffer.byteLength(before?.text ?? "") + Buffer.byteLength(after?.text ?? "");
        if (total + bytes > this.limits.maxTotalBytes) { exclude("total_budget"); result.truncated = true; continue; }
        const diff = (await this.git(preview.root, ["show", "--format=", "--no-show-signature", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=3", ...(parent ? ["--first-parent"] : []), commit, "--", filename], combined, this.limits.maxTotalBytes)).toString("utf8");
        if (containsGitEvidenceSecret(diff)) { exclude("sensitive_content"); continue; }
        if (total + bytes + Buffer.byteLength(diff) > this.limits.maxTotalBytes) { exclude("total_budget"); result.truncated = true; continue; }
        total += bytes + Buffer.byteLength(diff);
        result.files.push({ path: filename, status: match[5] === "A" ? "added" : match[5] === "D" ? "deleted" : "modified", before, after, diff });
      }
      await this.assertPreview(preview);
      combined.throwIfAborted();
      return result;
    } finally { clearTimeout(timer); }
  }

  /** Ordered first-parent discovery, bounded by the same command/time budgets.
   * hasMore never advances a cursor past commits that have not been processed. */
  async commitsSince(preview: RepositoryPreview, cursor: string, limit = 16, signal?: AbortSignal): Promise<CommitBatch> {
    if (!oidPattern.test(cursor) || cursor.length !== preview.head.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new GitEvidenceError("invalid_commit_cursor");
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.limits.timeoutMs)]) : AbortSignal.timeout(this.limits.timeoutMs);
    await this.assertPreview(preview);
    const current = await this.preview(preview.root, combined);
    if (current.repositoryId !== preview.repositoryId) throw new GitEvidenceError("repository_changed");
    try {
      await this.git(preview.root, ["merge-base", "--is-ancestor", preview.head, cursor], combined);
      await this.git(preview.root, ["merge-base", "--is-ancestor", cursor, current.head], combined);
    } catch (error) {
      if (combined.aborted) throw combined.reason;
      if (error instanceof GitEvidenceError) throw new GitEvidenceError("history_rewritten_or_cursor_out_of_scope");
      throw error;
    }
    const commits = (await this.git(preview.root, ["rev-list", "--reverse", "--first-parent", `${cursor}..${current.head}`], combined)).toString("ascii").trim().split("\n").filter(Boolean);
    if (commits.some(commit => !oidPattern.test(commit))) throw new GitEvidenceError("invalid_commit_list");
    await this.assertPreview(preview);
    combined.throwIfAborted();
    return { commits: commits.slice(0, limit), head: current.head, hasMore: commits.length > limit };
  }

  private async metadataIdentity(root: string): Promise<string> {
    const marker = path.join(root, ".git");
    const stat = await fs.lstat(marker).catch(() => { throw new GitEvidenceError("explicit_repository_root_required"); });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GitEvidenceError("linked_worktree_requires_metadata_authorization");
    if (await fs.lstat(path.join(marker, "commondir")).catch(() => undefined)) throw new GitEvidenceError("external_git_metadata_denied");
    for (const relative of ["config", "HEAD", "packed-refs", "shallow", "info/grafts"]) {
      const entry = await fs.lstat(path.join(marker, relative)).catch(() => undefined);
      if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 256_000)) throw new GitEvidenceError("external_git_metadata_denied");
    }
    const config = await fs.readFile(path.join(marker, "config"), "utf8");
    if (/^\s*\[\s*include(?:if)?(?:\s|\])/im.test(config) || /\b(?:partialclone|promisor)\s*=/im.test(config)) throw new GitEvidenceError("external_git_configuration_denied");
    for (const relative of ["objects", "objects/info", "objects/pack", "refs"]) {
      const target = path.join(marker, relative);
      const entry = await fs.lstat(target).catch(() => undefined);
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink() || await fs.realpath(target) !== target)) throw new GitEvidenceError("external_git_metadata_denied");
    }
    if (await fs.lstat(path.join(marker, "objects/info/alternates")).catch(() => undefined)
      || await fs.lstat(path.join(marker, "objects/info/http-alternates")).catch(() => undefined)) throw new GitEvidenceError("alternate_object_store_denied");
    // Git opens loose objects and pack/index files itself. Reject symlink entries
    // before that read so a repository cannot redirect them outside its scope.
    let inspected = 0;
    const inspect = async (directory: string, depth: number): Promise<void> => {
      const handle = await fs.opendir(directory);
      for await (const entry of handle) {
        if (++inspected > 20_000 || entry.isSymbolicLink() || depth > 8) throw new GitEvidenceError("external_git_metadata_denied");
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await inspect(filename, depth + 1);
        else { const item = await fs.lstat(filename); if (!item.isFile() || item.nlink !== 1) throw new GitEvidenceError("external_git_metadata_denied"); }
      }
    };
    await inspect(path.join(marker, "objects"), 0);
    await inspect(path.join(marker, "refs"), 0);
    return hash(`${stat.dev}:${stat.ino}`);
  }

  private async assertPreview(preview: RepositoryPreview) {
    if (!oidPattern.test(preview.head) || !["sha1", "sha256"].includes(preview.objectFormat)
      || preview.head.length !== (preview.objectFormat === "sha1" ? 40 : 64)
      || !/^[a-f0-9]{64}$/.test(preview.repositoryId) || !/^[a-f0-9]{64}$/.test(preview.metadataIdentity)
      || !path.isAbsolute(preview.root) || await fs.realpath(preview.root).catch(() => "") !== preview.root
      || await this.metadataIdentity(preview.root) !== preview.metadataIdentity
      || preview.repositoryId !== hash(`${preview.root}\0${preview.metadataIdentity}`)) throw new GitEvidenceError("repository_changed");
  }

  private git(root: string, args: string[], signal: AbortSignal, maxBuffer = this.limits.maxTotalBytes): Promise<Buffer> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      execFile("git", ["--no-pager", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "diff.external=", ...args], {
        cwd: root, signal, timeout: this.limits.timeoutMs, maxBuffer, encoding: "buffer", windowsHide: true,
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", GIT_ATTR_NOSYSTEM: "1" },
      }, (error, stdout) => {
        if (error) reject(signal.aborted ? signal.reason : new GitEvidenceError("git_read_failed"));
        else resolve(stdout);
      });
    });
  }
}
