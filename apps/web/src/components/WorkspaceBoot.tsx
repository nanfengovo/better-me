import { useEffect, useRef } from "react";
import { ProductMark } from "./ProductMark";
import { useUiPreferences } from "../lib/ui-preferences";
import "./workspace-boot.css";

export function WorkspaceBoot({ onComplete }: { onComplete: () => void }) {
  const { t, reduceMotion } = useUiPreferences();
  const skip = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduceMotion || media.matches) { onComplete(); return; }
    skip.current?.focus({ preventScroll: true });
    const timer = window.setTimeout(onComplete, 1800);
    const changed = () => { if (media.matches) onComplete(); };
    media.addEventListener("change", changed);
    return () => { window.clearTimeout(timer); media.removeEventListener("change", changed); };
  }, [onComplete, reduceMotion]);
  return <section className="workspace-boot no-print" role="dialog" aria-modal="true" aria-label={t("进入 BetterMe", "Entering BetterMe")} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onComplete(); } }}>
    <div className="workspace-boot-center">
      <ProductMark size={72} />
      <span className="workspace-boot-name">BetterMe</span>
      <div className="workspace-boot-track" aria-hidden="true"><span /></div>
      <p role="status">{t("欢迎回来", "Welcome back")}</p>
    </div>
    <button ref={skip} type="button" onClick={onComplete}>{t("跳过动画", "Skip animation")}</button>
  </section>;
}
