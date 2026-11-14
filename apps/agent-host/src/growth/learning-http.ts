import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { LearningId, TranslationCreateSchema } from "@better-me/agent-contracts";
import type { CareerTaskAccess } from "../kernel/service.js";
import type { LearningPaths } from "./learning-service.js";
import { learningFail } from "./learning-store.js";

/** Auth, origin, token and owner are checked by the same Host as career APIs. */
export async function handleLearning(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  learning: LearningPaths,
  access: CareerTaskAccess,
  read: (req: IncomingMessage, maxBytes?: number) => Promise<unknown>,
  send: (res: ServerResponse, status: number, body: unknown) => void,
) {
  const root = "/api/v1/agent/growth/learning";
  const suffix = pathname.slice(root.length);
  async function body(limit: number) {
    try {
      return await read(req, limit);
    } catch (error) {
      if (error instanceof SyntaxError) learningFail("invalid_json", 400);
      throw error;
    }
  }
  if (req.method === "GET") {
    if (suffix === "/translations/backend") return send(res, 200, { backend: await learning.translations.backend(access) });
    if (suffix === "/translations/backend/cloud") return send(res, 200, { backend: await learning.translations.backend(access,"cloud") });
    if (suffix === "/translations") return send(res, 200, { jobs: await learning.translations.list(access) });
    const translationRequest = /^\/translations\/requests\/([a-zA-Z0-9][a-zA-Z0-9._:-]{0,159})$/.exec(suffix);
    if (translationRequest) return send(res, 200, { job: await learning.translations.byRequest(translationRequest[1]!, access) });
    const translation = /^\/translations\/(lt_[a-f0-9]{32})(?:\/artifacts\/(mono|dual))?$/.exec(suffix);
    if (translation) {
      if (!translation[2]) return send(res, 200, { job: await learning.translations.get(translation[1]!, access) });
      const { artifact, bytes } = await learning.translations.bytes(translation[1]!, translation[2] as "mono" | "dual", access);
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": bytes.length,
        "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff", "X-Content-SHA256": artifact.hash,
        "Content-Disposition": `attachment; filename="translation-${translation[2]}-draft.pdf"` });
      res.end(bytes); return;
    }
    if (suffix === "/paths")
      return send(res, 200, { paths: await learning.list(access) });
    const pathItem = /^\/paths\/(lp_[a-f0-9]{32})$/.exec(suffix);
    if (pathItem)
      return send(res, 200, { path: await learning.get(pathItem[1]!, access) });
    if (suffix === "/materials")
      return send(res, 200, { materials: await learning.materials(access) });
    const passage =
      /^\/materials\/(lm_[a-f0-9]{64})\/passages\/(\d{1,2})\/(b\d{1,3})$/.exec(
        suffix,
      );
    if (passage)
      return send(
        res,
        200,
        await learning.passage(
          passage[1]!,
          Number(passage[2]),
          passage[3]!,
          access,
        ),
      );
    const item = /^\/materials\/(lm_[a-f0-9]{64})(\/bytes)?$/.exec(suffix);
    if (item) {
      if (!item[2])
        return send(res, 200, {
          material: await learning.material(item[1]!, access),
        });
      const { material, bytes } = await learning.bytes(item[1]!, access);
      res.writeHead(200, {
        "Content-Type": material.mediaType,
        "Content-Length": bytes.length,
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
        "X-Content-SHA256": material.hash,
        "Content-Disposition": `inline; filename="learning-original.${material.mediaType === "application/pdf" ? "pdf" : "txt"}"`,
      });
      res.end(bytes);
      return;
    }
  }
  if (req.method === "POST") {
    if (
      !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")
    )
      return send(res, 415, { error: "json_required" });
    if (suffix === "/translations"){
      const raw=await body(32768);
      if(raw && typeof raw==="object" && "request" in raw){
        const {request,credential}=z.object({request:TranslationCreateSchema,credential:z.string().regex(/^[!-~]{4,512}$/)}).strict().parse(raw);
        if(!request.cloudGrant)learningFail("translation_cloud_grant_required",422);
        return send(res,201,{job:await learning.translations.create(request,access,credential)});
      }
      return send(res,201,{job:await learning.translations.create(raw,access)});
    }
    const translationCommand = /^\/translations\/(lt_[a-f0-9]{32})\/(cancel|review)$/.exec(suffix);
    if (translationCommand) {
      const input = await body(16384);
      if (translationCommand[2] === "review") return send(res, 200, { job: await learning.translations.review(translationCommand[1]!, input, access) });
      z.object({ consent: z.literal(true) }).strict().parse(input);
      return send(res, 200, { job: await learning.translations.cancel(translationCommand[1]!, access) });
    }
    if (suffix === "/materials")
      return send(res, 201, {
        material: await learning.importMaterial(
          await body(12 * 1024 * 1024),
          access,
        ),
      });
    if (suffix === "/paths")
      return send(res, 201, {
        path: await learning.create(await body(4096), access),
      });
    const pathCommand = /^\/paths\/(lp_[a-f0-9]{32})\/commands$/.exec(suffix);
    if (pathCommand)
      return send(res, 200, {
        path: await learning.command(
          pathCommand[1]!,
          await body(100 * 1024),
          access,
        ),
      });
    const revoke = /^\/materials\/(lm_[a-f0-9]{64})\/revoke$/.exec(suffix);
    if (revoke) {
      const input = z
        .object({ requestId: LearningId, consent: z.literal(true) })
        .strict()
        .parse(await body(1024));
      return send(res, 200, {
        material: await learning.revoke(revoke[1]!, input.requestId, access),
      });
    }
  }
  return send(res, 404, { error: "learning_endpoint_not_found" });
}
