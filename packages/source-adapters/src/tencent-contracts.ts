import { z } from "zod";

/** Inert configuration for the reviewed public Tencent Query protocol, not an arbitrary URL proxy. */
export const TencentSourceOptionsSchema = z.object({
  companyName: z.string().trim().min(1).max(500).default("腾讯"),
  apiHost: z.literal("careers.tencent.com").default("careers.tencent.com"),
  language: z.enum(["zh-cn", "en-us"]).default("zh-cn"),
  pageSize: z.number().int().min(1).max(100).default(20),
  fetchDetails: z.boolean().default(false),
  maxDetailRequestsPerPage: z.number().int().min(1).max(10).default(2),
}).strict();
export type TencentSourceOptions = z.infer<typeof TencentSourceOptionsSchema>;
