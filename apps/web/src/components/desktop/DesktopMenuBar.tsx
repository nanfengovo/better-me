import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";

const POINTER_MEDIA = "(hover: hover) and (pointer: fine) and (min-width: 601px)";

/** Shared desktop chrome only: never owns an app's mount, draft, or execution. */
export function DesktopMenuBar({ children }: { children: ReactNode }) {
  const { t, menuBarAutoHide = false, setDesktopPreferences } = useUiPreferences();
  const [finePointer, setFinePointer] = useState(() => window.matchMedia(POINTER_MEDIA).matches);
  const [revealed, setRevealed] = useState(false);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const system = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const hovered = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusFrame = useRef(0);
  const autoHide = menuBarAutoHide && finePointer;
  const visible = !autoHide || revealed || context !== null;

  const cancelHide = useCallback(() => { clearTimeout(timer.current); }, []);
  const reveal = useCallback(() => { cancelHide(); setRevealed(true); }, [cancelHide]);
  const hideLater = useCallback(() => {
    cancelHide();
    timer.current = setTimeout(() => {
      if (!hovered.current && !system.current?.contains(document.activeElement)
        && !system.current?.querySelector("details[open]")) setRevealed(false);
    }, 220);
  }, [cancelHide]);
  const dismiss = useCallback((restoreFocus: boolean) => {
    setContext(null);
    if (restoreFocus && previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    previousFocus.current = null;
    hideLater();
  }, [hideLater]);
  function openContext(x: number, y: number) {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reveal(); setContext({ x, y });
  }

  useEffect(() => {
    const media = window.matchMedia(POINTER_MEDIA);
    const change = () => setFinePointer(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => () => { clearTimeout(timer.current); cancelAnimationFrame(focusFrame.current); }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "F10" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault(); reveal();
      cancelAnimationFrame(focusFrame.current);
      focusFrame.current = requestAnimationFrame(() => header.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }));
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [reveal]);
  useLayoutEffect(() => {
    if (!context || !menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    menu.current.style.left = `${Math.max(8, Math.min(context.x, window.innerWidth - (rect.width || 224) - 8))}px`;
    menu.current.style.top = `${Math.max(8, Math.min(context.y, window.innerHeight - (rect.height || 48) - 8))}px`;
    menu.current.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [context]);
  useEffect(() => {
    if (!context) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) dismiss(false); };
    const close = () => dismiss(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", close); window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", close); window.removeEventListener("blur", close);
    };
  }, [context, dismiss]);

  return <div ref={system} className="os-menubar-system no-print" data-auto-hide={autoHide} data-visible={visible}
    onPointerEnter={() => { hovered.current = true; reveal(); }}
    onPointerLeave={() => { hovered.current = false; hideLater(); }}
    onFocusCapture={reveal}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideLater(); }}>
    {autoHide && <button type="button" className="os-menubar-edge" aria-label={t("显示菜单栏", "Show menu bar")}
      aria-expanded={visible} tabIndex={visible ? -1 : 0} onFocus={reveal} onClick={reveal} />}
    <header ref={header} className="os-menubar" aria-label={t("桌面菜单栏", "Desktop menu bar")}
      onContextMenu={event => {
        if ((event.target as HTMLElement).closest("nav,[role=menu]")) return;
        event.preventDefault(); openContext(event.clientX, event.clientY);
      }}
      onKeyDown={event => {
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
          event.preventDefault(); event.stopPropagation();
          const rect = (event.target as HTMLElement).getBoundingClientRect(); openContext(rect.left, rect.bottom);
        }
      }}>
      <span className="os-menubar-native-drag" aria-hidden="true" />
      {children}
    </header>
    {context && <div ref={menu} className="os-menubar-context" role="menu" aria-label={t("菜单栏显示", "Menu bar visibility")}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(true); }
        if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) { event.preventDefault(); menu.current?.querySelector("button")?.focus(); }
        if (event.key === "Tab") dismiss(false);
      }}>
      <button type="button" role="menuitemcheckbox" aria-checked={menuBarAutoHide} onClick={() => {
        setDesktopPreferences({ menuBarAutoHide: !menuBarAutoHide }); dismiss(true);
      }}><span className="os-menubar-context-check">{menuBarAutoHide && <Check size={14} aria-hidden="true" />}</span>{t("自动隐藏菜单栏", "Auto-hide menu bar")}</button>
    </div>}
  </div>;
}
