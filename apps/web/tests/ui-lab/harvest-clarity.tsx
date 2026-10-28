import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { AtlasHarvestProgress } from "../../src/components/atlas/AtlasHarvestProgress";
import { AtlasLiveHarvestResults } from "../../src/components/atlas/AtlasLiveHarvestResults";
import { AtlasBackgroundEnrichmentStatus } from "../../src/components/atlas/AtlasBackgroundEnrichmentStatus";
import type { HarvestProgressState } from "../../src/components/atlas/harvest-progress-presentation";
import type { HarvestIssueInput } from "../../src/components/atlas/harvest-issue-presentation";
import type { LiveHarvestCard, LiveHarvestProvider, LiveHarvestView } from "../../src/components/atlas/live-harvest-view";
import type { BackgroundEnrichmentState } from "../../src/components/atlas/use-background-enrichment";
import { UiPreferencesProvider, useUiPreferences } from "../../src/lib/ui-preferences";
import "../../src/index.css";
import "../../src/studio.css";
import "../../src/theme.css";
import "../../src/atelier.css";
import "../../src/themes/workspace-theme.css";
import "../../src/components/atlas/atlas.css";
import "../../src/components/atlas/atlas-harvest-progress.css";
import "../../src/components/atlas/background-enrichment.css";
import "../../src/components/atlas/harvest-recovery.css";
import "../../src/components/atlas/atlas-experience.css";

const scenarios = [
  ["partial", "截图场景 · 部分未完成"],
  ["login", "需要登录"],
  ["verification", "需要人工验证"],
  ["unknown", "失败原因未知"],
  ["query-error", "检索词有明确错误"],
  ["import-error", "入库回执超时 · 来源已读取"],
  ["success", "本轮已完成"],
  ["cancelled", "已取消 · 保留结果"],
  ["running", "采集进行中"],
] as const;
type Scenario = typeof scenarios[number][0];
type BackgroundScenario = "working" | "done" | "error" | "hidden";
const capturedAt = "2026-10-28T12:00:00.000Z";
const TOTAL_CARDS = 1220;
const providerPlan = [
  { provider: "liepin", platform: "猎聘", count: 837, title: "C# 后端开发工程师", company: "澄明科技 · 合成企业", salary: "25–35K · 14薪", location: "上海市 · 浦东新区" },
  { provider: "boss", platform: "BOSS直聘", count: 284, title: ".NET 平台工程师", company: "青屿软件 · 合成企业", salary: "28–40K", location: "上海市 · 徐汇区" },
  { provider: "linkedin", platform: "LinkedIn", count: 99, title: "Senior Backend Engineer / C#", company: "Northfield Labs · Synthetic company", salary: "30–45K", location: "上海市 · 黄浦区" },
] as const;

type SyntheticSource = Pick<LiveHarvestCard, "provider" | "platform"> & {
  title: string; company: string; salary: string; location: string;
};

function makeCard(source: SyntheticSource, index: number): LiveHarvestCard {
  const title = index === 0 ? source.title : `${source.title} · 合成 ${index + 1}`;
  const url = `https://jobs.example.invalid/${source.provider}/synthetic-${index + 1}`;
  return { provider: source.provider, platform: source.platform, card: {
    platform: source.platform, url, title, company: source.company,
    locationText: source.location, salaryText: source.salary, publicationText: "今日发布 · 合成时间",
    cardText: "合成 UI 验收岗位，非真实招聘。负责服务开发与跨团队协作，3–5 年经验，本科；支持岗位列表、来源回执与状态可读性验收。",
    evidence: { pageUrl: `https://jobs.example.invalid/${source.provider}/search?keyword=C%23`, cardSelector: ".synthetic-job-card",
      fields: [{ field: "title", selector: ".synthetic-title", text: title }] },
  } };
}

// Keep actual card cardinality equal to the declared total and interleave the
// first three sources, so the real pagination and source tags can be checked.
const cards: LiveHarvestCard[] = [];
for (let index = 0; index < Math.max(...providerPlan.map(source => source.count)); index++) {
  for (const source of providerPlan) if (index < source.count) cards.push(makeCard(source, index));
}
if (cards.length !== TOTAL_CARDS) throw new Error("Synthetic fixture card count mismatch.");

