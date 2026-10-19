import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = path.resolve(process.argv[2] ?? "/tmp/better-me-dependency-licenses");
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const groups = JSON.parse(execFileSync(command, ["licenses", "list", "--prod", "--json"], {
  encoding: "utf8", maxBuffer: 20 * 1024 * 1024, shell: process.platform === "win32",
}));
const installed = Object.values(groups).flat();
const manifest = [];
const htmlEscape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

await mkdir(target, { recursive: true });
for (const entry of installed.sort((left, right) => left.name.localeCompare(right.name))) {
  for (const packagePath of entry.paths) {
    const pkg = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8"));
    const id = `${pkg.name.replace(/^@/, "").replaceAll("/", "__")}@${pkg.version}`;
    if (!/^[\w.@+-]+$/.test(id)) throw new Error(`Unsafe dependency identifier: ${id}`);
    if (manifest.some((item) => item.id === id)) continue;
    const output = path.join(target, "packages", id);
    await mkdir(output, { recursive: true });
    const originalFiles = await readdir(packagePath, { withFileTypes: true });
    const notices = originalFiles.filter((file) => file.isFile()
      && /^(?:licen[cs]e|copying|notice|copyright)(?:$|[.-])/i.test(file.name));
    const fullLicense = notices.some((file) => /^(?:licen[cs]e|copying)(?:$|[.-])/i.test(file.name));
    const files = [];
    const copyText = async (sourceFile, outputName, provenance) => {
      const contents = await readFile(sourceFile);
      await writeFile(path.join(output, outputName), contents);
      files.push({ path: `packages/${id}/${outputName}`, source: provenance,
        sha256: createHash("sha256").update(contents).digest("hex") });
    };
    for (const file of notices) {
      await copyText(path.join(packagePath, file.name), file.name, "Installed package, unchanged");
    }

    if (!fullLicense) {
      if ((pkg.name === "hash.js" && pkg.version === "1.1.7")
        || (pkg.name === "isarray" && pkg.version === "1.0.0")
        || (pkg.name === "murmurhash-js" && pkg.version === "1.0.0")) {
        // These exact published packages put the full MIT text and copyright in README.
        const text = await readFile(path.join(packagePath, "README.md"), "utf8");
        if (!text.includes("Permission is hereby granted") || !text.includes("THE SOFTWARE IS PROVIDED")) {
          throw new Error(`Expected complete README license missing: ${id}`);
        }
        await copyText(path.join(packagePath, "README.md"), "README.md", "Full MIT text in published README, unchanged");
      } else if (pkg.name === "saxes" && pkg.version === "6.0.0" && pkg.license === "ISC") {
        const override = path.join(scriptRoot, "license-overrides", "saxes-6.0.0");
        const contents = await readFile(path.join(override, "LICENSE"));
        if (createHash("sha256").update(contents).digest("hex") !== "0fac2374380621b22e6b50451057721a9c52935b02d16d106a9f04897f061d0e") {
          throw new Error("Pinned saxes upstream license changed");
        }
        await copyText(path.join(override, "LICENSE"), "LICENSE", "Fixed upstream commit for saxes@6.0.0; provenance in NOTICE.md");
        await copyText(path.join(override, "NOTICE.md"), "NOTICE.md", "BetterMe provenance note");
      } else if (pkg.name === "boolbase" && pkg.version === "1.0.0" && pkg.license === "ISC") {
        const override = path.join(scriptRoot, "license-overrides", "boolbase-1.0.0");
        const contents = await readFile(path.join(override, "LICENSE"));
        if (createHash("sha256").update(contents).digest("hex") !== "cdf4d87ae0a6c160227263bf4e39a0a10e30e89ae7256e0f7ac7bde0836552c6") {
          throw new Error("Pinned boolbase upstream license changed");
        }
        await copyText(path.join(override, "LICENSE"), "LICENSE", "Fixed upstream commit; provenance in NOTICE.md");
        await copyText(path.join(override, "NOTICE.md"), "NOTICE.md", "BetterMe provenance note");
      } else if (pkg.name.startsWith("@napi-rs/canvas-")) {
        // Optional native platform archives omit LICENSE; use their same-version upstream package.
        const parent = installed.find((item) => item.name === "@napi-rs/canvas" && item.versions.includes(pkg.version));
        if (!parent || pkg.license !== "MIT") throw new Error(`No same-version canvas license: ${id}`);
        await copyText(path.join(parent.paths[0], "LICENSE"), "LICENSE", `Same-version @napi-rs/canvas@${pkg.version} upstream package; optional native platform archive`);
      } else {
        throw new Error(`Complete production dependency license missing: ${id}`);
      }
    }

    const metadata = { name: pkg.name, version: pkg.version, license: pkg.license ?? entry.license,
      homepage: pkg.homepage, repository: pkg.repository, author: pkg.author };
    await writeFile(path.join(output, "package-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    manifest.push({ id, ...metadata, files });
  }
}

// Do not accidentally collect just the private workspace root (which has no prod deps).
for (const required of ["react", "react-dom", "lucide-react", "docx", "mammoth", "pdfjs-dist", "zod", "maplibre-gl", "three"]) {
  if (!manifest.some((item) => item.name === required)) throw new Error(`Dependency coverage missing: ${required}`);
}
const report = { schemaVersion: 1, scope: "Locked workspace production dependencies, including server and optional dependencies as a superset of browser bundles", packages: manifest };
await writeFile(path.join(target, "manifest.json"), `${JSON.stringify(report, null, 2)}\n`);
const rows = manifest.map((item) => `<tr><td>${htmlEscape(item.name)}</td><td>${htmlEscape(item.version)}</td><td>${htmlEscape(typeof item.license === "string" ? item.license : JSON.stringify(item.license))}</td><td>${item.files.map((file) => `<a href="${file.path.split("/").map(encodeURIComponent).join("/")}">${htmlEscape(path.basename(file.path))}</a>`).join(" · ")}</td></tr>`).join("\n");
await writeFile(path.join(target, "index.html"), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BetterMe dependency notices</title><style>body{max-width:80rem;margin:2rem auto;padding:0 1rem;font:1rem/1.7 system-ui}table{border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #ddd;padding:.4rem .8rem}a{color:#185a43}</style>
<h1>Production dependency licenses and notices</h1><p>Generated from the locked pnpm workspace production dependency graph. This collection includes server and optional packages as a superset of the static browser bundles. Original license/notice bytes are retained; README-only and upstream fallbacks identify their provenance. These licenses apply to their respective dependencies.</p>
<p><a href="manifest.json">Version and SHA-256 manifest</a> · <a href="../">Template notices and scope</a></p>
<table><thead><tr><th>Package</th><th>Version</th><th>Declared license</th><th>Full text / notices</th></tr></thead><tbody>${rows}</tbody></table></html>\n`);
console.log(`Collected complete licenses/notices for ${manifest.length} production dependencies.`);
