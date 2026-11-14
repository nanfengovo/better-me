import useSWR from "swr";
import { fetchEngineStatus, fetchHostHealth, fetchProxyStatus, fetchUsage, modelStatus, worstHealth, type StatusItem } from "../services/system-status-client";

const quiet = { revalidateOnFocus: true, shouldRetryOnError: false, keepPreviousData: true, dedupingInterval: 10_000 } as const;

export function useSystemStatus() {
  const host = useSWR("system-status:host", fetchHostHealth, { ...quiet, refreshInterval: 30_000 });
  const proxy = useSWR("system-status:proxy", fetchProxyStatus, { ...quiet, refreshInterval: 60_000 });
  const engines = useSWR(host.data?.health === "ok" ? "system-status:engines" : null, fetchEngineStatus, { ...quiet, refreshInterval: 60_000 });
  const usage = useSWR(host.data?.health === "ok" ? "system-status:usage" : null, fetchUsage, {
    ...quiet, dedupingInterval: 2_000,
    refreshInterval: latest => latest?.active.length ? 3_000 : 20_000,
  });
  const models = modelStatus(usage.data);
  const groups: Array<{ id: "proxy" | "engines" | "models"; label: string; items: StatusItem[] }> = [
    { id: "proxy", label: "代理", items: proxy.data ? [proxy.data] : [] },
    { id: "engines", label: "引擎", items: [...(host.data ? [host.data] : []), ...(engines.data ?? [])] },
    { id: "models", label: "模型", items: models },
  ];
  const all = groups.flatMap(group => group.items);
  const totals = (usage.data?.models ?? []).reduce((sum, model) => ({
    input: sum.input + model.inputTokens, output: sum.output + model.outputTokens, calls: sum.calls + model.calls,
  }), { input: 0, output: 0, calls: 0 });
  return { groups, overall: worstHealth(all), issues: all.filter(item => item.health === "down" || item.health === "warn"),
    usage: usage.data, totals, loading: !host.data };
}
