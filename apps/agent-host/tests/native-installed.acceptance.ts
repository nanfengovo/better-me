/** Opt-in: actual installed binaries, real macOS sandbox, local synthetic TLS
 * providers only. No ambient accounts, public provider requests or paid calls.
 * node --import tsx --test apps/agent-host/tests/native-installed.acceptance.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { RuntimeRegistry } from "../src/runtime/registry.js";
import { nativeLaunch, NativeOutput, type NativeId } from "../src/native-tools/adapters.js";
import { IsolatedNativeProcess } from "../src/native-tools/process.js";
import type { NativeProcessInput } from "../src/native-tools/process.js";
import { NativeAccountTools } from "../src/native-tools/service.js";
import { AgentRouting } from "../src/routing/service.js";
import { randomUUID } from "node:crypto";

const answer = "synthetic-native-answer";
const longAnswer = "OUTPUT_START_" + "完整输出".repeat(8000) + "_OUTPUT_END";
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
test("actual installed CLIs exchange text with synthetic TLS providers inside the production OS sandbox", { skip: process.platform !== "darwin", timeout: 160_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-native-installed-"));
  const cert = path.join(directory, "fixture-cert.pem"), key = path.join(directory, "fixture-key.pem");
  await promisify(execFile)("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=fixture.invalid", "-addext", "subjectAltName=DNS:fixture.invalid"], { timeout: 20_000 });
  let current: NativeId = "codex";
  const requests: string[] = [], unknown: string[] = [];
  let nativeClaude = false, nativeClaudeRequests = 0, expectedPrompt: string | undefined, observedFullPrompt = false, providerAnswer = answer;
  const server = https.createServer({ cert: await fs.readFile(cert), key: await fs.readFile(key) }, async (req, res) => {
    const chunks: Buffer[] = []; try { for await (const chunk of req) chunks.push(Buffer.from(chunk)); } catch { return; }
    const input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const answer = providerAnswer;
    if (expectedPrompt && req.url?.includes("/responses")) observedFullPrompt = JSON.stringify(input).includes(expectedPrompt);
    requests.push(`${current}:${req.url}`);
    if (nativeClaude && req.url?.includes("/messages")) {
      assert.equal(req.headers.authorization, "Bearer synthetic-native-claude-access-token");
      assert.equal(req.headers["x-api-key"], undefined, "native OAuth must not turn into an API-key request");
      nativeClaudeRequests++;
    }
    // Credentials are synthetic. The provider must never receive host paths or
    // another owner's material, nor an enabled native tool definition.
    assert.ok(!JSON.stringify(input).includes(os.homedir()), "provider must not receive the host home path");
    assert.doesNotMatch(JSON.stringify(input), /synthetic-other-owner/);
    // Gemini SDK emits [{functionDeclarations: []}], which advertises zero
    // functions. Any actual function or built-in provider tool remains denied.
    const definitions = Array.isArray(input.tools) ? input.tools.flatMap((tool: Record<string, unknown>) =>
      Object.keys(tool).length === 1 && Array.isArray(tool["functionDeclarations"]) ? tool["functionDeclarations"] : [tool]) : [];
    // Current Codex always declares request_user_input even in exec. It has no
    // host execution capability, and NativeOutput still rejects any invocation.
    // Do not loosen this to permit shell, MCP, goals or code-mode declarations.
    const executionDefinitions = current === "codex" ? definitions.filter((tool: Record<string, unknown>) => !(tool.type === "function" && tool.name === "request_user_input")) : definitions;
    assert.equal(executionDefinitions.length, 0, `${current} must not advertise native execution tools: ${JSON.stringify(executionDefinitions.map((tool: Record<string, unknown>) => ({type:tool.type,name:tool.name,functionName:(tool.function as {name?:string}|undefined)?.name})))}`);
    if (req.url?.includes("count_tokens")) { res.setHeader("Content-Type", "application/json"); res.end('{"input_tokens":12}'); return; }
    if (req.url?.includes("/messages")) {
      res.setHeader("Content-Type", "text/event-stream");
      res.end(event("message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [], model: input.model, stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } })
        + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
        + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } })
        + event("content_block_stop", { type: "content_block_stop", index: 0 })
        + event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } })
        + event("message_stop", { type: "message_stop" })); return;
    }
    if (req.url?.includes("chat/completions")) {
      res.setHeader("Content-Type", "text/event-stream");
      const frame = (delta: unknown, reason: string | null) => `data: ${JSON.stringify({ id: "chat_fixture", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      res.end(frame({ role: "assistant", content: answer }, null) + frame({}, "stop") + "data: [DONE]\n\n"); return;
    }
    if (req.url?.includes("GenerateContent") || req.url?.includes("generateContent")) {
      const data = { candidates: [{ content: { role: "model", parts: [{ text: answer }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 }, modelVersion: "gemini-2.5-flash" };
      res.setHeader("Content-Type", req.url.includes("stream") ? "text/event-stream" : "application/json");
      res.end(req.url.includes("stream") ? `data: ${JSON.stringify(data)}\n\n` : JSON.stringify(data)); return;
    }
    if (req.url?.includes("/responses")) {
      res.setHeader("Content-Type", "text/event-stream");
      const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] };
      const response = { id: "resp_fixture", object: "response", created_at: 1, model: input.model, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } };
      res.end(event("response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } })
        + event("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } })
        + event("response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
        + event("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: answer })
        + event("response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: answer })
        + event("response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] })
        + event("response.output_item.done", { type: "response.output_item.done", output_index: 0, item })
        + event("response.completed", { type: "response.completed", response })); return;
    }
    unknown.push(req.url ?? "empty"); res.writeHead(400); res.end('{"error":{"message":"unsupported synthetic route"}}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const runner = new IsolatedNativeProcess({ connectProvider: async host => {
    assert.equal(host, "fixture.invalid", "acceptance must never contact a public provider");
    return net.connect({ host: "127.0.0.1", port: address.port });
  } });
  try {
    assert.equal(await runner.isolation(), true, "OS isolation sentinel must pass, not be skipped");
    await t.test("process metadata boundary", async () => {
      const own = path.join(directory, "process-probe"); await fs.mkdir(own, { mode: 0o700 });
      const outsider = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)", "synthetic-other-process"], { stdio: "ignore" });
      try {
        assert.ok(outsider.pid);
        const script = "const r=require('node:child_process').spawnSync('/bin/ps',['-p',process.argv[1],'-o','command=']);if(r.stdout?.toString().trim())process.exit(9);console.log('process-boundary-ok');";
        assert.equal((await runner.run({ command: process.execPath, args: ["-e", script, String(outsider.pid)], directory: own, hosts: [], timeoutMs: 5000 })).trim(), "process-boundary-ok");
      } finally { outsider.kill(); }
    });
    await t.test("network boundary", async () => {
      const own = path.join(directory, "network-probe"); await fs.mkdir(own, { mode: 0o700 });
      const script = `const net=require('node:net'),http=require('node:http');
        (async()=>{
          if(process.env.OPENAI_API_KEY||process.env.SSH_AUTH_SOCK)throw Error('inherited_credentials');
          await new Promise((ok,bad)=>{const s=net.connect(Number(process.argv[1]),'127.0.0.1');s.on('error',()=>ok());s.on('connect',()=>{s.destroy();bad(Error('direct_local_network_allowed'))});s.setTimeout(1500,()=>{s.destroy();bad(Error('unknown_network_result'))})});
          const p=new URL(process.env.HTTPS_PROXY);
          await new Promise((ok,bad)=>{const r=http.request({host:p.hostname,port:p.port,method:'CONNECT',path:'not-authorized.invalid:443',headers:{'Proxy-Authorization':'Basic '+Buffer.from(decodeURIComponent(p.username)+':'+decodeURIComponent(p.password)).toString('base64')}});r.on('error',bad);r.on('connect',(response,s)=>{s.destroy();response.statusCode===403?ok():bad(Error('unapproved_provider_allowed'))});r.end()});
          console.log('network-boundary-ok');
        })().catch(()=>process.exit(9));`;
      assert.equal((await runner.run({ command: process.execPath, args: ["-e", script, String(address.port)], directory: own, hosts: [], timeoutMs: 5000 })).trim(), "network-boundary-ok");
      assert.equal((await runner.run({ command: process.execPath, args: ["-e", script, String(address.port)], directory: own, hosts: [], loopbackLoginListener: true, timeoutMs: 5000 })).trim(), "network-boundary-ok", "login listener must not enable outbound local networking");
    });
    const registry = new RuntimeRegistry(); await registry.discoverExecutables();
    const selected = process.env["BETTERME_NATIVE_ACCEPTANCE_IDS"]?.split(",");
    for (const id of ["codex", "opencode", "gemini-cli", "claude-code"] as const) {
      if (selected && !selected.includes(id)) continue;
      await t.test(id, { timeout: 35_000 }, async () => {
      current = id;
      const command = registry.get(id)?.resolvedCommand; assert.ok(command, `${id} is not installed`);
      const own = path.join(directory, id); await fs.mkdir(own, { mode: 0o700 });
      const ownCert = path.join(own, "fixture-ca.pem"); await fs.copyFile(cert, ownCert);
      const launch = await nativeLaunch(id, { generation: "synthetic", mode: "api-key", apiKey: "synthetic-unused-provider-key", model: id === "gemini-cli" ? "gemini-2.5-flash" : id === "codex" ? "gpt-5.4" : "synthetic-model", endpoint: `https://fixture.invalid${id === "codex" || id === "opencode" ? "/v1" : ""}` }, own);
      const decoder = new NativeOutput(id), frames: string[] = [], diagnostic: string[] = [];
      try {
        await runner.run({ command, ...launch, directory: own, environment: { ...launch.environment, SSL_CERT_FILE: ownCert, NODE_EXTRA_CA_CERTS: ownCert }, stdin: "Respond with a synthetic text-only answer. Never use tools.", timeoutMs: 30_000,
          onOutput: chunk => { frames.push(chunk); decoder.feed(chunk); }, onControlOutput: chunk => diagnostic.push(chunk) });
        assert.equal(decoder.finish(), answer);
        assert.ok(requests.some(request => request.startsWith(`${id}:`)), "actual CLI must reach the synthetic provider");
      } catch (error) {
        // Synthetic data only; no actual keys/accounts are present in this test.
        t.diagnostic(`${id} synthetic frames: ${frames.join("").slice(-2500)}; synthetic diagnostics: ${diagnostic.join("").slice(-3000)}`); throw error;
      }
      });
    }
    await t.test("the normal owner-scoped Codex service passes complete long input and output through the installed CLI", { timeout: 40_000 }, async () => {
      current = "codex";
      const own = path.join(directory, "owner-codex-full-context"); await fs.mkdir(own, { mode: 0o700 });
      const service = new NativeAccountTools({ directory: path.join(own, "accounts"), registry, runner: {
        isolation: () => runner.isolation(),
        run: async input => {
          const runCert = path.join(input.directory, "fixture-ca.pem"); await fs.copyFile(cert, runCert);
          return runner.run({ ...input, environment: { ...input.environment, SSL_CERT_FILE: runCert, NODE_EXTRA_CA_CERTS: runCert } });
        },
      } });
      const lease = { session: "synthetic-owner-codex", valid: async () => true };
      expectedPrompt = "INPUT_START_" + "完整输入".repeat(10000) + "_INPUT_END";
      providerAnswer = longAnswer;
      try {
        await service.authorizeApi("codex", { mode: "api-key", consent: true, apiKey: "synthetic-unused-provider-key", model: "gpt-5.4", endpoint: "https://fixture.invalid/v1" }, lease);
        const reasoner = await service.reasoner("codex", lease);
        assert.equal(await reasoner(expectedPrompt, new AbortController().signal), longAnswer);
        assert.equal(observedFullPrompt, true, "the provider receives every input character, not just tail markers");
        assert.equal((await service.capabilities()).find(item => item.id === "codex")?.code, "ready");
      } finally { expectedPrompt = undefined; providerAnswer = answer; await service.close(); }
    });
    await t.test("native Claude uses only the isolated OAuth file, not an API key or host login", { timeout: 40_000 }, async () => {
      const command = registry.get("claude-code")?.resolvedCommand; assert.ok(command);
      const own = path.join(directory, "native-claude-oauth"); await fs.mkdir(path.join(own, "claude"), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(own, "claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: {
        accessToken: "synthetic-native-claude-access-token", refreshToken: "synthetic-native-claude-refresh-token", expiresAt: Date.now() + 3_600_000,
        scopes: ["user:inference", "user:profile"], subscriptionType: "pro", rateLimitTier: "default_claude_pro",
      } }), { mode: 0o600 });
      const ownCert = path.join(own, "fixture-ca.pem"); await fs.copyFile(cert, ownCert);
      const launch = await nativeLaunch("claude-code", { generation: randomUUID(), mode: "native", model: "synthetic-model" }, own);
      assert.ok(!launch.args.includes("--bare")); assert.equal(launch.environment["ANTHROPIC_API_KEY"], undefined);
      const decoder = new NativeOutput("claude-code"), frames: string[] = [], diagnostics: string[] = [];
      current = "claude-code"; nativeClaude = true;
      try {
        await runner.run({ command, ...launch, directory: own, hosts: ["fixture.invalid"],
          environment: { ...launch.environment, ANTHROPIC_BASE_URL: "https://fixture.invalid", SSL_CERT_FILE: ownCert, NODE_EXTRA_CA_CERTS: ownCert },
          stdin: "Respond with a synthetic text-only answer. Never use tools.", timeoutMs: 30_000,
          onOutput: chunk => { frames.push(chunk); decoder.feed(chunk); }, onControlOutput: chunk => diagnostics.push(chunk) });
        assert.equal(decoder.finish(), answer); assert.ok(nativeClaudeRequests > 0);
      } catch (failure) { t.diagnostic(`synthetic native Claude frames: ${frames.join("").slice(-2500)}; diagnostics: ${diagnostics.join("").slice(-3000)}`); throw failure; }
      finally { nativeClaude = false; }
    });
    await t.test("native Claude login initializes offline and is cancelled before any account/provider request", { timeout: 15_000 }, async () => {
      const command = registry.get("claude-code")?.resolvedCommand; assert.ok(command);
      const own = path.join(directory, "native-login"); await fs.mkdir(own, { mode: 0o700 });
      const controller = new AbortController(); let output = "", valid = false;
      try {
        await runner.run({ command, args: ["auth", "login", "--claudeai"], directory: own, hosts: [], environment: { BROWSER: "/usr/bin/false" }, loopbackLoginListener: true, onStdinReady: () => {}, timeoutMs: 10_000, signal: controller.signal,
          onControlOutput: chunk => { output += chunk; const raw = output.match(/https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+/)?.[0]; if (!raw) return; const url = new URL(raw); valid = url.searchParams.get("code_challenge_method") === "S256" && url.searchParams.get("redirect_uri") === "https://platform.claude.com/oauth/code/callback"; controller.abort(); } });
      } catch (error) { if (!valid) throw error; }
      assert.equal(valid, true); output = "";
    });
    await t.test("owner router executes the real installed backup without Codex or a public provider", { timeout: 50_000 }, async () => {
      const own = path.join(directory, "owner-routing");
      const decorated = { isolation: () => runner.isolation(), async run(input: NativeProcessInput) {
        const ownCert = path.join(input.directory, "fixture-ca.pem"); await fs.copyFile(cert, ownCert);
        return runner.run({ ...input, environment: { ...input.environment, SSL_CERT_FILE: ownCert, NODE_EXTRA_CA_CERTS: ownCert } });
      } };
      const native = new NativeAccountTools({ directory: path.join(own, "native"), registry, runner: decorated });
      const routing = new AgentRouting({ directory: path.join(own, "routing"), native, scan: async () => { await registry.discoverExecutables(); } });
      const lease = { session: "synthetic-real-process", valid: async () => true };
      try {
        await native.authorizeApi("opencode", { mode: "api-key", apiKey: "synthetic-owner-key", model: "synthetic-model", endpoint: "https://fixture.invalid/v1", consent: true }, lease);
        const policy = await routing.update({ expectedRevision: 0, mode: "auto", preferred: "codex", backups: ["opencode"], allowApiBackups: true, consent: true }, lease);
        current = "opencode"; const id = randomUUID(), before = requests.length;
        const reply = await routing.run(id, policy.revision, "synthetic task, no native tools", new AbortController().signal, lease);
        assert.equal(reply.text, answer); assert.equal(reply.trace.runtimeId, "opencode");
        assert.ok(reply.trace.attempts.some(attempt => attempt.runtimeId === "codex" && attempt.status === "skipped"), "An installed but unconnected Codex is not implicitly authorized");
        assert.ok(requests.length > before);
        const count = requests.length; await routing.run(id, policy.revision, "synthetic task, no native tools", new AbortController().signal, lease); assert.equal(requests.length, count, "idempotent retry must not dispatch again");
      } finally { await routing.close(); await native.close(); }
    });
    assert.deepEqual(unknown, []);
    t.diagnostic(`synthetic provider request paths: ${requests.join(", ")}`);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); }
});
