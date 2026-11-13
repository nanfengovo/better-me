import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readComparisonConfig, prepareComparisonSelection, reviewCampaignComparison } from "./comparison.mjs";
import { readRegular } from "./freeze.mjs";
import { digest } from "./gold/extract.mjs";

/** Bounded, explicit offline reporting recurrence; never schedules inference.
 * Work is serial. Overruns skip missed slots rather than overlapping/catching up.
 * SIGINT/abort stops after the current report, preserving any partial artifacts.
 * Restart requires a NEW directory; no ambiguous cycle is silently replayed. */
export async function runPeriodicComparison({ config, selectionFile, outputDirectory, intervalMs, occurrences, signal, onProgress = () => {} }) {
  if (!path.isAbsolute(outputDirectory) || !Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 86_400_000
    || !Number.isInteger(occurrences) || occurrences < 1 || occurrences > 10_000) throw Error("explicit_bounded_periodic_plan_required");
  if (signal?.aborted) throw Error("periodic_stopped_before_start");
  if (selectionFile !== undefined) {
    if (!path.isAbsolute(selectionFile)) throw Error("explicit_absolute_selection_file_required");
    config = await readComparisonConfig(selectionFile);
  }
  ({ config, outputDirectory } = await prepareComparisonSelection({ config, outputDirectory }));
  await fs.mkdir(outputDirectory, { mode: 0o700 }); outputDirectory = await fs.realpath(outputDirectory);
  const plan = { schemaVersion: 1, protocolVersion: "resume-quality-offline-periodic-v1", config, selectionFile: selectionFile ?? null, intervalMs, occurrences,
    createdAt: new Date().toISOString(), inferenceScheduled: false, limits: ["Offline snapshots only; no SDK, auth, inference or adoption.",
      "Serial cycles; missed slots are skipped, never a catch-up burst. Abort finishes the current report before stopping.",
      "New output directory required; restarting never replays or overwrites an ambiguous prior cycle.",
      "An explicit selection file is reread each cycle so the operator can select newly completed campaigns. No folder scanning or inference is performed."] };
  await fs.writeFile(path.join(outputDirectory, "plan.json"), JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const eventFile = path.join(outputDirectory, "events.ndjson");
  await fs.writeFile(eventFile, "", { flag: "wx", mode: 0o600 });
  const emit = async event => {
    const entry = { at: new Date().toISOString(), ...event };
    await fs.appendFile(eventFile, JSON.stringify(entry) + "\n"); await onProgress(entry);
  };
  const cycles = []; let due = Date.now(), previousReportSha256 = null, stopped = false;
  for (let n = 1; n <= occurrences; n++) {
    try { while (!signal?.aborted && Date.now() < due) await delay(Math.min(1000, due - Date.now()), undefined, { signal }); }
    catch (error) { if (!signal?.aborted) throw error; }
    if (signal?.aborted) { stopped = true; break; }
    const directory = `cycle-${String(n).padStart(4, "0")}`, scheduledAt = new Date(due).toISOString();
    try {
      const selected = selectionFile === undefined ? config : await readComparisonConfig(selectionFile);
      await prepareComparisonSelection({ config: selected, outputDirectory }); // Reject feedback into this periodic output tree.
      const selectionSha256 = digest(JSON.stringify(selected));
      await emit({ stage: "cycle_started", cycle: n, directory, scheduledAt, selectionSha256, previousReportSha256 });
      const report = await reviewCampaignComparison({ config: selected, outputDirectory: path.join(outputDirectory, directory) });
      const reportSha256 = digest(await readRegular(path.join(outputDirectory, directory, "comparison.json")));
      const cycle = { cycle: n, directory, scheduledAt, completedAt: new Date().toISOString(), selectionSha256, reportSha256, previousReportSha256,
        collectionSha256s: report.campaigns.map(c => c.collectionSha256), deliveryComparable: report.deliveryComparable,
        qualityComparable: report.qualityComparable, reasonCodes: report.reasonCodes, modelRequests: 0 };
      cycles.push(cycle); previousReportSha256 = reportSha256; await emit({ stage: "cycle_completed", ...cycle });
    } catch (error) {
      await emit({ stage: "cycle_failed", cycle: n, directory, code: /^[a-z][a-z0-9_]{0,120}$/.test(error.message) ? error.message : "periodic_report_failed", modelRequests: 0 });
      throw error; // No implicit retry or deletion of failed-cycle evidence.
    }
    if (n < occurrences) {
      due += intervalMs;
      if (due < Date.now()) { const skipped = Math.ceil((Date.now() - due) / intervalMs); due += skipped * intervalMs; await emit({ stage: "slots_skipped", count: skipped }); }
    }
  }
  const summary = { schemaVersion: 1, protocolVersion: plan.protocolVersion, requested: occurrences, completed: cycles.length,
    stopped: stopped || Boolean(signal?.aborted), cycles, modelRequests: 0, inferenceScheduled: false,
    limitation: "Repeated snapshots of saved outputs are actual periodic REPORT execution, not new model trials, periodic inference or proof of a comparable second model." };
  await fs.writeFile(path.join(outputDirectory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), flags = ["--config", "--out", "--interval-ms", "--count"];
  if (args.length !== 8 || flags.some((flag, i) => args[i * 2] !== flag) || !/^\d+$/.test(args[5]) || !/^\d+$/.test(args[7]))
    throw Error("Usage: node --import tsx periodic-report.mjs --config ABSOLUTE_JSON --out NEW_ABSOLUTE_DIR --interval-ms N --count N");
  const controller = new AbortController(), stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const summary = await runPeriodicComparison({ selectionFile: path.resolve(args[1]), outputDirectory: path.resolve(args[3]),
      intervalMs: Number(args[5]), occurrences: Number(args[7]), signal: controller.signal, onProgress: event => console.log(JSON.stringify(event)) });
    console.log(JSON.stringify(summary));
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
