/**
 * server.ts — Minimal HTTP API for agent-host.
 *
 * Routes:
 *
 *   POST /api/v1/agent/tasks, /:id/start, /:id/jd-review
 *     → Owner-kernel JD analysis, explicit frozen-material grant, shared ledger.
 *   POST /api/v1/agent/jd-match/{start,resume}
 *     → 410. No legacy executor or fallback bypasses the task ledger.
 *
 *   GET  /api/v1/agent/jd-match/state/:threadId
 *     → Returns current checkpoint state for debugging / page-refresh recovery.
 *
 * Security:
 *   - modelSettings.apiKey is consumed in-flight only; never logged or stored.
 *   - CORS is restricted to the same origins as job-service.
 *   - Bearer token auth mirrors job-service pattern.
 */

import http from "node:http";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { z } from "zod";
import { DeepSeekApiError } from "./model.js";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { encodeSseEvent } from "./events/event-bus.js";
import { AgentRunManager } from "./runs/run-manager.js";
import type { SandboxMode } from "./runs/sandbox.js";
import { RuntimeRegistry } from "./runtime/registry.js";
import type { RuntimeAgentDef } from "@better-me/agent-contracts";
import { resolveCheckpointPath } from "./checkpointer.js";
import { ProjectUnderstandingService } from "./understanding/service.js";
import { createUnderstandingHandler, type UnderstandingRuntime } from "./understanding/http.js";
import { AgentRouting } from "./routing/service.js";
import { createRoutingHandler } from "./routing/http.js";
import { NativeAccountTools } from "./native-tools/service.js";
import type { NativeProcessRunner } from "./native-tools/process.js";
import type { UnderstandingReasoner } from "@better-me/agent-contracts";
import { studioAnalysisRuntime } from "@better-me/agent-contracts";
import type { LocalOllamaClient } from "./privacy/local-ollama.js";
import type { StudioLocalRuntime } from "@better-me/agent-contracts/career-studio";
import { StudioError } from "./career-studio/storage.js";
import { CareerTaskError } from "./tasks/evidence.js";
import { ChatGptPlanService } from "./chatgpt/service.js";
import { createChatGptHandler } from "./chatgpt/http.js";
import { createHash } from "node:crypto";
import { IdentityService, IdentityError, type Principal } from "./identity/service.js";
import { OwnedStore } from "./identity/owned-store.js";
import { RecoveryCatalog } from "./identity/recovery.js";
import { OidcService, OIDC_CALLBACK_PATH, type OidcOptions } from "./identity/oidc.js";
import { unconfiguredSocialLogin } from "./identity/social-login.js";
import { EvidenceBroker } from "./understanding/evidence-broker.js";
import { vorkService } from "./vork/service.js";
import { CareerCapabilities } from "./capabilities/service.js";
import { handleCapabilities } from "./capabilities/http.js";
import type { ToolBuilder } from "./capabilities/ollama.js";
import { SandboxBuildService, SandboxBuildError } from "./sandbox/build-service.js";
import { CodingTaskService, CodingTaskError } from "./sandbox/coding-tasks.js";
import { CodingLeases } from "./sandbox/coding-leases.js";
import { CodingAutoRuns } from "./sandbox/coding-auto.js";
import { handleSandboxCoding } from "./sandbox/coding-http.js";
import { AgentTaskKernel } from "./kernel/service.js";
import { createCareerTaskHandler } from "./tasks/http.js";
import { createCareerTaskRuntimeResolver } from "./tasks/runtime.js";
import type { CareerTaskReasoner } from "./kernel/model-protocol.js";
import { CareerStudio } from "./career-studio/service.js";
import { createCareerStudioHttp } from "./career-studio/http.js";
import type { CareerFinalExportRenderer } from "./career-studio/final-export-http.js";
import type { VerifiedJobResolver } from "./career-studio/verified-jobs.js";
import type { ConfiguredCareerMcpServer } from "./career-studio/mcp-client-http.js";
import type { CloudPrivacyAdapter } from "./privacy/types.js";
import type { loadCareerOperatorConfig } from "./career-studio/operator-config.js";
import { GrowthJourneys, GrowthJourneyError } from "./growth/service.js";
import { handleGrowthJourneys } from "./growth/http.js";

// ── Server factory ────────────────────────────────────────────────────────────

