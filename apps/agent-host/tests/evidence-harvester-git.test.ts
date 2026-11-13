import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { GitEvidenceError, GitEvidenceSource } from "../src/evidence-harvester/git-source.js";

const exec = promisify(execFile);
async function repository(t: TestContext) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-harvest-git-"));
  const root = await fs.realpath(temporary);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } })).stdout.trim();
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Synthetic Contributor");
  await git("config", "user.email", "synthetic-contributor@example.invalid");
  const write = async (filename: string, value: string | Buffer) => {
    await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await fs.writeFile(path.join(root, filename), value);
  };
  const commit = async () => { await git("add", "--all"); await git("commit", "-m", "synthetic fixture"); return git("rev-parse", "HEAD"); };
  return { root, git, write, commit };
}
const code = (expected: string) => (error: unknown) => error instanceof GitEvidenceError && error.code === expected;

test("capture reads a real root commit without exporting author, email, or claiming personal ownership", async t => {
  const repo = await repository(t);
  await repo.write("src/state.ts", "export const state = 'pending';\n");
  const head = await repo.commit();
  const source = new GitEvidenceSource();
  const preview = await source.preview(repo.root);
  const result = await source.capture(preview, head);
  assert.equal(result.commit, head);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.status, "added");
  assert.equal(result.files[0]?.before, undefined);
  assert.equal(result.files[0]?.after?.text, "export const state = 'pending';\n");
  assert.match(result.files[0]!.diff, /\+export const state/);
  assert.equal(result.files[0]?.after?.hash.length, 64);
  assert.equal(result.parent, undefined);
  assert.equal(result.truncated, false);
  assert.ok(result.limitations.some(item => item.includes("不证明本人贡献")));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-contributor|Synthetic Contributor|fixture/);
});

test("capture tracks modified and deleted source with both versions and excludes secrets even when removed", async t => {
  const repo = await repository(t);
  await repo.write("state.ts", "export const state = 1;\n");
  await repo.write("deleted.ts", "export const removed = true;\n");
  await repo.write("sensitive.ts", 'const api_key = "synthetic-secret-12345678";\n');
  await repo.commit();
  const source = new GitEvidenceSource();
  const preview = await source.preview(repo.root);
  await repo.write("state.ts", "export const state = 2;\n");
  await repo.write("sensitive.ts", "export const sanitized = true;\n");
  await fs.unlink(path.join(repo.root, "deleted.ts"));
  await repo.write(".env", "SYNTHETIC_PRIVATE=value");
  const next = await repo.commit();
  const result = await source.capture(preview, next);
  assert.equal(result.parent, preview.head);
  assert.deepEqual(result.files.map(file => [file.path, file.status]), [["deleted.ts", "deleted"], ["state.ts", "modified"]]);
  assert.equal(result.files[0]?.after, undefined);
  assert.equal(result.files[1]?.before?.text, "export const state = 1;\n");
  assert.equal(result.files[1]?.after?.text, "export const state = 2;\n");
  assert.ok(result.exclusions.some(file => file.path === "sensitive.ts" && file.reason === "sensitive_content"));
  assert.ok(result.exclusions.some(file => file.path === ".env" && file.reason === "sensitive_path"));
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|SYNTHETIC_PRIVATE/);
});

test("capture never follows a source symlink, binary data, hidden directory or unsupported file", async t => {
  const repo = await repository(t);
  await repo.write("safe.ts", "export {};\n");
  await repo.write("binary.ts", Buffer.from([0, 1, 2, 3]));
  await repo.write("image.png", "not a source file");
  await repo.write(".private/internal.ts", "private material");
  await fs.symlink("safe.ts", path.join(repo.root, "link.ts"));
  const head = await repo.commit();
  const source = new GitEvidenceSource();
  const result = await source.capture(await source.preview(repo.root), head);
  assert.deepEqual(result.files.map(file => file.path), ["safe.ts"]);
  assert.equal(result.exclusions.find(file => file.path === "link.ts")?.reason, "non_regular_file");
  assert.equal(result.exclusions.find(file => file.path === "binary.ts")?.reason, "binary");
  assert.equal(result.exclusions.find(file => file.path === "image.png")?.reason, "unsupported_type");
  assert.equal(result.exclusions.find(file => file.path === ".private/internal.ts")?.reason, "sensitive_path");
});

test("capture requires an exact commit and rejects unrelated or older history", async t => {
  const repo = await repository(t);
  await repo.write("state.ts", "export const state = 1;\n");
  const old = await repo.commit();
  await repo.write("state.ts", "export const state = 2;\n");
  await repo.commit();
  const source = new GitEvidenceSource();
  const preview = await source.preview(repo.root);
  await assert.rejects(source.capture(preview, "HEAD"), code("exact_commit_required"));
  await assert.rejects(source.capture(preview, "--output=/tmp/not-allowed"), code("exact_commit_required"));
  await assert.rejects(source.capture(preview, old), code("commit_outside_subscription"));
});

test("existing hooks and malicious diff/textconv configuration are not executed or overwritten", async t => {
  const repo = await repository(t);
  await repo.write("state.ts", "export const state = 1;\n");
  await repo.write(".gitattributes", "*.ts diff=synthetic\n");
  const head = await repo.commit();
  const marker = path.join(repo.root, ".git", "unexpected-execution");
  const helper = path.join(repo.root, ".git", "synthetic-helper.sh");
  await fs.writeFile(helper, `#!/bin/sh\nprintf executed > '${marker}'\n`, { mode: 0o700 });
  await repo.git("config", "diff.synthetic.command", helper);
  await repo.git("config", "diff.synthetic.textconv", helper);
  await repo.git("config", "diff.external", helper);
  await repo.git("config", "core.fsmonitor", helper);
  const hook = path.join(repo.root, ".git", "hooks", "post-commit");
  const originalHook = "#!/bin/sh\n# an existing user hook must be preserved\n";
  await fs.writeFile(hook, originalHook, { mode: 0o700 });
  const source = new GitEvidenceSource();
  const result = await source.capture(await source.preview(repo.root), head);
  assert.equal(result.files.length, 1);
  assert.equal(await fs.readFile(hook, "utf8"), originalHook);
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
});

