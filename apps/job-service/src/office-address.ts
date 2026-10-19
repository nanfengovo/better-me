import {
  defineTool, ToolError, OfficeAddressCandidatesInputSchema, OfficeAddressCandidatesResultSchema, OfficeAddressCandidateSchema,
  PreviewOfficeConfirmationInputSchema, ConfirmOfficeAddressInputSchema, RevokeOfficeAddressInputSchema, OfficeAddressPreviewSchema, OfficeAddressReceiptSchema,
  type JobLocation, type OfficeAddressCandidate, type ToolHandlerContext,
} from "@better-me/opportunities";
import { RepositoryError, type JobRepository } from "./repository.js";

/** Installed only by the host. Requests cannot select endpoints, credentials or coordinate transformations. */
export interface OfficeAddressProvider {
  readonly providerId: string;
  search(input: { query: string; location: JobLocation }, context: ToolHandlerContext): Promise<readonly OfficeAddressCandidate[]>;
}
function writeOptions(context: ToolHandlerContext, expectedRevision: number) {
  context.throwIfCancelled();
  if (!context.idempotencyKey) throw new ToolError("invalid-context");
  return { actorScope: context.actorScope, idempotencyKey: context.idempotencyKey, expectedRevision, throwIfCancelled: () => { try { context.throwIfCancelled(); } catch { throw new RepositoryError("cancelled"); } } };
}
export function createOfficeAddressTools(repository: JobRepository, provider?: OfficeAddressProvider) {
  return [
    defineTool({ name: "locations.office-address-candidates", version: 1, effect: provider ? "external-read" : "read-index",
      description: "读取该岗位来源地址；仅明确提交地址查询且宿主已配置provider时外部查候选。候选不是雇主地址认证，不自动保存。",
      inputSchema: OfficeAddressCandidatesInputSchema, outputSchema: OfficeAddressCandidatesResultSchema,
      execute: async (input, context) => {
        context.throwIfCancelled();
        const target = await repository.readOfficeAddressTarget(input);
        if (!input.query || !provider) return { ...target, configured: Boolean(provider), status: input.query ? "not-configured" as const : "manual-available" as const, candidates: [],
          warnings: [input.query && !provider ? "尚未配置地址查询provider，可手工填写来源确实披露的街址、WGS84坐标和出处核对。" : "来源原文保留不变；可核对街址与WGS84坐标，或明确输入地址查询。"] };
        const candidates = (await provider.search({ query: input.query, location: target.sourceLocation }, context)).map(candidate => OfficeAddressCandidateSchema.parse(candidate));
        context.throwIfCancelled();
        if (candidates.length > 20 || candidates.some(candidate => candidate.providerId !== provider.providerId)) throw new ToolError("source-changed");
        // A slow provider response cannot be applied to a new source/admin snapshot.
        await repository.readOfficeAddressTarget(input);
        return { ...target, configured: true, status: candidates.length ? "candidates" as const : "no-address-match" as const, candidates,
          warnings: ["地址provider候选仅供参考。请核对岗位原文与办公地点关联；保存仍是本人确认，不代表provider或雇主认证。"] };
      } }),
    defineTool({ name: "locations.preview-office-confirmation", version: 1, effect: "read-index", description: "预览具体街址与本人核对的WGS84位置，不写入，不将城市中心当办公室。",
      inputSchema: PreviewOfficeConfirmationInputSchema, outputSchema: OfficeAddressPreviewSchema,
      execute: (input, context) => { context.throwIfCancelled(); return repository.previewOfficeConfirmation(input); } }),
    defineTool({ name: "locations.confirm-office-address", version: 1, effect: "local-write", description: "本人明确核对后保存可撤销办公地址位置；来源及地区变化会使旧确认失效，仍标待核实。",
      inputSchema: ConfirmOfficeAddressInputSchema, outputSchema: OfficeAddressReceiptSchema,
      recoverInterrupted: (input, context) => repository.findOfficeAddressReceipt("locations.confirm-office-address", input, writeOptions(context, input.expectedRevision)),
      execute: (input, context) => repository.confirmOfficeAddress(input, writeOptions(context, input.expectedRevision)) }),
    defineTool({ name: "locations.revoke-office-address", version: 1, effect: "local-write", description: "追加撤销本人办公地址确认，恢复有效地区/来源位置，保留历史。",
      inputSchema: RevokeOfficeAddressInputSchema, outputSchema: OfficeAddressReceiptSchema,
      recoverInterrupted: (input, context) => repository.findOfficeAddressReceipt("locations.revoke-office-address", input, writeOptions(context, input.expectedRevision)),
      execute: (input, context) => repository.revokeOfficeAddress(input, writeOptions(context, input.expectedRevision)) }),
  ] as const;
}
