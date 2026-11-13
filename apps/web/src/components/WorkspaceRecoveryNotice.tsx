export function WorkspaceRecoveryNotice({ error, restored, download }: { error: string; restored: boolean; download: () => void }) {
  return error ? <div className="coach-alert" role="alert"><p>{error}</p><button type="button" onClick={download}>下载本页备份</button></div>
    : <p className="coach-note" role="status">{restored ? "已恢复本机记录 · 输入自动保存" : "输入与交互记录自动保存在本机"}</p>;
}
