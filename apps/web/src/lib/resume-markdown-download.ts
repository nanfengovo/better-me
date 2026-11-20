import { projectedResumeToMarkdown, type ProjectedResume } from "@better-me/core";

export function downloadResumeMarkdown(resume: ProjectedResume, editionName?: string) {
  const blob = new Blob([projectedResumeToMarkdown(resume)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  // eslint-disable-next-line no-control-regex -- Filenames must be portable across desktop platforms.
  const name = (editionName || resume.profile.displayName).replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").slice(0,120);
  link.download = `resume-${resume.locale}-${name}.md`;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