// Ingestion is separate from source reading: these 15 source cards exist, but
// their write receipt is unconfirmed. Do not relabel the source as failed.
let replacedBossCards = 0;
const importErrorCards = cards.map(card => card.provider === "boss" && replacedBossCards < 15
  ? makeCard({ provider: "51job", platform: "51JOB", title: "C# 服务开发工程师", company: "清远数字 · 合成企业",
    salary: "24–36K", location: "上海市 · 长宁区" }, replacedBossCards++) : card);
const importFailures: NonNullable<HarvestIssueInput["importFailures"]> = [{
  platform: "51JOB", cards: 15,
  error: "51JOB入库提交等待30秒超时，尚未收到这15张卡片的成功回执；未收到回执不等于未写入。",
}];

function coverage(stopReason: LiveHarvestProvider["coverage"]["stopReason"], pagesVisited: number, scrollSteps = 0) {
  return { pagesVisited, pageLimit: 20, scrollSteps, scrollLimit: scrollSteps ? 80 : 0,
    cardLimit: 1500, stopReason, partial: stopReason !== "exhausted" };
}

function providersFor(scenario: Scenario): LiveHarvestProvider[] {
  const providers: LiveHarvestProvider[] = [
    { provider: "51job", platform: "51JOB", status: "error", cardCount: 0, pagesVisited: 0, scrollSteps: 0,
      coverage: coverage("error", 0), warnings: [], error: "页面读取超时：等待招聘列表30秒后仍未加载完成。请稍后继续读取；已返回的其他平台岗位已保留。" },
    { provider: "liepin", platform: "猎聘", status: "ready", cardCount: 837, pagesVisited: 20, scrollSteps: 0,
      coverage: coverage("page_limit", 20), warnings: ["达到本轮20页读取预算，剩余页面尚未读取；这不代表网站全量。"] },
    { provider: "boss", platform: "BOSS直聘", status: "ready", cardCount: 284, pagesVisited: 1, scrollSteps: 63,
      coverage: coverage("no_progress", 1, 63), warnings: ["继续滚动后未确认列表变化，停止本轮读取；已有核验卡片保留。"] },
    { provider: "linkedin", platform: "LinkedIn", status: "ready", cardCount: 99, pagesVisited: 8, scrollSteps: 0,
      coverage: coverage("error", 8), warnings: ["已读取的卡片保留，尚未返回的分页不计为覆盖。"],
      error: "第9页读取失败：页面响应超时；前8页返回的99张卡片已保留。" },
  ];
  if (scenario === "unknown") {
    delete providers[0]!.error;
    providers[0]!.warnings = [];
  } else if (scenario === "login") {
    providers[0] = { ...providers[0]!, status: "login_required", coverage: coverage("gate", 0),
      error: "51JOB会话已退出，需要在平台页面完成登录后继续。" };
  } else if (scenario === "verification") {
    providers[1] = { ...providers[1]!, coverage: coverage("exhausted", 20), warnings: [] };
    providers[0] = { ...providers[0]!, status: "empty", coverage: coverage("exhausted", 1), error: undefined };
    providers[2] = { ...providers[2]!, status: "verification_required", coverage: coverage("gate", 1, 63),
      error: "BOSS直聘要求人工安全验证，请在平台页面完成验证；已返回卡片保留。" };
  } else if (scenario === "success" || scenario === "import-error") {
    return providers.map(provider => ({ ...provider,
      ...(scenario === "import-error" && provider.provider === "51job" ? { cardCount: 15, pagesVisited: 1 } : {}),
      ...(scenario === "import-error" && provider.provider === "boss" ? { cardCount: 269 } : {}),
      status: provider.cardCount || scenario === "import-error" && provider.provider === "51job" ? "ready" : "empty",
      coverage: { ...provider.coverage,
        ...(scenario === "import-error" && provider.provider === "51job" ? { pagesVisited: 1 } : {}),
        stopReason: "exhausted", partial: false }, warnings: [], error: undefined }));
  } else if (scenario === "cancelled") {
    return providers.map(provider => ({ ...provider, status: "cancelled",
      coverage: { ...provider.coverage, stopReason: "cancelled", partial: true }, warnings: [], error: undefined }));
  } else if (scenario === "running") {
    return providers.map(provider => ({ ...provider, status: "running", progressCardsCaptured: provider.cardCount,
      warnings: [], error: undefined }));
  }
  return providers;
}

