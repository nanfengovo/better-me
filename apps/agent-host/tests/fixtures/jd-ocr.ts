import { createHash } from "node:crypto";
import { careerRuntimeBinding, type JdOcrImage, type JdOcrTask, type JdOcrTaskCreate } from "@better-me/agent-contracts";

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=","base64");
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
/** Valid synthetic 1px PNG with inert trailing fixture bytes; never a quality benchmark. */
export function ocrImage(index:number,size=png.length+1){
  const bytes=Buffer.alloc(size,index);png.copy(bytes);const dataUrl=`data:image/png;base64,${bytes.toString("base64")}`;
  const image:JdOcrImage={id:`img_${hash(String(index)+dataUrl).slice(0,32)}`,name:`完整合成图片-${index}.png`,mimeType:"image/png",byteLength:bytes.length,hash:hash(dataUrl)};
  return {image,dataUrl};
}
export const ocrBinding=careerRuntimeBinding({kind:"model",modelSettings:{provider:"ollama",model:"synthetic-vision",baseUrl:"http://127.0.0.1:1/v1"}});
export const ocrText=" \r\n合成工业岗位截图全文：C# / .NET 工业软件工程师。\r\n职责：保留原始接口和项目边界，不虚构任职事实。\n薪资与地点未知。  \r\n";
export const ocrInput=(images:JdOcrImage[],key="synthetic-ocr-task"):JdOcrTaskCreate=>({kind:"jd_ocr",workspaceKey:"synthetic-ocr",rootScopeKey:"synthetic-ocr-scope",objective:"完整截图文字识别，待本人审阅",request:{images},runtimeBinding:ocrBinding,consent:true,idempotencyKey:key});
export const ocrCommand=(task:JdOcrTask)=>({expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,runtimeBinding:task.runtimeBinding,consent:true as const});
export const ocrUpload=(task:JdOcrTask,dataUrl:string)=>({expectedRevision:task.revision,sourceFingerprint:task.sourceFingerprint,consent:true as const,dataUrl});
