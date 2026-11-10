import { build } from "esbuild";
import { readFile } from "node:fs/promises";

// Bundle our workspace TypeScript; keep third-party packages intact, including
// Playwright's resources, QuickJS WASM and native SQLite bindings.
const manifests = await Promise.all(["../agent-host/package.json", "../job-service/package.json"].map(async file => JSON.parse(await readFile(file, "utf8"))));
const external = [...new Set(manifests.flatMap(pkg => Object.keys(pkg.dependencies ?? {})))].filter(name => !name.startsWith("@better-me/"));
await build({ entryPoints: ["src/runtime/server.ts"], outfile: "dist/runtime/server.mjs", bundle: true, platform: "node", format: "esm", target: "node24", external,
  banner: { js: "import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);" },
});
