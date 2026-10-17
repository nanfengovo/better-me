/** @jsxRuntime automatic */
import { useState } from "react";
import { ArrowDown, ArrowUp, Check, GripVertical, LayoutTemplate, Palette, SlidersHorizontal, Eye, ListChecks } from "lucide-react";
import { getResumeLayout, getResumeSectionOrder, isResumeProfileVisible, isResumeSectionVisible, pickLocale, type FactBase, type ResumeView, type ResumeSectionId, type ResumeProfileField, type ResumeLayout } from "@better-me/core";
import { RESUME_TEMPLATES } from "./ResumeTemplate";

type Props = { view: ResumeView; factBase: FactBase; onChange: (view: ResumeView) => void };
const SECTION_NAMES: Record<ResumeSectionId, string> = { summary: "目标方向与优势", experience: "工作经历", projects: "项目与作品", skills: "专业技能", education: "教育背景", custom: "自定义" };
const PROFILE_FIELDS: { field: ResumeProfileField; label: string }[] = [
  { field: "photo", label: "个人照片" }, { field: "headline", label: "职业定位" }, { field: "education", label: "抬头中的学历" },
  { field: "location", label: "所在城市" }, { field: "email", label: "电子邮箱" }, { field: "phone", label: "联系电话" },
  { field: "links", label: "作品与社交链接" }, { field: "targetRoles", label: "目标岗位" }, { field: "traits", label: "核心优势" },
];
const COLORS = ["#1b5147", "#293c58", "#69424c", "#7a613d", "#292929", "#0f5d65"];

function TemplateMiniature({ id }: { id: string }) {
  return <span className={`template-mini template-mini-${id}`} aria-hidden="true"><span className="mini-header"><i /><i /><i /></span><span className="mini-sidebar"><i /><i /><i /><i /></span><span className="mini-body">{[0, 1, 2].map((i) => <span className="mini-section" key={i}><i /><i /><i /><i /></span>)}</span></span>;
}

function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  return <label className={`design-toggle${disabled ? " is-disabled" : ""}`}><span>{label}</span><input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} /><span className="design-switch" aria-hidden="true" /></label>;
}

