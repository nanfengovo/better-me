/** @jsxRuntime automatic */
import type { CSSProperties } from "react";
import { Check, Palette } from "lucide-react";
import { RESUME_THEMES, getResumeTheme, resolveResumeTheme, type ResumeView } from "@better-me/core";
import { useUiPreferences } from "../lib/ui-preferences";
import { getResumeThemeCompatibility, recommendedResumeTheme } from "./resume-theme-compatibility";

type Props = { view: ResumeView; onChange: (patch: Partial<ResumeView>) => void };

export function ResumeThemePanel({ view, onChange }: Props) {
  const { t, locale } = useUiPreferences();
  const resolved = resolveResumeTheme(view);
  const compatibility = getResumeThemeCompatibility(view.templateId);
  const overrides = view.layout?.accentColor !== undefined || view.layout?.fontFamily !== undefined || Boolean(view.themeOverrides);
  const knownTheme = RESUME_THEMES.some((theme) => theme.id === view.themeId);
  const recommended = getResumeTheme(recommendedResumeTheme(view.templateId));
  const useThemeDefaults = () => {
    const layout = { ...view.layout };
    delete layout.accentColor;
    delete layout.fontFamily;
    onChange({ layout, themeOverrides: view.themeOverrides?.decoration ? { decoration: view.themeOverrides.decoration } : undefined });
  };

  return <section className="design-card resume-theme-panel" aria-label={t("简历主题", "Resume themes")}>
    <div className="design-card-title"><Palette size={17} /><h3>{t("简历主题", "Resume themes")}</h3><span className="design-count">{RESUME_THEMES.length} {t("种风格", "STYLES")}</span></div>
    <p className="design-help">{t("版式决定怎么排，主题决定纸张、配色与字形。网页外观单独设置。", "Layouts arrange your content. Themes set paper, colors and type. Workspace appearance is separate.")}</p>
    <div className="resume-theme-actions">
      <button type="button" aria-pressed={!view.themeId} onClick={() => onChange({ themeId: undefined, themeOverrides: undefined })}>{t("沿用模板风格", "Use template styling")}</button>
      <button type="button" onClick={() => onChange({ themeId: recommended.id })}>{t(`推荐：${recommended.name.zh}`, `Suggested: ${recommended.name.en}`)}</button>
    </div>
    <div className="resume-theme-gallery" role="group" aria-label={t("选择简历主题", "Choose a resume theme")}>
      {RESUME_THEMES.map((theme) => {
        const selected = Boolean(view.themeId) && resolved.id === theme.id;
        const colors = theme.tokens.colors;
        const style = { "--theme-card-paper": colors.paper, "--theme-card-ink": colors.text, "--theme-card-muted": colors.muted, "--theme-card-accent": colors.accent, "--theme-card-soft": colors.accentSoft, "--theme-card-rule": colors.rule } as CSSProperties;
        return <button type="button" key={theme.id} className="resume-theme-choice" style={style} data-resume-theme-choice={theme.id} aria-pressed={selected} title={theme.description[locale]} onClick={() => onChange({ themeId: theme.id })}>
          <span className={`resume-theme-sample theme-sample-${theme.tokens.typography.bodyFamily}`} aria-hidden="true"><span className="resume-theme-sample-name">{t("你的名字", "Your name")}<span>{selected && <Check size={13} />}</span></span><span className="resume-theme-sample-role">{t("让每一份经历有光", "Experience, considered.")}</span><span className="resume-theme-sample-rule" /><span className="resume-theme-sample-lines"><i /><i /></span><span className="resume-theme-sample-tags"><i /><i /><i /></span></span>
          <span className="resume-theme-choice-title">{theme.name[locale]}</span><span className="resume-theme-choice-description">{theme.description[locale]}</span>
        </button>;
      })}
    </div>
    {view.themeId && <div className="resume-theme-current" role="status"><strong>{t("当前主题：", "Current theme: ")}{getResumeTheme(view.themeId).name[locale]}</strong>
      {!knownTheme && <p>{t("备份中的主题暂不可用，先以墨绿主题显示；原选择仍保留。", "The saved theme is unavailable. Forest is displayed while your original choice is retained.")}</p>}
      {overrides && <p>{t("保留了你手动设置的配色或字形。", "Your custom color or type settings are retained.")} <button type="button" onClick={useThemeDefaults}>{t("采用主题原始配色与字形", "Use theme color & type defaults")}</button></p>}
      <p>{compatibility.decoration === "full" ? t("此版式支持主题配色、字体、标题和标签装饰。", "This layout supports theme colors, type, headings and tags.") : t("此版式应用主题配色与字体，保留原有标题和标签装饰。", "This layout uses theme colors and type while retaining its own heading and tag ornaments.")}</p>
    </div>}
    <p className="design-help">{t("切换主题会保留字号、间距、边距和所有内容；PDF 沿用纸面主题，Word 保留可映射的样式。", "Switching themes keeps sizes, spacing, margins and content. PDF uses the paper theme; Word keeps supported styles.")}</p>
  </section>;
}
