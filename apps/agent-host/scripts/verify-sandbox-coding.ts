/** Operator opt-in: a real, already-installed local model, synthetic examples
 * only. No workspace files, publishing, remote fallback, or model downloads. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodingTaskService } from "../src/sandbox/coding-tasks.js";
import { verifyCodingCandidate } from "../src/sandbox/coding-engine.js";
const args=process.argv.slice(2);
if(args.length!==3 || args[0]!=="--model" || !args[1]?.trim() || args[2]!=="--consent-synthetic"){
  console.error("Usage: pnpm exec tsx apps/agent-host/scripts/verify-sandbox-coding.ts --model <installed-local-tag> --consent-synthetic");
  process.exitCode=2;
} else {
  const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-coding-smoke-"));
  const tasks=new CodingTaskService({directory,ownerId:"synthetic-local-operator"}), lease=()=>true;
  try{
    let t=await tasks.create({model:args[1],consent:true,maxAttempts:2,maxActiveMs:150000,
      goal:"For a JSON input with an array values of integers, return the sum of strictly positive integers. Return 0 for an empty array.",
      cases:[{id:"mixed",input:{values:[-3,2,5,0]},expected:7},{id:"empty",input:{values:[]},expected:0},{id:"negative",input:{values:[-4,-1]},expected:0}]},lease);
    let first:typeof t.best;
    for(let i=0;i<2 && t.status==="ready";i++) {
      t=await tasks.step(t.id,t.revision,lease);
      if(i===0) first=t.best;
    }
    // Score first-pass and retained output only AFTER generation. Neither the
    // blind inputs nor their results go back into the model's repair context.
    const blind=[
      {id:"duplicates",input:{values:[2,2,-8,0,19]},expected:23},{id:"zeros",input:{values:[0,0]},expected:0},
    ];
    const score=async(candidate:typeof t.best)=> candidate ? {
      sourceHash:candidate.sourceHash,publicChecks:candidate.checks,
      blindChecks:await verifyCodingCandidate(candidate.source,blind,AbortSignal.timeout(12_000)),
    }:null;
    const firstPass=await score(first),retained=t.best && t.best.sourceHash===firstPass?.sourceHash ? firstPass : await score(t.best);
    console.log(JSON.stringify({model:t.model,modelDigest:t.modelDigest,status:t.status,attempts:t.attemptsUsed,activeMs:t.activeMs,
      firstPass,retained,regressions:t.history.filter(h=>h.outcome==="regression").length,installed:false},null,2));
    if(t.status!=="review_ready" || !retained || retained.blindChecks.length!==blind.length || !retained.blindChecks.every(c=>c.passed))process.exitCode=1;
  } finally {await tasks.close();await rm(directory,{recursive:true,force:true});}
}
