import type { KeyboardEvent } from "react";

export function trapDialogTab(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget;
  const controls = [...dialog.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest('[inert], [hidden], [aria-hidden="true"]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
  const first = controls[0], last = controls.at(-1);
  if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
  const active = dialog.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || !controls.includes(active as HTMLElement))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (active === last || !controls.includes(active as HTMLElement))) {
    event.preventDefault(); first.focus();
  }
}
