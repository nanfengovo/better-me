import {bindResumeProposalSources,type sendAgentChat,type ChatMessage} from "../../src/services/agent-client";

/** Widget-only seam: supplied replies, no Host or model. Task transport is tested separately against the real kernel/HTTP. */
export const widgetChat:typeof sendAgentChat=async params=>{
  const response=await fetch("http://ui-fixture.invalid/ui-chat-fixture",{method:"POST",signal:params.signal,body:JSON.stringify({messages:params.messages,context:params.context,modelSettings:params.llmConfig})});
  params.signal?.throwIfAborted();
  const value=await response.json() as {reply?:ChatMessage;message?:ChatMessage};
  const reply=value.reply??value.message;
  if(!reply)throw new Error("UI fixture did not supply a reply");
  return bindResumeProposalSources(reply,params.context?.resumeEditContext);
};
