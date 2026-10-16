import type { ProjectedResume } from "./resume-projection.js";

/** Convert a ProjectedResume directly into clean, portable Markdown format. */
export function projectedResumeToMarkdown(resume: ProjectedResume): string {
  const isZh = resume.locale === "zh";
  const lines: string[] = [];

  // Name & Headline
  lines.push(`# ${resume.profile.displayName}`);
  if (resume.profile.headline) {
    lines.push(`> ${resume.profile.headline}`);
  }
  lines.push("");

  // Contact & Info
  const meta: string[] = [];
  if (resume.profile.location) meta.push(resume.profile.location);
  if (resume.profile.education) meta.push(resume.profile.education);
  if (resume.profile.phone) meta.push(resume.profile.phone);
  if (resume.profile.email) meta.push(resume.profile.email);
  if (meta.length > 0) {
    lines.push(meta.join(" | "));
  }

  // Links
  if (resume.profile.links.length > 0) {
    const linkStr = resume.profile.links
      .map((l) => `[${l.label}](${l.url})`)
      .join(" | ");
    lines.push(linkStr);
  }
  lines.push("");

  // Traits / Advantages
  if (resume.profile.traits && resume.profile.traits.length > 0) {
    lines.push(`## ${isZh ? "核心优势 / 专长" : "Key Highlights & Skills"}`);
    lines.push(resume.profile.traits.join(" · "));
    lines.push("");
  }

  // Target Roles
  if (resume.profile.targetRoles.length > 0) {
    lines.push(`## ${isZh ? "目标方向" : "Target Roles"}`);
    resume.profile.targetRoles.forEach((role) => lines.push(`- ${role}`));
    lines.push("");
  }

  // Work Experience
  const work = resume.experiences.filter((e) => e.type === "work");
  if (work.length > 0) {
    lines.push(`## ${isZh ? "工作经历" : "Work Experience"}`);
    work.forEach((exp) => {
      const endStr = exp.end ?? (isZh ? "至今" : "Present");
      lines.push(`### ${exp.org} · ${exp.title} (${exp.start} ~ ${endStr})`);
      if (exp.projectName) {
        lines.push(`**${isZh ? "项目" : "Project"}**: ${exp.projectName}`);
      }
      if (exp.techStack.length > 0) {
        lines.push(
          `**${isZh ? "技术栈" : "Tech Stack"}**: ${exp.techStack.join(", ")}`,
        );
      }
      lines.push("");
      exp.claims.forEach((claim) => {
        lines.push(`- ${claim.text}`);
      });
      lines.push("");
    });
  }

  // Projects / Open Source
  const projects = resume.experiences.filter(
    (e) => e.type === "opensource" || e.type === "other",
  );
  if (projects.length > 0) {
    lines.push(`## ${isZh ? "项目与作品" : "Projects & Works"}`);
    projects.forEach((exp) => {
      const name = exp.projectName ?? exp.org;
      const urlStr = exp.url ? ` ([Link](${exp.url}))` : "";
      const endStr = exp.end ?? (isZh ? "至今" : "Present");
      lines.push(`### ${name}${urlStr} (${exp.start} ~ ${endStr})`);
      if (exp.title) {
        lines.push(`**${isZh ? "角色" : "Role"}**: ${exp.title}`);
      }
      if (exp.techStack.length > 0) {
        lines.push(
          `**${isZh ? "技术栈" : "Tech Stack"}**: ${exp.techStack.join(", ")}`,
        );
      }
      lines.push("");
      exp.claims.forEach((claim) => {
        lines.push(`- ${claim.text}`);
      });
      lines.push("");
    });
  }

  // Education Experience
  const educationExps = resume.experiences.filter((e) => e.type === "education");
  if (educationExps.length > 0) {
    lines.push(`## ${isZh ? "教育背景" : "Education"}`);
    educationExps.forEach((exp) => {
      const endStr = exp.end ?? (isZh ? "毕业" : "Graduated");
      lines.push(`### ${exp.org} · ${exp.title} (${exp.start} ~ ${endStr})`);
      if (exp.claims.length > 0) {
        exp.claims.forEach((claim) => {
          lines.push(`- ${claim.text}`);
        });
      }
      lines.push("");
    });
  }

  return lines.join("\n").trim() + "\n";
}
