import test from "node:test";
import assert from "node:assert/strict";
import { SandboxBuildService } from "../src/sandbox/build-service.js";
import { PRESET_MICRO_APP_TEMPLATES } from "../../web/src/services/sandbox-build-client.js";

test("all shipped microapp templates compile without executing a guest or omitting the actual UI",async()=>{
  const service=new SandboxBuildService();
  for (const [appId,preset] of Object.entries(PRESET_MICRO_APP_TEMPLATES)){
    const artifact=await service.build({appId,...preset});
    assert.ok(artifact.bundleHtml.includes(preset.htmlBody));assert.ok(artifact.bundleHtml.includes("connect-src 'none'"));
    assert.equal(artifact.verification.profile,"reviewed-builtin-v2");
    assert.match(artifact.codeHash,/^[a-f0-9]{64}$/);assert.equal(artifact.pinnedToDock,false);
  }
});
test("unknown JS, changed markup/permissions, and traversal are never buildable via the preset endpoint",async()=>{
  const service=new SandboxBuildService(),appId="star-prompter",p={appId,...PRESET_MICRO_APP_TEMPLATES[appId]!};
  for (const body of [{...p,sourceCode:"globalThis.process.exit(23)"},{...p,htmlBody:p.htmlBody+"changed"},
    {...p,grantedScopes:["job_snapshots","backcheck_summary"]},{...p,dependencies:["unreviewed"]},{...p,appId:"../../unsafe"}])
    await assert.rejects(service.build(body),/invalid_sandbox_template|unreviewed_sandbox_template/);
});
