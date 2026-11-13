import path from "node:path";
import { z } from "zod";
import { readPrivateJson, writePrivateJson } from "../identity/private-json.js";
import type { CodingTaskLease } from "./coding-tasks.js";

// Switching accounts need not revoke a credential for unrelated applications.
// Fence this capability separately, even if the previous cookie has not expired
// and the Host has restarted. Only digests survive; the identity TTL is 8 hours.
const denials = z.array(z.object({ key:z.string().regex(/^[a-f0-9]{64}$/), until:z.number().finite() }).strict());
export class CodingLeases {
  private active=new Map<string,Set<AbortController>>();
  private revoked=new Map<string,number>();
  private writes:Promise<void>=Promise.resolve();
  private closed=false;
  constructor(private directory:string) {}
  private file(owner:string) { return path.join(this.directory,"owners",owner,"sandbox-coding-access-v1","denied.json"); }
  open(owner:string,key:string,authenticated:()=>Promise<boolean>) {
    const controller=new AbortController(), group=this.active.get(key) ?? new Set<AbortController>();
    group.add(controller);this.active.set(key,group);
    const live=()=>!this.closed && !controller.signal.aborted && (this.revoked.get(key)??0)<=Date.now();
    const valid:CodingTaskLease=Object.assign(async ()=>{
      if (!live() || !await authenticated()) return false;
      await this.writes;
      const blocked=denials.parse(await readPrivateJson(this.file(owner)) ?? []);
      return live() && !blocked.some(v=>v.key===key && v.until>Date.now());
    },{signal:controller.signal});
    return {valid,release:()=>{group.delete(controller);if (!group.size) this.active.delete(key);}};
  }
  revoke(owner:string,key:string) {
    const now=Date.now(), until=now+24*3600000;
    for (const [k,exp] of this.revoked) if(exp<=now) this.revoked.delete(k);
    this.revoked.set(key,until);
    for(const c of this.active.get(key)??[]) c.abort();
    const file=this.file(owner);
    const op=this.writes.then(async ()=>{
      const fresh=denials.parse(await readPrivateJson(file)??[]).filter(v=>v.key!==key && v.until>Date.now());
      await writePrivateJson(file,[...fresh,{key,until}]);
    });
    this.writes=op.catch(()=>{}); return op;
  }
  close() { this.closed=true;for(const group of this.active.values()) for(const c of group)c.abort(); }
}
