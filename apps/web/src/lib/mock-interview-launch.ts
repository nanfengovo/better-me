import {z} from "zod";
import {JdMatchMaterialSchema,MockInterviewFocusSchema} from "@better-me/agent-contracts";
import {captureIdentityLease} from "./identity";
import type {ProjectedResume} from "@better-me/core";
import {jdMatchResumeMaterial} from "../services/jd-match-task-client";

export const InterviewSelectionSchema=z.object({id:z.string().regex(/^[a-f0-9]{64}$/),matching:JdMatchMaterialSchema,focus:MockInterviewFocusSchema}).strict();
export type InterviewSelection=z.infer<typeof InterviewSelectionSchema>;
export const InterviewWorkspaceStateSchema=z.object({selection:InterviewSelectionSchema.optional(),open:z.boolean()}).strict().refine(value=>!value.open||Boolean(value.selection));
export const InterviewLaunchSchema=z.object({workspaceKey:z.string().min(1),selection:InterviewSelectionSchema}).strict();
export const interviewLaunchEvent="betterme:mock-interview";
export function isInterviewSelectionCurrent(selection:InterviewSelection,resume:ProjectedResume|null){
  try{const material=jdMatchResumeMaterial(resume);return JSON.stringify(material.sessionClaims)===JSON.stringify(selection.matching.sessionClaims)&&JSON.stringify(material.allowedProfileEntryIds)===JSON.stringify(selection.matching.allowedProfileEntryIds);}catch{return false;}
}
export async function createInterviewSelection(input:Omit<InterviewSelection,"id">):Promise<InterviewSelection>{
  const lease=captureIdentityLease();lease.assert();
  const material={matching:JdMatchMaterialSchema.parse(input.matching),focus:MockInterviewFocusSchema.parse(input.focus)};
  const id=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(material)))),byte=>byte.toString(16).padStart(2,"0")).join("");
  lease.assert();return {...material,id};
}
/** Local navigation only, never a model request or a data-sharing grant. */
export function requestMockInterview(workspaceKey:string,selection:InterviewSelection){
  const event=new CustomEvent(interviewLaunchEvent,{detail:InterviewLaunchSchema.parse({workspaceKey,selection}),cancelable:true});
  window.dispatchEvent(event);return event.defaultPrevented;
}