function progressFor(scenario: Scenario): HarvestProgressState {
  const complete = scenario === "success";
  const sourcesComplete = complete || scenario === "import-error";
  const running = scenario === "running";
  const cancelled = scenario === "cancelled";
  return { stage: running || cancelled ? "platform-harvest" : "completed", stageIndex: running || cancelled ? 2 : 5, totalStages: 5,
    message: complete ? "本轮有限读取范围处理完毕；已确认岗位保留。" : "已返回的原站岗位与成功入库回执保留，未返回页面不计作已覆盖。",
    stats: { cardsFetched: TOTAL_CARDS, committedCards: complete ? TOTAL_CARDS : 1122,
      // Queue gauge is independent evidence, not inferred from discovered minus receipts.
      pendingCards: running ? 24 : 0, pendingBatches: running ? 1 : 0,
      failedCards: complete || running || cancelled ? 0 : 15, cancelledCards: cancelled ? 15 : 0,
      totalAdded: complete ? 122 : 42, totalUpdated: 1080, totalUnchanged: complete ? 18 : 0,
      queryTermIndex: running || cancelled ? 2 : 4, queryTermTotal: 4, queryTerm: ".NET",
      completedQueryTerms: running || cancelled ? 1 : 4, failedQueryTerms: sourcesComplete || cancelled || running ? 0 : 1,
      failedPlatforms: sourcesComplete || cancelled || running || scenario === "login" || scenario === "verification" ? 0 : 1,
      blockedPlatforms: scenario === "login" || scenario === "verification" ? 1 : 0,
      partialPlatforms: sourcesComplete ? 0 : 3, enrichmentSkipped: 1, enrichmentBackground: 1,
      ...(scenario === "query-error" ? { queryTermError: "检索词“.NET”读取失败：连接中断，未收到该检索词的最终分页回执。" } : {}),
    } };
}

function backgroundFor(scenario: BackgroundScenario): BackgroundEnrichmentState {
  if (scenario === "hidden") return { loading: false, refreshingSnapshot: false };
  return { loading: false, refreshingSnapshot: false,
    status: { revision: 42, pending: scenario === "working" ? 22 : 0, running: scenario === "working" ? 2 : 0,
      completed: 1120, failed: scenario === "error" ? 3 : 0,
      workerState: scenario === "working" ? "running" : scenario === "error" ? "error" : "idle",
      ...(scenario === "error" ? { workerError: "合成状态：本机补全工作进程暂不可用" } : {}),
    },
    ...(scenario === "error" ? { error: "后台补全暂不可用，任务已保留；仍可阅读岗位并继续搜索。" } : {}),
  };
}

