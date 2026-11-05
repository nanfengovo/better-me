import { useState } from "react";
import { LoginGlobe } from "./LoginGlobe";
import { useUiPreferences } from "../lib/ui-preferences";
import { ArrowUpRight, BriefcaseBusiness, Check, FileText, Layers3, Pause, Play, Sparkles } from "lucide-react";

const scenes = [
  { title: "让经历，成为你的优势。", subtitle: "梳理真实经历，打磨每一次表达。", icon: FileText, label: "简历创作", card: "从经历，到有说服力的表达", detail: "内容梳理 · 版式设计 · 版本管理", step: "整理经历" },
  { title: "让下一步，更有方向。", subtitle: "把岗位、要求与自己的优势放在一起看。", icon: BriefcaseBusiness, label: "发现机会", card: "找到与你同频的下一站", detail: "岗位收藏 · 要求对照 · 求职记录", step: "对照岗位" },
  { title: "你的目标，有一个搭档。", subtitle: "与 Agent 一起拆解任务，让每一步清晰可见。", icon: Sparkles, label: "Agent 协作", card: "你决定方向，Agent 协助推进", detail: "明确需求 · 工具协作 · 由你确认", step: "协作推进" },
];

export function LoginShowcase() {
  const { t, locale } = useUiPreferences();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const englishScenes = [
    { title: "Turn experience into your advantage.", subtitle: "Shape your real experience into a compelling story.", label: "Resume", card: "Experience, expressed with impact", detail: "Content · Layout · Versions", step: "Organize experience" },
    { title: "Give your next step direction.", subtitle: "Explore roles alongside your strengths and goals.", label: "Opportunities", card: "Find your next meaningful opportunity", detail: "Save roles · Compare requirements · Track progress", step: "Compare roles" },
    { title: "A partner for your ambitions.", subtitle: "Break down tasks together. Stay in control.", label: "Agent", card: "You lead. Your Agent supports.", detail: "Define goals · Use tools · Review decisions", step: "Work together" },
  ];
  const scene = { ...scenes[index]!, ...(locale === "en" ? englishScenes[index] : {}) };
  const Icon = scene.icon;
  return <aside className={`login-showcase${paused ? " is-paused" : ""}`} aria-label="BetterMe 产品展示">
    <div className="login-showcase-top"><span className="login-brand"><Layers3 size={23} strokeWidth={1.6} /> BetterMe<span className="login-brand-tag">{t("工作室", "STUDIO")}</span></span></div>
    <div className="login-story"><div className="login-eyebrow"><span /> {t("立足全球 · 连接你的下一站", "GLOBAL REACH · YOUR NEXT CHAPTER")}</div><h2>{t("世界很大，", "A world of possibility.")}<br /><span>{t("你的未来不设限。", "Your future, unbounded.")}</span></h2><p>{t("以全球视野，发现属于你的职业可能。", "Discover your next career opportunity with a global perspective.")}</p></div>
    <LoginGlobe paused={paused} />
    <div className="login-scene" key={index}>
      <div className="login-scene-chip"><span className="login-tool-icon"><Icon size={16} /></span><span>{scene.step}</span><Check size={13} /></div>
      <button type="button" className={`login-floating-card${detailsOpen ? " is-open" : ""}`} onClick={() => setDetailsOpen(value => !value)} aria-expanded={detailsOpen}><div className="login-card-top"><span><Icon size={16} /> {scene.label}</span><ArrowUpRight size={16} /></div><h3>{scene.card}</h3><p>{scene.detail}</p><div className="login-card-lines"><i /><i /><i /></div>{detailsOpen && <div className="login-card-detail"><span className="login-detail-pulse" /> {t("登录后，与 Agent 一起探索下一步", "Sign in to explore your next step with your Agent")}</div>}</button>
    </div>
    <div className="login-showcase-bottom"><div className="login-scene-copy" aria-live="polite"><strong>{scene.title}</strong><p>{scene.subtitle}</p></div><div className="login-scene-controls"><div className="login-scene-tabs" role="group" aria-label="切换产品场景">{scenes.map((item, i) => <button key={item.label} type="button" aria-pressed={index === i} onClick={() => setIndex(i)}>{t(item.label, englishScenes[i]!.label)}</button>)}</div><button type="button" className="login-motion-button" aria-label={paused ? "播放展示动效" : "暂停展示动效"} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? <Play size={14} /> : <Pause size={14} />}</button></div></div>
  </aside>;
}
