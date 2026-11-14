import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPdf2zhEngine } from "../src/growth/pdf2zh-engine.js";
import type { TranslationCreate } from "@better-me/agent-contracts";

// This executable only imitates the pinned Python bridge protocol. It does not
// load PDF2zh, verify real assets or produce a translation-quality result.
const interpreter = String.raw`
const fs=require("node:fs"),http=require("node:http"),{spawn}=require("node:child_process");
if(process.argv.length===7){console.log(JSON.stringify({python:[3,13],pdf2zh:"2.10.2",babeldoc:"0.7.1",assetsValid:true}));process.exit(0);}
let raw="",grandchild;process.stdin.on("data",chunk=>raw+=chunk);process.stdin.on("end",async()=>{
  try{
    const args=JSON.parse(raw),cached=process.cwd()+"/private-home/.cache/babeldoc/fonts/mode.json",
      mode=JSON.parse(fs.readFileSync(cached,"utf8")).mode;
    process.on("SIGTERM",()=>{});
    grandchild=mode==="cancel"?spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",env:{}}):undefined;
    const info={cwd:process.cwd(),pid:process.pid,grandchild:grandchild?.pid,leakedEnv:Object.hasOwn(process.env,"BETTERME_FIXTURE_PRIVATE_SENTINEL"),cachedLinks:fs.statSync(cached).nlink};
    fs.appendFileSync(cached,"\nprivate-copy-only");
    const body=JSON.stringify({model:"betterme-local",messages:[{role:"user",content:JSON.stringify(info)}],stream:false});
    const send=(authorization="Bearer "+args.token,origin)=>new Promise((resolve,reject)=>{
      const request=http.request({host:"127.0.0.1",port:args.port,path:"/v1/chat/completions",method:"POST",headers:{authorization,"Content-Type":"application/json",...(origin?{origin}:{})}},response=>{
        let raw="";response.on("data",chunk=>raw+=chunk);response.on("end",()=>resolve({status:response.statusCode,body:raw}));
      });request.on("error",reject);request.end(body);
    });
    if((await send("Bearer not-the-capability")).status!==403)throw Error("invalid authorization admitted");
    if((await send(undefined,"https://invalid.example")).status!==403)throw Error("browser origin admitted");
    const first=send();await new Promise(resolve=>setTimeout(resolve,60));
    const second=await send(),third=await send(),firstResult=await first;
    if(second.status!==403||third.status!==403||firstResult.status!==200)throw Error("concurrent request admitted");
    if(mode==="cancel"){
      console.log("BETTERME_PDF_EVENT "+JSON.stringify({type:"progress",stage:"typesetting",percent:30}));
      setInterval(()=>{},1000);return;
    }
    fs.copyFileSync("source.pdf","mono.pdf");
    console.log("BETTERME_PDF_EVENT "+JSON.stringify({type:"progress",stage:"typesetting",percent:90}));
    console.log("BETTERME_PDF_EVENT "+JSON.stringify({type:"finish"}));
  }catch{grandchild?.kill("SIGKILL");process.exit(1);}
});
`;

async function fixture(
  context: { mock: typeof import("node:test").mock },
  mode: "success" | "cancel",
) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "betterme-native-protocol-test-"),
  );
  const assets = path.join(directory, "assets"),
    python = path.join(directory, "python-protocol-fixture");
  await fs.mkdir(path.join(assets, "fonts"), { recursive: true });
  await fs.writeFile(
    path.join(assets, "fonts/mode.json"),
    JSON.stringify({ mode }),
  );
  await fs.writeFile(python, `#!${process.execPath}\n${interpreter}`, {
    mode: 0o700,
  });
  let generations = 0;
  context.mock.method(
    globalThis,
    "fetch",
    async (value: string | URL | Request) => {
      const url = String(value);
      assert.ok(
        url.startsWith("http://127.0.0.1:11434/"),
        "no external request in this fixture",
      );
      if (url.endsWith("/api/version"))
        return Response.json({ version: "0.40.15" });
      if (url.endsWith("/api/tags"))
        return Response.json({
          models: [
            { name: "synthetic-native-local", digest: "f".repeat(64) },
            {
              name: "synthetic:cloud",
              digest: "e".repeat(64),
              remote_host: "remote.invalid",
            },
          ],
        });
      assert.ok(url.endsWith("/api/generate"));
      generations++;
      return Response.json({
        response: "protocol fixture only",
        done: true,
        done_reason: "stop",
        model: "synthetic-native-local",
      });
    },
  );
  const engine = createPdf2zhEngine({ python, assets });
  assert.ok(engine);
  const backend = await engine.backend();
  assert.equal(backend.ready, true, backend.reason);
  assert.deepEqual(
    backend.models.map((item) => item.name),
    ["synthetic-native-local"],
  );
  const request: TranslationCreate = {
    requestId: "native-protocol-fixture",
    consent: true,
    materialId: "source-fixture",
    materialHash: "a".repeat(64),
    materialRevision: 1,
    backendId: backend.id,
    model: backend.models[0],
    sourceLanguage: "zh",
    targetLanguage: "en",
    bilingual: false,
    glossary: [],
  };
  const source = new Uint8Array(
    await fs.readFile(
      new URL("./fixtures/learning/checkpoint-notes-v1.pdf", import.meta.url),
    ),
  );
  return { directory, engine, request, source, generations: () => generations };
}

