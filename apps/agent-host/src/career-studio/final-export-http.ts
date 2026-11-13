import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CareerStudio } from "./service.js";
import { StudioError } from "./storage.js";
import type { StudioAccess } from "./contracts.js";
import { FinalExportRenderError, type createFinalExportRenderer } from "./final-export-renderer.js";

export type CareerFinalExportRenderer = ReturnType<typeof createFinalExportRenderer>;
const inputSchema = z.object({ contextId: z.string().uuid(), operationId: z.string().min(1).max(160),
  format: z.enum(["pdf", "docx"]), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/), inputBase64: z.string().min(4).max(12_000_000), consent: z.literal(true),
}).strict();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Actual file export is an independent, explicit operation. No file/HTML is
 * persisted, no binary paths are accepted from HTTP, and a disconnect cancels
 * rendering rather than permitting a late successful response. */
export function createFinalExportHttp(options: {
  studio: CareerStudio; renderer?: CareerFinalExportRenderer;
  readBody(req: IncomingMessage): Promise<unknown>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
}) {
  return async (req: IncomingMessage, res: ServerResponse, pathname: string, access: StudioAccess): Promise<boolean> => {
    if (pathname !== "/api/v1/agent/career-studio/layout/export") return false;
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once("aborted", abort); res.once("close", abort);
    try {
      if (req.method !== "POST") throw new StudioError("studio_method_denied", 405);
      const input = inputSchema.parse(await options.readBody(req));
      const context = await options.studio.getContext(input.contextId, access);
      if (context.sourceFingerprint !== input.contentHash) throw new StudioError("final_export_source_stale");
      if (!options.renderer) throw new StudioError("final_export_renderer_not_configured", 422);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.inputBase64)) throw new StudioError("final_export_input_encoding_invalid", 400);
      const bytes = Buffer.from(input.inputBase64, "base64");
      if (bytes.toString("base64") !== input.inputBase64 || hash(bytes) !== input.inputSha256) throw new StudioError("final_export_input_hash_mismatch", 400);
      const isCurrent = async () => {
        if (controller.signal.aborted) return false;
        try { return (await options.studio.getContext(input.contextId, access)).sourceFingerprint === input.contentHash; } catch { return false; }
      };
      const result = await options.renderer.render({ format: input.format, input: bytes, inputContentHash: input.contentHash, signal: controller.signal, isCurrent });
      if (!await isCurrent()) throw new StudioError("final_export_source_stale");
      // JSON/base64 transport has its own stricter cap; never silently truncate.
      if (result.pdfBytes.length > 8_000_000 || result.sourceBytes.length > 8_000_000 || (input.format === "docx" && result.pdfBytes.length + result.sourceBytes.length > 11_000_000)) throw new StudioError("final_export_response_budget", 413);
      options.sendJson(res, 200, { operationId: input.operationId, contextId: input.contextId, format: result.format,
        contentHash: result.inputContentHash, sourceSha256: result.sourceSha256, renderedSha256: result.renderedSha256,
        artifactBase64: (input.format === "pdf" ? result.pdfBytes : result.sourceBytes).toString("base64"),
        ...(input.format === "docx" ? { renderedPdfBase64: result.pdfBytes.toString("base64") } : {}),
        receipt: { id: `${input.operationId}:${result.renderedSha256.slice(0, 16)}`, renderer: result.renderer, renderedAt: result.at },
        limitations: ["文件哈希与本次版本绑定不是事实真实性或人工视觉验收证明。", "DOCX的派生PDF只说明这个本机排版器的观察，不保证其他Word版本分页一致。"] });
    } catch (error) {
      const code = error instanceof StudioError || error instanceof FinalExportRenderError ? error.code : error instanceof z.ZodError ? "invalid_final_export_input" : "final_export_unavailable";
      if (!res.destroyed && !res.writableEnded) options.sendJson(res, error instanceof StudioError ? error.status : error instanceof z.ZodError ? 400 : 409, { error: code });
    } finally { controller.abort(); req.off("aborted", abort); res.off("close", abort); }
    return true;
  };
}
