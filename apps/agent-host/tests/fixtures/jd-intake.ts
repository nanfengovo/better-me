import { JdIntakeRequestSchema, type JdIntakeResult } from "@better-me/agent-contracts";
export const METADATA_VALUES={title:"合成接口测试工程师",company:"合成设备企业",salary:"20k-30k",location:"上海浦东"};
export function metadataResult(text:string):JdIntakeResult{
  const quote=(value:string)=>{const start=text.indexOf(value);return start<0?null:{value,start,end:start+value.length};};
  return {kind:"metadata",fields:{title:quote(METADATA_VALUES.title),company:quote(METADATA_VALUES.company),salary:quote(METADATA_VALUES.salary),location:quote(METADATA_VALUES.location)}};
}
export function metadataPromptRequest(prompt:string){
  return JdIntakeRequestSchema.parse(JSON.parse(prompt.split("\n\nUntrusted frozen request JSON:\n")[1]!.split("\n\nHost validation observations (data):\n")[0]!));
}
export const completeMetadataText="  来源正文🚧\r\n"+"只提供合成岗位原文，不认领任何个人经验。\r\n".repeat(200)+"\r\n"+Object.values(METADATA_VALUES).join("\r\n")+"\r\nMETADATA-END  ";
