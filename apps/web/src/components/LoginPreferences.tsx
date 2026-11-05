import { Languages, Moon, Sun } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import "./login-global.css";

export function LoginPreferences() {
  const { locale, theme, setLocale, setTheme, t } = useUiPreferences();
  return <div className="login-preferences">
    <span className="login-preferences-brand">BETTERME / {t("工作空间", "WORKSPACE")}</span>
    <div className="login-preference-controls">
      <label className="login-language"><Languages size={15} aria-hidden="true" /><span className="sr-only">{t("界面语言", "Language")}</span><select aria-label={t("界面语言", "Language")} value={locale} onChange={event => setLocale(event.target.value as "zh" | "en")}><option value="zh">简体中文</option><option value="en">English</option></select></label>
      <button type="button" className="login-theme-button" aria-label={theme === "dark" ? t("切换浅色主题", "Switch to light theme") : t("切换深色主题", "Switch to dark theme")} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</button>
    </div>
  </div>;
}
