import {
  defineTool,
  ToolError,
  PreviewCompanyControllerOverrideInputSchema,
  CompanyControllerOverridePreviewSchema,
  ConfirmCompanyControllerOverrideInputSchema,
  CompanyControllerOverrideReceiptSchema,
  RevokeCompanyControllerOverrideInputSchema,
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

export function createCompanyControllerTools(repository: JobRepository) {
  return [
    defineTool({
      name: "companies.preview-controller-override",
      version: 1,
      effect: "read-index",
      description: "预览人工核实的企业最终控股方与所有制分类着色，保留证据链，不写数据库。",
      inputSchema: PreviewCompanyControllerOverrideInputSchema,
      outputSchema: CompanyControllerOverridePreviewSchema,
      execute: (input, context) => {
        context.throwIfCancelled();
        return repository.previewCompanyControllerOverride(input);
      },
    }),
    defineTool({
      name: "companies.confirm-controller-override",
      version: 1,
      effect: "local-write",
      description: "在人工审核证据链后确认最终控股方与所有制分类，支持撤销并保留决策历史。",
      inputSchema: ConfirmCompanyControllerOverrideInputSchema,
      outputSchema: CompanyControllerOverrideReceiptSchema,
      execute: (input, context) => repository.confirmCompanyControllerOverride(input, writeOptions(context, input.expectedRevision)),
    }),
    defineTool({
      name: "companies.revoke-controller-override",
      version: 1,
      effect: "local-write",
      description: "撤销企业最终控股方的人工确认，恢复上一有效状态或原始采集结果，保留历史。",
      inputSchema: RevokeCompanyControllerOverrideInputSchema,
      outputSchema: CompanyControllerOverrideReceiptSchema,
      execute: (input, context) => repository.revokeCompanyControllerOverride(input, writeOptions(context, input.expectedRevision)),
    }),
  ] as const;
}
