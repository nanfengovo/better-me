import { getResumeSectionOrder } from "../schema/resume.js";
import type { ProjectedExperience, ProjectedResume } from "./resume-projection.js";

/** Input contract checked against the upstream example and schema, not a bundled renderer. */
export const RENDERCV_EXPORT_TARGET = {
  version: "2.8",
  commit: "1d4b87bc427e4cf61c0ef49623c971b0e2224708",
  schemaUrl: "https://raw.githubusercontent.com/rendercv/rendercv/1d4b87bc427e4cf61c0ef49623c971b0e2224708/schema.json",
} as const;

export type RenderCvExportDiagnostic = {
  code: "renderer-design" | "photo-omitted" | "text-styles-omitted" | "education-as-text" | "unsafe-link-omitted" | "chinese-font" | "blank-name" | "unsupported-character";
  severity: "info" | "warning";
  path: string;
  message: string;
};

type RenderCvEntry = {
  name?: string;
  company?: string;
  position?: string;
  start_date: string;
  end_date: string;
  summary?: string;
  highlights?: string[];
};

export type RenderCvYamlDocument = {
  cv: {
    name: string;
    headline?: string;
    location?: string;
    email?: string;
    custom_connections?: { fontawesome_icon: string; placeholder: string; url: null }[];
    sections: Record<string, string[] | RenderCvEntry[]>;
  };
  design: {
    theme: "classic";
    page: { size: "a4"; show_top_note: false };
    typography?: { font_family: "Noto Sans" };
  };
  locale: { language: "mandarin_chinese" | "english" };
};

export type RenderCvYamlExport = {
  yaml: string;
  /** Useful for validating the adapter without needing a YAML parser or Python runtime. */
  document: RenderCvYamlDocument;
  diagnostics: RenderCvExportDiagnostic[];
  targetVersion: typeof RENDERCV_EXPORT_TARGET.version;
};

type YamlValue = string | boolean | null | YamlValue[] | { [key: string]: YamlValue | undefined };

