/** @jsxRuntime automatic */
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectedResume } from "@better-me/core";
import { RESUME_TEMPLATES, resolveResumeTemplate, ResumeTemplate, type ResumeTemplateId } from "../src/components/ResumeTemplate";
import { getResumeTemplate } from "../src/components/template-catalog";

function createResume(): ProjectedResume {
  return {
    locale: "zh",
    templateId: "zh-classic",
    profile: {
      displayName: "模板测试候选人",
      headline: "Engineering candidate",
      avatarUrl: "data:image/png;base64,iVBORw0KGgo=",
      location: "Test city",
      education: "Test degree",
      phone: "10000000000",
      email: "candidate@example.test",
      links: [{ label: "Portfolio", url: "https://example.test/portfolio" }],
      targetRoles: ["Backend engineer"],
      traits: ["System debugging", "Clear communication"],
    },
    experiences: (["work", "opensource", "other", "education"] as const).map((type, index) => ({
      id: `experience-${index}`,
      type,
      org: `Organization ${index}`,
      title: `Role ${index}`,
      start: "2020-01",
      end: index === 0 ? null : "2024-06",
      projectName: type === "work" || type === "other" ? `Project ${index}` : undefined,
      url: `https://example.test/experience/${index}`,
      techStack: [`Technology ${index}`],
      claims: [{ id: `claim-${index}`, kind: "action", text: `Verified contribution ${index}`, tags: [] }],
    })),
  };
}

function render(resume: ProjectedResume, templateId: ResumeTemplateId, showAvatar = true) {
  return renderToStaticMarkup(<ResumeTemplate resume={resume} templateId={templateId} showAvatar={showAvatar} />);
}

function claimTexts(markup: string) {
  return [...markup.matchAll(/<ul class="resume-claims">(.*?)<\/ul>/gs)]
    .flatMap((list) => [...list[1]!.matchAll(/<li(?:\s[^>]*)?>(.*?)<\/li>/gs)].map((item) => item[1]));
}

test("all registered templates retain profile, every experience type and the same factual bullets", () => {
  const resume = createResume();
  const expectedClaims = resume.experiences.flatMap((experience) => experience.claims.map((claim) => claim.text));

  for (const template of RESUME_TEMPLATES) {
    const markup = render(resume, template.id);
    for (const expected of [resume.profile.displayName, resume.profile.headline!, resume.profile.email!, "工作经历", "项目与作品经历", "教育背景", "Backend engineer", "System debugging", "Organization 0", "Organization 1", "Project 2", "Organization 3"]) {
      assert.ok(markup.includes(expected), `${template.id} should contain ${expected}`);
    }
    for (const experience of resume.experiences) {
      assert.ok(markup.includes(experience.title));
      assert.ok(markup.includes(experience.techStack[0]!));
      assert.ok(markup.includes(experience.url!));
    }
    assert.deepEqual(claimTexts(markup), expectedClaims, `${template.id} should not drop or reorder bullets`);
  }
});

test("ATS always omits photos; classic and modern follow the explicit photo preference", () => {
  const resume = createResume();
  for (const showAvatar of [true, false]) assert.doesNotMatch(render(resume, "en-ats", showAvatar), /<img\b/);

  for (const templateId of ["zh-classic", "clean-modern"] as const) {
    assert.match(render(resume, templateId, true), /<img[^>]+class="resume-avatar"/);
    assert.doesNotMatch(render(resume, templateId, false), /<img\b/);
    const noPhoto = { ...resume, profile: { ...resume.profile, avatarUrl: undefined } };
    assert.doesNotMatch(render(noPhoto, templateId, true), /<img\b/);
  }
});

