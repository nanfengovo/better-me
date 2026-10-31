import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ATLAS_GEO_PUBLIC_FILES } from "./check-atlas-distribution.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let image = "better-me:docker-check";
let build = true;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--skip-build") {
    build = false;
  } else if (args[index] === "--image" && args[index + 1]) {
    image = args[++index];
  } else {
    throw new Error("Usage: node scripts/check-docker.mjs [--image tag] [--skip-build]");
  }
}

function docker(args, { inherit = false, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: root,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => { stdout += data; });
    child.stderr?.on("data", (data) => { stderr += data; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`docker ${args[0]} exceeded ${timeout / 1000}s`));
    }, timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`docker ${args[0]} failed (${code}): ${stderr || stdout}`));
    });
  });
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const containerName = `better-me-check-${randomUUID()}`;
let containerId;
let base;
let requests = 0;

async function request(urlPath, { status = 200, method = "GET" } = {}) {
  const response = await fetch(new URL(urlPath, base), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  requests += 1;
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, `${method} ${urlPath}: ${body.toString().slice(0, 180)}`);
  return { response, body };
}

function assertNotCached(response, label) {
  assert.match(response.headers.get("cache-control") ?? "", /(?:no-cache|no-store)/i, `${label} cache policy`);
}

async function sourceFiles(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sourceFiles(relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

try {
  if (build) {
    console.log(`Building ${image} from the repository Dockerfile...`);
    await docker(["build", "--target", "static", "--tag", image, "."], { inherit: true, timeout: 15 * 60_000 });
  }
  console.log(`Starting an isolated read-only container from ${image}...`);
  containerId = await docker([
    "run", "--detach", "--name", containerName,
    "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--publish", "127.0.0.1::8080", image,
  ]);
  assert.match(containerId, /^[a-f0-9]{64}$/i, "Docker must return this container's ID");
  const inspect = async () => JSON.parse(await docker(["inspect", containerId]))[0];
  let state;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    state = await inspect();
    assert.equal(state.State.Running, true, "Container must remain running");
    assert.ok(state.State.Health, "Image must define a HEALTHCHECK");
    if (state.State.Health.Status === "healthy") break;
    assert.notEqual(state.State.Health.Status, "unhealthy", "Container health check failed");
    await pause(1000);
  }
  assert.equal(state.State.Health.Status, "healthy", "Container did not become healthy within 60s");
  assert.equal(state.HostConfig.ReadonlyRootfs, true);
  assert.ok(state.HostConfig.CapDrop?.some((capability) => capability.toUpperCase() === "ALL"));
  assert.ok(state.HostConfig.SecurityOpt?.some((option) => /^no-new-privileges(?::true)?$/.test(option)));
  assert.ok(state.Config.User && !["root", "0", "0:0"].includes(state.Config.User), "Image USER must be non-root");
  const uid = Number(await docker(["exec", containerId, "id", "-u"]));
  assert.ok(Number.isSafeInteger(uid) && uid > 0, "Runtime UID must be non-root");
  const binding = state.NetworkSettings.Ports["8080/tcp"];
  assert.equal(binding?.length, 1, "Only one localhost port binding is expected");
  assert.equal(binding[0].HostIp, "127.0.0.1");
  assert.match(binding[0].HostPort, /^\d+$/);
  base = `http://127.0.0.1:${binding[0].HostPort}/`;

  const health = await request("/healthz");
  assert.match(health.response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(JSON.parse(health.body), { status: "ok", mode: "static" });

  const home = await request("/");
  const html = home.body.toString("utf8");
  assert.match(home.response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(html, /<div\s+id=["']root["']/);
  assertNotCached(home.response, "HTML");
  const entryPaths = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((match) => match[1]);
  assert.ok(entryPaths.some((name) => name.endsWith(".js")), "HTML must reference a root-based JS entry");
  assert.ok(entryPaths.some((name) => name.endsWith(".css")), "HTML must reference a root-based CSS entry");
  assert.doesNotMatch(html, /(?:src|href)=["']\/better-me\//, "Docker uses / rather than the Pages subpath");
  const refreshed = await request("/resume/check-refresh");
  assert.deepEqual(refreshed.body, home.body, "A deep link refresh must return the same app shell");
  assertNotCached(refreshed.response, "SPA fallback HTML");

  const webRoot = "/usr/share/nginx/html";
  const assetPaths = (await docker(["exec", containerId, "find", `${webRoot}/assets`, "-type", "f"]))
    .split(/\r?\n/).filter(Boolean).map((file) => file.slice(webRoot.length));
  for (const entry of entryPaths) assert.ok(assetPaths.includes(entry), `Entry asset exists: ${entry}`);
  const workerPaths = assetPaths.filter((file) => /pdf\.worker[^/]*\.mjs$/.test(file));
  assert.ok(workerPaths.length > 0, "Build must include the PDF worker");
  const mapWorkerPaths = assetPaths.filter((file) => /\/maplibre-gl-worker-[\w-]+\.mjs$/.test(file));
  assert.equal(mapWorkerPaths.length, 1, "Build must include the standalone ESM MapLibre worker");
  const lazyPaths = assetPaths.filter((file) => file.endsWith(".js") && !entryPaths.includes(file));
  assert.ok(lazyPaths.length > 0, "Build must include lazy JavaScript chunks");
  let javascript = "";
  const publishedAssetHashes = new Map();
  for (const assetPath of assetPaths) {
    const asset = await request(assetPath);
    assert.ok(asset.body.length > 0, `${assetPath} is not empty`);
    publishedAssetHashes.set(assetPath, createHash("sha256").update(asset.body).digest("hex"));
    const cache = asset.response.headers.get("cache-control") ?? "";
    assert.match(cache, /\bimmutable\b/, `${assetPath} immutable cache`);
    assert.match(cache, /\bmax-age=31536000\b/, `${assetPath} annual cache`);
    const mime = asset.response.headers.get("content-type") ?? "";
    if (/\.(?:m?js)$/.test(assetPath)) {
      assert.match(mime, /(?:application|text)\/(?:javascript|ecmascript)/, `${assetPath} JavaScript MIME`);
      javascript += asset.body.toString("utf8");
    } else if (assetPath.endsWith(".css")) {
      assert.match(mime, /text\/css/, `${assetPath} CSS MIME`);
    } else if (assetPath.endsWith(".geojson")) {
      assert.match(mime, /application\/geo\+json/, `${assetPath} GeoJSON MIME`);
    }
  }
  for (const worker of [...workerPaths, ...mapWorkerPaths]) {
    assert.ok(javascript.includes(path.posix.basename(worker)), `The app must reference its shipped worker: ${worker}`);
  }
  assert.ok(lazyPaths.some((file) => javascript.includes(path.posix.basename(file))), "App must reference lazy chunks");
  await request("/assets/__better_me_missing__.js", { status: 404 });
  await request("/assets/__missing__/chunk.css", { status: 404 });
  await request("/__better_me_missing__.js", { status: 404 });

  for (const urlPath of ["/api", "/api/jd/extract", "/api/network/status", "/api/v1/jobs/search"]) {
    for (const method of ["GET", "POST"]) {
      const api = await request(urlPath, { status: 501, method });
      assert.match(api.response.headers.get("content-type") ?? "", /application\/json/);
      assert.equal(JSON.parse(api.body).error, "local_service_required", `${method} ${urlPath} must explain the local-service boundary`);
      assertNotCached(api.response, `${method} ${urlPath}`);
    }
  }

  const legal = await request("/legal/");
  assert.match(legal.response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(legal.body.toString("utf8"), /(?:LICENSE|NOTICE|许可证|许可)/);
  assert.match(legal.body.toString("utf8"), /href="geography\/"/, "The distribution index links geography notices");
  const geographyIndex = await request("/legal/geography/");
  assert.match(geographyIndex.response.headers.get("content-type") ?? "", /text\/html/);
  const expectedGeographyFiles = [...ATLAS_GEO_PUBLIC_FILES, "index.html"].sort();
  const actualGeographyFiles = (await docker(["exec", containerId, "find", `${webRoot}/legal/geography`, "-maxdepth", "1", "-type", "f"]))
    .split(/\r?\n/).filter(Boolean).map((file) => path.posix.basename(file)).sort();
  assert.deepEqual(actualGeographyFiles, expectedGeographyFiles, "Only explicitly public geography files are shipped");
  for (const file of ATLAS_GEO_PUBLIC_FILES) {
    const published = await request(`/legal/geography/${file}`);
    assert.deepEqual(published.body, await readFile(path.join(root, "apps/web/src/components/atlas/geo", file)), `Unchanged public geography: ${file}`);
    assertNotCached(published.response, `Geography metadata ${file}`);
    assert.ok(geographyIndex.body.toString("utf8").includes(`href="${file}"`), `Geography index links ${file}`);
  }
  const geoManifest = JSON.parse((await request("/legal/geography/manifest.json")).body);
  const dotManifest = JSON.parse((await request("/legal/geography/dots-manifest.json")).body);
  for (const asset of [...geoManifest.assets, dotManifest]) {
    assert.ok(assetPaths.some((file) => file.startsWith(`/assets/${path.parse(asset.file).name}-`) && file.endsWith(".geojson") && publishedAssetHashes.get(file) === asset.sha256), `The rendered map asset matches its published provenance: ${asset.file}`);
  }
  for (const privatePath of ["/.env", "/.git/config", "/.agent-memory/activeContext.md", "/config/geography/gazetteer/manifest.json"]) await request(privatePath, { status: 404 });
  const licenseFiles = ["templates/README.md", "templates/CATALOG.md", "templates/catalog.json", ...await sourceFiles("templates/licenses")];
  for (const file of licenseFiles) {
    const published = await request(`/legal/${file}`);
    assert.deepEqual(published.body, await readFile(path.join(root, file)), `Published license/source metadata must match ${file}`);
  }
  const adaptedPrefix = "apps/web/src/components/templates/";
  const adaptedFiles = await sourceFiles(adaptedPrefix.slice(0, -1));
  assert.ok(adaptedFiles.length > 0, "Adapted template source must accompany the distribution");
  for (const file of adaptedFiles) {
    const published = await request(`/legal/adapted-source/templates/${file.slice(adaptedPrefix.length)}`);
    assert.deepEqual(published.body, await readFile(path.join(root, file)), `Published adapted source must match ${file}`);
  }
  const dependencies = await request("/legal/dependencies/");
  assert.match(dependencies.response.headers.get("content-type") ?? "", /text\/html/);
  const dependencyManifest = await request("/legal/dependencies/manifest.json");
  assert.match(dependencyManifest.response.headers.get("content-type") ?? "", /application\/json/);
  const manifest = JSON.parse(dependencyManifest.body);
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.packages) && manifest.packages.length > 0);
  const packageIds = new Set();
  let dependencyLicenseFiles = 0;
  for (const pkg of manifest.packages) {
    assert.ok(pkg.id && pkg.name && pkg.version && pkg.license, "Dependency identity and license are required");
    assert.ok(!packageIds.has(pkg.id), `Duplicate dependency ${pkg.id}`);
    packageIds.add(pkg.id);
    assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, `Missing license text: ${pkg.id}`);
    for (const file of pkg.files) {
      assert.ok(typeof file.path === "string" && file.path.startsWith(`packages/${pkg.id}/`) && !file.path.includes(".."));
      assert.match(file.sha256, /^[a-f0-9]{64}$/i);
      const published = await request(`/legal/dependencies/${file.path}`);
      assert.ok(published.body.length > 0, `Empty dependency license ${file.path}`);
      assert.equal(createHash("sha256").update(published.body).digest("hex"), file.sha256, `Dependency license SHA: ${file.path}`);
      dependencyLicenseFiles += 1;
    }
  }
  for (const required of ["maplibre-gl", "three"]) assert.ok(manifest.packages.some((pkg) => pkg.name === required), `Map engine complete notices: ${required}`);
  await request("/legal/templates/licenses/__missing__/LICENSE", { status: 404 });
  await request("/legal/geography/__missing__.geojson", { status: 404 });
  console.log(JSON.stringify({
    result: "passed", image, imageId: state.Image, runtimeUid: uid,
    readOnlyRootFilesystem: true, health: state.State.Health.Status,
    requests, assets: assetPaths.length, lazyChunks: lazyPaths.length,
    pdfWorkers: workerPaths.length, maplibreWorkers: mapWorkerPaths.length, geographyPublicFiles: actualGeographyFiles.length,
    licenseFiles: licenseFiles.length, adaptedSourceFiles: adaptedFiles.length,
    dependencyPackages: manifest.packages.length, dependencyLicenseFiles,
    scope: "Container health, HTTP resources/cache/MIME, API boundary and license distribution; not browser or visual acceptance.",
  }, null, 2));
} catch (error) {
  if (containerId) {
    console.error("Container logs:");
    await docker(["logs", "--tail", "80", containerId], { inherit: true }).catch(() => {});
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  // This random name belongs only to this run, including a partially failed `docker run`.
  try {
    await docker(["rm", "--force", containerId || containerName]);
  } catch (error) {
    if (containerId) {
      console.error(`Could not clean up this run's container ${containerId}:`, error);
      process.exitCode = 1;
    }
  }
}
