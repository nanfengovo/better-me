import { z } from "zod";
import { CountryCodeSchema } from "@better-me/opportunities";

/** Data only: the public tenant Posting API is fixed by installed adapter code. */
export const SmartRecruitersSourceOptionsSchema = z.object({
  companyIdentifier: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  companyName: z.string().trim().min(1).max(500).optional(),
  /** An optional, explicitly configured board scope; requested geography is still checked locally. */
  countryCode: CountryCodeSchema.optional(),
  pageSize: z.number().int().min(1).max(100).default(20),
  fetchDetails: z.boolean().default(false),
  maxDetailRequestsPerPage: z.number().int().min(1).max(10).default(2),
}).strict();
export type SmartRecruitersSourceOptions = z.infer<typeof SmartRecruitersSourceOptionsSchema>;
