import path from "node:path";
import { z } from "zod";
import { TaskScopeAssociationSchema, type AgentTask, type TaskScopeAssociation } from "@better-me/agent-contracts";
import { readPrivateJson, writePrivateJson } from "../identity/private-json.js";
import { CareerTaskError } from "../tasks/evidence.js";

const registrySchema=z.object({schema:z.literal(1),ownerId:z.string().min(1),associations:z.array(TaskScopeAssociationSchema)}).strict();
type Registry=z.infer<typeof registrySchema>;
const invalid=():never=>{throw new CareerTaskError("invalid_task_scope_associations",503);};

/** One atomic metadata file; original task journals remain the only usage ledger.
 * Every call is made under the kernel's existing owner writer lock. */
export class TaskScopeAssociations {
  private readonly file:string;
  constructor(directory:string,private ownerId:string){this.file=path.join(directory,"task-scope-associations-v1.json");}
  async read():Promise<Registry>{
    let raw:unknown;
    try{raw=await readPrivateJson(this.file);}catch{invalid();}
    if(raw===undefined)return {schema:1,ownerId:this.ownerId,associations:[]};
    const parsed=registrySchema.safeParse(raw);if(!parsed.success||parsed.data.ownerId!==this.ownerId)invalid();
    const registry=parsed.data!,roots=new Set<string>(),scopes=new Set<string>(),members=new Set<string>();
    for(const entry of registry.associations){
      if(entry.ownerId!==this.ownerId||roots.has(entry.rootTaskId)||scopes.has(entry.rootScopeKey)||!entry.memberIds.includes(entry.rootTaskId))invalid();
      roots.add(entry.rootTaskId);scopes.add(entry.rootScopeKey);
      for(const id of entry.memberIds){if(members.has(id))invalid();members.add(id);}
    }
    return registry;
  }
  scope(task:AgentTask,registry:Registry):string|undefined{
    const entry=registry.associations.find(item=>item.rootTaskId===(task.rootTaskId??task.id));
    if(!entry)return task.rootScopeKey;
    // Only explicitly confirmed original members may retain an absent raw scope.
    // Newly created descendants must persist the effective scope themselves.
    if(task.rootScopeKey===undefined&&!entry.memberIds.includes(task.id)||task.rootScopeKey!==undefined&&task.rootScopeKey!==entry.rootScopeKey)invalid();
    return entry.rootScopeKey;
  }
  async append(registry:Registry,association:TaskScopeAssociation){
    if(registry.associations.some(item=>item.rootTaskId===association.rootTaskId||item.rootScopeKey===association.rootScopeKey))invalid();
    await writePrivateJson(this.file,{...registry,associations:[...registry.associations,association]});
  }
}
