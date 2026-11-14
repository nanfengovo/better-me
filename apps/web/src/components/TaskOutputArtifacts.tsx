import {useEffect,useRef,useState} from "react";
import type {TaskOutputArtifact} from "@better-me/agent-contracts";
import {captureIdentityLease} from "../lib/identity";
import {defaultTaskOutputClient,type TaskOutputSource,type VerifiedTaskOutput} from "../services/task-output-client";
import {useUiPreferences} from "../lib/ui-preferences";
import "./task-output-artifacts.css";

type Client=typeof defaultTaskOutputClient;
function Output({task,artifact,client}:{task:TaskOutputSource;artifact:TaskOutputArtifact;client:Client}){
  const {t}=useUiPreferences();
  const [lease]=useState(captureIdentityLease),[value,setValue]=useState<VerifiedTaskOutput>(),[busy,setBusy]=useState(false),[invalid,setInvalid]=useState(false),[message,setMessage]=useState("");
  const operation=useRef<AbortController|undefined>(undefined),urls=useRef(new Set<string>());
  useEffect(()=>{
    const invalidate=()=>{operation.current?.abort();operation.current=undefined;setValue(undefined);setBusy(false);setInvalid(true);setMessage(t("账号授权已变化，全文已从本页清除；未重新读取。","Account authorization changed. Full text was cleared from this page and was not read again."));for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();};
    lease.signal.addEventListener("abort",invalidate,{once:true});if(lease.signal.aborted)invalidate();
    const currentUrls=urls.current;
    return()=>{lease.signal.removeEventListener("abort",invalidate);operation.current?.abort();operation.current=undefined;for(const url of currentUrls)URL.revokeObjectURL(url);currentUrls.clear();};
  },[lease,t]);
  async function read(){
    if(operation.current)return;const controller=new AbortController();operation.current=controller;setBusy(true);setMessage("");
    try{lease.assert();const result=await client.read(task,artifact.id,controller.signal);lease.assert();controller.signal.throwIfAborted();if(operation.current===controller)setValue(result);}
    catch(error){if(operation.current===controller&&!controller.signal.aborted)setMessage(error instanceof Error?error.message:t("原始输出尚未核实，没有显示部分内容。","Raw output has not been verified; no partial content is shown."));}
    finally{if(operation.current===controller){operation.current=undefined;setBusy(false);}}
  }
  function close(){operation.current?.abort();operation.current=undefined;setBusy(false);setValue(undefined);setMessage("");}
  async function copy(){try{lease.assert();if(!value)return;await navigator.clipboard.writeText(value.text);lease.assert();setMessage(t("已复制完整原文。","Copied the full text."));}catch{if(!lease.signal.aborted)setMessage(t("复制未完成，可下载完整原文。","Copy did not finish. You can download the full text."));}}
  function download(){
    try{lease.assert();if(!value)return;const url=URL.createObjectURL(new Blob([value.text],{type:"text/plain;charset=utf-8"}));urls.current.add(url);
      const link=document.createElement("a");link.href=url;link.download=`${task.id}-${artifact.id}.txt`;link.click();
      setTimeout(()=>{URL.revokeObjectURL(url);urls.current.delete(url);},1000);
    }catch{if(!lease.signal.aborted)setMessage(t("下载未完成，完整原文仍保留在原任务。","Download did not finish. The full text remains in the original task."));}
  }
  return <section className="task-output-artifact" aria-label={t(`原始输出 ${artifact.id}`,`Raw output ${artifact.id}`)}>
    <div className="task-output-artifact-heading"><strong>{t("完整原始输出","Full raw output")}</strong><span>{t(`${artifact.bytes.toLocaleString()} 字节`,`${artifact.bytes.toLocaleString()} bytes`)}</span></div>
    <details><summary>{t("核对文件信息","Verify file details")}</summary><dl><dt>{t("记录","Record")}</dt><dd>{artifact.id}</dd><dt>{t("保存时间","Saved at")}</dt><dd>{artifact.createdAt}</dd><dt>SHA-256</dt><dd>{artifact.hash}</dd></dl></details>
    <div className="task-output-artifact-actions">
      {!value&&<button type="button" disabled={busy||invalid} onClick={()=>void read()}>{busy?t("正在读取并校验…","Reading and verifying…"):t("读取完整原文","Read full text")}</button>}
      {(busy||value)&&<button type="button" onClick={close}>{busy?t("取消读取","Cancel reading"):t("收起并清除本页全文","Collapse and clear full text from this page")}</button>}
      {value&&<><button type="button" onClick={()=>void copy()}>{t("复制完整原文","Copy full text")}</button><button type="button" onClick={download}>{t("下载完整原文","Download full text")}</button></>}
    </div>
    {message&&<p role="status">{message}</p>}
    {value&&<><p className="task-output-artifact-note">{t("字节数与 SHA-256 已核实。以下是原始模型输出，不代表完整结果或已采用内容。","Byte count and SHA-256 are verified. The following is raw model output, not a complete result or adopted content.")}</p><pre tabIndex={0} aria-label={t("完整原始输出正文","Full raw output body")}>{value.text}</pre></>}
  </section>;
}

/** Same reader for the shared root ledger and task-local recovery views. */
export function TaskOutputArtifacts({task,client=defaultTaskOutputClient}:{task:TaskOutputSource;client?:Client}){
  if(!task.outputArtifacts?.length)return null;
  return <div className="task-output-artifacts">{task.outputArtifacts.map(artifact=><Output key={`${task.ownerId}:${task.id}:${artifact.id}:${artifact.hash}:${artifact.bytes}`} task={task} artifact={artifact} client={client}/>)}</div>;
}
