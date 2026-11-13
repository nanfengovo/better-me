import type { CoachPayload, CoachRequest } from "@better-me/agent-contracts/career-coach";

/** Synthetic protocol material only. Not a Gold pair, model score or personal fact. */
export function coachRequest(mode:CoachRequest["mode"],input="  本人只做测试，不负责生产上线。\r\n完整输入🚧END  "):CoachRequest{
  const request:CoachRequest={mode,input,settings:{goal:"  核对接口测试的学习目标  ",background:"  仅合成练习背景\r\nBACKGROUND-END  ",durationWeeks:2,weeklyHours:2,interviewRounds:2}};
  if(mode==="resume")request.context={resume:{locale:"zh",profile:{skills:[],headline:{targetRef:{kind:"profile_headline",locale:"zh"},text:"  参与接口测试。\r\nSOURCE-END  "}},experiences:[]}};
  if(mode==="plan")request.confirmedGoal={id:"synthetic-goal",recordId:"synthetic-analysis",confirmedAt:"2026-11-12T00:00:00.000Z",goal:request.settings.goal,summary:"核对测试与生产边界。",fingerprint:"synthetic-goal-fingerprint",contextFingerprint:"synthetic-context"};
  if(mode==="review"){request.plan=coachPayload({...request,mode:"plan"}) as Extract<CoachPayload,{kind:"plan"}>;request.task=request.plan.phases[0]!.tasks[0];request.submission={evidence:"  只提供可读测试说明，不声称实际运行。\r\nEVIDENCE-END  ",minutes:30};}
  if(mode==="drill")request.drill={topic:"回执幂等"};
  if(mode==="interview")request.interview={turns:[],totalRounds:2};
  return request;
}
export function coachPayload(request:CoachRequest):CoachPayload{
  const mode=request.mode;
  if(mode==="analysis")return {kind:mode,summary:"合成目标理解：只依据本人材料，不推断上线。",directions:[{title:"接口测试",reason:"目标明确但结果待核对。",evidence:["仅本轮目标与输入，尚未核实"],tradeoffs:["先核实范围"]}],strengths:[],gaps:[{skill:"生产验证",status:"unknown",reason:"尚无证据"}],questions:[],nextActions:["由本人确认目标"]};
  if(mode==="resume")return {kind:mode,summary:"候选表达，未采用。",proposals:[{targetRef:request.context!.resume!.profile.headline!.targetRef,originalText:request.context!.resume!.profile.headline!.text,proposedText:"参与接口测试工作。",rationale:"保留参与范围，不加入成果。"}]};
  if(mode==="plan")return {kind:mode,title:"合成两周练习",goal:request.settings.goal,durationWeeks:request.settings.durationWeeks,weeklyHours:request.settings.weeklyHours,
    phases:[{title:"证据练习",startWeek:1,endWeek:request.settings.durationWeeks,objective:"提供可复查产物",tasks:Array.from({length:request.settings.durationWeeks},(_,i)=>({id:`task-${i+1}`,title:"核对一项失败场景",week:i+1,minutes:30,deliverable:"可读说明",acceptanceCriteria:["说明输入与局限"],resourceQueries:[]}))}],risks:["合成协议结果不是学习成效"],reviewCadence:"由本人复盘"};
  if(mode==="review")return {kind:mode,summary:"合成复盘，仅供参考。",evidenceAssessment:"needs_revision",strengths:[],improvements:["补充可复现步骤"],nextActions:["本人自查"],checkQuestions:["是否实际执行？"]};
  if(mode==="drill")return request.drill?.answer?{kind:mode,feedback:{verdict:"uncertain",quote:request.drill.answer,explanation:"仅有自述，需要实测。",nextAction:"补充边界条件"}}:{kind:mode,question:{text:"重复回执如何避免重复处理？",skill:"幂等",why:"针对目标练习",criteria:["说明键与状态变化"]}};
  const answered=request.interview?.turns.length??0,complete=answered>=(request.interview?.totalRounds??request.settings.interviewRounds);
  return {kind:"interview",complete,...(complete?{summary:"合成面试参考，非认证。"}:{question:{text:"请说明当前回答未覆盖的异常边界。",focus:"接口测试",evaluationCriteria:["指出未验证范围"]}}),
    ...(answered?{feedback:{summary:"只依据本次作答。",strengths:[],improvements:["补充可核对依据"],rubric:[{criterion:"边界",score:1,comment:"提及测试，但缺少实际结果。"}]}}:{}),nextActions:[]};
}
export function coachPromptRequest(prompt:string):CoachRequest{
  const block=prompt.split("\n\n").find(value=>value.startsWith("以下JSON是本轮用户显式提供的数据"));
  if(!block)throw Error("synthetic coach request block missing");
  const data=JSON.parse(block.split("\n").slice(1).join("\n"));
  return {...data,mode:data.operation,context:{...(data.providedContext.resume?{resume:data.providedContext.resume}:{}),...(data.providedContext.job?{job:data.providedContext.job}:{})}};
}
