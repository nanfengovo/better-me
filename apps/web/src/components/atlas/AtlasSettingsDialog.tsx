import { useId, useLayoutEffect, useRef, type PointerEvent, type ReactNode } from "react";
import { X } from "lucide-react";

function canRestoreFocus(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest("[hidden], [inert]") || element.matches(":disabled")) return false;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
  }
  return true;
}

/** The browser owns modality and tab containment; settings stay outside page flow. */
export function AtlasSettingsDialog({ title, children, onClose }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const backdropPointer = useRef<number | null>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const document = dialog.ownerDocument;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      // A settings change can open another dialog or hide the workspace. Do not
      // reclaim focus from that next task, or jump to an invisible opener.
      const current = document.activeElement;
      const ownedFocus = !current || current === document.body || dialog.contains(current);
      if (dialog.open) dialog.close();
      const anotherModal = [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')]
        .some(candidate => candidate !== dialog && !dialog.contains(candidate));
      if (ownedFocus && !anotherModal && opener && canRestoreFocus(opener)) opener.focus({ preventScroll: true });
    };
  }, []);

  function isBackdrop(event: PointerEvent<HTMLDialogElement>): boolean {
    if (event.target !== event.currentTarget) return false;
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  }

  return <dialog ref={dialogRef} className="atlas-settings atlas-settings-dialog" aria-modal="true" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onKeyDown={event => {
      // A modal keyboard interaction must never clear the job/map selection.
      event.stopPropagation();
      if (event.key === "Escape" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        onClose();
      }
    }}
    onPointerDown={event => {
      backdropPointer.current = event.button === 0 && event.isPrimary !== false && isBackdrop(event) ? event.pointerId : null;
    }}
    onPointerUp={event => {
      const dismiss = backdropPointer.current === event.pointerId && isBackdrop(event);
      backdropPointer.current = null;
      if (dismiss) onClose();
    }}
    onPointerCancel={() => { backdropPointer.current = null; }}>
    <header className="atlas-settings-dialog-header">
      <h2 id={titleId}>{title}</h2>
      <button ref={closeRef} type="button" className="atlas-settings-dialog-close" aria-label="关闭地图设置" onClick={onClose}>
        <X size={18} aria-hidden="true" />
      </button>
    </header>
    <div className="atlas-settings-dialog-body">{children}</div>
  </dialog>;
}
