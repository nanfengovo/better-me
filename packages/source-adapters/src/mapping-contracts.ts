import { z } from "zod";

export const JsonMappingPathSchema = z.string().max(500).refine((path) => path === '' || path.split('.').every((part) =>
  /^[\p{L}\p{N}_-]{1,100}$/u.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part)), 'Expected a finite own-property field path');
const JsonFieldMappingObjectSchema = z.object({
  recordsPath: JsonMappingPathSchema.default(''),
  idPath: JsonMappingPathSchema.optional(), titlePath: JsonMappingPathSchema,
  urlPath: JsonMappingPathSchema.optional(), applicationUrlPath: JsonMappingPathSchema.optional(), companyPath: JsonMappingPathSchema.optional(),
  descriptionPath: JsonMappingPathSchema.optional(), locationsPath: JsonMappingPathSchema.optional(), salaryTextPath: JsonMappingPathSchema.optional(),
  /** Optional subpaths are relative to each entry of locationsPath, never another location or the row. */
  locationTextPath: JsonMappingPathSchema.optional(), locationCountryPath: JsonMappingPathSchema.optional(),
  locationRegionPath: JsonMappingPathSchema.optional(), locationCityPath: JsonMappingPathSchema.optional(),
  locationStreetAddressPath: JsonMappingPathSchema.optional(), locationPostalCodePath: JsonMappingPathSchema.optional(),
  /** Omission means ISO2; it intentionally adds no default property to legacy cursor fingerprints. */
  locationCountryFormat: z.enum(['iso2', 'name']).optional(),
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
});
function refineMapping(mapping: z.infer<typeof JsonFieldMappingObjectSchema>, context: z.RefinementCtx): void {
  const paths = ['locationTextPath', 'locationCountryPath', 'locationRegionPath', 'locationCityPath',
    'locationStreetAddressPath', 'locationPostalCodePath', 'locationCountryFormat'] as const;
  for (const path of paths) if (mapping[path] !== undefined && mapping.locationsPath === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: 'A location subfield requires an explicit locationsPath; an empty path selects the row.' });
  }
  if (mapping.locationCountryFormat !== undefined && mapping.locationCountryPath === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['locationCountryFormat'], message: 'A country format requires an explicit locationCountryPath.' });
  }
}
export const JsonFieldMappingSchema = JsonFieldMappingObjectSchema.strict().superRefine(refineMapping);
/** Source options can also contain host-owned values; retain the same mapping refinements after stripping them. */
export const JsonFieldMappingOptionsSchema = JsonFieldMappingObjectSchema.strip().superRefine(refineMapping);
export type JsonFieldMapping = z.infer<typeof JsonFieldMappingSchema>;
