import type http from "node:http";
import { z } from "zod";
import { CareerTaskBudgetSchema, AgentTaskCreateSchema, AgentTaskRunSchema, CareerTaskMutationSchema, CareerTaskReceiptSchema, ChatGptRuntimeSchema, JdMatchReviewSchema, JdOcrUploadSchema, isCareerTask, agentTaskSourceFingerprint, type AgentTask, type AgentTaskCreate } from "@better-me/agent-contracts";
import { ModelSettingsSchema } from "../model.js";
import type { NativeLease } from "../native-tools/service.js";
import type { UnderstandingRuntime } from "../understanding/http.js";
import { CareerTaskError, CareerTaskService, type CareerTaskRuntime } from "./service.js";
import { taskTools } from "../kernel/tools.js";
import { TaskRootScopeKeySchema, TaskScopeAssociationRequestSchema } from "@better-me/agent-contracts";

const runtimeSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("model"),modelSettings:ModelSettingsSchema}).strict(),
  z.object({kind:z.literal("native"),runtimeId:z.string().min(1).max(120)}).strict(),
  z.object({kind:z.literal("unified"),expectedRevision:z.number().int().nonnegative()}).strict(),ChatGptRuntimeSchema,
]);
const runSchema=AgentTaskRunSchema.extend({runtime:runtimeSchema}).strict();
type Dependencies={ownerId:string;service:CareerTaskService;readBody:(req:http.IncomingMessage)=>Promise<unknown>;
  sendJson:(res:http.ServerResponse,status:number,value:unknown)=>void;
  resolveReasoner:(runtime:UnderstandingRuntime,lease:NativeLease,task:AgentTask,cancel:()=>Promise<void>)=>Promise<CareerTaskRuntime>};
