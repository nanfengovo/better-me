import { useUiPreferences } from "../lib/ui-preferences";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type ConfirmOptions = { title?: string; confirmLabel?: string; danger?: boolean };
type Confirm = (message: string, options?: ConfirmOptions) => Promise<boolean>;
type Request = { message: string; options: ConfirmOptions; resolve: (value: boolean) => void };
const ConfirmationContext = createContext<Confirm | null>(null);

export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) throw new Error("确认操作需要 ConfirmationProvider。");
  return confirm;
}

export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const { t } = useUiPreferences();

  const [request, setRequest] = useState<Request | null>(null);
  const pending = useRef<Request | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirm = useCallback<Confirm>((message, options = {}) => {
    // A second action cannot silently replace the question already on screen.
    if (pending.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const next = { message, options, resolve };
      pending.current = next;
      setRequest(next);
    });
  }, []);
  const settle = useCallback((answer: boolean) => {
    const current = pending.current;
    if (!current) return;
    pending.current = null;
    dialogRef.current?.close();
    setRequest(null);
    current.resolve(answer);
  }, []);
  useEffect(() => () => {
    pending.current?.resolve(false);
    pending.current = null;
  }, []);
  useEffect(() => {
    if (!request) return;
    dialogRef.current?.showModal();
    cancelRef.current?.focus();
  }, [request]);

  return <ConfirmationContext.Provider value={confirm}>
    {children}
    {request && <dialog ref={dialogRef} className="confirmation-dialog no-print" aria-labelledby="confirmation-title" aria-describedby="confirmation-message"
      onCancel={(event) => { event.preventDefault(); settle(false); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") event.preventDefault();
      }}>
      <h2 id="confirmation-title">{request.options.title ?? t("确认操作", "Confirm action")}</h2>
      <p id="confirmation-message">{request.message}</p>
      <div className="confirmation-actions">
        <button ref={cancelRef} type="button" onClick={() => settle(false)}>{t("取消", "Cancel")}</button>
        <button type="button" className={request.options.danger ? "danger" : "confirm"} onClick={() => settle(true)}>{request.options.confirmLabel ?? t("确认", "Confirm")}</button>
      </div>
    </dialog>}
  </ConfirmationContext.Provider>;
}
