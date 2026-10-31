/** Serial health polling for services attached to Vite; closing cancels future checks. */
export function watchDevService(
  broker: { ensure: () => Promise<unknown>; close: () => Promise<void> },
  intervalMs: number,
  onError: (error: unknown) => void,
): { close: () => Promise<void> } {
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let priorError = "";
  const check = async () => {
    try { await broker.ensure(); priorError = ""; }
    catch (error) {
      const key = error instanceof Error ? error.message : String(error);
      if (!closing && key !== priorError) onError(error);
      priorError = key;
    } finally {
      if (!closing) {
        timer = setTimeout(() => { void check(); }, intervalMs);
        timer.unref?.();
      }
    }
  };
  void check();
  return { close: async () => {
    closing = true;
    if (timer) clearTimeout(timer);
    await broker.close();
  } };
}
