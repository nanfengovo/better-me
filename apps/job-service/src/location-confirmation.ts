import { defineTool, PreviewLocationConfirmationInputSchema, ConfirmLocationInputSchema, RevokeLocationConfirmationInputSchema, LocationConfirmationPreviewSchema, LocationConfirmationReceiptSchema, ToolError, type ToolHandlerContext } from "@better-me/opportunities";
import type { JobRepository } from "./repository.js";

function writeOptions(context: ToolHandlerContext, expectedRevision: number) {
  context.throwIfCancelled();
  if (!context.idempotencyKey) throw new ToolError("invalid-context");
  return { actorScope: context.actorScope, idempotencyKey: context.idempotencyKey, expectedRevision };
}
/** Identical tool definitions back the authenticated HTTP/UI and future Agent executor. */
export function createLocationConfirmationTools(repository: JobRepository) {
  return [
    defineTool({ name: "locations.preview-confirmation", version: 1, effect: "read-index", description: "预览本人确认的国家及省市区，保留原地点原文与证据，不生成坐标、不写索引。", inputSchema: PreviewLocationConfirmationInputSchema, outputSchema: LocationConfirmationPreviewSchema,
      execute: (input, context) => { context.throwIfCancelled(); return repository.previewLocationConfirmation(input); } }),
    defineTool({ name: "locations.confirm", version: 1, effect: "local-write", description: "明确核对后保存可撤销的地区确认；原始来源地点不变，不代表办公室地址已核实。", inputSchema: ConfirmLocationInputSchema, outputSchema: LocationConfirmationReceiptSchema,
      execute: (input, context) => repository.confirmLocation(input, writeOptions(context, input.expectedRevision)) }),
    defineTool({ name: "locations.revoke-confirmation", version: 1, effect: "local-write", description: "追加撤销本人地区确认的决议并恢复上一有效选择或来源地点，历史保持不变。", inputSchema: RevokeLocationConfirmationInputSchema, outputSchema: LocationConfirmationReceiptSchema,
      execute: (input, context) => repository.revokeLocationConfirmation(input, writeOptions(context, input.expectedRevision)) }),
  ] as const;
}