test("all templates keep semantic follow anchors after reordering and omit hidden claims", () => {
  const resume = createResume();
  resume.sectionOrder = ["education", "projects", "experience", "skills", "summary"];
  resume.experiences[0]!.claims = [];
  for (const template of RESUME_TEMPLATES) {
    const markup = render(resume, template.id);
    for (const anchor of ["profile", "profile:displayName", "profile:headline", "profile:location", "profile:education", "profile:email", "profile:phone", "profile:links", "profile:targetRoles", "profile:traits", "section:summary", "section:experience", "section:projects", "section:education", "section:skills", "experience:experience-0", "experience:experience-3", "claim:claim-3"]) {
      assert.ok(markup.includes(`data-preview-anchor="${anchor}"`), `${template.id} is missing ${anchor}`);
    }
    assert.ok(markup.indexOf('data-preview-anchor="section:education"') < markup.indexOf('data-preview-anchor="section:experience"'));
    assert.ok(!markup.includes('data-preview-anchor="claim:claim-0"'));
    assert.equal(markup.includes('data-preview-anchor="profile:photo"'), template.id !== "en-ats");
  }
});

test("decorative catalogue pages retain content without becoming preview-follow targets or nested links", () => {
  const resume = createResume();
  const expectedClaims = resume.experiences.flatMap((experience) => experience.claims.map((claim) => claim.text));
  for (const template of RESUME_TEMPLATES) {
    const markup = renderToStaticMarkup(<ResumeTemplate resume={resume} templateId={template.id} decorative />);
    assert.doesNotMatch(markup, /data-preview-anchor=|<a\b|href=|tabindex=/, `${template.id} catalogue page must not intercept editor navigation`);
    assert.ok(markup.includes(resume.profile.displayName));
    assert.ok(markup.includes(resume.profile.email!));
    assert.ok(markup.includes(resume.profile.links[0]!.label));
    assert.deepEqual(claimTexts(markup), expectedClaims);
    assert.equal(markup.includes('class="resume-avatar"'), template.id !== "en-ats");
  }
});

test("English output uses English section labels and exposes link destinations in ATS", () => {
  const resume = { ...createResume(), locale: "en" as const };
  const markup = render(resume, "en-ats");
  assert.match(markup, /lang="en"/);
  for (const label of ["Work Experience", "Projects &amp; Works", "Education", "Target Roles", "Key Competencies", "Present"]) assert.ok(markup.includes(label));
  assert.ok(markup.includes("Portfolio: https://example.test/portfolio"));
  assert.doesNotMatch(markup, /工作经历|教育背景|至今/);
});

test("long resumes retain all experiences and the final character of every long bullet", () => {
  const resume = createResume();
  resume.experiences = Array.from({ length: 30 }, (_, experienceIndex) => ({
    ...resume.experiences[0]!,
    id: `long-experience-${experienceIndex}`,
    org: `Long organization ${experienceIndex}`,
    claims: Array.from({ length: 12 }, (_, claimIndex) => ({
      id: `long-claim-${experienceIndex}-${claimIndex}`,
      kind: "action" as const,
      text: `Start ${experienceIndex}/${claimIndex} ${"Detailed engineering evidence ".repeat(35)}End ${experienceIndex}/${claimIndex}`,
      tags: [],
    })),
  }));
  const expected = resume.experiences.flatMap((experience) => experience.claims.map((claim) => claim.text));
  for (const template of RESUME_TEMPLATES) {
    const markup = render(resume, template.id);
    assert.deepEqual(claimTexts(markup), expected);
    assert.ok(markup.includes("Long organization 29"));
    assert.ok(markup.includes("End 29/11"));
  }
});

test("resume text stays escaped instead of becoming executable HTML", () => {
  const resume = createResume();
  resume.experiences[0]!.claims[0]!.text = '<script>alert("example")</script>';
  for (const template of RESUME_TEMPLATES) {
    const markup = render(resume, template.id);
    assert.doesNotMatch(markup, /<script>/);
    assert.ok(markup.includes("&lt;script&gt;"));
  }
});

test("unknown saved template identifiers fall back to a usable classic template", () => {
  assert.equal(resolveResumeTemplate("old-theme"), "zh-classic");
  for (const template of RESUME_TEMPLATES) assert.equal(resolveResumeTemplate(template.id), template.id);
});

