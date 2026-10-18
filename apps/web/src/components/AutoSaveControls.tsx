import { useUiPreferences } from "../lib/ui-preferences";
import { useEffect, useId, useRef, useState } from "react";
import type { AutoSaveSettings } from "@better-me/storage";
import { Check, ChevronDown, Save, Settings2, X } from "lucide-react";
import "./autosave-controls.css";

type Props = {
  settings: AutoSaveSettings;
  onChange: (settings: AutoSaveSettings) => void;
  onSave: () => void;
  saving?: boolean;
  preferenceError?: string;
};

type SecondsFieldProps = {
  label: string;
  valueMs: number;
  min: number;
  max: number;
  onCommit: (valueMs: number) => void;
};

function SecondsField({ label, valueMs, min, max, onCommit }: SecondsFieldProps) {
  const { t } = useUiPreferences();

  const [text, setText] = useState(String(valueMs / 1000));
  useEffect(() => { setText(String(valueMs / 1000)); }, [valueMs]);
  const commit = () => {
    const parsed = text.trim() ? Number(text) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      setText(String(valueMs / 1000));
      return;
    }
    const seconds = Math.min(max, Math.max(min, Math.round(parsed)));
    setText(String(seconds));
    if (seconds * 1000 !== valueMs) onCommit(seconds * 1000);
  };
  return (
    <label className="autosave-setting-field autosave-seconds-field">
      <span>{label}</span>
      <span className="autosave-seconds-input">
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          aria-label={label}
        />
        <span>{t("秒", "seconds")}</span>
      </span>
      <small>{min}–{max} {t(" 秒，回车或离开后应用", "seconds; press Enter or leave to apply")}</small>
    </label>
  );
}

export function AutoSaveControls({ settings, onChange, onSave, saving = false, preferenceError }: Props) {
  const { t } = useUiPreferences();

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      settingsButtonRef.current?.focus();
    };
    document.addEventListener("click", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="autosave-controls" ref={rootRef}>
      <div className="autosave-control-group">
        <button
          type="button"
          className={`autosave-switch ${settings.enabled ? "is-on" : ""}`}
          role="switch"
          aria-label={t("自动保存", "Autosave")}
          aria-checked={settings.enabled}
          title={settings.enabled ? t("关闭自动保存完整版本，草稿保护仍启用", "Turn off complete-version autosave; draft protection stays enabled") : t("开启自动保存完整版本", "Enable complete-version autosave")}
          onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
        >
          <span className="autosave-switch-track" aria-hidden="true"><span>{settings.enabled && <Check size={9} strokeWidth={3} />}</span></span>
          <span>{t("自动保存", "Autosave")}</span>
          <small>{settings.enabled ? t("已开启", "On") : t("已关闭", "Off")}</small>
        </button>
        <button
          type="button"
          className="autosave-settings-button"
          ref={settingsButtonRef}
          aria-label={t("自动保存设置", "Autosave settings")}
          aria-expanded={open}
          aria-controls={panelId}
          aria-haspopup="dialog"
          title={t("设置自动保存条件", "Choose autosave conditions")}
          onClick={() => setOpen((previous) => !previous)}
        ><Settings2 size={13} /><ChevronDown size={10} className={open ? "is-open" : ""} /></button>
      </div>
      <button type="button" className="studio-button autosave-now" aria-label={t("立即保存", "Save now")} title={t("立即保存", "Save now")} onClick={onSave} disabled={saving}>
        <Save size={13} /><span>{saving ? t("正在保存", "Saving") : t("立即保存", "Save now")}</span>
      </button>
      {open && (
        <section className="autosave-popover" id={panelId} role="dialog" aria-labelledby={titleId}>
          <div className="autosave-popover-heading">
            <div><span className="autosave-eyebrow">{t("按你的节奏保存", "Save at your pace")}</span><h2 id={titleId}>{t("自动保存设置", "Autosave settings")}</h2></div>
            <button type="button" className="autosave-close" aria-label={t("关闭自动保存设置", "Close autosave settings")} onClick={() => { setOpen(false); settingsButtonRef.current?.focus(); }}><X size={15} /></button>
          </div>
          <label className="autosave-setting-field">
            <span>{t("何时保存完整版本", "When to save a complete version")}</span>
            <select
              aria-label={t("自动保存触发条件", "Autosave trigger")}
              value={settings.trigger}
              onChange={(event) => onChange({ ...settings, trigger: event.target.value as AutoSaveSettings["trigger"] })}
            >
              <option value="enter">{t("按下回车", "Press Enter")}</option>
              <option value="idle">{t("停止输入后", "After typing stops")}</option>
              <option value="blur">{t("离开编辑项", "Leave the edited field")}</option>
            </select>
            {settings.trigger === "enter" && <small>{t("输入框内回车保存；Shift+Enter 仅换行。输入法选词不会触发保存。", "Press Enter to save in a field; Shift+Enter adds a line break. IME composition does not trigger saving.")}</small>}
          </label>
          {settings.trigger === "idle" && <SecondsField label={t("停止输入多久后保存", "Save delay after typing stops")} valueMs={settings.delayMs} min={1} max={300} onCommit={(delayMs) => onChange({ ...settings, delayMs })} />}
          <SecondsField label={t("自动版本合并间隔", "Automatic version merge interval")} valueMs={settings.historyIntervalMs} min={15} max={600} onCommit={(historyIntervalMs) => onChange({ ...settings, historyIntervalMs })} />
          <div className="autosave-explanation">
            <p>{t("草稿保护始终启用，保留未完成编辑，不生成历史版本。满足所选条件后，才保存完整版本。", "Draft protection always keeps incomplete edits without creating history. Complete versions are saved when the selected condition is met.")}</p>
            <p>{t("间隔内的相邻自动版本合并为一版；手动命名的检查点独立保留。关闭自动保存后，仍可点「立即保存」。", "Adjacent automatic versions within the interval merge. Named checkpoints stay separate. Save now remains available when autosave is off.")}</p>
          </div>
          {!settings.enabled && <p className="autosave-paused">{t("自动保存已关闭，以上条件将在开启后生效。", "Autosave is off. These conditions apply when it is enabled.")}</p>}
          {preferenceError && <p className="autosave-preference-error" role="alert">{preferenceError}</p>}
        </section>
      )}
    </div>
  );
}
