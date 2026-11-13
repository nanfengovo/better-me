import type http from "node:http";
import { z } from "zod";
import type { NativeLease } from "../native-tools/service.js";
import { AgentRouting, RoutingError } from "./service.js";

export function createRoutingHandler(options: {
  service: AgentRouting; readBody: (req: http.IncomingMessage) => Promise<unknown>;
  sendJson: (res: http.ServerResponse, status: number, value: unknown) => void;
}) {
  const prefix = "/api/v1/agent/routing";
  return async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string, lease: NativeLease): Promise<boolean> => {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.method === "GET" && pathname === prefix) options.sendJson(res, 200, await options.service.status());
      else if (req.method === "PUT" && pathname === prefix) options.sendJson(res, 200, { policy: await options.service.update(await options.readBody(req), lease) });
      else if (req.method === "POST" && pathname === `${prefix}/respond`) {
        options.sendJson(res, 410, { error: "routing_response_moved_to_tasks", next: "/api/v1/agent/tasks" });
      } else options.sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof RoutingError) options.sendJson(res, error.status, { error: error.code, ...(error.trace ? { trace: error.trace } : {}), message: "本轮底座路由已停止。请核对可见原因后再重试；未静默切换付费 API。" });
      else options.sendJson(res, error instanceof z.ZodError ? 400 : 500, { error: error instanceof z.ZodError ? "invalid_request" : "routing_unavailable", message: "底座配置或服务暂不可用；未改变原有资料和记录，也未尝试其他模型。" });
    }
    return true;
  };
}
