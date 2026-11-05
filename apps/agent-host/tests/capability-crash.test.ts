import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { CareerCapabilities } from "../src/capabilities/service.js";

test("a hard-crashed writer releases its OS lease; restart preserves the task without automatic generation", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-capability-crash-"));
  const moduleUrl = new URL("../src/capabilities/service.ts", import.meta.url).href;
  const contractsUrl = new URL("../../../packages/agent-contracts/src/capabilities.ts", import.meta.url).href;
  // Resolve from repository root, not a global tsx install.
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const source = `import {CareerCapabilities} from ${JSON.stringify(moduleUrl)};
    import {syntheticJobComparison} from ${JSON.stringify(contractsUrl)};
    const keepAlive=setInterval(()=>{},1000);
    const service=new CareerCapabilities({directory:${JSON.stringify(directory)},ownerId:'crash-owner',
      builder:async()=>{process.send({ready:true});return new Promise(()=>{});}});
    await service.start({input:syntheticJobComparison(),idempotencyKey:'crash-operation',expectedCatalogRevision:0,consent:true},
      {session:'old-session',valid:async()=>true});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: root,
    stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let diagnostic = ""; child.stderr!.on("data", chunk => { diagnostic += String(chunk); });
  let service: CareerCapabilities | undefined;
  try {
    await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`crash_fixture_failed:${diagnostic}`); })]);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    service = new CareerCapabilities({ directory, ownerId: "crash-owner", builder: async () => { throw new Error("must_not_auto_replay"); } });
    const state = await service.snapshot(); assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0]?.stage, "interrupted"); assert.equal(state.tasks[0]?.grant.revoked, true);
    assert.equal(state.tasks[0]?.builderCalls, 1); assert.equal(state.tasks[0]?.receipt, undefined);
  } finally { child.kill("SIGKILL"); await service?.close(); await rm(directory, { recursive: true, force: true }); }
});
