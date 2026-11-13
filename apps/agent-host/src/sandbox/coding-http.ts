import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { CodingTaskError, type CodingTaskLease, type CodingTaskService } from "./coding-tasks.js";
import type { CodingAutoRuns } from "./coding-auto.js";

const root = "/api/v1/agent/sandbox/coding/tasks";
const revision = z.number().int().nonnegative();
const stepBody = z.object({ expectedRevision: revision, consent: z.literal(true) }).strict();
const pauseBody = z.object({ expectedRevision: revision }).strict();
type Send = (res: ServerResponse, status: number, body: unknown) => void;

/** Only called after the Host has resolved the principal and checked origin and transport auth. */
export async function handleSandboxCoding(req: IncomingMessage, res: ServerResponse, pathname: string,
  tasks: CodingTaskService, auto: CodingAutoRuns, lease: CodingTaskLease, acquireRunLease:()=>{valid:CodingTaskLease;release:()=>void},
  read: (req: IncomingMessage, maxBytes?: number) => Promise<unknown>, send: Send) {
  const one = /^\/api\/v1\/agent\/sandbox\/coding\/tasks\/([A-Za-z0-9_-]{1,100})(?:\/(step|run|pause))?$/.exec(pathname);
  if (pathname !== root && !one) return send(res, 404, { error: "coding_endpoint_not_found" });
  const check = async () => {
    if (lease.signal?.aborted || !await lease() || lease.signal?.aborted) throw new CodingTaskError("coding_lease_invalid",403);
  };
  await check();
  if (req.method === "GET" && !one?.[2]) {
    const body = one ? { task: auto.view(await tasks.get(one[1]!, lease)) } : { tasks: (await tasks.list(lease)).map(t => ({
      id:t.id,revision:t.revision,goal:t.goal,model:t.model,status:t.status,attemptsUsed:t.attemptsUsed,maxAttempts:t.maxAttempts,updatedAt:t.updatedAt,autoRunning:auto.view(t).autoRunning,
    })) };
    await check(); return send(res,200,body);
  }
  if (req.method !== "POST" || (one && !one[2])) return send(res,405,{error:"coding_method_denied"});
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) return send(res,415,{error:"json_required"});
  let body: unknown;
  try { body=await read(req,one?1024:96*1024); }
  catch(error) { if(error instanceof SyntaxError) return send(res,400,{error:"invalid_json"}); throw error; }
  // Service validates the complete immutable initializer contract (including consent).
  let task;
  if (!one) task=await tasks.create(body as Parameters<CodingTaskService["create"]>[0], lease);
  else if (one[2] === "step" || one[2] === "run") {
    const parsed=stepBody.safeParse(body); if (!parsed.success) return send(res,400,{error:"invalid_coding_step"});
    if (one[2] === "run") {
      // This lease lives in the Host, independently of HTTP subscriptions.
      const held=acquireRunLease();
      try {task=await auto.start(one[1]!,parsed.data.expectedRevision,held.valid,held.release);}
      catch(error) {held.release();throw error;}
    } else {
      if (auto.busy(one[1]!)) return send(res,409,{error:"coding_auto_running"});
      task=await tasks.step(one[1]!,parsed.data.expectedRevision,lease);
    }
  } else {
    const parsed=pauseBody.safeParse(body); if (!parsed.success) return send(res,400,{error:"invalid_coding_pause"});
    task=await auto.pause(one[1]!,parsed.data.expectedRevision,lease);
  }
  await check(); return send(res,!one?201:one[2]==="run"?202:200,{task:auto.view(task)});
}
