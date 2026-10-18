import { getHighlightColor, getResumeLayout, getResumeSectionOrder, resolveResumeTheme, splitStyledText, type ProjectedExperience, type ProjectedResume, type ResumeThemeFontFamily } from "@better-me/core";
import type { IParagraphOptions, IRunOptions, Paragraph, ParagraphChild } from "docx";

export type DocxExportResult = { blob: Blob; filename: string; diagnostics: string[] };

/** Keep browser downloads valid on Windows without discarding non-Latin names. */
export function resumeDocxFilename(resume: Pick<ProjectedResume, "locale" | "profile">): string {
  // eslint-disable-next-line no-control-regex -- A download name must exclude Windows control and reserved characters.
  const name = resume.profile.displayName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim().replace(/[. ]+$/g, "").slice(0, 80);
  return `resume-${resume.locale}-${name || "untitled"}.docx`;
}

function safeLink(value: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- URLs with hidden controls are not safe external targets.
  if (/[\x00-\x20\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function xmlText(value: string): string {
  // XML 1.0 cannot represent these controls. Do not let pasted text corrupt the archive.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, "");
}

/**
 * Export the selected projection, never the full FactBase. This is a portable,
 * editable single-column document, with semantic headings and no remote assets.
 * Loading docx here keeps its ZIP writer out of the initial editor bundle.
 */
export async function projectedResumeToDocx(resume: ProjectedResume): Promise<DocxExportResult> {
  const { Document, Paragraph, TextRun, ExternalHyperlink, Packer, HeadingLevel, LevelFormat, AlignmentType, UnderlineType, HighlightColor, ShadingType, BorderStyle } = await import("docx");
  const theme = resume.themeId ? resolveResumeTheme(resume) : undefined;
  const layout = theme?.layout ?? getResumeLayout(resume.layout);
  const zh = resume.locale === "zh";
  const diagnostics = ["DOCX 使用可编辑的 A4 单栏排版；保留可见正文、分节顺序与基本文字格式。网页模板的分栏和完整装饰请使用 PDF 保留。"];
  if (theme) diagnostics.push("DOCX 已映射简历主题的字体、配色与可用标题/技能装饰；纸张底色是否打印取决于 Word 的打印背景设置。");
  if (resume.profile.avatarUrl) diagnostics.push("DOCX 不包含照片，不会下载外部图片；需要带照片的版式请导出 PDF。");
  let unsafeLinks = 0;
  let skippedClaims = 0;
  const bounded = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
  const bodySize = bounded(layout.bodyFontSize, 8, 14);
  const nameSize = bounded(layout.nameFontSize, 20, 40);
  const headingSize = bounded(layout.headingFontSize, 10, 17);
  const wordFont = (family: ResumeThemeFontFamily) => family === "serif" ? { ascii: "Cambria", hAnsi: "Cambria", eastAsia: "SimSun", cs: "Cambria" }
    : family === "mono" ? { ascii: "Consolas", hAnsi: "Consolas", eastAsia: "Microsoft YaHei", cs: "Consolas" }
      : { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Microsoft YaHei", cs: "Calibri" };
  // Only validated resolver tokens and fixed font mappings reach OOXML attributes.
  const rgb = (value: string) => value.slice(1).toUpperCase();
  const colors = theme ? Object.fromEntries(Object.entries(theme.tokens.colors).map(([key, value]) => [key, rgb(value)])) : undefined;
  const fonts = wordFont(theme?.tokens.typography.bodyFamily ?? layout.fontFamily);
  const headingStyle: IRunOptions = theme ? { font: wordFont(theme.tokens.typography.headingFamily), color: colors!.accent } : {};
  const nameStyle: IRunOptions = theme ? { font: wordFont(theme.tokens.typography.nameFamily), color: colors!.accent } : {};
  const mutedStyle: IRunOptions = theme ? { color: colors!.muted } : {};
  const runDefaults = { font: fonts, color: colors?.text ?? "000000", size: Math.round(bodySize * 2), language: { value: zh ? "zh-CN" : "en-US", eastAsia: "zh-CN" } };
  const borderStyle = theme?.tokens.decoration.dividerStyle === "dashed" ? BorderStyle.DASHED : BorderStyle.SINGLE;
  let headingDecoration: IParagraphOptions = {};
  if (theme) {
    const sectionStyle = theme.tokens.decoration.sectionHeading;
    if (sectionStyle === "soft-band") headingDecoration = { shading: { fill: colors!.accentSoft, color: "auto", type: ShadingType.CLEAR } };
    if (theme.tokens.decoration.dividerStyle !== "none") {
      if (sectionStyle === "side-rule") headingDecoration = { border: { left: { style: borderStyle, size: 18, space: 6, color: colors!.accent } } };
      if (sectionStyle === "accent-rule" || sectionStyle === "underline") headingDecoration = { border: { bottom: { style: borderStyle, size: 4, space: 4, color: sectionStyle === "underline" ? colors!.rule : colors!.accent } } };
    }
  }
  const paragraphs: Paragraph[] = [];
  const textRuns = (text: string, key?: string, size = bodySize, defaults: IRunOptions = {}): InstanceType<typeof TextRun>[] => {
    const ranges = key ? resume.textStyles?.[`${key}:${resume.locale}`] : undefined;
    return splitStyledText(text, ranges).flatMap((segment) => {
      // Word's named highlight palette cannot represent an arbitrary RGB color.
      // Validate drafts at runtime and retain the legacy yellow for missing/invalid colors.
      const customHighlightColor = segment.style.highlight === true && typeof segment.style.highlightColor === "string" && /^#[\da-fA-F]{6}$/.test(segment.style.highlightColor)
        ? getHighlightColor(segment.style) : undefined;
      return segment.text.split(/\r\n|\r|\n/).map((line, lineIndex) => new TextRun({
        ...runDefaults, ...defaults, text: xmlText(line), break: lineIndex ? 1 : undefined,
        bold: segment.style.bold ?? defaults.bold, italics: segment.style.italic ?? defaults.italics,
        underline: segment.style.underline === undefined ? defaults.underline : segment.style.underline ? { type: UnderlineType.SINGLE } : { type: UnderlineType.NONE },
        highlight: segment.style.highlight === true && !customHighlightColor ? HighlightColor.YELLOW : undefined,
        shading: customHighlightColor ? { fill: customHighlightColor.slice(1), color: "auto", type: ShadingType.CLEAR } : defaults.shading,
        size: Math.round(size * bounded(segment.style.fontScale ?? 1, .8, 1.8) * 2),
      }));
    });
  };
  const paragraph = (children: ParagraphChild[], options: IParagraphOptions = {}) => {
    paragraphs.push(new Paragraph({ widowControl: true, ...options, children }));
  };
  const plain = (text: string, options: IParagraphOptions = {}) => paragraph(textRuns(text), options);
  const heading = (text: string) => paragraph(textRuns(text, undefined, headingSize, { bold: true, ...headingStyle }), {
    ...headingDecoration,
    heading: HeadingLevel.HEADING_1, keepNext: true, spacing: { before: Math.round(bounded(layout.sectionSpacing, 12, 36) * 15), after: 90 },
  });
  const link = (label: string, target: string): InstanceType<typeof ExternalHyperlink> | undefined => {
    const url = safeLink(target);
    if (!url) { unsafeLinks++; return undefined; }
    return new ExternalHyperlink({ link: url, children: textRuns(label || url, undefined, bodySize, { color: colors?.accent ?? "000000", underline: { type: UnderlineType.SINGLE } }) });
  };
  const bullet = (text: string, key?: string) => paragraph(textRuns(text, key), { numbering: { reference: "resume-bullets", level: 0 }, spacing: { after: 65 } });

  const keywordRuns = (values: string[]) => values.flatMap((value, index) => {
    const style: IRunOptions = theme?.tokens.decoration.keywordStyle === "soft-tag" ? { color: colors!.accent, shading: { fill: colors!.accentSoft, color: "auto", type: ShadingType.CLEAR } }
      : theme?.tokens.decoration.keywordStyle === "outlined" ? { border: { style: BorderStyle.SINGLE, color: colors!.rule, size: 4, space: 2 } } : {};
    return [...(index ? textRuns(" · ") : []), ...textRuns(value, undefined, bodySize, style)];
  });

  paragraph(textRuns(resume.profile.displayName, "profile:displayName", nameSize, { bold: true, ...nameStyle }), {
    heading: HeadingLevel.TITLE, keepNext: true, spacing: { after: 90 },
    ...(theme && theme.tokens.decoration.dividerStyle !== "none" ? { border: { bottom: { style: borderStyle, size: 4, space: 6, color: colors!.rule } } } : {}),
  });
  if (resume.profile.headline) paragraph(textRuns(resume.profile.headline, "profile:headline"), { keepNext: true, spacing: { after: 70 } });
  const contact = [resume.profile.location, resume.profile.education, resume.profile.phone, resume.profile.email].filter(Boolean).join(" | ");
  if (contact) paragraph(textRuns(contact, undefined, bodySize, mutedStyle), { spacing: { after: 70 } });
  const links = resume.profile.links.flatMap((item) => {
    const itemLink = link(item.label, item.url);
    return itemLink ? [itemLink] : [];
  });
  if (links.length) paragraph(links.flatMap((item, index) => index ? [new TextRun(" | "), item] : [item]), { spacing: { after: 70 } });

  function experience(entry: ProjectedExperience, section: "experience" | "projects" | "education") {
    const name = section === "projects" ? entry.projectName || entry.org : entry.org;
    const title = [name, entry.title].filter(Boolean).join(" · ");
    const dates = entry.start || entry.end ? [entry.start, entry.end ?? (zh ? "至今" : "Present")].filter(Boolean).join(" – ") : "";
    const titleRuns = theme ? [...textRuns(title, undefined, bodySize, { bold: true, ...headingStyle }), ...(dates ? textRuns(`${title ? "  |  " : ""}${dates}`, undefined, bodySize, mutedStyle) : [])]
      : textRuns([title, dates].filter(Boolean).join("  |  "), undefined, bodySize, { bold: true });
    paragraph(titleRuns, { heading: HeadingLevel.HEADING_2, keepNext: true, spacing: { before: 110, after: 70 } });
    if (section === "experience" && entry.projectName) plain(`${zh ? "项目" : "Project"}: ${entry.projectName}`, { keepNext: true });
    if (entry.url) { const entryLink = link(entry.url, entry.url); if (entryLink) paragraph([entryLink]); }
    if (entry.techStack.length) plain(`${zh ? "技术栈" : "Technologies"}: ${entry.techStack.join(" · ")}`);
    for (const claim of entry.claims) {
      // Defend again if an adapter builds ProjectedResume without projectResume.
      if (claim.kind === "interview" || claim.kind === "pitfall" || (claim.metric && !claim.metric.confirmed)) { skippedClaims++; continue; }
      bullet(claim.text, `claim:${claim.id}`);
    }
  }
  for (const section of getResumeSectionOrder(resume.sectionOrder)) {
    if (resume.sectionVisibility?.[section] === false) continue;
    if (section === "summary") {
      if (resume.profile.targetRoles.length) { heading(zh ? "目标方向" : "Target Roles"); for (const role of resume.profile.targetRoles) bullet(role); }
      if (resume.profile.traits.length) { heading(zh ? "核心优势与专长" : "Key Competencies"); plain(resume.profile.traits.join(" · ")); }
    } else if (section === "skills") {
      const skills = resume.skills ?? [...new Set(resume.experiences.flatMap((entry) => entry.techStack))];
      if (skills.length) { heading(zh ? "专业技能" : "Technical Skills"); if (theme) paragraph(keywordRuns(skills)); else plain(skills.join(" · ")); }
    } else if (section !== "custom") {
      const entries = resume.experiences.filter((entry) => section === "experience" ? entry.type === "work" : section === "education" ? entry.type === "education" : entry.type === "opensource" || entry.type === "other");
      if (!entries.length && !(section === "education" && resume.educationSummary)) continue;
      heading(section === "experience" ? zh ? "工作经历" : "Work Experience" : section === "education" ? zh ? "教育背景" : "Education" : zh ? "项目与作品经历" : "Projects and Works");
      if (section === "education" && !entries.length && resume.educationSummary) plain(resume.educationSummary);
      for (const entry of entries) experience(entry, section);
    }
  }
  if (unsafeLinks) diagnostics.push(`已忽略 ${unsafeLinks} 个不安全或无效链接。`);
  if (skippedClaims) diagnostics.push(`已排除 ${skippedClaims} 条未核实量化或面试私有要点。`);
  const margin = Math.round(bounded(layout.pageMargin, 12, 28) / 25.4 * 1440);
  const doc = new Document({
    creator: "", lastModifiedBy: "", title: "", description: "",
    ...(theme ? { background: { color: colors!.paper } } : {}),
    styles: { default: {
      document: { run: runDefaults, paragraph: { spacing: { line: Math.round(bounded(layout.lineHeight, 1.2, 2) * 240), after: 70 } } },
      title: { run: { ...runDefaults, ...nameStyle, size: nameSize * 2, bold: true }, paragraph: { keepNext: true, spacing: { after: 90 } } },
      heading1: { run: { ...runDefaults, ...headingStyle, size: headingSize * 2, bold: true }, paragraph: { keepNext: true, ...headingDecoration } },
      heading2: { run: { ...runDefaults, ...headingStyle, bold: true }, paragraph: { keepNext: true } },
      hyperlink: { run: { color: colors?.accent ?? "000000", underline: { type: UnderlineType.SINGLE } } },
    } },
    numbering: { config: [{ reference: "resume-bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 260, hanging: 180 } }, run: { ...runDefaults } } }] }] },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: margin, bottom: margin, left: margin, right: margin } } }, children: paragraphs }],
  });
  return { blob: await Packer.toBlob(doc), filename: resumeDocxFilename(resume), diagnostics };
}
