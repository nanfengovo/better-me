import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { BetterMeAgent } from "./kernel";
import { IndexedDbAgentRepository, createOwnedAgentRepository, type AgentRepository } from "./storage";
import { currentPrincipal } from "../identity";
import { defaultUnderstandingClient, type UnderstandingClient } from "../../services/understanding-client";
import { AgentRoutingProvider } from "../agent-routing";

const Context = createContext<BetterMeAgent | undefined>(undefined);
const repository = new IndexedDbAgentRepository();
const instances = new WeakMap<AgentRepository, Map<string, BetterMeAgent>>();
export function BetterMeAgentProvider({ workspaceKey, children, repository: provided, understandingClient = defaultUnderstandingClient }: {
  workspaceKey: string; children: ReactNode; repository?: AgentRepository; understandingClient?: UnderstandingClient;
}) {
  const [store] = useState(() => provided ?? (currentPrincipal() ? createOwnedAgentRepository() : repository));
  return <AgentScope key={workspaceKey} {...{ workspaceKey, store, understandingClient }}>{children}</AgentScope>;
}
function AgentScope({ workspaceKey, store, understandingClient, children }: { workspaceKey: string; store: AgentRepository; understandingClient: UnderstandingClient; children: ReactNode }) {
  const [agent] = useState(() => {
    let scopes = instances.get(store);
    if (!scopes) { scopes = new Map(); instances.set(store, scopes); }
    let existing = scopes.get(workspaceKey);
    if (!existing) { existing = new BetterMeAgent(workspaceKey, store, understandingClient.getSession, currentPrincipal()?.id); scopes.set(workspaceKey, existing); }
    return existing;
  });
  useEffect(() => {
    // Remote project work lives in Agent Host. Polling here survives every view change.
    const timer = setInterval(() => { void agent.refreshUnderstanding(); }, 3000);
    return () => clearInterval(timer);
  }, [agent]);
  useEffect(() => {
    const prepare = (event: Event) => { (event as CustomEvent<Promise<void>[]>).detail.push(agent.flush()); };
    window.addEventListener("betterme:before-sign-out", prepare);
    return () => window.removeEventListener("betterme:before-sign-out", prepare);
  }, [agent]);
  return <Context.Provider value={agent}><AgentRoutingProvider onSelectionChange={() => agent.cancelModelOperations()}>{children}</AgentRoutingProvider></Context.Provider>;
}
const noSubscribe = () => () => {};
const noSnapshot = () => undefined;
/** Optional so existing standalone integrations keep their explicit dependencies. */
export function useBetterMeAgent() {
  const agent = useContext(Context);
  const snapshot = useSyncExternalStore(agent?.subscribe ?? noSubscribe, agent?.getSnapshot ?? noSnapshot);
  return { agent, snapshot };
}

/** App supplies only its already-loaded, visible source projections; never opens a data store. */
export function AgentSourceBridge({ sources }: { sources: Array<{ key: string; text: string }> }) {
  const { agent, snapshot } = useBetterMeAgent();
  useEffect(() => { if (snapshot?.ready && !snapshot.error) agent?.reconcileSources(sources, true); }, [agent, snapshot?.ready, snapshot?.error, sources]);
  return null;
}
