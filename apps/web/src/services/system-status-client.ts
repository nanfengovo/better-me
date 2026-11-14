import { agentOrigin, ownedFetch } from "../lib/identity";
import { readRuntimeConnection } from "../lib/runtime-connection";
import { checkAgentHostHealth, listLocalAgentRuntimes, type LocalRuntimeInfo } from "./agent-client";
import { fetchVorkStatus } from "./vork-client";
import { detectNetworkProxies, getNetworkSettings } from "../lib/network-settings";

export type Health = "ok" | "warn" | "down" | "unknown";
export type StatusItem = {
  id: string;
  label: string;
  health: Health;
  detail: string;
  meta?: string;
  badge?: string;
};

export type ModelUsage = {
  label: string;
  kind?: "model" | "chatgpt" | "native";
  calls: number;
  failures: number;
  metered: boolean;
  inputTokens: number;
  outputTokens: number;
  lastAt: string;
};
export type UsageSnapshot = {
  day: string;
  since: string;
  models: ModelUsage[];
  active: Array<{ label: string; startedAt: string }>;
};

const token = () => readRuntimeConnection()?.agentToken ?? "better-me-agent-token";
const nonNegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const compactHost = (raw: string) => {
  try { return new URL(raw).host || raw; } catch { return raw; }
};

export async function fetchHostHealth(): Promise<StatusItem> {
  const online = await checkAgentHostHealth();
  return {
    id: "host",
    label: "Agent 服务",
    health: online ? "ok" : "down",
    detail: online ? "在线" : "无法连接本机服务",
    badge: online ? "在线" : "离线",
  };
}

export async function fetchProxyStatus(): Promise<StatusItem> {
  try {
    const settings = await getNetworkSettings();
    if (settings.mode === "direct") {
      return { id: "proxy", label: "网络代理", health: "ok", detail: "直接连接", badge: "直连" };
    }
    const detection = await detectNetworkProxies();
    const target = settings.mode === "manual" ? settings.proxyUrl : detection.autoRoute.proxyUrl;
    if (!target) {
      return { id: "proxy", label: "网络代理", health: "ok", detail: "未检测到代理，直接连接", meta: "自动", badge: "直连" };
    }
    const host = compactHost(target);
    const candidate = detection.candidates.find(item => item.url === target);
    if (!candidate) {
      return { id: "proxy", label: "网络代理", health: "unknown", detail: `${target} · 未检测`, meta: host, badge: "未检测" };
    }
    return {
      id: "proxy",
      label: "网络代理",
      health: candidate.reachable ? "ok" : "down",
      detail: `${target} · ${candidate.reachable ? "可连接" : "无法连接"}`,
      meta: host,
      badge: candidate.reachable ? "可连接" : "不可达",
    };
  } catch {
    return { id: "proxy", label: "网络代理", health: "unknown", detail: "网络设置服务不可用", badge: "未知" };
  }
}

const runtimeHealth: Record<LocalRuntimeInfo["status"], Health> = {
  available: "ok",
  "needs-config": "warn",
  error: "down",
  "not-installed": "unknown",
};
const runtimeDetail: Record<LocalRuntimeInfo["status"], string> = {
  available: "可用",
  "needs-config": "需配置",
  error: "异常",
  "not-installed": "未安装",
};

export async function fetchEngineStatus(): Promise<StatusItem[]> {
  const [runtimes, vork] = await Promise.allSettled([listLocalAgentRuntimes(), fetchVorkStatus()]);
  const items: StatusItem[] = runtimes.status === "fulfilled"
    ? runtimes.value.filter(runtime => runtime.status !== "not-installed").map(runtime => ({
        id: `runtime:${runtime.id}`,
        label: runtime.name,
        health: runtimeHealth[runtime.status],
        detail: [runtimeDetail[runtime.status], runtime.version].filter(Boolean).join(" · "),
        meta: runtime.version,
        badge: runtimeDetail[runtime.status],
      }))
    : [{ id: "runtimes", label: "本机 CLI", health: "unknown", detail: "登录后可查看", badge: "待登录" }];
  if (vork.status === "fulfilled") {
    items.push({
      id: "vork",
      label: `渲染 · ${vork.value.engine}`,
      health: vork.value.available ? "ok" : "unknown",
      detail: vork.value.available ? vork.value.device || "可用" : "未安装",
      meta: vork.value.available ? vork.value.device : undefined,
      badge: vork.value.available ? "就绪" : "未安装",
    });
  }
  return items;
}

export async function fetchUsage(): Promise<UsageSnapshot | null> {
  const response = await ownedFetch(`${agentOrigin()}/api/v1/agent/usage`, {
    headers: { Authorization: `Bearer ${token()}` },
    signal: AbortSignal.timeout(4_000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`usage_${response.status}`);
  const data = await response.json() as Partial<UsageSnapshot>;
  return {
    day: String(data.day ?? ""),
    since: String(data.since ?? ""),
    models: Array.isArray(data.models) ? data.models.map(item => ({
      label: String(item.label),
      kind: item.kind,
      calls: nonNegative(item.calls),
      failures: nonNegative(item.failures),
      metered: item.metered === true,
      inputTokens: nonNegative(item.inputTokens),
      outputTokens: nonNegative(item.outputTokens),
      lastAt: String(item.lastAt ?? ""),
    })) : [],
    active: Array.isArray(data.active) ? data.active.map(item => ({ label: String(item.label), startedAt: String(item.startedAt) })) : [],
  };
}

/** Model health is the outcome of real calls already made; never a paid probe. */
export function modelStatus(usage: UsageSnapshot | null | undefined): StatusItem[] {
  if (!usage) return [{ id: "models", label: "模型通道", health: "unknown", detail: "登录后可查看", badge: "待登录" }];
  if (!usage.models.length) return [{ id: "models", label: "模型通道", health: "unknown", detail: "今日尚未调用", badge: "待调用" }];
  return usage.models.map(model => ({
    id: `model:${model.label}`,
    label: model.label,
    health: model.failures === 0 ? "ok" : model.failures >= model.calls ? "down" : "warn",
    detail: model.failures ? `今日 ${model.failures}/${model.calls} 次失败` : `今日 ${model.calls} 次调用正常`,
    meta: `${model.calls} 次`,
    badge: model.failures ? `${model.failures} 失败` : "正常",
  }));
}

export function worstHealth(items: StatusItem[]): Health {
  if (items.some(item => item.health === "down")) return "down";
  if (items.some(item => item.health === "warn")) return "warn";
  if (items.some(item => item.health === "ok")) return "ok";
  return "unknown";
}

export function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}
