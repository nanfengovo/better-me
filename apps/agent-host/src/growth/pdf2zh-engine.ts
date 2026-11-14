import fs from "node:fs/promises";
import { constants as fileFlags } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import {
  TRANSLATION_LIMITS,
  PDF_CLOUD_BACKEND,PDF_CLOUD_ORIGIN,PdfCloudModelName,pdfCloudModel,
  type TranslationBackend,
} from "@better-me/agent-contracts";
import { createLocalOllamaClient } from "../privacy/local-ollama.js";
import { readBoundedJson } from "../privacy/http-cloud.js";
import { sendPdfCloudText } from "./pdf2zh-cloud.js";
import { PDF2ZH_PRIVATE_BOOTSTRAP } from "./pdf2zh-private.js";
import { translationPrompt, validateTranslationCompletion } from "./pdf2zh-completion.js";
import {
  type LearningTranslationEngine,
  unavailableTranslationBackend,
} from "./learning-translations.js";

const ENGINE_VERSION = "PDF2zh-next 2.10.2 / BabelDOC 0.7.1";
let activeNativeJobs = 0;
const probeScript = String.raw`
import hashlib,importlib.metadata as m,json,runpy,sys
from pathlib import Path
result={"python":list(sys.version_info[:2]),"pdf2zh":m.version("pdf2zh-next"),"babeldoc":m.version("babeldoc"),"assetsValid":False}
if (3,10)<=sys.version_info[:2]<(3,14) and result["pdf2zh"]=="2.10.2" and result["babeldoc"]=="0.7.1":
    # Read only the pinned package's data constants; don't import the converter,
    # initialize its user cache or run its warmup/download routine during probe.
    constants=runpy.run_path(str(m.distribution("babeldoc").locate_file("babeldoc/assets/embedding_assets_metadata.py")))
    assets=Path(sys.argv[1])
    expected={"models/doclayout_yolo_docstructbench_imgsz1024.onnx":constants["DOCLAYOUT_YOLO_DOCSTRUCTBENCH_IMGSZ1024ONNX_SHA3_256"]}
    for name in set(font for family in constants["ALL_FONT_FAMILY"]["EN"].values() for font in family):
        expected["fonts/"+name]=constants["EMBEDDING_FONT_METADATA"][name]["sha3_256"]
    for name,value in constants["CMAP_METADATA"].items(): expected["cmap/"+name]=value["sha3_256"]
    for name,value in constants["TIKTOKEN_CACHES"].items(): expected["tiktoken/"+name]=value
    valid=True
    for name,digest in expected.items():
        file=assets/name
        if not file.is_file(): valid=False;break
        hash=hashlib.sha3_256()
        with file.open("rb") as stream:
            for block in iter(lambda:stream.read(1024*1024),b""): hash.update(block)
        if hash.hexdigest()!=digest: valid=False;break
    result["assetsValid"]=valid
print(json.dumps(result))
`;
// This is trusted integration code, not model-generated code. The converter is
// an optional operator-managed installation, not part of the desktop bundle.
// Python's socket guard prevents incidental downloads in this adapter; it is
// NOT an OS sandbox or a defense against a malicious installed native library.
const BRIDGE = PDF2ZH_PRIVATE_BOOTSTRAP + String.raw`
import asyncio,csv,importlib.metadata as metadata,json,os,shutil,socket,sys
from pathlib import Path
args=json.load(sys.stdin)
if not ((3,10)<=sys.version_info[:2]<(3,14)) or metadata.version("pdf2zh-next")!="2.10.2" or metadata.version("babeldoc")!="0.7.1":
    raise RuntimeError("unsupported_converter_installation")
cache=Path.home()/".cache"/"babeldoc"
if not cache.is_dir(): raise RuntimeError("private_assets_missing")
proxy_port=args["port"]
original_connect=socket.socket.connect
original_connect_ex=socket.socket.connect_ex
def allowed(address):
    return isinstance(address,tuple) and len(address)>=2 and address[0]=="127.0.0.1" and address[1]==proxy_port
def connect(self,address):
    if not allowed(address): raise OSError("betterme_offline_converter: network destination denied")
    return original_connect(self,address)
def connect_ex(self,address):
    if not allowed(address): raise OSError("betterme_offline_converter: network destination denied")
    return original_connect_ex(self,address)
socket.socket.connect=connect
socket.socket.connect_ex=connect_ex
from pdf2zh_next.config.model import SettingsModel
from pdf2zh_next.high_level import create_babeldoc_config
from babeldoc.format.pdf.high_level import async_translate
settings={"basic":{"debug":False},"translation":{"lang_in":"zh","lang_out":"en","output":str(work/"result"),
    "qps":1,"pool_max_workers":1,"no_auto_extract_glossary":True,"ignore_cache":True},
    "pdf":{"no_mono":False,"no_dual":not args["bilingual"],"use_alternating_pages_dual":True,
    "auto_enable_ocr_workaround":False,"ocr_workaround":False,"watermark_output_mode":"no_watermark"},
    "translate_engine_settings":{"translate_engine_type":"OpenAI","openai_model":"betterme-local",
    "openai_api_key":args["token"],"openai_base_url":"http://127.0.0.1:"+str(proxy_port)+"/v1","openai_timeout":"120"}}
if args["glossary"]:
    glossary=work/"terms.csv"
    with glossary.open("w",encoding="utf-8",newline="") as stream:
        writer=csv.writer(stream);writer.writerow(["source","target"])
        for term in args["glossary"]: writer.writerow([term["source"],term["target"]])
    settings["translation"]["glossaries"]=str(glossary)
def emit(value): print("BETTERME_PDF_EVENT "+json.dumps(value),flush=True)
async def main():
    finished=False
    validated=SettingsModel.model_validate(settings)
    validated.validate_settings()
    # We already own a dedicated process. Calling BabelDOC directly avoids a
    # second SDK child (which would lose Python guards) without enabling debug
    # mode: debug=True draws layout annotations into both output PDFs.
    configuration=create_babeldoc_config(validated,work/"source.pdf")
    if configuration.debug: raise RuntimeError("debug_pdf_output_not_allowed")
    async for event in async_translate(translation_config=configuration):
        kind=event.get("type")
        if kind in ("progress_start","progress_update","progress_end"):
            name=str(event.get("stage","")).lower()
            stage="translating" if "translat" in name else "typesetting" if any(s in name for s in ("typeset","save pdf","render")) else "parsing"
            value=event.get("overall_progress")
            emit({"type":"progress","stage":stage,"percent":value if isinstance(value,(int,float)) else None})
        elif kind=="error": raise RuntimeError("converter_returned_error")
        elif kind=="finish":
            result=event["translate_result"]
            for kind in (["mono","dual"] if args["bilingual"] else ["mono"]):
                output=getattr(result,"no_watermark_"+kind+"_pdf_path",None) or getattr(result,kind+"_pdf_path",None)
                if not output: raise RuntimeError("missing_pdf_output")
                output=Path(output).resolve()
                if not output.is_relative_to(work) or not output.is_file() or output.stat().st_size>8*1024*1024: raise RuntimeError("unsafe_pdf_output")
                shutil.copyfile(output,work/(kind+".pdf"))
            finished=True
            # BabelDOC's callback stream need not close after finish. Match
            # PDF2zh-next's consumer: stop here instead of waiting forever.
            break
    if not finished: raise RuntimeError("missing_finish_event")
    emit({"type":"finish"})
asyncio.run(main())
`;
function probe(python: string, assets: string) {
  return new Promise<unknown>((resolve, reject) => {
    execFile(
      python,
      ["-I", "-B", "-c", probeScript, assets],
      { env: {}, timeout: 15_000, maxBuffer: 4096, windowsHide: true },
      (error, stdout) => {
        if (error)
          reject(new Error("translation_python_or_packages_unavailable"));
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("translation_installation_unverified"));
          }
        }
      },
    );
  });
}
async function assetsSize(
  directory: string,
  root = directory,
  count = { files: 0, bytes: 0 },
): Promise<void> {
  if (root.length > directory.length + 500)
    throw new Error("translation_asset_limit");
  const stat = await fs.lstat(root);
  if (
    stat.isSymbolicLink() ||
    (!stat.isFile() && !stat.isDirectory()) ||
    (stat.isFile() && stat.nlink !== 1)
  )
    throw new Error("translation_unsafe_assets");
  if (stat.isFile()) {
    count.files++;
    count.bytes += stat.size;
  }
  // The pinned 0.7.1 metadata adds CJK fallbacks to EN: 265,807,784
  // font bytes + CMaps + layout/tokenizer already exceed 256 MiB. Retain a
  // finite machine-copy budget, separate from each private PDF's 8 MiB cap.
  if (count.files > 3000 || count.bytes > 512 * 1024 * 1024)
    throw new Error("translation_asset_limit");
  if (stat.isDirectory())
    for (const name of await fs.readdir(root)) {
      if (
        root === directory &&
        !["fonts", "models", "tiktoken", "cmap"].includes(name)
      )
        throw new Error("translation_assets_only_directory_required");
      await assetsSize(directory, path.join(root, name), count);
    }
  if (root === directory && !count.files)
    throw new Error("translation_assets_missing");
}
const completion = z
  .object({
    model: z.literal("betterme-local"),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string().max(32_000),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    stream: z.literal(false).optional(),
    temperature: z.number().optional(),
    max_tokens: z.number().int().optional(),
    extra_body: z.record(z.unknown()).optional(),
  })
  .strict();

