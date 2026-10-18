/** @jsxRuntime automatic */
import type { CSSProperties } from "react";
import { getResumeLayout, getResumeThemeCssVariables, resolveResumeTheme, getResumeSectionOrder, type ProjectedResume, type ResumeSectionId } from "@better-me/core";
import { RichResumeText } from "./RichResumeText";

import { getResumeTemplate, type ResumeTemplateId } from "./template-catalog";
import { getResumeThemeCompatibility } from "./resume-theme-compatibility";
export { RESUME_TEMPLATES, resolveResumeTemplate, type ResumeTemplateId } from "./template-catalog";

type Props = { resume: ProjectedResume; templateId: ResumeTemplateId; showAvatar?: boolean; decorative?: boolean };
type Experience = ProjectedResume["experiences"][number];

function safeHref(url: string) { return /^(https?:|mailto:|tel:)/i.test(url) ? url : undefined; }
function previewAnchor(value: string, decorative: boolean) { return decorative ? {} : { "data-preview-anchor": value }; }

function ContactDetails({ resume, plain, decorative, separator }: { resume: ProjectedResume; plain: boolean; decorative: boolean; separator: string }) {
  const details = (["location", "education", "phone", "email"] as const)
    .map((field) => ({ field, text: resume.profile[field] })).filter((detail) => Boolean(detail.text));
  return <div className="resume-contact">
    {details.length > 0 && <p className="resume-contact-details">{details.map((detail, index) => <span key={detail.field}>{index > 0 && separator}<span {...previewAnchor(`profile:${detail.field}`, decorative)}>{detail.text}</span></span>)}</p>}
    {resume.profile.links.length > 0 && <ul className="resume-links" {...previewAnchor("profile:links", decorative)} aria-label={resume.locale === "en" ? "Links" : "相关链接"}>
      {resume.profile.links.map((link, index) => <li key={`${link.url}-${index}`}>{decorative ? <span>{link.label}{plain && link.label !== link.url ? `: ${link.url}` : ""}</span> : <a href={safeHref(link.url)} target="_blank" rel="noreferrer">{link.label}{plain && link.label !== link.url ? `: ${link.url}` : ""}</a>}</li>)}
    </ul>}
  </div>;
}

function ProfileSummary({ resume, decorative }: { resume: ProjectedResume; decorative: boolean }) {
  const isEnglish = resume.locale === "en";
  if (!resume.profile.targetRoles.length && !resume.profile.traits.length) return null;
  return <div className="resume-summary" data-section="summary" {...previewAnchor("section:summary", decorative)}>
    {resume.profile.targetRoles.length > 0 && <section className="resume-section resume-summary-section" {...previewAnchor("profile:targetRoles", decorative)}><h2>{isEnglish ? "Target Roles" : "目标方向"}</h2><ul className="resume-keywords">{resume.profile.targetRoles.map((role, index) => <li key={index}>{role}</li>)}</ul></section>}
    {resume.profile.traits.length > 0 && <section className="resume-section resume-summary-section" {...previewAnchor("profile:traits", decorative)}><h2>{isEnglish ? "Key Competencies" : "核心优势与专长"}</h2><ul className="resume-keywords">{resume.profile.traits.map((trait, index) => <li key={index}>{trait}</li>)}</ul></section>}
  </div>;
}

