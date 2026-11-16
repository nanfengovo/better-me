import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { InventoryWorkspace } from "./workspace.js";
import type { OwnedStore } from "../identity/owned-store.js";

/** No generic record-write endpoint exposes this namespace. The guard is rechecked at persistence. */
export async function handleInventory(req:IncomingMessage,res:ServerResponse,pathname:string,store:OwnedStore,ownerId:string,
  access:()=>Promise<boolean>, read:(r:IncomingMessage,limit?:number)=>Promise<unknown>,send:(r:ServerResponse,s:number,b:unknown)=>void) {
  const space=new InventoryWorkspace(store), suffix=pathname.slice("/api/v1/agent/inventory".length);
  const m=/^\/sessions\/([a-f0-9]{64})(\/commands)?$/.exec(suffix);
  if(req.method==="GET" && suffix==="/profile") return send(res,200,{ownerId,profile:await space.profile(access)});
  if(req.method==="GET" && m && !m[2]) return send(res,200,{ownerId,view:await space.get(m[1]!,access)});
  if(req.method==="POST"){
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"]??"")) return send(res,415,{error:"json_required"});
    if(suffix==="/start") return send(res,200,{ownerId,view:await space.start(await read(req,4*1024*1024),access)});
    if(m?.[2]) return send(res,200,{ownerId,view:await space.command(m[1]!,await read(req,140000),access)});
    if(suffix==="/profile/forget"){const c=z.object({id:z.string().uuid(),revision:z.number().int().nonnegative()}).strict().parse(await read(req,2048));
      return send(res,200,{ownerId,profile:await space.forget(c.id,c.revision,access)});}
  }
  return send(res,404,{error:"inventory_endpoint_not_found"});
}
