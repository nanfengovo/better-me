import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/** A disclosure, not an ARIA menu: its content can contain ordinary form fields. */
export function AtlasToolbarMenu({ label, className = "", children }: {
  label: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !details.current?.contains(event.target)) {
        if (details.current) details.current.open = false;
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  function close(restoreFocus: boolean) {
    if (!details.current) return;
    if (restoreFocus) details.current.querySelector("summary")?.focus();
    details.current.open = false;
    setOpen(false);
  }
  return <details ref={details} className={`atlas-toolbar-menu ${className}`}
    onToggle={event => setOpen(event.currentTarget.open)}
    onKeyDown={event => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing && details.current?.open) {
        event.preventDefault(); event.stopPropagation(); close(true);
      }
    }}>
    <summary>{label}<ChevronDown size={13} aria-hidden="true" /></summary>
    <div className="atlas-toolbar-popover" onClick={event => {
      if (event.target instanceof Element && event.target.closest("button[data-close-menu]")) close(true);
    }}>{children}</div>
  </details>;
}
