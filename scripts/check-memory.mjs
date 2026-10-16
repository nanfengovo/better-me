import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "projectbrief.md",
  "decisionLog.md",
  "activeContext.md",
  "progress.md",
].map((f) => path.join(root, ".agent-memory", f));

let ok = true;
for (const file of required) {
  try {
    await access(file, constants.R_OK);
    console.log("ok ", path.relative(root, file));
  } catch {
    ok = false;
    console.error("missing", path.relative(root, file));
  }
}

if (!ok) {
  process.exit(1);
}
console.log("Memory Bank files present.");
