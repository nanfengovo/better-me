import { createJobApplication } from "../apps/job-service/src/application.js";
import { openJobRepository } from "../apps/job-service/src/repository.js";
import { createControlledSourceTransport } from "../packages/source-adapters/src/index.js";

async function main() {
  const dataDir = "/Users/feng/Library/Application Support/BetterMe/job-atlas";
  const repo = openJobRepository(`${dataDir}/jobs.sqlite`);
  const transport = createControlledSourceTransport();
  const app = createJobApplication({ repository: repo, transport });
  const snapshot = await repo.readSnapshot();

  console.log(`Checking ${snapshot.sources.length} sources in repository...`);

  for (const source of snapshot.sources) {
    console.log(`\n========================================`);
    console.log(`Testing sync for: ${source.sourceId} (${source.attribution.label})`);
    console.log(`Adapter: ${source.adapterId}, EntryUrl: ${source.entryUrl}`);

    const context = {
      requestId: `test-sync-${Date.now()}`,
      actorScope: "local-owner",
      idempotencyKey: `test-key-${source.sourceId}-${Date.now()}`,
      allowedEffects: ["read-index", "external-read", "local-write"],
      budget: { requests: 20, bytes: 10 * 1024 * 1024, timeoutMs: 40000 },
      signal: new AbortController().signal,
      throwIfCancelled: () => {},
      consumeRequests: () => {},
    };

    try {
      const result = await app.registry.execute("sources.sync", {
        sourceId: source.sourceId,
        scope: { roles: [], regions: [], companyNames: [] },
        maxRecords: 10,
        maxPages: 1,
      }, context);

      if (result.ok) {
        console.log(`  [SUCCESS] Run status: ${result.value.run.status}`);
        console.log(`  Summary:`, result.value.run.summary);
        if (result.value.warnings?.length) console.log(`  Warnings:`, result.value.warnings);
        if (result.value.sourceError) console.log(`  SourceError:`, result.value.sourceError);
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
