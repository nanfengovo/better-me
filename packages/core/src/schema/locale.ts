import { z } from "zod";

/** Homologous bilingual text — one fact, two locales (never two inventing sources). */
export const LocalizedStringSchema = z.object({
  zh: z.string().min(1),
  en: z.string().optional(),
});

export type LocalizedString = z.infer<typeof LocalizedStringSchema>;

export const LocaleSchema = z.enum(["zh", "en"]);
export type Locale = z.infer<typeof LocaleSchema>;

export function pickLocale(
  value: LocalizedString,
  locale: Locale,
): string {
  if (locale === "en" && value.en?.trim()) return value.en;
  return value.zh;
}