/** JSON double-quoted scalars are also YAML 1.2 scalars; never interpolate raw user YAML. */
function quote(value: string): string {
  return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function yamlLines(value: YamlValue, depth = 0): string[] {
  const indent = "  ".repeat(depth);
  const scalar = (item: YamlValue) => typeof item === "string" ? quote(item) : String(item);
  const isScalar = (item: YamlValue): item is string | boolean | null => item === null || typeof item !== "object";
  if (isScalar(value)) return [indent + scalar(value)];
  if (Array.isArray(value)) {
    if (!value.length) return [indent + "[]"];
    return value.flatMap((item) => isScalar(item) ? [indent + "- " + scalar(item)] : [indent + "-", ...yamlLines(item, depth + 1)]);
  }
  const entries = Object.entries(value).filter((entry): entry is [string, YamlValue] => entry[1] !== undefined);
  if (!entries.length) return [indent + "{}"];
  return entries.flatMap(([key, item]) => {
    const prefix = indent + quote(key) + ":";
    if (isScalar(item)) return [prefix + " " + scalar(item)];
    if (Array.isArray(item) && !item.length) return [prefix + " []"];
    if (!Array.isArray(item) && Object.keys(item).length === 0) return [prefix + " {}"];
    return [prefix, ...yamlLines(item, depth + 1)];
  });
}

/**
 * Export only the selected projection. This is a one-way interchange document, not
 * another FactBase, and never translates or recomputes a claim from its metrics.
 *
 * RenderCV intentionally accepts Markdown, raw Typst commands and $$ math. All
 * BetterMe text is literal: Markdown is escaped and a word joiner after # / $
 * prevents the upstream command/math recognizers from treating it as executable
 * markup. The word joiner has no visible glyph. Links are printed as text; the
 * adapter never creates a Markdown link or a remote photo fetch.
 */
export function projectedResumeToRenderCvYaml(resume: ProjectedResume): RenderCvYamlExport {
  const diagnostics: RenderCvExportDiagnostic[] = [];
  const add = (code: RenderCvExportDiagnostic["code"], path: string, message: string, severity: RenderCvExportDiagnostic["severity"] = "info") => diagnostics.push({ code, path, message, severity });
  const isZh = resume.locale === "zh";
  const plain = (value: string, path: string): string => {
    // YAML does not accept lone UTF-16 surrogates or non-characters. Report any repair.
    const validUnicode = Array.from(value, (char) => {
      const point = char.codePointAt(0)!;
      return (point < 0x20 && ![9, 10, 13].includes(point)) || (point >= 0xd800 && point <= 0xdfff) || (point & 0xffff) >= 0xfffe || (point >= 0xfdd0 && point <= 0xfdef) ? "\ufffd" : char;
    }).join("");
    if (validUnicode !== value) add("unsupported-character", path, "无法编码的 Unicode 字符已替换为替代字符，请核对原文。", "warning");
    return validUnicode.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/([\\`*_[\]{}()!|])/g, "\\$1").replace(/[#$]/g, (char) => char + "\u2060");
  };
  const safeUrl = (value: string, path: string): string | undefined => {
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || Array.from(value).some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f)) throw new Error("unsupported URL");
      return url.href;
    } catch {
      add("unsafe-link-omitted", path, "此链接不是无凭据的 HTTP(S) 地址，已省略网址；未生成可执行链接。", "warning");
      return undefined;
    }
  };
  const cv: RenderCvYamlDocument["cv"] = { name: plain(resume.profile.displayName, "profile.displayName"), sections: {} };
  if (!resume.profile.displayName.trim()) add("blank-name", "profile.displayName", "当前视图姓名为空，导出保留为空，请在渲染前补充。", "warning");
  if (resume.profile.headline) cv.headline = plain(resume.profile.headline, "profile.headline");
  if (resume.profile.location) cv.location = plain(resume.profile.location, "profile.location");
  if (resume.profile.email) cv.email = resume.profile.email;

  const connections: NonNullable<RenderCvYamlDocument["cv"]["custom_connections"]> = [];
  // Keep local phone formatting instead of guessing an international calling code.
  if (resume.profile.phone) connections.push({ fontawesome_icon: "phone", placeholder: plain(resume.profile.phone, "profile.phone"), url: null });
  if (resume.profile.education) connections.push({ fontawesome_icon: "graduation-cap", placeholder: plain(resume.profile.education, "profile.education"), url: null });
  resume.profile.links.forEach((link, index) => {
    const url = safeUrl(link.url, `profile.links[${index}].url`);
    const text = [link.label, url].filter(Boolean).join(": ");
    if (text) connections.push({ fontawesome_icon: "link", placeholder: plain(text, `profile.links[${index}]`), url: null });
  });
  if (connections.length) cv.custom_connections = connections;

  const experienceEntry = (exp: ProjectedExperience): RenderCvEntry => {
    const path = `experiences.${exp.id}`;
    const work = exp.type === "work";
    const entry: RenderCvEntry = { start_date: exp.start, end_date: exp.end ?? "present" };
    if (work) {
      entry.company = plain(exp.org, `${path}.org`);
      entry.position = plain(exp.title, `${path}.title`);
    } else {
      entry.name = plain(exp.type === "education" ? exp.org : exp.projectName || exp.org, `${path}.name`);
    }
    const summary: string[] = [];
    if (!work && exp.title) summary.push(exp.title);
    if (!work && exp.projectName && exp.projectName !== exp.org && exp.type !== "education" && exp.org) summary.push(exp.org);
    if (work && exp.projectName) summary.push(`${isZh ? "项目" : "Project"}: ${exp.projectName}`);
    if (exp.techStack.length) summary.push(`${isZh ? "技术栈" : "Technologies"}: ${exp.techStack.join(" · ")}`);
    if (exp.url) {
      const url = safeUrl(exp.url, `${path}.url`);
      if (url) summary.push(`${isZh ? "相关链接" : "Link"}: ${url}`);
    }
    if (summary.length) entry.summary = plain(summary.join("\n"), `${path}.summary`);
    const claims = exp.claims.filter((claim) => claim.kind !== "interview" && claim.kind !== "pitfall" && !(claim.metric && !claim.metric.confirmed));
    if (claims.length) entry.highlights = claims.map((claim) => plain(claim.text, `${path}.claims.${claim.id}`));
    return entry;
  };

  for (const section of getResumeSectionOrder(resume.sectionOrder)) {
    if (resume.sectionVisibility?.[section] === false) continue;
    if (section === "summary") {
      if (resume.profile.targetRoles.length) cv.sections[isZh ? "目标方向" : "Target Roles"] = resume.profile.targetRoles.map((role, index) => plain(role, `profile.targetRoles[${index}]`));
      if (resume.profile.traits.length) cv.sections[isZh ? "核心优势与专长" : "Key Competencies"] = resume.profile.traits.map((trait, index) => plain(trait, `profile.traits[${index}]`));
    } else if (section === "skills") {
      const skills = resume.skills ?? [...new Set(resume.experiences.flatMap((exp) => exp.techStack))];
      if (skills.length) cv.sections[isZh ? "专业技能" : "Technical Skills"] = [plain(skills.join(" · "), "skills")];
    } else if (section !== "custom") {
      const experiences = resume.experiences.filter((exp) => section === "experience" ? exp.type === "work" : section === "education" ? exp.type === "education" : exp.type === "opensource" || exp.type === "other");
      const title = section === "experience" ? isZh ? "工作经历" : "Work Experience" : section === "education" ? isZh ? "教育背景" : "Education" : isZh ? "项目与作品经历" : "Projects & Works";
      if (experiences.length) cv.sections[title] = experiences.map(experienceEntry);
      else if (section === "education" && resume.educationSummary) cv.sections[title] = [plain(resume.educationSummary, "educationSummary")];
      if (section === "education" && experiences.length) add("education-as-text", "experiences.education", "教育经历使用通用条目保留原始名称和职位/学历文字，没有推断或拆分学位、专业。");
    }
  }

  add("renderer-design", "design", "导出使用 RenderCV 2.8 的 classic/A4 排版；保留内容和分节顺序，网页模板、颜色、字号和间距不映射。");
  if (resume.profile.avatarUrl && resume.templateId !== "en-ats") add("photo-omitted", "profile.avatarUrl", "此 YAML 不打包或下载照片。若需要照片，请在本地放置图片并自行设置 cv.photo。", "warning");
  if (resume.textStyles && Object.values(resume.textStyles).some((ranges) => ranges.length)) add("text-styles-omitted", "textStyles", "选中文字的粗体、斜体、下划线、高亮和大小未映射；原文按纯文本保留。");
  if (isZh) add("chinese-font", "design.typography.font_family", "中文使用 RenderCV 支持的 Noto Sans 字体族；请在本地核验中文字形，缺字时安装相应字体并调整字体名，或在 YAML 同级 fonts/ 放置许可允许的字体。未打包字体。");

  const document: RenderCvYamlDocument = {
    cv,
    design: { theme: "classic", page: { size: "a4", show_top_note: false }, ...(isZh ? { typography: { font_family: "Noto Sans" as const } } : {}) },
    locale: { language: isZh ? "mandarin_chinese" : "english" },
  };
  const yaml = `# yaml-language-server: $schema=${RENDERCV_EXPORT_TARGET.schemaUrl}\n# BetterMe selected resume → RenderCV ${RENDERCV_EXPORT_TARGET.version}; render locally with RenderCV.\n${yamlLines(document).join("\n")}\n`;
  return { yaml, document, diagnostics, targetVersion: RENDERCV_EXPORT_TARGET.version };
}
