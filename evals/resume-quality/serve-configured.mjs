import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runIsolatedConfigured } from "./collect-configured.mjs";

/** Opt-in loopback operator bridge. The standalone page reads only the existing
 * LLM setting; this process receives it in memory, never logs its request body,
 * and can dispatch only the fixed public five cases. No career routes exist.
 */
export async function serveConfiguredGold({ outputDirectory, pageOrigin, providerOrigin, model, declaredRevision, port = 5340 }) {
  const page = new URL(pageOrigin), provider = new URL(providerOrigin);
  if (page.origin !== pageOrigin || page.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(page.hostname)
    || provider.origin !== providerOrigin || provider.protocol !== "https:" || !model || !declaredRevision) throw Error("explicit_operator_selection_required");
  const parent = await fs.realpath(path.dirname(outputDirectory));
  outputDirectory = path.join(parent, path.basename(outputDirectory));
  try { await fs.mkdir(outputDirectory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = await fs.lstat(outputDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(outputDirectory) !== outputDirectory) throw Error("private_operator_output_required");
  const claim = path.join(outputDirectory, "dispatch-claim.json"), stateFile = path.join(outputDirectory, "operator-status.json");
  let claimed = await fs.stat(claim).then(() => true, () => false);
  let state = { stage: claimed ? "previous_claim_observe_only" : "ready", selection: { providerOrigin, model, declaredRevision }, events: [] };
  if (claimed) {
    try { state = JSON.parse(await fs.readFile(stateFile, "utf8")); } catch { /* Unknown claimed operation never restarts. */ }
  }
  let pending;
  const save = async () => fs.writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Type", "application/json");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status, body) => { response.statusCode = status; response.end(JSON.stringify(body)); };
    if (request.headers.host !== `127.0.0.1:${server.address()?.port}` || origin !== pageOrigin) return send(403, { error: "operator_origin_rejected" });
    response.setHeader("Access-Control-Allow-Origin", pageOrigin);
    response.setHeader("Vary", "Origin");
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type"); return send(204, null);
    }
    if (request.method === "GET" && request.url === "/state") return send(200, { ...state, claimed });
    if (request.method !== "POST" || request.url !== "/run") return send(404, { error: "operator_route_missing" });
    if (claimed) return send(409, { error: "operator_already_claimed_observe_original" });
    if (request.headers["content-type"] !== "application/json") return send(415, { error: "operator_json_required" });
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 16_384) return send(413, { error: "operator_input_limit" }); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const settings = body.modelSettings, endpoint = new URL(settings.baseUrl);
      if (body.consent !== true || settings.model !== model || endpoint.origin !== providerOrigin || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || typeof settings.apiKey !== "string" || !settings.apiKey.trim()) return send(409, { error: "operator_selection_changed" });
      // Claim durably before any task or provider request; a reload or restarted
      // bridge cannot issue the five requests again, even after an unknown result.
      try { await fs.writeFile(claim, JSON.stringify({ at: new Date().toISOString(), providerOrigin, model, declaredRevision,
        planned: 5, maxModelCallsPerCase: 1, maxActiveMsPerCase: 300_000, publicGoldOnly: true }), { flag: "wx", mode: 0o600 }); }
      catch { claimed = true; return send(409, { error: "operator_already_claimed_observe_original" }); }
      claimed = true; state = { ...state, stage: "running", events: [] }; await save();
      pending = runIsolatedConfigured({ datasetDirectory: fileURLToPath(new URL("./gold/v1/", import.meta.url)),
        modelSettings: settings, outputDirectory: path.join(outputDirectory, "run"), declaredRevision,
        onProgress: async event => { state.events.push(event); await save(); console.log(JSON.stringify(event)); },
      }).then(async summary => { state = { ...state, stage: "completed", summary }; await save(); console.log(JSON.stringify({ stage: "completed", ...summary })); })
        .catch(async () => { state = { ...state, stage: "stopped", error: "configured_run_stopped_inspect_original_records_no_replay" }; await save(); console.log(JSON.stringify({ stage: "stopped", error: state.error })); });
      return send(202, { claimed: true, stage: state.stage });
    } catch { return send(400, { error: "operator_input_rejected" }); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  console.log(JSON.stringify({ bridge: `http://127.0.0.1:${server.address().port}`, pageOrigin, providerOrigin, model, outputDirectory, claimed }));
  return { server, get pending() { return pending; } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), names = ["--out", "--page-origin", "--provider-origin", "--model", "--revision"];
  if (args.length !== 10 || names.some((name, i) => args[i * 2] !== name)) throw Error("explicit_operator_flags_required");
  const bridge = await serveConfiguredGold({ outputDirectory: path.resolve(args[1]), pageOrigin: args[3], providerOrigin: args[5], model: args[7], declaredRevision: args[9] });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void (async () => {
    await bridge.pending; bridge.server.close();
  })(); });
}
