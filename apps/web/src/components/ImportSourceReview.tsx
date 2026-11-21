/** @jsxRuntime automatic */
import { ChevronDown, Download, Sparkles, Check } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import { Button } from "../design-system";
import type { Experience, FactBase, ResumeImportSource } from "@better-me/core";

type FactClaim = Experience["claims"][number];

function isWrappedContinuationLine(prevText: string, nextText: string): boolean {
  const prev = prevText.trim();
  const next = nextText.trim();
  if (!prev || !next) return false;
  if (/^(?:内容|个人职责|主要职责|工作职责|职责|业绩|主要业绩|项目业绩|成果|核心项目|项目名称|项目背景|项目简介|项目内容|代码库|技术栈)\s*[：:]/.test(prev)) return false;
  if (/^(?:内容|个人职责|主要职责|工作职责|职责|业绩|主要业绩|项目业绩|成果|核心项目|项目名称|项目背景|项目简介|项目内容|代码库|技术栈)\s*[：:]/.test(next)) return false;
  if (next.includes("|") || /(?:19|20)\d{2}\s*[-–—~至到.]/.test(next)) return false;
  if (/[。！？；.!?;:：]$/.test(prev)) return false;
  return next.length <= 28;
}

function mergeBrokenClaimsInExperiences(experiences: Experience[]): { experiences: Experience[]; mergedCount: number } {
  let mergedCount = 0;
  const nextExperiences = experiences.map((exp) => {
    const mergedClaims: FactClaim[] = [];
    for (const claim of exp.claims) {
      const prev = mergedClaims[mergedClaims.length - 1];
      if (prev && isWrappedContinuationLine(prev.text.zh, claim.text.zh)) {
        mergedClaims[mergedClaims.length - 1] = {
          ...prev,
          text: {
            ...prev.text,
            zh: `${prev.text.zh.trim()}${claim.text.zh.trim()}`,
          },
          metric: prev.metric ?? claim.metric,
        };
        mergedCount++;
      } else {
        mergedClaims.push(claim);
      }
    }
    return mergedClaims.length === exp.claims.length ? exp : { ...exp, claims: mergedClaims };
  });
  return { experiences: nextExperiences, mergedCount };
}

