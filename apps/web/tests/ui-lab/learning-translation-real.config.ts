// Manual opt-in real LOCAL inference only. Never part of a normal test run.
// Set the two trusted operator paths explicitly; no user config/key discovery.
import { growthLoopLab } from "./growth-loop-live.config.ts";
import { createPdf2zhEngine } from "../../../agent-host/src/growth/pdf2zh-engine.ts";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const trace = fileURLToPath(new URL(`../../../../output/translation-real/model-trace-${Date.now()}.ndjson`, import.meta.url));

const engine = createPdf2zhEngine({
  python: process.env.BETTERME_PDF2ZH_PYTHON,
  assets: process.env.BETTERME_PDF2ZH_ASSETS,
});
if (!engine) throw new Error("Explicit isolated PDF2zh interpreter/assets required");
let adapterRuns = 0, modelRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === "http://127.0.0.1:11434/api/generate" && init?.method === "POST") modelRequests++;
  return originalFetch(input, init);
};
export default growthLoopLab({
  port: 5338,
  entry: "tests/ui-lab/learning-path.html",
  translationEngine: {
    abortSettles: true,
    backend: () => engine.backend(),
    run: async (input) => {
      // This opt-in QA lab may trace ONLY our original, nonpersonal fixture.
      // Normal Host code has no prompt logging or fixture restriction.
      if (createHash("sha256").update(input.source).digest("hex") !== "1bb01c208dcf6f5ca0f1111d1b66da4a100d3d60150cf4f648465abed5d348f2")
        throw new Error("real_qa_original_fixture_only");
      adapterRuns++;
      await fs.mkdir(new URL("../../../../output/translation-real/", import.meta.url), { recursive: true });
      return engine.run({ ...input, modelCall: async (prompt, invoke) => {
        const result = await input.modelCall(prompt, invoke);
        await fs.appendFile(trace, JSON.stringify({ prompt, result }) + "\n", { mode: 0o600 });
        return result;
      } });
    },
  },
  qaState: () => ({ translationAdapterRuns: adapterRuns, translationModelRequests: modelRequests }),
});
