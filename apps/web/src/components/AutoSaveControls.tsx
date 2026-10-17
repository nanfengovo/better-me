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
        <span>秒</span>
      </span>
      <small>{min}–{max} 秒，回车或离开后应用</small>
    </label>
  );
}

export function AutoSaveControls({ settings, onChange, onSave, saving = false, preferenceError }: Props) {
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
          aria-label="自动保存"
          aria-checked={settings.enabled}
          title={settings.enabled ? "关闭自动保存完整版本，草稿保护仍启用" : "开启自动保存完整版本"}
          onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
        >
          <span className="autosave-switch-track" aria-hidden="true"><span>{settings.enabled && <Check size={9} strokeWidth={3} />}</span></span>
          <span>自动保存</span>
          <small>{settings.enabled ? "已开启" : "已关闭"}</small>
        </button>
        <button
          type="button"
          className="autosave-settings-button"
          ref={settingsButtonRef}
          aria-label="自动保存设置"
          aria-expanded={open}
          aria-controls={panelId}
          aria-haspopup="dialog"
          title="设置自动保存条件"
          onClick={() => setOpen((previous) => !previous)}
        ><Settings2 size={13} /><ChevronDown size={10} className={open ? "is-open" : ""} /></button>
      </div>
      <button type="button" className="studio-button autosave-now" aria-label="立即保存" title="立即保存" onClick={onSave} disabled={saving}>
        <Save size={13} /><span>{saving ? "正在保存" : "立即保存"}</span>
      </button>
      {open && (
        <section className="autosave-popover" id={panelId} role="dialog" aria-labelledby={titleId}>
          <div className="autosave-popover-heading">
            <div><span className="autosave-eyebrow">按你的节奏保存</span><h2 id={titleId}>自动保存设置</h2></div>
            <button type="button" className="autosave-close" aria-label="关闭自动保存设置" onClick={() => { setOpen(false); settingsButtonRef.current?.focus(); }}><X size={15} /></button>
          </div>
          <label className="autosave-setting-field">
            <span>何时保存完整版本</span>
            <select
              aria-label="自动保存触发条件"
              value={settings.trigger}
              onChange={(event) => onChange({ ...settings, trigger: event.target.value as AutoSaveSettings["trigger"] })}
            >
              <option value="enter">按下回车</option>
              <option value="idle">停止输入后</option>
              <option value="blur">离开编辑项</option>
            </select>
            {settings.trigger === "enter" && <small>输入框内回车保存；Shift+Enter 仅换行。输入法选词不会触发保存。</small>}
          </label>
          {settings.trigger === "idle" && <SecondsField label="停止输入多久后保存" valueMs={settings.delayMs} min={1} max={300} onCommit={(delayMs) => onChange({ ...settings, delayMs })} />}
          <SecondsField label="自动版本合并间隔" valueMs={settings.historyIntervalMs} min={15} max={600} onCommit={(historyIntervalMs) => onChange({ ...settings, historyIntervalMs })} />
          <div className="autosave-explanation">
            <p>草稿保护始终启用，保留未完成编辑，不生成历史版本。满足所选条件后，才保存完整版本。</p>
            <p>间隔内的相邻自动版本合并为一版；手动命名的检查点独立保留。关闭自动保存后，仍可点「立即保存」。</p>
          </div>
          {!settings.enabled && <p className="autosave-paused">自动保存已关闭，以上条件将在开启后生效。</p>}
          {preferenceError && <p className="autosave-preference-error" role="alert">{preferenceError}</p>}
        </section>
      )}
    </div>
  );
}
