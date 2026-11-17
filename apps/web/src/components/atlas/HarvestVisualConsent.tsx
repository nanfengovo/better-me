import { useEffect, useState } from "react";
import { readHarvestVisualStatus } from "../../lib/platform-search-client";

export function HarvestVisualConsent({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof readHarvestVisualStatus>>>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void readHarvestVisualStatus(abort.signal).then(value => { if (!abort.signal.aborted) setStatus(value); }, () => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, []);
  const ready = status?.configured && status.ocr;
  return <div className="atlas-visual-consent">
    <label><input type="checkbox" checked={checked && Boolean(ready)} disabled={!ready} onChange={event => onChange(event.target.checked)} />
      <span>本轮允许 AI 视觉兜底（Computer Use + 本地 OCR）</span></label>
    <small>{ready
      ? "仅失败时发送工具搜索页截图至 OpenAI（可能含账号显示信息），不上传本地简历。登录 / 验证码由你处理；授权仅限本轮。"
      : failed ? "暂时无法核对视觉服务；常规后台采集仍可继续。" : !status ? "正在检查本机视觉兜底配置…"
      : !status.configured ? "视觉模型尚未配置；常规后台采集仍可继续。" : "本地 OCR 暂不可用（当前需要 macOS Vision 和 Swift）；视觉操作未启用。"}</small>
    {ready && <details><summary>调用上限与操作范围</summary><small>gpt-6.1-sol；整轮最多 4 次调用（含截图握手），每次最多 1200 输出 token。仅受限点击 / 滚动，单平台最多 2 次视觉尝试。用完或刷新后不保留授权，不自动执行登录、验证码或投递。</small></details>}
  </div>;
}
