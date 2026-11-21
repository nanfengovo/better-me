/** @jsxRuntime automatic */
import { useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, ArrowLeft, CheckCircle2, FileSearch, RotateCcw, ShieldCheck, Sparkles, X } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import { DEMO_ATS_SAMPLE, diagnoseAtsResume } from "../lib/ats-diagnostics";
import { Button, EmptyState, PageHeader, StatusPill } from "../design-system";
import "./public-showcase.css";

export interface AtsDiagnosticToolProps {
  /** Pre-populated resume plain text (e.g. from the active Resume Studio document). */
  initialResumeText?: string;
  /** Optional target JD text. */
  initialJdText?: string;
  /** Standalone full-page route (`?view=ats`) vs embedded inside Landing or modal. */
  standalone?: boolean;
  /** Optional handler to jump into the full Agent OS workspace. */
  onOpenStudio?: () => void;
  /** Optional handler to close when rendered inside an in-app modal. */
  onClose?: () => void;
}

export function AtsDiagnosticTool({
  initialResumeText = "",
  initialJdText = "",
  standalone = false,
  onOpenStudio,
  onClose,
}: AtsDiagnosticToolProps) {
  const { t, locale, setLocale, theme, setTheme } = useUiPreferences();
  const [resumeText, setResumeText] = useState(initialResumeText);
  const [jdText, setJdText] = useState(initialJdText);

  const report = useMemo(
    () => diagnoseAtsResume({ resumeText, jdText }),
    [resumeText, jdText],
  );

  const isEn = locale === "en";
  const ringRadius = 32;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringOffset = ringCircumference * (1 - Math.max(0, Math.min(100, report.overallScore)) / 100);
  const scoreTone = report.overallScore >= 80 ? "accent" : report.overallScore >= 60 ? "warn" : "danger";

  function loadDemo() {
    const sample = isEn ? DEMO_ATS_SAMPLE.en : DEMO_ATS_SAMPLE.zh;
    setResumeText(sample.resumeText);
    setJdText(sample.jdText);
  }

  function loadActiveResume() {
    if (initialResumeText) setResumeText(initialResumeText);
  }

  const body = (
    <div className="bm-ats-tool">
      <PageHeader
        compact={!standalone}
        headingLevel={standalone ? 1 : 2}
        icon={<FileSearch size={standalone ? 18 : 15} />}
        eyebrow={standalone ? "ZERO-AUTH · LOCAL DETERMINISTIC ATS CHECKER" : undefined}
        title={t("ATS 纯文本与 JD 匹配诊断", "Zero-Auth ATS & JD Diagnostics")}
        description={t(
          "100% 浏览器本地确定性计算，无需登录或配置 API Key；即时检查分节完整性、日期一致性、量化密度、写作套话与 JD 关键词缺口。",
          "100% browser-local deterministic analysis — no login or API key. Checks section structure, date consistency, quantified impact, writing craft, and JD keyword gaps.",
        )}
        meta={
          <StatusPill tone="accent">
            <ShieldCheck size={11} aria-hidden="true" />
            {t("文本绝不离开本机", "Never leaves your device")}
          </StatusPill>
        }
        actions={
          <>
            {standalone && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setLocale(isEn ? "zh" : "en")}>
                  {isEn ? "中文" : "EN"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
                  {theme === "dark" ? t("浅色", "Light") : t("深色", "Dark")}
                </Button>
              </>
            )}
            {onOpenStudio && (
              <Button variant="primary" size="sm" onClick={onOpenStudio}>
                <ArrowLeft size={13} aria-hidden="true" />
                {t("打开 Agent OS 工作台", "Open Agent OS")}
              </Button>
            )}
            {onClose && (
              <Button variant="ghost" size="sm" iconOnly aria-label={t("关闭诊断窗口", "Close diagnostics")} onClick={onClose}>
                <X size={15} />
              </Button>
            )}
          </>
        }
      />

      <div className="bm-ats-tool-grid">
        {/* Left: Input column */}
        <div className="bm-ats-card">
          <div className="bm-ats-field-head">
            <label htmlFor="bm-ats-resume-input">{t("简历纯文本（或从 PDF 复制的文本）", "Resume plain text (or text copied from PDF)")}</label>
            <div className="flex flex-wrap items-center gap-1.5">
              {initialResumeText && resumeText !== initialResumeText && (
                <Button variant="tinted" size="xs" onClick={loadActiveResume}>
                  {t("载入当前简历", "Load active resume")}
                </Button>
              )}
              <Button variant="secondary" size="xs" onClick={loadDemo}>
                <Sparkles size={12} aria-hidden="true" />
                {t("载入示例", "Load demo")}
              </Button>
              {(resumeText || jdText) && (
                <Button variant="ghost" size="xs" onClick={() => { setResumeText(""); setJdText(""); }}>
                  <RotateCcw size={12} aria-hidden="true" />
                  {t("清空", "Clear")}
                </Button>
              )}
            </div>
          </div>
          <textarea
            id="bm-ats-resume-input"
            className="bm-ats-textarea"
            value={resumeText}
            onChange={(event) => setResumeText(event.target.value)}
            placeholder={t(
              "在此粘贴你的简历纯文本或 Markdown……\n例如：\n张明 · 高级前端工程师 | name@example.com\n工作经历\n- 设计并交付……",
              "Paste your plain-text or Markdown resume here…\nExample:\nAlex Chen · Senior Engineer | alex@example.com\nExperience\n- Designed and shipped…",
            )}
          />

          <div className="bm-ats-field-head">
            <label htmlFor="bm-ats-jd-input">{t("目标岗位 JD（可选，用于计算关键词覆盖与缺口）", "Target Job Description (optional, for keyword coverage & gaps)")}</label>
          </div>
          <textarea
            id="bm-ats-jd-input"
            className="bm-ats-textarea is-jd"
            value={jdText}
            onChange={(event) => setJdText(event.target.value)}
            placeholder={t(
              "粘贴岗位职责与任职要求，系统将提取核心技术词并标出已命中与真实缺口（不会替你编造技能）…",
              "Paste the job requirements to compare matched vs. missing keywords honestly…",
            )}
          />
        </div>

        {/* Right: Deterministic Score & Findings */}
        <div className="bm-ats-card" aria-live="polite">
          {!resumeText.trim() ? (
            <EmptyState
              compact
              icon={<FileSearch size={20} />}
              title={t("粘贴简历文本，即刻获得透明体检报告", "Paste resume text for an instant local check")}
              description={t(
                "所有规则均在浏览器内确定性执行，可点击「载入示例」体验完整的多维度诊断与 JD 关键词矩阵。",
                "Every check runs deterministically in your browser. Click Load demo to inspect a complete report.",
              )}
              actions={
                <Button variant="primary" size="sm" onClick={loadDemo}>
                  <Sparkles size={13} aria-hidden="true" />
                  {t("载入示例简历与 JD", "Load sample resume & JD")}
                </Button>
              }
            />
          ) : (
            <>
              <div className="bm-ats-score-hero">
                <div className="bm-ats-ring-wrap" aria-label={t(`ATS 综合评分 ${report.overallScore} 分`, `ATS score ${report.overallScore} of 100`)}>
                  <svg width="78" height="78" viewBox="0 0 78 78">
                    <circle
                      cx="39"
                      cy="39"
                      r={ringRadius}
                      fill="none"
                      stroke="var(--ui-surface-soft)"
                      strokeWidth="6"
                    />
                    <circle
                      cx="39"
                      cy="39"
                      r={ringRadius}
                      fill="none"
                      stroke={
                        scoreTone === "accent"
                          ? "var(--ui-accent)"
                          : scoreTone === "warn"
                            ? "var(--ui-warning)"
                            : "var(--ui-danger)"
                      }
                      strokeWidth="6"
                      strokeLinecap="round"
                      strokeDasharray={ringCircumference}
                      strokeDashoffset={ringOffset}
                      transform="rotate(-90 39 39)"
                    />
                  </svg>
                  <div className="bm-ats-ring-value">
                    <strong>{report.overallScore}</strong>
                    <small>/ 100</small>
                  </div>
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm font-semibold">{isEn ? report.verdict.en : report.verdict.zh}</strong>
                  </div>
                  <p className="text-xs text-[var(--ui-text-secondary)] tabular-nums">
                    {t(
                      `${report.charCount} 字符 · ${report.bulletCount} 条要点 · ${report.quantifiedBulletCount} 条含真实量化`,
                      `${report.charCount} chars · ${report.bulletCount} bullets · ${report.quantifiedBulletCount} quantified`,
                    )}
                  </p>
                </div>
              </div>

              {/* Dimension Breakdown */}
              <div className="bm-ats-dims">
                {report.dimensions.map((dim) => {
                  const tone = dim.score >= 75 ? "accent" : dim.score >= 50 ? "warn" : "critical";
                  return (
                    <div key={dim.id} className="bm-ats-dim-row">
                      <div className="bm-ats-dim-top">
                        <strong>{isEn ? dim.label.en : dim.label.zh}</strong>
                        <span>
                          {isEn ? dim.summary.en : dim.summary.zh} · {dim.score}%
                        </span>
                      </div>
                      <div className="bm-ats-dim-track">
                        <div className="bm-ats-dim-fill" data-tone={tone} style={{ width: `${dim.score}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* JD Keyword Coverage Matrix */}
              {(report.matchedKeywords.length > 0 || report.missingKeywords.length > 0) && (
                <div className="bm-ats-kw-group">
                  {report.matchedKeywords.length > 0 && (
                    <>
                      <span className="bm-ats-kw-title">
                        {t(`已命中 JD 关键词 (${report.matchedKeywords.length})`, `Matched JD keywords (${report.matchedKeywords.length})`)}
                      </span>
                      <div className="bm-ats-kw-chips">
                        {report.matchedKeywords.map((kw) => (
                          <span key={`m-${kw}`} className="bm-ats-chip" data-kind="matched">{kw}</span>
                        ))}
                      </div>
                    </>
                  )}
                  {report.missingKeywords.length > 0 && (
                    <>
                      <span className="bm-ats-kw-title" style={{ marginTop: 4 }}>
                        {t(
                          `尚未出现的 JD 词项 (${report.missingKeywords.length}) — 仅补充你真实具备的技能`,
                          `Not yet present (${report.missingKeywords.length}) — add only if genuinely verified`,
                        )}
                      </span>
                      <div className="bm-ats-kw-chips">
                        {report.missingKeywords.map((kw) => (
                          <span key={`g-${kw}`} className="bm-ats-chip" data-kind="missing">{kw}</span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Findings */}
              <div className="bm-ats-findings">
                {report.findings.map((finding) => (
                  <div key={finding.id} className="bm-ats-finding" data-severity={finding.severity}>
                    {finding.severity === "critical" ? (
                      <AlertCircle size={15} className="shrink-0 mt-0.5 text-[var(--ui-danger)]" aria-hidden="true" />
                    ) : finding.severity === "warn" ? (
                      <AlertTriangle size={15} className="shrink-0 mt-0.5 text-[var(--ui-warning)]" aria-hidden="true" />
                    ) : (
                      <CheckCircle2 size={15} className="shrink-0 mt-0.5 text-[var(--ui-accent)]" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">
                      <strong>{isEn ? finding.title.en : finding.title.zh}</strong>
                      <p>{isEn ? finding.detail.en : finding.detail.zh}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  if (standalone) {
    return (
      <div className="bm-public-page">
        <div className="bm-ats-tool-standalone">{body}</div>
      </div>
    );
  }

  return body;
}
