import { createJobApplication } from "../apps/job-service/src/application.js";
import { openJobRepository } from "../apps/job-service/src/repository.js";
import { createControlledSourceTransport } from "../packages/source-adapters/src/transport.js";

async function main() {
  const dataDir = "/Users/feng/Library/Application Support/BetterMe/job-atlas";
  const repo = openJobRepository(`${dataDir}/jobs.sqlite`);
  const transport = createControlledSourceTransport();
  const app = createJobApplication({ repository: repo, transport });

  const context = {
    requestId: `diag-tc-${Date.now()}`,
    actorScope: "local-owner",
    idempotencyKey: `diag-tc-key-${Date.now()}`,
    allowedEffects: ["read-index", "external-read", "local-write"],
    budget: { requests: 20, bytes: 10 * 1024 * 1024, timeoutMs: 30000 },
    signal: new AbortController().signal,
    throwIfCancelled: () => {},
    consumeRequests: () => {},
  };

  console.log("Calling sources.sync for src-tencent-cn...");
  try {
    const res = await app.registry.execute("sources.sync", {
      sourceId: "src-tencent-cn",
      scope: { roles: ["前端"], regions: [], companyNames: [] },
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
