import { useUiPreferences } from "../lib/ui-preferences";
import { useEffect, useRef, useState } from "react";
import type { ResumeImportModalProps } from "./ResumeImportModal";

type ImportComponent = typeof import("./ResumeImportModal").ResumeImportModal;

export function LazyResumeImportModal(props: ResumeImportModalProps) {
  const { t } = useUiPreferences();
  const uiTextRef = useRef(t);
  uiTextRef.current = t;

  const [Component, setComponent] = useState<ImportComponent | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const loadingDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (props.isOpen && !Component) loadingDialog.current?.showModal();
  }, [props.isOpen, Component]);
  useEffect(() => {
    if (!props.isOpen || Component) return;
    let active = true;
    import("./ResumeImportModal").then((module) => {
      if (active) setComponent(() => module.ResumeImportModal);
    }).catch(() => {
      if (active) setError(uiTextRef.current("导入工具未能加载，请检查网络后重试。", "The import tool could not load. Check your connection and try again."));
    });
    return () => { active = false; };
  }, [props.isOpen, Component, attempt]);
  if (Component) return <Component {...props} />;
  if (!props.isOpen) return null;
  return <dialog ref={loadingDialog} aria-labelledby="import-loading-title" onCancel={(event) => { event.preventDefault(); props.onClose(); }} className="m-auto w-[calc(100vw-40px)] max-w-sm rounded-2xl border-0 bg-white p-6 shadow-2xl backdrop:bg-slate-950/45 backdrop:backdrop-blur-sm no-print">
      <h2 id="import-loading-title" className="font-semibold">{t("导入简历", "Import resume")}</h2>
      <p role={error ? "alert" : "status"} className="my-5 text-sm text-slate-600">{error || t("正在加载 PDF / Word 导入工具…", "Loading PDF / Word import tools…")}</p>
      <div className="flex justify-end gap-3">
        <button type="button" className="studio-button" onClick={props.onClose}>{t("关闭", "Close")}</button>
        {error && <button type="button" className="studio-button primary" onClick={() => { setError(""); setAttempt((value) => value + 1); }}>{t("重新加载", "Reload")}</button>}
      </div>
  </dialog>;
}
