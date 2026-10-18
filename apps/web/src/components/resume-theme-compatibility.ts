import { getResumeTemplate, resolveResumeTemplate } from "./template-catalog";

/** Layouts retain their geometry. Source adaptations keep their own ornaments. */
export function getResumeThemeCompatibility(templateId: string) {
  const template = getResumeTemplate(resolveResumeTemplate(templateId));
  return { palette: true, typography: true, decoration: template.source === "original" ? "full" as const : "template" as const };
}

export function recommendedResumeTheme(templateId: string): string {
  if (templateId === "en-ats" || /engineering|harvard|sb2nov|ink|mono|academic/.test(templateId)) return "mono-minimal";
  if (/editorial|elegant|desert|creative/.test(templateId)) return "editorial-warm";
  if (/modern|stackoverflow|tech/.test(templateId)) return "tech-teal";
  if (/classic|executive|professional/.test(templateId)) return "corporate-navy";
  return "forest-professional";
}
