/** @jsxRuntime automatic */
import { useMemo, useState } from "react";
import { Check, Compass, Crosshair, Download, Layers, Search, ShieldCheck, X } from "lucide-react";
import type { FactBase, ResumeView } from "@better-me/core";
import { useUiPreferences } from "../lib/ui-preferences";
import {
  buildSkillEvidenceGraph,
  toggleClaimInResumeView,
  toggleExperienceInResumeView,
  type LinkedExperienceEvidence,
} from "../lib/skill-evidence-graph";
import { Button, EmptyState, PageHeader, SegmentedControl, StatusPill } from "../design-system";

export interface SkillEvidenceAtlasProps {
  factBase: FactBase;
  view: ResumeView;
  onViewChange: (next: ResumeView) => void;
  onJumpToAnchor?: (anchor: string) => void;
  onExportInteractiveHtml?: () => void;
  onClose: () => void;
}

/**
 * Skill-to-Evidence Atlas:
 * - Zero-WebGL, instant-load CSS 3D tactile keycaps (100% DOM & Ctrl+F searchable)
 * - Dual-mode switch: Tactile Skill Keycap Deck | Chronological Field Report Atlas
 * - Direct toggle to include/exclude any experience or verified claim in the active resume view
 */
export function SkillEvidenceAtlas({
  factBase,
  view,
  onViewChange,
  onJumpToAnchor,
  onExportInteractiveHtml,
  onClose,
}: SkillEvidenceAtlasProps) {
  const { t, locale } = useUiPreferences();
  const [mode, setMode] = useState<"skills" | "timeline">("skills");
  const [query, setQuery] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [pressCount, setPressCount] = useState(0);

  const graph = useMemo(
    () => buildSkillEvidenceGraph(factBase, view, view.locale || locale),
    [factBase, view, locale],
  );

  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return graph.skills;
    return graph.skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.experiences.some(
          (e) =>
            e.org.toLowerCase().includes(q) ||
            e.title.toLowerCase().includes(q) ||
            e.claims.some((c) => c.text.toLowerCase().includes(q)),
        ),
    );
  }, [graph.skills, query]);

  const activeSkill =
    filteredSkills.find((s) => s.id === selectedSkillId) ?? filteredSkills[0] ?? null;

  const filteredTimeline = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return graph.timeline;
    return graph.timeline.filter(
      (e) =>
        e.org.toLowerCase().includes(q) ||
        e.title.toLowerCase().includes(q) ||
        e.techStack.some((tech) => tech.toLowerCase().includes(q)) ||
        e.claims.some((c) => c.text.toLowerCase().includes(q)),
    );
  }, [graph.timeline, query]);

  function renderExperienceCard(exp: LinkedExperienceEvidence) {
    return (
      <article key={exp.experienceId} className="bm-evidence-exp-card">
        <header className="bm-evidence-exp-head">
          <div className="min-w-0">
            <strong>{exp.org} · {exp.title}</strong>
            <small>{exp.period}</small>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              variant={exp.includedInResume ? "tinted" : "secondary"}
              size="xs"
              aria-pressed={exp.includedInResume}
              onClick={() => onViewChange(toggleExperienceInResumeView(factBase, view, exp.experienceId))}
            >
              {exp.includedInResume && <Check size={11} aria-hidden="true" />}
              {exp.includedInResume ? t("已写入简历", "In resume") : t("未选入", "Excluded")}
            </Button>
          </div>
        </header>
        {exp.claims.length > 0 && (
          <div className="bm-evidence-claims">
            {exp.claims.map((claim) => (
              <div key={claim.claimId} className="bm-evidence-claim-row" data-included={claim.includedInResume}>
                <input
                  type="checkbox"
                  checked={claim.includedInResume}
                  aria-label={t(`在当前简历中包含要点：${claim.text.slice(0, 24)}`, `Include claim in resume: ${claim.text.slice(0, 24)}`)}
                  onChange={() => onViewChange(toggleClaimInResumeView(factBase, view, exp.experienceId, claim.claimId))}
                  style={{ marginTop: 3 }}
                />
                <div className="bm-evidence-claim-copy">
                  <span>{claim.text}</span>
                  <div className="bm-evidence-claim-badges">
                    {claim.metric && (
                      <span className="bm-evidence-badge" data-tone={claim.metric.confirmed ? "verified" : "unverified"}>
                        <ShieldCheck size={10} aria-hidden="true" />
                        {claim.metric.confirmed
                          ? `${claim.metric.value}${claim.metric.unit}${claim.metric.baseline ? ` (${claim.metric.baseline})` : ""}`
                          : t("指标待核实（已过滤）", "Unverified metric (withheld)")}
                      </span>
                    )}
                    {onJumpToAnchor && (
                      <button
                        type="button"
                        className="bm-inline-bubble-btn"
                        onClick={() => {
                          onClose();
                          onJumpToAnchor(`claim:${claim.claimId}`);
                        }}
                      >
                        <Crosshair size={11} aria-hidden="true" />
                        {t("定位编辑", "Edit")}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </article>
    );
  }

  return (
    <div
      className="bm-atlas-modal-backdrop no-print"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="bm-atlas-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("个人职业能力与证据图谱", "Career Skill & Evidence Atlas")}
      >
        <PageHeader
          compact
          headingLevel={2}
          icon={<Compass size={16} />}
          title={t("个人职业能力与证据图谱", "Career Skill & Evidence Atlas")}
          description={t(
            "按下任意技能键帽，立即追溯它在哪些真实经历中得到证明，并一键勾选写入或移出当前简历视图。",
            "Press any skill keycap to inspect verified project evidence and toggle claims directly in your active resume.",
          )}
          meta={
            <StatusPill tone="accent">
              {t(
                `${graph.skills.length} 项能力 · ${graph.includedClaims}/${graph.totalClaims} 条要点已选入`,
                `${graph.skills.length} skills · ${graph.includedClaims}/${graph.totalClaims} claims in resume`,
              )}
            </StatusPill>
          }
          actions={
            <>
              {onExportInteractiveHtml && (
                <Button variant="tinted" size="sm" onClick={onExportInteractiveHtml}>
                  <Download size={13} aria-hidden="true" />
                  {t("导出双模式交互主页 (.html)", "Export Interactive Portfolio (.html)")}
                </Button>
              )}
              <Button variant="ghost" size="sm" iconOnly aria-label={t("关闭能力图谱", "Close skill atlas")} onClick={onClose}>
                <X size={15} />
              </Button>
            </>
          }
        />

        <div className="bm-atlas-toolbar">
          <label className="bm-atlas-search">
            <Search size={13} aria-hidden="true" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("搜索技能、公司或经历关键词…", "Filter skills, companies, or evidence…")}
              aria-label={t("搜索技能或证据", "Filter skills or evidence")}
            />
          </label>
          <SegmentedControl
            value={mode}
            ariaLabel={t("图谱浏览模式", "Atlas view mode")}
            options={[
              { value: "skills", label: t("触觉技能键帽", "Skill Keycaps") },
              { value: "timeline", label: t("档案时间轴", "Field Report Timeline") },
            ]}
            onChange={setMode}
          />
        </div>

        {mode === "skills" ? (
          <div className="bm-atlas-body" data-mode="skills">
            <div className="bm-keycap-deck-panel">
              <div className="bm-keycap-deck-head">
                <span>{t("点击或方向键切换技能键帽（纯 DOM 可搜索）", "Click any keycap to inspect evidence (100% searchable DOM)")}</span>
                <span className="bm-keycap-odometer" title={t("交互计数", "Keycap presses")}>
                  {String(pressCount).padStart(4, "0")}
                </span>
              </div>
              {filteredSkills.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Layers size={18} />}
                  title={t("暂无匹配的技能节点", "No matching skill nodes")}
                  description={t("在工作经历中补充技术栈标签或要点后，能力图谱会自动生成。", "Add tech stack tags or claims in your experiences to populate the atlas.")}
                />
              ) : (
                <div className="bm-keycap-grid" role="group" aria-label={t("技能键帽矩阵", "Skill keycap deck")}>
                  {filteredSkills.map((skill) => {
                    const active = activeSkill?.id === skill.id;
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        className="bm-keycap"
                        aria-pressed={active}
                        onClick={() => {
                          setSelectedSkillId(skill.id);
                          setPressCount((c) => c + 1);
                        }}
                      >
                        <span className="bm-keycap-name">{skill.name}</span>
                        <span className="bm-keycap-meta">
                          <span>{t(`${skill.experienceCount}段 · ${skill.claimCount}条`, `${skill.experienceCount}r · ${skill.claimCount}c`)}</span>
                          {skill.verifiedMetricCount > 0 && (
                            <span className="bm-keycap-metric-dot" title={t("已核实量化指标数", "Verified metrics")}>
                              ★{skill.verifiedMetricCount}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="bm-field-report" aria-live="polite">
              {activeSkill ? (
                <>
                  <div className="bm-field-report-head">
                    <div>
                      <h3>{activeSkill.name}</h3>
                      <small className="text-xs text-[var(--ui-text-secondary)]">
                        {t(
                          `在 ${activeSkill.experienceCount} 段经历中有 ${activeSkill.claimCount} 条实证（${activeSkill.includedClaimCount} 条已选入当前简历）`,
                          `Evidenced across ${activeSkill.experienceCount} role(s) and ${activeSkill.claimCount} claim(s) (${activeSkill.includedClaimCount} in resume)`,
                        )}
                      </small>
                    </div>
                  </div>
                  <div className="bm-field-report-list">
                    {activeSkill.experiences.map(renderExperienceCard)}
                  </div>
                </>
              ) : (
                <EmptyState
                  compact
                  title={t("选择左侧任意技能键帽", "Select a skill keycap")}
                  description={t("查看该项能力对应的真实项目证据，并决定是否投影到当前简历。", "Inspect linked evidence and decide what projects into your resume.")}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="bm-atlas-body" data-mode="timeline">
            <div className="bm-field-report">
              <div className="bm-field-report-head">
                <h3>{t("完整职业档案卡（Field Report）", "Complete Career Field Report")}</h3>
                <span className="text-xs text-[var(--ui-text-secondary)] tabular-nums">
                  {t(`${filteredTimeline.length} 段经历`, `${filteredTimeline.length} entries`)}
                </span>
              </div>
              <div className="bm-field-report-list">
                {filteredTimeline.map(renderExperienceCard)}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