function ExperienceSection({ title, experiences, kind, resume, plain, decorative, roleFirst, dateFirst }: {
  title: string; experiences: Experience[]; kind: "experience" | "projects" | "education"; resume: ProjectedResume; plain: boolean; decorative: boolean; roleFirst: boolean; dateFirst: boolean;
}) {
  if (!experiences.length && !(kind === "education" && resume.educationSummary)) return null;
  const isEnglish = resume.locale === "en";
  return <section className="resume-section" data-section={kind} {...previewAnchor(`section:${kind}`, decorative)}>
    <h2>{title}</h2><div className="resume-experience-list">
      {kind === "education" && !experiences.length && <p {...previewAnchor("profile:education", decorative)}>{resume.educationSummary}</p>}
      {experiences.map((experience) => {
        const name = kind === "projects" ? experience.projectName || experience.org : experience.org;
        const end = experience.end ?? (isEnglish ? "Present" : "至今");
        const dates = (experience.start || experience.end) && <p className="resume-dates">{[experience.start, end].filter(Boolean).join(" – ")}</p>;
        return <div className="resume-experience" key={experience.id} {...previewAnchor(`experience:${experience.id}`, decorative)}>
          <div className="resume-experience-heading">{dateFirst && dates}<h3>{roleFirst && experience.title ? <><span className="resume-role resume-role-name">{experience.title}</span><span className="resume-role-separator">, </span><span className="resume-organization">{name}</span></> : <><span className="resume-organization">{name}</span>{experience.title && <span className="resume-role"><span className="resume-role-separator"> · </span><span className="resume-role-name">{experience.title}</span></span>}</>}</h3>{!dateFirst && dates}</div>
          {kind === "experience" && experience.projectName && <p className="resume-project-name">{isEnglish ? "Project: " : "项目："}{experience.projectName}</p>}
          {experience.url && <p className="resume-experience-url">{decorative ? <span>{plain ? experience.url : `${isEnglish ? "Link" : "相关链接"}: ${experience.url}`}</span> : <a href={safeHref(experience.url)} target="_blank" rel="noreferrer">{plain ? experience.url : `${isEnglish ? "Link" : "相关链接"}: ${experience.url}`}</a>}</p>}
          {experience.techStack.length > 0 && <p className="resume-tech"><strong>{isEnglish ? "Technologies: " : "技术栈："}</strong>{experience.techStack.join(" · ")}</p>}
          {experience.claims.length > 0 && <ul className="resume-claims">{experience.claims.map((claim) => <li key={claim.id} {...previewAnchor(`claim:${claim.id}`, decorative)}><RichResumeText text={claim.text} ranges={resume.textStyles?.[`claim:${claim.id}:${resume.locale}`]} /></li>)}</ul>}
        </div>;
      })}
    </div>
  </section>;
}

function ResumeSection({ section, resume, plain, decorative, roleFirst, dateFirst }: { section: ResumeSectionId; resume: ProjectedResume; plain: boolean; decorative: boolean; roleFirst: boolean; dateFirst: boolean }) {
  if (resume.sectionVisibility?.[section] === false) return null;
  const en = resume.locale === "en";
  if (section === "summary") return <ProfileSummary resume={resume} decorative={decorative} />;
  if (section === "skills") {
    const skills = resume.skills ?? [...new Set(resume.experiences.flatMap((experience) => experience.techStack))];
    return skills.length ? <section className="resume-section" data-section="skills" {...previewAnchor("section:skills", decorative)}><h2>{en ? "Technical Skills" : "专业技能"}</h2><ul className="resume-keywords resume-skill-list">{skills.map((skill) => <li key={skill}>{skill}</li>)}</ul></section> : null;
  }
  if (section === "custom") return null;
  const experiences = resume.experiences.filter((experience) => section === "experience" ? experience.type === "work" : section === "education" ? experience.type === "education" : experience.type === "opensource" || experience.type === "other");
  const title = section === "experience" ? en ? "Work Experience" : "工作经历" : section === "education" ? en ? "Education" : "教育背景" : en ? "Projects & Works" : "项目与作品经历";
  return <ExperienceSection title={title} experiences={experiences} kind={section} resume={resume} plain={plain} decorative={decorative} roleFirst={roleFirst && section === "experience"} dateFirst={dateFirst} />;
}