/** Missing config is a real unavailable state. Never discovers user keys,
 * changes model settings, starts Ollama, installs packages or downloads assets. */
export function createPdf2zhEngine(
  config: { python?: string; assets?: string } = {},
): LearningTranslationEngine | undefined {
  if (!config.python && !config.assets) return undefined;
  const { python, assets } = config;
  const admitted = new Set<"local"|"cloud">();
  return {
    abortSettles: true,
    async backend(location="local") {
      const result: TranslationBackend = {
        ...unavailableTranslationBackend,
        engine: ENGINE_VERSION,
        ...(location==="cloud" ? {location,id:PDF_CLOUD_BACKEND,recipientOrigin:PDF_CLOUD_ORIGIN} : {}),
      };
      admitted.delete(location);
      try {
        if (process.platform === "win32")
          throw new Error("translation_windows_isolation_unreviewed");
        if (
          !python ||
          !assets ||
          !path.isAbsolute(python) ||
          !path.isAbsolute(assets)
        )
          throw new Error("translation_installation_paths_required");
        const installation = z
          .object({
            python: z.tuple([z.literal(3), z.number().int().min(10).max(13)]),
            pdf2zh: z.literal("2.10.2"),
            babeldoc: z.literal("0.7.1"),
            assetsValid: z.literal(true),
          })
          .strict();
        await assetsSize(assets);
        installation.parse(await probe(python, assets));
        if(location==="cloud"){
          admitted.add(location);
          return {...result,ready:true,reason:undefined,models:PdfCloudModelName.options.map(pdfCloudModel)};
        }
        const signal = AbortSignal.timeout(3000),
          response = await fetch("http://127.0.0.1:11434/api/tags", {
            signal,
            redirect: "error",
          });
        const catalog = z
          .object({
            models: z
              .array(
                z
                  .object({
                    name: z.string().min(1).max(200),
                    digest: z.string(),
                    remote_host: z.unknown().optional(),
                    remote_model: z.unknown().optional(),
                  })
                  .passthrough(),
              )
              .max(2000),
          })
          .passthrough()
          .parse(await readBoundedJson(response, 1_000_000, signal));
        result.models = catalog.models
          .filter(
            (model) =>
              model.remote_host === undefined &&
              model.remote_model === undefined &&
              !/(?:-cloud|:cloud)(?:$|[:/])/i.test(model.name) &&
              /^[a-f0-9]{64}$/.test(model.digest.replace(/^sha256:/, "")),
          )
          .slice(0, 20)
          .map((model) => ({
            name: model.name,
            digest: model.digest.replace(/^sha256:/, ""),
          }));
        if (!result.models.length)
          throw new Error("translation_local_model_unavailable");
        for (const model of result.models)
          await createLocalOllamaClient({
            model: model.name,
            expectedDigest: model.digest,
          }).binding();
        admitted.add(location);
        return { ...result, ready: true, reason: undefined };
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        return {
          ...result,
          models: [],
          reason: /^translation_[a-z_]+$/.test(code)
            ? code
            : "translation_installation_unverified",
        };
      }
    },
    async run(input) {
      const cloud = input.request?.backendId===PDF_CLOUD_BACKEND;
      if (!admitted.has(cloud?"cloud":"local") || !python || !assets || process.platform === "win32")
        throw new Error("translation_backend_unavailable");
      input.signal.throwIfAborted();
      await assetsSize(assets);
      if(cloud && (!input.request.cloudGrant || !input.cloudKey))throw Error("translation_cloud_credential_required");
      const client = cloud ? undefined : createLocalOllamaClient({
        model: input.request.model.name,
        expectedDigest: input.request.model.digest,
      });
      await client?.binding();
      if (activeNativeJobs >= 1) throw new Error("translation_machine_busy");
      activeNativeJobs++;
      let directory: string;
      try {
        directory = await fs.mkdtemp(
          path.join(os.tmpdir(), "betterme-pdf2zh-job-"),
        );
      } catch (error) {
        activeNativeJobs--;
        throw error;
      }
      const token = randomBytes(32).toString("hex");
      let inFlight = false,
        port = 0;
      let cloudFailure="",stopCloudChild:(()=>void)|undefined;
      const proxy = http.createServer(async (req, res) => {
        let ownsSlot = false;
        try {
          if (
            req.method !== "POST" ||
            req.url !== "/v1/chat/completions" ||
            req.headers.authorization !== `Bearer ${token}` ||
            req.headers.origin ||
            inFlight ||
            input.signal.aborted || !!cloudFailure
          ) {
            res.writeHead(403);
            res.end();
            return;
          }
          inFlight = true;
          ownsSlot = true;
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 64_000) throw new Error("translation_input_limit");
            chunks.push(Buffer.from(chunk));
          }
          const body = completion.parse(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          );
          const prompt = translationPrompt(body.messages);
          const text = await input.modelCall(prompt, (signal) =>
            cloud ? sendPdfCloudText({prompt,model:input.request.model,key:input.cloudKey!,signal}) : client!.complete({
              prompt,
              signal,
              budget: {
                maxInputBytes: TRANSLATION_LIMITS.inputBytes,
                maxOutputBytes: TRANSLATION_LIMITS.outputBytes,
                maxActiveMs: 120_000,
              },
            }),
          );
          validateTranslationCompletion(body.messages, text);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "betterme-document-translation",
              object: "chat.completion",
              model: "betterme-local",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: text },
                  finish_reason: "stop",
                },
              ],
            }),
          );
        } catch (error) {
          if(cloud && !cloudFailure){
            const code=error instanceof Error?error.message:"";
            cloudFailure=/^translation_[a-z_]+$/.test(code)?code:"translation_cloud_request_failed";
            stopCloudChild?.();
          }
          if (!res.headersSent)
            res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "translation_request_refused",
                type: "translation_error",
              },
            }),
          );
        } finally {
          // A denied parallel request must not release another request's slot.
          if (ownsSlot) inFlight = false;
        }
      });
      proxy.requestTimeout = 130_000;
      proxy.headersTimeout = 5000;
      try {
        await fs.writeFile(path.join(directory, "source.pdf"), input.source, {
          flag: "wx",
          mode: 0o600,
        });
        await fs.mkdir(path.join(directory, "private-home", ".cache"), { recursive: true, mode: 0o700 });
        await fs.cp(assets, path.join(directory, "private-home", ".cache", "babeldoc"), {
          recursive: true, errorOnExist: true, force: false,
          // APFS/reflink where supported, ordinary private copies elsewhere.
          // Never hardlink the operator's assets into a mutable job directory.
          mode: fileFlags.COPYFILE_FICLONE,
        });
        input.signal.throwIfAborted();
        proxy.listen(0, "127.0.0.1");
        await once(proxy, "listening");
        const address = proxy.address();
        if (!address || typeof address === "string")
          throw new Error("translation_proxy_failed");
        port = address.port;
        await new Promise<void>((resolve, reject) => {
          const child = spawn(python, ["-I", "-B", "-c", BRIDGE], {
            cwd: directory,
            env: {},
            detached: true,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
          let closed = false,
            finished = false,
            failure = "",
            buffer = "",
            bytes = 0,
            killTimer: ReturnType<typeof setTimeout> | undefined;
          let progress = Promise.resolve();
          const stop = () => {
            if (closed || !child.pid) return;
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              child.kill("SIGTERM");
            }
            killTimer ??= setTimeout(() => {
              if (!closed && child.pid) {
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {
                  child.kill("SIGKILL");
                }
              }
            }, 1500);
          };
          stopCloudChild=stop;
          input.signal.addEventListener("abort", stop, { once: true });
          child.stdin.on("error", () => {});
          child.stdin.end(
            JSON.stringify({
              port,
              token,
              bilingual: input.request.bilingual,
              glossary: input.request.glossary,
            }),
          );
          child.stdout.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 1_000_000) {
              failure = "translation_engine_output_limit";
              stop();
              return;
            }
            buffer += chunk.toString("utf8");
            for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (!line.startsWith("BETTERME_PDF_EVENT ")) continue;
              try {
                const event = JSON.parse(line.slice(19));
                if (event.type === "finish") finished = true;
                if (
                  event.type === "progress" &&
                  ["parsing", "translating", "typesetting"].includes(
                    event.stage,
                  )
                )
                  progress = progress
                    .then(() =>
                      input.progress(
                        event.stage,
                        typeof event.percent === "number"
                          ? event.percent
                          : null,
                      ),
                    )
                    .catch(() => {
                      failure = "translation_stopped";
                      stop();
                    });
              } catch {
                failure = "translation_engine_protocol";
                stop();
              }
            }
          });
          child.stderr.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 1_000_000) {
              failure = "translation_engine_output_limit";
              stop();
            }
          }); // Never expose paths/source/provider logs.
          child.once("error", () => {
            stop();
            reject(new Error("translation_engine_failed"));
          });
          child.once("close", (code) => {
            closed = true;
            clearTimeout(killTimer);
            input.signal.removeEventListener("abort", stop);
            void progress.then(
              () =>
                code === 0 && finished && !input.signal.aborted && !failure && !cloudFailure
                  ? resolve()
                  : reject(new Error(cloudFailure || failure || "translation_engine_failed")),
              reject,
            );
          });
          if (input.signal.aborted) stop();
        });
        const read = async (kind: "mono" | "dual") => {
          const filename = path.join(directory, `${kind}.pdf`),
            stat = await fs.lstat(filename);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            stat.size > TRANSLATION_LIMITS.artifactBytes
          )
            throw new Error("translation_invalid_output");
          return new Uint8Array(await fs.readFile(filename));
        };
        input.signal.throwIfAborted();
        return {
          mono: await read("mono"),
          ...(input.request.bilingual ? { dual: await read("dual") } : {}),
        };
      } finally {
        proxy.closeAllConnections();
        if (proxy.listening)
          await new Promise<void>((resolve) => proxy.close(() => resolve()));
        try {
          await fs.rm(directory, { recursive: true, force: true });
        } finally {
          // Exact mkdtemp directory owned by this invocation only.
          activeNativeJobs--;
        }
      }
    },
  };
}
