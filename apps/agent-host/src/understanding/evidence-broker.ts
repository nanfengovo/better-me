import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { UnderstandingEvidence, UnderstandingGrant } from "@better-me/agent-contracts";

export class EvidenceAccessError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "EvidenceAccessError"; }
}

export type EvidenceRequest = { operation: "list" | "search" | "read"; path?: string; query?: string; startLine?: number; endLine?: number };
export type EvidenceResult = {
  evidence: UnderstandingEvidence[];
  entries?: { path: string; kind: "file" | "directory" }[];
  truncated: boolean;
  skipped?: number;
};

const excludedDirectories = new Set(["node_modules", "vendor", "dist", "build", "target", "bin", "obj", "coverage", "out", "output", "logs", "log", "backups", "cache"]);
const textExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cs", ".csproj", ".sln", ".fs", ".vb", ".py", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".vue", ".svelte", ".html", ".css", ".scss", ".md", ".mdx", ".txt", ".json", ".xml", ".yaml", ".yml", ".toml"]);
// Conservative screening, not a complete DLP guarantee. User consent still controls disclosure.
const secretContent = /-----BEGIN (?:[A-Z ]*PRIVATE KEY)|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\b(?:password|passwd|pwd|api[_-]?key|access[_-]?token|client[_-]?secret|connection[_-]?strings?)["']?\s*[=:]\s*(?:["'][^"'\n]+["']|[^\s;,}"']+)|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/:]+:[^\s/@]+@/i;

function deniedPart(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith(".") || excludedDirectories.has(lower) || /^(?:appsettings|web\.config|connectionstrings)(?:\.|$)/i.test(lower)
    || /(?:^|[._-])(?:credentials?|secrets?|tokens?|passwords?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(lower)
    || /\.(?:pem|key|pfx|p12|db|sqlite3?|bak|log|lock)$/i.test(lower);
}
function relativeInput(input = ""): string {
  if (input === "." || input === "") return "";
  if (input.includes("\0") || path.isAbsolute(input) || /^[A-Za-z]:/.test(input) || input.startsWith("\\")) {
    throw new EvidenceAccessError("path_denied", "Only a path relative to the explicit grant is allowed.");
  }
  const parts = input.replaceAll("\\", "/").split("/");
  if (parts.some(part => !part || part === ".." || deniedPart(part))) throw new EvidenceAccessError("path_denied", "Hidden, sensitive, generated and parent paths are excluded.");
  return parts.join(path.sep);
}
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** No shell, native runtime, network or arbitrary absolute-path tool is exposed. */
export class EvidenceBroker {
  private readonly maxFileBytes: number;
  private readonly maxEntries: number;
  constructor(options: { maxFileBytes?: number; maxEntries?: number } = {}) {
    this.maxFileBytes = Math.max(1, Math.min(options.maxFileBytes ?? 256 * 1024, 1024 * 1024));
    this.maxEntries = Math.max(1, Math.min(options.maxEntries ?? 100, 200));
  }

  async grant(explicitPath: string): Promise<UnderstandingGrant> {
    if (typeof explicitPath !== "string" || !explicitPath.trim() || !path.isAbsolute(explicitPath) || explicitPath.includes("\0")) {
      throw new EvidenceAccessError("grant_path_required", "请选择明确的项目目录或源码文件绝对路径。");
    }
    const requested = path.resolve(explicitPath.trim());
    // System aliases are canonicalized; arbitrary ancestor aliases cannot silently widen a grant.
    let ancestor = path.parse(requested).root;
    for (const part of requested.slice(ancestor.length).split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, part);
      const ancestorStat = await fs.lstat(ancestor).catch(() => undefined);
      if (ancestorStat?.isSymbolicLink()) {
        const systemAlias = (ancestor === "/tmp" && await fs.realpath(ancestor) === "/private/tmp") || (ancestor === "/var" && await fs.realpath(ancestor) === "/private/var");
        if (!systemAlias) throw new EvidenceAccessError("grant_path_denied", "授权路径不能经过符号链接；请选择实际源码路径。");
      }
    }
    const stat = await fs.lstat(requested).catch(() => undefined);
    if ((!stat?.isDirectory() && !stat?.isFile()) || stat.isSymbolicLink()) throw new EvidenceAccessError("grant_path_denied", "A real project directory or exact source file is required; symlink grants are not allowed.");
    const canonical = await fs.realpath(requested);
    const home = os.homedir();
    const broad = [path.parse(canonical).root, home, path.dirname(home), os.tmpdir(), "/", "/Users", "/home", "/tmp", "/var", "/private", "/private/var", "/private/tmp", "/etc", "/private/etc", "/System", "/Library", "/Applications", "/usr", "/opt", "/Volumes",
      ...["Documents", "Desktop", "Downloads", "Library", "AppData", "OneDrive"].map(name => path.join(home, name))];
    const resolvedBroad = await Promise.all(broad.map(value => fs.realpath(value).catch(() => path.resolve(value))));
    if (resolvedBroad.includes(canonical) || canonical.split(path.sep).filter(Boolean).some(deniedPart)) {
      throw new EvidenceAccessError("grant_too_broad", "Grant a specific source project, not a home, system, hidden or data directory.");
    }
    if (stat.isFile() && (!this.isSource(canonical) || stat.nlink > 1 || stat.size > this.maxFileBytes)) throw new EvidenceAccessError("grant_path_denied", "An exact-file grant must be an allowlisted, bounded source file without hard links.");
    // Persist exact-file scope in the opaque grant ID without broadening the shared grant contract.
    return { id: `${stat.isFile() ? "file_grant" : "grant"}_${randomUUID()}`, path: canonical, label: path.basename(canonical), createdAt: new Date().toISOString() };
  }

  async execute(grant: UnderstandingGrant, request: EvidenceRequest, signal?: AbortSignal): Promise<EvidenceResult> {
    signal?.throwIfAborted();
    if (grant.revokedAt) throw new EvidenceAccessError("grant_revoked", "This source grant was revoked.");
    let relative = relativeInput(request.path);
    const rootStat = await fs.lstat(grant.path).catch(() => undefined);
    const exactFile = grant.id.startsWith("file_grant_");
    if (exactFile !== (rootStat?.isFile() === true)) throw new EvidenceAccessError("grant_changed", "授权对象类型发生变化，请重新授权。");
    if (exactFile) {
      if (relative && relative !== path.basename(grant.path)) throw new EvidenceAccessError("path_denied", "This grant permits only its exact file, never the parent directory.");
      relative = path.basename(grant.path);
      if (request.operation === "list") return { evidence: [], entries: [{ path: relative, kind: "file" }], truncated: false };
      if (request.operation === "search") {
        if (!request.query?.trim() || request.query.length > 200) throw new EvidenceAccessError("query_invalid", "Provide a literal search query of 1–200 characters.");
        const source = await this.textFile(grant, relative, signal);
        const matches = source.lines.flatMap((line, index) => line.toLowerCase().includes(request.query!.toLowerCase()) && line.length <= 2000 ? [this.record(grant, relative, source.hash, index + 1, index + 1, line)] : []);
        return { evidence: matches.slice(0, 20), truncated: matches.length > 20 };
      }
    }
    const resolved = await this.resolve(grant, relative);
    if (request.operation === "read") {
      const source = await this.textFile(grant, relative, signal);
      const start = request.startLine ?? 1;
      const end = request.endLine ?? start + 119;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new EvidenceAccessError("range_invalid", "Use a positive ordered line range.");
      const boundedEnd = Math.min(end, start + 199, source.lines.length);
      if (start > source.lines.length) throw new EvidenceAccessError("range_invalid", "The requested line is beyond this file.");
      const excerpt = source.lines.slice(start - 1, boundedEnd).join("\n");
      if (excerpt.length > 16000) throw new EvidenceAccessError("excerpt_too_large", "Request a smaller line range.");
      return { evidence: [this.record(grant, relative, source.hash, start, boundedEnd, excerpt)], truncated: boundedEnd < end };
    }
    if (!(await fs.lstat(resolved)).isDirectory()) throw new EvidenceAccessError("directory_required", "List and search require a directory.");
    if (request.operation === "list") {
      const entries: NonNullable<EvidenceResult["entries"]> = [];
      let scanned = 0;
      const directory = await fs.opendir(resolved);
      for await (const entry of directory) {
        signal?.throwIfAborted();
        if (++scanned > 2000 || entries.length >= this.maxEntries) return { entries, evidence: [], truncated: true };
        if (deniedPart(entry.name) || entry.isSymbolicLink() || (!entry.isDirectory() && !this.isSource(entry.name))) continue;
        entries.push({ path: path.join(relative, entry.name).split(path.sep).join("/"), kind: entry.isDirectory() ? "directory" : "file" });
      }
      entries.sort((a, b) => a.path.localeCompare(b.path));
      return { entries, evidence: [], truncated: false };
    }
    if (request.operation !== "search" || !request.query?.trim() || request.query.length > 200) throw new EvidenceAccessError("query_invalid", "Provide a literal search query of 1–200 characters.");
    const query = request.query.toLowerCase();
    const evidence: UnderstandingEvidence[] = [];
    const queue = [relative];
    let scanned = 0, files = 0, skipped = 0;
    while (queue.length && scanned < 2000 && files < 100 && evidence.length < 20) {
      const current = queue.shift()!;
      const directory = await fs.opendir(await this.resolve(grant, current));
      for await (const entry of directory) {
        signal?.throwIfAborted();
        if (++scanned >= 2000 || files >= 100 || evidence.length >= 20) break;
        if (deniedPart(entry.name) || entry.isSymbolicLink()) continue;
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) { if (child.split(path.sep).length <= 12) queue.push(child); continue; }
        if (!entry.isFile() || !this.isSource(entry.name)) continue;
        files++;
        try {
          const source = await this.textFile(grant, child, signal);
          for (let index = 0; index < source.lines.length && evidence.length < 20; index++) {
            const line = source.lines[index]!;
            if (line.toLowerCase().includes(query) && line.length <= 2000) evidence.push(this.record(grant, child, source.hash, index + 1, index + 1, line));
          }
        } catch (error) { signal?.throwIfAborted(); if (!(error instanceof EvidenceAccessError)) throw error; skipped++; }
      }
    }
    return { evidence, skipped, truncated: queue.length > 0 || scanned >= 2000 || files >= 100 || evidence.length >= 20 };
  }

  private isSource(file: string): boolean { return textExtensions.has(path.extname(file).toLowerCase()); }
  private async resolve(grant: UnderstandingGrant, relative: string): Promise<string> {
    const rootStat = await fs.lstat(grant.path).catch(() => undefined);
    if ((!rootStat?.isDirectory() && !rootStat?.isFile()) || rootStat.isSymbolicLink() || await fs.realpath(grant.path) !== grant.path) throw new EvidenceAccessError("grant_changed", "The granted source path has changed.");
    if (rootStat.isFile() !== grant.id.startsWith("file_grant_")) throw new EvidenceAccessError("grant_changed", "授权对象类型发生变化，请重新授权。");
    if (rootStat.isFile()) {
      if (relative !== path.basename(grant.path)) throw new EvidenceAccessError("path_denied", "Only the exact granted file is available.");
      return grant.path;
    }
    let cursor = grant.path;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const stat = await fs.lstat(cursor).catch(() => undefined);
      if (!stat || stat.isSymbolicLink()) throw new EvidenceAccessError("path_denied", "Missing paths and symlinks cannot be read.");
    }
    const canonical = await fs.realpath(cursor);
    if (!inside(grant.path, canonical)) throw new EvidenceAccessError("path_escape", "The path escapes its grant.");
    return canonical;
  }
  private async textFile(grant: UnderstandingGrant, relative: string, signal?: AbortSignal): Promise<{ lines: string[]; hash: string }> {
    if (!relative || !this.isSource(relative)) throw new EvidenceAccessError("file_type_denied", "Only allowlisted source and text files may be read.");
    const filename = await this.resolve(grant, relative);
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1 || stat.size > this.maxFileBytes) throw new EvidenceAccessError("file_too_large", "Binary, special, hard-linked and oversized files are excluded.");
      const current = await fs.stat(await this.resolve(grant, relative));
      if (current.ino !== stat.ino || current.dev !== stat.dev) throw new EvidenceAccessError("file_changed", "The source changed while opening it.");
      signal?.throwIfAborted();
      const bytes = Buffer.alloc(this.maxFileBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        signal?.throwIfAborted();
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > this.maxFileBytes) throw new EvidenceAccessError("file_too_large", "The file exceeds the source read budget.");
      const data = bytes.subarray(0, length);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw new EvidenceAccessError("binary_denied", "Only UTF-8 text is supported."); }
      if (data.some(byte => byte <= 8 || (byte >= 14 && byte <= 31))) throw new EvidenceAccessError("binary_denied", "二进制内容不能作为源码材料读取。");
      if (secretContent.test(text)) throw new EvidenceAccessError("sensitive_content", "Potential credential content is excluded.");
      return { lines: text.split(/\r?\n/), hash: createHash("sha256").update(data).digest("hex") };
    } finally { await handle.close(); }
  }
  private record(grant: UnderstandingGrant, relative: string, hash: string, startLine: number, endLine: number, excerpt: string): UnderstandingEvidence {
    const sourcePath = relative.split(path.sep).join("/");
    return { id: `ev_${createHash("sha256").update(`${grant.id}:${sourcePath}:${hash}:${startLine}:${endLine}`).digest("hex").slice(0, 24)}`, grantId: grant.id, path: sourcePath, hash, startLine, endLine, excerpt, collectedAt: new Date().toISOString() };
  }
}