test("every layout honors movable sections, visibility and custom typography", () => {
  const resume = { ...createResume(), sectionOrder: ["education", "experience", "projects", "skills", "summary"] as const, sectionVisibility: { projects: false, skills: false }, layout: { accentColor: "#69424c", bodyFontSize: 12, lineHeight: 1.8, pageMargin: 22 } };
  for (const template of RESUME_TEMPLATES) {
    const markup = render({ ...resume, sectionOrder: [...resume.sectionOrder] }, template.id);
    assert.ok(markup.indexOf('data-section="education"') < markup.indexOf('data-section="experience"'));
    assert.ok(markup.indexOf('data-section="experience"') < markup.indexOf('data-section="summary"'));
    assert.doesNotMatch(markup, /data-section="projects"|data-section="skills"|Organization 1|Project 2/);
    assert.match(markup, /--resume-accent:#69424c/);
    assert.match(markup, /font-size:12pt/);
    assert.match(markup, /padding:22mm/);
  }
});

test("rich formatting preserves text nodes, overlap overrides and selection font size", () => {
  const resume = createResume();
  resume.experiences[0]!.claims[0]!.text = "<script>safe</script>";
  resume.textStyles = { "claim:claim-0:zh": [{ start: 0, end: 20, bold: true, fontScale: 1.3 }, { start: 8, end: 12, bold: false, highlight: true, italic: true, underline: true }] };
  const markup = render(resume, "editorial");
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /font-size:1.3em/);
  assert.match(markup, /font-weight:400;font-style:italic;text-decoration:underline;background-color:#fae6a1/);
});

test("education can appear only in its section with its header field absent", () => {
  const resume = createResume();
  resume.profile.education = undefined;
  resume.experiences = resume.experiences.filter((experience) => experience.type !== "education");
  resume.educationSummary = "独立学历事实";
  for (const template of RESUME_TEMPLATES) {
    const markup = render(resume, template.id);
    const header = markup.slice(markup.indexOf("<header"), markup.indexOf("</header>"));
    assert.doesNotMatch(header, /独立学历事实/);
    assert.match(markup, /data-section="education"[^>]*><h2>教育背景<\/h2><div class="resume-experience-list"><p[^>]*>独立学历事实<\/p>/);
  }
});

// Semantic variants are rendered in reading order, rather than visually moved
// with CSS; thumbnail template IDs must work independently of saved view IDs.
test("upstream heading variants preserve role and date semantics with an independent effective template", () => {
  const resume = createResume();
  const engineering = render(resume, "rendercv-engineeringresumes");
  assert.ok(engineering.indexOf('resume-role resume-role-name') < engineering.indexOf('resume-organization'));
  assert.ok(engineering.includes('Portfolio: https://example.test/portfolio'));
  assert.match(engineering, /<img\b/);
  const modern = render(resume, "rendercv-moderncv");
  assert.ok(modern.indexOf('class="resume-dates"') < modern.indexOf('<h3>'));
  assert.equal(resume.templateId, "zh-classic");
});

test("required attribution survives all chapter visibility and stays outside factual text", () => {
  const resume = createResume();
  resume.sectionVisibility = { summary: false, experience: false, education: false, skills: false, projects: false };
  const original = structuredClone(resume);
  for (const template of RESUME_TEMPLATES) {
    const attribution = getResumeTemplate(template.id).attribution;
    if (!attribution) continue;
    const markup = render(resume, template.id);
    assert.ok(markup.includes('class="resume-template-attribution"'), template.id);
    assert.ok(markup.includes(attribution.text) && markup.includes(attribution.license), template.id);
    assert.ok(markup.includes(attribution.url) && markup.includes(attribution.licenseUrl), template.id);
    assert.doesNotMatch(markup, /data-section=|class="resume-claims"/);
  }
  assert.deepEqual(resume, original);
});
