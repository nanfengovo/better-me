/** Manual Chromium/Electron fixture: private temporary accounts, random ports,
 * a scripted model recovering on turn two, and the real QuickJS verifier. */
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemorySaver } from "@langchain/langgraph";
import { createAgentServer } from "../src/server.js";
const root=await realpath(fileURLToPath(new URL("../../web/dist/",import.meta.url)));
const scratch=await mkdtemp(path.join(os.tmpdir(),"betterme-coding-browser-"));
let hostPort=0,origin="";
const types:Record<string,string>={".html":"text/html",".js":"application/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".webp":"image/webp",".json":"application/json",".woff2":"font/woff2"};
const web=http.createServer(async(req,res)=>{
  const {pathname}=new URL(req.url??"/","http://fixture.invalid");
  if (/^\/api\/v1\/agent\/(?:identity\/|sandbox\/coding\/|health$)/.test(pathname)){
    const proxy=http.request({hostname:"127.0.0.1",port:hostPort,path:req.url,method:req.method,headers:{...req.headers,origin,host:`127.0.0.1:${hostPort}`}},
      upstream=>{res.writeHead(upstream.statusCode??502,upstream.headers);upstream.pipe(res);});
    proxy.on("error",()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(proxy);return;
  }
  if (pathname.startsWith("/api/") || req.method!=="GET") {res.writeHead(404);return res.end();}
  try {
    const file=await realpath(path.join(root,pathname==="/"? "index.html":decodeURIComponent(pathname)));
    if(!file.startsWith(root+path.sep))throw Error("outside fixture");
    const data=await readFile(file);res.writeHead(200,{"Content-Type":types[path.extname(file)]??"application/octet-stream","Cache-Control":"no-store"});res.end(data);
  } catch {res.writeHead(404);res.end();}
});
web.listen(0,"127.0.0.1");await once(web,"listening");const address=web.address();if(!address||typeof address==="string")throw Error("no web address");
origin=`http://127.0.0.1:${address.port}`;
const host=createAgentServer({host:"127.0.0.1",port:0,authToken:"better-me-agent-token",allowedOrigins:[origin],checkpointer:new MemorySaver() as never,
  identityDirectory:path.join(scratch,"accounts"),runsDirectory:path.join(scratch,"runs"),runtimeDefinitions:[],
  sandboxCoding:{resolveModel:async()=>"f".repeat(64),generate:async({previousSource})=>previousSource
    ? "function(input){return Math.abs(input.value)}":"function(input){return input.value}"}});
await once(host,"listening");const addr=host.address();if(!addr||typeof addr==="string") throw Error("no host address");hostPort=addr.port;
console.log(JSON.stringify({web:origin+"/?workspace=autopilot",host:`http://127.0.0.1:${hostPort}`,fixture:"abs-of-value; no real inference"}));
let closing=false;const close=async()=>{if(closing)return;closing=true;
  await Promise.all([web,host].map(s=>new Promise<void>(resolve=>{s.close(()=>resolve());s.closeAllConnections();})));
  await rm(scratch,{recursive:true,force:true});
};
process.once("SIGINT",()=>void close());process.once("SIGTERM",()=>void close());
