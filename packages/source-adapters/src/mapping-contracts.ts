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
  /** Opt-in pagination: follow only an explicitly returned increasing numeric page on this same endpoint. */
  nextPageUrlPath: JsonMappingPathSchema.refine(path => path.length > 0, 'A next-page field is required.').optional(),
  pageParameter: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/)
    .refine(value => !['__proto__', 'prototype', 'constructor'].includes(value)).default('page'),
  discoveryOnly: z.boolean().default(true),
}).strict();
export type JsonFieldMapping = z.infer<typeof JsonFieldMappingSchema>;
