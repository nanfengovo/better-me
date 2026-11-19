// ============================================================================
// 4. 6x6 外环 20 槽位逆时针映射
// ============================================================================
export const PERIMETER_20_SLOTS = [
  { row: 1, col: 1, zone: "TOP" },
  { row: 1, col: 2, zone: "TOP" },
  { row: 1, col: 3, zone: "SPOTLIGHT" }, // 顶部中央黄金聚光位
  { row: 1, col: 4, zone: "TOP" },
  { row: 1, col: 5, zone: "TOP" },
  { row: 1, col: 6, zone: "TOP" },
  { row: 2, col: 6, zone: "RIGHT" },
  { row: 3, col: 6, zone: "RIGHT" },
  { row: 4, col: 6, zone: "RIGHT" },
  { row: 5, col: 6, zone: "RIGHT" },
  { row: 6, col: 6, zone: "BOTTOM" },
  { row: 6, col: 5, zone: "BOTTOM" },
  { row: 6, col: 4, zone: "BOTTOM" },
  { row: 6, col: 3, zone: "BOTTOM" },
  { row: 6, col: 2, zone: "BOTTOM" },
  { row: 6, col: 1, zone: "BOTTOM" },
  { row: 5, col: 1, zone: "LEFT" },
  { row: 4, col: 1, zone: "LEFT" },
  { row: 3, col: 1, zone: "LEFT" },
  { row: 2, col: 1, zone: "LEFT" },
];

// ============================================================================
// 5. 20 节点求职工程流水线全链路拓扑定义
// ============================================================================
export interface StudioNode {
  id: number;
  code: string;
  name: string;
  tag: string;
  sub: string;
  vizType: string;
  latency: string;
  tokens: string;
  bulletColor: string;
  cmdTitle: string;
  cmdDetail: string;
}

export function getNodeTagBadge(tag: string, theme: "light" | "dark") {
  const isLight = theme === "light";
  switch (tag) {
    case "CORE":
      return isLight ? "bg-amber-100 text-amber-900 border-amber-300" : "bg-amber-400/15 text-amber-300 border-amber-400/30";
    case "SOURCING":
      return isLight ? "bg-sky-100 text-sky-900 border-sky-300" : "bg-sky-400/15 text-sky-300 border-sky-400/30";
    case "GUARD":
      return isLight ? "bg-emerald-100 text-emerald-900 border-emerald-300" : "bg-emerald-400/15 text-emerald-300 border-emerald-400/30";
    case "ANALYSIS":
      return isLight ? "bg-purple-100 text-purple-900 border-purple-300" : "bg-purple-400/15 text-purple-300 border-purple-400/30";
    case "TRIAGE":
      return isLight ? "bg-indigo-100 text-indigo-900 border-indigo-300" : "bg-indigo-400/15 text-indigo-300 border-indigo-400/30";
    case "TAILOR":
      return isLight ? "bg-orange-100 text-orange-900 border-orange-300" : "bg-orange-400/15 text-orange-300 border-orange-400/30";
    case "VERIFY":
      return isLight ? "bg-teal-100 text-teal-900 border-teal-300" : "bg-teal-400/15 text-teal-300 border-teal-400/30";
    case "DELIVERY":
      return isLight ? "bg-blue-100 text-blue-900 border-blue-300" : "bg-blue-400/15 text-blue-300 border-blue-400/30";
    case "TRACKING":
      return isLight ? "bg-cyan-100 text-cyan-900 border-cyan-300" : "bg-cyan-400/15 text-cyan-300 border-cyan-400/30";
    case "INTERVIEW":
      return isLight ? "bg-rose-100 text-rose-900 border-rose-300" : "bg-rose-400/15 text-rose-300 border-rose-400/30";
    case "DECISION":
      return isLight ? "bg-amber-100 text-amber-900 border-amber-300" : "bg-amber-400/15 text-amber-300 border-amber-400/30";
    case "SANDBOX":
      return isLight ? "bg-fuchsia-100 text-fuchsia-900 border-fuchsia-300" : "bg-fuchsia-400/15 text-fuchsia-300 border-fuchsia-400/30";
    default:
      return isLight ? "bg-slate-100 text-slate-700 border-slate-300" : "bg-slate-800 text-slate-300 border-slate-700";
  }
}

