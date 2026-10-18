import { createJobQueryService, JobQueryError, JobQuerySchema, type JobQuery, type QueryOptions } from "./query.js";
import { JobQueryResultSchema } from "./query-output.js";
import { defineTool, ToolError, type ToolHandlerContext } from "./tools.js";

export type JobQueryService = ReturnType<typeof createJobQueryService>;

/** Resolve private anchors/configuration inside the trusted host, outside tool arguments. */
export function createJobsSearchTool(
  service: JobQueryService,
  resolveOptions: (query: JobQuery, context: ToolHandlerContext) => QueryOptions | Promise<QueryOptions> = () => ({}),
) {
  return defineTool({
    name: "jobs.search", version: 1,
    description: "查询同一岗位索引，返回全量地图桶/统计、分页列表、原始来源及未知值；不执行来源采集。",
    effect: "read-index", inputSchema: JobQuerySchema, outputSchema: JobQueryResultSchema,
    execute: async (query, context) => {
      context.throwIfCancelled();
      try {
        const options = await resolveOptions(query, context);
        context.throwIfCancelled();
        const result = await service.search(query, options);
        context.throwIfCancelled();
        // Zod domain inputs may contain explicit optional undefined. This known response is projected
        // into its JSON representation here; the general tool executor remains strict for all tools.
        return JSON.parse(JSON.stringify(result)) as typeof result;
      } catch (error) {
        if (error instanceof JobQueryError) {
          throw new ToolError(error.code === "stale-cursor" ? "stale-version" : error.code === "anchor-required" ? "location-unresolved" : "invalid-input");
        }
        throw error;
      }
    },
  });
}