test("Git alternate object stores and linked metadata require a separate explicit scope", async t => {
  const repo = await repository(t);
  await repo.write("safe.ts", "export {};\n");
  await repo.commit();
  const source = new GitEvidenceSource();
  await fs.writeFile(path.join(repo.root, ".git", "objects", "info", "alternates"), "/synthetic-outside-object-store\n");
  await assert.rejects(source.preview(repo.root), code("alternate_object_store_denied"));
  const linked = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-harvest-worktree-"));
  const linkedRoot = await fs.realpath(linked);
  t.after(() => fs.rm(linkedRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(linkedRoot, ".git"), `gitdir: ${path.join(repo.root, ".git")}\n`);
  await assert.rejects(source.preview(linkedRoot), code("linked_worktree_requires_metadata_authorization"));
});

test("file limits produce an explicit partial capture instead of silently dropping work", async t => {
  const repo = await repository(t);
  await repo.write("a.ts", "export const a = 1;\n");
  await repo.write("b.ts", "export const b = 2;\n");
  const head = await repo.commit();
  const source = new GitEvidenceSource({ maxFiles: 1 });
  const result = await source.capture(await source.preview(repo.root), head);
  assert.deepEqual(result.files.map(file => file.path), ["a.ts"]);
  assert.equal(result.truncated, true);
  assert.ok(result.exclusions.some(file => file.path === "b.ts" && file.reason === "file_budget"));
});

test("before and after file sizes are bounded, with no raw content in exclusion metadata", async t => {
  const repo = await repository(t);
  await repo.write("huge.ts", "x".repeat(1000));
  await repo.write("safe.ts", "export {};\n");
  const head = await repo.commit();
  const source = new GitEvidenceSource({ maxFileBytes: 32 });
  const result = await source.capture(await source.preview(repo.root), head);
  assert.deepEqual(result.files.map(file => file.path), ["safe.ts"]);
  assert.equal(result.truncated, true);
  assert.ok(result.exclusions.some(file => file.path === "huge.ts" && file.reason === "file_budget"));
  assert.doesNotMatch(JSON.stringify(result), /x{100}/);
});

test("cancellation and replaced repository metadata invalidate pending capture", async t => {
  const repo = await repository(t);
  await repo.write("safe.ts", "export {};\n");
  const head = await repo.commit();
  const source = new GitEvidenceSource();
  const preview = await source.preview(repo.root);
  const controller = new AbortController();
  controller.abort(new Error("synthetic cancellation"));
  await assert.rejects(source.capture(preview, head, controller.signal), /synthetic cancellation/);
  await fs.rename(path.join(repo.root, ".git"), path.join(repo.root, "previous-metadata"));
  await repo.git("init", "--initial-branch=main");
  await assert.rejects(source.capture(preview, head), code("repository_changed"));
});

test("an explicit real repository root and bounded positive budgets are required", async t => {
  const repo = await repository(t);
  const source = new GitEvidenceSource();
  await assert.rejects(source.preview("."), code("explicit_repository_required"));
  await assert.rejects(source.preview(os.homedir()), code("repository_scope_too_broad"));
  await fs.mkdir(path.join(repo.root, "child"));
  await assert.rejects(source.preview(path.join(repo.root, "child")), code("explicit_repository_root_required"));
  assert.throws(() => new GitEvidenceSource({ maxFiles: 0 }), code("invalid_git_budget"));
  assert.throws(() => new GitEvidenceSource({ maxFiles: 100_000 }), code("invalid_git_budget"));
});

test("bounded background discovery returns oldest unprocessed commits first without skipping the cursor", async t => {
  const repo = await repository(t);
  await repo.write("state.ts", "export const state = 0;\n");
  await repo.commit();
  const source = new GitEvidenceSource();
  const preview = await source.preview(repo.root);
  const commits: string[] = [];
  for (let value = 1; value <= 3; value++) {
    await repo.write("state.ts", `export const state = ${value};\n`);
    commits.push(await repo.commit());
  }
  const first = await source.commitsSince(preview, preview.head, 2);
  assert.deepEqual(first.commits, commits.slice(0, 2));
  assert.equal(first.hasMore, true);
  assert.equal(first.head, commits[2]);
  const second = await source.commitsSince(preview, first.commits[1]!, 2);
  assert.deepEqual(second.commits, [commits[2]]);
  assert.equal(second.hasMore, false);
  assert.deepEqual((await source.commitsSince(preview, second.head)).commits, []);
});

test("forged snapshot metadata and shell-like cursors cannot broaden discovery", async t => {
  const repo = await repository(t);
  await repo.write("state.ts", "export {};\n");
  const head = await repo.commit();
  const source = new GitEvidenceSource();
  const preview = await source.preview(repo.root);
  await assert.rejects(source.capture({ ...preview, head: "--config=bad" }, head), code("repository_changed"));
  await assert.rejects(source.commitsSince(preview, "HEAD"), code("invalid_commit_cursor"));
  await assert.rejects(source.commitsSince(preview, head, 0), code("invalid_commit_cursor"));
});
