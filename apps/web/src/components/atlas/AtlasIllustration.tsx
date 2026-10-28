import { memo, useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { MapPinned, Search } from "lucide-react";

export type AtlasIllustrationKind = "discovery" | "search";
const artBase = `${import.meta.env?.BASE_URL ?? "/"}atlas-art/`;

/** Decorative, lazy artwork. Pointer feedback never rerenders the workspace or its data. */
export const AtlasIllustration = memo(function AtlasIllustration({
  kind = "discovery", compact = false, interactive = true,
}: { kind?: AtlasIllustrationKind; compact?: boolean; interactive?: boolean }) {
  const picture = useRef<HTMLImageElement>(null);
  const frame = useRef<number | undefined>(undefined);
  const bounds = useRef<DOMRect | undefined>(undefined);
  const [failedKind, setFailedKind] = useState<AtlasIllustrationKind>();
  const failed = failedKind === kind;
  const reset = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    bounds.current = undefined;
    if (picture.current) picture.current.style.transform = "";
  }, []);
  useEffect(() => {
    if (!interactive || compact || failed) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const stop = () => { reset(); };
    const keyboard = () => {
      if (picture.current) picture.current.style.transition = "none";
      reset();
    };
    document.addEventListener("visibilitychange", stop);
    document.addEventListener("keydown", keyboard, true);
    reduced?.addEventListener?.("change", stop);
    return () => {
      reset();
      document.removeEventListener("visibilitychange", stop);
      document.removeEventListener("keydown", keyboard, true);
      reduced?.removeEventListener?.("change", stop);
    };
  }, [interactive, compact, failed, kind, reset]);
  const tilt = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive || compact || failed || event.pointerType !== "mouse" || document.hidden
      || !window.matchMedia?.("(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)").matches) return;
    if (picture.current) picture.current.style.transition = "";
    const rect = bounds.current ??= event.currentTarget.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1));
    const y = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1));
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      if (picture.current) picture.current.style.transform = `rotateX(${-y * 5}deg) rotateY(${x * 7}deg)`;
    });
  };
  const Fallback = kind === "search" ? Search : MapPinned;
  return <div className="atlas-illustration" data-compact={compact || undefined} data-kind={kind}
    aria-hidden="true" onPointerMove={tilt} onPointerLeave={reset} onPointerCancel={reset}>
    {failed ? <span className="atlas-illustration-fallback"><Fallback size={compact ? 24 : 38} strokeWidth={1.4} /></span>
      : <img ref={picture} src={`${artBase}${kind}-384.webp`}
        srcSet={`${artBase}${kind}-384.webp 384w, ${artBase}${kind}-768.webp 768w`}
        sizes={compact ? "96px" : "(max-width: 480px) 180px, 240px"}
        width={384} height={256} alt="" loading="lazy" decoding="async" draggable={false}
        onError={() => setFailedKind(kind)} />}
  </div>;
});
