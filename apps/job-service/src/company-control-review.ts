import {
  defineTool, ToolError, ReadCompanyControlReviewInputSchema, CompanyControlReviewReadResultSchema,
  PreviewCompanyControlReviewInputSchema, CompanyControlReviewPreviewSchema,
  ConfirmCompanyControlReviewInputSchema, RevokeCompanyControlReviewInputSchema, CompanyControlReviewReceiptSchema,
  type ToolHandlerContext,
} from "@better-me/opportunities";
import { RepositoryError, type JobRepository } from "./repository.js";

function writeOptions(context: ToolHandlerContext, expectedRevision: number) {
  context.throwIfCancelled();
  if (!context.idempotencyKey) throw new ToolError("invalid-context");
  return { actorScope: context.actorScope, idempotencyKey: context.idempotencyKey, expectedRevision,
    throwIfCancelled: () => { try { context.throwIfCancelled(); } catch { throw new RepositoryError("cancelled"); } } };
}

/** These tools archive explicit user-reviewed citations; they do not fetch or certify a company. */
export function createCompanyControlReviewTools(repository: JobRepository) {
  return [
    defineTool({ name: "companies.read-control-review", version: 1, effect: "read-index",
      description: "按同版岗位与公司标识读取来源公司、有效分类及追加控股核对历史，不采集或写入。",
      inputSchema: ReadCompanyControlReviewInputSchema, outputSchema: CompanyControlReviewReadResultSchema,
      execute: (input, context) => { context.throwIfCancelled(); return repository.readCompanyControlReview(input); } }),
    defineTool({ name: "companies.preview-control-review", version: 1, effect: "read-index",
      description: "依据逐字段原句预览实际雇主、母公司与最终控制方；仅本人核对引用，不表示官方认证。",
      inputSchema: PreviewCompanyControlReviewInputSchema, outputSchema: CompanyControlReviewPreviewSchema,
      execute: (input, context) => { context.throwIfCancelled(); return repository.previewCompanyControlReview(input); } }),
    defineTool({ name: "companies.confirm-control-review", version: 1, effect: "local-write",
      description: "明确审核后归档企业原文和哈希，追加可撤销核对并更新同公司岗位分类；保留来源底账。",
      inputSchema: ConfirmCompanyControlReviewInputSchema, outputSchema: CompanyControlReviewReceiptSchema,
      recoverInterrupted: (input, context) => repository.findCompanyControlReviewReceipt("companies.confirm-control-review", input, writeOptions(context, input.expectedRevision)),
      execute: (input, context) => repository.confirmCompanyControlReview(input, writeOptions(context, input.expectedRevision)) }),
    defineTool({ name: "companies.revoke-control-review", version: 1, effect: "local-write",
      description: "追加撤销本人的企业控股核对；保留证据和历史，恢复仍适用的前次核对或来源分类。",
      inputSchema: RevokeCompanyControlReviewInputSchema, outputSchema: CompanyControlReviewReceiptSchema,
      recoverInterrupted: (input, context) => repository.findCompanyControlReviewReceipt("companies.revoke-control-review", input, writeOptions(context, input.expectedRevision)),
      execute: (input, context) => repository.revokeCompanyControlReview(input, writeOptions(context, input.expectedRevision)) }),
  ] as const;
}
