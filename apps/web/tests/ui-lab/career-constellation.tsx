import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import AtlasSkillConstellation from "../../src/components/AtlasSkillConstellation";
import type { SkillConstellationBinding, SkillConstellationBadge, VerifiedSkillJobLink } from "../../src/lib/skill-constellation";

if (!import.meta.env.DEV) throw new Error("Synthetic GPU acceptance fixture is development-only.");

// No Workspace/identity/provider import, business storage, account request,
// model client, configurable scene factory or hand-written substitute canvas.
// The production component uses its actual default Cesium scene and postRender.
const badge: SkillConstellationBadge = { id: "synthetic-gpu-badge", label: "合成技能符号 · 仅图形机制验收",
  verificationReceiptId: "synthetic-not-a-verification-receipt", sourceHash: "a".repeat(64), skillIds: ["sqlite", "concurrency"] };
const links: readonly VerifiedSkillJobLink[] = [
  { id: "synthetic-link-a", jobId: "synthetic-job-a", badgeId: badge.id, longitude: 121.5, latitude: 31.2, skillIds: ["sqlite", "concurrency"], strength: 1, sourceHash: "b".repeat(64), meaning: "explicit_skill_evidence_overlap_not_hiring_probability" },
  { id: "synthetic-link-b", jobId: "synthetic-job-b", badgeId: badge.id, longitude: 139.7, latitude: 35.6, skillIds: ["sqlite"], strength: .5, sourceHash: "c".repeat(64), meaning: "explicit_skill_evidence_overlap_not_hiring_probability" },
  { id: "synthetic-link-c", jobId: "synthetic-job-c", badgeId: badge.id, longitude: 116.4, latitude: 39.9, skillIds: ["concurrency"], strength: .5, sourceHash: "d".repeat(64), meaning: "explicit_skill_evidence_overlap_not_hiring_probability" },
  { id: "synthetic-link-d", jobId: "synthetic-job-d", badgeId: badge.id, longitude: 103.8, latitude: 1.3, skillIds: ["sqlite", "concurrency"], strength: 1, sourceHash: "e".repeat(64), meaning: "explicit_skill_evidence_overlap_not_hiring_probability" },
];
const metadata = links.map((link, index) => ({ jobId: link.jobId, label: `合成绘图岗位 ${String.fromCharCode(65 + index)} · 非真实招聘`, company: `虚构展示组 ${index + 1}`,
  officeLabel: "仅球面绘图坐标，不是真实办公室或已验证岗位" }));
const bindingAt = (generation: number): SkillConstellationBinding => ({ ownerId: "synthetic-gpu-owner-not-an-account", sessionGeneration: generation,
  contextId: `synthetic-gpu-only-scope-${generation}`, revision: `synthetic-gpu-drawing-revision-${generation}` });

function GpuAcceptanceLab() {
  const [binding, setBinding] = useState(() => bindingAt(1)), authority = useRef(binding), [revoked, setRevoked] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), [inspected, setInspected] = useState(false);
  const revoke = () => { authority.current = { ...authority.current, revision: `revoked-${authority.current.revision}` }; setRevoked(true); setSelected([]); setInspected(false); };
  const renew = () => { const next = bindingAt(binding.sessionGeneration + 1); authority.current = next; setBinding(next); setRevoked(false); setSelected([]); setInspected(false); };
  return <main data-theme="dark" data-synthetic-gpu-lab="true">
    <header className="gpu-lab-warning"><h1>仅合成图形验收，非真实岗位/Workspace来源证据</h1>
      <p>4 条合成连线、2 个合成技能。这里的岗位、公司、坐标与哈希全部为绘图夹具，不来自真实账号、岗位服务、Workspace、源码或 Verification Receipt。</p>
      <p>生产组件中“核对”“真实岗位点”等通用文案在本夹具不构成任何数据权威证明。只验实际默认 Cesium 渲染、postRender、列表筛选、选中、相机与撤权。此图不是 Vork 光追，也不是 GPU 型号/性能认证。</p>
    </header>
    <div className="gpu-lab-controls"><button type="button" disabled={revoked} onClick={revoke}>撤销当前合成授权</button><button type="button" disabled={!revoked} onClick={renew}>重建新的合成授权范围</button><span role="status">{revoked ? "合成授权已撤销；旧节点、连线与坐标应已隐藏。" : "仅当前合成范围有效；请用下方生产组件执行筛选、选择、放大/缩小和总览。"}</span></div>
    <p className="gpu-lab-info">固定虚构 owner：{binding.ownerId} · scope：{binding.contextId} · generation：{binding.sessionGeneration}。无账号/API/模型请求；仅加载同源 Vite 与 Cesium SDK 静态资源。未设置 sceneFactory 或 sharedViewer。</p>
    <AtlasSkillConstellation binding={binding} getCurrentBinding={() => authority.current} badge={badge} links={links} jobMetadata={metadata} excludedJobs={0}
      limitations={["仅合成图形验收，非真实岗位/Workspace来源证据。四个点和全部哈希只用于图形与撤权测试，不是可信办公室输入。"]}
      onSelectJob={jobId => { if (!revoked) setSelected(previous => [...previous, jobId].slice(-6)); }} onInspectBadge={() => { if (!revoked) setInspected(true); }} />
    <p className="gpu-lab-log" role="status">生产组件选择回调（无业务写入）：{selected.join(" → ") || "尚未选择"}；查看合成回执回调：{inspected ? "已触发，不代表回执真实性" : "尚未触发"}。</p>
    <p className="gpu-lab-info">真实帧状态以上方生产组件“已观察到三维渲染帧”及 data-scene-phase 为准。若显示 GPU/网络错误，保持失败；本夹具没有替代假场景或自动把 loading 改为 ready。</p>
  </main>;
}
const element = document.getElementById("root");
if (!element) throw new Error("GPU acceptance root not found.");
createRoot(element).render(<StrictMode><GpuAcceptanceLab /></StrictMode>);
