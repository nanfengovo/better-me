import {
  defineTool,
  ToolError,
  PreviewCompensationAuditInputSchema,
  CompensationAuditPreviewSchema,
  ConfirmCompensationAuditInputSchema,
  CompensationAuditReceiptSchema,
  RevokeCompensationAuditInputSchema,
  type ToolHandlerContext,
} from "@better-me/opportunities";
import { RepositoryError, type JobRepository } from "./repository.js";

function writeOptions(context: ToolHandlerContext, expectedRevision: number) {
  context.throwIfCancelled();
  if (!context.idempotencyKey) throw new ToolError("invalid-context");
  return {
    actorScope: context.actorScope,
    idempotencyKey: context.idempotencyKey,
    expectedRevision,
    throwIfCancelled: () => {
      try { context.throwIfCancelled(); } catch { throw new RepositoryError("cancelled"); }
    },
  };
}

export function createCompensationAuditTools(repository: JobRepository) {
  return [
    defineTool({
      name: "compensations.preview-audit",
      version: 1,
      effect: "read-index",
      description: "预览薪资折算与年化固定现金口径（税前/保证月数/CNY），保留出处原文与证据，不写数据库。",
      inputSchema: PreviewCompensationAuditInputSchema,
      outputSchema: CompensationAuditPreviewSchema,
      execute: (input, context) => {
        context.throwIfCancelled();
        return repository.previewCompensationAudit(input);
      },
    }),
    defineTool({
      name: "compensations.confirm-audit",
      version: 1,
      effect: "local-write",
      description: "明确核对薪资证据链后保存受审薪资，生成标准年化与CNY折算结果，点亮薪资排序与图表对比。",
      inputSchema: ConfirmCompensationAuditInputSchema,
      outputSchema: CompensationAuditReceiptSchema,
      execute: (input, context) => repository.confirmCompensationAudit(input, writeOptions(context, input.expectedRevision)),
    }),
    defineTool({
      name: "compensations.revoke-audit",
      version: 1,
      effect: "local-write",
      description: "撤销薪资人工审核结果，恢复原始来源采集的薪资记录，保留历史决策。",
      inputSchema: RevokeCompensationAuditInputSchema,
      outputSchema: CompensationAuditReceiptSchema,
      execute: (input, context) => repository.revokeCompensationAudit(input, writeOptions(context, input.expectedRevision)),
    }),
  ] as const;
}
