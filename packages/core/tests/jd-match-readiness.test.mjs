import test from "node:test";
import assert from "node:assert/strict";
import { createDemoFactBase, createDefaultResumeView, getJdMatchReadiness, projectResume } from "../dist/index.js";

function realBase() {
  return {
    schemaVersion: 1,
    updatedAt: "2026-10-18T00:00:00.000Z",
    profile: { displayName: { zh: "姓名待确认" }, links: [], traits: [], targetRoles: [], constraints: [] },
    experiences: [{
      id: "exp-sample-1", type: "work", org: { zh: "实际设备公司" }, title: { zh: "软件工程师" },
      start: "2024-01", end: null, techStack: ["C#"],
      claims: [{ id: "claim-sample-1", kind: "action", text: { zh: "开发设备通讯与故障诊断模块" }, tags: [] }],
    }],
  };
}

function project(base, viewChanges = {}) {
  return projectResume(base, { ...createDefaultResumeView(base), ...viewChanges });
}

test("bundled demo is blocked in Chinese and English without depending on IDs", () => {
  for (const locale of ["zh", "en"]) {
    const base = createDemoFactBase();
    base.profile.displayName = { zh: "本人名字", en: "A Real Name" };
    for (const [index, experience] of base.experiences.entries()) {
      experience.id = `new-${index}`;
      for (const [claimIndex, claim] of experience.claims.entries()) claim.id = `new-${index}-${claimIndex}`;
    }
    const readiness = getJdMatchReadiness(project(base, { locale }));
    assert.equal(readiness.ready, false);
    assert.equal(readiness.reason, "demo");
    assert.match(readiness.message, /演示内容/);
  }
});

test("demo content signatures survive whitespace and punctuation changes", () => {
  const base = createDemoFactBase();
  base.profile.education = undefined;
  const resume = project(base);
  for (const experience of resume.experiences) {
    experience.org = "改过单位";
    experience.projectName = undefined;
    for (const claim of experience.claims) claim.text = `  ${claim.text.replace(/[，、；]/g, " ")}。  `;
  }
  assert.equal(getJdMatchReadiness(resume).reason, "demo");
});

test("one substantive real experience is ready even with sample IDs or an unknown name", () => {
  const base = realBase();
  const readiness = getJdMatchReadiness(project(base));
  assert.equal(readiness.ready, true);
  assert.equal(readiness.reason, null);
  assert.match(readiness.message, /不代表事实已核实/);
});

test("actual imports do not require importSource or a particular ID convention", () => {
  const base = realBase();
  base.experiences[0].id = "offline-exp-1";
  base.experiences[0].claims[0].id = "ai-claim-1";
  assert.equal(getJdMatchReadiness(project(base)).ready, true);
  base.importSource = { fileName: "example-resume.pdf", importedAt: base.updatedAt, rawText: "review text", unparsedLines: [] };
  assert.equal(getJdMatchReadiness(project(base)).ready, true);
});

test("a mixture of real and visible demo experiences blocks personal matching", () => {
  const base = realBase();
  base.experiences.push(...createDemoFactBase().experiences);
  const readiness = getJdMatchReadiness(project(base));
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "mixed-demo");
});

test("a demo sentence left inside an otherwise edited real experience remains blocked", () => {
  const base = realBase();
  base.experiences[0].claims.push(createDemoFactBase().experiences[0].claims[0]);
  assert.equal(getJdMatchReadiness(project(base)).reason, "mixed-demo");
});

test("an import marker cannot make bundled demo content personal evidence", () => {
  const base = createDemoFactBase();
  base.importSource = { fileName: "imported.json", importedAt: base.updatedAt, rawText: "imported demonstration", unparsedLines: [] };
  assert.equal(getJdMatchReadiness(project(base)).reason, "demo");
});

test("empty or header-only resumes cannot be matched even when skills are present", () => {
  const base = realBase();
  base.experiences = [];
  const resume = project(base);
  resume.profile.headline = "软件工程师";
  resume.profile.email = "test@example.invalid";
  resume.profile.targetRoles = ["后端开发"];
  resume.skills = ["C#", "TypeScript"];
  assert.equal(getJdMatchReadiness(resume).reason, "insufficient");
});

test("new blank work items and placeholder claims are not evidence", () => {
  const resume = project(realBase());
  const experience = resume.experiences[0];
  Object.assign(experience, { org: "", title: "", start: "", techStack: [], claims: [] });
  assert.equal(getJdMatchReadiness(resume).reason, "insufficient");
  Object.assign(experience, { org: "公司名称", title: "职位名称", projectName: "项目名称", claims: [{ id: "claim", kind: "action", text: "待补充", tags: [] }] });
  assert.equal(getJdMatchReadiness(resume).reason, "insufficient");
});

test("hiding all demo experiences also removes their derived skills", () => {
  const base = createDemoFactBase();
  const resume = project(base, {
    sectionVisibility: { experience: false, projects: false, education: false },
    profileVisibility: { education: false },
  });
  assert.equal(resume.experiences.length, 0);
  assert.deepEqual(resume.skills, []);
  assert.equal(getJdMatchReadiness(resume).reason, "insufficient");
});

test("skills come only from the visible real experiences when demo sections are hidden", () => {
  const base = realBase();
  base.experiences[0].type = "opensource";
  base.experiences[0].projectName = { zh: "设备监控工具" };
  const hiddenWork = createDemoFactBase().experiences[0];
  hiddenWork.id = "hidden-demo-work";
  base.experiences.push(hiddenWork);
  const resume = project(base, { sectionVisibility: { experience: false, projects: true } });
  assert.equal(resume.experiences.length, 1);
  assert.equal(resume.experiences[0].id, base.experiences[0].id);
  assert.deepEqual(resume.skills, ["C#"]);
  assert.ok(!resume.skills.includes("Redis"));
  assert.equal(getJdMatchReadiness(resume).ready, true);
});

test("hidden demo content does not block visible personal experiences", () => {
  const base = realBase();
  const hidden = createDemoFactBase().experiences;
  for (const experience of hidden) experience.id = `hidden-${experience.id}`;
  base.experiences.push(...hidden);
  const selected = project(base, { experienceSelection: "selected", includedExperienceIds: [base.experiences[0].id] });
  assert.equal(selected.experiences.length, 1);
  assert.equal(getJdMatchReadiness(selected).ready, true);
});

test("generic roles and technology names shared with the demo do not imply demonstration data", () => {
  const base = realBase();
  base.experiences[0].org.zh = "开源社区";
  base.experiences[0].title.zh = "核心贡献者";
  base.experiences[0].techStack = ["TypeScript", "Redis", "PostgreSQL"];
  assert.equal(getJdMatchReadiness(project(base)).ready, true);
});

test("an actual education record or dated technical role can provide limited evidence", () => {
  const base = realBase();
  base.experiences[0].claims = [];
  assert.equal(getJdMatchReadiness(project(base)).ready, true);
  base.experiences[0].type = "education";
  base.experiences[0].org.zh = "实际学院";
  base.experiences[0].title.zh = "计算机科学本科";
  base.experiences[0].techStack = [];
  assert.equal(getJdMatchReadiness(project(base)).ready, true);
});

test("a remaining demonstration school blocks an otherwise personal resume", () => {
  const base = realBase();
  base.profile.education = createDemoFactBase().profile.education;
  assert.equal(getJdMatchReadiness(project(base)).reason, "mixed-demo");
});
