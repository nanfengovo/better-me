import { growthLoopLab } from "./growth-loop-live.config.ts";

// Only this isolated lab can advance a synthetic clock. No production route.
let time = Date.now();
export default growthLoopLab({ port: 5336, entry: "tests/ui-lab/learning-path.html", clock: () => time,
  advanceWeek: () => time += 7 * 24 * 60 * 60 * 1000 });