export const STUDIO_20_NODES: ReadonlyArray<StudioNode> = [
  {
    id: 1,
    code: "01",
    name: "BetterMe Agent",
    tag: "CORE",
    sub: "多内核编排 · 调度全部 20 项能力",
    vizType: "hub",
    latency: "Ready",
    tokens: "Local",
    bulletColor: "#F59E0B",
    cmdTitle: "kernel.orchestrate(skills=20, mode='local-first')",
    cmdDetail: "FactBase lock & saved opportunity library ready for advisor execution",
  },
  {
    id: 2,
    code: "02",
    name: "招聘检索",
    tag: "SOURCING",
    sub: "公开岗位卡 · SimHash 语义去重",
    vizType: "bars",
    latency: "待运行",
    tokens: "—",
    bulletColor: "#38BDF8",
    cmdTitle: "sourcing.query(sources=['careers', 'greenhouse', 'lever'])",
    cmdDetail: "Reads verified public sources configured in Opportunity Space",
  },
  {
    id: 3,
    code: "03",
    name: "BOSS直聘",
    tag: "SOURCING",
    sub: "只读公开卡片 · 绝不自动代发打招呼",
    vizType: "bridge",
    latency: "只读",
    tokens: "—",
    bulletColor: "#10B981",
    cmdTitle: "cdp.boss_readonly(auto_send=false)",
    cmdDetail: "Read-only capture with user confirmation; zero auto-messaging",
  },
  {
    id: 4,
    code: "04",
    name: "企业官网",
    tag: "SOURCING",
    sub: "Careers / ATS 公开招聘直连",
    vizType: "tree3",
    latency: "待运行",
    tokens: "—",
    bulletColor: "#22D3EE",
    cmdTitle: "ats.probe_official(mode='public_api')",
    cmdDetail: "Fetches official postings via authenticated / public adapters",
  },
  {
    id: 5,
    code: "05",
    name: "LinkedIn",
    tag: "SOURCING",
    sub: "外企研发中心 · 远程与混合办公筛选",
    vizType: "dotmatrix",
    latency: "待运行",
    tokens: "—",
    bulletColor: "#60A5FA",
    cmdTitle: "linkedin.read_public_card(filter_work_mode=true)",
    cmdDetail: "Preserves original URL and publication timestamp verbatim",
  },
  {
    id: 6,
    code: "06",
    name: "JD Guard",
    tag: "GUARD",
    sub: "隐藏指令剥离 · 零宽字符清洗",
    vizType: "guard",
    latency: "Guard",
    tokens: "—",
    bulletColor: "#F59E0B",
    cmdTitle: "jd_guard.sanitize(strip_zero_width=true)",
    cmdDetail: "Isolates untrusted JD markup before prompt construction",
  },
  {
    id: 7,
    code: "07",
    name: "JD 原句拆解",
    tag: "ANALYSIS",
    sub: "职责权重 · 硬性门槛 · 隐性加分项",
    vizType: "splitbars",
    latency: "待执行",
    tokens: "—",
    bulletColor: "#38BDF8",
    cmdTitle: "jd.decompose_requirements(source='saved_opportunity')",
    cmdDetail: "Send job to Advisor to generate structured requirement breakdown",
  },
  {
    id: 8,
    code: "08",
    name: "证据链对齐",
    tag: "ANALYSIS",
    sub: "FactBase 实证 · 弱表达诊断 · 缺口",
    vizType: "spectrum",
    latency: "待执行",
    tokens: "—",
    bulletColor: "#10B981",
    cmdTitle: "factbase.align(ground_truth_only=true)",
    cmdDetail: "Links resume phrasing directly to saved FactBase claims",
  },
  {
    id: 9,
    code: "09",
    name: "机会评级",
    tag: "TRIAGE",
    sub: "按真实需求与阶段做人工分层",
    vizType: "tiers",
    latency: "人工/顾问",
    tokens: "—",
    bulletColor: "#F59E0B",
    cmdTitle: "triage.evaluate(requires_advisor_receipt=true)",
    cmdDetail: "Scores appear only after explicit Advisor execution receipt",
  },
  {
    id: 10,
    code: "10",
    name: "企业来源核对",
    tag: "TRIAGE",
    sub: "发布主体 / 原始链接 / 时间核验",
    vizType: "radar",
    latency: "待核验",
    tokens: "—",
    bulletColor: "#A855F7",
    cmdTitle: "recon.inspect_provenance(source='opportunity_record')",
    cmdDetail: "Displays verified origin metadata without fabricated verdicts",
  },
  {
    id: 11,
    code: "11",
    name: "简历润色",
    tag: "TAILOR",
    sub: "结构化 old -> new · 绑定真实经历",
    vizType: "diff",
    latency: "待执行",
    tokens: "—",
    bulletColor: "#22D3EE",
    cmdTitle: "tailor.prepare_diff(grounded_in_factbase=true)",
    cmdDetail: "Open job in Advisor to review candidate rewrite proposals",
  },
  {
    id: 12,
    code: "12",
    name: "Reviewer",
    tag: "TAILOR",
    sub: "独立复核 · 拒绝虚构参数",
    vizType: "bridge",
    latency: "待执行",
    tokens: "—",
    bulletColor: "#10B981",
    cmdTitle: "reviewer.verify_claims(allow_invented=false)",
    cmdDetail: "Verifies every tailored bullet against your local FactBase",
  },
  {
    id: 13,
    code: "13",
    name: "ATS / 版式",
    tag: "VERIFY",
    sub: "简历材料快照 · 单页版式与 DOM 检查",
    vizType: "docscan",
    latency: "Ready",
    tokens: "—",
    bulletColor: "#38BDF8",
    cmdTitle: "verify.check_materials(target='saved_opportunity')",
    cmdDetail: "Inspect saved resume snapshots or run Advisor ATS check",
  },
  {
    id: 14,
    code: "14",
    name: "材料快照",
    tag: "DELIVERY",
    sub: "所投即所存 · 独立 Markdown 快照归档",
    vizType: "stack",
    latency: "Local",
    tokens: "—",
    bulletColor: "#60A5FA",
    cmdTitle: "snapshot.record_material(immutable_copy=true)",
    cmdDetail: "Subsequent resume edits never mutate archived job snapshots",
  },
  {
    id: 15,
    code: "15",
    name: "本人交接",
    tag: "DELIVERY",
    sub: "保留原申请页入口 · 由本人确认投递",
    vizType: "handover",
    latency: "Human",
    tokens: "—",
    bulletColor: "#F59E0B",
    cmdTitle: "delivery.human_confirm(require_explicit_submit=true)",
    cmdDetail: "Opening a link never fakes an applied status",
  },
  {
    id: 16,
    code: "16",
    name: "投递追踪",
    tag: "TRACKING",
    sub: "收藏 -> 投递 -> 面试 -> Offer 阶段树",
    vizType: "wave",
    latency: "Local",
    tokens: "—",
    bulletColor: "#10B981",
    cmdTitle: "tracking.stage_history(local_storage=true)",
    cmdDetail: "Tracks real stage transitions and user follow-up reminders",
  },
  {
    id: 17,
    code: "17",
    name: "面试攻防",
    tag: "INTERVIEW",
    sub: "基于真实项目经历组织深挖预案",
    vizType: "qa",
    latency: "待执行",
    tokens: "—",
    bulletColor: "#A855F7",
    cmdTitle: "interview.prepare(source='factbase')",
    cmdDetail: "Send job to Advisor for tailored interview drill",
  },
  {
    id: 18,
    code: "18",
    name: "STAR 对练",
    tag: "INTERVIEW",
    sub: "S-T-A-R 结构化复盘演练",
    vizType: "star",
    latency: "待执行",
    tokens: "—",
    bulletColor: "#22D3EE",
    cmdTitle: "interview.star_chain(nodes=['S', 'T', 'A', 'R'])",
    cmdDetail: "Builds structured STAR prompts around your verified work",
  },
  {
    id: 19,
    code: "19",
    name: "薪酬测算",
    tag: "DECISION",
    sub: "用户假设模拟 · 非岗位实际待遇承诺",
    vizType: "wagebars",
    latency: "Sim",
    tokens: "—",
    bulletColor: "#F59E0B",
    cmdTitle: "decision.simulate_hourly(tax_assumption=0.88)",
    cmdDetail: "Hypothetical calculator based on user sliders only",
  },
  {
    id: 20,
    code: "20",
    name: "沙箱应用工坊",
    tag: "SANDBOX",
    sub: "内置预设 · 本地模型编码实验台",
    vizType: "polygon",
    latency: "—",
    tokens: "—",
    bulletColor: "#38BDF8",
    cmdTitle: "sandbox · choose a reviewed preset or start a local coding task",
    cmdDetail: "Manual authorization required. Check the Host receipt for actual results.",
  },
];

