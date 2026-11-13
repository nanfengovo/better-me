import {useEffect,useRef,useState} from "react";
import {z} from "zod";
import {careerRuntimeBinding,type MockInterviewTask} from "@better-me/agent-contracts";
import type {LlmConfig,ProjectedResume} from "@better-me/core";
import {isInterviewSelectionCurrent,type InterviewSelection} from "../lib/mock-interview-launch";
import {useWorkspaceRecovery} from "../lib/use-workspace-recovery";
import {useAgentRouting} from "../lib/agent-routing";
import {useAgentTaskRuntime} from "../lib/agent-task-runtime";
import {defaultMockInterviewTaskClient,type MockInterviewTaskClient,type InterviewTaskParams} from "../services/mock-interview-task-client";
import {taskIssueText} from "../services/agent-task-transport";
import {WorkspaceRecoveryNotice} from "./WorkspaceRecoveryNotice";
import {AgentMarkdownRenderer} from "./AgentMarkdownRenderer";
import {TaskOutputArtifacts} from "./TaskOutputArtifacts";
import "./mock-interview.css";

const RecoverySchema=z.object({taskId:z.string().optional(),draft:z.string(),pending:z.object({id:z.string(),content:z.string(),revision:z.number()}).optional()}).strict();
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export type MockInterviewPanelProps={workspaceKey:string;selection:InterviewSelection;resume:ProjectedResume|null;llmConfig:LlmConfig;
  onClose:()=>void;onOpenConfig:()=>void;blockingError?:string;client?:MockInterviewTaskClient};

/** One focused child session inside AgentWorkspace; its draft has a separate
 * owner/workspace/selection journal, and restoring it never restores consent. */
