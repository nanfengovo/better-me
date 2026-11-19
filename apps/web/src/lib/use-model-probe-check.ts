import {useEffect,useState} from "react";
import {careerRuntimeBinding,type CareerRuntimeBinding} from "@better-me/agent-contracts";
import type {LlmConfig} from "@better-me/core";
import {captureIdentityLease} from "./identity";
import {readWorkspaceBinding} from "../services/agent-task-scope";
import {AgentTaskClientError} from "../services/agent-task-transport";

type Result={state:"checking"|"login"|"unavailable"|"legacy"|"unsafe"|"first"|"match"}|{state:"conflict";current:string};

/** Runs only when the user opens the fixed-text check. This reads the public
 * workspace binding; the Host still makes the authoritative decision on send. */
export function useModelProbeCheck(scope:string,config:Pick<LlmConfig,"model"|"baseUrl"|"provider">|undefined){
  const model=config?.model, baseUrl=config?.baseUrl, provider=config?.provider;
  const selection=JSON.stringify([scope,model,baseUrl,provider]);
  const [attempt,setAttempt]=useState(0);
  const [record,setRecord]=useState<{selection:string;attempt:number;result:Result}>();
  useEffect(()=>{
    if(model===undefined)return;
    const lease=captureIdentityLease(),controller=new AbortController();
    const publish=(result:Result)=>{if(!controller.signal.aborted)setRecord({selection,attempt,result});};
    const invalidate=()=>publish({state:"login"});
    lease.signal.addEventListener("abort",invalidate,{once:true});
    const check=async()=>{
      if(!lease.ownerId||lease.signal.aborted){invalidate();return;}
      let expected:CareerRuntimeBinding;
      try{expected=careerRuntimeBinding({kind:"model",modelSettings:{model,baseUrl,provider}});}catch{publish({state:"unsafe"});return;}
      try{
        const bound=await readWorkspaceBinding(scope,AbortSignal.any([controller.signal,lease.signal]));
        if(lease.signal.aborted)return;
        publish(!bound?{state:"first"}:bound.id===expected.id&&bound.label===expected.label&&bound.location===expected.location?{state:"match"}:{state:"conflict",current:bound.label});
      }catch(failure){
        if(lease.signal.aborted||controller.signal.aborted)return;
        // Older Hosts still enforce the pin on dispatch. Never fetch full task
        // histories, switch provider, or silently run a probe as a fallback.
        publish({state:failure instanceof AgentTaskClientError&&failure.code==="task_route_not_found"?"legacy":"unavailable"});
      }
    };
    void check();
    return()=>{controller.abort();lease.signal.removeEventListener("abort",invalidate);};
  },[scope,selection,model,baseUrl,provider,attempt]);
  const current=record?.selection===selection?record:undefined;
  const result=current&&(current.attempt===attempt||current.result.state==="first")?current.result:{state:"checking"} as const;
  return {result,blocked:Boolean(config)&&!["first","match","legacy"].includes(result.state),refresh:()=>setAttempt(value=>value+1)};
}
