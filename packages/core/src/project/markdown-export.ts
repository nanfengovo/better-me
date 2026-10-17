import { getResumeSectionOrder, splitStyledText, type TextStyleRange } from "../schema/resume.js";
import type { ProjectedResume, ProjectedExperience } from "./resume-projection.js";

function escapeMarkdown(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([\\`*_[\]{}])/g, "\\$1");
}

function formatText(text: string, ranges?: TextStyleRange[]): string {
  return splitStyledText(text, ranges).map((segment) => {
    // Markdown emphasis cannot start or finish with whitespace. Keep it outside markers.
    const [, leading = "", middle = "", trailing = ""] = segment.text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    let content = escapeMarkdown(middle);
    if (!content) return leading + trailing;
    if (segment.style.bold) content = `**${content}**`;
    if (segment.style.italic) content = `*${content}*`;
    if (segment.style.underline) content = `<u>${content}</u>`;
    if (segment.style.highlight) content = `<mark>${content}</mark>`;
    return leading + content + trailing;
  }).join("");
}

function safeMarkdownUrl(url: string): string | undefined {
  return /^(https?:|data:image\/)/i.test(url) ? url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/[\r\n<>]/g, "") : undefined;
}

/** Export the same selected facts and section order as preview; sizes/margins belong to PDF. */
export function projectedResumeToMarkdown(resume: ProjectedResume): string {
  const isZh = resume.locale === "zh";
  const lines: string[] = [];
  const styled = (text: string, key: string) => formatText(text, resume.textStyles?.[`${key}:${resume.locale}`]);
  lines.push(`# ${styled(resume.profile.displayName, "profile:displayName")}`);
  if (resume.profile.headline) lines.push(`> ${styled(resume.profile.headline, "profile:headline")}`);
  lines.push("");
  const avatar = resume.templateId !== "en-ats" && resume.profile.avatarUrl ? safeMarkdownUrl(resume.profile.avatarUrl) : undefined;
  if (avatar) lines.push(`![${isZh ? "照片" : "Portrait"}](${avatar})`, "");
  const meta = [resume.profile.location, resume.profile.education, resume.profile.phone, resume.profile.email].filter((item): item is string => Boolean(item));
  if (meta.length) lines.push(meta.map(escapeMarkdown).join(" | "), "");
  const links = resume.profile.links.flatMap((link) => {
    const url = safeMarkdownUrl(link.url);
    return url ? [`[${escapeMarkdown(link.label)}](${url})`] : [];
  });
  if (links.length) lines.push(links.join(" | "), "");

  const renderExperiences = (experiences: ProjectedExperience[], kind: "experience" | "projects" | "education") => {
    for (const exp of experiences) {
      const end = exp.end ?? (isZh ? "至今" : "Present");
      const name = kind === "projects" ? exp.projectName || exp.org : exp.org;
      const title = [name, exp.title].filter(Boolean).map(escapeMarkdown).join(" · ");
      lines.push(`### ${title} (${exp.start} ~ ${end})`);
      if (kind === "experience" && exp.projectName) lines.push(`**${isZh ? "项目" : "Project"}**: ${escapeMarkdown(exp.projectName)}`);
      const url = exp.url ? safeMarkdownUrl(exp.url) : undefined;
      if (url) lines.push(`[${isZh ? "相关链接" : "Link"}](${url})`);
      if (exp.techStack.length) lines.push(`**${isZh ? "技术栈" : "Technologies"}**: ${exp.techStack.map(escapeMarkdown).join(" · ")}`);
      lines.push("");
      for (const claim of exp.claims) lines.push(`- ${styled(claim.text, `claim:${claim.id}`).replace(/\n/g, "\n  ")}`);
      lines.push("");
    }
  };

  for (const section of getResumeSectionOrder(resume.sectionOrder)) {
    if (resume.sectionVisibility?.[section] === false) continue;
    if (section === "summary") {
      if (resume.profile.targetRoles.length) lines.push(`## ${isZh ? "目标方向" : "Target Roles"}`, ...resume.profile.targetRoles.map((role) => `- ${escapeMarkdown(role)}`), "");
      if (resume.profile.traits.length) lines.push(`## ${isZh ? "核心优势与专长" : "Key Competencies"}`, resume.profile.traits.map(escapeMarkdown).join(" · "), "");
    } else if (section === "skills") {
      const skills = resume.skills ?? [...new Set(resume.experiences.flatMap((exp) => exp.techStack))];
      if (skills.length) lines.push(`## ${isZh ? "专业技能" : "Technical Skills"}`, skills.map(escapeMarkdown).join(" · "), "");
    } else if (section !== "custom") {
      const experiences = resume.experiences.filter((exp) => section === "experience" ? exp.type === "work" : section === "education" ? exp.type === "education" : exp.type === "opensource" || exp.type === "other");
      if (!experiences.length && !(section === "education" && resume.educationSummary)) continue;
      const title = section === "experience" ? isZh ? "工作经历" : "Work Experience" : section === "education" ? isZh ? "教育背景" : "Education" : isZh ? "项目与作品经历" : "Projects & Works";
      lines.push(`## ${title}`, "");
      if (section === "education" && resume.educationSummary && experiences.length === 0) lines.push(escapeMarkdown(resume.educationSummary), "");
      renderExperiences(experiences, section);
    }
  }
  return lines.join("\n").trim() + "\n";
}
