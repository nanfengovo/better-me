import { useEffect, useMemo, useRef, useState } from "react";
import type { AtlasDataset } from "@better-me/opportunities";
import {
  readBackgroundEnrichmentStatus,
  type BackgroundEnrichmentStatus,
} from "../../lib/background-enrichment-client";
import { readAtlasSnapshot } from "./client";

export type BackgroundEnrichmentState = {
  status?: BackgroundEnrichmentStatus;
  loading: boolean;
  refreshingSnapshot: boolean;
  error?: string;
};

export type BackgroundEnrichmentInput = {
  endpoint: string;
  token: string;
  enabled: boolean;
  currentRevision: number | undefined;
  onSnapshot: (snapshot: AtlasDataset) => void;
  onError?: (message: string) => void;
};

const EMPTY: BackgroundEnrichmentState = { loading: false, refreshingSnapshot: false };
const STATUS_ERROR = "暂时无法读取后台补全状态，将自动重试。请检查本机服务连接。";
const SNAPSHOT_ERROR = "后台补全后的索引暂未刷新，将自动重试；当前岗位仍可使用。";
const WORKER_ERROR = "后台补全暂不可用，将自动重试。";

/** Observe server-owned tasks. Disposing this hook never cancels server work. */
export function useBackgroundEnrichment(input: BackgroundEnrichmentInput): BackgroundEnrichmentState {
  const { endpoint, token, enabled } = input;
  const connection = useMemo(() => ({ endpoint, token }), [endpoint, token]);
  const latest = useRef(input);
  latest.current = input;
  const [bound, setBound] = useState<{ connection: typeof connection; state: BackgroundEnrichmentState }>();

  useEffect(() => {
    if (!enabled) return;
    const { endpoint, token } = connection;
    let disposed = false;
    let pageHidden = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let statusRequest: AbortController | undefined;
    let snapshotRequest: AbortController | undefined;
    let status: BackgroundEnrichmentStatus | undefined;
    let loading = false;
    let statusError: string | undefined;
    let snapshotError: string | undefined;
    let reportedError: string | undefined;
    let wantedRevision = -1;
    let publishedRevision = -1;
    let idleRounds = 0;
    let failedPolls = 0;

    const visible = () => !disposed && !pageHidden && document.visibilityState !== "hidden";
    const currentRevision = () => Math.max(publishedRevision, latest.current.currentRevision ?? -1);

    function publish() {
      if (disposed) return;
      const error = statusError ?? snapshotError
        ?? (status?.workerState === "error" || status?.workerError ? WORKER_ERROR : undefined);
      setBound({ connection, state: {
        ...(status ? { status } : {}), loading, refreshingSnapshot: !!snapshotRequest,
        ...(error ? { error } : {}),
      } });
      if (error && error !== reportedError) latest.current.onError?.(error);
      reportedError = error;
    }

    function clearPoll() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }

    function stopObserving() {
      clearPoll();
      statusRequest?.abort();
      snapshotRequest?.abort();
      statusRequest = undefined;
      snapshotRequest = undefined;
      loading = false;
      publish();
    }

    function refreshSnapshot() {
      if (!visible() || snapshotRequest || wantedRevision <= currentRevision()) return;
      const controller = new AbortController();
      snapshotRequest = controller;
      const requestedRevision = wantedRevision;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
      const clearDeadline = () => clearTimeout(timeout);
      controller.signal.addEventListener("abort", clearDeadline, { once: true });
      publish();
      void (async () => {
        let succeeded = false;
        try {
          const next = await readAtlasSnapshot(endpoint, token, { signal: controller.signal });
          if (!visible() || snapshotRequest !== controller || controller.signal.aborted) return;
          if (next.revision < requestedRevision) throw new Error("stale snapshot");
          // A foreground import may have already published a newer revision while
          // this export was in flight. Never return that older data to its owner.
          if (next.revision > currentRevision()) {
            latest.current.onSnapshot(next);
            publishedRevision = next.revision;
          }
          snapshotError = undefined;
          succeeded = true;
        } catch {
          if (!visible() || snapshotRequest !== controller || (controller.signal.aborted && !timedOut)) return;
          snapshotError = SNAPSHOT_ERROR;
        } finally {
          clearTimeout(timeout);
          controller.signal.removeEventListener("abort", clearDeadline);
          if (snapshotRequest === controller) {
            snapshotRequest = undefined;
            publish();
            // Revisions observed during a slow export collapse to one next read.
            // Failures retry on the next status poll, never in a tight loop.
            if (succeeded) refreshSnapshot();
          }
        }
      })();
    }

    function nextDelay() {
      if (statusError) return Math.min(30_000, 3_000 * 2 ** Math.min(failedPolls - 1, 4));
      if (status && status.pending + status.running > 0) { idleRounds = 0; return 1_500; }
      const idleDelay = Math.min(30_000, 5_000 * 2 ** Math.min(idleRounds++, 3));
      const retryAt = status?.nextRetryAt ? Date.parse(status.nextRetryAt) - Date.now() : Infinity;
      return Math.min(idleDelay, Math.max(1_500, retryAt));
    }

    async function poll() {
      if (!visible() || statusRequest) return;
      clearPoll();
      const controller = new AbortController();
      statusRequest = controller;
      loading = !status;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
      const clearDeadline = () => clearTimeout(timeout);
      controller.signal.addEventListener("abort", clearDeadline, { once: true });
      publish();
      try {
        const next = await readBackgroundEnrichmentStatus(endpoint, token, { signal: controller.signal });
        if (!visible() || statusRequest !== controller || controller.signal.aborted) return;
        if (!status || next.revision >= status.revision) status = next;
        statusError = undefined;
        failedPolls = 0;
        wantedRevision = Math.max(wantedRevision, next.revision);
        refreshSnapshot();
      } catch {
        if (!visible() || statusRequest !== controller || (controller.signal.aborted && !timedOut)) return;
        statusError = STATUS_ERROR;
        failedPolls++;
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", clearDeadline);
        if (statusRequest === controller) {
          statusRequest = undefined;
          loading = false;
          publish();
          if (visible()) timer = setTimeout(() => { void poll(); }, nextDelay());
        }
      }
    }

    function visibilityChanged() {
      if (visible()) void poll();
      else stopObserving();
    }
    function pageHide() { pageHidden = true; stopObserving(); }
    function pageShow() { pageHidden = false; visibilityChanged(); }

    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("pageshow", pageShow);
    if (visible()) void poll();
    else publish();
    return () => {
      disposed = true;
      stopObserving();
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("pageshow", pageShow);
    };
  }, [connection, enabled]);

  if (!enabled) return EMPTY;
  return bound?.connection === connection ? bound.state : { ...EMPTY, loading: true };
}
