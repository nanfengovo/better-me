/**
 * server.ts — Minimal HTTP API for agent-host.
 *
 * Routes:
 *
 *   POST /api/v1/agent/jd-match/start
 *     Body: { threadId, modelSettings, rawJd, allowedProfileEntryIds, sessionClaims }
 *     → Runs the graph until it hits interrupt() at confirmProposals.
 *     → Returns { status: "awaiting_review", proposals: [...], threadId }
 *
 *   POST /api/v1/agent/jd-match/resume
 *     Body: { threadId, modelSettings, decisions: { [proposalId]: ProposalDecision } }
 *     → Resumes the graph with confirmed decisions.
 *     → Returns { status: "complete", accepted: [...], gaps: [...] }
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
import path from "node:path";
import { Command } from "@langchain/langgraph";
import { z } from "zod";
import { buildModel, ModelSettingsSchema, DeepSeekApiError, type ModelSettings } from "./model.js";
import { buildJdMatchGraph } from "./graphs/jd-match/graph.js";
import type { JdMatchGraph } from "./graphs/jd-match/graph.js";
import type { ProposalDecision } from "./graphs/jd-match/state.js";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { ChatRequestBodySchema } from "./chat/types.js";
import { processAgentChat } from "./chat/chat-service.js";
import { ContextPackSchema } from "@better-me/agent-contracts";
import { encodeSseEvent } from "./events/event-bus.js";
import { AgentRunManager } from "./runs/run-manager.js";
import type { SandboxMode } from "./runs/sandbox.js";
import { RuntimeRegistry } from "./runtime/registry.js";
import type { RuntimeAgentDef } from "@better-me/agent-contracts";
import { buildCareerOrchestrator } from "./graphs/career/graph.js";
import type { CareerApproval } from "./graphs/career/state.js";
import { resolveCheckpointPath } from "./checkpointer.js";
import { ProjectUnderstandingService } from "./understanding/service.js";
import { createUnderstandingHandler, type UnderstandingRuntime } from "./understanding/http.js";
import { AgentRouting } from "./routing/service.js";
import { createRoutingHandler } from "./routing/http.js";
import { NativeAccountTools } from "./native-tools/service.js";
import type { NativeProcessRunner } from "./native-tools/process.js";
import type { UnderstandingReasoner } from "@better-me/agent-contracts";
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
import { SandboxBuildService, type SandboxBuildInput } from "./sandbox/build-service.js";

// ── Request schemas ───────────────────────────────────────────────────────────

const StartBodySchema = z.object({
  threadId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  modelSettings: ModelSettingsSchema,
  rawJd: z.string().min(1).max(50_000),
  allowedProfileEntryIds: z.array(z.string()).max(500),
  sessionClaims: z.record(z.string()).optional(),
});

const ResumeBodySchema = z.object({
  threadId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  modelSettings: ModelSettingsSchema,
  decisions: z.record(z.union([
    z.object({ status: z.literal("accepted") }),
    z.object({ status: z.literal("rejected"), reason: z.string().optional() }),
    z.object({ status: z.literal("edited"), editedSuggestion: z.string().min(1) }),
  ])),
});

const StartRunBodySchema = z.object({
  runtimeId: z.string().min(1).max(120),
  workflow: z.string().min(1).max(120).default("career-orchestrator"),
  prompt: z.string().min(1).max(20_000),
  contextPack: ContextPackSchema.optional(),
  allowedReadPaths: z.array(z.string().min(1).max(2_000)).max(20).default([]),
  timeoutMs: z.number().int().min(1_000).max(60 * 60_000).optional(),
  sandboxMode: z.enum(["auto", "required", "disabled"]).optional(),
});

const CareerStartBodySchema = z.object({
  threadId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  task: z.string().min(1).max(20_000),
  workspaceId: z.string().min(1).max(200).default("default"),
  requestedRuntimeId: z.string().min(1).max(120).optional(),
});

const CareerResumeBodySchema = z.object({
  threadId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  approval: z.object({
    status: z.union([z.literal("approved"), z.literal("rejected")]),
    approvedArtifactRefs: z.array(z.string().min(1)).max(500).optional(),
    actorScope: z.string().min(1).max(200),
    expectedRevision: z.number().int().nonnegative().optional(),
    idempotencyKey: z.string().min(8).max(200),
  }),
});

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
  understandingReasoner?: (runtime: UnderstandingRuntime) => Promise<UnderstandingReasoner>;
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
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  const maxBytes = 16 * 1024 * 1024;
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
    const error = new Error("request_body_too_large");
    error.name = "PayloadTooLargeError";
    throw error;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

export function createAgentServer(opts: ServerOptions): http.Server {
  // Cache one compiled graph per process; thread safety via thread_id in checkpointer.
  const careerGraph = buildCareerOrchestrator(opts.checkpointer);
  const runtimeRegistry = new RuntimeRegistry({ definitions: opts.runtimeDefinitions });
  const understandingRegistry = new RuntimeRegistry({ definitions: opts.runtimeDefinitions });
  let runtimeScan: Promise<unknown> | undefined;
  const identityRoot = opts.identityDirectory ?? path.join(opts.runsDirectory ?? path.dirname(resolveCheckpointPath()), "accounts-v1");
  const identities = new IdentityService(identityRoot);
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
    return { understanding, nativeTools, routing, chatGpt: provider, recovery, store: new OwnedStore(path.join(root, "records"), principal.id,
      (namespace, key) => namespace === "continuity" ? recovery.continuity(key) : Promise.resolve(undefined)),
      runManager: new AgentRunManager({ registry: runtimeRegistry, rootDirectory: path.join(root, "runs"), sandboxMode: opts.sandboxMode }),
      handleChatGpt: createChatGptHandler({ service: provider, allowedOrigins: opts.allowedOrigins, readBody, sendJson: jsonResponse }),
      handleRouting: createRoutingHandler({ service: routing, readBody, sendJson: jsonResponse }),
      handleUnderstanding: createUnderstandingHandler({ service: understanding, registry: understandingRegistry,
        nativeTools: opts.trustedSingleUserRuntimeExecution ? undefined : nativeTools,
        routing,
        allowNativeExecution: opts.trustedSingleUserRuntimeExecution === true,
        ensureRuntimeScan: async () => { await understandingRegistry.discoverExecutables(); }, readBody, sendJson: jsonResponse, reasoner: opts.understandingReasoner, chatGpt: provider }),
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
      await capabilityOwners.get(previous.id)?.invalidateSession(capabilitySession(cookie));
      await owners.get(previous.id)?.nativeTools.invalidateSession(capabilitySession(cookie));
      await owners.get(previous.id)?.routing.invalidateSession(capabilitySession(cookie));
    }
  };

  async function ensureRuntimeScan(): Promise<void> {
    if (runtimeRegistry.list().length > 0) return;
    runtimeScan ??= (opts.trustedSingleUserRuntimeExecution ? runtimeRegistry.scan() : runtimeRegistry.discoverExecutables()).finally(() => { runtimeScan = undefined; });
    await runtimeScan;
  }

  function getGraph(settings: ModelSettings): JdMatchGraph {
    // Graph state belongs in the checkpointer, credentials and generation controls do not.
    // Rebuilding honors key rotation and thinking settings on every request.
    return buildJdMatchGraph(buildModel(settings), opts.checkpointer);
  }

  const sandboxBuildService = new SandboxBuildService();

  const server = http.createServer(async (req, res) => {
    // ── CORS ──────────────────────────────────────────────────────────────────
    const origin = req.headers["origin"] ?? "";
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Origin");
    if (origin && !opts.allowedOrigins.includes(origin)) return jsonResponse(res, 403, { error: "origin_rejected" });
    if (typeof origin === "string" && opts.allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-BetterMe-Owner");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const { pathname } = url;
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
        try {
          const body = await readBody(req);
          const artifact = await sandboxBuildService.build(body as SandboxBuildInput);
          return jsonResponse(res, 200, { ok: true, app: artifact, verification: artifact.verification });
        } catch (buildError) {
          return jsonResponse(res, 500, {
            ok: false,
            error: buildError instanceof Error ? buildError.message : String(buildError),
          });
        }
      }
      let owner = owners.get(principal.id);
      if (!owner) { owner = makeOwner(principal); owners.set(principal.id, owner); }
      const { handleChatGpt, handleUnderstanding, runManager } = owner;
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

      // ── POST /api/v1/agent/workflows/career/start ───────────────────────
      if (req.method === "POST" && pathname === "/api/v1/agent/workflows/career/start") {
        const body = CareerStartBodySchema.parse(await readBody(req));
        const result = await careerGraph.invoke({
          task: body.task,
          workspaceId: body.workspaceId,
          requestedRuntimeId: body.requestedRuntimeId,
        }, { configurable: { thread_id: thread("career", body.threadId) } });
        const state = await careerGraph.getState({ configurable: { thread_id: thread("career", body.threadId) } });
        return jsonResponse(res, 200, {
          status: state.next.length > 0 ? "awaiting_approval" : "complete",
          threadId: body.threadId,
          workers: result.workers,
          artifacts: result.artifacts,
          coverage: result.coverage,
          errors: result.errors,
          stepLog: result.stepLog,
        });
      }

      // ── POST /api/v1/agent/workflows/career/resume ──────────────────────
      if (req.method === "POST" && pathname === "/api/v1/agent/workflows/career/resume") {
        const body = CareerResumeBodySchema.parse(await readBody(req));
        const config = { configurable: { thread_id: thread("career", body.threadId) } };
        const pending = await careerGraph.getState(config);
        if (!pending.tasks.some(task => task.interrupts?.length)) return jsonResponse(res, 409, { error: "workflow_not_awaiting_approval" });
        const result = await careerGraph.invoke(new Command({ resume: { ...body.approval, actorScope: principal.id } as CareerApproval }), config);
        const state = await careerGraph.getState(config);
        return jsonResponse(res, 200, {
          status: state.next.length > 0 ? "awaiting_approval" : "complete",
          threadId: body.threadId,
          approval: result.approval,
          artifacts: result.artifacts,
          coverage: result.coverage,
          errors: result.errors,
          stepLog: result.stepLog,
        });
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

      // ── POST /api/v1/agent/runs ─────────────────────────────────────────
      if (req.method === "POST" && pathname === "/api/v1/agent/runs") {
        // Existing CLI runs inherit an OS account and can read its files. A process directory or
        // the current optional sandbox is NOT a multi-user read boundary. Keep the controlled
        // understanding Broker; refuse unrestricted runs rather than exposing another owner's data.
        if (!opts.trustedSingleUserRuntimeExecution) return jsonResponse(res, 403, { error: "runtime_identity_isolation_required" });
        await runManager.ready();
        const raw = await readBody(req);
        const body = StartRunBodySchema.parse(raw);
        await ensureRuntimeScan();
        const runtime = runtimeRegistry.get(body.runtimeId);
        if (!runtime) return jsonResponse(res, 404, { error: "runtime_not_found", runtimeId: body.runtimeId });
        if (runtime.status !== "available") {
          return jsonResponse(res, 409, { error: "runtime_not_available", runtime });
        }
        const run = await runManager.start({ ...body, runtime });
        return jsonResponse(res, 202, {
          run,
          eventsUrl: `/api/v1/agent/runs/${run.id}/events`,
          statusUrl: `/api/v1/agent/runs/${run.id}`,
        });
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

      // ── POST /api/v1/agent/jd-match/start ────────────────────────────────
      if (req.method === "POST" && pathname === "/api/v1/agent/jd-match/start") {
        const raw = await readBody(req);
        const body = StartBodySchema.parse(raw);
        const graph = getGraph(body.modelSettings);

        const result = await graph.invoke(
          {
            rawJd: body.rawJd,
            allowedProfileEntryIds: body.allowedProfileEntryIds,
            sessionClaims: body.sessionClaims ?? {},
          },
          {
            configurable: { thread_id: thread("jd", body.threadId) },
            // apiKey is in modelSettings only; not part of graph config
          }
        );

        const threadState = await graph.getState({ configurable: { thread_id: thread("jd", body.threadId) } });
        if (threadState.next.length > 0) {
          // Graph hit interrupt/breakpoint at confirmProposals — return proposals for review
          return jsonResponse(res, 200, {
            status: "awaiting_review",
            threadId: body.threadId,
            proposals: result.proposals,
            structuredJd: result.structuredJd,
            errors: result.errors,
          });
        }

        // Graph completed without interrupt (e.g. structureJd failed early)
        return jsonResponse(res, 200, {
          status: "complete",
          threadId: body.threadId,
          proposals: result.proposals,
          decisions: result.decisions,
          errors: result.errors,
        });
      }

      // ── POST /api/v1/agent/jd-match/resume ───────────────────────────────
      if (req.method === "POST" && pathname === "/api/v1/agent/jd-match/resume") {
        const raw = await readBody(req);
        const body = ResumeBodySchema.parse(raw);
        const graph = getGraph(body.modelSettings);

        const config = { configurable: { thread_id: thread("jd", body.threadId) } };
        const pending = await graph.getState(config);
        if (!pending.tasks.some(task => task.interrupts?.length)) return jsonResponse(res, 409, { error: "workflow_not_awaiting_review" });
        const proposals = pending.values.proposals as Array<{ id: string }>;
        if (proposals.some(proposal => !body.decisions[proposal.id]) || Object.keys(body.decisions).some(id => !proposals.some(proposal => proposal.id === id))) {
          return jsonResponse(res, 400, { error: "review_decisions_must_match_proposals" });
        }
        const result = await graph.invoke(
          new Command({ resume: body.decisions as Record<string, ProposalDecision> }),
          config
        );

        const accepted = result.proposals.filter(
          (p) => result.decisions[p.id]?.status === "accepted"
        );
        const edited = result.proposals
          .filter((p) => result.decisions[p.id]?.status === "edited")
          .map((p) => {
            const d = result.decisions[p.id] as { status: "edited"; editedSuggestion: string };
            return { ...p, suggestion: d.editedSuggestion };
          });
        const gaps = result.proposals.filter((p) => p.evidenceType === "gap");

        return jsonResponse(res, 200, {
          status: "complete",
          threadId: body.threadId,
          accepted,
          edited,
          gaps,
          errors: result.errors,
        });
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
        const raw = await readBody(req);
        const body = ChatRequestBodySchema.parse(raw);
        const model = buildModel(body.modelSettings);
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        req.once("aborted", onAbort);
        res.once("close", onClose);
        try {
          const reply = await processAgentChat(model, body, controller.signal);
          if (controller.signal.aborted) return;
          return jsonResponse(res, 200, { reply });
        } catch (error) {
          if (controller.signal.aborted) return;
          throw error;
        } finally {
          req.off("aborted", onAbort);
          res.off("close", onClose);
        }
      }

      return jsonResponse(res, 404, { error: "not_found" });
    } catch (err: any) {
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

  server.once("close", () => { for (const owner of owners.values()) { void owner.routing.close(); void owner.nativeTools.close(); void owner.understanding.dispose(); owner.chatGpt.dispose(); } });
  server.listen(opts.port, opts.host, () => {
    console.log(`[agent-host] listening on http://${opts.host}:${opts.port}`);
  });

  server.once("close", () => { for (const service of capabilityOwners.values()) void service.close(); });
  return server;
}
