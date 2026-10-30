import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, ArrowRight, Check, Compass, FileText, Orbit, ShieldCheck, Sparkles, WandSparkles, X } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import { FIRST_RUN_GUIDE_KEY, GUIDE_STEPS, placeGuide, rememberGuide, shouldShowGuide, type GuideRect } from "../lib/first-run-guide";
import "./first-run-guide.css";

type Props = { eligible: boolean; onPrepare: () => void };
export function FirstRunGuide({ eligible, onPrepare }: Props) {
  const { t } = useUiPreferences();
  const [step, setStep] = useState<number | null>(null);
  const [effects, setEffects] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);
  const [geometry, setGeometry] = useState<{ width: number; height: number; target: GuideRect | null; x: number; y: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), panel = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const replay = useRef<HTMLButtonElement>(null), previousFocus = useRef<HTMLElement | null>(null);
  const attempted = useRef(false), keyboard = useRef(false), motion = useRef<Animation | null>(null);
  const stepInfo = step === null ? null : GUIDE_STEPS[step];
  const cinematic = stepInfo?.target === null;
  const animated = effects && !reduced;
  const positioned = geometry !== null;

  function close(state: "completed" | "skipped") {
    // This is an independent preference. Never call resume persistence or reset.
    let stored = false;
    try { stored = rememberGuide(window.localStorage, state); } catch { /* Storage access itself can be blocked. */ }
    setStorageWarning(!stored);
    dialog.current?.close(); setStep(null);
    (previousFocus.current?.isConnected && previousFocus.current !== document.body ? previousFocus.current : replay.current)?.focus({ preventScroll: true });
  }
  function navigate(next: number, fromKeyboard = false) {
    keyboard.current = fromKeyboard;
    setStep(Math.max(0, Math.min(GUIDE_STEPS.length - 1, next)));
  }
  function start() {
    attempted.current = true; previousFocus.current = replay.current;
    setStorageWarning(false); onPrepare(); setStep(0);
  }
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches); change();
    media.addEventListener("change", change); return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!eligible || attempted.current) return;
    const timer = window.setTimeout(() => {
      attempted.current = true;
      try { if (!shouldShowGuide(window.localStorage)) return; } catch { /* A blocked preference must not break the workspace. */ }
      if (document.querySelector("dialog[open]")) return;
      // A late-loaded tour must not interrupt someone who has already started typing.
      if (document.activeElement?.matches("input, textarea, select, [contenteditable=true]")) return;
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setStep(0);
    }, 650);
    return () => clearTimeout(timer);
  }, [eligible]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === FIRST_RUN_GUIDE_KEY && event.newValue) {
        try { const value = JSON.parse(event.newValue); if (value.version === 1 && ["completed", "skipped"].includes(value.state)) { dialog.current?.close(); setStep(null); } } catch { /* Unrelated invalid preferences do not close the tour. */ }
      }
    };
    window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, []);
  useLayoutEffect(() => {
    if (step === null) return;
    const current = GUIDE_STEPS[step]; if (!current) return;
    const selector = current.target;
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    function measure() {
      const width = window.innerWidth, height = window.innerHeight;
      const element = selector ? document.querySelector<HTMLElement>(selector) : null;
      const rect = element?.getBoundingClientRect();
      const visible = rect && rect.width > 0 && rect.height > 0 && rect.bottom > 8 && rect.top < height - 8 && rect.right > 8 && rect.left < width - 8;
      const target = visible ? { x: Math.max(8, rect.left - 6), y: Math.max(8, rect.top - 6), width: Math.min(width - 8, rect.right + 6) - Math.max(8, rect.left - 6), height: Math.min(height - 8, rect.bottom + 6) - Math.max(8, rect.top - 6) } : null;
      const size = { width: panel.current?.offsetWidth ?? 440, height: panel.current?.offsetHeight ?? 460 };
      setGeometry({ width, height, target, ...placeGuide(target, { width, height }, size) });
    }
    measure();
    const observer = new ResizeObserver(measure); if (panel.current) observer.observe(panel.current);
    const anchor = current.target ? document.querySelector(current.target) : null; if (anchor) observer.observe(anchor);
    window.addEventListener("resize", measure); window.addEventListener("scroll", measure, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [step]);
  useLayoutEffect(() => {
    // The first measurement reveals the card. Focus only after it is visible.
    if (step !== null && positioned) heading.current?.focus({ preventScroll: true });
  }, [step, positioned]);
  useEffect(() => {
    motion.current?.cancel();
    if (step === null || !panel.current || !animated || keyboard.current || typeof panel.current.animate !== "function") return;
    const animation = panel.current.animate([{ opacity: 0.45, transform: "translateY(12px) scale(0.97)" }, { opacity: 1, transform: "translateY(0) scale(1)" }], { duration: 250, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    motion.current = animation;
    void animation.finished.catch(() => { /* Moving on or closing intentionally cancels this animation. */ });
    return () => animation.cancel();
  }, [step, animated]);
  useEffect(() => () => { motion.current?.cancel(); }, []);

  const cutout = geometry?.target;
  const backdropPath = geometry ? `M0 0H${geometry.width}V${geometry.height}H0Z${cutout ? `M${cutout.x} ${cutout.y}v${cutout.height}h${cutout.width}v-${cutout.height}Z` : ""}` : "";
  return <>
    <button ref={replay} type="button" className="studio-button subtle guide-replay" aria-label={t("重新播放新手引导", "Replay workspace tour")} onClick={start} title={t("新手引导", "Workspace tour")}><Compass size={16} /><span>{t("新手引导", "Tour")}</span></button>
    {storageWarning && <span className="guide-storage-warning" role="status">{t("引导已关闭，但浏览器未保存偏好，下次可能再次出现。", "Tour closed, but this browser could not remember it.")}</span>}
    {step !== null && stepInfo && <dialog ref={dialog} className={`first-run-guide no-print ${cinematic ? "is-cinematic" : "is-spotlight"} ${animated ? "has-effects" : "reduced-effects"}`} aria-labelledby="guide-title" aria-describedby="guide-description"
      onCancel={event => { event.preventDefault(); close("skipped"); }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Tab") {
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")).filter(node => node.getClientRects().length > 0);
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") event.preventDefault();
        if (event.key === "ArrowRight") { event.preventDefault(); navigate(step + 1, true); }
        if (event.key === "ArrowLeft") { event.preventDefault(); navigate(step - 1, true); }
      }}>
      <svg className="guide-shade" aria-hidden="true" viewBox={`0 0 ${geometry?.width ?? 1} ${geometry?.height ?? 1}`} preserveAspectRatio="none"><path d={backdropPath} fillRule="evenodd" /></svg>
      <div className="guide-atmosphere" aria-hidden="true"><i /><i /><i /></div>
      {cutout && <div className="guide-focus" aria-hidden="true" style={{ left: cutout.x, top: cutout.y, width: cutout.width, height: cutout.height }}><i /><b /><span /></div>}
      <section ref={panel} className="guide-panel" style={{ left: geometry?.x ?? 16, top: geometry?.y ?? 16, visibility: geometry ? "visible" : "hidden" }} data-step={stepInfo.id}>
        <header className="guide-top"><span><span className="guide-brand-dot" /> BETTERME <b>/ {t("初次见面", "WELCOME ABOARD")}</b></span><button type="button" className="guide-icon-button" onClick={() => close("skipped")} aria-label={t("关闭并跳过引导", "Close and skip tour")}><X size={18} /></button></header>
        {cinematic && <div className={`guide-scene ${stepInfo.id === "finish" ? "is-celebration" : ""}`} aria-hidden="true">
          <div className="guide-scene-grid" /><div className="guide-orbit orbit-one" /><div className="guide-orbit orbit-two" /><div className="guide-orbit orbit-three" />
          <div className="guide-orbit-tag tag-one"><ShieldCheck size={17} /> {t("真实", "TRUE")}</div><div className="guide-orbit-tag tag-two"><Sparkles size={17} /> AGENT</div><div className="guide-orbit-tag tag-three"><Orbit size={17} /> {t("可能性", "POSSIBILITY")}</div>
          <div className="guide-paper"><div className="guide-paper-mark">bm<span>.</span></div><div className="guide-paper-line" /><div className="guide-paper-line short" /><div className="guide-paper-block"><FileText size={20} /><span /><span /></div><div className="guide-paper-line" /><div className="guide-paper-line short" /><div className="guide-paper-seal">{stepInfo.id === "finish" ? <Check size={26} /> : <WandSparkles size={26} />}</div><i className="guide-paper-scan" /></div>
          {Array.from({ length: 18 }, (_, index) => <i key={index} className="guide-spark" style={{ "--spark-x": `${(index * 37 + 11) % 100}%`, "--spark-y": `${(index * 23 + 7) % 100}%`, "--spark-delay": `${(index % 6) * 50}ms`, "--spark-angle": `${index * 137.5}deg` } as CSSProperties} />)}
        </div>}
        <div className="guide-copy" aria-live="polite" aria-atomic="true"><div className="guide-chapter"><Sparkles size={14} />{String(step + 1).padStart(2, "0")} / {t(stepInfo.label[0], stepInfo.label[1])}</div><h2 id="guide-title" ref={heading} tabIndex={-1}>{t(stepInfo.title[0], stepInfo.title[1])}</h2><p id="guide-description">{t(stepInfo.description[0], stepInfo.description[1])}</p><div className="guide-hint"><ShieldCheck size={15} /><span>{t(stepInfo.hint[0], stepInfo.hint[1])}</span></div>{!cinematic && !cutout && <p className="guide-target-fallback">{t("当前布局未显示此区域；关闭引导后可从对应导航入口找到。", "This area is not visible in this layout. Find it through the workspace navigation after the tour.")}</p>}</div>
        <footer className="guide-footer"><div className="guide-progress" role="group" aria-label={t("引导步骤", "Tour steps")}>{GUIDE_STEPS.map((item, index) => <button key={item.id} type="button" aria-label={t(`第 ${index + 1} 步：${item.label[0]}`, `Step ${index + 1}: ${item.label[1]}`)} aria-current={step === index ? "step" : undefined} className={index <= step ? "is-reached" : ""} onClick={() => navigate(index)}><span /></button>)}</div>
          <div className="guide-actions"><button type="button" className="guide-secondary" onClick={() => step === 0 ? close("skipped") : navigate(step - 1)}>{step === 0 ? t("稍后再说", "Maybe later") : <><ArrowLeft size={15} />{t("上一步", "Back")}</>}</button><button type="button" className="guide-primary" onClick={() => step === GUIDE_STEPS.length - 1 ? close("completed") : navigate(step + 1)}>{step === 0 ? t("带我逛逛", "Show me around") : step === GUIDE_STEPS.length - 1 ? t("开始写我的故事", "Start my story") : t("下一步", "Next")}<ArrowRight size={17} /></button></div>
          <div className="guide-utilities"><label><input type="checkbox" checked={animated} disabled={reduced} onChange={event => setEffects(event.target.checked)} />{reduced ? t("跟随系统 · 减少动态效果", "System: reduced motion") : t("沉浸动效", "Immersive effects")}</label><span>{step + 1} / {GUIDE_STEPS.length}</span>{step > 0 && step < GUIDE_STEPS.length - 1 ? <button type="button" onClick={() => navigate(step + 1)}>{t("跳过本步", "Skip step")}</button> : <button type="button" onClick={() => close("skipped")}>{t("跳过引导", "Skip tour")}</button>}</div>
        </footer>
      </section>
    </dialog>}
  </>;
}
