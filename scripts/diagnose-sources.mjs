import { createJobApplication } from "../apps/job-service/src/application.js";
import { openJobRepository } from "../apps/job-service/src/repository.js";

async function main() {
  const dataDir = "/Users/feng/Library/Application Support/BetterMe/job-atlas";
  const repo = openJobRepository(`${dataDir}/jobs.sqlite`);

  const app = createJobApplication({ repository: repo });
  const snapshot = await repo.readSnapshot();

  console.log(`Found ${snapshot.sources.length} sources in repository.`);

  for (const source of snapshot.sources) {
    console.log(`\nTesting source: ${source.sourceId} (${source.attribution.label}) ...`);
    const context = {
      requestId: `diag-${Date.now()}`,
      actorScope: "local-owner",
      idempotencyKey: `diag-key-${source.sourceId}-${Date.now()}`,
      allowedEffects: ["read-index", "external-read", "local-write"],
      budget: { requests: 20, bytes: 10 * 1024 * 1024, timeoutMs: 15000 },
      signal: new AbortController().signal,
      throwIfCancelled: () => {},
      consumeRequests: () => {},
    };

    try {
      const result = await app.registry.execute("sources.preview", {
        sourceId: source.sourceId,
        scope: { roles: ["C#"], regions: [], companyNames: [] },
      }, context);

      if (result.ok) {
        console.log(`  [OK] Records: ${result.value.page.records.length}, LocalMatched: ${result.value.localMatchedRecords}`);
      } else {
        console.log(`  [FAILED] Error:`, result.error);
      }
    } catch (err) {
      console.log(`  [EXCEPTION]`, err);
    }
  }

  await repo.close();
}

main().catch(console.error);
