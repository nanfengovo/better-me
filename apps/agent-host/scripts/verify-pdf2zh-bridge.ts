/** Operator-only preflight of the actual bridge up to its first HTTP request.
 * Uses only our original fixture. The proxy never contacts a model. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PDF2ZH_PRIVATE_BOOTSTRAP } from "../src/growth/pdf2zh-private.js";

const [python, assets] = process.argv.slice(2);
const eventsOnly = process.argv[4] === "--events-only";
assert(python && assets && path.isAbsolute(python) && path.isAbsolute(assets));
const source = await fs.readFile(new URL("../src/growth/pdf2zh-engine.ts", import.meta.url), "utf8");
const body = source.match(/const BRIDGE = PDF2ZH_PRIVATE_BOOTSTRAP \+ String\.raw`([\s\S]*?)`;\nfunction probe/);
assert(body, "Actual bridge definition not found");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-pdf2zh-preflight-"));
let requests = 0;
const server = http.createServer((_req, res) => {
  requests++;
  res.writeHead(503);
  res.end();
  child.kill("SIGTERM");
});
let child: ReturnType<typeof spawn>;
try {
  await fs.copyFile(new URL("../tests/fixtures/learning/checkpoint-notes-v1.pdf", import.meta.url), path.join(directory, "source.pdf"));
  await fs.mkdir(path.join(directory, "private-home", ".cache"), { recursive: true, mode: 0o700 });
  await fs.cp(assets, path.join(directory, "private-home", ".cache", "babeldoc"), {
    recursive: true, errorOnExist: true, force: false, mode: constants.COPYFILE_FICLONE,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  // Exercise our actual generator consumer independently of expensive OCR/ML.
  // After finish the generator deliberately never ends: its caller must break,
  // as PDF2zh-next's own high-level consumer does. No fake output is delivered.
  const eventsPrelude = String.raw`
import asyncio,sys,types
class FakeSettings:
    @classmethod
    def model_validate(cls,value):
        assert value["basic"]["debug"] is False
        return cls()
    def validate_settings(self): pass
def fake_config(settings,file): return types.SimpleNamespace(debug=False)
async def fake_translate(translation_config):
    result=types.SimpleNamespace(no_watermark_mono_pdf_path=work/"source.pdf",no_watermark_dual_pdf_path=work/"source.pdf")
    yield {"type":"finish","translate_result":result}
    await asyncio.Event().wait()
for name,values in (("pdf2zh_next.config.model",{"SettingsModel":FakeSettings}),
    ("pdf2zh_next.high_level",{"create_babeldoc_config":fake_config}),
    ("babeldoc.format.pdf.high_level",{"async_translate":fake_translate})):
    module=types.ModuleType(name)
    for key,value in values.items(): setattr(module,key,value)
    sys.modules[name]=module
`;
  child = spawn(python, ["-I", "-B", "-c", PDF2ZH_PRIVATE_BOOTSTRAP + (eventsOnly ? eventsPrelude : "") + body[1]], {
    cwd: directory, env: {}, stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostic = "";
  let stdout = "";
  child.stderr!.on("data", chunk => { if (diagnostic.length < 20_000) diagnostic += chunk.toString(); });
  child.stdout!.on("data", chunk => { if (stdout.length < 20_000) stdout += chunk.toString(); });
  child.stdin!.on("error", () => {});
  child.stdin!.end(JSON.stringify({ port: address.port, token: "offline-preflight-unused", bilingual: true,
    glossary: [{ source: "回执", target: "receipt" }, { source: "断点", target: "checkpoint" }, { source: "结果未知", target: "unknown outcome" }] }));
  const timeout = setTimeout(() => child.kill("SIGKILL"), eventsOnly ? 5000 : 90_000);
  let exit;
  try { [exit] = await once(child, "close"); } finally { clearTimeout(timeout); }
  if (eventsOnly) {
    assert.equal(requests, 0);
    assert.equal(exit, 0, "Bridge must stop consuming at finish, without waiting for another event");
    assert.ok(stdout.includes('BETTERME_PDF_EVENT {"type": "finish"}'));
    console.log(JSON.stringify({ bridge: "finish-event-consumed", proxyRequests: 0, actualModelRequests: 0 }));
    process.exitCode = 0;
  } else {
  if (!requests) process.stderr.write(diagnostic.replaceAll(directory, "<PRIVATE_JOB>").replaceAll(python, "<DEDICATED_PYTHON>"));
  assert.equal(requests, 1, "The actual bridge must reach its first local proxy request; no model was called");
  console.log(JSON.stringify({ bridge: "first-proxy-request", proxyRequests: requests, actualModelRequests: 0 }));
  }
} finally {
  server.closeAllConnections();
  server.close();
  await fs.rm(directory, { recursive: true, force: true });
}
