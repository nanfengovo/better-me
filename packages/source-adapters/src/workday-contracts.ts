import { z } from "zod";

/** Data-only tenant configuration. Endpoint origin, routes and request method live in adapter code. */
export const WorkdaySourceOptionsSchema = z.object({
  tenant: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  site: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  pageSize: z.number().int().min(1).max(100).default(20),
  maxDetailRequestsPerPage: z.number().int().min(0).max(10).default(2),
}).strict();
export type WorkdaySourceOptions = z.infer<typeof WorkdaySourceOptionsSchema>;
