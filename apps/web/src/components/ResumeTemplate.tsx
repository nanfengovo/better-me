/** @jsxRuntime automatic */
import type { CSSProperties } from "react";
import { getResumeLayout, getResumeSectionOrder, type ProjectedResume, type ResumeSectionId } from "@better-me/core";
import { RichResumeText } from "./RichResumeText";

/** Original BetterMe layouts, with no copied commercial assets or bundled fonts. */
export const RESUME_TEMPLATES = [
  { id: "zh-classic", name: "经典正式", label: "CLASSIC", description: "居中抬头、衬线标题与细线分节，正式而克制。", tag: "正式投递" },
  { id: "en-ats", name: "极简单栏", label: "ATS", description: "自然阅读顺序、纯文本信息、固定无照片；实际 ATS 解析仍需验证。", tag: "海外 / ATS" },
  { id: "clean-modern", name: "现代专业", label: "MODERN", description: "信息块抬头与时间线经历，用清晰层次突出技术成果。", tag: "技术岗位" },
  { id: "editorial", name: "编辑部", label: "EDITORIAL", description: "大字抬头、侧标分节与宽松留白，像一份精心编辑的作品。", tag: "高级质感" },
  { id: "sidebar", name: "左岸", label: "SIDEBAR", description: "个人资料置于独立窄栏，正文聚焦经历；适合信息丰富的中文简历。", tag: "双栏布局" },
  { id: "compact", name: "精练履历", label: "COMPACT", description: "窄行距、横向信息带与紧凑分节，让重点更集中。", tag: "高密度" },
] as const;

export type ResumeTemplateId = (typeof RESUME_TEMPLATES)[number]["id"];
export function resolveResumeTemplate(id: string): ResumeTemplateId {
  return RESUME_TEMPLATES.some((template) => template.id === id) ? id as ResumeTemplateId : "zh-classic";
}

type Props = { resume: ProjectedResume; templateId: ResumeTemplateId; showAvatar?: boolean };
type Experience = ProjectedResume["experiences"][number];

function safeHref(url: string) { return /^(https?:|mailto:|tel:)/i.test(url) ? url : undefined; }

function ContactDetails({ resume, plain }: { resume: ProjectedResume; plain: boolean }) {
  const details = (["location", "education", "phone", "email"] as const)
    .map((field) => ({ field, text: resume.profile[field] })).filter((detail) => Boolean(detail.text));
  return <div className="resume-contact">
    {details.length > 0 && <p className="resume-contact-details">{details.map((detail, index) => <span key={detail.field}>{index > 0 && " | "}<span data-preview-anchor={`profile:${detail.field}`}>{detail.text}</span></span>)}</p>}
    {resume.profile.links.length > 0 && <ul className="resume-links" data-preview-anchor="profile:links" aria-label={resume.locale === "en" ? "Links" : "相关链接"}>
      {resume.profile.links.map((link, index) => <li key={`${link.url}-${index}`}><a href={safeHref(link.url)} target="_blank" rel="noreferrer">{link.label}{plain && link.label !== link.url ? `: ${link.url}` : ""}</a></li>)}
    </ul>}
  </div>;
}

function ProfileSummary({ resume }: { resume: ProjectedResume }) {
  const isEnglish = resume.locale === "en";
  if (!resume.profile.targetRoles.length && !resume.profile.traits.length) return null;
  return <div className="resume-summary" data-section="summary" data-preview-anchor="section:summary">
    {resume.profile.targetRoles.length > 0 && <section className="resume-section resume-summary-section" data-preview-anchor="profile:targetRoles"><h2>{isEnglish ? "Target Roles" : "目标方向"}</h2><ul className="resume-keywords">{resume.profile.targetRoles.map((role, index) => <li key={index}>{role}</li>)}</ul></section>}
    {resume.profile.traits.length > 0 && <section className="resume-section resume-summary-section" data-preview-anchor="profile:traits"><h2>{isEnglish ? "Key Competencies" : "核心优势与专长"}</h2><ul className="resume-keywords">{resume.profile.traits.map((trait, index) => <li key={index}>{trait}</li>)}</ul></section>}
  </div>;
}

