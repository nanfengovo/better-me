import { Languages, Moon, Sun } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import { WORKSPACE_THEMES, isWorkspaceThemeId } from "../themes/workspace-theme";

export function WorkspacePreferences() {
  const { locale, theme, workspaceThemeId, setLocale, setTheme, setWorkspaceThemeId, t, persistenceError } = useUiPreferences();
  return <div className="workspace-preferences">
    <div className="workspace-preference-group" role="group" aria-label={t("界面语言", "Interface language")} title={t("只切换工作台界面，简历语言单独设置", "Changes the workspace interface. Resume language is set separately.")}>
      <span className="workspace-preference-label"><Languages size={13} /><span>{t("界面", "UI")}</span></span>
      <button type="button" lang="zh-CN" aria-pressed={locale === "zh"} onClick={() => setLocale("zh")}>中文</button>
      <button type="button" lang="en" aria-label="English" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>EN</button>
    </div>
    <label className="workspace-preference-group workspace-theme-picker" title={t("工作台配色独立于简历主题，浅深模式单独切换", "Workspace colors are independent of resume themes. Choose light or dark separately.")}>
      <span className="workspace-theme-dot" aria-hidden="true" />
      <span className="sr-only">{t("工作台配色", "Workspace color palette")}</span>
      <select aria-label={t("工作台配色", "Workspace color palette")} value={workspaceThemeId} onChange={event => {
        if (isWorkspaceThemeId(event.target.value)) setWorkspaceThemeId(event.target.value);
      }}>
        {WORKSPACE_THEMES.map(item => <option value={item.id} key={item.id}>{item.name[locale]}</option>)}
      </select>
    </label>
    <div className="workspace-preference-group" role="group" aria-label={t("界面主题", "Workspace theme")} title={t("切换工作台明暗，简历纸张和导出配色保持不变", "Changes the workspace appearance. Resume paper and export colors stay the same.")}>
      <button type="button" aria-label={t("浅色主题", "Light theme")} aria-pressed={theme === "light"} onClick={() => setTheme("light")}><Sun size={14} /><span>{t("浅色", "Light")}</span></button>
      <button type="button" aria-label={t("深色主题", "Dark theme")} aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}><Moon size={14} /><span>{t("深色", "Dark")}</span></button>
    </div>
    {persistenceError && <span className="workspace-preference-error" role="status">{t("本次切换已生效，偏好未能保存", "Applied for this session; preferences could not be saved")}</span>}
  </div>;
}
