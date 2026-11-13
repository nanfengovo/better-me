import { useMemo, useRef } from "react";
import type { AgentRoutingPolicy } from "@better-me/agent-contracts";
import type { LlmConfig } from "@better-me/core";
import { understandingModelRuntime, type UnderstandingRuntime } from "../services/understanding-client";
import { useAgentRouting } from "./agent-routing";
import { useBetterMeAgent } from "./betterme-agent/react";

type AccountSelection = { kind: "current" | "chatgpt"; profileId: string; model: string; ready: boolean };
type RoutingSelection = { enabled: boolean; blocked: boolean; policy?: Pick<AgentRoutingPolicy, "revision" | "preferred"> };

/** Select only the explicitly chosen transport. Readiness never changes billing
 * or credentials; an unavailable selection remains selected and fails closed. */
export function selectAgentTaskRuntime(config: LlmConfig, routing?: RoutingSelection, account?: AccountSelection) {
  const runtime: UnderstandingRuntime = routing?.enabled
    ? { kind: "unified", expectedRevision: routing.policy?.revision ?? 0 }
    : account?.kind === "chatgpt"
      ? { kind: "chatgpt", profileId: account.profileId, model: account.model }
      : understandingModelRuntime(config);
  const error = routing?.blocked || routing?.enabled && !routing.policy
    ? "底座状态尚未确认；未使用旧 API 配置补发。"
    : runtime.kind === "chatgpt" && (!account?.ready || !runtime.profileId || !runtime.model)
      ? "请先完成 ChatGPT 授权、选择可用模型并检查额度状态；不会改用当前 API 配置。"
      : undefined;
  const label = runtime.kind === "chatgpt" ? `ChatGPT · ${runtime.model || "未选择模型"}`
    : runtime.kind === "unified" ? `Agent 底座 · ${routing?.policy?.preferred || "待确认"}` : config.model;
  return { runtime, preferredRuntimeId: routing?.enabled ? routing.policy?.preferred : undefined, label, error };
}

/** Shared frontend selection seam, not another inference executor. Call the
 * assertion both before dispatch and before accepting a possibly late result. */
export function useAgentTaskRuntime(config: LlmConfig, account?: AccountSelection) {
  const routing = useAgentRouting();
  const { snapshot } = useBetterMeAgent();
  const choice = account ?? (snapshot ? {
    ...snapshot.data.selection, ready: snapshot.chatGptReady,
  } : undefined);
  const selected = useMemo(() => selectAgentTaskRuntime(config, routing, choice),
    // Only actual selection changes invalidate a frozen request, not a task's
    // unrelated display/history updates in the same provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, routing?.enabled, routing?.blocked, routing?.policy?.revision, routing?.policy?.preferred,
      choice?.kind, choice?.profileId, choice?.model, choice?.ready]);
  const key = JSON.stringify(selected);
  const current = useRef(key); current.current = key;
  return useMemo(() => ({ ...selected, key, assertSelected: () => {
    if (current.current !== key) throw new Error("账号或底座选择已变化，未采用旧请求结果；原记录和草稿保留。");
    routing?.assertSelected();
    if (selected.error) throw new Error(selected.error);
  } }), [selected, key, routing]);
}
