import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import useSWR, { SWRConfig } from "swr";
import { listLocalAgentRuntimes, scanLocalAgentRuntimes, type LocalRuntimeInfo } from "../services/agent-client";

const EMPTY_RUNTIMES: LocalRuntimeInfo[] = [];

function useRuntimeState(enabled: boolean) {
  const { data, error, isLoading, mutate } = useSWR(enabled ? "betterme/local-agent-runtimes" : null, () => listLocalAgentRuntimes(), {
    refreshInterval: 30_000, shouldRetryOnError: false,
  });
  const [preferredId, setPreferredId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [scanFailed, setScanFailed] = useState(false);
  const runtimes = data ?? EMPTY_RUNTIMES;
  const selectedRuntime = preferredId === null
    ? runtimes.find(runtime => runtime.status === "available")
    : runtimes.find(runtime => runtime.id === preferredId);
  const selectedRuntimeId = preferredId ?? selectedRuntime?.id ?? "";
  const online = error || scanFailed ? false : data ? true : null;
  const ready = online === true && selectedRuntime?.status === "available";
  const setSelectedRuntimeId = useCallback((id: string) => {
    if (id === "" || runtimes.some(runtime => runtime.id === id && runtime.status === "available")) setPreferredId(id);
  }, [runtimes]);
  const refresh = useCallback(async (forceScan = false) => {
    setRefreshing(true);
    try {
      if (forceScan) await mutate(scanLocalAgentRuntimes(), { revalidate: false });
      else await mutate();
      setScanFailed(false);
    } catch { setScanFailed(true); }
    finally { setRefreshing(false); }
  }, [mutate]);
  return { runtimes, selectedRuntime, selectedRuntimeId, setSelectedRuntimeId, online, ready, loading: isLoading, refreshing, refresh };
}

const Context = createContext<ReturnType<typeof useRuntimeState> | null>(null);
function RuntimeScope({ children }: { children: ReactNode }) {
  const state = useRuntimeState(true);
  return <Context.Provider value={state}>{children}</Context.Provider>;
}

export function LocalAgentRuntimeProvider({ children }: { children: ReactNode }) {
  const [cache] = useState(() => new Map());
  return <SWRConfig value={{ provider: () => cache }}><RuntimeScope>{children}</RuntimeScope></SWRConfig>;
}

export function useLocalAgentRuntime() {
  const shared = useContext(Context);
  // Standalone surfaces retain their existing behavior; the app shares one scoped provider.
  const standalone = useRuntimeState(!shared);
  return shared ?? standalone;
}
