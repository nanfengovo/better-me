import { useEffect, useMemo, useRef, useState } from "react";
import { prepareCityMapReferences, type AtlasDataset, type MapReferencesResult } from "@better-me/opportunities";
import type { AtlasDataMode } from "./connection-session";
import { AtlasSourceServiceError, createAtlasSourceClient } from "./service-client";

export type AtlasMapReferencesInput = {
  active: boolean; dataMode: AtlasDataMode; connected: boolean;
  endpoint: string; token: string; snapshot: AtlasDataset | null;
};

/** A disposable display projection. Credentials, derived city points and errors never enter storage. */
export function useAtlasMapReferences({ active, dataMode, connected, endpoint, token, snapshot }: AtlasMapReferencesInput) {
  const binding = useMemo(() => ({ endpoint, token, snapshot }), [endpoint, token, snapshot]);
  const eligible = useMemo(() => {
    if (!snapshot) return false;
    const referenced = new Set(snapshot.jobs.filter(job => job.workMode !== "remote").flatMap(job => job.locationIds));
    return snapshot.locations.some(location => referenced.has(location.id) && location.kind !== "remote-region"
      && !location.coordinates && !!location.countryCode && !!location.city && location.verification !== "conflicting");
  }, [snapshot]);
  const enabled = active && dataMode === "live" && connected && eligible;
  const [attempt, setAttempt] = useState(0);
  type State = { binding: typeof binding; attempt: number; loading: boolean; result?: MapReferencesResult; error?: string };
  const [state, setState] = useState<State>();
  const cached = useRef<State | undefined>(undefined);
  const current = useRef<{ binding: typeof binding; controller: AbortController } | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !binding.snapshot) return;
    if (cached.current?.binding === binding && cached.current.attempt === attempt) { setState(cached.current); return; }
    const operation = { binding, controller: new AbortController() }; current.current = operation;
    setState({ binding, attempt, loading: true });
    const timer = setTimeout(() => operation.controller.abort(), 20_000);
    void createAtlasSourceClient(binding.endpoint, binding.token).mapReferences({ expectedRevision: binding.snapshot.revision }, { signal: operation.controller.signal }).then(async result => {
      try { await prepareCityMapReferences(binding.snapshot!, result); }
      catch { throw new AtlasSourceServiceError("invalid-response", "城市分布参考与当前索引地点不一致，请重新读取；岗位列表仍可使用。"); }
      if (current.current !== operation || operation.controller.signal.aborted) return;
      const next = { binding, attempt, loading: false, result }; cached.current = next; setState(next);
    }).catch((error: unknown) => {
      if (current.current !== operation) return;
      setState({ binding, attempt, loading: false, error: operation.controller.signal.aborted
        ? "城市分布参考读取已取消或超时，可重试；岗位列表仍可使用。"
        : error instanceof AtlasSourceServiceError && error.status === 404
          ? "本机服务尚不支持城市分布参考。请更新并重启岗位服务后重试；岗位列表仍可使用。"
          : error instanceof Error ? error.message : "城市分布参考暂不可用；岗位列表仍可使用。" });
    }).finally(() => clearTimeout(timer));
    return () => { if (current.current === operation) current.current = undefined; operation.controller.abort(); clearTimeout(timer); };
  }, [binding, enabled, attempt]);
  const bound = enabled && state?.binding === binding && state.attempt === attempt ? state : undefined;
  function cancel() {
    const operation = current.current;
    if (!operation || operation.binding !== binding) return;
    current.current = undefined; operation.controller.abort();
    setState({ binding, attempt, loading: false, error: "已取消城市分布参考读取；岗位列表仍可使用。" });
  }
  return { result: bound?.result, loading: enabled && (!bound || bound.loading), error: bound?.error,
    eligible: dataMode === "live" && connected && eligible, retry: () => setAttempt(value => value + 1), cancel };
}
