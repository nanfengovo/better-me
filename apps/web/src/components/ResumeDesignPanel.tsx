/** @jsxRuntime automatic */
import { useUiPreferences } from "../lib/ui-preferences";
import { useState } from "react";
import { ArrowDown, ArrowUp, Check, GripVertical, LayoutTemplate, Palette, SlidersHorizontal, Eye, ListChecks } from "lucide-react";
import { getResumeLayout, getResumeSectionOrder, isResumeProfileVisible, isResumeSectionVisible, pickLocale, type FactBase, type ResumeView, type ResumeSectionId, type ResumeProfileField, type ResumeLayout } from "@better-me/core";
import { RESUME_TEMPLATES, TEMPLATE_SOURCES, getResumeTemplate, getTemplateUiMetadata, resolveResumeTemplate, type TemplateSourceId } from "./template-catalog";
import { TemplateThumbnail } from "./TemplateThumbnail";

type Props = { view: ResumeView; factBase: FactBase; onChange: (view: ResumeView) => void };

const COLORS = ["#1b5147", "#293c58", "#69424c", "#7a613d", "#292929", "#0f5d65"];

function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  return <label className={`design-toggle${disabled ? " is-disabled" : ""}`}><span>{label}</span><input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} /><span className="design-switch" aria-hidden="true" /></label>;
}

