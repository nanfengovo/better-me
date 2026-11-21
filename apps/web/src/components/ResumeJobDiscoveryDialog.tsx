/** @jsxRuntime automatic */
import { useEffect, useMemo, useState } from "react";
import type { FactBase, ProjectedResume } from "@better-me/core";
import { useUiPreferences } from "../lib/ui-preferences";
import { resolveResumeJobConnection } from "../lib/resume-job-connection";
import { invalidateResumeJobCandidates } from "../lib/resume-job-source";
import { resumeDiscoveryCriteria } from "../lib/resume-discovery-criteria";
import { AtlasResumeDiscovery } from "./atlas/AtlasResumeDiscovery";
import { AtlasSettingsDialog } from "./atlas/AtlasSettingsDialog";
import type { AtlasConnectionIdentity } from "./atlas/connection-session";
import "./resume-job-discovery-dialog.css";

export type ResumeDiscoverySelection = {
  documentId?: string; viewId: string; name: string; resume: ProjectedResume; facts: FactBase; direction?: string;
};

export function ResumeJobDiscoveryDialog({ selection, onClose, onOpenMap, onCollected, onOpenBackgroundWatch }: {
  selection: ResumeDiscoverySelection; onClose: () => void; onOpenMap: () => void; onCollected: () => void; onOpenBackgroundWatch?: () => void;
}) {
  const { t } = useUiPreferences();
  const criteria = useMemo(() => resumeDiscoveryCriteria(selection.resume, selection.facts, selection.direction), [selection]);
  const [connection, setConnection] = useState<AtlasConnectionIdentity>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void resolveResumeJobConnection(abort.signal, attempt > 0).then(session => {
      if (abort.signal.aborted) return;
      setConnection(session);
      setFailed(!session);
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, [attempt]);
  return <AtlasSettingsDialog className="resume-job-dialog" title={t("按简历找岗位", "Find jobs with this resume")}
    closeLabel={t("关闭岗位搜索", "Close job search")} onClose={onClose}>
    <p className="resume-job-origin">{t("当前简历", "Current resume")} · {selection.name}</p>
    {onOpenBackgroundWatch && <button className="job-watch-from-search" type="button" onClick={onOpenBackgroundWatch}>{t("开启后台持续寻岗", "Set up ongoing background search")}</button>}
    {connection ? <AtlasResumeDiscovery {...criteria} {...connection} autoSearchOnOpen onCollected={() => {
        invalidateResumeJobCandidates();
        onCollected();
      }} />
      : failed ? <div className="resume-job-connection">
        <p role="status">{t("需要连接岗位服务才能查询招聘官网。", "Connect to the job service to search employer sites.")}</p>
        <button type="button" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>{t("连接岗位服务", "Connect job service")}</button>
        <button type="button" onClick={onOpenMap}>{t("到岗位地图设置连接", "Set up connection in the job map")}</button>
      </div> : <p role="status">{t("正在连接岗位服务…", "Connecting to the job service…")}</p>}
  </AtlasSettingsDialog>;
}