// Compatibility export
export const AUTOPILOT_CARDS = STUDIO_20_NODES.map((n) => [n.tag, n.name, n.sub, `node-${n.code}`, n.vizType] as const);

const STUDIO_NODE_EN: Record<number, { name: string; sub: string; latency?: string }> = {
  1: { name: "BetterMe Agent", sub: "Multi-kernel orchestration across all 20 capabilities" },
  2: { name: "Job Search", sub: "Public job cards · SimHash semantic dedup", latency: "Idle" },
  3: { name: "BOSS Zhipin", sub: "Read-only public cards · never auto-messages", latency: "Read-only" },
  4: { name: "Company Careers", sub: "Direct official Careers / ATS adapters", latency: "Idle" },
  5: { name: "LinkedIn", sub: "R&D centers · remote and hybrid filters", latency: "Idle" },
  6: { name: "JD Guard", sub: "Strip hidden prompts & zero-width chars" },
  7: { name: "JD Decompose", sub: "Responsibilities · hard gates · bonus skills", latency: "Pending" },
  8: { name: "Evidence Align", sub: "FactBase proof · weak phrasing · gaps", latency: "Pending" },
  9: { name: "Role Triage", sub: "Human tiering by real fit & stage", latency: "Manual" },
  10: { name: "Source Verify", sub: "Publisher / canonical URL / timestamp check", latency: "Unverified" },
  11: { name: "Resume Tailor", sub: "Structured old -> new bound to verified facts", latency: "Pending" },
  12: { name: "Reviewer", sub: "Independent check · zero fabricated metrics", latency: "Pending" },
  13: { name: "ATS & Layout", sub: "Resume snapshot · 1-page A4 & DOM audit" },
  14: { name: "Material Snapshot", sub: "Immutable Markdown snapshot archive per role" },
  15: { name: "Human Handover", sub: "Keep official apply URL · human confirmation only" },
  16: { name: "Stage Tracker", sub: "Saved -> Applied -> Interview -> Offer tree" },
  17: { name: "Interview Defense", sub: "Deep-dive defense scripts from verified projects", latency: "Pending" },
  18: { name: "STAR Drill", sub: "Structured S-T-A-R practice sequence", latency: "Pending" },
  19: { name: "Comp Calculator", sub: "User assumption slider · not an offer guarantee" },
  20: { name: "Sandbox Studio", sub: "Built-in presets · local-model coding lab" },
};

export function localizeStudioNode(node: StudioNode, t: (zh: string, en: string) => string): StudioNode {
  const en = STUDIO_NODE_EN[node.id];
  if (!en) return node;
  return {
    ...node,
    name: t(node.name, en.name),
    sub: t(node.sub, en.sub),
    latency: en.latency ? t(node.latency, en.latency) : node.latency,
  };
}
