import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useBackgroundEnrichment } from "../../src/components/atlas/use-background-enrichment";

// This entry never boots the application, browser storage, or local job index.
// Serve only with background-recovery.config.ts on its dedicated port.
if (location.origin !== "http://127.0.0.1:5198") throw new Error("Isolated fixture origin required");
function Probe() {
  const [revision, setRevision] = useState(10);
  const state = useBackgroundEnrichment({ endpoint: location.origin, token: "synthetic-only", enabled: true,
    currentRevision: revision, onSnapshot: () => { throw new Error("No snapshot should be published in this scenario"); } });
  return <main style={{ fontFamily: "system-ui", margin: "5rem auto", maxWidth: 760, lineHeight: 1.8 }}>
    <h1>后台索引告警 · 隔离回归</h1>
    <p>纯合成版本与 HTTP 失败，不连接真实简历、岗位库或招聘平台。</p>
    <p>后台目标版本：{state.status?.revision ?? "读取中"} · 前台版本：{revision}</p>
    <p role="status">{state.error ?? "索引已追上，无刷新告警"}</p>
    <p>刷新中：{String(state.refreshingSnapshot)}</p>
    <button onClick={() => setRevision(12)}>模拟前台已取得版本 12</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Probe />);
