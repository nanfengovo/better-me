import { getResumeLayout, resolveResumeTheme, type ProjectedResume } from "@better-me/core";

/** Page canvas must use the paper token too, including below short documents. */
export function getResumePrintCss(resume: Pick<ProjectedResume, "layout" | "themeId" | "themeOverrides">): string {
  const margin = Math.max(12, Math.min(28, getResumeLayout(resume.layout).pageMargin));
  const paper = resume.themeId ? resolveResumeTheme(resume).tokens.colors.paper : undefined;
  return `@page { size: A4; margin: ${margin}mm;${paper ? ` background: ${paper};` : ""} }${paper ? ` html, body { background: ${paper} !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }` : ""}`;
}
