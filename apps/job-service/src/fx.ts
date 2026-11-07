import { z } from "zod";
import {
  defineTool, ToolError, ReadFxStateInputSchema, FxStateSchema,
  PreviewFxImportInputSchema, FxImportPreviewSchema, ConfirmFxImportInputSchema,
  ActivateFxSnapshotInputSchema, FxMutationReceiptSchema, FxImportDraftSchema,
  type FxImportDraft, type ToolHandlerContext,
} from "@better-me/opportunities";
import { RepositoryError, type JobRepository } from "./repository.js";

export interface FxReferenceProvider { read(context: ToolHandlerContext): Promise<FxImportDraft> }

function writeOptions(context: ToolHandlerContext, expectedRevision: number) {
  context.throwIfCancelled();
  if (!context.idempotencyKey) throw new ToolError("invalid-context");
  return { actorScope: context.actorScope, idempotencyKey: context.idempotencyKey, expectedRevision,
    throwIfCancelled: () => { try { context.throwIfCancelled(); } catch { throw new RepositoryError("cancelled"); } } };
}

/** Public source reading is separate from preview, persistence and explicit selection. */
export function createFxTools(repository: JobRepository, provider?: FxReferenceProvider) {
  return [
    defineTool({ name: "fx.fetch-reference", version: 1, effect: "external-read",
      description: "读取宿主安装的固定参考汇率来源原文，返回待核对草稿；不保存或自动启用。",
      inputSchema: z.object({}).strict(), outputSchema: FxImportDraftSchema,
      execute: async (_input, context) => {
        context.throwIfCancelled(); if (!provider) throw new ToolError("unsupported-capability");
        const result = await provider.read(context); context.throwIfCancelled(); return result;
      } }),
    defineTool({ name: "fx.read-state", version: 1, effect: "read-index",
      description: "读取同一岗位索引版本的参考汇率快照、当前选择和查询时间上下文，不采集。",
      inputSchema: ReadFxStateInputSchema, outputSchema: FxStateSchema,
      execute: (input, context) => { context.throwIfCancelled(); return repository.readFxState(input); } }),
    defineTool({ name: "fx.preview-import", version: 1, effect: "read-index",
      description: "从保留原文重算EUR参考价到人民币汇率，校验来源日期并预览；不写岗位或汇率。",
      inputSchema: PreviewFxImportInputSchema, outputSchema: FxImportPreviewSchema,
      execute: (input, context) => { context.throwIfCancelled(); return repository.previewFxImport(input); } }),
    defineTool({ name: "fx.confirm-import", version: 1, effect: "local-write",
      description: "明确核对预览后保存带出处的不可变参考汇率快照，可同时选择启用；不改来源薪资。",
      inputSchema: ConfirmFxImportInputSchema, outputSchema: FxMutationReceiptSchema,
      recoverInterrupted: (input, context) => repository.findFxReceipt("fx.confirm-import", input, writeOptions(context, input.expectedRevision)),
      execute: (input, context) => repository.confirmFxImport(input, writeOptions(context, input.expectedRevision)) }),
    defineTool({ name: "fx.activate", version: 1, effect: "local-write",
      description: "明确选择已保存参考汇率或停用换算，追加历史并提高共同索引版本；保留来源原币。",
      inputSchema: ActivateFxSnapshotInputSchema, outputSchema: FxMutationReceiptSchema,
      recoverInterrupted: (input, context) => repository.findFxReceipt("fx.activate", input, writeOptions(context, input.expectedRevision)),
      execute: (input, context) => repository.activateFxSnapshot(input, writeOptions(context, input.expectedRevision)) }),
  ] as const;
}