export function supplementFactBaseFromImportSource(factBase: FactBase): FactBase {
  const source = factBase.importSource;
  const { experiences: wrapFixedExperiences } = mergeBrokenClaimsInExperiences(factBase.experiences);
  if (!source || source.unparsedLines.length === 0) {
    return { ...factBase, experiences: wrapFixedExperiences };
  }

  // Step 1: Merge wrapped lines inside unparsedLines
  const mergedLines: string[] = [];
  for (const rawLine of source.unparsedLines) {
    const line = rawLine.trim();
    if (!line) continue;
    const prev = mergedLines[mergedLines.length - 1];
    if (prev && isWrappedContinuationLine(prev, line)) {
      mergedLines[mergedLines.length - 1] = `${prev}${line}`;
    } else {
      mergedLines.push(line);
    }
  }

  let nextEducationProfile = factBase.profile.education;
  const addedExperiences: Experience[] = [];
  let currentProject: Experience | null = null;
  const fallbackProjectStart =
    wrapFixedExperiences.find((exp) => exp.type === "opensource" || exp.type === "other")?.start ?? "2024-01";

  const flushProject = () => {
    if (currentProject) {
      addedExperiences.push(currentProject);
      currentProject = null;
    }
  };

  for (const line of mergedLines) {
    // Check Education line: e.g. "江苏电子信息职业学院 大专 电子信息工程技术 2020-2023"
    const eduMatch = line.match(
      /^(\S+(?:大学|学院|学校|University|College))\s+(?:(本科|硕士|博士|大专|专科|学士|Master|Bachelor|PhD)\s+)?(\S+)?\s*((?:19|20)\d{2})\s*[-–—~至到]\s*((?:19|20)\d{2}|至今|现在|Present)$/i
    );
    if (eduMatch) {
      flushProject();
      const [, school, degree = "", major = "", startYear, endRaw] = eduMatch;
      const isCurrent = /^(?:至今|现在|Present)$/i.test(endRaw!);
      if (!nextEducationProfile?.zh.trim()) {
        nextEducationProfile = {
          ...(nextEducationProfile ?? { zh: "" }),
          zh: [school, degree, major, `${startYear}-${endRaw}`].filter(Boolean).join(" · "),
        };
      }
      const alreadyHasEdu = wrapFixedExperiences.some(
        (exp) => exp.type === "education" && exp.org.zh.includes(school!)
      );
      if (!alreadyHasEdu) {
        addedExperiences.push({
          id: crypto.randomUUID(),
          type: "education",
          org: { zh: school! },
          title: { zh: [degree, major].filter(Boolean).join(" · ") || "专业学习" },
          start: `${startYear}-09`,
          end: isCurrent ? null : `${endRaw}-06`,
          techStack: [],
          claims: [],
        });
      }
      continue;
    }

    // Skip personal profile metadata lines (e.g., "男 | 年龄：24岁", "电话：... | 邮箱：...")
    if (
      /^(?:男|女|性别|年龄|出生|籍贯|民族|政治面貌|婚姻状况|现居|期望城市|电话|手机|邮箱|微信|GitHub|LinkedIn)\b/i.test(line) ||
      /(?:年龄\s*[：:]\s*\d+|性别\s*[：:]|岁\s*$)/.test(line)
    ) {
      continue;
    }

    // Check Project header with pipe: e.g. "面向工业现场的开源 AI Agent 工作台 | 个人项目 | 2026 - 至今" or "AI Decision Intelligence Platform（InvestBrain） | 个人项目"
    if (line.includes("|")) {
      const parts = line.split("|").map((item) => item.trim()).filter(Boolean);
      if (parts.length >= 2) {
        flushProject();
        const projectName = parts[0]!;
        const rolePart = parts[1] || "个人项目";
        const datePart = parts[2] || "";
        const yearMatch = datePart.match(/((?:19|20)\d{2})(?:\s*[./年-]\s*(\d{1,2}))?\s*[-–—~至到]\s*((?:19|20)\d{2}(?:\s*[./年-]\s*\d{1,2})?|至今|现在|Present)/i);
        const start = yearMatch
          ? `${yearMatch[1]}-${(yearMatch[2] || "01").padStart(2, "0")}`
          : fallbackProjectStart;
        const isCurrent = yearMatch ? /^(?:至今|现在|Present)$/i.test(yearMatch[3]!) : true;
        const end =
          yearMatch && !isCurrent
            ? `${yearMatch[3]!.slice(0, 4)}-12`
            : null;
        currentProject = {
          id: crypto.randomUUID(),
          type: "opensource",
          org: { zh: projectName },
          title: { zh: rolePart },
          start,
          end,
          techStack: [],
          claims: [],
        };
        continue;
      }
    }

    // Otherwise, attach to currentProject (or create one if none)
    if (!currentProject) {
      currentProject = {
        id: crypto.randomUUID(),
        type: "opensource",
        org: { zh: "补充项目经历" },
        title: { zh: "个人项目" },
        start: fallbackProjectStart,
        end: null,
        techStack: [],
        claims: [],
      };
    }

    const activeProject = currentProject;
    const techMatch = line.match(/^技术栈\s*[：:]\s*(.+)$/);
    if (techMatch && techMatch[1]) {
      const tags = techMatch[1]
        .split(/[,，、/]/)
        .map((item) => item.trim())
        .filter(Boolean);
      activeProject.techStack = Array.from(new Set([...activeProject.techStack, ...tags]));
    }

    const urlMatch = line.match(/^代码库\s*[：:]\s*(https?:\/\/\S+)$/i);
    if (urlMatch && urlMatch[1] && !activeProject.url) {
      activeProject.url = urlMatch[1];
    }

    activeProject.claims.push({
      id: crypto.randomUUID(),
      text: { zh: line },
      kind: "action",
      tags: [],
    });
  }

  flushProject();

  // Remove empty shell "个人项目" placeholder if we added concrete project experiences
  const hasAddedProjects = addedExperiences.some((exp) => exp.type === "opensource" || exp.type === "other");
  const filteredExisting = wrapFixedExperiences.filter(
    (exp) => !(hasAddedProjects && (exp.type === "opensource" || exp.type === "other") && exp.claims.length === 0)
  );

  return {
    ...factBase,
    profile: {
      ...factBase.profile,
      education: nextEducationProfile,
    },
    experiences: [...filteredExisting, ...addedExperiences],
    importSource: {
      ...source,
      unparsedLines: [],
    },
  };
}

