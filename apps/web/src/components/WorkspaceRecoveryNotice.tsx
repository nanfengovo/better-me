import { useUiPreferences } from "../lib/ui-preferences";

const recoveryErrors: Record<string, string> = {
  "本机恢复记录无法读取，原记录未覆盖。请下载备份并保留此页内容。": "Local recovery records could not be read. Original records were not overwritten; download a backup and keep this page open.",
  "另一窗口已更新记录，本页保留未保存草稿且不覆盖。请下载本页备份，再刷新页面核对。": "Another window updated these records. This page kept its unsaved draft without overwriting anything; download this page backup, then refresh to verify.",
  "另一窗口已更新记录，本页未覆盖对方内容。请下载本页备份，再刷新页面核对。": "Another window updated these records. This page did not overwrite them; download this page backup, then refresh to verify.",
  "本机记录尚未保存（空间不足或存储受限）。请下载备份，暂勿关闭或刷新。": "Local records have not been saved because storage is low or restricted. Download a backup and do not close or refresh this page yet.",
  "另一窗口已更新记录，本页保留当前内容且不覆盖。请下载本页备份，再刷新页面核对。": "Another window updated these records. This page kept its current content without overwriting anything; download this page backup, then refresh to verify.",
};

export function WorkspaceRecoveryNotice({ error, restored, download }: { error: string; restored: boolean; download: () => void }) {
  const { t } = useUiPreferences();
  const visibleError = error ? t(error, recoveryErrors[error] ?? error) : "";
  return visibleError ? <div className="coach-alert" role="alert"><p>{visibleError}</p><button type="button" onClick={download}>{t("下载本页备份", "Download this page backup")}</button></div>
    : <p className="coach-note" role="status">{restored ? t("已恢复本机记录 · 输入自动保存", "Local records restored · Input saves automatically") : t("输入与交互记录自动保存在本机", "Input and interaction history save automatically on this device")}</p>;
}
