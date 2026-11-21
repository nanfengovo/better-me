import assert from "node:assert/strict";
import test from "node:test";
import { createDemoFactBase } from "../src/seed/demo-fact-base.js";
import { factBaseToJsonResume, isJsonResumePayload, jsonResumeToFactBase } from "../src/project/jsonresume-io.js";

test("factBaseToJsonResume exports standard JSON Resume v1 and excludes unconfirmed metric numbers", () => {
  const demo = createDemoFactBase();
  // Inject one unconfirmed metric to verify zero-fabrication filtering
  demo.experiences[0]!.claims[0]!.metric = {
    value: 999,
    unit: "%",
    confirmed: false,
  };
  const exported = factBaseToJsonResume(demo, "zh");
  assert.equal(isJsonResumePayload(exported), true);
  assert.ok(exported.basics.name.length > 0);
  assert.ok(Array.isArray(exported.work) && exported.work.length > 0);
  assert.equal(JSON.stringify(exported).includes("999%"), false);
});

test("jsonResumeToFactBase imports standard jsonresume.org documents into a schema-valid FactBase", () => {
  const sample = {
    basics: {
      name: "Alex Chen",
      label: "Senior Full-Stack Engineer",
      email: "alex@example.com",
      phone: "+1-555-0100",
      url: "https://alex.example.com",
      summary: "Local-first distributed systems engineer.",
      location: { city: "Remote", countryCode: "US" },
      profiles: [{ network: "GitHub", url: "https://github.com/alex-demo" }],
    },
    work: [
      {
        name: "Northstar Systems",
        position: "Senior Engineer",
        startDate: "2023-04-01",
        endDate: "Present",
        highlights: ["Cut dispatch latency from 420ms to 95ms across 120 devices."],
        keywords: ["TypeScript", "React", "PostgreSQL"],
      },
    ],
    projects: [
      {
        name: "OpenFleet",
        roles: ["Maintainer"],
        startDate: "2022",
        endDate: "2023-03",
        highlights: ["Built deterministic ATS & workflow engine."],
        keywords: ["Node.js", "Docker"],
      },
    ],
    education: [
      {
        institution: "Example Tech",
        studyType: "B.S.",
        area: "Software Engineering",
        startDate: "2017-09",
        endDate: "2021-06",
      },
    ],
    skills: [{ name: "Backend", keywords: ["PostgreSQL", "Redis"] }],
  };

  assert.equal(isJsonResumePayload(sample), true);
  assert.equal(isJsonResumePayload({ factBase: {}, resumeViews: [] }), false);

  const factBase = jsonResumeToFactBase(sample, "2026-11-21T00:00:00.000Z");
  assert.equal(factBase.profile.displayName.zh, "Alex Chen");
  assert.equal(factBase.profile.email, "alex@example.com");
  assert.equal(factBase.experiences.length, 3);
  assert.equal(factBase.experiences[0]!.start, "2023-04");
  assert.equal(factBase.experiences[0]!.end, null);
  assert.equal(factBase.experiences[0]!.claims[0]!.text.zh, "Cut dispatch latency from 420ms to 95ms across 120 devices.");
  assert.equal(factBase.experiences[1]!.type, "opensource");
  assert.equal(factBase.experiences[2]!.type, "education");
});
