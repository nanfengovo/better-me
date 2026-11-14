import { setTimeout as delay } from "node:timers/promises";
import { growthLoopLab } from "./growth-loop-live.config.ts";
import type { LearningTranslationEngine } from "../../../agent-host/src/growth/learning-translations.ts";

let adapterRuns = 0,
  modelRequests = 0;
const translationEngine: LearningTranslationEngine = {
  backend: async () => ({
    id: "pdf-job-simulation-v1",
    engine: "模拟 PDF 作业 · 不生成英文译文",
    ready: true,
    simulation: true,
    location: "local",
    models: [{ name: "synthetic-local-no-inference", digest: "f".repeat(64) }],
  }),
  run: async (input) => {
    adapterRuns++;
    await input.progress("parsing", 5);
    for (let index = 0; index < 2; index++) {
      await input.modelCall(
        `Synthetic converter protocol input ${index}, no private document sent to a model.`,
        async (signal) => {
          modelRequests++;
          await delay(2000, undefined, { signal });
          return "Synthetic response; not a translated paragraph.";
        },
      );
      await input.progress(
        index === 0 ? "translating" : "typesetting",
        index === 0 ? 35 : 85,
      );
    }
    // Deliberately the ORIGINAL bytes, clearly simulation=true. Never a fake English PDF.
    return {
      mono: input.source,
      ...(input.request.bilingual ? { dual: input.source } : {}),
    };
  },
};
export default growthLoopLab({
  port: 5337,
  entry: "tests/ui-lab/learning-path.html",
  translationEngine,
  qaState: () => ({
    translationAdapterRuns: adapterRuns,
    translationModelRequests: modelRequests,
  }),
});
