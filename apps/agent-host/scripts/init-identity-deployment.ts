import { provisionIdentityDeployment } from "../src/identity/bootstrap.js";

const args = process.argv.slice(2);
try {
  if (args.length !== 6 || args[0] !== "--directory" || args[2] !== "--issuer" || args[4] !== "--app-origin") throw new Error();
  console.log(JSON.stringify(await provisionIdentityDeployment({ directory: args[1]!, issuer: args[3]!, publicOrigin: args[5]! })));
} catch {
  console.error(JSON.stringify({ status: "initialization_refused", usage: "pnpm auth:identity:init --directory /absolute/NEW-private-directory --issuer https://identity.example.com --app-origin https://betterme.example.com", existingDataReplaced: false }));
  process.exitCode = 1;
}