function ExperienceSection({ title, experiences, kind, resume, plain }: {
  title: string; experiences: Experience[]; kind: "experience" | "projects" | "education"; resume: ProjectedResume; plain: boolean;
}) {
  if (!experiences.length && !(kind === "education" && resume.educationSummary)) return null;
  const isEnglish = resume.locale === "en";
  return <section className="resume-section" data-section={kind} data-preview-anchor={`section:${kind}`}>
    <h2>{title}</h2><div className="resume-experience-list">
      {kind === "education" && !experiences.length && <p data-preview-anchor="profile:education">{resume.educationSummary}</p>}
      {experiences.map((experience) => {
        const name = kind === "projects" ? experience.projectName || experience.org : experience.org;
        const end = experience.end ?? (isEnglish ? "Present" : "至今");
        return <div className="resume-experience" key={experience.id} data-preview-anchor={`experience:${experience.id}`}>
          <div className="resume-experience-heading"><h3>{name}{experience.title && <span className="resume-role"> · {experience.title}</span>}</h3>{(experience.start || experience.end) && <p className="resume-dates">{[experience.start, end].filter(Boolean).join(" – ")}</p>}</div>
          {kind === "experience" && experience.projectName && <p className="resume-project-name">{isEnglish ? "Project: " : "项目："}{experience.projectName}</p>}
          {experience.url && <p className="resume-experience-url"><a href={safeHref(experience.url)} target="_blank" rel="noreferrer">{plain ? experience.url : `${isEnglish ? "Link" : "相关链接"}: ${experience.url}`}</a></p>}
          {experience.techStack.length > 0 && <p className="resume-tech"><strong>{isEnglish ? "Technologies: " : "技术栈："}</strong>{experience.techStack.join(" · ")}</p>}
          {experience.claims.length > 0 && <ul className="resume-claims">{experience.claims.map((claim) => <li key={claim.id} data-preview-anchor={`claim:${claim.id}`}><RichResumeText text={claim.text} ranges={resume.textStyles?.[`claim:${claim.id}:${resume.locale}`]} /></li>)}</ul>}
        </div>;
      })}
    </div>
  </section>;
}

function ResumeSection({ section, resume, plain }: { section: ResumeSectionId; resume: ProjectedResume; plain: boolean }) {
  if (resume.sectionVisibility?.[section] === false) return null;
  const en = resume.locale === "en";
  if (section === "summary") return <ProfileSummary resume={resume} />;
  if (section === "skills") {
    const skills = resume.skills ?? [...new Set(resume.experiences.flatMap((experience) => experience.techStack))];
    return skills.length ? <section className="resume-section" data-section="skills" data-preview-anchor="section:skills"><h2>{en ? "Technical Skills" : "专业技能"}</h2><ul className="resume-keywords resume-skill-list">{skills.map((skill) => <li key={skill}>{skill}</li>)}</ul></section> : null;
  }
  if (section === "custom") return null;
  const experiences = resume.experiences.filter((experience) => section === "experience" ? experience.type === "work" : section === "education" ? experience.type === "education" : experience.type === "opensource" || experience.type === "other");
  const title = section === "experience" ? en ? "Work Experience" : "工作经历" : section === "education" ? en ? "Education" : "教育背景" : en ? "Projects & Works" : "项目与作品经历";
  return <ExperienceSection title={title} experiences={experiences} kind={section} resume={resume} plain={plain} />;
}

export function ResumeTemplate({ resume, templateId, showAvatar = true }: Props) {
  const isEnglish = resume.locale === "en";
  const plain = templateId === "en-ats";
  const avatarVisible = !plain && showAvatar && Boolean(resume.profile.avatarUrl);
  const layout = getResumeLayout(resume.layout);
  const families = { sans: '"Inter", "Microsoft YaHei", "PingFang SC", Arial, sans-serif', serif: '"Noto Serif SC", "Songti SC", SimSun, Georgia, serif', mono: '"Cascadia Code", "Microsoft YaHei", Consolas, monospace' };
  const style = {
    "--resume-accent": layout.accentColor, "--resume-body-size": `${layout.bodyFontSize}pt`,
    "--resume-name-size": `${layout.nameFontSize}pt`, "--resume-heading-size": `${layout.headingFontSize}pt`,
    "--resume-line-height": layout.lineHeight, "--resume-section-spacing": `${layout.sectionSpacing}px`,
    "--resume-margin": `${layout.pageMargin}mm`, "--resume-font-family": families[layout.fontFamily],
    fontFamily: families[layout.fontFamily], fontSize: `${layout.bodyFontSize}pt`, lineHeight: layout.lineHeight,
    padding: `${layout.pageMargin}mm`,
  } as CSSProperties;
  return <article className={`a4-sheet resume-sheet resume-document resume-template-${templateId}`} style={style} lang={isEnglish ? "en" : "zh-CN"} data-template={templateId}>
    <header className={`resume-header${avatarVisible ? " has-avatar" : ""}`} data-preview-anchor="profile">
      <div className="resume-identity"><h1 data-preview-anchor="profile:displayName"><RichResumeText text={resume.profile.displayName} ranges={resume.textStyles?.[`profile:displayName:${resume.locale}`]} /></h1>{resume.profile.headline && <p className="resume-headline" data-preview-anchor="profile:headline"><RichResumeText text={resume.profile.headline} ranges={resume.textStyles?.[`profile:headline:${resume.locale}`]} /></p>}</div>
      <ContactDetails resume={resume} plain={plain} />
      {avatarVisible && <img className="resume-avatar" data-preview-anchor="profile:photo" src={resume.profile.avatarUrl} alt={isEnglish ? `${resume.profile.displayName} portrait` : `${resume.profile.displayName}的照片`} />}
    </header>
    <div className="resume-body">{getResumeSectionOrder(resume.sectionOrder).map((section) => <ResumeSection key={section} section={section} resume={resume} plain={plain} />)}</div>
  </article>;
}
