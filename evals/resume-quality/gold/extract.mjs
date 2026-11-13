import { createHash } from "node:crypto";
import { privateTerms, forbiddenPersonalTerms } from "./sources.mjs";

export const digest = value => createHash("sha256").update(value).digest("hex");
export const redact = text => privateTerms.reduce((s, [term, replacement]) => s.split(term).join(replacement), text);
const tidy = text => text.replace(/\s+/g, " ").trim();
const html = text => text.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&(?:raquo|nbsp);/g, " ");
function tex(text) {
  return text.replace(/\\link\{[^}]*\}\{(?:\\texttt\{([^}]+)\}|([^}]+))\}/g, (_, nested, plain) => nested ?? plain)
    .replace(/\\icon\{\\[A-Za-z]+\}/g, " ")
    .replace(/\\(?:enquote|texttt|emph|textbf)\{([^}]+)\}/g, "$1")
    .replace(/\\(?:begin|end)\{[^}]+\}(?:\[[^\]]*\])?/g, " ")
    .replace(/\\LaTeX\b/g, "LaTeX").replace(/\\([&%_])/g, "$1").replace(/\\item\b/g, " ");
}
export function piiFindings(text) {
  return [
    ...forbiddenPersonalTerms.filter(term => text.toLowerCase().includes(term.toLowerCase())).map(term => `personal:${term}`),
    ...(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map(() => "email"),
    ...(text.match(/(?:https?:\/\/|www\.)[^\s<>]+/g) ?? []).map(() => "url"),
    ...(text.match(/\b\d{3}[- ]\d{3,4}[- ]\d{4}\b/g) ?? []).map(() => "phone"),
    ...privateTerms.filter(([term]) => text.includes(term)).map(() => "unredacted-organization"),
  ];
}
/** Official JD hyperlinks are provenance, not candidate contact data. */
export function jobLinkFindings(text) {
  const allowedHosts = new Set(["gitlab.com", "handbook.gitlab.com", "about.gitlab.com", "docs.gitlab.com", "en.wikipedia.org"]);
  const urls = text.match(/https?:\/\/[^\s)<>]+/g) ?? [];
  const findings = urls.filter(url => {
    const parsed = new URL(url); return parsed.protocol !== "https:" || parsed.username || parsed.password || !allowedHosts.has(parsed.hostname);
  }).map(() => "unapproved_jd_url");
  return [...findings, ...piiFindings(text.replace(/https?:\/\/[^\s)<>]+/g, ""))];
}
export function sourceSpan(raw, start, end) {
  if (!(start >= 0 && end > start && end <= raw.length)) throw Error("invalid_original_span");
  return { start, end, startLine: raw.slice(0, start).split("\n").length,
    endLine: raw.slice(0, end - 1).split("\n").length, sha256: digest(raw.slice(start, end)) };
}
/** A data-only JSON parser with exact UTF-16 string-token locations. No source code is executed. */
function jsonStrings(raw) {
  const leaves = new Map(); let position = 0;
  const whitespace = () => { while (/\s/.test(raw[position] ?? "") && position < raw.length) position++; };
  function string() {
    const start = position++;
    while (position < raw.length) { const char = raw[position++]; if (char === "\\") position++; else if (char === '"') break; }
    const end = position; return { text: JSON.parse(raw.slice(start, end)), start, end };
  }
  function value(pointer) {
    whitespace();
    if (raw[position] === '"') { leaves.set(pointer, string()); return; }
    if (raw[position] === "{") {
      position++; whitespace();
      while (raw[position] !== "}") {
        const key = string().text; whitespace(); if (raw[position++] !== ":") throw Error("invalid_json_separator");
        value(`${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`); whitespace();
        if (raw[position] !== ",") break; position++; whitespace();
      }
      if (raw[position++] !== "}") throw Error("invalid_json_object");
    } else if (raw[position] === "[") {
      position++; whitespace(); let i = 0;
      while (raw[position] !== "]") { value(`${pointer}/${i++}`); whitespace(); if (raw[position] !== ",") break; position++; }
      if (raw[position++] !== "]") throw Error("invalid_json_array");
    } else { while (position < raw.length && !/[\s,}\]]/.test(raw[position])) position++; }
  }
  JSON.parse(raw); value(""); return leaves;
}
export function extractResume(source, raw) {
  const units = [], groups = [], map = [];
  function add(id, pieces, group, kind, context = "") {
    const text = redact(tidy(context + pieces.map(p => p.text).join(" ")));
    const findings = piiFindings(text); if (findings.length) throw Error(`${source.id}/${id}: ${findings.join(",")}`);
    units.push({ id, text, group, kind });
    map.push({ id, derivedSha256: digest(text), operation: "decode markup/JSON; normalize whitespace; deterministic pseudonym replacement; retain full selected unit",
      context, originals: pieces.map(p => sourceSpan(raw, p.start, p.end)) });
  }
  if (source.id === "c01" || source.id === "c03") {
    const parsed = JSON.parse(raw), strings = jsonStrings(raw);
    const piece = pointer => { const p = strings.get(pointer); if (!p) throw Error(`missing_json_pointer:${pointer}`); return p; };
    if (source.id === "c01") {
      add("summary", [piece("/summary")], "profile", "summary");
      parsed.experience.forEach((exp, i) => {
        const group = `work-${i}`;
        groups.push({ id: group, title: exp.role, organization: redact(exp.company), dates: `${exp.start} - ${exp.end}`, kind: i === 3 ? "training" : "employment",
          originals: ["company", "role", "start", "end"].map(key => { const p = piece(`/experience/${i}/${key}`); return sourceSpan(raw, p.start, p.end); }) });
        exp.highlights.forEach((_, j) => add(`${group}-action-${j}`, [piece(`/experience/${i}/role`), piece(`/experience/${i}/highlights/${j}`)], group, i === 3 ? "training" : "employment", i === 3 ? "Training. " : ""));
        exp.technologies.forEach((_, j) => add(`${group}-technology-${j}`, [piece(`/experience/${i}/technologies/${j}`)], group, "technology_list"));
      });
      parsed.skills.forEach((skill, i) => skill.items.forEach((_, j) => add(`skill-${i}-${j}`, [piece(`/skills/${i}/items/${j}`)], "skills", "skill_list")));
      parsed.projects.forEach((p, i) => p.highlights.forEach((_, j) => add(`personal-${i}-${j}`, [piece(`/projects/${i}/description`), piece(`/projects/${i}/highlights/${j}`)], "personal", "personal", "Personal project. ")));
      parsed.education.forEach((_, i) => add(`education-${i}`, [piece(`/education/${i}/school`), piece(`/education/${i}/degree`), piece(`/education/${i}/start`), piece(`/education/${i}/end`)], "education", "education"));
      parsed.certifications.forEach((_, i) => add(`certification-${i}`, [piece(`/certifications/${i}/name`)], "certifications", "certification"));
    } else {
      Object.entries(parsed.content).forEach(([key, entry]) => {
        if (key.startsWith("work-")) {
          groups.push({ id: key, title: entry.title, organization: redact(entry.company), dates: `${entry.startYear} / ${entry.endYear} (original fields; chronology unresolved)`, kind: key === "work-3" ? "internship" : "employment",
            originals: ["company", "title", "startYear", "endYear"].map(field => { const p = piece(`/content/${key}/${field}`); return sourceSpan(raw, p.start, p.end); }) });
          add(key, [piece(`/content/${key}/title`), piece(`/content/${key}/description`)], key, key === "work-3" ? "internship" : "employment");
        } else if (key.startsWith("project-")) {
          groups.push({ id: key, title: redact(entry.title), organization: entry.role, dates: `${entry.startYear} / ${entry.endYear} (original fields; chronology unresolved)`, kind: "project",
            originals: ["title", "role", "startYear", "endYear"].map(field => { const p = piece(`/content/${key}/${field}`); return sourceSpan(raw, p.start, p.end); }) });
          (entry.playerRole ?? []).forEach((_, j) => add(`${key}-action-${j}`, [piece(`/content/${key}/title`), piece(`/content/${key}/role`), piece(`/content/${key}/playerRole/${j}`)], key, key === "project-0" || key === "project-1" || key === "project-2" || key === "project-6" ? "mobile_project" : "mobile_web_project"));
          entry.techstack.forEach((_, j) => add(`${key}-technology-${j}`, [piece(`/content/${key}/techstack/${j}`)], key, "technology_list"));
        } else if (key.startsWith("skills-")) add(key, [piece(`/content/${key}/name`)], "skills", "skill_list");
        else if (key.startsWith("education-")) add(key, [piece(`/content/${key}/college`), piece(`/content/${key}/title`), piece(`/content/${key}/branch`), piece(`/content/${key}/year`), piece(`/content/${key}/description`)], "education", "education");
      });
    }
  } else if (source.id === "c02") {
    const blocks = [...raw.matchAll(/\[\[(jobs|early_career)\]\]([\s\S]*?)(?=\[\[|$)/g)];
    blocks.forEach((block, i) => {
      const body = block[0], offset = block.index, period = body.match(/period = "([^"]+)"/)[1];
      const content = body.match(/content = """([\s\S]*?)"""/), role = tidy(html(content[1]));
      const group = `work-${i}`;
      const periodMatch = body.match(/period = "([^"]+)"/);
      groups.push({ id: group, title: redact(role), organization: `Employer ${i + 1}`, dates: period, kind: i === 6 ? "freelance" : "employment",
        originals: [sourceSpan(raw, offset + content.index, offset + content.index + content[0].length), sourceSpan(raw, offset + periodMatch.index, offset + periodMatch.index + periodMatch[0].length)] });
      const projects = body.match(/projects = \[([\s\S]*?)\n\]/);
      if (projects) {
        const projectOffset = offset + projects.index + projects[0].indexOf(projects[1]);
        [...projects[1].matchAll(/"""([\s\S]*?)"""|"([^"\n]+)"/g)].forEach((m, j) => {
          const start = projectOffset + m.index;
          add(`${group}-action-${j}`, [{ text: role, start: offset + content.index, end: offset + content.index + content[0].length },
            { text: m[1] ?? m[2], start, end: start + m[0].length }], group, i === 6 ? "freelance" : "employment");
        });
      } else add(group, [{ text: role, start: offset + content.index, end: offset + content.index + content[0].length }], group, "employment");
      const tags = body.match(/tags = \[([\s\S]*?)\]/);
      if (tags) [...tags[1].matchAll(/"([^"\n]+)"/g)].forEach((m, j) => {
        const start = offset + tags.index + tags[0].indexOf(tags[1]) + m.index;
        add(`${group}-technology-${j}`, [{ text: m[1], start, end: start + m[0].length }], group, "technology_list");
      });
    });
  } else if (source.id === "c04") {
    const workStart = raw.indexOf('<section class="work-item">'), workEnd = raw.indexOf("<!-- //  EDUCATION", workStart);
    const detailsEnd = raw.indexOf('<div class="work-summary">', workStart);
    groups.push({ id: "freelance", title: "Web Developer & Designer", organization: "Self-employed", dates: "Jan 2017 - Present", kind: "freelance",
      originals: [sourceSpan(raw, workStart, detailsEnd)] });
    const work = raw.slice(workStart, workEnd);
    [...work.matchAll(/<li>([\s\S]*?)<\/li>/g)].forEach((m, i) => add(`freelance-action-${i}`, [{ text: html(m[1]), start: workStart + m.index, end: workStart + m.index + m[0].length }], "freelance", "freelance", "Self-employed Web Developer & Designer. "));
    [...raw.matchAll(/<section class="project-item">([\s\S]*?)<\/section>/g)].forEach((m, i) => {
      const title = m[1].match(/<h3>([\s\S]*?)<\/h3>/)[1], paragraph = m[1].match(/<p>([\s\S]*?)<\/p>/)[1];
      const group = `project-${i}`;
      groups.push({ id: group, title: redact(tidy(html(title))), organization: "Portfolio", dates: "Not stated", kind: /fictional/.test(title) ? "fictional_practice" : "portfolio",
        originals: [sourceSpan(raw, m.index, m.index + m[0].length)] });
      add(group, [{ text: `${html(title)}. ${html(paragraph)}`, start: m.index, end: m.index + m[0].length }], group, /fictional/.test(title) ? "fictional_practice" : "portfolio");
    });
    [...raw.matchAll(/<section class="education-item">([\s\S]*?)<\/section>/g)].forEach((m, i) => add(`education-${i}`, [{ text: html(m[1]), start: m.index, end: m.index + m[0].length }], "education", "education"));
    const profile = raw.match(/<p>I've been[\s\S]*?<\/p>/);
    add("profile", [{ text: html(profile[0]), start: profile.index, end: profile.index + profile[0].length }], "profile", "summary");
    const skills = work.match(/<p>Created so many projects[\s\S]*?<\/p>/);
    add("professional-skills", [{ text: html(skills[0]), start: workStart + skills.index, end: workStart + skills.index + skills[0].length }], "freelance", "skill_list");
  } else if (source.id === "c05") {
    const sections = [...raw.matchAll(/\\sectionTitle\{([^}]+)\}/g)];
    const internships = raw.indexOf("\\sectionTitle{Internships}");
    [...raw.matchAll(/\\item\s+([\s\S]*?)(?=\\item\b|\\end\{itemize\})/g)].forEach((m, i) => {
      const section = sections.filter(s => s.index < m.index).at(-1)?.[1] ?? "Unknown";
      const intern = m.index > internships;
      const second = raw.indexOf("{Web Developer @ 97 Suifang");
      const group = intern ? (m.index < second ? "internship-data" : "internship-web") : section.toLowerCase().replace(/[^a-z]+/g, "-");
      const context = intern ? (group === "internship-data" ? "Data Engineer internship (April-August 2018). " : "Web Developer internship (July-September 2013). ") : `${section}. `;
      add(`item-${i}`, [{ text: tex(m[1]), start: m.index, end: m.index + m[0].length }], group, intern ? "internship" : section === "Personal Projects" ? "personal" : section === "Research Achievements" ? "academic" : "computer_skills", context);
    });
    const summary = raw.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/);
    add("summary", [{ text: tex(summary[1]), start: summary.index, end: summary.index + summary[0].length }], "profile", "summary");
    [...raw.matchAll(/\\comptence\{([^}]+)\}\{([\s\S]*?)\n  \}/g)].forEach((m, i) => add(`competence-${i}`, [{ text: `${m[1]}: ${tex(m[2]).replace(/%/g, " ")}`, start: m.index, end: m.index + m[0].length }], "skills", "skill_list"));
    [...raw.matchAll(/\\education%([\s\S]*?)(?=\n\s*\\separator|\n\\end\{educations\})/g)].forEach((m, i) => add(`education-${i}`, [{ text: tex(m[1]).replace(/[%{}[\]]/g, " "), start: m.index, end: m.index + m[0].length }], "education", "education"));
    const headers = [...raw.slice(internships).matchAll(/\\experience%([\s\S]*?)(?=\[\\begin\{itemize\})/g)];
    groups.push({ id: "internship-data", title: "Data Engineer internship", organization: "Employer R", dates: "April-August 2018", kind: "internship",
      originals: [sourceSpan(raw, internships + headers[0].index, internships + headers[0].index + headers[0][0].length)] },
    { id: "internship-web", title: "Web Developer internship", organization: "Employer S", dates: "July-September 2013", kind: "internship",
      originals: [sourceSpan(raw, internships + headers[1].index, internships + headers[1].index + headers[1][0].length)] });
  } else throw Error("unknown_source");
  if (!units.length) throw Error("no_evidence_extracted");
  return { units, groups, map };
}
