import { z } from "zod";

export const JsonMappingPathSchema = z.string().max(500).refine((path) => path === '' || path.split('.').every((part) =>
  /^[\p{L}\p{N}_-]{1,100}$/u.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part)), 'Expected a finite own-property field path');
export const JsonFieldMappingSchema = z.object({
  recordsPath: JsonMappingPathSchema.default(''),
  idPath: JsonMappingPathSchema.optional(), titlePath: JsonMappingPathSchema,
  urlPath: JsonMappingPathSchema.optional(), applicationUrlPath: JsonMappingPathSchema.optional(), companyPath: JsonMappingPathSchema.optional(),
  descriptionPath: JsonMappingPathSchema.optional(), locationsPath: JsonMappingPathSchema.optional(), salaryTextPath: JsonMappingPathSchema.optional(),
  publishedPath: JsonMappingPathSchema.optional(), updatedPath: JsonMappingPathSchema.optional(),
  discoveryOnly: z.boolean().default(true),
}).strict();
export type JsonFieldMapping = z.infer<typeof JsonFieldMappingSchema>;