export interface ServerOptions {
  port: number;
  host: string;
  /** Allowed origins for CORS (should match job-service origins). */
  allowedOrigins: string[];
  /** Bearer token expected on all requests. */
  authToken: string;
  checkpointer: SqliteSaver;
  /** Optional override used by tests and local development. */
  runsDirectory?: string;
  /** Optional registry definitions override for embedded hosts and tests. */
  runtimeDefinitions?: RuntimeAgentDef[];
  /** Global process isolation policy; individual runs may tighten it. */
  sandboxMode?: SandboxMode;
  /** Separate opt-in evidence/history store; never the resume or jobs database. */
  understandingDirectory?: string;
  understandingTurnTimeoutMs?: number;
  /** @deprecated Legacy turns are retired. Use careerTaskReasoner for isolated task fixtures. */
  understandingReasoner?: (runtime: UnderstandingRuntime) => Promise<UnderstandingReasoner>;
  /** Trusted synthetic task fixture only; never accepted from HTTP. */
  careerTaskReasoner?: (runtime: UnderstandingRuntime) => Promise<CareerTaskReasoner>;
  /** Trusted metadata fixture; never accepted from HTTP. */
  careerStudioLocalClient?: (runtime: StudioLocalRuntime) => LocalOllamaClient;
  /** Separate OAuth store; never a resume/jobs database or a CLI auth directory. */
  chatGptDirectory?: string;
  chatGptAuthorizationUnavailableReason?: string;
  /** Trusted embedding/testing seam, never supplied through HTTP. */
  chatGptService?: ChatGptPlanService;
  /** New owner-only root. Legacy runs, sessions, credentials and checkpoints are never claimed. */
  identityDirectory?: string;
  /** Trusted installation configuration, never accepted from an HTTP request. */
  oidc?: OidcOptions;
  /** Trusted single-OS-user embedding only. Not exposed by CLI or HTTP. Unsafe for account isolation. */
  trustedSingleUserRuntimeExecution?: boolean;
  /** Trusted synthetic regression seam only; no HTTP-provided executables/runners. */
  nativeProcessRunner?: NativeProcessRunner;
  /** Trusted regression seam only; HTTP cannot supply executable source/builders. */
  capabilityBuilder?: ToolBuilder;
  /** Local coding contract fixtures for trusted embeddings; never configurable by HTTP. */
  sandboxCoding?: Pick<ConstructorParameters<typeof CodingTaskService>[0],"generate"|"resolveModel">;
  /** Trusted operator configuration; HTTP/model output cannot install servers. */
  careerMcpServers?: readonly ConfiguredCareerMcpServer[];
  careerPrivacyCloud?: CloudPrivacyAdapter;
  careerOperator?: Awaited<ReturnType<typeof loadCareerOperatorConfig>>;
  /** Trusted Vork installation path only. Source scenes are never accepted. */
  careerVorkBinary?: string;
  /** Installation-owned renderer; browser requests cannot select executables. */
  careerFinalExportRenderer?: CareerFinalExportRenderer;
  /** Read-only JobService authority; HTTP coordinate flags are never trusted. */
  careerVerifiedJobResolver?: VerifiedJobResolver;
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let oversized = false;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    byteLength += buffer.length;
    if (byteLength > maxBytes) {
      oversized = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (oversized) {
    const error = Object.assign(new Error("request_body_too_large"),{code:"request_body_too_large",status:413});
    error.name = "PayloadTooLargeError";
    throw error;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

export function createAgentServer(opts: ServerOptions): http.Server {
  const runtimeRegistry = new RuntimeRegistry({ definitions: opts.runtimeDefinitions });
  const understandingRegistry = new RuntimeRegistry({ definitions: opts.runtimeDefinitions });
  let runtimeScan: Promise<unknown> | undefined;
  const identityRoot = opts.identityDirectory ?? path.join(opts.runsDirectory ?? path.dirname(resolveCheckpointPath()), "accounts-v1");
  const identities = new IdentityService(identityRoot);
  const codingLeases = new CodingLeases(identityRoot);
  const codingOwners = new Map<string,{tasks:CodingTaskService;auto:CodingAutoRuns}>();
  const oidc = opts.oidc ? new OidcService(opts.oidc, identities) : undefined;
  function makeOwner(principal: Principal) {
    // principal.id is server-generated and authenticated, never a request path/body field.
    const root = path.join(identityRoot, "owners", principal.id);
    const recovery = new RecoveryCatalog(root, principal.id);
    const understanding = new ProjectUnderstandingService({ storageDir: path.join(root, "understanding"), turnTimeoutMs: opts.understandingTurnTimeoutMs,
      recovered: id => recovery.session(id),
      broker: new EvidenceBroker({ forbiddenRoots: [identityRoot, path.dirname(resolveCheckpointPath()),
        ...[opts.runsDirectory, opts.understandingDirectory, opts.chatGptDirectory].filter((value): value is string => Boolean(value))] }),
    });
    const chatGpt = new ChatGptPlanService({ directory: path.join(root, "chatgpt"), authorizationUnavailableReason: opts.chatGptAuthorizationUnavailableReason });
    // A trusted injected fixture is single-owner only; it can never become a shared credential service.
    const provider: ChatGptPlanService = opts.chatGptService && owners.size === 0 ? opts.chatGptService : chatGpt;
    const nativeTools = new NativeAccountTools({ directory: path.join(root, "native-tools-v1"), registry: understandingRegistry, runner: opts.nativeProcessRunner });
    const routing = new AgentRouting({ directory: path.join(root, "routing-v1"), native: nativeTools, scan: async () => { await understandingRegistry.discoverExecutables(); } });
    const careerTasks = new AgentTaskKernel({ ownerId: principal.id, directory: path.join(root, "career-tasks-v1"),
      validateStudioAnalysis: async (task, access) => {
        try { await getStudioHttp().studio.validateAnalysis(task, access); }
        catch (error) { if (error instanceof StudioError) throw new CareerTaskError(error.code, error.status); throw error; }
      },
      validateStudioCommittee: async (task, access) => {
        try { return await getStudioHttp().studio.validateAnalysis(task, access); }
        catch (error) { if (error instanceof StudioError) throw new CareerTaskError(error.code, error.status); throw error; }
      },
      broker: new EvidenceBroker({ forbiddenRoots: [identityRoot, path.dirname(resolveCheckpointPath()),
        ...[opts.runsDirectory, opts.understandingDirectory, opts.chatGptDirectory].filter((value): value is string => Boolean(value))] }),
    });
    const taskRuntime = createCareerTaskRuntimeResolver({ nativeTools, routing, chatGpt: provider, reasoner: opts.careerTaskReasoner,
      scan: async () => { await understandingRegistry.discoverExecutables(); } });
    // Studio's private ledger is opt-in. Ordinary resume/routing requests must
    // not create its stores or depend on its optional renderer/adapters.
    let studioHttp: ReturnType<typeof createCareerStudioHttp> | undefined;
    const getStudioHttp = () => {
      if (studioHttp) return studioHttp;
      const studioBroker = new EvidenceBroker({ forbiddenRoots: [identityRoot, path.dirname(resolveCheckpointPath()),
        ...[opts.runsDirectory, opts.understandingDirectory, opts.chatGptDirectory].filter((value): value is string => Boolean(value))] });
      const studio = new CareerStudio({ ownerId: principal.id, directory: path.join(root, "career-studio-v1"), vorkBinary: opts.careerVorkBinary, resolveVerifiedJob: opts.careerVerifiedJobResolver,
        ...(opts.careerOperator ? { resolveVorkBinary: () => opts.careerOperator!.getVorkBinary() } : {}),
        broker: studioBroker,
        committeeTasks: {
          get: async (id, access) => { if (!await access.valid()) throw new StudioError("studio_interaction_invalid", 403);
            const task = await careerTasks.readTask(id); if (task.kind !== "studio_committee") throw new StudioError("studio_operation_not_found", 404); return task; },
          list: async (contextId, access) => { if (!await access.valid()) throw new StudioError("studio_interaction_invalid", 403);
            return (await careerTasks.listTasks()).filter((task): task is import("@better-me/agent-contracts").StudioCommitteeTask => task.kind === "studio_committee" && task.request.contextId === contextId); },
          describe: (id, access) => careerTasks.describeStudioCommittee(id, access),
          review: (id, access) => careerTasks.reviewStudioCommittee(id, access),
        },
        ...(opts.careerStudioLocalClient ? { localClient: opts.careerStudioLocalClient } : {}),
      });
      studioHttp = createCareerStudioHttp({ studio, ownerId: principal.id, baseURL: serverOrigin(), allowedOrigins: [...new Set([...opts.allowedOrigins, serverOrigin()])],
        mcpServers: opts.careerMcpServers, cloud: opts.careerOperator?.configuredCloud ?? opts.careerPrivacyCloud,
        ...(opts.careerOperator ? { getMcpServers: () => opts.careerOperator!.getMcpServers(), assertConfiguration: () => opts.careerOperator!.assertCurrent() } : {}),
        privacyBroker: studioBroker, finalExportRenderer: opts.careerFinalExportRenderer, readBody, sendJson: jsonResponse });
      return studioHttp;
    };
    let growthJourneys: GrowthJourneys | undefined;
    let growthKernel: AgentTaskKernel | undefined;
    const getGrowthJourneys = () => {
      // Synthetic validation uses the existing Kernel implementation, but never
      // scans or claims the user's real career-task history or root ledger.
      growthKernel ??= new AgentTaskKernel({ ownerId: principal.id, directory: path.join(root, "growth-synthetic-tasks-v1") });
      return growthJourneys ??= new GrowthJourneys({ ownerId: principal.id, directory: path.join(root, "growth-journeys-v1"), kernel: growthKernel });
    };
    const closeGrowthJourneys = async () => { try { await growthJourneys?.close(); } finally { await growthKernel?.close(); } };
    const invalidateGrowthSession = async (session: string) => { growthJourneys?.invalidateSession(session); await growthKernel?.invalidateSession(session); };
    return { understanding, nativeTools, routing, careerTasks, taskRuntime, getGrowthJourneys, closeGrowthJourneys, invalidateGrowthSession, getStudioHttp, peekStudioHttp: () => studioHttp, chatGpt: provider, recovery, store: new OwnedStore(path.join(root, "records"), principal.id,
      (namespace, key) => namespace === "continuity" ? recovery.continuity(key) : Promise.resolve(undefined)),
      runManager: new AgentRunManager({ registry: runtimeRegistry, rootDirectory: path.join(root, "runs"), sandboxMode: opts.sandboxMode }),
      handleChatGpt: createChatGptHandler({ service: provider, allowedOrigins: opts.allowedOrigins, readBody, sendJson: jsonResponse }),
      handleRouting: createRoutingHandler({ service: routing, readBody, sendJson: jsonResponse }),
      handleCareerTasks: createCareerTaskHandler({ ownerId:principal.id, service: careerTasks, readBody, sendJson: jsonResponse,
        resolveReasoner: async (runtime, lease, task, cancel) => {
          if (task.kind === "studio_analysis" || task.kind === "studio_committee") {
            if (!isDeepStrictEqual(runtime, studioAnalysisRuntime(task.request.runtime.model))) throw Object.assign(new Error("studio_task_runtime_mismatch"), { code: "studio_task_runtime_mismatch", status: 422 });
            await getStudioHttp().studio.validateAnalysis(task, lease);
          }
          return taskRuntime(runtime, lease, task, cancel);
        },
      }),
      handleUnderstanding: createUnderstandingHandler({ service: understanding, registry: understandingRegistry,
        nativeTools: opts.trustedSingleUserRuntimeExecution ? undefined : nativeTools,
        allowNativeExecution: opts.trustedSingleUserRuntimeExecution === true,
        ensureRuntimeScan: async () => { await understandingRegistry.discoverExecutables(); }, readBody, sendJson: jsonResponse }),
    };
  }
  const owners = new Map<string, ReturnType<typeof makeOwner>>();
  const ownerStreams = new Map<string, Set<http.ServerResponse>>();
  const capabilityOwners = new Map<string, CareerCapabilities>();
  const capabilitySession = (cookie: string | undefined) => createHash("sha256")
    .update((cookie ?? "").split(";").map(item => item.trim()).find(item => item.startsWith("betterme_session=")) ?? "").digest("hex");
  const invalidateCapabilitySession = async (cookie: string | undefined) => {
    if (!cookie) return;
    const previous = await identities.authenticate(cookie);
    if (previous) {
      owners.get(previous.id)?.taskRuntime.invalidateSession(capabilitySession(cookie));
      await codingLeases.revoke(previous.id,capabilitySession(cookie));
      await capabilityOwners.get(previous.id)?.invalidateSession(capabilitySession(cookie));
      await owners.get(previous.id)?.nativeTools.invalidateSession(capabilitySession(cookie));
      await owners.get(previous.id)?.routing.invalidateSession(capabilitySession(cookie));
      await owners.get(previous.id)?.careerTasks.invalidateSession(capabilitySession(cookie));
      await owners.get(previous.id)?.invalidateGrowthSession(capabilitySession(cookie));
      await owners.get(previous.id)?.peekStudioHttp()?.invalidateSession(capabilitySession(cookie));
    }
  };

  async function ensureRuntimeScan(): Promise<void> {
    if (runtimeRegistry.list().length > 0) return;
    runtimeScan ??= (opts.trustedSingleUserRuntimeExecution ? runtimeRegistry.scan() : runtimeRegistry.discoverExecutables()).finally(() => { runtimeScan = undefined; });
    await runtimeScan;
  }

  const sandboxBuildService = new SandboxBuildService();

  function serverOrigin() {
    const address = server.address(), port = address && typeof address === "object" ? address.port : opts.port;
    const host = opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host;
    return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  }

  const server = http.createServer(async (req, res) => {
    // ── CORS ──────────────────────────────────────────────────────────────────
    const origin = req.headers["origin"] ?? "";
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Origin");
    const allowedOrigin = opts.allowedOrigins.includes(origin) || origin === serverOrigin();
    if (origin && !allowedOrigin) return jsonResponse(res, 403, { error: "origin_rejected" });
    if (typeof origin === "string" && allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-BetterMe-Owner");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const { pathname } = url;
    // Capsule/MCP capabilities use their own narrow, expiring bearer tokens;
    // never require or expose the private installation transport token here.
    if (pathname.startsWith("/api/v1/agent/career-studio/public/")) {
      for (const owner of owners.values()) if (await owner.peekStudioHttp()?.handlePublic(req, res, pathname)) return;
      return jsonResponse(res, 404, { error: "public_capability_unavailable" });
    }
    // Only the registered OIDC callback is a browser navigation without the transport token.
    // Its own one-use state + browser cookie + nonce + PKCE + signed JWT checks are mandatory.
    if (req.method === "GET" && pathname === OIDC_CALLBACK_PATH && oidc) {
      try {
        const result = await oidc.complete(url.search, req.headers.cookie);
        if ("token" in result) {
          await invalidateCapabilitySession(req.headers.cookie);
          res.setHeader("Set-Cookie", identities.cookie(result.token, new URL(oidc.options.callbackUrl).protocol === "https:"));
        }
        res.writeHead(303, { Location: result.redirect, "Referrer-Policy": "no-referrer" }); res.end();
      } catch {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer" });
        res.end('<h1>统一登录未完成</h1><p>登录已过期、被取消或未通过验证。没有切换账号，也没有移动资料。</p><a href="/">返回 BetterMe，重新发起登录或关联</a>');
      }
      return;
    }
    // ── Auth ──────────────────────────────────────────────────────────────────
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${opts.authToken}`) {
      return jsonResponse(res, 401, { error: "unauthorized" });
    }

    try {
      // Keep the browser health probe explicit; probing an unknown checkpoint
      // thread produces noisy 404s even when the daemon is healthy.
      if (req.method === "GET" && pathname === "/api/v1/agent/health") {
        return jsonResponse(res, 200, { status: "ok", service: "agent-host" });
      }

      // ── vork 3D Raytracing Engine (Metal / Slang / OpenPBR) ────────────────
      if (req.method === "GET" && pathname === "/api/v1/agent/vork/status") {
        return jsonResponse(res, 200, vorkService.getStatus());
      }
      if (req.method === "POST" && pathname === "/api/v1/agent/vork/render") {
        try {
          const body = (await readBody(req)) as any;
          const result = await vorkService.render(body || {});
          return jsonResponse(res, 200, result);
        } catch (vorkError: any) {
          return jsonResponse(res, 500, {
            success: false,
            error: vorkError instanceof Error ? vorkError.message : String(vorkError),
          });
        }
      }
      if (req.method === "POST" && ["/api/v1/agent/identity/register", "/api/v1/agent/identity/sign-in"].includes(pathname)) {
        oidc?.cancel(req.headers.cookie);
        const result = await identities.signIn(await readBody(req), pathname.endsWith("/register"), req.socket.remoteAddress ?? "local");
        await invalidateCapabilitySession(req.headers.cookie);
        res.setHeader("Set-Cookie", identities.cookie(result.token, Boolean(origin && new URL(origin).protocol === "https:")));
        return jsonResponse(res, 200, { principal: result.principal, expiresAt: result.expiresAt });
      }
      if (req.method === "GET" && pathname === "/api/v1/agent/identity/providers") return jsonResponse(res, 200,
        oidc ? await oidc.social.list(req.headers["user-agent"], url.searchParams.get("refresh") === "1") : unconfiguredSocialLogin());
      const principal = await identities.authenticate(req.headers.cookie);
      if (req.method === "GET" && pathname === "/api/v1/agent/identity/session") return jsonResponse(res, 200, { principal: principal ?? null });
      if (req.method === "POST" && pathname === "/api/v1/agent/identity/oidc/start") {
        if (!oidc) return jsonResponse(res, 503, { error: "oidc_not_configured" });
        const callbackOrigin = new URL(oidc.options.callbackUrl).origin;
        const isAllowedOrigin = origin === callbackOrigin || (origin && opts.allowedOrigins.includes(origin)) || (origin && ["http://127.0.0.1:5173", "http://localhost:5173"].includes(origin));
        if (!isAllowedOrigin) return jsonResponse(res, 403, { error: "origin_rejected" });
        const result = await oidc.start(await readBody(req), req.headers.cookie, req.headers["x-betterme-owner"] as string | undefined, req.socket.remoteAddress ?? "local", req.headers["user-agent"]);
        res.setHeader("Set-Cookie", result.cookie); return jsonResponse(res, 200, { url: result.url });
      }
      if (!principal) return jsonResponse(res, 401, { error: "identity_required" });
      if (req.headers["x-betterme-owner"] !== principal.id) return jsonResponse(res, 409, { error: "identity_changed" });
      if (req.method === "GET" && pathname === "/api/v1/agent/identity/account") return jsonResponse(res, 200,
        await identities.loginMethods(req.headers.cookie, principal.id, oidc?.options.issuer));
      if (req.method === "POST" && pathname === "/api/v1/agent/identity/sign-out") {
        oidc?.cancel(req.headers.cookie);
        await invalidateCapabilitySession(req.headers.cookie);
        await identities.signOut(req.headers.cookie); res.setHeader("Set-Cookie", identities.clearCookie());
        for (const stream of ownerStreams.get(principal.id) ?? []) stream.end();
        return jsonResponse(res, 200, { signedOut: true });
      }
      if (req.method === "POST" && pathname === "/api/v1/agent/sandbox/build") {
        const artifact = await sandboxBuildService.build(await readBody(req,192*1024));
        return jsonResponse(res, 200, { ok: true, app: artifact, verification: artifact.verification });
      }
      if (pathname.startsWith("/api/v1/agent/sandbox/coding/")) {
        let coding=codingOwners.get(principal.id);
        if (!coding) {
          const tasks = new CodingTaskService({directory:path.join(identityRoot,"owners",principal.id,"sandbox-coding-v1"),
            ownerId:principal.id,...opts.sandboxCoding});
          coding={tasks,auto:new CodingAutoRuns(tasks)};
          codingOwners.set(principal.id,coding);
        }
        const cookie=req.headers.cookie,sessionId=capabilitySession(cookie),ownerId=principal.id;
        const acquire=()=>codingLeases.open(ownerId,sessionId,async()=>(await identities.authenticate(cookie))?.id===ownerId);
        const lease=acquire();
        try { return await handleSandboxCoding(req,res,pathname,coding.tasks,coding.auto,lease.valid,acquire,readBody,jsonResponse); }
        finally { lease.release(); }
      }
      let owner = owners.get(principal.id);
      if (!owner) { owner = makeOwner(principal); owners.set(principal.id, owner); }
      const { handleChatGpt, handleUnderstanding, runManager } = owner;
      if (pathname.startsWith("/api/v1/agent/growth/")) return await handleGrowthJourneys(req, res, pathname, owner.getGrowthJourneys(), {
        session: capabilitySession(req.headers.cookie), valid: async () => (await identities.authenticate(req.headers.cookie))?.id === principal.id,
      }, readBody, jsonResponse);
      if (pathname.startsWith("/api/v1/agent/career-studio/") && await owner.getStudioHttp().handleOwner(req, res, pathname, { session: capabilitySession(req.headers.cookie),
        valid: async () => (await identities.authenticate(req.headers.cookie))?.id === principal.id })) return;
      if (pathname.startsWith("/api/v1/agent/capabilities")) {
        let capabilities = capabilityOwners.get(principal.id);
        if (!capabilities) {
          capabilities = new CareerCapabilities({ directory: path.join(identityRoot, "owners", principal.id, "career-capabilities-v1"),
            ownerId: principal.id, builder: opts.capabilityBuilder });
          capabilityOwners.set(principal.id, capabilities);
        }
        if (await handleCapabilities(req, res, pathname, capabilities, { session: capabilitySession(req.headers.cookie),
          valid: async () => (await identities.authenticate(req.headers.cookie))?.id === principal.id }, readBody, jsonResponse)) return;
      }
      if (req.method === "GET" && pathname === "/api/v1/agent/recovery") return jsonResponse(res, 200, { ownerId: principal.id, archives: await owner.recovery.list() });
      const recoveryDocument = pathname.match(/^\/api\/v1\/agent\/recovery\/([a-f0-9]{32})\/documents\/([a-zA-Z0-9_-]{1,100})$/);
      if (req.method === "GET" && recoveryDocument) return jsonResponse(res, 200, { ownerId: principal.id, document: await owner.recovery.document(recoveryDocument[1]!, recoveryDocument[2]!) });
      const recoverySession = pathname.match(/^\/api\/v1\/agent\/recovery\/([a-f0-9]{32})\/sessions\/([a-zA-Z0-9_-]{1,100})$/);
      if (req.method === "GET" && recoverySession) return jsonResponse(res, 200, { ownerId: principal.id, session: await owner.recovery.archivedSession(recoverySession[1]!, recoverySession[2]!) });
      // Namespacing also includes workflow kind; equal client IDs never alias across people or graphs.
      const thread = (kind: string, id: string) => createHash("sha256").update(JSON.stringify([principal.id, kind, id])).digest("hex");
      if (await handleChatGpt(req, res, pathname)) return;
      if (await owner.handleRouting(req, res, pathname, { session: capabilitySession(req.headers.cookie),
        valid: async () => (await identities.authenticate(req.headers.cookie))?.id === principal.id })) return;
      if (await handleUnderstanding(req, res, pathname, { session: capabilitySession(req.headers.cookie),
        valid: async () => (await identities.authenticate(req.headers.cookie))?.id === principal.id })) return;
      if (await owner.handleCareerTasks(req, res, pathname, { session: capabilitySession(req.headers.cookie),
        valid: async () => (await identities.authenticate(req.headers.cookie))?.id === principal.id })) return;
      const recordMatch = pathname.match(/^\/api\/v1\/agent\/records\/(continuity|growth)$/);
      if (recordMatch) {
        const namespace = recordMatch[1] as "continuity" | "growth";
        const key = url.searchParams.get("key") ?? "";
        if (req.method === "GET") {
          const record = await owner.store.read(namespace, key);
          return jsonResponse(res, 200, { ownerId: principal.id, revision: record?.revision ?? 0, value: record?.value ?? null });
        }
        if (req.method === "POST") {
          const body = z.object({ expectedRevision: z.number().int().nonnegative(), value: z.unknown() }).strict().parse(await readBody(req));
          await owner.store.write(namespace, key, body.expectedRevision, body.value);
          return jsonResponse(res, 200, { ownerId: principal.id, revision: body.expectedRevision + 1 });
        }
      }

      // Legacy graphs are history only, not a second executor / approval authority.
      if (req.method === "POST" && ["/api/v1/agent/workflows/career/start", "/api/v1/agent/workflows/career/resume"].includes(pathname)) {
        return jsonResponse(res, 410, { error: "career_workflow_moved_to_tasks", next: "/api/v1/agent/tasks" });
      }
      const careerState = pathname.match(/^\/api\/v1\/agent\/workflows\/career\/state\/([A-Za-z0-9._:-]{1,200})$/);
      if (req.method === "GET" && careerState) {
        const threadId = careerState[1]!;
        const tuple = await opts.checkpointer.getTuple({ configurable: { thread_id: thread("career", threadId) } });
        if (!tuple) return jsonResponse(res, 404, { error: "thread_not_found" });
        return jsonResponse(res, 200, { legacy: true, readOnly: true, threadId, checkpointId: tuple.checkpoint.id,
          state: tuple.checkpoint.channel_values, pendingWrites: tuple.pendingWrites ?? [] });
      }

      // ── GET /api/v1/agent/runtimes ──────────────────────────────────────
      if (req.method === "GET" && pathname === "/api/v1/agent/runtimes") {
        await ensureRuntimeScan();
        return jsonResponse(res, 200, { runtimes: runtimeRegistry.list().map(runtime => opts.trustedSingleUserRuntimeExecution ? runtime : {
          ...runtime, canRun: false, readiness: "unsupported", detail: "普通 CLI 任务未开放：请在项目理解的「本账号工具授权与状态」中独立授权，使用带强制隔离的受控阅读；不会继承电脑共享登录。",
        }) });
      }

      // ── POST /api/v1/agent/runtimes/scan ─────────────────────────────────
      if (req.method === "POST" && pathname === "/api/v1/agent/runtimes/scan") {
        const runtimes = await (opts.trustedSingleUserRuntimeExecution ? runtimeRegistry.scan() : runtimeRegistry.discoverExecutables());
        return jsonResponse(res, 200, { runtimes: runtimes.map(runtime => opts.trustedSingleUserRuntimeExecution ? runtime : {
          ...runtime, canRun: false, readiness: "unsupported", detail: "普通 CLI 任务未开放：请在项目理解的「本账号工具授权与状态」中独立授权，使用带强制隔离的受控阅读；不会继承电脑共享登录。",
        }) });
      }

      // Legacy runs remain readable/cancellable; all new text execution is a task.
      if (req.method === "POST" && pathname === "/api/v1/agent/runs") {
        return jsonResponse(res, 410, { error: "runtime_run_moved_to_tasks", next: "/api/v1/agent/tasks" });
      }

      // ── GET /api/v1/agent/runs ──────────────────────────────────────────
      if (req.method === "GET" && pathname === "/api/v1/agent/runs") {
        await runManager.ready();
        const rawLimit = Number(url.searchParams.get("limit") ?? "50");
        return jsonResponse(res, 200, { runs: runManager.list(Number.isFinite(rawLimit) ? rawLimit : 50) });
      }

      // ── GET /api/v1/agent/runs/:runId ───────────────────────────────────
      const runMatch = pathname.match(/^\/api\/v1\/agent\/runs\/([A-Za-z0-9._:-]+)$/);
      if (req.method === "GET" && runMatch) {
        await runManager.ready();
        const runId = runMatch[1]!;
        const run = runManager.get(runId);
        if (!run) return jsonResponse(res, 404, { error: "run_not_found" });
        const output = await runManager.getOutput(runId);
        return jsonResponse(res, 200, { run, latestSequence: runManager.events.latestSequence(runId), ...output });
      }

      // ── GET /api/v1/agent/runs/:runId/events ─────────────────────────────
      const eventMatch = pathname.match(/^\/api\/v1\/agent\/runs\/([A-Za-z0-9._:-]+)\/events$/);
      if (req.method === "GET" && eventMatch) {
        await runManager.ready();
        const runId = eventMatch[1]!;
        if (!runManager.get(runId)) return jsonResponse(res, 404, { error: "run_not_found" });
        const headerValue = req.headers["last-event-id"];
        const parsedHeader = typeof headerValue === "string" ? Number(headerValue.split(":")[1]) : NaN;
        const queryAfter = Number(url.searchParams.get("after") ?? "");
        const afterSequence = Number.isFinite(queryAfter) && queryAfter >= 0
          ? queryAfter
          : Number.isFinite(parsedHeader) && parsedHeader >= 0 ? parsedHeader : 0;
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("retry: 2000\n\n");
        const streams = ownerStreams.get(principal.id) ?? new Set<http.ServerResponse>();
        streams.add(res); ownerStreams.set(principal.id, streams);
        for (const event of runManager.events.get(runId, afterSequence)) res.write(encodeSseEvent(event));
        const unsubscribe = runManager.events.subscribe(runId, (event) => {
          if (!res.destroyed) res.write(encodeSseEvent(event));
        });
        const heartbeat = setInterval(() => {
          void identities.authenticate(req.headers.cookie).then(current => {
            if (current?.id !== principal.id) { res.end(); return; }
            if (!res.destroyed && !res.writableEnded) res.write(": keepalive\n\n");
          }).catch(() => res.end());
        }, 15_000);
        res.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
          streams.delete(res);
          if (!streams.size) ownerStreams.delete(principal.id);
        });
        return;
      }

      // ── POST /api/v1/agent/runs/:runId/cancel ────────────────────────────
      const cancelMatch = pathname.match(/^\/api\/v1\/agent\/runs\/([A-Za-z0-9._:-]+)\/cancel$/);
      if (req.method === "POST" && cancelMatch) {
        await runManager.ready();
        const runId = cancelMatch[1]!;
        const run = runManager.cancel(runId);
        if (!run) return jsonResponse(res, 404, { error: "run_not_found" });
        return jsonResponse(res, 202, { run });
      }

      // Legacy records remain readable below, but this route is no longer an
      // independent executor or a fallback around the owner task ledger.
      if (req.method === "POST" && ["/api/v1/agent/jd-match/start","/api/v1/agent/jd-match/resume"].includes(pathname)) {
        return jsonResponse(res, 410, { error: "jd_match_moved_to_tasks", next: "/api/v1/agent/tasks" });
      }

      // ── GET /api/v1/agent/jd-match/state/:threadId ───────────────────────
      const stateMatch = pathname.match(/^\/api\/v1\/agent\/jd-match\/state\/([A-Za-z0-9._:-]+)$/);
      if (req.method === "GET" && stateMatch) {
        const threadId = stateMatch[1]!;
        const tuple = await opts.checkpointer.getTuple({ configurable: { thread_id: thread("jd", threadId) } });
        if (!tuple) {
          return jsonResponse(res, 404, { error: "thread_not_found" });
        }
        return jsonResponse(res, 200, {
          threadId,
          checkpointId: tuple.checkpoint.id,
          next: (tuple as any).next ?? [],
          state: tuple.checkpoint.channel_values,
        });
      }

      // ── POST /api/v1/agent/chat ──────────────────────────────────────────
      if (req.method === "POST" && pathname === "/api/v1/agent/chat") {
        return jsonResponse(res, 410, { error: "free_chat_moved_to_tasks", next: "/api/v1/agent/tasks" });
      }

      return jsonResponse(res, 404, { error: "not_found" });
    } catch (err: any) {
      if (err instanceof CodingTaskError || err instanceof SandboxBuildError) return jsonResponse(res, err.status, { error:err.code });
      if (err instanceof GrowthJourneyError) return jsonResponse(res, err.status, { error: err.code });
      if (err instanceof IdentityError) return jsonResponse(res, err.status, { error: err.code });
      if (err instanceof DeepSeekApiError) {
        return jsonResponse(res, err.status, { error: "model_provider_error", message: err.message });
      }
      if (err?.name === "PayloadTooLargeError") {
        return jsonResponse(res, 413, { error: "request_body_too_large" });
      }
      if (err?.name === "ZodError") {
        return jsonResponse(res, 400, { error: "invalid_request", details: err.errors });
      }
      // Provider/IO errors may contain prompts, paths or credentials from a private owner.
      // Installation-wide logs must not become a second, unscoped memory store.
      console.error("[agent-host] private request failed:", err instanceof Error ? err.name : "UnknownError");
      return jsonResponse(res, 500, { error: "internal_error" });
    }
  });

  let draining:Promise<void>|undefined;
  const drain=()=>draining??=(async()=>{
    codingLeases.close();
    const work:Promise<unknown>[]=[];
    for(const owner of owners.values()){
      owner.taskRuntime.close();
      work.push((async () => { try { await owner.closeGrowthJourneys(); } finally { await owner.careerTasks.close(); } })().finally(async()=>{
        await Promise.allSettled([owner.peekStudioHttp()?.close(),owner.routing.close(),owner.nativeTools.close(),owner.understanding.dispose()]);
        owner.chatGpt.dispose();
      }));
    }
    for(const service of capabilityOwners.values())work.push(service.close());
    for(const coding of codingOwners.values())work.push(coding.auto.close().finally(()=>coding.tasks.close()));
    const results=await Promise.allSettled(work);
    opts.careerOperator?.close();opts.careerFinalExportRenderer?.close();
    if(results.some(result=>result.status==="rejected"))throw Error("agent_shutdown_failed");
  })();
  // The close callback is also the storage lifetime gate for embedded Hosts.
  // Await kernel writers before a caller can release the private directories.
  const close=server.close.bind(server);
  server.close=callback=>close(error=>{void drain().then(()=>callback?.(error),()=>callback?.(error??Error("agent_shutdown_failed")));});
  server.once("close",()=>{void drain().catch(()=>{ /* close callback reports a sanitized shutdown failure */ });});
  server.listen(opts.port, opts.host, () => {
    console.log(`[agent-host] listening on http://${opts.host}:${opts.port}`);
  });

  return server;
}
