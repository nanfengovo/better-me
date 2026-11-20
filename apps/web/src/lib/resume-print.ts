import { getResumeLayout, resolveResumeTheme, type ProjectedResume } from "@better-me/core";

/** The entire printed page belongs to the resume, including space below a short resume. */
export function getResumePrintCss(resume: Pick<ProjectedResume, "layout" | "themeId" | "themeOverrides">): string {
  const margin = Math.max(12, Math.min(28, getResumeLayout(resume.layout).pageMargin));
  const paper = resume.themeId ? resolveResumeTheme(resume).tokens.colors.paper : "#ffffff";
  return `
    @page { size: A4; margin: ${margin}mm; background: ${paper}; }
    html:root, html:root body { background: ${paper} !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    #root .agent-layout, #root .os-business-window {
      background: transparent !important; transition: none !important; border-radius: 0 !important;
    }
  `;
}