const fixtureCss = `
.harvest-clarity-lab { min-height:100dvh; background:var(--color-paper); color:var(--color-ink); }
.harvest-clarity-header { display:flex;align-items:center;gap:16px;min-height:58px;padding:10px 24px;border-bottom:1px solid var(--color-line);background:var(--color-panel); }
.harvest-clarity-header strong { font:24px Georgia,serif; }
.harvest-clarity-header span { font-size:13px;color:var(--color-ink-muted); }
.harvest-clarity-layout { display:grid;grid-template-columns:minmax(0,600px) minmax(240px,320px);gap:24px;justify-content:center;align-items:start;padding:18px; }
.harvest-clarity-pane { width:100%;max-width:600px;height:calc(100dvh - 94px);min-height:480px;display:flex;flex-direction:column;margin:0!important;padding:0!important;overflow:hidden!important; }
.harvest-clarity-pane.is-compact { max-width:380px;justify-self:center; }
.harvest-clarity-pane > .atlas-results { width:100%;height:100%;min-height:0; }
.harvest-clarity-controls { min-width:0;padding:18px;border:1px solid var(--color-line);border-radius:14px;background:var(--color-panel); }
.harvest-clarity-controls h1 { margin:0 0 12px;font-size:18px; }
.harvest-clarity-controls fieldset { margin:0 0 18px;padding:0;border:0; }
.harvest-clarity-controls legend { margin-bottom:8px;font-size:14px;font-weight:600; }
.harvest-clarity-controls .fixture-buttons { display:flex;flex-wrap:wrap;gap:6px; }
.harvest-clarity-controls button { min-height:44px;padding:8px 12px;border:1px solid var(--color-line);border-radius:9px;background:var(--color-paper);color:var(--color-ink);font-family:inherit;font-size:14px;cursor:pointer; }
.harvest-clarity-controls button[aria-pressed=true] { border-color:var(--color-accent);background:var(--color-accent-soft); }
.harvest-clarity-controls button:focus-visible { outline:2px solid var(--color-accent);outline-offset:3px; }
.harvest-clarity-controls output { display:block;min-height:64px;padding:10px;border-radius:9px;background:var(--color-paper);font-size:13px;line-height:1.5;overflow-wrap:anywhere; }
.harvest-clarity-controls p { font-size:13px;line-height:1.65;color:var(--color-ink-muted); }
@media(max-width:760px) {
 .harvest-clarity-header { min-height:52px;padding:8px 12px;gap:10px; }
 .harvest-clarity-header strong { font-size:20px; }
 .harvest-clarity-header span { font-size:12px; }
 .harvest-clarity-layout { grid-template-columns:minmax(0,1fr);padding:10px;gap:14px; }
 .harvest-clarity-pane,.harvest-clarity-pane.is-compact { max-width:none;height:calc(100dvh - 72px);min-height:480px; }
 .harvest-clarity-controls { padding:14px; }
}
`;

