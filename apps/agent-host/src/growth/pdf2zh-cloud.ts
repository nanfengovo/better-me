import { z } from "zod";
import { PDF_CLOUD_ORIGIN, PdfCloudModelName, pdfCloudModel, TRANSLATION_LIMITS } from "@better-me/agent-contracts";
import { readBoundedJson } from "../privacy/http-cloud.js";
import { disclosureViolations } from "../privacy/content-guard.js";

const responseShape=z.object({model:z.string(),choices:z.array(z.object({index:z.literal(0),finish_reason:z.literal("stop"),
  message:z.object({role:z.literal("assistant"),content:z.string().trim().min(1),tool_calls:z.never().optional(),function_call:z.never().optional()})})).length(1)});

/** One reservation → one POST. The PDF library only ever knows its disposable loopback token. */
export async function sendPdfCloudText(input:{prompt:string;key:string;model:{name:string;digest:string};signal:AbortSignal},wire:typeof fetch=fetch){
  const name=PdfCloudModelName.safeParse(input.model.name);
  if(!name.success||pdfCloudModel(name.data).digest!==input.model.digest||!input.key||!input.prompt.trim()||
    Buffer.byteLength(input.prompt)>TRANSLATION_LIMITS.inputBytes)throw Error("translation_cloud_binding_invalid");
  if(input.prompt.includes(input.key)||disclosureViolations(input.prompt).some(v=>v==="credential"||v==="private_path"))
    throw Error("translation_cloud_sensitive_text");
  const signal=AbortSignal.any([input.signal,AbortSignal.timeout(120_000)]);signal.throwIfAborted();
  try{
    const res=await wire(PDF_CLOUD_ORIGIN+"/chat/completions",{method:"POST",redirect:"error",signal,
      headers:{Authorization:"Bearer "+input.key,"Content-Type":"application/json"},
      body:JSON.stringify({model:name.data,messages:[{role:"user",content:input.prompt}],stream:false,
        thinking:{type:"disabled"},temperature:0,max_tokens:4096})});
    const parsed=responseShape.safeParse(await readBoundedJson(res,128_000,signal));
    if(!parsed.success || parsed.data.model!==name.data)throw Error();
    const text=parsed.data.choices[0]!.message.content;
    if(text.includes(input.key)||Buffer.byteLength(text)>TRANSLATION_LIMITS.outputBytes)throw Error();
    signal.throwIfAborted();return text;
  }catch{throw Error("translation_cloud_request_failed");} // never return provider bodies, prompts, keys or SDK debug details
}