export function ResumeTemplate({ resume, templateId, showAvatar = true, decorative = false }: Props) {
  const isEnglish = resume.locale === "en";
  const plain = ["en-ats", "rendercv-engineeringresumes", "rendercv-sb2nov", "rendercv-ink"].includes(templateId);
  const attribution = getResumeTemplate(templateId).attribution;
  const roleFirst = ["rendercv-engineeringresumes", "rendercv-engineeringclassic", "rendercv-moderncv", "rendercv-sb2nov", "jsonresume-rickosborne"].includes(templateId);
  const separator = ["rendercv-sb2nov", "rendercv-harvard", "rendercv-opal"].includes(templateId) ? " • " : templateId === "rendercv-ember" ? " · " : ["rendercv-classic", "rendercv-moderncv", "rendercv-engineeringclassic"].includes(templateId) ? "   " : " | ";
  const avatarVisible = templateId !== "en-ats" && showAvatar && Boolean(resume.profile.avatarUrl);
  const theme = resume.themeId ? resolveResumeTheme(resume) : undefined;
  const layout = theme?.layout ?? getResumeLayout(resume.layout);
  const families = { sans: '"Inter", "Microsoft YaHei", "PingFang SC", Arial, sans-serif', serif: '"Noto Serif SC", "Songti SC", SimSun, Georgia, serif', mono: '"Cascadia Code", "Microsoft YaHei", Consolas, monospace' };
  const style = {
    "--resume-accent": layout.accentColor, "--resume-body-size": `${layout.bodyFontSize}pt`,
    "--resume-name-size": `${layout.nameFontSize}pt`, "--resume-heading-size": `${layout.headingFontSize}pt`,
    "--resume-line-height": layout.lineHeight, "--resume-section-spacing": `${layout.sectionSpacing}px`,
    "--resume-margin": `${layout.pageMargin}mm`, "--resume-font-family": families[layout.fontFamily],
    "--resume-serif-family": isEnglish ? 'Georgia, "Times New Roman", serif' : '"Songti SC", SimSun, "Noto Serif SC", serif',
    fontFamily: theme ? "var(--resume-body-font)" : families[layout.fontFamily], fontSize: `${layout.bodyFontSize}pt`, lineHeight: layout.lineHeight,
    padding: `${layout.pageMargin}mm`,
    ...(theme ? getResumeThemeCssVariables(resume, resume.locale) : {}),
  } as CSSProperties;
  return <article className={`a4-sheet resume-sheet resume-document resume-template-${templateId}`} style={style} lang={isEnglish ? "en" : "zh-CN"} data-template={templateId}
    data-resume-theme={theme?.id} data-theme-decoration={theme ? getResumeThemeCompatibility(templateId).decoration : undefined}
    data-section-heading={theme?.tokens.decoration.sectionHeading} data-keyword-style={theme?.tokens.decoration.keywordStyle} data-divider-style={theme?.tokens.decoration.dividerStyle}>
    <header className={`resume-header${avatarVisible ? " has-avatar" : ""}`} {...previewAnchor("profile", decorative)}>
      <div className="resume-identity"><h1 {...previewAnchor("profile:displayName", decorative)}><RichResumeText text={resume.profile.displayName} ranges={resume.textStyles?.[`profile:displayName:${resume.locale}`]} /></h1>{resume.profile.headline && <p className="resume-headline" {...previewAnchor("profile:headline", decorative)}><RichResumeText text={resume.profile.headline} ranges={resume.textStyles?.[`profile:headline:${resume.locale}`]} /></p>}</div>
      <ContactDetails resume={resume} plain={plain} decorative={decorative} separator={separator} />
      {avatarVisible && <img className="resume-avatar" {...previewAnchor("profile:photo", decorative)} src={resume.profile.avatarUrl} alt={decorative ? "" : isEnglish ? `${resume.profile.displayName} portrait` : `${resume.profile.displayName}的照片`} />}
    </header>
    <div className="resume-body">{getResumeSectionOrder(resume.sectionOrder).map((section) => <ResumeSection key={section} section={section} resume={resume} plain={plain} decorative={decorative} roleFirst={roleFirst} dateFirst={templateId === "rendercv-moderncv"} />)}</div>
    {attribution && <footer className="resume-template-attribution">{decorative ? <>{attribution.text} · {attribution.license}</> : <><a href={safeHref(attribution.url)} target="_blank" rel="noreferrer">{attribution.text}</a>{" · "}<a href={safeHref(attribution.licenseUrl)} target="_blank" rel="noreferrer">{attribution.license}</a></>}</footer>}
  </article>;
}
