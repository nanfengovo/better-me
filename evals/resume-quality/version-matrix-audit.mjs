import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { replayMatrix } from "./version-matrix.mjs";
import { estimateTokenCost, rateCard } from "./token-cost.mjs";
import { readRegular } from "./freeze.mjs";
import { sha, summarize } from "./version-matrix/experiment.mjs";

/** Check the saved reports and raw responses offline, without executing any code from the archive. */
export async function auditMatrix(directory) {
  directory = await fs.realpath(directory);
  const report = await replayMatrix(directory);
  const files = await fs.readdir(directory);
  const allowed = new Set(
    report.rows.flatMap((row) => [row.cell + ".intent.json", row.cell + ".result.json"]),
  );
  if (files.some((file) => file.startsWith("cell-") && file.endsWith(".json") && !allowed.has(file))) {
    throw Error("unknown_matrix_cell_file");
  }
  let sealed = false;
  if (files.includes("report.json")) {
    const saved = JSON.parse(await readRegular(path.join(directory, "report.json")));
    for (const row of report.rows) {
      const original = saved.rows?.find((r) => r.cell === row.cell);
      if (!original) throw Error("matrix_sealed_cell_missing:" + row.cell);
      if (original.resultSha256 && !row.resultSha256) throw Error("matrix_sealed_result_missing:" + row.cell);
      if (original.resultSha256 !== row.resultSha256) throw Error("matrix_sealed_result_changed:" + row.cell);
    }
    // A later checkout can use a different source version. This property describes the machine doing the replay.
    const { sourceMatchesCurrentCheckout: _originalMatch, ...historical } = saved;
    const { sourceMatchesCurrentCheckout: _currentMatch, ...reconstructed } = report;
    if (!isDeepStrictEqual(historical, reconstructed))
      throw Error("matrix_sealed_report_differs_from_replay");
    sealed = true;
  }
  return {
    integrity: {
      state: sealed && !report.unresolved ? "sealed_complete" : sealed ? "sealed_partial" : "unsealed",
      sealed,
      planned: report.planned,
      rawResultHashesVerified: sealed ? report.rows.filter((r) => r.resultSha256).length : 0,
      unresolvedCells: report.rows.filter((r) => r.state === "unresolved").map((r) => r.cell),
      sourceMatchesCurrentCheckout: report.sourceMatchesCurrentCheckout,
      assurance: "Local archive checksums and replay, with no independent signature or provider attestation.",
    },
    report,
  };
}

const key = (provider, model, revision) => JSON.stringify([provider, model, revision]);
/** Rates may cover a subset of revisions. Known partial costs and missing coverage remain visible. */
export function priceMatrix({ integrity, report }, suppliedRates) {
  if (!Array.isArray(suppliedRates)) throw Error("matrix_rate_cards_array_required");
  const rates = suppliedRates.map((r) => rateCard.parse(r));
  const byModel = new Map();
  for (const row of report.rows) {
    const id = key("ollama", row.model, row.revision);
    if (!byModel.has(id)) byModel.set(id, []);
    byModel.get(id).push(row);
  }
  const indexed = new Map();
  for (const card of rates) {
    const id = key(card.provider, card.model, card.revision);
    if (!byModel.has(id)) throw Error("matrix_rate_model_or_revision_mismatch");
    if (indexed.has(id)) throw Error("duplicate_matrix_rate");
    indexed.set(id, card);
  }
  const models = [];
  for (const [id, rows] of byModel) {
    const summary = summarize(rows);
    const metadata = {
      provider: "ollama",
      id: rows[0].model,
      revision: rows[0].revision,
      execution: "model",
    };
    const collection = {
      metadata,
      planned: rows.length,
      unresolved: summary.unresolved,
      runtimeQuality: {
        ledgerCoverage: {
          numerator: rows.filter((r) => r.state !== "unresolved").length,
          denominator: rows.length,
        },
        providerUsage: summary.providerUsage,
      },
    };
    const card = indexed.get(id);
    const estimate = card ? estimateTokenCost(card, collection) : null;
    models.push({
      provider: metadata.provider,
      model: metadata.id,
      revision: metadata.revision,
      planned: rows.length,
      unresolved: summary.unresolved,
      tokenCoverage: summary.providerUsage.tokenCoverage,
      pairedTokens: summary.providerUsage.pairedTokens,
      currency: card?.currency ?? null,
      rate: card ?? null,
      observedTokenEstimate: estimate?.observedTokenEstimate ?? null,
      fullModelTokenEstimate: integrity.sealed ? (estimate?.fullCampaignTokenEstimate ?? null) : null,
      billedAmount: null,
    });
  }
  const currencies = new Set(models.map((m) => m.currency).filter(Boolean));
  const complete = currencies.size === 1 && models.every((m) => m.fullModelTokenEstimate !== null);
  const total = complete ? models.reduce((sum, m) => sum + m.fullModelTokenEstimate, 0) : null;
  if (total !== null && !Number.isFinite(total)) throw Error("invalid_matrix_cost_total");
  return {
    planSha256: report.planSha256,
    rateCardsSha256: sha(rates),
    integrity,
    models,
    total: {
      currency: complete ? currencies.values().next().value : null,
      fullMatrixTokenEstimate: total,
      billedAmount: null,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { archive: { type: "string" }, rates: { type: "string" } } });
  if (!values.archive) throw Error("Usage: --archive DIRECTORY [--rates JSON_FILE]");
  const checked = await auditMatrix(values.archive);
  const result = values.rates
    ? priceMatrix(checked, JSON.parse(await readRegular(await fs.realpath(values.rates))))
    : {
        integrity: checked.integrity,
        planSha256: checked.report.planSha256,
        completion: checked.report.completion,
        distinctModels: checked.report.distinctModels,
        providerUsage: checked.report.providerUsage,
      };
  console.log(JSON.stringify(result, null, 2));
}
