import type http from "node:http";
import { z } from "zod";
import { ChatGptResponseRequestSchema } from "@better-me/agent-contracts";
import { ChatGptPlanService } from "./service.js";
import { safeFailure } from "./errors.js";

export function createChatGptHandler(deps: { service: ChatGptPlanService; allowedOrigins: string[];
  readBody: (req: http.IncomingMessage) => Promise<unknown>;
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}) {
  const prefix = "/api/v1/agent/chatgpt";
  return async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> => {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
    res.setHeader("Cache-Control", "no-store");
    if (req.headers.origin && !deps.allowedOrigins.includes(req.headers.origin)) { deps.sendJson(res, 403, { error: "origin_rejected" }); return true; }
    try {
      const route = pathname.slice(prefix.length);
      if (req.method === "GET" && route === "/state") deps.sendJson(res, 200, await deps.service.state());
      else if (req.method === "POST" && route === "/sign-in") {
        const input = z.object({ profileId: z.string().min(1).max(100).optional() }).strict().parse(await deps.readBody(req));
        deps.sendJson(res, 200, await deps.service.startSignIn(input.profileId));
      } else if (req.method === "POST" && route === "/cancel-sign-in") {
        const { attemptId } = z.object({ attemptId: z.string().uuid() }).strict().parse(await deps.readBody(req));
        deps.service.cancelSignIn(attemptId); deps.sendJson(res, 200, await deps.service.state());
      } else if (req.method === "POST" && ["/models", "/sign-out", "/retry"].includes(route)) {
        const { profileId } = z.object({ profileId: z.string().min(1).max(100) }).strict().parse(await deps.readBody(req));
        if (route === "/models") deps.sendJson(res, 200, { models: await deps.service.models(profileId) });
        else if (route === "/retry") { deps.service.retry(profileId); deps.sendJson(res, 200, await deps.service.state()); }
        else deps.sendJson(res, 200, { ...await deps.service.signOut(profileId), state: await deps.service.state() });
      } else if (req.method === "POST" && route === "/response") {
        const { consentToSend: _consent, ...input } = ChatGptResponseRequestSchema.parse(await deps.readBody(req));
        const controller = new AbortController();
        const cancel = () => controller.abort(); res.once("close", cancel);
        try { deps.sendJson(res, 200, await deps.service.respond(input, controller.signal)); }
        finally { res.off("close", cancel); }
      } else deps.sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      if (error instanceof z.ZodError) deps.sendJson(res, 400, { error: "invalid_request", message: "ChatGPT 请求格式不完整，未发送模型请求。" });
      else { const safe = safeFailure(error); deps.sendJson(res, safe.issue.status && safe.issue.status >= 400 && safe.issue.status < 600 ? safe.issue.status : 502, { error: safe.issue.code, issue: safe.issue }); }
    }
    return true;
  };
}
