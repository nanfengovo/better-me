import { createJobApplication } from "../apps/job-service/src/application.js";
import { openJobRepository } from "../apps/job-service/src/repository.js";
import { createControlledSourceTransport } from "../packages/source-adapters/src/transport.js";

async function main() {
  const sourceId = process.argv[2] || "reviewed-bosch-china-official";
  const dataDir = "/Users/feng/Library/Application Support/BetterMe/job-atlas";
  const repo = openJobRepository(`${dataDir}/jobs.sqlite`);
  const transport = createControlledSourceTransport({ timeoutMs: 30000 });
  const app = createJobApplication({ repository: repo, transport });

  const context = {
    requestId: `diag-${sourceId}-${Date.now()}`,
    actorScope: "local-owner",
    idempotencyKey: `diag-key-${sourceId}-${Date.now()}`,
    allowedEffects: ["read-index", "external-read", "local-write"],
    budget: { requests: 20, bytes: 10 * 1024 * 1024, timeoutMs: 35000 },
    signal: new AbortController().signal,
    throwIfCancelled: () => {},
    consumeRequests: () => {},
  };

  console.log(`Calling sources.sync for ${sourceId}...`);
  try {
    const res = await app.registry.execute("sources.sync", {
      sourceId,
      scope: { roles: [], regions: [], companyNames: [] },
      maxRecords: 10,
      maxPages: 1,
    }, context);

    console.log("Result:", JSON.stringify(res, null, 2));
  } catch (err) {
    console.error("Exception:", err);
  }

  await repo.close();
}

main().catch(console.error);
