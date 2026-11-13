import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { JdOcrImageSchema, JD_OCR_DATA_URL_LENGTH, type JdOcrImage } from "@better-me/agent-contracts";
import { privateDirectory, readPrivateJson, writePrivateJson } from "../identity/private-json.js";
import { CareerTaskError, digest } from "../tasks/evidence.js";
import type { TaskImage } from "./model-protocol.js";

const recordSchema=z.object({schema:z.literal(1),ownerId:z.string(),taskId:z.string(),image:JdOcrImageSchema,dataUrl:z.string().max(JD_OCR_DATA_URL_LENGTH)}).strict();
function fail(code:string,status=409):never{throw new CareerTaskError(code,status);}
function validate(image:JdOcrImage,dataUrl:string){
  if(dataUrl.length>JD_OCR_DATA_URL_LENGTH)fail("task_image_bytes_exceeded",413);
  const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if(!match||match[1]!==image.mimeType||match[2]!.length!==Math.ceil(image.byteLength/3)*4)fail("task_image_manifest_mismatch",422);
  const bytes=Buffer.from(match[2]!,"base64");
  if(bytes.length!==image.byteLength||bytes.toString("base64")!==match[2]||digest(dataUrl)!==image.hash)fail("task_image_manifest_mismatch",422);
  const signature=image.mimeType==="image/png"?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):image.mimeType==="image/jpeg"?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.subarray(0,4).toString()==="RIFF"&&bytes.subarray(8,12).toString()==="WEBP";
  if(!signature)fail("task_image_type_mismatch",422);
}

/** Immutable task-owned inputs, not a global upload bucket. Kernel holds its owner writer. */
export class JdOcrImageStore {
  constructor(private directory:string,private ownerId:string){}
  private async file(taskId:string,imageId:string,create=false){
    if(!/^ct_[a-f0-9]{32}$/.test(taskId)||!/^img_[a-f0-9]{32}$/.test(imageId))fail("task_image_not_found",404);
    const parent=path.join(this.directory,"image-inputs"),directory=path.join(parent,taskId);
    for(const location of [parent,directory]){
      if(create)await privateDirectory(location);
      else{const stat=await fs.lstat(location).catch((error:NodeJS.ErrnoException)=>{if(error.code==="ENOENT")fail("task_images_not_ready",422);throw error;});
        if(!stat.isDirectory()||stat.isSymbolicLink()||process.platform!=="win32"&&(stat.mode&0o077)!==0)fail("unsafe_task_image",503);}
    }
    return path.join(directory,`${imageId}.json`);
  }
  private async existing(file:string,taskId:string,image:JdOcrImage){
    const raw=await readPrivateJson(file);if(raw===undefined)return;
    const parsed=recordSchema.safeParse(raw);if(!parsed.success)fail("invalid_private_image",503);
    const record=parsed.data;
    if(record.ownerId!==this.ownerId||record.taskId!==taskId||digest(record.image)!==digest(image))fail("task_image_manifest_mismatch",409);
    validate(image,record.dataUrl);return record.dataUrl;
  }
  async put(taskId:string,image:JdOcrImage,dataUrl:string){
    validate(image,dataUrl);const file=await this.file(taskId,image.id,true),previous=await this.existing(file,taskId,image);
    if(previous!==undefined){if(previous!==dataUrl)fail("task_image_manifest_mismatch");return;}
    await writePrivateJson(file,{schema:1,ownerId:this.ownerId,taskId,image,dataUrl});
  }
  async read(taskId:string,image:JdOcrImage):Promise<TaskImage>{
    const dataUrl=await this.existing(await this.file(taskId,image.id),taskId,image);
    if(dataUrl===undefined)fail("task_images_not_ready",422);
    return {messageId:image.id,name:image.name,mimeType:image.mimeType,dataUrl};
  }
}
