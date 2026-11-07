/** @jsxRuntime automatic */
import { useUiPreferences } from "../lib/ui-preferences";
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
  return <details className="no-print rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs text-slate-700" open={source.unparsedLines.length > 0 || brokenWrapCount > 0}>
    <summary className="cursor-pointer font-semibold break-words">
      {t("导入原文与待补录 · ", "Imported source & items to review · ")}
      {source.unparsedLines.length
        ? t(`${source.unparsedLines.length} 段待核对`, `${source.unparsedLines.length} ${source.unparsedLines.length === 1 ? "section" : "sections"} to review`)
        : brokenWrapCount > 0
          ? t(`${brokenWrapCount} 处断行待合并`, `${brokenWrapCount} wrapped lines to merge`)
          : t("查看原文", "View source")}
    </summary>
    <div className="mt-3 space-y-3">
      <p className="break-words">{t("来源：", "Source: ")}{source.fileName}{t("。以下是导入时的提取文本快照，随本地文档和 JSON 备份保存，不进入对外简历。原文件、原版式及后续修改未包含在此快照中，请保留原 PDF / Word。", ". This extracted text snapshot is saved with the local document and JSON backup and is excluded from the resume. It does not include the original file, layout or later edits. Keep the original PDF / Word file.")}</p>
      {factBase && onUpdateFactBase && (source.unparsedLines.length > 0 || brokenWrapCount > 0 || unconfirmedMetricCount > 0) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-950">
          <span className="font-medium">
            {t(
              `检测到 ${source.unparsedLines.length} 段未入库内容（含个人项目/教育经历）${brokenWrapCount > 0 ? `、${brokenWrapCount} 处 PDF 断行` : ""}${unconfirmedMetricCount > 0 ? `、${unconfirmedMetricCount} 条待确认业绩指标` : ""}：`,
              `Detected ${source.unparsedLines.length} unparsed lines${brokenWrapCount > 0 ? `, ${brokenWrapCount} wrapped lines` : ""}${unconfirmedMetricCount > 0 ? `, ${unconfirmedMetricCount} unconfirmed metrics` : ""}:`
            )}
          </span>
          {(source.unparsedLines.length > 0 || brokenWrapCount > 0) && (
            <button
              type="button"
              onClick={() => onUpdateFactBase(supplementFactBaseFromImportSource(factBase))}
              className="rounded-md bg-emerald-600 px-2.5 py-1 font-semibold text-white hover:bg-emerald-700"
            >
              {t("✨ 一键补录待核对内容并修复断行", "✨ Supplement all & fix line wraps")}
            </button>
          )}
          {unconfirmedMetricCount > 0 && (
            <button
              type="button"
              onClick={() =>
                onUpdateFactBase({
                  ...factBase,
                  experiences: factBase.experiences.map((exp) => ({
                    ...exp,
                    claims: exp.claims.map((c) => (c.metric ? { ...c, metric: { ...c.metric, confirmed: true } } : c)),
                  })),
                })
              }
              className="rounded-md border border-emerald-600 bg-white px-2.5 py-1 font-semibold text-emerald-800 hover:bg-emerald-100"
            >
              {t(`✓ 核实并展示全部业绩指标（${unconfirmedMetricCount} 项）`, `✓ Confirm & show all metrics (${unconfirmedMetricCount})`)}
            </button>
          )}
        </div>
      )}
      {source.unparsedLines.length > 0 && <section aria-label={t("待补录原文", "Source text to review")}>
        <p className="font-semibold text-amber-800">{t("以下内容尚未成为结构化事实，请对照原文件核对后补录；标有“AI 部分提取”的片段是模型输出，需要另行核实。", "This content is not yet structured into facts. Check the original file before adding it. Segments marked AI partial extraction are model output and require separate verification.")}</p>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-amber-200 bg-amber-50 p-3">{source.unparsedLines.join("\n")}</pre>
      </section>}
      <details><summary className="cursor-pointer">{t("展开完整提取原文", "Expand all extracted source text")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3">{source.rawText}</pre></details>
      {source.ocrText && <details><summary className="cursor-pointer">{t("视觉模型转录（未核实，请对照原图）", "Visual model transcription (unverified; compare with the original image)")}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3">{source.ocrText}</pre></details>}
      <button type="button" onClick={downloadSource} className="rounded border border-slate-200 px-3 py-1.5 font-medium">{t("下载导入原文", "Download imported source text")}</button>
    </div>
  </details>;
}