export function ResumeDesignPanel({ view, factBase, onChange }: Props) {
  const [dragging, setDragging] = useState<ResumeSectionId | null>(null);
  const layout = getResumeLayout(view.layout);
  const order: ResumeSectionId[] = getResumeSectionOrder(view.sectionOrder).filter((section) => section !== "custom");
  const change = (patch: Partial<ResumeView>) => onChange({ ...view, ...patch, updatedAt: new Date().toISOString() });
  const layoutChange = (patch: Partial<ResumeLayout>) => change({ layout: { ...layout, ...patch } });
  const move = (section: ResumeSectionId, destination: number) => {
    const next = order.filter((id) => id !== section);
    next.splice(Math.max(0, Math.min(next.length, destination)), 0, section);
    change({ sectionOrder: next });
  };
  const allExperiences = view.experienceSelection === "all" || (!view.experienceSelection && !view.includedExperienceIds.length);
  const allClaims = view.claimSelection === "all" || (!view.claimSelection && !view.includedClaimIds.length);
  const toggleExperience = (id: string) => {
    const selected = new Set(allExperiences ? factBase.experiences.map((experience) => experience.id) : view.includedExperienceIds);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    change({ experienceSelection: "selected", includedExperienceIds: [...selected] });
  };
  const toggleClaim = (id: string) => {
    const selected = new Set(allClaims ? factBase.experiences.flatMap((experience) => experience.claims.map((claim) => claim.id)) : view.includedClaimIds);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    change({ claimSelection: "selected", includedClaimIds: [...selected] });
  };
  const sliders: { field: keyof ResumeLayout; label: string; min: number; max: number; step: number; unit: string }[] = [
    { field: "bodyFontSize", label: "正文字号", min: 8, max: 14, step: .5, unit: "pt" },
    { field: "nameFontSize", label: "姓名字号", min: 20, max: 40, step: 1, unit: "pt" },
    { field: "headingFontSize", label: "分节字号", min: 10, max: 17, step: .5, unit: "pt" },
    { field: "lineHeight", label: "行间距", min: 1.2, max: 2, step: .05, unit: "倍" },
    { field: "sectionSpacing", label: "分节间距", min: 12, max: 36, step: 1, unit: "px" },
    { field: "pageMargin", label: "页面边距", min: 12, max: 28, step: 1, unit: "mm" },
  ];

  return <div className="resume-design-panel">
    <div className="design-intro"><span className="design-eyebrow">MAKE IT YOURS</span><h2>让优势先被看见。</h2><p>选择版式，调整顺序，只展示这次投递需要的信息。</p></div>
    <section className="design-card"><div className="design-card-title"><LayoutTemplate size={17} /><h3>模板库</h3><span className="design-count">06 ORIGINALS</span></div>
      <div className="template-gallery">{RESUME_TEMPLATES.map((template) => <button type="button" key={template.id} className={`template-card${view.templateId === template.id ? " is-selected" : ""}`} onClick={() => change({ templateId: template.id })} aria-pressed={view.templateId === template.id} title={template.description}>
        <TemplateMiniature id={template.id} /><span className="template-card-name">{template.name}{view.templateId === template.id && <Check size={13} aria-hidden="true" />}</span><span className="template-card-label">{template.label} · {template.tag}</span>
      </button>)}</div><p className="design-help">每套模板采用独立排版。切换模板保留你的事实与显示设置。</p>
    </section>

    <section className="design-card"><div className="design-card-title"><GripVertical size={17} /><h3>内容顺序</h3><span className="design-count">拖动 / 上下移动</span></div>
      <p className="design-help">工作经历可以放在最前，教育背景可以放到最后或隐藏。</p>
      <div className="design-section-list">{order.map((section, index) => <div className={`design-section-row${dragging === section ? " is-dragging" : ""}`} key={section} draggable onDragStart={(event) => { setDragging(section); event.dataTransfer.setData("text/plain", section); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); if (dragging && dragging !== section) move(dragging, index); setDragging(null); }} onDragEnd={() => setDragging(null)}>
        <GripVertical size={15} className="design-grip" aria-hidden="true" /><span className="design-section-number">0{index + 1}</span><span className="design-section-name">{SECTION_NAMES[section]}</span>
        <button type="button" aria-label={`${SECTION_NAMES[section]}上移`} disabled={index === 0} onClick={() => move(section, index - 1)}><ArrowUp size={13} /></button><button type="button" aria-label={`${SECTION_NAMES[section]}下移`} disabled={index === order.length - 1} onClick={() => move(section, index + 1)}><ArrowDown size={13} /></button>
        <label className="design-section-visible"><input type="checkbox" checked={isResumeSectionVisible(view, section)} aria-label={`显示${SECTION_NAMES[section]}`} onChange={() => change({ sectionVisibility: { ...view.sectionVisibility, [section]: !isResumeSectionVisible(view, section) } })} /></label>
      </div>)}</div>
    </section>

    <section className="design-card"><div className="design-card-title"><Eye size={17} /><h3>个人信息开关</h3></div>
      <div className="design-presets"><button type="button" onClick={() => change({ profileVisibility: { ...view.profileVisibility, photo: true, education: false } })}>国内投递 · 可带照片</button><button type="button" onClick={() => change({ profileVisibility: { ...view.profileVisibility, photo: false, education: false } })}>海外投递 · 不带照片</button></div>
      <div className="design-toggle-grid">{PROFILE_FIELDS.map(({ field, label }) => <Toggle key={field} label={label} checked={field === "photo" && view.templateId === "en-ats" ? false : isResumeProfileVisible(view, field)} disabled={field === "photo" && view.templateId === "en-ats"} onChange={() => change({ profileVisibility: { ...view.profileVisibility, [field]: !isResumeProfileVisible(view, field) } })} />)}</div>
      <p className="design-help">抬头学历与「教育背景」分节独立控制。ATS 模板固定不显示照片；开关控制已有内容，不会补造信息。</p>
    </section>

    <section className="design-card"><div className="design-card-title"><Palette size={17} /><h3>字形与留白</h3><SlidersHorizontal size={15} className="design-title-end" /></div>
      <div className="design-color-row"><span>主题色</span><div className="design-swatches">{COLORS.map((color) => <button key={color} type="button" style={{ backgroundColor: color }} aria-label={`主题色 ${color}`} aria-pressed={layout.accentColor === color} onClick={() => layoutChange({ accentColor: color })}>{layout.accentColor === color && <Check size={12} />}</button>)}<input type="color" value={layout.accentColor} aria-label="自定义主题色" onChange={(event) => layoutChange({ accentColor: event.target.value })} /></div></div>
      <label className="design-font-row"><span>字体风格</span><select value={layout.fontFamily} onChange={(event) => layoutChange({ fontFamily: event.target.value as ResumeLayout["fontFamily"] })}><option value="sans">现代无衬线</option><option value="serif">书刊衬线</option><option value="mono">技术等宽</option></select></label>
      <div className="design-sliders">{sliders.map(({ field, label, min, max, step, unit }) => <label className="design-slider" key={field}><span>{label}<output>{typeof layout[field] === "number" ? Number((layout[field] as number).toFixed(2)) : layout[field]} {unit}</output></span><input type="range" min={min} max={max} step={step} value={layout[field] as number} onChange={(event) => layoutChange({ [field]: Number(event.target.value) })} /></label>)}</div>
      <p className="design-help">文字编辑时选中片段，可加粗、斜体、下划线、高亮和放大。字号与边距影响预览和 PDF；Markdown 保留结构与强调。</p>
    </section>

    <section className="design-card"><div className="design-card-title"><ListChecks size={17} /><h3>选择经历与要点</h3></div><p className="design-help">隐藏仅影响这份简历，事实库仍保留完整内容。</p>
      {factBase.experiences.length === 0 ? <p className="design-empty">先在「内容」中添加经历，再选择本次投递需要的部分。</p> : <div className="design-fact-list">{factBase.experiences.map((experience) => {
        const included = allExperiences || view.includedExperienceIds.includes(experience.id);
        return <details className="design-experience-select" key={experience.id}><summary><input type="checkbox" checked={included} aria-label={`包含经历 ${pickLocale(experience.org, view.locale)}`} onClick={(event) => event.stopPropagation()} onChange={() => toggleExperience(experience.id)} /><span>{pickLocale(experience.org, view.locale) || "未命名经历"}<small>{pickLocale(experience.title, view.locale)} · {experience.start || "日期待补"}</small></span><span className="design-claim-count">{experience.claims.length} 条</span></summary><div className="design-claim-select-list">
          {experience.claims.filter((claim) => claim.kind !== "pitfall" && claim.kind !== "interview").map((claim) => <label key={claim.id}><input type="checkbox" checked={allClaims || view.includedClaimIds.includes(claim.id)} disabled={!included} onChange={() => toggleClaim(claim.id)} /><span>{pickLocale(claim.text, view.locale) || "未填写要点"}{claim.metric && !claim.metric.confirmed && <small>量化待核实，暂不输出</small>}</span></label>)}
          {experience.claims.length === 0 && <p className="design-empty">这段经历暂无事实要点。</p>}
        </div></details>;
      })}</div>}
    </section>
  </div>;
}
