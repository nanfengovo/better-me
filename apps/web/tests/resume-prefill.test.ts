import assert from "node:assert/strict";
import test from "node:test";
import { extractResumePrefill } from "../src/components/atlas/resume-prefill";
import type { FactBase, ProjectedResume } from "@better-me/core";

test("extractResumePrefill handles empty or missing inputs gracefully", () => {
  const result = extractResumePrefill(null, null);
  assert.equal(result.hasResumeData, false);
  assert.equal(result.targetRole, "");
  assert.equal(result.locationName, "");
  assert.deepEqual(result.skills, []);
});

test("extractResumePrefill extracts target role, city, and top skills correctly", () => {
  const mockResume: ProjectedResume = {
    locale: "zh",
    templateId: "default",
    profile: {
      displayName: "张三",
      targetRoles: ["资深前端工程师"],
      location: "上海市",
      links: [],
      traits: [],
    },
    skills: ["React", "TypeScript"],
    experiences: [],
  };

  const mockFactBase: Partial<FactBase> = {
    profile: {
      displayName: { zh: "张三" },
      targetRoles: [{ zh: "资深前端开发" }],
      location: { zh: "上海" },
      salaryRange: { minK: 30, maxK: 50, currency: "CNY" },
      links: [],
      traits: [],
      constraints: [],
    },
    experiences: [
      {
        id: "exp-1",
        type: "work",
        org: { zh: "某大厂" },
        title: { zh: "前端技术专家" },
        start: "2021-01",
        end: null,
        techStack: ["React", "TypeScript", "Next.js", "Node.js"],
        claims: [
          {
            id: "claim-1",
            kind: "action",
            text: { zh: "主导微前端重构" },
            tags: ["微前端", "Performance", "React"],
          },
        ],
      },
      {
        id: "exp-2",
        type: "work",
        org: { zh: "某初创" },
        title: { zh: "前端开发" },
        start: "2019-01",
        end: "2020-12",
        techStack: ["React", "Vue", "Webpack"],
        claims: [],
      },
    ],
  };

  const prefill = extractResumePrefill(mockResume, mockFactBase as FactBase);
  assert.equal(prefill.hasResumeData, true);
  assert.equal(prefill.targetRole, "资深前端工程师");
  assert.equal(prefill.mode, "domestic");
  assert.equal(prefill.chinaSelection.provinceCode, "31");
  assert.equal(prefill.chinaSelection.cityCode, "3101");
  assert.equal(prefill.salaryMinWan, "36"); // 30k * 12 / 10 = 36万
  // React should be most frequent
  assert.equal(prefill.skills[0], "React");
  assert.ok(prefill.skills.includes("TypeScript"));
  assert.ok(prefill.skills.includes("Next.js"));
  assert.ok(prefill.summaryLabel.includes("资深前端工程师"));
});

test("extractResumePrefill resolves Beijing, Shenzhen, and Hong Kong", () => {
  const bj = extractResumePrefill(null, {
    profile: {
      displayName: { zh: "李四" },
      location: { zh: "北京海淀" },
      targetRoles: [],
      links: [],
      traits: [],
      constraints: [],
    },
    experiences: [],
  } as unknown as FactBase);
  assert.equal(bj.chinaSelection.provinceCode, "11");
  assert.equal(bj.chinaSelection.cityCode, "1101");

  const hk = extractResumePrefill(null, {
    profile: {
      displayName: { zh: "王五" },
      location: { zh: "中国香港" },
      targetRoles: [],
      links: [],
      traits: [],
      constraints: [],
    },
    experiences: [],
  } as unknown as FactBase);
  assert.equal(hk.chinaSelection.provinceCode, "HK");
});
