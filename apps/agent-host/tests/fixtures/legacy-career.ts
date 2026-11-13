import {createHash} from "node:crypto";
import type {BaseCheckpointSaver} from "@langchain/langgraph";
import {Command} from "@langchain/langgraph";
import {buildCareerOrchestrator} from "../../src/graphs/career/graph.js";

/** Seed the exact historical checkpoint format, never through a live executor route. */
export async function seedLegacyCareer(checkpointer:BaseCheckpointSaver,ownerId:string|null,threadId:string,task:string,completed=false){
  const config={configurable:{thread_id:ownerId===null?threadId:createHash("sha256").update(JSON.stringify([ownerId,"career",threadId])).digest("hex")}};
  const graph=buildCareerOrchestrator(checkpointer);
  await graph.invoke({task,workspaceId:"synthetic-legacy"},config);
  if(completed)await graph.invoke(new Command({resume:{status:"approved",actorScope:ownerId,idempotencyKey:"synthetic-historical-approval"}}),config);
  return {config,tuple:await checkpointer.getTuple(config)};
}
