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
import { z } from "zod";
import { buildModel, type ModelSettings } from "./model.js";
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

// ── Request schemas ───────────────────────────────────────────────────────────

const ModelSettingsSchema = z.object({
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).max(100),
  apiKey: z.string().optional().default("ollama-key"),
  temperature: z.number().min(0).max(2).optional(),
});

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
  const graphCache = new Map<string, JdMatchGraph>();
  const careerGraph = buildCareerOrchestrator(opts.checkpointer);
  const runtimeRegistry = new RuntimeRegistry({ definitions: opts.runtimeDefinitions });
  const runManager = new AgentRunManager({ registry: runtimeRegistry, rootDirectory: opts.runsDirectory, sandboxMode: opts.sandboxMode });
  let runtimeScan: Promise<unknown> | undefined;

  async function ensureRuntimeScan(): Promise<void> {
    if (runtimeRegistry.list().length > 0) return;
    runtimeScan ??= runtimeRegistry.scan().finally(() => { runtimeScan = undefined; });
    await runtimeScan;
  }

  function getGraph(settings: ModelSettings): JdMatchGraph {
    const cacheKey = `${settings.baseUrl ?? "openai"}:${settings.model}`;
    if (!graphCache.has(cacheKey)) {
      const model = buildModel(settings);
      graphCache.set(cacheKey, buildJdMatchGraph(model, opts.checkpointer));
    }
    return graphCache.get(cacheKey)!;
  }

  const server = http.createServer(async (req, res) => {
    // ── CORS ──────────────────────────────────────────────────────────────────
    const origin = req.headers["origin"] ?? "";
    if (typeof origin === "string" && opts.allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // ── Auth ──────────────────────────────────────────────────────────────────
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${opts.authToken}`) {
      return jsonResponse(res, 401, { error: "unauthorized" });
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const { pathname } = url;

    try {
      // Keep the browser health probe explicit; probing an unknown checkpoint
      // thread produces noisy 404s even when the daemon is healthy.
      if (req.method === "GET" && pathname === "/api/v1/agent/health") {
        return jsonResponse(res, 200, { status: "ok", service: "agent-host" });
      }

      // ── POST /api/v1/agent/workflows/career/start ───────────────────────
      if (req.method === "POST" && pathname === "/api/v1/agent/workflows/career/start") {
        const body = CareerStartBodySchema.parse(await readBody(req));
        const result = await careerGraph.invoke({
          task: body.task,
          workspaceId: body.workspaceId,
          requestedRuntimeId: body.requestedRuntimeId,
        }, { configurable: { thread_id: body.threadId } });
        const state = await careerGraph.getState({ configurable: { thread_id: body.threadId } });
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
        const result = await careerGraph.invoke({ approval: body.approval as CareerApproval }, { configurable: { thread_id: body.threadId } });
        const state = await careerGraph.getState({ configurable: { thread_id: body.threadId } });
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
        return jsonResponse(res, 200, { runtimes: runtimeRegistry.list() });
      }

      // ── POST /api/v1/agent/runtimes/scan ─────────────────────────────────
      if (req.method === "POST" && pathname === "/api/v1/agent/runtimes/scan") {
        const runtimes = await runtimeRegistry.scan();
        return jsonResponse(res, 200, { runtimes });
      }

      // ── POST /api/v1/agent/runs ─────────────────────────────────────────
      if (req.method === "POST" && pathname === "/api/v1/agent/runs") {
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
        for (const event of runManager.events.get(runId, afterSequence)) res.write(encodeSseEvent(event));
        const unsubscribe = runManager.events.subscribe(runId, (event) => {
          if (!res.destroyed) res.write(encodeSseEvent(event));
        });
        const heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(": keepalive\n\n");
        }, 15_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
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
            configurable: { thread_id: body.threadId },
            // apiKey is in modelSettings only; not part of graph config
          }
        );

        const threadState = await graph.getState({ configurable: { thread_id: body.threadId } });
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

        const result = await graph.invoke(
          // Supply decisions through the state update on resume
          { decisions: body.decisions as Record<string, ProposalDecision> },
          { configurable: { thread_id: body.threadId } }
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
        const tuple = await opts.checkpointer.getTuple({ configurable: { thread_id: threadId } });
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
        const reply = await processAgentChat(model, body);
        return jsonResponse(res, 200, { reply });
      }

      return jsonResponse(res, 404, { error: "not_found" });
    } catch (err: any) {
      if (err?.name === "PayloadTooLargeError") {
        return jsonResponse(res, 413, { error: "request_body_too_large" });
      }
      if (err?.name === "ZodError") {
        return jsonResponse(res, 400, { error: "invalid_request", details: err.errors });
      }
      console.error("[agent-host] error:", err);
      return jsonResponse(res, 500, { error: "internal_error" });
    }
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`[agent-host] listening on http://${opts.host}:${opts.port}`);
  });

  return server;
}
