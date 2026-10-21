import {
  defineTool, ToolError, ReadCompensationReviewInputSchema, CompensationReviewReadResultSchema,
  PreviewCompensationReviewInputSchema, CompensationReviewPreviewSchema,
  ConfirmCompensationReviewInputSchema, RevokeCompensationReviewInputSchema, CompensationReviewReceiptSchema,
  type ToolHandlerContext,
} from "@better-me/opportunities";
import { RepositoryError, type JobRepository } from "./repository.js";

function writeOptions(context: ToolHandlerContext, expectedRevision: number) {
  context.throwIfCancelled();
  if (!context.idempotencyKey) throw new ToolError("invalid-context");
  return { actorScope: context.actorScope, idempotencyKey: context.idempotencyKey, expectedRevision,
    throwIfCancelled: () => { try { context.throwIfCancelled(); } catch { throw new RepositoryError("cancelled"); } } };
}

/** A local evidence review never fetches new text, edits the disclosure or supplies an FX rate. */
export function createCompensationReviewTools(repository: JobRepository) {
  return [
    defineTool({ name: "compensations.read-review", version: 1, effect: "read-index",
      description: "同一索引版本读取该来源薪资、有效薪资及追加核对历史，不采集或写入。",
      inputSchema: ReadCompensationReviewInputSchema, outputSchema: CompensationReviewReadResultSchema,
      execute: (input, context) => { context.throwIfCancelled(); return repository.readCompensationReview(input); } }),
    defineTool({ name: "compensations.preview-review", version: 1, effect: "read-index",
      description: "以该岗位已保存的同来源披露逐字段核对薪资，预览税制、薪资项与明确计薪口径，不写入。",
      inputSchema: PreviewCompensationReviewInputSchema, outputSchema: CompensationReviewPreviewSchema,
      execute: (input, context) => { context.throwIfCancelled(); return repository.previewCompensationReview(input); } }),
    defineTool({ name: "compensations.confirm-review", version: 1, effect: "local-write",
      description: "本人明确审核后追加来源绑定的薪资核对；保留原文，仍待核实，可撤销，来源变化永久停用。",
      inputSchema: ConfirmCompensationReviewInputSchema, outputSchema: CompensationReviewReceiptSchema,
      recoverInterrupted: (input, context) => repository.findCompensationReviewReceipt("compensations.confirm-review", input, writeOptions(context, input.expectedRevision)),
      execute: (input, context) => repository.confirmCompensationReview(input, writeOptions(context, input.expectedRevision)) }),
    defineTool({ name: "compensations.revoke-review", version: 1, effect: "local-write",
      description: "追加撤销本人的薪资核对，保留来源和历史，恢复仍适用的前次核对或来源薪资。",
      inputSchema: RevokeCompensationReviewInputSchema, outputSchema: CompensationReviewReceiptSchema,
      recoverInterrupted: (input, context) => repository.findCompensationReviewReceipt("compensations.revoke-review", input, writeOptions(context, input.expectedRevision)),
      execute: (input, context) => repository.revokeCompensationReview(input, writeOptions(context, input.expectedRevision)) }),
  ] as const;
}
