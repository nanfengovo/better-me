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

// ── Server factory ────────────────────────────────────────────────────────────

export interface ServerOptions {
  port: number;
  host: string;
  /** Allowed origins for CORS (should match job-service origins). */
  allowedOrigins: string[];
  /** Bearer token expected on all requests. */
  authToken: string;
  checkpointer: SqliteSaver;
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
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

export function createAgentServer(opts: ServerOptions): http.Server {
  // Cache one compiled graph per process; thread safety via thread_id in checkpointer.
  const graphCache = new Map<string, JdMatchGraph>();

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
