import path from "node:path";
import { resolveCheckpointPath } from "../src/checkpointer.js";
import { loadIdentityDeployment, publicOrigins } from "../src/identity/deployment.js";
import { checkIdentityDeployment } from "../src/identity/deployment-check.js";

const args = process.argv.slice(2);
try {
  if (args.length && (args.length !== 2 || args[0] !== "--config" || !path.isAbsolute(args[1]!))) throw new Error();
  const env = { ...process.env, ...(args[1] ? { BETTERME_OIDC_CONFIG: args[1] } : {}) };
  publicOrigins(env, []);
  const defaultConfigPath = process.env.BETTER_ME_DATA_DIR ? path.resolve(process.env.BETTER_ME_DATA_DIR, "agent", "oidc.json") : path.join(path.dirname(resolveCheckpointPath()), "oidc.json");
  const result = await checkIdentityDeployment(await loadIdentityDeployment({ env, defaultConfigPath }));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ready ? 0 : 1;
} catch {
  console.error(JSON.stringify({ ready: false, status: "invalid_check_arguments_or_public_origin", usage: "pnpm auth:check [--config /absolute/private/oidc.json]" }));
  process.exitCode = 1;
}
