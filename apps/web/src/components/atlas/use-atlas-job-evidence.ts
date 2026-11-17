import { useEffect, useMemo, useState } from "react";
import type { AtlasDataset } from "@better-me/opportunities";
import type { AtlasJobEvidence } from "../../../../job-service/src/browse-contract";
import { isAtlasBrowseDataset, readAtlasJobEvidence } from "./client";

/** One selected job only. Leaving/changing the captured view cancels its read;
 * late history cannot enable actions for a different job or connection. */
export function useAtlasJobEvidence(data: AtlasDataset | null, jobId?: string) {
  const [state, setState] = useState<{ data: AtlasDataset; jobId: string; evidence?: AtlasJobEvidence; error?: string }>();
  const needsRead = isAtlasBrowseDataset(data) && Boolean(jobId);
  useEffect(() => {
    if (!data || !jobId || !isAtlasBrowseDataset(data)) return;
    const controller = new AbortController();
    void readAtlasJobEvidence(data, jobId, controller.signal).then(evidence => {
      if (!controller.signal.aborted) setState({ data, jobId, evidence });
    }, error => { if (!controller.signal.aborted) setState({ data, jobId, error: error instanceof Error ? error.message : "岗位完整来源暂未读取，请重新打开。" }); });
    return () => controller.abort();
  }, [data, jobId]);
  const current = state?.data === data && state.jobId === jobId ? state : undefined;
  const merged = useMemo(() => {
    if (!data || !current?.evidence) return data;
    const detail = current.evidence;
    const merge = <T extends { id: string }>(rows: T[], incoming: T[]) => { const updated = new Map(incoming.map(row => [row.id, row])); return [...rows.filter(row => !updated.has(row.id)), ...incoming]; };
    return { ...data, jobs: merge(data.jobs, [detail.job]), companies: merge(data.companies, [detail.company]),
      locations: merge(data.locations, detail.locations), compensations: merge(data.compensations, detail.compensations), listings: merge(data.listings, detail.listings),
      observations: merge(data.observations, detail.observations), snapshots: detail.snapshots };
  }, [data, current]);
  return { data: merged, loading: needsRead && !current, error: current?.error };
}