type ChildInfo = {
  cwd: string;
  pid: number;
  grandchild?: number;
  leakedEnv: boolean;
  cachedLinks: number;
};
function childInfo(prompt: string): ChildInfo {
  const message = prompt.split("### Converter user message\n")[1]?.split("\n\n### Critical output requirements")[0];
  assert.ok(message);
  return JSON.parse(message);
}

test(
  "native adapter proxy admits one capability-scoped request, bounds concurrency and removes its private files",
  { skip: process.platform === "win32" },
  async (context) => {
    const data = await fixture(context, "success");
    let child: ChildInfo | undefined,
      reservations = 0;
    process.env.BETTERME_FIXTURE_PRIVATE_SENTINEL = "synthetic-test-only";
    try {
      const result = await data.engine.run({
        request: data.request,
        source: data.source,
        signal: AbortSignal.timeout(6000),
        progress: async () => {},
        modelCall: async (prompt, complete) => {
          reservations++;
          child = childInfo(prompt);
          await delay(400);
          return complete(new AbortController().signal);
        },
      });
      assert.deepEqual(result.mono, data.source); // Protocol bytes, NOT a translation.
      assert.equal(reservations, 1);
      assert.equal(data.generations(), 1);
      assert.ok(child);
      assert.equal(child.leakedEnv, false);
      assert.equal(child.cachedLinks, 1, "private asset copies must not be shared hardlinks");
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(data.directory, "assets/fonts/mode.json"), "utf8")), { mode: "success" });
      assert.ok(path.basename(child.cwd).startsWith("betterme-pdf2zh-job-"));
      await assert.rejects(fs.stat(child.cwd), { code: "ENOENT" });
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
    } finally {
      delete process.env.BETTERME_FIXTURE_PRIVATE_SENTINEL;
      context.mock.restoreAll();
      await fs.rm(data.directory, { recursive: true, force: true });
    }
  },
);

test(
  "native asset admission accommodates the pinned upstream fallback fonts but still has a finite byte ceiling",
  { skip: process.platform === "win32" },
  async (context) => {
    const data = await fixture(context, "success");
    const filename = path.join(data.directory, "assets/fonts/sparse-budget-fixture");
    try {
      // BabelDOC 0.7.1 adds all families to EN: fonts alone are 265,807,784
      // bytes, before CMaps/model/tokenizer. Sparse files test the real walk
      // without allocating hundreds of MB or pretending to verify real assets.
      const file = await fs.open(filename, "wx");
      try { await file.truncate(350 * 1024 * 1024); } finally { await file.close(); }
      assert.equal((await data.engine.backend()).ready, true);
      await fs.truncate(filename, 512 * 1024 * 1024 + 1);
      const rejected = await data.engine.backend();
      assert.equal(rejected.ready, false);
      assert.equal(rejected.reason, "translation_asset_limit");
      assert.equal(data.generations(), 0);
    } finally {
      context.mock.restoreAll();
      await fs.rm(data.directory, { recursive: true, force: true });
    }
  },
);

test(
  "native cancellation waits for the owned POSIX process group to exit before cleaning its directory",
  { skip: process.platform === "win32" },
  async (context) => {
    const data = await fixture(context, "cancel"),
      abort = new AbortController();
    let child: ChildInfo | undefined;
    try {
      await assert.rejects(
        data.engine.run({
          request: data.request,
          source: data.source,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(6000)]),
          progress: async (_stage, percent) => {
            if (percent === 30) abort.abort();
          },
          modelCall: async (prompt, complete) => {
            child = childInfo(prompt);
            await delay(400);
            return complete(abort.signal);
          },
        }),
      );
      assert.ok(child?.grandchild);
      for (const pid of [child.pid, child.grandchild])
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await assert.rejects(fs.stat(child.cwd), { code: "ENOENT" });
      assert.equal(data.generations(), 1);
    } finally {
      context.mock.restoreAll();
      await fs.rm(data.directory, { recursive: true, force: true });
    }
  },
);
