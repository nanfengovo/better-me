/** Operator-only, offline real-install regression. No PDF or inference. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDF2ZH_PRIVATE_BOOTSTRAP } from "../src/growth/pdf2zh-private.js";

const python = process.argv[2];
if (!python || !path.isAbsolute(python)) throw new Error("Explicit dedicated Python path required");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-pdf2zh-offline-"));
try {
  const result = await promisify(execFile)(python, ["-I", "-B", "-c", PDF2ZH_PRIVATE_BOOTSTRAP + String.raw`
import importlib.metadata as metadata,json,socket,sys
assert (3,10)<=sys.version_info[:2]<(3,14)
assert metadata.version("pdf2zh-next")=="2.10.2" and metadata.version("babeldoc")=="0.7.1"
# A red test must never create the real user's config, even with approval.
def audit(event,args):
    if event=="os.mkdir" and not Path(args[0]).resolve().is_relative_to(work):
        raise RuntimeError("runtime_attempted_nonprivate_mkdir")
sys.addaudithook(audit)
def deny(self,address): raise OSError("offline_runtime_probe_network_denied")
socket.socket.connect=deny
socket.socket.connect_ex=deny
assert Path.home().is_relative_to(work)
assert Path("~/.config/pdf2zh").expanduser().is_relative_to(work)
assert Path(tempfile.gettempdir()).is_relative_to(work)
assert Path(os.fsdecode(os.path.expanduser(b"~/.config"))).is_relative_to(work)
assert os.path.expanduser("unchanged/relative")=="unchanged/relative"
for invalid in ("~another-user/.config","~/../../outside"):
    try: os.path.expanduser(invalid)
    except ValueError: pass
    else: raise AssertionError("unsafe home expansion admitted")
print(json.dumps({"probe":"private_paths"}),flush=True)
from pdf2zh_next.config.model import SettingsModel
print(json.dumps({"probe":"settings_import"}),flush=True)
from pdf2zh_next.high_level import do_translate_async_stream
print(json.dumps({"probe":"converter_import"}),flush=True)
from httpx._utils import get_environment_proxies
assert os.environ.get("NO_PROXY")=="*"
assert get_environment_proxies()=={}, "system proxies must not intercept the private loopback bridge"
from pdf2zh_next.const import DEFAULT_CONFIG_DIR,DEFAULT_CONFIG_FILE
from babeldoc.const import CACHE_FOLDER,TIKTOKEN_CACHE_FOLDER
from pdf2zh_next.translator.cache import db
assert Path(db.database).resolve().is_relative_to(work)
for location in (DEFAULT_CONFIG_DIR,DEFAULT_CONFIG_FILE,CACHE_FOLDER,TIKTOKEN_CACHE_FOLDER):
    assert location.resolve().is_relative_to(work)
s=SettingsModel.model_validate({"basic":{"debug":False},"translation":{"lang_in":"zh","lang_out":"en",
    "qps":1,"pool_max_workers":1,"no_auto_extract_glossary":True,"ignore_cache":True},
    "pdf":{"watermark_output_mode":"no_watermark"},"translate_engine_settings":{"translate_engine_type":"OpenAI",
    "openai_model":"betterme-local","openai_api_key":"unused-offline-probe","openai_base_url":"http://127.0.0.1:1/v1"}})
s.validate_settings()
print(json.dumps({"python":list(sys.version_info[:3]),"pdf2zh":metadata.version("pdf2zh-next"),
    "babeldoc":metadata.version("babeldoc"),"imports":"ready","privateConfig":True,"privateTemp":True,
    "offline":True,"modelRequests":0}))
`], { cwd: directory, env: {}, timeout: 90_000, maxBuffer: 16_384 });
  console.log(result.stdout.trim());
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
