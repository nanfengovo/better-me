import useSWR from "swr";
import { fetchEngineStatus, fetchHostHealth, fetchProxyStatus, fetchUsage, modelStatus, worstHealth, type StatusItem } from "../services/system-status-client";
import { isStaticPublicPreview } from "./runtime-mode";

const quiet = { revalidateOnFocus: true, shouldRetryOnError: false, keepPreviousData: true, dedupingInterval: 10_000 } as const;

export function useSystemStatus() {
  const staticPreview = isStaticPublicPreview();
  const host = useSWR(staticPreview ? null : "system-status:host", fetchHostHealth, { ...quiet, refreshInterval: 30_000 });
  const proxy = useSWR(staticPreview ? null : "system-status:proxy", fetchProxyStatus, { ...quiet, refreshInterval: 60_000 });
  const engines = useSWR(!staticPreview && host.data?.health === "ok" ? "system-status:engines" : null, fetchEngineStatus, { ...quiet, refreshInterval: 60_000 });
  const usage = useSWR(!staticPreview && host.data?.health === "ok" ? "system-status:usage" : null, fetchUsage, {
    ...quiet, dedupingInterval: 2_000,
    refreshInterval: latest => latest?.active.length ? 3_000 : 20_000,
  });
  const models = modelStatus(usage.data);
  const groups: Array<{ id: "proxy" | "engines" | "models"; label: string; items: StatusItem[] }> = staticPreview
    ? [{ id: "engines", label: "预览", items: [{ id: "static-preview", label: "纯浏览器预览", health: "unknown", detail: "本地优先演示模式，不连接本机后端" }] }]
    : [
        { id: "proxy", label: "代理", items: proxy.data ? [proxy.data] : [] },
        { id: "engines", label: "引擎", items: [...(host.data ? [host.data] : []), ...(engines.data ?? [])] },
        { id: "models", label: "模型", items: models },
      ];
  const all = groups.flatMap(group => group.items);
  const totals = (usage.data?.models ?? []).reduce((sum, model) => ({
    input: sum.input + model.inputTokens, output: sum.output + model.outputTokens, calls: sum.calls + model.calls,
  }), { input: 0, output: 0, calls: 0 });
  const usageState = usage.data === null ? "unauthorized" : usage.error ? (usage.data ? "stale" : "error")
    : host.data?.health !== "ok" ? "unavailable" : usage.isLoading ? "loading" : usage.data ? "ready" : "unknown";
  const issues = all.filter(item => item.health === "down" || item.health === "warn");
  return { groups, overall: worstHealth(all), issues, usageState,
    usage: usage.data, totals, loading: host.isLoading, refreshing: usage.isValidating,
    retry: () => Promise.all([host.mutate(), proxy.mutate(), engines.mutate(), usage.mutate()]),
  };
}
