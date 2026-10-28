import { useCallback, useEffect, useRef, useState } from "react";
import type { HarvestCheckpoint, HarvestRunInput } from "./harvest-checkpoint";
import { HarvestRecoveryController, type HarvestRecoveryState } from "./harvest-recovery-controller";

export function useHarvestRecovery(input: {
  endpoint: string;
  token: string;
  enabled: boolean;
  onResume: (input: HarvestRunInput, checkpoint: HarvestCheckpoint, signal: AbortSignal) => Promise<void>;
}) {
  const latest = useRef(input);
  latest.current = input;
  const owner = useRef<{ controller: HarvestRecoveryController; endpoint: string; token: string } | undefined>(undefined);
  const draining = useRef<Promise<void>>(Promise.resolve());
  const [state, setState] = useState<HarvestRecoveryState>({ phase: "idle" });
  useEffect(() => {
    if (!input.enabled) { setState({ phase: "idle" }); return; }
    const current = () => latest.current.enabled && latest.current.endpoint === input.endpoint && latest.current.token === input.token;
    const controller = new HarvestRecoveryController({ endpoint: input.endpoint, token: input.token }, undefined,
      next => { if (owner.current?.controller === controller && current()) setState(next); });
    owner.current = { controller, endpoint: input.endpoint, token: input.token };
    const priorWriter = draining.current;
    void priorWriter.then(() => {
      if (owner.current?.controller !== controller || !current()) return;
      return controller.resume((saved, checkpoint, signal) => {
        if (owner.current?.controller !== controller || !current() || signal.aborted) return Promise.resolve();
        return latest.current.onResume(saved, checkpoint, signal);
      });
    }).catch(() => {
      // Controller exposes the actionable error. An unavailable journal never
      // prevents reading/searching the already-stored local index.
    });
    return () => {
      if (owner.current?.controller === controller) owner.current = undefined;
      draining.current = Promise.all([draining.current, controller.dispose()]).then(() => {});
    };
  }, [input.enabled, input.endpoint, input.token]);

  const run = useCallback(async <T,>(saved: HarvestRunInput, execute: (checkpoint: HarvestCheckpoint, signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => {
    const bound = owner.current;
    await draining.current;
    if (!bound || owner.current !== bound || !latest.current.enabled || bound.endpoint !== latest.current.endpoint || bound.token !== latest.current.token) throw new Error("尚未连接可保存采集断点的本机索引。请先连接后重试。");
    return bound.controller.start(saved, execute, signal);
  }, []);
  const cancel = useCallback(() => owner.current?.controller.cancel() ?? Promise.resolve(), []);
  const continuePrevious = useCallback(async () => {
    const bound = owner.current;
    await draining.current;
    if (!bound || owner.current !== bound || !latest.current.enabled || bound.endpoint !== latest.current.endpoint || bound.token !== latest.current.token) return;
    await bound.controller.continue((saved, checkpoint, signal) => {
      if (owner.current !== bound || !latest.current.enabled || bound.endpoint !== latest.current.endpoint || bound.token !== latest.current.token || signal.aborted) return Promise.resolve();
      return latest.current.onResume(saved, checkpoint, signal);
    });
  }, []);
  return { state, run, cancel, continuePrevious };
}
