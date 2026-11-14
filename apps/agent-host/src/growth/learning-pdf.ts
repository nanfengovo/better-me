import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { z } from "zod";
import { LearningPageSchema } from "@better-me/agent-contracts";
import { learningFail } from "./learning-store.js";

// Trusted parser code only, not a general-purpose executor. A worker bounds V8
// heap and wall time; it is NOT an OS security sandbox. No user URLs are fetched.
const PARSER = String.raw`
const {parentPort,workerData:d}=require('node:worker_threads');
const {createHash}=require('node:crypto');
const hash=text=>createHash('sha256').update(text).digest('hex');
(async()=>{
  const pdfjs=await import(d.engine);
  const task=pdfjs.getDocument({data:new Uint8Array(d.bytes),useSystemFonts:true,
    stopAtErrors:true,useWorkerFetch:false,cMapUrl:d.cmaps,standardFontDataUrl:d.fonts});
  try {
    const pdf=await task.promise;
    if(pdf.numPages>60)throw Error('learning_pdf_page_limit');
    const pages=[]; let total=0;
    for(let number=1;number<=pdf.numPages;number++){
      const page=await pdf.getPage(number),viewport=page.getViewport({scale:1});
      try {
        const content=await page.getTextContent();
        if(content.items.length>10000)throw Error('learning_pdf_text_limit');
        const items=content.items.filter(item=>'str' in item&&item.str.trim()).map(item=>({
          text:item.str,x:item.transform[4],y:item.transform[5],width:Math.abs(item.width),height:Math.max(1,item.height),
          bottom:item.transform[5]-Math.max(1,item.height)*0.2,top:item.transform[5]+Math.max(1,item.height)*0.8}));
        items.sort((a,b)=>Math.abs(a.y-b.y)>3?b.y-a.y:a.x-b.x);
        const groups=[];const columnRows=new Set();
        for(const item of items){
          const previous=groups.at(-1),sameLine=previous&&Math.abs(previous.y-item.y)<3;
          if(sameLine&&item.x-(previous.x+previous.width)>60)columnRows.add(Math.round(item.y/4));
          if(previous&&(sameLine&&item.x-(previous.x+previous.width)<40||Math.abs(previous.x-item.x)<12&&previous.y-item.y>0&&previous.y-item.y<item.height*1.8)){
            previous.text+=(sameLine?' ':'\n')+item.text;
            previous.width=Math.max(previous.width,item.x+item.width-previous.x);
            previous.bottom=Math.min(previous.bottom,item.bottom);previous.top=Math.max(previous.top,item.top);
            previous.y=item.y;
          }else groups.push({...item});
        }
        const count=groups.reduce((n,g)=>n+g.text.replace(/\s/g,'').length,0); total+=count;
        if(groups.length>300||groups.some(g=>g.text.length>16000)||total>200000)throw Error('learning_pdf_text_limit');
        pages.push({number,width:viewport.width,height:viewport.height,coordinateSystem:'pdf_points_bottom_left',
          status:count<30?'needs_recognition':columnRows.size>=2?'needs_review':'text',
          ...(count<30?{issue:'本页可提取文字不足，需要识别或人工校对。'}:columnRows.size>=2?{issue:'检测到可能的多栏顺序，请先校对。'}:{}),
          blocks:groups.map((g,index)=>({id:'b'+(index+1),text:g.text,hash:hash(g.text),box:[g.x,g.bottom,g.width,g.top-g.bottom]}))});
      } catch(error){
        if(error.message.startsWith('learning_'))throw error;
        pages.push({number,width:viewport.width,height:viewport.height,coordinateSystem:'pdf_points_bottom_left',status:'needs_recognition',blocks:[],issue:'本页文字提取失败，需要识别。'});
      } finally {page.cleanup();}
    }
    parentPort.postMessage({ok:true,pages});
  } finally {await task.destroy();}
})().catch(error=>parentPort.postMessage({ok:false,code:['learning_pdf_page_limit','learning_pdf_text_limit'].includes(error.message)?error.message:'learning_pdf_unreadable'}));
`;

export async function extractLearningPdf(bytes: Uint8Array) {
  const require = createRequire(import.meta.url),
    assets = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const pages = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(PARSER, {
      eval: true,
      env: {},
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
      workerData: {
        bytes,
        engine: pathToFileURL(
          require.resolve("pdfjs-dist/legacy/build/pdf.mjs"),
        ).href,
        cmaps: path.join(assets, "cmaps") + path.sep,
        fonts: path.join(assets, "standard_fonts") + path.sep,
      },
    });
    let settled = false;
    const finish = (error?: string, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker
        .terminate()
        .then(() => (error ? reject(new Error(error)) : resolve(value)));
    };
    const timer = setTimeout(
      () => finish("learning_pdf_resource_limit"),
      20_000,
    );
    worker.once("error", () => finish("learning_pdf_resource_limit"));
    worker.once("exit", () => {
      if (!settled) finish("learning_pdf_unreadable");
    });
    worker.once(
      "message",
      (message: { ok?: boolean; code?: string; pages?: unknown }) => {
        if (!message.ok)
          return finish(message.code ?? "learning_pdf_unreadable");
        try {
          finish(
            undefined,
            z.array(LearningPageSchema).min(1).max(60).parse(message.pages),
          );
        } catch {
          finish("learning_pdf_unreadable");
        }
      },
    );
  }).catch((error) =>
    learningFail(error.message, /limit$/.test(error.message) ? 413 : 422),
  );
  return z.array(LearningPageSchema).min(1).max(60).parse(pages);
}
