import { useEffect, useState } from "react";
import { inventoryJobSignals, type InventoryProfile } from "@better-me/agent-contracts";
import { inventoryClient } from "../services/inventory-client";

/** Private preferences are compared on this device. No profile ever enters the JD model material or score. */
export function InventoryJobCheck({description}:{description:string}){
  const [profile,setProfile]=useState<InventoryProfile|null>(null),[open,setOpen]=useState(false),[error,setError]=useState(false);
  useEffect(()=>{
    if(!open)return;let active=true,n=0;
    const read=()=>{const seq=++n;setProfile(null);void inventoryClient.profile().then(p=>{if(active&&seq===n){setProfile(p);setError(false);}},()=>{if(active&&seq===n)setError(true);});};
    read();window.addEventListener("focus",read);window.addEventListener("betterme:inventory-profile",read);
    return()=>{active=false;window.removeEventListener("focus",read);window.removeEventListener("betterme:inventory-profile",read);};
  },[open]);
  const signals=profile?inventoryJobSignals(profile,description):[];
  return <details className="iv-context" onToggle={e=>setOpen(e.currentTarget.open)}><summary>用我的私有偏好核对岗位</summary>
    {open&&(error?<p role="alert">未能读取本人画像，没有推断岗位适合度。</p>:!profile?<p>读取本人已确认的偏好…</p>:!signals.length?<p>还没有允许用于岗位提醒的偏好。</p>:signals.map(s=><div className="iv-row" key={s.id}><strong>{s.state==="conflict"?"与本人偏好可能冲突":s.state==="check"?"原句需核对":"岗位未明确 · 建议面试时问"}</strong><p>本人：{s.preference}</p>{s.quote&&<p>岗位原文：{s.quote}</p>}</div>))}</details>;
}
