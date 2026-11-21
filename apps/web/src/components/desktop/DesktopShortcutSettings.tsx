/** @jsxRuntime automatic */
import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";
import {
  SHORTCUT_DEFINITIONS,
  eventToShortcutSpec,
  findShortcutConflict,
  formatShortcutTokens,
  isMacPlatform,
  useShortcuts,
  type ShortcutCategory,
  type ShortcutId,
} from "../../lib/shortcuts";
import { Button } from "../../design-system";

const CATEGORIES: readonly { id: ShortcutCategory; zh: string; en: string }[] = [
  { id: "edit", zh: "编辑与保存", en: "Editing & saving" },
  { id: "view", zh: "视图与效率", en: "View & productivity" },
  { id: "navigation", zh: "工作台切换", en: "Workspace navigation" },
];

export function DesktopShortcutSettings() {
  const { t, locale } = useUiPreferences();
  const { shortcuts, updateShortcut, resetShortcut, resetAll } = useShortcuts();
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);
  const mac = isMacPlatform();

  useEffect(() => {
    if (!recordingId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecordingId(null);
        setConflictMsg(null);
        return;
      }
      if (event.key === "Backspace" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        resetShortcut(recordingId);
        setRecordingId(null);
        setConflictMsg(null);
        return;
      }
      const spec = eventToShortcutSpec(event, mac);
      if (!spec) return;
      const conflictId = findShortcutConflict(shortcuts, recordingId, spec);
      if (conflictId) {
        const conflictDef = SHORTCUT_DEFINITIONS.find((item) => item.id === conflictId);
        const conflictName = conflictDef ? (locale === "en" ? conflictDef.en : conflictDef.zh) : conflictId;
        setConflictMsg(t(`该组合键已被「${conflictName}」占用，请换一个组合键。`, `Already assigned to "${conflictName}". Choose another combination.`));
        return;
      }
      updateShortcut(recordingId, spec);
      setRecordingId(null);
      setConflictMsg(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recordingId, shortcuts, mac, locale, t, updateShortcut, resetShortcut]);

  const hasCustom = SHORTCUT_DEFINITIONS.some((def) => shortcuts[def.id] !== def.defaultSpec);

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="os-setting-intro" style={{ margin: 0 }}>
          {t("点击任意键帽后按下新的组合键即可修改，全局实时生效。按 Esc 取消，Backspace 恢复默认。", "Click any keycap and press a new key combination. Changes apply globally right away. Press Esc to cancel or Backspace to reset.")}
        </p>
        {hasCustom && (
          <Button variant="secondary" size="xs" onClick={() => { resetAll(); setConflictMsg(null); }}>
            <RotateCcw size={12} aria-hidden="true" />
            {t("全部恢复默认", "Reset all")}
          </Button>
        )}
      </div>

      {conflictMsg && (
        <div role="alert" className="bm-shortcut-conflict">
          {conflictMsg}
        </div>
      )}

      {CATEGORIES.map((category) => {
        const items = SHORTCUT_DEFINITIONS.filter((def) => def.category === category.id);
        return (
          <section key={category.id}>
            <h2>{locale === "en" ? category.en : category.zh}</h2>
            <div className="os-settings-card">
              {items.map((def) => {
                const isRecording = recordingId === def.id;
                const isModified = shortcuts[def.id] !== def.defaultSpec;
                const tokens = formatShortcutTokens(shortcuts[def.id], mac);
                return (
                  <div key={def.id} className="os-setting-row">
                    <div>
                      <div style={{ fontWeight: 550 }}>{locale === "en" ? def.en : def.zh}</div>
                      <small style={{ color: "var(--os-muted)", fontSize: 11 }}>{locale === "en" ? def.descEn : def.descZh}</small>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {isModified && (
                        <Button
                          variant="ghost"
                          size="xs"
                          iconOnly
                          aria-label={t(`恢复「${def.zh}」默认快捷键`, `Reset "${def.en}" shortcut`)}
                          title={t("恢复默认", "Reset to default")}
                          onClick={() => { resetShortcut(def.id); setConflictMsg(null); }}
                        >
                          <RotateCcw size={12} aria-hidden="true" />
                        </Button>
                      )}
                      <button
                        type="button"
                        className="bm-shortcut-recorder"
                        data-recording={isRecording ? "true" : undefined}
                        aria-label={t(`修改「${def.zh}」快捷键`, `Edit "${def.en}" shortcut`)}
                        onClick={() => { setRecordingId(isRecording ? null : def.id); setConflictMsg(null); }}
                      >
                        {isRecording ? (
                          <span className="bm-shortcut-prompt">{t("按下组合键…", "Press keys…")}</span>
                        ) : (
                          tokens.map((tok, i) => <kbd key={`${tok}-${i}`} className="bm-kbd">{tok}</kbd>)
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}