function ClarityFixture() {
  const params = new URLSearchParams(location.search);
  const requestedHeight = Number(params.get("height"));
  const paneHeight = Number.isInteger(requestedHeight) && requestedHeight >= 320 && requestedHeight <= 1600 ? requestedHeight : undefined;
  const initial = params.get("scenario");
  const [scenario, setScenario] = useState<Scenario>(scenarios.some(([key]) => key === initial) ? initial as Scenario : "partial");
  const [background, setBackground] = useState<BackgroundScenario>("working");
  const [compact, setCompact] = useState(params.get("width") === "380");
  const [mobile, setMobile] = useState(() => matchMedia("(max-width:760px)").matches);
  const [action, setAction] = useState("尚未操作。所有按钮回调只在本验收页内记录，不发出采集、登录或入库请求。");
  const { theme, setTheme } = useUiPreferences();
  useEffect(() => {
    const media = matchMedia("(max-width:760px)");
    const changed = () => setMobile(media.matches);
    media.addEventListener("change", changed); return () => media.removeEventListener("change", changed);
  }, []);
  const providers = useMemo(() => providersFor(scenario), [scenario]);
  const progress = useMemo(() => progressFor(scenario), [scenario]);
  const view = useMemo<LiveHarvestView>(() => ({ capturedAt, query: { keyword: "C#", region: "上海市" },
    totalCards: TOTAL_CARDS, cards: scenario === "import-error" ? importErrorCards : cards, providers }), [providers, scenario]);
  const busy = scenario === "running";
  const failed = !busy && scenario !== "success" && scenario !== "cancelled";
  const actionProps = { providers,
    onResume: () => setAction("模拟动作：继续本轮未完成采集。未调用任何平台、服务或持久化写入。"),
    onOpenLogin: () => setAction("模拟动作：打开平台登录／验证入口。未打开真实浏览器或读取登录态。"),
    recoveryMessage: failed || scenario === "cancelled" ? "仍有待核对回执，可继续上次采集；已收到的岗位保留。" : undefined,
    recoveryPhase: failed ? "needs-attention" : scenario === "cancelled" ? "cancelled" : undefined,
  };
  function interceptSource(event: MouseEvent<HTMLElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    if (!anchor || !anchor.href.includes("example.invalid")) return;
    event.preventDefault(); setAction("模拟动作：查看合成来源原文。example.invalid链接已拦截，没有打开外部网站。");
  }
  return <div className="harvest-clarity-lab">
    <style>{fixtureCss}</style>
    <header className="harvest-clarity-header"><strong>BetterMe</strong><span>采集状态验收 · 纯合成数据 · 不连接岗位／简历服务</span></header>
    <main className="harvest-clarity-layout">
      <section className={`atlas-workspace atlas-experience harvest-clarity-pane ${compact ? "is-compact" : ""}`}
        data-pane-layout={mobile || compact ? "narrow" : "wide"} data-clarity-live-pane data-clarity-pane-height={paneHeight ?? "viewport"}
        style={paneHeight === undefined ? undefined : { height: paneHeight, minHeight: 0 }} onClickCapture={interceptSource}>
        <aside className="atlas-results is-live-source-results" aria-label="真实采集右栏组件验收">
          <div className="atlas-results-heading"><div className="atlas-results-heading-left">
            <h2>原站实时岗位 <span>{TOTAL_CARDS}</span></h2>
          </div></div>
          <AtlasHarvestProgress progress={progress} discoveredCards={TOTAL_CARDS} busy={busy}
            cancelled={scenario === "cancelled"} failed={failed} {...actionProps}
            importFailures={scenario === "import-error" ? importFailures : undefined}
            onCancel={busy ? () => { setScenario("cancelled"); setAction("模拟动作：停止当前采集；已有合成岗位卡片保留。"); } : undefined} />
          <AtlasBackgroundEnrichmentStatus state={backgroundFor(background)} />
          <AtlasLiveHarvestResults view={view} busy={busy} {...{ compactHeading: true }} />
        </aside>
      </section>
      <aside className="harvest-clarity-controls" aria-label="验收场景控制">
        <h1>采集状态可读性</h1>
        <fieldset><legend>合成回执场景</legend><div className="fixture-buttons">
          {scenarios.map(([key, label]) => <button type="button" key={key} aria-pressed={scenario === key}
            onClick={() => { setScenario(key); setAction(`已切换合成场景：${label}。未触发网络请求。`); }}>{label}</button>)}
        </div></fieldset>
        <fieldset><legend>后台补全</legend><div className="fixture-buttons">
          {([["working", "后台进行中"], ["done", "后台已完成"], ["error", "后台异常"], ["hidden", "无后台状态"]] as const)
            .map(([key, label]) => <button type="button" key={key} aria-pressed={background === key} onClick={() => setBackground(key)}>{label}</button>)}
        </div></fieldset>
        <fieldset><legend>布局与主题</legend><div className="fixture-buttons">
          <button type="button" aria-pressed={!compact} onClick={() => setCompact(false)}>桌面600px</button>
          <button type="button" aria-pressed={compact} onClick={() => setCompact(true)}>窄栏380px</button>
          <button type="button" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>{theme === "light" ? "切换深色" : "切换浅色"}</button>
        </div></fieldset>
        <p>岗位栏高度：{paneHeight === undefined ? "随验收窗口变化（默认）" : `${paneHeight}px（URL指定）`}。可用 height=600 复现真实受限栏高。</p>
        <output data-clarity-action role="status" aria-live="polite">{action}</output>
        <p>默认发现1220张、成功回执1122张、未确认15张。队列数量独立提供，不把数字之差猜成丢失岗位。所有岗位、企业、薪资、地址、错误和证据链接均为合成样本。</p>
        <p>检查：首屏原因和首张岗位可见；处理／来源详情默认闭合但统计保留；在真实组件内验证移动触控目标、键盘焦点及横向溢出。右侧控制按钮尺寸不计为产品验收。</p>
      </aside>
    </main>
  </div>;
}

const initialTheme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
createRoot(document.getElementById("root")!).render(<UiPreferencesProvider initialPreferences={{ locale: "zh", theme: initialTheme, workspaceThemeId: "graphite" }}>
  <ClarityFixture />
</UiPreferencesProvider>);