/** Kept with the local document; source evidence never enters the printed resume. */
export function ImportSourceReview({
  source,
  factBase,
  onUpdateFactBase,
}: {
  source?: ResumeImportSource;
  factBase?: FactBase;
  onUpdateFactBase?: (next: FactBase) => void;
}) {
  const { t } = useUiPreferences();

  if (!source) return null;
  const brokenWrapCount = factBase ? mergeBrokenClaimsInExperiences(factBase.experiences).mergedCount : 0;
  const unconfirmedMetricCount = factBase
    ? factBase.experiences.reduce(
        (sum, exp) => sum + exp.claims.filter((c) => Boolean(c.metric && !c.metric.confirmed)).length,
        0
      )
    : 0;

  function downloadSource() {
    if (!source) return;
    const content = [source.rawText, ...(source.ocrText ? [t("\n视觉模型转录（需对照原图核实）\n", "\nVisual model transcription (verify against the original image)\n"), source.ocrText] : [])].join("");
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    const safeName = Array.from(source.fileName.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*]/g, "_"), (character) => character.charCodeAt(0) < 32 ? "_" : character).join("");
    anchor.download = `${safeName}-${t("原文", "source")}.txt`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const hasPending = source.unparsedLines.length > 0 || brokenWrapCount > 0 || unconfirmedMetricCount > 0;

  return <details className="bm-notice-bar no-print">
    <summary>
      <span className="bm-notice-dot" data-tone={hasPending ? "warn" : "clean"} aria-hidden="true" />
      <span className="break-words">
        {t("导入原文与待补录 · ", "Imported source & items to review · ")}
        {source.unparsedLines.length
          ? t(`${source.unparsedLines.length} 段待核对`, `${source.unparsedLines.length} ${source.unparsedLines.length === 1 ? "section" : "sections"} to review`)
          : brokenWrapCount > 0
            ? t(`${brokenWrapCount} 处断行待合并`, `${brokenWrapCount} wrapped lines to merge`)
            : t("查看原文", "View source")}
        {source.unparsedLines.length > 0 && brokenWrapCount > 0 && t(` · ${brokenWrapCount} 处断行`, ` · ${brokenWrapCount} wrapped`)}
        {unconfirmedMetricCount > 0 && t(` · ${unconfirmedMetricCount} 项待确认指标`, ` · ${unconfirmedMetricCount} unconfirmed metrics`)}
      </span>
      <ChevronDown size={14} className="bm-notice-chevron" aria-hidden="true" />
    </summary>
    <div className="bm-notice-body">
      <p className="break-words" style={{ color: "var(--ui-text-muted)", margin: 0 }}>{t("来源：", "Source: ")}{source.fileName}{t("（仅本地存档，不进入对外简历）", " (local reference only, excluded from resume)")}</p>
      {factBase && onUpdateFactBase && hasPending && (
        <div className="bm-notice-action-strip">
          <span style={{ fontWeight: 550 }}>
            {t(
              `检测到 ${source.unparsedLines.length} 段未入库内容（含个人项目/教育经历）${brokenWrapCount > 0 ? `、${brokenWrapCount} 处 PDF 断行` : ""}${unconfirmedMetricCount > 0 ? `、${unconfirmedMetricCount} 条待确认业绩指标` : ""}：`,
              `Detected ${source.unparsedLines.length} unparsed lines${brokenWrapCount > 0 ? `, ${brokenWrapCount} wrapped lines` : ""}${unconfirmedMetricCount > 0 ? `, ${unconfirmedMetricCount} unconfirmed metrics` : ""}:`
            )}
          </span>
          {(source.unparsedLines.length > 0 || brokenWrapCount > 0) && (
            <Button
              variant="tinted"
              size="xs"
              onClick={() => onUpdateFactBase(supplementFactBaseFromImportSource(factBase))}
            >
              <Sparkles size={12} aria-hidden="true" />
              {t("一键补录待核对内容并修复断行", "Supplement all & fix line wraps")}
            </Button>
          )}
          {unconfirmedMetricCount > 0 && (
            <Button
              variant="secondary"
              size="xs"
              onClick={() =>
                onUpdateFactBase({
                  ...factBase,
                  experiences: factBase.experiences.map((exp) => ({
                    ...exp,
                    claims: exp.claims.map((c) => (c.metric ? { ...c, metric: { ...c.metric, confirmed: true } } : c)),
                  })),
                })
              }
            >
              <Check size={12} aria-hidden="true" />
              {t(`核实并展示全部业绩指标（${unconfirmedMetricCount} 项）`, `Confirm & show all metrics (${unconfirmedMetricCount})`)}
            </Button>
          )}
        </div>
      )}
      {source.unparsedLines.length > 0 && <section aria-label={t("待补录原文", "Source text to review")}>
        <p style={{ fontWeight: 600, color: "var(--ui-warning)", margin: 0 }}>{t("未入库原文（核对后可补录）", "Unparsed source lines (review before adding)")}</p>
        <pre className="bm-notice-pre" data-tone="warn">{source.unparsedLines.join("\n")}</pre>
      </section>}
      <details><summary className="cursor-pointer">{t("展开完整提取原文", "Expand all extracted source text")}</summary><pre className="bm-notice-pre">{source.rawText}</pre></details>
      {source.ocrText && <details><summary className="cursor-pointer">{t("视觉模型转录（未核实，请对照原图）", "Visual model transcription (unverified; compare with the original image)")}</summary><pre className="bm-notice-pre">{source.ocrText}</pre></details>}
      <div><Button variant="secondary" size="xs" onClick={downloadSource}><Download size={12} aria-hidden="true" />{t("下载导入原文", "Download imported source text")}</Button></div>
    </div>
  </details>;
}
