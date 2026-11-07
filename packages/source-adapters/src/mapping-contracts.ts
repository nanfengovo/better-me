import { z } from "zod";

export const JsonMappingPathSchema = z.string().max(500).refine((path) => path === '' || path.split('.').every((part) =>
  /^[\p{L}\p{N}_-]{1,100}$/u.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part)), 'Expected a finite own-property field path');
export const JsonFieldMappingSchema = z.object({
  recordsPath: JsonMappingPathSchema.default(''),
  idPath: JsonMappingPathSchema.optional(), titlePath: JsonMappingPathSchema,
  urlPath: JsonMappingPathSchema.optional(), applicationUrlPath: JsonMappingPathSchema.optional(), companyPath: JsonMappingPathSchema.optional(),
  descriptionPath: JsonMappingPathSchema.optional(), locationsPath: JsonMappingPathSchema.optional(), salaryTextPath: JsonMappingPathSchema.optional(),
  publishedPath: JsonMappingPathSchema.optional(), updatedPath: JsonMappingPathSchema.optional(),
  /** Feed bodies can be excerpts even when the API supplies non-empty text. */
  descriptionCompleteness: z.enum(['excerpt', 'detail']).default('detail'),
  /** False for a latest-jobs window or one known page of a larger feed. */
  enumerationComplete: z.boolean().default(true),
  /** Numeric timestamps are only interpreted when their units are explicitly configured. */
  publishedFormat: z.enum(['iso', 'unix-seconds', 'unix-milliseconds']).default('iso'),
  discoveryOnly: z.boolean().default(true),
}).strict();
export type JsonFieldMapping = z.infer<typeof JsonFieldMappingSchema>;
