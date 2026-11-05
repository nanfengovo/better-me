import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentRoutingPolicy, AgentRoutingTrace } from "@better-me/agent-contracts";
import { currentPrincipal } from "./identity";
import { AgentRoutingClientError, defaultAgentRoutingClient, type AgentRoutingClient } from "../services/agent-routing-client";

export type AgentBaseReply = { text: string; runtimeId: string };
type RoutingContext = {
  policy?: AgentRoutingPolicy; trace?: AgentRoutingTrace; error: string; busy: boolean; enabled: boolean; blocked: boolean;
  refresh: () => Promise<void>; update: (policy: AgentRoutingPolicy) => Promise<void>;
  assertSelected: () => void;
  respond: (instructions: string, messages: { role: "user" | "assistant"; content: string }[], signal: AbortSignal) => Promise<AgentBaseReply>;
};
const Context = createContext<RoutingContext | undefined>(undefined);
export function AgentRoutingProvider({ children, client = defaultAgentRoutingClient, onSelectionChange }: { children: ReactNode; client?: AgentRoutingClient; onSelectionChange?: () => void }) {
  const [policy, setPolicy] = useState<AgentRoutingPolicy>(), [trace, setTrace] = useState<AgentRoutingTrace>();
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const current = useRef(policy); current.current = policy;
  const lifetime = useRef(new AbortController());
  const adopt = (next: AgentRoutingPolicy) => {
    if (current.current && current.current.revision > next.revision) return false;
    if (current.current && current.current.revision !== next.revision) onSelectionChange?.();
    current.current = next; setPolicy(next); return true;
  };
  const refresh = async () => {
    const signal = lifetime.current.signal;
    try { const status = await client.status(signal); if (signal.aborted) return; if (adopt(status.policy)) { setTrace(status.trace); setError(""); } }
    catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : "底座状态尚未确认；未自动改变原有选择。"); }
  };
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    if (!currentPrincipal() && client === defaultAgentRoutingClient) return () => controller.abort();
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
    // One provider per authenticated app scope; no browser persistence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  const update = async (next: AgentRoutingPolicy) => {
    if (busy) return; setBusy(true); setError(""); const signal = lifetime.current.signal;
    try { const saved = await client.update(next, signal); if (!signal.aborted) adopt(saved); }
    catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : "底座选择未保存；原配置不变。"); throw failure; }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const respond: RoutingContext["respond"] = async (instructions, messages, signal) => {
    const selected = policy;
    if (!selected || selected.mode === "legacy") throw new AgentRoutingClientError("routing_not_enabled");
    if (current.current?.revision !== selected.revision) throw new AgentRoutingClientError("routing_revision_conflict");
    const combined = AbortSignal.any([signal, lifetime.current.signal]);
    try {
      const result = await client.respond({ id: crypto.randomUUID(), expectedRevision: selected.revision, instructions, messages }, combined);
      combined.throwIfAborted();
      if (current.current?.revision !== selected.revision) throw new AgentRoutingClientError("routing_revision_conflict");
      setTrace(result.trace); return { text: result.text, runtimeId: result.trace.runtimeId! };
    } catch (failure) { if (!combined.aborted && failure instanceof AgentRoutingClientError && failure.trace) setTrace(failure.trace); throw failure; }
  };
  const assertSelected = () => {
    if (currentPrincipal() && !policy || current.current?.revision !== policy?.revision) throw new AgentRoutingClientError("routing_revision_conflict");
  };
  return <Context.Provider value={{ policy, trace, error, busy, enabled: Boolean(policy && policy.mode !== "legacy"), blocked: Boolean((currentPrincipal() || client !== defaultAgentRoutingClient) && !policy), refresh, update, respond, assertSelected }}>{children}</Context.Provider>;
}
export function useAgentRouting() { return useContext(Context); }
export function agentBaseLabel(policy?: AgentRoutingPolicy) { return !policy || policy.mode === "legacy" ? "明确配置的模型" : policy.mode === "auto" ? `自动底座 · 首选 ${policy.preferred}` : `Agent 底座 · ${policy.preferred}`; }
