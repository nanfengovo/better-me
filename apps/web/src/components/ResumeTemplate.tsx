/** @jsxRuntime automatic */
import type { ProjectedResume } from "@better-me/core";

export const RESUME_TEMPLATES = [
  { id: "zh-classic", name: "经典正式 · Classic", description: "居中抬头与清晰分节，适合正式投递。" },
  { id: "en-ats", name: "简洁单栏 · ATS", description: "无照片、无装饰侧栏，按自然顺序阅读；实际解析效果仍需核验。" },
  { id: "clean-modern", name: "现代信息 · Modern", description: "分区信息抬头与重点标签，突出项目和技术经历。" },
] as const;

export type ResumeTemplateId = (typeof RESUME_TEMPLATES)[number]["id"];

export function resolveResumeTemplate(id: string): ResumeTemplateId {
  return RESUME_TEMPLATES.some((template) => template.id === id)
    ? (id as ResumeTemplateId)
    : "zh-classic";
}

type Props = { resume: ProjectedResume; templateId: ResumeTemplateId; showAvatar: boolean };
type Experience = ProjectedResume["experiences"][number];

function ContactDetails({ resume, plain }: { resume: ProjectedResume; plain: boolean }) {
  const details = [resume.profile.location, resume.profile.education, resume.profile.phone, resume.profile.email].filter(Boolean);
  return (
    <div className="resume-contact">
      {details.length > 0 && <p className="resume-contact-details">{details.join(" | ")}</p>}
      {resume.profile.links.length > 0 && (
        <ul className="resume-links" aria-label={resume.locale === "en" ? "Links" : "相关链接"}>
          {resume.profile.links.map((link, index) => (
            <li key={`${link.url}-${index}`}>
              <a href={link.url} target="_blank" rel="noreferrer">{link.label}{plain && link.label !== link.url ? `: ${link.url}` : ""}</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProfileSummary({ resume }: { resume: ProjectedResume }) {
  const isEnglish = resume.locale === "en";
  if (resume.profile.targetRoles.length === 0 && resume.profile.traits.length === 0) return null;
  return (
    <div className="resume-summary">
      {resume.profile.targetRoles.length > 0 && (
        <section className="resume-section resume-summary-section">
          <h2>{isEnglish ? "Target Roles" : "目标方向"}</h2>
          <ul className="resume-keywords">{resume.profile.targetRoles.map((role, index) => <li key={`${role}-${index}`}>{role}</li>)}</ul>
        </section>
      )}
      {resume.profile.traits.length > 0 && (
        <section className="resume-section resume-summary-section">
          <h2>{isEnglish ? "Key Competencies" : "核心优势与专长"}</h2>
          <ul className="resume-keywords">{resume.profile.traits.map((trait, index) => <li key={`${trait}-${index}`}>{trait}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

function ExperienceSection({ title, experiences, kind, locale, plain }: {
  title: string; experiences: Experience[]; kind: "work" | "projects" | "education";
  locale: ProjectedResume["locale"]; plain: boolean;
}) {
  if (experiences.length === 0) return null;
  const isEnglish = locale === "en";
  return (
    <section className="resume-section">
      <h2>{title}</h2>
      <div className="resume-experience-list">
        {experiences.map((experience) => {
          const name = kind === "projects" ? experience.projectName || experience.org : experience.org;
          const end = experience.end ?? (isEnglish ? "Present" : "至今");
          return (
            <div className="resume-experience" key={experience.id}>
              <div className="resume-experience-heading">
                <h3>{name}{experience.title && <span className="resume-role"> · {experience.title}</span>}</h3>
                {(experience.start || experience.end) && <p className="resume-dates">{[experience.start, end].filter(Boolean).join(" – ")}</p>}
              </div>
              {kind === "work" && experience.projectName && <p className="resume-project-name">{isEnglish ? "Project: " : "项目："}{experience.projectName}</p>}
              {experience.url && <p className="resume-experience-url"><a href={experience.url} target="_blank" rel="noreferrer">{plain ? experience.url : `${isEnglish ? "Link" : "相关链接"}: ${experience.url}`}</a></p>}
              {experience.techStack.length > 0 && <p className="resume-tech"><strong>{isEnglish ? "Technologies: " : "技术栈："}</strong>{experience.techStack.join(" · ")}</p>}
              {experience.claims.length > 0 && <ul className="resume-claims">{experience.claims.map((claim) => <li key={claim.id}>{claim.text}</li>)}</ul>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ResumeTemplate({ resume, templateId, showAvatar }: Props) {
  const isEnglish = resume.locale === "en";
  const plain = templateId === "en-ats";
  const avatarVisible = !plain && showAvatar && Boolean(resume.profile.avatarUrl);
  return (
    <article className={`a4-sheet resume-document resume-template-${templateId}`} lang={isEnglish ? "en" : "zh-CN"} data-template={templateId}>
      <header className={`resume-header${avatarVisible ? " has-avatar" : ""}`}>
        <div className="resume-identity"><h1>{resume.profile.displayName}</h1>{resume.profile.headline && <p className="resume-headline">{resume.profile.headline}</p>}</div>
        <ContactDetails resume={resume} plain={plain} />
        {avatarVisible && <img className="resume-avatar" src={resume.profile.avatarUrl} alt={isEnglish ? `${resume.profile.displayName} portrait` : `${resume.profile.displayName}的照片`} />}
      </header>
      <ProfileSummary resume={resume} />
      <div className="resume-body">
        <ExperienceSection title={isEnglish ? "Work Experience" : "工作经历"} experiences={resume.experiences.filter((experience) => experience.type === "work")} kind="work" locale={resume.locale} plain={plain} />
        <ExperienceSection title={isEnglish ? "Projects & Works" : "项目与作品经历"} experiences={resume.experiences.filter((experience) => experience.type === "opensource" || experience.type === "other")} kind="projects" locale={resume.locale} plain={plain} />
        <ExperienceSection title={isEnglish ? "Education" : "教育背景"} experiences={resume.experiences.filter((experience) => experience.type === "education")} kind="education" locale={resume.locale} plain={plain} />
      </div>
    </article>
  );
}
