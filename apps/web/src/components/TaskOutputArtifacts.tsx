import {useEffect,useRef,useState} from "react";
import type {TaskOutputArtifact} from "@better-me/agent-contracts";
import {captureIdentityLease} from "../lib/identity";
import {defaultTaskOutputClient,type TaskOutputSource,type VerifiedTaskOutput} from "../services/task-output-client";
import "./task-output-artifacts.css";

type Client=typeof defaultTaskOutputClient;
function Output({task,artifact,client}:{task:TaskOutputSource;artifact:TaskOutputArtifact;client:Client}){
  const [lease]=useState(captureIdentityLease),[value,setValue]=useState<VerifiedTaskOutput>(),[busy,setBusy]=useState(false),[invalid,setInvalid]=useState(false),[message,setMessage]=useState("");
  const operation=useRef<AbortController|undefined>(undefined),urls=useRef(new Set<string>());
  useEffect(()=>{
    const invalidate=()=>{operation.current?.abort();operation.current=undefined;setValue(undefined);setBusy(false);setInvalid(true);setMessage("账号授权已变化，全文已从本页清除；未重新读取。");for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();};
    lease.signal.addEventListener("abort",invalidate,{once:true});if(lease.signal.aborted)invalidate();
    const currentUrls=urls.current;
    return()=>{lease.signal.removeEventListener("abort",invalidate);operation.current?.abort();operation.current=undefined;for(const url of currentUrls)URL.revokeObjectURL(url);currentUrls.clear();};
  },[lease]);
  async function read(){
    if(operation.current)return;const controller=new AbortController();operation.current=controller;setBusy(true);setMessage("");
    try{lease.assert();const result=await client.read(task,artifact.id,controller.signal);lease.assert();controller.signal.throwIfAborted();if(operation.current===controller)setValue(result);}
    catch(error){if(operation.current===controller&&!controller.signal.aborted)setMessage(error instanceof Error?error.message:"原始输出尚未核实，没有显示部分内容。");}
    finally{if(operation.current===controller){operation.current=undefined;setBusy(false);}}
  }
  function close(){operation.current?.abort();operation.current=undefined;setBusy(false);setValue(undefined);setMessage("");}
  async function copy(){try{lease.assert();if(!value)return;await navigator.clipboard.writeText(value.text);lease.assert();setMessage("已复制完整原文。");}catch{if(!lease.signal.aborted)setMessage("复制未完成，可下载完整原文。");}}
  function download(){
    try{lease.assert();if(!value)return;const url=URL.createObjectURL(new Blob([value.text],{type:"text/plain;charset=utf-8"}));urls.current.add(url);
      const link=document.createElement("a");link.href=url;link.download=`${task.id}-${artifact.id}.txt`;link.click();
      setTimeout(()=>{URL.revokeObjectURL(url);urls.current.delete(url);},1000);
    }catch{if(!lease.signal.aborted)setMessage("下载未完成，完整原文仍保留在原任务。");}
  }
  return <section className="task-output-artifact" aria-label={`原始输出 ${artifact.id}`}>
    <div className="task-output-artifact-heading"><strong>完整原始输出</strong><span>{artifact.bytes.toLocaleString()} 字节</span></div>
    <details><summary>核对文件信息</summary><dl><dt>记录</dt><dd>{artifact.id}</dd><dt>保存时间</dt><dd>{artifact.createdAt}</dd><dt>SHA-256</dt><dd>{artifact.hash}</dd></dl></details>
    <div className="task-output-artifact-actions">
      {!value&&<button type="button" disabled={busy||invalid} onClick={()=>void read()}>{busy?"正在读取并校验…":"读取完整原文"}</button>}
      {(busy||value)&&<button type="button" onClick={close}>{busy?"取消读取":"收起并清除本页全文"}</button>}
      {value&&<><button type="button" onClick={()=>void copy()}>复制完整原文</button><button type="button" onClick={download}>下载完整原文</button></>}
    </div>
    {message&&<p role="status">{message}</p>}
    {value&&<><p className="task-output-artifact-note">字节数与 SHA-256 已核实。以下是原始模型输出，不代表完整结果或已采用内容。</p><pre tabIndex={0} aria-label="完整原始输出正文">{value.text}</pre></>}
  </section>;
}

/** Same reader for the shared root ledger and task-local recovery views. */
export function TaskOutputArtifacts({task,client=defaultTaskOutputClient}:{task:TaskOutputSource;client?:Client}){
  if(!task.outputArtifacts?.length)return null;
  return <div className="task-output-artifacts">{task.outputArtifacts.map(artifact=><Output key={`${task.ownerId}:${task.id}:${artifact.id}:${artifact.hash}:${artifact.bytes}`} task={task} artifact={artifact} client={client}/>)}</div>;
}