const roots=["/api/v1/agent/tasks","/api/v1/agent/career-tasks"];
/** Authentication, host/origin checks and owner selection must already have happened in the host. Never bind a task's abort signal to this observer's connection. */
export function createCareerTaskHandler(deps:Dependencies){
  return async(req:http.IncomingMessage,res:http.ServerResponse,pathname:string,lease:NativeLease):Promise<boolean>=>{
    const root=roots.find(root=>pathname===root||pathname.startsWith(`${root}/`));if(!root)return false;
    res.setHeader("Cache-Control","no-store");const {service}=deps;
    const valid=async()=>{if(!await lease.valid())throw new CareerTaskError("interaction_lease_invalid",403);};
    try{
      await valid();
      if(pathname===`${root}/legacy-scopes`&&root==="/api/v1/agent/tasks"&&req.method==="GET"){
        const scope=TaskRootScopeKeySchema.parse(new URL(req.url??"","http://localhost").searchParams.get("rootScopeKey"));
        const preview=await service.previewLegacyScopes(scope,lease);await valid();deps.sendJson(res,200,preview);return true;
      }
      const association=/^\/(ct_[a-f0-9]{32})\/associate-scope$/.exec(pathname.slice(root.length));
      if(association&&root==="/api/v1/agent/tasks"&&req.method==="POST"){
        const input=TaskScopeAssociationRequestSchema.parse(await deps.readBody(req)),result=await service.associateLegacyScope(association[1]!,input,lease);
        await valid();deps.sendJson(res,200,result);return true;
      }
      if(pathname===`${root}/tools`&&req.method==="GET"){const tools=await service.listInstalledTools();await valid();deps.sendJson(res,200,{ownerId:deps.ownerId,tools});return true;}
      const installed=/^\/tools\/(tool_[a-f0-9]{32})\/revoke$/.exec(pathname.slice(root.length));
      if(installed&&req.method==="POST"){
        const c=z.object({sourceHash:z.string().regex(/^[a-f0-9]{64}$/),consent:z.literal(true)}).strict().parse(await deps.readBody(req));
        await service.revokeTool(installed[1]!,c.sourceHash,lease);await valid();deps.sendJson(res,200,{ownerId:deps.ownerId,tools:await service.listInstalledTools()});return true;
      }
      const install=/^\/(ct_[a-f0-9]{32})\/tools\/(tool_[a-f0-9]{32})\/install$/.exec(pathname.slice(root.length));
      if(install&&req.method==="POST"){
        const c=CareerTaskMutationSchema.extend({sourceHash:z.string().regex(/^[a-f0-9]{64}$/),consent:z.literal(true)}).strict().parse(await deps.readBody(req));
        const task=await service.installTool(install[1]!,c.expectedRevision,install[2]!,c.sourceHash,lease);await valid();deps.sendJson(res,200,{task});return true;
      }
      if(pathname===root&&req.method==="GET"){const tasks=root.endsWith("career-tasks")?await service.list():await service.listTasks();await valid();deps.sendJson(res,200,{tasks});return true;}
      if(pathname===root&&req.method==="POST"){
        const input=await deps.readBody(req);AgentTaskCreateSchema.parse(input);
        // Kernel owns normalization: an omitted child budget must not become an
        // explicit request for the schema's fresh-root default ceiling.
        const task=await service.createTask(input as AgentTaskCreate,lease);await valid();deps.sendJson(res,201,{task});return true;
      }
      const image=/^\/(ct_[a-f0-9]{32})\/images\/(img_[a-f0-9]{32})$/.exec(pathname.slice(root.length));
      if(image&&root==="/api/v1/agent/tasks"){
        if(req.method==="POST"){
          const input=JdOcrUploadSchema.parse(await deps.readBody(req));await valid();
          const task=await service.uploadOcrImage(image[1]!,image[2]!,input,lease);await valid();deps.sendJson(res,200,{task});return true;
        }
        if(req.method==="GET"){
          const result=await service.readOcrImage(image[1]!,image[2]!,lease);await valid();deps.sendJson(res,200,result);return true;
        }
        throw new CareerTaskError("method_not_allowed",405);
      }
      const output=/^\/(ct_[a-f0-9]{32})\/outputs\/(out_[a-f0-9]{32})$/.exec(pathname.slice(root.length));
      const currentAnalysis=/^\/(ct_[a-f0-9]{32})\/analysis\/current$/.exec(pathname.slice(root.length));
      if(currentAnalysis&&req.method==="GET"){
        const task=await service.currentStudioAnalysis(currentAnalysis[1]!,lease);await valid();deps.sendJson(res,200,{task});return true;
      }
      const currentCommittee=/^\/(ct_[a-f0-9]{32})\/committee\/current$/.exec(pathname.slice(root.length));
      if(currentCommittee&&req.method==="GET"){
        const task=await service.currentStudioCommittee(currentCommittee[1]!,lease);await valid();deps.sendJson(res,200,{task});return true;
      }
      if(output&&req.method==="GET"){
        const result=await service.readOutput(output[1]!,output[2]!);await valid();
        res.setHeader("Content-Type","text/plain; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename="${output[2]}.txt"`);res.setHeader("X-Content-Type-Options","nosniff");res.end(result.text);return true;
      }
      const project=/^\/(ct_[a-f0-9]{32})\/project\/(source|grants|revoke-grant|confirm|cancel)$/.exec(pathname.slice(root.length));
      if(project){
        if(req.method!=="POST")throw new CareerTaskError("method_not_allowed",405);
        const raw=await deps.readBody(req);await valid();let task:AgentTask;
        if(project[2]==="source"){const c=CareerTaskMutationSchema.extend({sourceText:z.string().min(1).max(16000)}).strict().parse(raw);task=await service.updateProjectSource(project[1]!,c.expectedRevision,c.sourceText,lease);}
        else if(project[2]==="grants"){const c=CareerTaskMutationSchema.extend({path:z.string().min(1).max(3000)}).strict().parse(raw);task=await service.grantProject(project[1]!,c.expectedRevision,c.path,lease);}
        else if(project[2]==="revoke-grant"){const c=CareerTaskMutationSchema.extend({grantId:z.string().min(1).max(300)}).strict().parse(raw);task=await service.revokeProjectGrant(project[1]!,c.expectedRevision,c.grantId,lease);}
        else if(project[2]==="confirm"){const c=CareerTaskMutationSchema.extend({summaryHash:z.string().min(1).max(128)}).strict().parse(raw);task=await service.confirmProject(project[1]!,c.expectedRevision,c.summaryHash,lease);}
        else{const c=z.object({expectedTurnCount:z.number().int().nonnegative()}).strict().parse(raw);task=await service.cancelProject(project[1]!,c.expectedTurnCount,lease);}
        await valid();deps.sendJson(res,200,{task});return true;
      }
      const group=/^\/(ct_[a-f0-9]{32})\/pause-group$/.exec(pathname.slice(root.length));
      if(group&&req.method==="POST"){const c=CareerTaskMutationSchema.parse(await deps.readBody(req));const task=await service.pauseGroup(group[1]!,c.expectedRevision,lease);await valid();deps.sendJson(res,200,{task});return true;}
      const jdReview=/^\/(ct_[a-f0-9]{32})\/jd-review$/.exec(pathname.slice(root.length));
      if(jdReview&&req.method==="POST"){
        const c=CareerTaskMutationSchema.extend({decisions:JdMatchReviewSchema,consent:z.literal(true)}).strict().parse(await deps.readBody(req));
        const task=await service.reviewJdMatch(jdReview[1]!,c.expectedRevision,c.decisions,lease);await valid();deps.sendJson(res,200,{task});return true;
      }
      const match=/^\/(ct_[a-f0-9]{32})(?:\/(start|resume|answer|pause|revoke|budget|update-budget|receipt|facts|events|tools)(?:\/(fact_[a-f0-9]{24})\/(approve|reject))?)?$/.exec(pathname.slice(root.length));
      if(!match)throw new CareerTaskError("task_route_not_found",404);
      const [,rawId,op,factId,factOp]=match,id=rawId!;
      if(!op&&req.method==="GET"){const task=await service.readTask(id);await valid();deps.sendJson(res,200,{task});return true;}
      if(op==="events"&&req.method==="GET"){
        const after=new URL(req.url??"", "http://localhost").searchParams.get("after")??"0";
        if(!/^\d{1,12}$/.test(after))throw new CareerTaskError("invalid_event_cursor",422);
        const feed=await service.watch(id,Number(after));await valid();deps.sendJson(res,200,feed);return true;
      }
      if(op==="tools"&&req.method==="GET"){const task=await service.readTask(id);await valid();deps.sendJson(res,200,{taskId:id,tools:isCareerTask(task)?taskTools(task):[]});return true;}
      if(req.method!=="POST"||!op)throw new CareerTaskError("method_not_allowed",405);
      const raw=await deps.readBody(req);await valid();let task:AgentTask;
      if(op==="start"||op==="resume"||op==="answer"){
        const {runtime,...input}=runSchema.parse(raw),current=await service.readTask(id);
        if(current.kind==="project_understanding"&&input.projectTurn){const replay=await service.replayProjectTurn(id,input.projectTurn,lease);if(replay){await valid();deps.sendJson(res,200,{task:replay});return true;}}
        if(current.revision!==input.expectedRevision)throw new CareerTaskError("task_revision_conflict");
        if(agentTaskSourceFingerprint(current)!==input.sourceFingerprint)throw new CareerTaskError("source_changed_new_comparison_required");
        if(JSON.stringify(current.runtimeBinding)!==JSON.stringify(input.runtimeBinding))throw new CareerTaskError("runtime_binding_changed");
        const selected=await deps.resolveReasoner(runtime,lease,current,()=>service.cancelActive(id,input.expectedRevision+1));
        task=await service.dispatch(id,{kind:op,input,runtime:selected},input.expectedRevision,lease);
      }else if(op==="pause"||op==="revoke"){const c=CareerTaskMutationSchema.parse(raw);task=await service.dispatch(id,{kind:op},c.expectedRevision,lease);}
      else if(op==="budget"||op==="update-budget"){const c=CareerTaskMutationSchema.extend({budget:CareerTaskBudgetSchema,consent:z.literal(true)}).parse(raw);task=await service.dispatch(id,{kind:"budget",budget:c.budget},c.expectedRevision,lease);}
      else if(op==="receipt"){task=await service.receipt(id,CareerTaskReceiptSchema.parse(raw),lease);}
      else if(op==="facts"&&factId&&factOp){const c=CareerTaskMutationSchema.parse(raw);task=await service.decideFact(id,c.expectedRevision,factId,factOp==="approve",lease);}
      else if(op==="facts"){const c=CareerTaskMutationSchema.extend({text:z.string().min(1).max(4000),evidenceIds:z.array(z.string().min(1).max(300)).min(1).max(40)}).parse(raw);task=await service.fact(id,c.expectedRevision,c.text,c.evidenceIds,lease);}
      else throw new CareerTaskError("task_route_not_found",404);
      await valid();deps.sendJson(res,["start","resume","answer"].includes(op)?202:200,{task});
    }catch(error){
      const candidate=error as {code?:unknown;status?:unknown};
      const code=typeof candidate.code==="string"&&/^[a-z][a-z0-9_]{1,100}$/.test(candidate.code)?candidate.code:error instanceof z.ZodError?"invalid_task_request":"task_request_failed";
      const status=error instanceof z.ZodError?400:typeof candidate.status==="number"&&candidate.status>=400&&candidate.status<=599?candidate.status:500;
      deps.sendJson(res,status,{error:code});
    }
    return true;
  };
}