export function MockInterviewPanel({workspaceKey,selection,resume,llmConfig,onClose,onOpenConfig,blockingError,client=defaultMockInterviewTaskClient}:MockInterviewPanelProps){
  const recovery=useWorkspaceRecovery(`interview:${workspaceKey}:${selection.id}`,RecoverySchema,()=>({draft:""}));
  const routing=useAgentRouting(),controller=useRef<AbortController|null>(null),mounted=useRef(true);
  const [task,setTask]=useState<MockInterviewTask>(),[busy,setBusy]=useState(false),[reading,setReading]=useState(true),[error,setError]=useState(""),[consent,setConsent]=useState(false);
  const sourceCurrent=isInterviewSelectionCurrent(selection,resume);
  const taskRuntime=useAgentTaskRuntime(llmConfig);
  const {runtime,preferredRuntimeId}=taskRuntime;
  const runtimeCurrent=!task||same(task.runtimeBinding,careerRuntimeBinding(runtime,preferredRuntimeId));
  const valid=!taskRuntime.error&&sourceCurrent&&runtimeCurrent&&!recovery.error&&!blockingError;
  const bindingKey=JSON.stringify(careerRuntimeBinding(runtime,preferredRuntimeId));
  useEffect(()=>setConsent(false),[bindingKey,sourceCurrent]);
  const params:InterviewTaskParams={workspaceKey,rootScopeKey:workspaceKey,matching:selection.matching,focus:selection.focus,runtime,preferredRuntimeId};
  const accept=(next:MockInterviewTask)=>{
    if(!mounted.current)return;
    if(!same(next.matching,selection.matching)||!same(next.interview.focus,selection.focus)||next.rootScopeKey!==workspaceKey)throw new Error("对练回执不属于当前资料或工作区，未采用。");
    setTask(next);
    recovery.set(previous=>{
      const answered=previous.pending&&next.conversation.messages.some(message=>message.id===previous.pending!.id&&message.role==="user"&&message.content===previous.pending!.content);
      return {...previous,taskId:next.id,...(answered?{draft:previous.draft===previous.pending!.content?"":previous.draft,pending:undefined}:{})};
    });
  };
  const readSession=async(signal:AbortSignal)=>{
    const existing=recovery.value.taskId?await client.get(recovery.value.taskId,signal):await client.find({...params,signal});
    if(existing){accept(existing);setReading(false);if(existing.status==="running")await client.observe(existing.id,{signal,onTask:accept});}
  };
  useEffect(()=>{
    mounted.current=true;const observer=new AbortController();controller.current=observer;
    void readSession(observer.signal).catch(failure=>{if(!observer.signal.aborted)setError(failure instanceof Error?failure.message:"无法读取对练记录。");}).finally(()=>{if(!observer.signal.aborted)setReading(false);});
    return ()=>{mounted.current=false;observer.abort();controller.current?.abort();};
    // This mounted session captures its frozen selection. Config/source changes
    // invalidate the explicit controls, never start another effect/request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[client,selection.id,workspaceKey]);
  const run=async(action:"start"|"answer"|"finish"|"resume"|"read"|"pause")=>{
    if((busy&&action!=="pause")||reading)return;
    if(action!=="read"&&action!=="pause"&&(!valid||!consent))return;
    controller.current?.abort();const request=new AbortController();controller.current=request;setBusy(true);setError("");
    try{
      if(action==="read"){await readSession(request.signal);return;}
      if(action==="pause"){if(task)accept(await client.pause(task.id));return;}
      taskRuntime.assertSelected();
      const input={...params,signal:request.signal,onTask:accept};let result:MockInterviewTask;
      if(action==="start")result=await client.start({...input,consent:true});
      else{
        if(!task)throw new Error("请先读取原会话。");
        if(action==="answer"){
          const pending=recovery.value.pending;
          if(pending&&(pending.revision!==task.revision||pending.content!==recovery.value.draft))throw new Error("上一条回答的结果尚待核对。请先读取现有会话；草稿没有重发到新的问题。");
          const answer=pending??{id:crypto.randomUUID(),content:recovery.value.draft,revision:task.revision};
          recovery.set(previous=>({...previous,pending:answer}));
          result=await client.answer(task,input,answer.content,answer.id);
        }else if(action==="finish")result=await client.finish(task,input);
        else result=await client.resume(task,input);
      }
      if(!request.signal.aborted){taskRuntime.assertSelected();accept(result);}
    }catch(failure){if(!request.signal.aborted)setError(failure instanceof Error?failure.message:"操作未完成；原会话与草稿保留。");}
    finally{if(!request.signal.aborted&&mounted.current)setBusy(false);}
  };
  const unavailable=busy||reading||!valid||!consent;
  const pendingNeedsReview=Boolean(recovery.value.pending&&task&&(recovery.value.pending.revision!==task.revision||recovery.value.pending.content!==recovery.value.draft));
  const download=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({selection,task,draft:recovery.value.draft,pending:recovery.value.pending},null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="BetterMe-面试攻防评估记录.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  return <section className="mock-interview" aria-label="面试对练子会话">
    <header><div><h2>技术面试对练</h2><p>{selection.focus.gapItem}</p></div><button type="button" onClick={onClose}>返回顾问</button></header>
    <WorkspaceRecoveryNotice {...recovery}/>
    <div className="mock-interview-scroll">
      <blockquote>{selection.focus.question}</blockquote>
      <details><summary>本次资料与提问背景</summary><h3>岗位原文</h3><pre>{selection.matching.rawJd}</pre><h3>简历自述</h3>{Object.entries(selection.matching.sessionClaims).map(([id,text])=><div key={id}><small>{id}</small><pre>{text}</pre></div>)}<h3>提问要点（不是本人事实）</h3>{selection.focus.corePoints.map((point,index)=><p key={index}>{point}</p>)}</details>
      {!sourceCurrent&&<p role="alert">当前简历资料已变化。原会话和草稿保留，未发送旧资料；请返回攻防点重新核对。</p>}
      {!runtimeCurrent&&<p role="alert">原根任务固定了另一底座，未换模型或重置预算。请在模型设置中核对。</p>}
      {routing?.blocked&&<p role="alert">底座状态尚未确认，未使用旧配置补发。</p>}
      {!routing?.blocked&&taskRuntime.error&&<p role="alert">{taskRuntime.error}</p>}
      {blockingError&&<p role="alert">{blockingError}</p>}
      {error&&<p role="alert">{error}</p>}
      {task?.error&&<p role="alert">{taskIssueText[task.error]??`任务已停止（${task.error}）；原记录保留，没有自动重试或切换模型。`}</p>}
      <p role="status">{reading?"正在只读恢复会话…":busy?"任务处理中，完整记录由本机宿主保留。":task?`会话状态：${task.status} · 根累计 ${task.rootLedger?.usage.modelCalls??task.usage.modelCalls} 次模型调用`:"尚未开始。授权后创建 JD 父任务和对练子会话，不额外运行岗位分析。"}</p>
      {task&&<><details><summary>任务关系与完整证据</summary><p>任务 {task.id}</p><p>JD父任务 {task.parentTaskId}</p><p>共享根 {task.rootTaskId??task.id}</p>{task.evidence.map(item=><pre key={item.id}>{JSON.stringify(item,null,2)}</pre>)}</details>
        <div className="mock-interview-thread" aria-label="完整对练记录">{task.conversation.messages.map((message,index)=>message.role==="assistant"&&index===task.conversation.messages.length-1&&task.interview.receipt?<section key={message.id} aria-label="面试攻防评估回执"><AgentMarkdownRenderer content={message.content}/></section>:<article key={message.id} data-role={message.role}><strong>{message.role==="user"?"我的回答":"面试官"}</strong><AgentMarkdownRenderer content={message.content}/></article>)}</div>
        {task.partialOutput&&<details><summary>未完成的模型原始输出</summary><pre>{task.partialOutput.text}</pre></details>}
        <TaskOutputArtifacts task={task}/>
      </>}
    </div>
    <footer>
      <div className="mock-interview-actions"><button type="button" onClick={()=>void run("read")} disabled={busy||reading}>读取现有会话</button><button type="button" onClick={download}>下载完整记录</button><button type="button" onClick={onOpenConfig}>模型设置</button>{task?.status==="running"&&<button type="button" onClick={()=>void run("pause")} disabled={reading}>暂停任务</button>}</div>
      {pendingNeedsReview&&<div role="alert"><p>上一条回答与当前问题或草稿不再一致；未自动重发。请先读取会话，核对后再将草稿用于当前问题。</p><button type="button" disabled={busy||reading||!sourceCurrent} onClick={()=>{recovery.field("pending",undefined);setConsent(false);}}>已核对当前问题，重新编辑草稿</button></div>}
      {task?.status!=="completed"&&<><label className="mock-interview-consent"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} disabled={busy||reading}/>授权本次 JD、简历自述与作答，使用当前底座；沿用工作区根额度，不自动写入简历或事实库。</label>
        {(!task||task.status==="ready")&&<button type="button" disabled={unavailable} onClick={()=>void run("start")}>授权并开始对练</button>}
        {task?.status==="awaiting_answer"&&<><label htmlFor={`interview-answer-${selection.id}`}>我的回答</label><textarea id={`interview-answer-${selection.id}`} value={recovery.value.draft} onChange={event=>recovery.field("draft",event.target.value)} disabled={busy} placeholder="只描述真实经历；不确定或没有做过的内容可以直接说明。"/><div className="mock-interview-actions"><button type="button" disabled={unavailable||pendingNeedsReview||!recovery.value.draft.trim()} onClick={()=>void run("answer")}>提交回答并追问</button><button type="button" disabled={unavailable||Boolean(recovery.value.draft)||Boolean(recovery.value.pending)} onClick={()=>void run("finish")}>结束演练并生成回执</button></div>{recovery.value.draft&&<small>结束前请先提交或自行清空草稿；不会丢弃回答。</small>}</>}
        {task&&["paused","interrupted"].includes(task.status)&&<button type="button" disabled={unavailable} onClick={()=>void run("resume")}>核对后手动继续</button>}
      </>}
    </footer>
  </section>;
}
