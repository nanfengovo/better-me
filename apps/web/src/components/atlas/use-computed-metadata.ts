import { useEffect, useMemo, useState } from "react";
import type { AtlasDataset } from "@better-me/opportunities";
import { getAtlasDataCoverage, type AtlasCoverageOptions } from "./coverage";
import { analyzeAiJobRelevance } from "./ai-job-relevance";
import { atlasCompute, atlasComputeAvailable } from "./compute-client";
import type { AtlasMetadata } from "./compute-protocol";

const empty = { coverage: getAtlasDataCoverage(undefined), penetratedIds: [] } satisfies AtlasMetadata;
export function useComputedAtlasMetadata(data: AtlasDataset | null, options: AtlasCoverageOptions, text: string, scope: object) {
  // Stable semantic inputs avoid recomputing on every input/hover render.
  const key = JSON.stringify(options);
  const stableOptions = useMemo(() => options, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const synchronous = useMemo(() => {
    if (atlasComputeAvailable() || !data) return undefined;
    const companies = new Map(data.companies.map(company => [company.id, company]));
    return { coverage: getAtlasDataCoverage(data, stableOptions), penetratedIds: text.trim() ? data.jobs.filter(job => analyzeAiJobRelevance(job, text, companies.get(job.companyId)?.names[0]).isPenetrated).map(job => job.id) : [] };
  }, [data, stableOptions, text]);
  const [state, setState] = useState<{ data: AtlasDataset; key: string; text: string; scope: object; result: AtlasMetadata }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!data || !atlasComputeAvailable()) return;
    const controller = new AbortController();
    setError("");
    void atlasCompute.metadata(data, stableOptions, text, controller.signal).then(result => {
      if (!controller.signal.aborted) setState({ data, key, text, scope, result });
    }, (failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "岗位统计计算失败，请重试连接。"); });
    return () => controller.abort();
  }, [data, key, stableOptions, text, scope]);
  const current = state?.data === data && state.key === key && state.text === text && state.scope === scope;
  const result = synchronous ?? (current ? state.result : empty);
  // Do not disable a filter mid-keystroke merely because the same connection's
  // newer snapshot is being calculated. Cross-connection facts never carry over.
  const coverage = synchronous?.coverage ?? (state?.scope === scope && state.key === key ? state.result.coverage : result.coverage);
  return { ...result, coverage, ready: !data || !!synchronous || current, error };
}