export function ResumeDesignPanel({ view, factBase, onChange }: Props) {
  const { t, locale } = useUiPreferences();
  const SECTION_NAMES: Record<ResumeSectionId, string> = { summary: t("目标方向与优势", "Goals & strengths"), experience: t("工作经历", "Work experience"), projects: t("项目与作品", "Projects & portfolio"), skills: t("专业技能", "Skills"), education: t("教育背景", "Education"), custom: t("自定义", "Custom") };
  const PROFILE_FIELDS: { field: ResumeProfileField; label: string }[] = [
    { field: "photo", label: t("个人照片", "Photo") }, { field: "headline", label: t("职业定位", "Headline") }, { field: "education", label: t("抬头中的学历", "Education in header") },
    { field: "location", label: t("所在城市", "Location") }, { field: "email", label: t("电子邮箱", "Email") }, { field: "phone", label: t("联系电话", "Phone") },
    { field: "links", label: t("作品与社交链接", "Portfolio & social links") }, { field: "targetRoles", label: t("目标岗位", "Target roles") }, { field: "traits", label: t("核心优势", "Strengths") },
  ];

  const [dragging, setDragging] = useState<ResumeSectionId | null>(null);
  const [templateSource, setTemplateSource] = useState<"all" | TemplateSourceId>("all");
  const [templateSearch, setTemplateSearch] = useState("");
  const [templatePage, setTemplatePage] = useState(0);
  const selectedTemplateId = resolveResumeTemplate(view.templateId);
  const selectedTemplate = getResumeTemplate(selectedTemplateId);
  const selectedMetadata = getTemplateUiMetadata(selectedTemplateId, locale);
  const query = templateSearch.trim().toLocaleLowerCase();
  const matchingTemplates = RESUME_TEMPLATES.filter((template) => (templateSource === "all" || template.source === templateSource) && (!query || [template.id, template.name, template.tag, template.en.name, template.en.tag, template.source].some((text) => text.toLocaleLowerCase().includes(query))));
  const pageSize = 12;
  const pageCount = Math.max(1, Math.ceil(matchingTemplates.length / pageSize));
  const currentPage = Math.min(templatePage, pageCount - 1);
  const visibleTemplates = matchingTemplates.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const filterSource = (source: "all" | TemplateSourceId) => { setTemplateSource(source); setTemplatePage(0); };
  const layout = getResumeLayout(view.layout);
  const order: ResumeSectionId[] = getResumeSectionOrder(view.sectionOrder).filter((section) => section !== "custom");
  const change = (patch: Partial<ResumeView>) => onChange({ ...view, ...patch, updatedAt: new Date().toISOString() });
  const layoutChange = (patch: Partial<ResumeLayout>) => change({ layout: { ...view.layout, ...patch } });
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
    { field: "bodyFontSize", label: t("正文字号", "Body font size"), min: 8, max: 14, step: .5, unit: "pt" },
    { field: "nameFontSize", label: t("姓名字号", "Name font size"), min: 20, max: 40, step: 1, unit: "pt" },
    { field: "headingFontSize", label: t("分节字号", "Section heading size"), min: 10, max: 17, step: .5, unit: "pt" },
    { field: "lineHeight", label: t("行间距", "Line height"), min: 1.2, max: 2, step: .05, unit: t("倍", "×") },
    { field: "sectionSpacing", label: t("分节间距", "Section spacing"), min: 12, max: 36, step: 1, unit: "px" },
    { field: "pageMargin", label: t("页面边距", "Page margin"), min: 12, max: 28, step: 1, unit: "mm" },
  ];

  return <div className="resume-design-panel">
    <div className="design-intro"><span className="design-eyebrow">{t("为你而排", "MAKE IT YOURS")}</span><h2>{t("让优势先被看见。", "Make your strengths stand out.")}</h2><p>{t("选择版式，调整顺序，只展示这次投递需要的信息。", "Choose a layout, arrange sections and show what matters for this application.")}</p></div>
    <section className="design-card template-library"><div className="design-card-title"><LayoutTemplate size={17} /><h3>{t("模板库", "Template library")}</h3><span className="design-count">{RESUME_TEMPLATES.length} {t("套版式", "LAYOUTS")}</span></div>
      <p className="template-library-caption">{t("为你的下一程，选一份好版式。", "A considered layout for your next chapter.")}</p>
      <div className="template-source-filters" role="group" aria-label={t("筛选模板来源", "Filter template sources")}>
        <button type="button" aria-pressed={templateSource === "all"} onClick={() => filterSource("all")}>{t("全部", "All")}<span>{RESUME_TEMPLATES.length}</span></button>
        {TEMPLATE_SOURCES.map((source) => <button key={source.id} type="button" aria-pressed={templateSource === source.id} onClick={() => filterSource(source.id)}>{source[locale]}<span>{RESUME_TEMPLATES.filter((template) => template.source === source.id).length}</span></button>)}
      </div>
      <label className="template-search"><span>{t("查找版式", "Find a layout")}</span><input type="search" value={templateSearch} placeholder={t("按名称、来源或风格查找", "Search name, source or style")} onChange={(event) => { setTemplateSearch(event.target.value); setTemplatePage(0); }} /></label>
      <div className="template-selection-details" aria-label={t("当前模板", "Selected template")}>
        <div><strong>{selectedMetadata.name}</strong><span>{selectedTemplate.source === "original" ? t("BetterMe 自研", "BetterMe original") : `${t("来源原生适配", "Native source adaptation")} · ${selectedTemplate.licenseLabel ?? "MIT"}`}</span></div>
        <p>{selectedMetadata.description}</p>
        {selectedTemplate.usageRestriction && <p className="template-license-restriction">{selectedTemplate.usageRestriction[locale]}</p>}
        <div className="template-selection-actions"><button type="button" onClick={() => layoutChange(selectedTemplate.recommended)}>{t("采用推荐配色与字形", "Use recommended color & type")}</button>{selectedTemplate.upstreamUrl && <a href={selectedTemplate.upstreamUrl} target="_blank" rel="noreferrer">{t("上游源码 ↗", "Upstream source ↗")}</a>}</div>
      </div>
      <div className="template-gallery">{visibleTemplates.map((template) => {
        const metadata = getTemplateUiMetadata(template.id, locale);
        const definition = getResumeTemplate(template.id);
        const selected = view.templateId === template.id;
        return <button type="button" key={template.id} data-template-choice={template.id} className={`template-card${selected ? " is-selected" : ""}`} onClick={() => change({ templateId: template.id })} aria-pressed={selected} aria-label={`${metadata.name} ${template.label} · ${metadata.tag}`} title={metadata.description}>
          <span className="template-card-stage"><span className="template-card-index" aria-hidden="true">{String(RESUME_TEMPLATES.findIndex((item) => item.id === template.id) + 1).padStart(2, "0")}</span><TemplateThumbnail id={template.id} locale={locale} /><span className="template-card-status" aria-hidden="true">{selected && <Check size={12} strokeWidth={2.6} />}</span></span>
          <span className="template-card-info"><span className="template-card-name">{metadata.name}</span><span className="template-card-label">{template.label} · {metadata.tag}</span>{definition.usageRestriction && <span className="template-license-restriction">{definition.usageRestriction[locale]}</span>}<span className="template-card-origin">{template.source === "original" ? t("自研", "Original") : (definition.licenseLabel ?? "MIT") + " · " + TEMPLATE_SOURCES.find((source) => source.id === template.source)!.name}</span></span>
        </button>;
      })}</div>
      {matchingTemplates.length === 0 && <p className="template-empty" role="status">{t("没有匹配的版式，试试其他关键词或来源。", "No matching layouts. Try another search or source.")}</p>}
      <div className="template-pagination"><span role="status">{t(`共 ${matchingTemplates.length} 套 · 第 ${currentPage + 1} / ${pageCount} 页`, `${matchingTemplates.length} layouts · Page ${currentPage + 1} of ${pageCount}`)}</span><button type="button" disabled={currentPage === 0} onClick={() => setTemplatePage(currentPage - 1)}>{t("上一页", "Previous")}</button><button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => setTemplatePage(currentPage + 1)}>{t("下一页", "Next")}</button></div>
      <p className="design-help">{t("切换保留事实、分节顺序与设计参数。缩略图使用推荐配色与字形；开源适配版使用系统字体，PDF 采用当前网页排版。", "Switching preserves facts, section order and design settings. Thumbnails use recommended color and type. Adaptations use system fonts; PDF follows the current web layout.")}</p>
    </section>


    <section className="design-card"><div className="design-card-title"><GripVertical size={17} /><h3>{t("内容顺序", "Section order")}</h3><span className="design-count">{t("拖动 / 上下移动", "Drag / move up or down")}</span></div>
      <p className="design-help">{t("工作经历可以放在最前，教育背景可以放到最后或隐藏。", "Put work experience first, move education later or hide it.")}</p>
      <div className="design-section-list">{order.map((section, index) => <div className={`design-section-row${dragging === section ? " is-dragging" : ""}`} key={section} draggable onDragStart={(event) => { setDragging(section); event.dataTransfer.setData("text/plain", section); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); if (dragging && dragging !== section) move(dragging, index); setDragging(null); }} onDragEnd={() => setDragging(null)}>
        <GripVertical size={15} className="design-grip" aria-hidden="true" /><span className="design-section-number">0{index + 1}</span><span className="design-section-name">{SECTION_NAMES[section]}</span>
        <button type="button" aria-label={t(`${SECTION_NAMES[section]}上移`, `Move ${SECTION_NAMES[section]} up`)} disabled={index === 0} onClick={() => move(section, index - 1)}><ArrowUp size={13} /></button><button type="button" aria-label={t(`${SECTION_NAMES[section]}下移`, `Move ${SECTION_NAMES[section]} down`)} disabled={index === order.length - 1} onClick={() => move(section, index + 1)}><ArrowDown size={13} /></button>
        <label className="design-section-visible"><input type="checkbox" checked={isResumeSectionVisible(view, section)} aria-label={t(`显示${SECTION_NAMES[section]}`, `Show ${SECTION_NAMES[section]}`)} onChange={() => change({ sectionVisibility: { ...view.sectionVisibility, [section]: !isResumeSectionVisible(view, section) } })} /></label>
      </div>)}</div>
    </section>

    <section className="design-card"><div className="design-card-title"><Eye size={17} /><h3>{t("个人信息开关", "Personal information visibility")}</h3></div>
      <div className="design-presets"><button type="button" onClick={() => change({ profileVisibility: { ...view.profileVisibility, photo: true, education: false } })}>{t("国内投递 · 可带照片", "Domestic applications · photo optional")}</button><button type="button" onClick={() => change({ profileVisibility: { ...view.profileVisibility, photo: false, education: false } })}>{t("海外投递 · 不带照片", "International applications · no photo")}</button></div>
      <div className="design-toggle-grid">{PROFILE_FIELDS.map(({ field, label }) => <Toggle key={field} label={label} checked={field === "photo" && view.templateId === "en-ats" ? false : isResumeProfileVisible(view, field)} disabled={field === "photo" && view.templateId === "en-ats"} onChange={() => change({ profileVisibility: { ...view.profileVisibility, [field]: !isResumeProfileVisible(view, field) } })} />)}</div>
      <p className="design-help">{t("抬头学历与「教育背景」分节独立控制。ATS 模板固定不显示照片；开关控制已有内容，不会补造信息。", "Header education and the Education section are independent. ATS always hides photos. Toggles only control existing information.")}</p>
    </section>

    <section className="design-card"><div className="design-card-title"><Palette size={17} /><h3>{t("字形与留白", "Typography & spacing")}</h3><SlidersHorizontal size={15} className="design-title-end" /></div>
      <div className="design-color-row"><span>{t("主题色", "Accent color")}</span><div className="design-swatches">{COLORS.map((color) => <button key={color} type="button" style={{ backgroundColor: color }} aria-label={t(`主题色 ${color}`, `Accent color ${color}`)} aria-pressed={layout.accentColor === color} onClick={() => layoutChange({ accentColor: color })}>{layout.accentColor === color && <Check size={12} />}</button>)}<input type="color" value={layout.accentColor} aria-label={t("自定义主题色", "Custom accent color")} onChange={(event) => layoutChange({ accentColor: event.target.value })} /></div></div>
      <label className="design-font-row"><span>{t("字体风格", "Font style")}</span><select value={layout.fontFamily} onChange={(event) => layoutChange({ fontFamily: event.target.value as ResumeLayout["fontFamily"] })}><option value="sans">{t("现代无衬线", "Modern sans serif")}</option><option value="serif">{t("书刊衬线", "Editorial serif")}</option><option value="mono">{t("技术等宽", "Technical monospace")}</option></select></label>
      <div className="design-sliders">{sliders.map(({ field, label, min, max, step, unit }) => <label className="design-slider" key={field}><span>{label}<output>{typeof layout[field] === "number" ? Number((layout[field] as number).toFixed(2)) : layout[field]} {unit}</output></span><input type="range" min={min} max={max} step={step} value={layout[field] as number} onChange={(event) => layoutChange({ [field]: Number(event.target.value) })} /></label>)}</div>
      <p className="design-help">{t("文字编辑时选中片段，可加粗、斜体、下划线、高亮和放大。字号与边距影响预览和 PDF；Markdown 保留结构与强调。", "Select text to apply bold, italics, underline, highlight or size. Font size and margins affect preview and PDF; Markdown preserves structure and emphasis.")}</p>
    </section>

    <section className="design-card"><div className="design-card-title"><ListChecks size={17} /><h3>{t("选择经历与要点", "Choose experiences & entries")}</h3></div><p className="design-help">{t("隐藏仅影响这份简历，事实库仍保留完整内容。", "Hiding affects this resume only. The fact base keeps all content.")}</p>
      {factBase.experiences.length === 0 ? <p className="design-empty">{t("先在「内容」中添加经历，再选择本次投递需要的部分。", "Add experience in Content, then choose what to include in this application.")}</p> : <div className="design-fact-list">{factBase.experiences.map((experience) => {
        const included = allExperiences || view.includedExperienceIds.includes(experience.id);
        return <details className="design-experience-select" key={experience.id}><summary><input type="checkbox" checked={included} aria-label={t(`包含经历 ${pickLocale(experience.org, view.locale)}`, `Include experience ${pickLocale(experience.org, view.locale)}`)} onClick={(event) => event.stopPropagation()} onChange={() => toggleExperience(experience.id)} /><span>{pickLocale(experience.org, view.locale) || t("未命名经历", "Untitled experience")}<small>{pickLocale(experience.title, view.locale)} · {experience.start || t("日期待补", "Date not entered")}</small></span><span className="design-claim-count">{experience.claims.length} {t(" 条", "entries")}</span></summary><div className="design-claim-select-list">
          {experience.claims.filter((claim) => claim.kind !== "pitfall" && claim.kind !== "interview").map((claim) => <label key={claim.id}><input type="checkbox" checked={allClaims || view.includedClaimIds.includes(claim.id)} disabled={!included} onChange={() => toggleClaim(claim.id)} /><span>{pickLocale(claim.text, view.locale) || t("未填写要点", "Entry not entered")}{claim.metric && !claim.metric.confirmed && <small>{t("量化待核实，暂不输出", "Metric unverified; excluded from output")}</small>}</span></label>)}
          {experience.claims.length === 0 && <p className="design-empty">{t("这段经历暂无事实要点。", "This experience has no fact entries yet.")}</p>}
        </div></details>;
      })}</div>}
    </section>
  </div>;
}

export { getTemplateUiMetadata } from "./template-catalog";
