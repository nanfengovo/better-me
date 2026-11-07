import { useEffect, useMemo, useRef, useState } from "react";
import type { AtlasDataset, FxState } from "@better-me/opportunities";
import type { AtlasDataMode } from "./connection-session";
import { AtlasSourceServiceError, createAtlasSourceClient } from "./service-client";

export type AtlasFxContextInput = {
  active: boolean; dataMode: AtlasDataMode; connected: boolean;
  endpoint: string; token: string; snapshot: AtlasDataset | null;
  asOfDay?: string;
};

/** No FX state crosses a connection, snapshot identity, retry, or data-view boundary. */
export function useAtlasFxContext({ active, dataMode, connected, endpoint, token, snapshot, asOfDay }: AtlasFxContextInput) {
  const binding = useMemo(() => ({ endpoint, token, snapshot, asOfDay }), [endpoint, token, snapshot, asOfDay]);
  const enabled = active && dataMode === "live" && connected && !!snapshot;
  const [attempt, setAttempt] = useState(0);
  type State = { binding: typeof binding; attempt: number; loading: boolean; value?: FxState; error?: string; unsupported?: boolean };
  const [state, setState] = useState<State>();
  const current = useRef<{ binding: typeof binding; controller: AbortController } | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !binding.snapshot) return;
    const operation = { binding, controller: new AbortController() }; current.current = operation;
    setState({ binding, attempt, loading: true });
    const timer = setTimeout(() => operation.controller.abort(), 20_000);
    void createAtlasSourceClient(endpoint, token).readFxState({ expectedRevision: binding.snapshot.revision }, { signal: operation.controller.signal }).then(value => {
      if (current.current !== operation || operation.controller.signal.aborted) return;
      setState({ binding, attempt, loading: false, value });
    }).catch((problem: unknown) => {
      if (current.current !== operation) return;
      const unsupported = problem instanceof AtlasSourceServiceError && problem.status === 404;
      setState({ binding, attempt, loading: false, unsupported, error: operation.controller.signal.aborted
        ? "汇率上下文读取已取消或超时，请重试。旧汇率结果已隐藏。"
        : problem instanceof Error ? problem.message : "无法读取与当前索引同版的汇率上下文，请重试。" });
    }).finally(() => clearTimeout(timer));
    return () => { if (current.current === operation) current.current = undefined; operation.controller.abort(); clearTimeout(timer); };
  }, [binding, enabled, attempt, endpoint, token]);
  const bound = enabled && state?.binding === binding && state.attempt === attempt ? state : undefined;
  function cancel() {
    const operation = current.current;
    if (!operation || operation.binding !== binding) return;
    current.current = undefined; operation.controller.abort();
    setState({ binding, attempt, loading: false, error: "已停止读取汇率上下文。旧汇率结果已隐藏，请重试。" });
  }
  return { state: bound?.value, context: bound?.value?.context,
    ready: dataMode !== "live" || enabled && (!!bound?.value || !!bound?.unsupported),
    loading: enabled && (!bound || bound.loading), error: bound?.error, unsupported: !!bound?.unsupported,
    retry: () => setAttempt(value => value + 1), cancel };
}
