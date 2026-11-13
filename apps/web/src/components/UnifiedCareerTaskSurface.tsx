import { useCallback, useState } from "react";
import type { CareerTask } from "@better-me/agent-contracts";
import CareerTaskPanel, {type CareerTaskPanelProps} from "./CareerTaskPanel";
import { AgentSurface, useAgentSidebar } from "./AgentSidebar";

/** One mounted observer/controller outside route and resume-page lifetimes. The Host owns execution. */
export function UnifiedCareerTaskSurface(props:Omit<CareerTaskPanelProps,"job"|"initialObjective"|"onTaskChange">){
  const sidebar=useAgentSidebar(),setTaskState=sidebar?.setTaskState;
  const [pinnedJob,setPinnedJob]=useState<CareerTask["job"]>();
  const observe=useCallback((task:CareerTask|undefined)=>{setTaskState?.(task?{id:task.id,status:task.status}:undefined);setPinnedJob(task?.job);},[setTaskState]);
  return <AgentSurface name="task"><CareerTaskPanel {...props} job={sidebar?.taskRequest?.job??pinnedJob} initialObjective={sidebar?.taskRequest?.objective} initialFocus={sidebar?.taskRequest?.focus} onTaskChange={observe}/></AgentSurface>;
}
