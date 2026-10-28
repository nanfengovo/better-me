import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSandboxPlan } from "../src/runs/sandbox.js";

describe("run sandbox plans", () => {
  it("does not claim an OS permission boundary in auto mode without opt-in", async () => {
    const plan = await createSandboxPlan({
      command: process.execPath,
      args: ["--version"],
      cwd: "/tmp",
      runDirectory: "/tmp/better-me-run",
      allowedReadPaths: [],
      mode: "auto",
      platform: "darwin",
      env: { PATH: "/does-not-exist" },
    });
    assert.equal(plan.isolation, "process");
    assert.equal(plan.provider, "none");
    assert.match(plan.detail, /shell-free/);
  });

  it("fails closed when a required provider is unavailable", async () => {
    await assert.rejects(
      createSandboxPlan({
        command: process.execPath,
        args: [],
        cwd: "/tmp",
        runDirectory: "/tmp/better-me-run",
        allowedReadPaths: [],
        mode: "required",
        platform: "freebsd",
        env: { PATH: "/does-not-exist" },
      }),
      /os_sandbox_unavailable:freebsd/,
    );
  });

  it("builds a Linux read-only-root plan from a discovered bwrap binary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "better-me-bwrap-"));
    const bwrap = path.join(root, "bwrap");
    await fs.writeFile(bwrap, "#!/bin/sh\n");
    await fs.chmod(bwrap, 0o755);
    try {
      const plan = await createSandboxPlan({
        command: "/usr/bin/node",
        args: ["--version"],
        cwd: "/tmp/run",
        runDirectory: "/tmp/run",
        allowedReadPaths: ["/workspace"],
        mode: "required",
        platform: "linux",
        env: { PATH: root },
      });
      assert.equal(plan.provider, "linux-bubblewrap");
      assert.equal(plan.isolation, "os-sandbox");
      assert.ok(plan.args.includes("--ro-bind"));
      assert.ok(plan.args.includes("/workspace"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
