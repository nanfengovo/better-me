/** @jsxRuntime automatic */
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectedResume } from "@better-me/core";
import { RESUME_TEMPLATES, resolveResumeTemplate, ResumeTemplate, type ResumeTemplateId } from "../src/components/ResumeTemplate";

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
    .flatMap((list) => [...list[1]!.matchAll(/<li>(.*?)<\/li>/gs)].map((item) => item[1]));
}

test("all three templates retain profile, every experience type and the same factual bullets", () => {
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
