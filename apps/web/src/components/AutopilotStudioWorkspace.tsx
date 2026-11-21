import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import type { FactBase, ProjectedResume } from "@better-me/core";
import useSWR from "swr";
import {
  useInstalledMicroApps,
  type InstalledMicroApp,
} from "../lib/micro-app-registry";
import {
  readOpportunityLibrary,
  type Opportunity,
} from "../lib/opportunities";
import { useUiPreferences } from "../lib/ui-preferences";
import { captureIdentityLease, currentPrincipal } from "../lib/identity";
import {
  buildSandboxedMicroApp,
  openReviewedPreset,
  PRESET_MICRO_APP_TEMPLATES,
  type BuiltMicroAppArtifact,
} from "../services/sandbox-build-client";
import { MicroAppPermissionModal } from "./MicroAppPermissionModal";
import { SandboxCodingLab } from "./SandboxCodingLab";
import {
  EMPTY_AUTOPILOT_TELEMETRY,
  fetchAutopilotKernelTelemetry,
  type AutopilotKernelTelemetry,
} from "./autopilot/autopilot-telemetry";
import { AutopilotNodeInspector } from "./autopilot/AutopilotNodeInspector";
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  ShieldCheck,
  Terminal,
  ChevronRight,
  RotateCw,
  Orbit,
  BookmarkCheck,
  Eye,
  Layers,
  Zap,
  Lock,
  Code2,
  Activity,
  Sun,
  Moon,
  Sliders,
  Loader2,
  CheckCircle2,
  Mic,
  X,
} from "lucide-react";
import { openSystemSettings } from "../lib/settings-navigation";
import { isStaticPublicPreview } from "../lib/runtime-mode";
import { useLocalAgentRuntime } from "../lib/local-agent-runtime";
import { StudioRuntimeIcon } from "./StudioRuntimeIcon";
import "./autopilot-studio.css";
import {
  AGENT_KERNELS,
  AgentTotemIcon,
  AgentMascotSprite,
  type AgentKernelConfig,
} from "./autopilot/AutopilotAgentSprites";
import {
  PERIMETER_20_SLOTS,
  STUDIO_20_NODES,
  AUTOPILOT_CARDS,
  getNodeTagBadge,
  localizeStudioNode,
  type StudioNode,
} from "./autopilot/autopilot-nodes";
import { BlueprintMicroChamber } from "./autopilot/BlueprintMicroChamber";
import { CyberJobCard3D, type JobPipelineItem } from "./autopilot/CyberJobCard3D";
import {
  opportunityToPipelineItem,
  stageLabel,
} from "./autopilot/autopilot-pipeline-mappers";
import { Button, EmptyState, PageHeader, StatusPill } from "../design-system";

export {
  AGENT_KERNELS,
  AgentTotemIcon,
  AgentMascotSprite,
  type AgentKernelConfig,
  STUDIO_20_NODES,
  AUTOPILOT_CARDS,
  getNodeTagBadge,
  type StudioNode,
  type JobPipelineItem,
};

// Real opportunity library mappers live in ./autopilot/autopilot-pipeline-mappers.ts

// ============================================================================
// 9. 主工作区组件：AutopilotStudioWorkspace
// ============================================================================
export type AutopilotStudioWorkspaceProps = {
  active?: boolean;
  factBase?: FactBase;
  resume?: ProjectedResume;
  projectedResume?: ProjectedResume;
  targetQuery?: string;
  initialOpportunityId?: string;
  onOpenMicroApp?: (app: InstalledMicroApp) => void;
  onOpenOpportunity?: (id: string) => void;
  onOpenOpportunitySources?: () => void;
  onAnalyzeOpportunity?: (job: Opportunity) => void;
  onOpenApp?: (appId: string) => void;
  onNavigateToDraft?: () => void;
  onClose?: () => void;
};

export function AutopilotStudioWorkspace(props: AutopilotStudioWorkspaceProps) {
  const active = props.active ?? true;
  const ownerId = currentPrincipal()?.id;
  const libraryKey = ownerId ? ["studio:opportunity-library", ownerId] : "studio:opportunity-library";
  const { data: libraryState, mutate } = useSWR(active ? libraryKey : null, () => readOpportunityLibrary(), { refreshInterval: 5_000 });
  const staticPreview = isStaticPublicPreview();
  const { data: kernelTelemetry, mutate: mutateTelemetry } = useSWR(active && ownerId && !staticPreview ? ["studio:kernel-telemetry", ownerId] : null, ([, summaryOwner]) => fetchAutopilotKernelTelemetry(summaryOwner), { refreshInterval: 8_000 });
  useEffect(() => {
    if (!active) return;
    const sync = () => { void mutate(); void mutateTelemetry(); };
    window.addEventListener("betterme:opportunities-updated", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("betterme:opportunities-updated", sync);
      window.removeEventListener("storage", sync);
    };
  }, [active, mutate, mutateTelemetry]);
  const jobs = libraryState?.library?.jobs ?? [];
  return (
    <AutopilotWorkbenchPrototype
      {...props}
      opportunities={jobs}
      loadingOpportunities={!libraryState}
      opportunityError={libraryState?.error}
      kernelTelemetry={kernelTelemetry}
      onRefreshOpportunities={active ? () => { void mutate(); void mutateTelemetry(); } : undefined}
    />
  );
}

export function AutopilotWorkbenchPrototype({
  factBase,
  resume,
  projectedResume,
  targetQuery: _targetQuery = "",
  initialOpportunityId,
  opportunities = [],
  loadingOpportunities = false,
  opportunityError = "",
  kernelTelemetry = EMPTY_AUTOPILOT_TELEMETRY,
  onRefreshOpportunities,
  onOpenMicroApp,
  onOpenOpportunity,
  onOpenOpportunitySources,
  onAnalyzeOpportunity,
  onOpenApp: _onOpenApp,
  onNavigateToDraft: _onNavigateToDraft,
  onClose: _onClose,
}: AutopilotStudioWorkspaceProps & {
  opportunities?: Opportunity[];
  loadingOpportunities?: boolean;
  opportunityError?: string;
  kernelTelemetry?: AutopilotKernelTelemetry;
  onRefreshOpportunities?: () => void;
}) {
  const { theme, setTheme, t } = useUiPreferences();

  // 1. 工坊身份跟随系统设置；视觉配色不再决定执行运行时。
  const { selectedRuntime, selectedRuntimeId, ready: runtimeReady, loading: runtimeLoading, online } = useLocalAgentRuntime();
  const runtimeName = selectedRuntime?.name ?? (selectedRuntimeId ? t("所选 Agent 暂不可用", "Selected Agent is unavailable") : t("未配置 Agent", "No Agent configured"));
  const runtimeStatus = runtimeLoading ? t("正在检测", "Detecting") : online === false ? t("Host 未连接", "Host not connected") : runtimeReady ? t("本机可用", "Available locally") : selectedRuntimeId ? t("暂不可用", "Unavailable") : t("待配置", "Needs setup");
  const currentAgent: AgentKernelConfig = {
    ...AGENT_KERNELS["opus-5.5"]!,
    id: selectedRuntimeId || "unconfigured",
    shortName: runtimeName, brandName: runtimeName, fullTitle: runtimeName,
    cliHeaderTitle: runtimeName, cliVersion: selectedRuntime?.version ?? t("版本未提供", "Version not provided"),
    heroBannerPrefix: `${runtimeName} + FACTBASE`, mascotName: runtimeName,
    mascotRole: t("跟随系统设置 · 本机执行入口", "Follows system settings · local run entry"),
    modelSpec: selectedRuntime?.version ?? t("模型由运行时配置", "Model set by the runtime"),
    computeBadge: runtimeStatus, signatureQuote: t("执行入口与系统设置保持一致。", "The run entry matches system settings."),
  };
  const studioNodes = useMemo(() => STUDIO_20_NODES.map(node => node.id === 1
    ? { ...node, name: runtimeName, sub: t(`系统设置 · ${runtimeStatus}`, `System settings · ${runtimeStatus}`) }
    : localizeStudioNode(node, t)), [runtimeName, runtimeStatus, t]);

  // 2. 工作台模式 ('studio' | 'space3d' | 'split')
  const [workspaceMode, setWorkspaceMode] = useState<"studio" | "space3d" | "split">("studio");

  // 3. 20-节点环流履带控制
  const [conveyorShiftMode, setConveyorShiftMode] = useState(true);
  const [autoLoopPlaying, setAutoLoopPlaying] = useState(false);
  const [activeNodeIdx, setActiveNodeIdx] = useState(12); // 默认聚焦 #13 ATS / 版式
  const [terminalTab, setTerminalTab] = useState<"terminal" | "inspector">("terminal");

  // 4. 真实岗位队列与 3D 卡状态
  const jobs = useMemo(() => opportunities.map((job, idx) => opportunityToPipelineItem(job, idx, t)), [opportunities, t]);
  const sourcedJobsCount = useMemo(() => opportunities.filter((job) => Boolean(job.sourceUrl)).length, [opportunities]);

  const [activeJobId, setActiveJobId] = useState<string>(() => initialOpportunityId || opportunities[0]?.id || "");
  const [flipped3DMap, setFlipped3DMap] = useState<Record<string, boolean>>({});
  const [space3DLayout, setSpace3DLayout] = useState<"grid" | "carousel">("grid");

  // 5. 模拟器参数 (#19 薪酬与时薪)
  const [simBaseK, setSimBaseK] = useState(42);
  const [simMonths, setSimMonths] = useState(15);
  const [simWeeklyHours, setSimWeeklyHours] = useState(37.5);

  // 6. 挂载沙箱应用列表 (#20 沙箱应用工坊)
  const installedMicroApps = useInstalledMicroApps();
  const [buildStatus, setBuildStatus] = useState<"idle" | "building" | "success" | "error">("idle");
  const [buildingStep, setBuildingStep] = useState<string>("");
  const [buildingAppId, setBuildingAppId] = useState<string | null>(null);
  const [pendingArtifact, setPendingArtifact] = useState<BuiltMicroAppArtifact | null>(null);
  const [isPermissionModalOpen, setIsPermissionModalOpen] = useState(false);
  const pendingBuild = useRef<ReturnType<typeof captureIdentityLease> | null>(null);

  const [toast, setToast] = useState<{ title: string; desc: string } | null>(null);
  const toastTimer = useRef<number | null>(null);
  useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current); }, []);

  const activeJob = useMemo(() => jobs.find((j) => j.id === activeJobId) || jobs[0] || null, [jobs, activeJobId]);
  const activeNode = studioNodes[activeNodeIdx]!;
  const collected3DJobs = jobs;
  const activeResumeProjection = projectedResume ?? resume;
  const resumeSectionCount = activeResumeProjection?.experiences?.length ?? 0;

  // FactBase claim count & summary
  const claimCount = useMemo(() => {
    let count = 0;
    if (factBase?.experiences) {
      for (const exp of factBase.experiences) count += exp.claims?.length || 0;
    }
    return count;
  }, [factBase]);

  const operatorName = factBase?.profile?.displayName?.zh || factBase?.profile?.displayName?.en || t("本地用户", "Local user");
  const operatorRole = factBase?.profile?.targetRoles?.[0]?.zh || t("职业方向未填写", "Target role not set");

  const triggerToast = useCallback((title: string, desc: string) => {
    setToast({ title, desc });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      setToast((prev) => (prev?.title === title ? null : prev));
      toastTimer.current = null;
    }, 3800);
  }, []);

  // 自动环流定时器
  useEffect(() => {
    if (!runtimeReady || !autoLoopPlaying || workspaceMode === "space3d") return;
    const timer = setInterval(() => {
      setActiveNodeIdx((prev) => (prev + 1) % STUDIO_20_NODES.length);
    }, 2400);
    return () => clearInterval(timer);
  }, [autoLoopPlaying, workspaceMode, runtimeReady]);

  useEffect(() => { setAutoLoopPlaying(false); }, [selectedRuntimeId, runtimeReady]);

  // 键盘快捷键 (Space 暂停/继续，左右箭头单步)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || (e.target instanceof HTMLElement && e.target.closest("input,textarea,select,button,summary,[contenteditable=true],[role=button],[role=dialog]"))) return;
      if (e.code === "Space") {
        if (!runtimeReady) return;
        e.preventDefault();
        setAutoLoopPlaying((p) => !p);
      } else if (e.code === "ArrowRight") {
        setAutoLoopPlaying(false);
        setActiveNodeIdx((p) => (p + 1) % STUDIO_20_NODES.length);
      } else if (e.code === "ArrowLeft") {
        setAutoLoopPlaying(false);
        setActiveNodeIdx((p) => (p - 1 + STUDIO_20_NODES.length) % STUDIO_20_NODES.length);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [runtimeReady]);

  // 20 张卡片在 6x6 外环物理槽位坐标映射
  const positionedCards = useMemo(() => {
    const spotlightSlotIndex = 2; // Top Row, Col 3
    return studioNodes.map((node, nodeIndex) => {
      const slotIndex = conveyorShiftMode
        ? (nodeIndex - activeNodeIdx + spotlightSlotIndex + 20) % 20
        : nodeIndex;
      const slot = PERIMETER_20_SLOTS[slotIndex]!;
      const isSpotlight = nodeIndex === activeNodeIdx;
      return {
        node,
        nodeIndex,
        slotIndex,
        slot,
        isSpotlight,
      };
    });
  }, [activeNodeIdx, conveyorShiftMode, studioNodes]);

  // 当前节点附近的能力流程，用于导航。
  const visibleCapabilityFlow = useMemo(() => {
    const list = [];
    for (let offset = -4; offset <= 0; offset++) {
      const idx = (activeNodeIdx + offset + STUDIO_20_NODES.length) % STUDIO_20_NODES.length;
      list.push({
        ...studioNodes[idx]!,
        isCurrent: offset === 0,
      });
    }
    return list;
  }, [activeNodeIdx, studioNodes]);

  // 切换至 3D 机会金库查看已收藏卡片
  const handleOpen3DVault = () => {
    setWorkspaceMode("space3d");
    triggerToast(
      t(`✦ 已切换至 3D 机会金库 (${collected3DJobs.length})`, `Switched to 3D opportunity vault (${collected3DJobs.length})`),
      t("仅展示本地机会库已保存的真实岗位与当前状态。", "Showing only real saved opportunities and current stages from your local library.")
    );
  };

  const openArtifact = (app: InstalledMicroApp) => {
    if (onOpenMicroApp) onOpenMicroApp(app);
    else window.dispatchEvent(new window.CustomEvent("betterme:open-micro-app", { detail: app }));
  };
  const handleOpenInstalledApp = openArtifact;

  // The Host verifies and compiles a pinned preset. Only the user's next action can open it.
  const handleTriggerSandboxBuild = async (appId: string) => {
    const template = PRESET_MICRO_APP_TEMPLATES[appId];
    if (!template || (pendingBuild.current && !pendingBuild.current.signal.aborted && buildStatus === "building")) return;
    const lease = captureIdentityLease();
    pendingBuild.current = lease;
    setPendingArtifact(null);
    setIsPermissionModalOpen(false);
    setBuildingAppId(appId);
    setBuildStatus("building");
    setBuildingStep(t("正在请求本机宿主核对内置模板并编译…", "Asking the local host to check and compile the built-in template…"));
    try {
      const artifact = await buildSandboxedMicroApp({ appId, ...template });
      lease.assert();
      if (pendingBuild.current !== lease) return;
      setBuildingStep(t("宿主检查通过，等待你的运行或固定授权。", "Host check passed; waiting for you to run it or authorize pinning."));
      setPendingArtifact(artifact);
      setBuildStatus("success");
      setIsPermissionModalOpen(true);
    } catch (err) {
      if (lease.signal.aborted || pendingBuild.current !== lease) return;
      setBuildStatus("error");
      triggerToast(t("预设未构建", "Preset not built"), err instanceof Error ? err.message : String(err));
    } finally {
      if (pendingBuild.current === lease) setBuildingAppId(null);
    }
  };

  const handleApproveArtifact = (artifact: BuiltMicroAppArtifact, pinToDock: boolean) => {
    if (!pendingBuild.current || pendingBuild.current.signal.aborted || artifact !== pendingArtifact) return;
    try {
      pendingBuild.current.assert();
      openReviewedPreset(artifact, pinToDock, openArtifact);
      triggerToast(t(`已打开「${artifact.name}」`, `Opened ${artifact.name}`), pinToDock ? t("已按你的授权固定到应用 Dock。", "Pinned to the app Dock as you authorized.") : t("仅本次打开，未写入应用列表。", "Opened this time only; not added to the app list."));
    } catch (err) {
      triggerToast(t("预设未打开", "Preset not opened"), err instanceof Error ? err.message : String(err));
    } finally {
      setIsPermissionModalOpen(false);
      setPendingArtifact(null);
    }
  };

  // #19 真实净时薪精算
  const netHourlyWage = useMemo(() => {
    const annualGross = simBaseK * 1000 * simMonths;
    const annualNetWithFund = annualGross * 0.88;
    const annualHours = simWeeklyHours * 50;
    return Math.round(annualNetWithFund / annualHours);
  }, [simBaseK, simMonths, simWeeklyHours]);

  // 底部 ASCII 块状进度条
  const progressPercent = Math.round(((activeNodeIdx + 1) / STUDIO_20_NODES.length) * 100);
  const filledBlocks = Math.round(((activeNodeIdx + 1) / STUDIO_20_NODES.length) * 24);
  const asciiBar = "■".repeat(filledBlocks) + "░".repeat(24 - filledBlocks);

  return (
    <div
      style={{
        backgroundColor: "var(--ap-tone-28)",
        backgroundImage: `
          ${currentAgent.ambientBg},
          radial-gradient(${"var(--ap-tone-29)"} 1px, transparent 0),
          linear-gradient(to right, ${"var(--ap-tone-30)"} 1px, transparent 1px),
          linear-gradient(to bottom, ${"var(--ap-tone-30)"} 1px, transparent 1px)
        `,
        backgroundSize: "100% 100%, 16px 16px, 64px 64px, 64px 64px",
      }}
      data-theme={theme}
      className={`studio-workshop relative w-full h-full min-h-0 overflow-hidden flex flex-col justify-between select-none transition-colors duration-500 font-sans ${theme === "light" ? "text-slate-900" : "text-slate-100"}`}
    >
      {/* Toast 提示横幅 */}
      {toast && (
        <div
          style={{
            borderColor: currentAgent.primaryHex,
            boxShadow: `0 16px 40px -8px rgba(0,0,0,0.85), 0 0 28px ${currentAgent.glowRgba}`,
          }}
          className="fixed top-16 right-4 z-[130] w-96 max-w-[calc(100vw-32px)] p-3.5 rounded-2xl bg-[#0A101A]/95 border backdrop-blur-2xl flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-200"
        >
          <div className="p-1.5 rounded-xl bg-white/[0.04] border border-white/10 shrink-0">
            <StudioRuntimeIcon agentId={currentAgent.id} className="w-8 h-7" />
          </div>
          <div className="font-mono text-xs leading-relaxed min-w-0 flex-1">
            <div style={{ color: currentAgent.primaryHex }} className="font-bold">
              {toast.title}
            </div>
            <div className="text-slate-300 mt-0.5 font-sans text-[11.5px]">{toast.desc}</div>
          </div>
          <button
            type="button"
            aria-label={t("关闭提示", "Dismiss notification")}
            onClick={() => setToast(null)}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition shrink-0"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* ====================================================================
          1. 顶部 STUDIO HERO BANNER
         ==================================================================== */}
      <header className="relative z-30 px-4 pt-2.5 pb-1 flex items-center justify-between gap-4 shrink-0">
        {/* 左侧：Operator Medallion */}
        <div className="flex items-center gap-3">
          <div
            style={{
              backgroundColor: "var(--ap-tone-31)",
              boxShadow: theme === "light" ? "0 4px 14px rgba(0,0,0,0.06)" : "0 10px 28px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,0.1)",
              borderColor: "var(--ap-tone-32)",
            }}
            className="px-3 py-1.5 rounded-xl border flex items-center gap-2.5"
          >
            <div
              style={{
                borderColor: currentAgent.primaryHex,
                boxShadow: `0 0 12px ${currentAgent.glowRgba}`,
              }}
              className="w-9 h-9 rounded-full bg-[#060A0F] border-2 flex items-center justify-center relative shrink-0"
            >
              <span className="font-mono font-black text-xs text-white">
                {operatorName.slice(0, 2).toUpperCase()}
              </span>
              <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-[#060A0F]" />
            </div>
            <div className="font-mono">
              <div className="flex items-center gap-1.5">
                <span className={`text-xs font-bold ${theme === "light" ? "text-slate-800" : "text-white"}`}>
                  @{operatorName}
                </span>
                <span className="px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[9px] font-bold">
                  FactBase: {claimCount}
                </span>
              </div>
              <div className={`text-[10px] ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                {operatorRole}
              </div>
            </div>
          </div>

          {/* 队列岗位快速切换胶囊 */}
          <div className="hidden xl:flex flex-col gap-0.5 font-mono">
            <span className="text-[9px] text-slate-500 uppercase tracking-widest">{t("真实岗位队列", "LIVE OPPORTUNITY QUEUE")}</span>
            <div className={`flex items-center gap-1 p-0.5 rounded-lg ${theme === "light" ? "bg-white border-slate-200" : "bg-[#0A1018] border-[#1B2A3D]"} border`}>
              {jobs.length > 0 ? (
                jobs.slice(0, 4).map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    data-queue-job-id={j.id}
                    onClick={() => {
                      setActiveJobId(j.id);
                      triggerToast(t(`✦ 目标切换：${j.company}`, `Target switched: ${j.company}`), t(`岗位「${j.role}」已载入控制台`, `${j.role} loaded into console`));
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] transition ${
                      activeJob?.id === j.id
                        ? theme === "light"
                          ? "bg-amber-100 text-amber-900 border border-amber-300 font-bold shadow-sm"
                          : "bg-amber-400/20 text-amber-300 border border-amber-400/40 font-bold"
                        : theme === "light"
                          ? "text-slate-600 hover:text-slate-900"
                          : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {j.shortName}
                  </button>
                ))
              ) : (
                <span className={`px-2 py-0.5 text-[10px] ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                  {t("未接入真实岗位", "No real jobs yet")}
                </span>
              )}
              {onOpenOpportunitySources && (
                <button
                  type="button"
                  onClick={onOpenOpportunitySources}
                  className="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition"
                >
                  {t("接入真实岗位", "Connect real opportunities")}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 中间：全链路自动化工坊核心标题 */}
        <PageHeader
          compact
          headingLevel={1}
          className="border-0 p-0 m-0"
          eyebrow={<span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />BETTERME AUTOPILOT · 20-NODE DAG</span>}
          title={t("求职全链路自动化工坊", "End-to-end job-search automation studio")}
          meta={<StatusPill tone={jobs.length > 0 ? "accent" : "neutral"}>{jobs.length} {t("岗位", "jobs")} · {claimCount} {t("事实", "claims")}</StatusPill>}
        />

        {/* 右侧：遥测指标舱 + 刷新 + 前往系统设置 + 主题切换 */}
        <div className="flex items-center gap-2 shrink-0">
          {/* 实时真实数据计数胶囊 */}
          <div className={`studio-live-summary hidden md:flex items-center gap-2 px-2.5 py-1.5 rounded-xl border font-mono text-[11px] whitespace-nowrap shrink-0 ${
            theme === "light"
              ? "bg-white border-slate-200 text-slate-700 shadow-sm"
              : "bg-[#0A1018] border-[#1E2E42] text-slate-300"
          }`} aria-label={t("真实数据概览", "Real data summary")}>
            <span className="flex items-center gap-1.5 shrink-0">
              <span className={`w-2 h-2 rounded-full ${jobs.length > 0 ? "bg-emerald-500 animate-pulse" : "bg-slate-400"}`} />
              <span className="font-semibold">{jobs.length}{t(" 岗位", " jobs")}</span>
            </span>
            <span className="opacity-30">·</span>
            <span className="text-amber-500 font-semibold shrink-0">{sourcedJobsCount}{t(" 带来源", " sourced")}</span>
            <span className="opacity-30">·</span>
            <span className="text-cyan-500 font-semibold shrink-0">{t(`事实库要点 ${claimCount}`, `${claimCount} fact claims`)}</span>
            {kernelTelemetry.authenticated && (
              <>
                <span className="opacity-30">·</span>
                <span className="text-emerald-500 font-semibold shrink-0">
                  {t(`内核任务 ${kernelTelemetry.totalTasks}`, `${kernelTelemetry.totalTasks} tasks`)}
                </span>
              </>
            )}
          </div>

          {onRefreshOpportunities && (
            <button
              type="button"
              onClick={onRefreshOpportunities}
              className={`px-2.5 py-1.5 rounded-xl border flex items-center gap-1.5 font-mono text-xs font-bold transition ${
                theme === "light"
                  ? "bg-white border-slate-300 text-slate-800 hover:bg-slate-50 shadow-sm"
                  : "bg-[#0A1018] border-[#1E2E42] text-slate-200 hover:bg-[#121c2a]"
              }`}
            >
              <RotateCw className="w-3.5 h-3.5 text-emerald-500" />
              <span>{t("刷新", "Refresh")}</span>
            </button>
          )}

          {/* 系统设置快捷入口 (配置 CLI Agent 与模型) */}
          <button
            type="button"
            onClick={() => openSystemSettings("tools")}
            className={`px-3 py-1.5 rounded-xl border flex items-center gap-1.5 font-mono text-xs font-bold transition hover:scale-[1.02] ${
              theme === "light"
                ? "bg-white border-slate-300 text-slate-800 hover:bg-slate-50 shadow-sm"
                : "bg-[#0A1018] border-[#1E2E42] text-slate-200 hover:bg-[#121c2a]"
            }`}
            title={t("在系统设置中配置本地 CLI Agent 与大模型内核", "Configure local CLI agents and model kernels in System settings")}
          >
            <Sliders className="w-3.5 h-3.5 text-cyan-500" />
            <span>{t("系统设置", "System settings")}</span>
          </button>

          {/* 浅色/深色模式一键切换 */}
          <button
            type="button"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            className={`p-2 rounded-xl border flex items-center justify-center transition ${
              theme === "light"
                ? "bg-white border-slate-200 text-slate-700 hover:bg-slate-50 shadow-sm"
                : "bg-[#0A1018] border-[#1E2E42] text-slate-300 hover:bg-[#121c2a]"
            }`}
            title={theme === "light" ? t("切换深色黑曜石工业风", "Switch to the dark obsidian industrial look") : t("切换浅色钛金风", "Switch to the light titanium look")}
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>
      </header>

      {/* ====================================================================
          2. 中央主舞台：20-NODE 环流工坊 OR 3D 机会金库
         ==================================================================== */}
      <main className="relative z-10 flex-1 min-h-0 w-full px-3 py-1 flex items-center justify-center">
        {workspaceMode === "studio" && (
          <div className="relative w-full h-full max-w-[1580px] grid grid-cols-6 grid-rows-6 gap-2">
            {/* 游走 AI Mascot 精灵 */}
            <div hidden={!runtimeReady} data-testid="studio-agent-courier"
              style={{
                top: `${(positionedCards.find((c) => c.isSpotlight)?.slot.row || 1) * 16 - 2}%`,
                left: `${(positionedCards.find((c) => c.isSpotlight)?.slot.col || 3) * 16 - 4}%`,
              }}
              className="pointer-events-none absolute z-40 transition-all duration-700 ease-out flex flex-col items-center"
            >
              <div style={{ animation: "ap-rover-float 2.2s ease-in-out infinite" }}>
                <StudioRuntimeIcon agentId={currentAgent.id} className="w-10 h-10 drop-shadow-[0_4px_14px_rgba(245,158,11,0.6)]" />
              </div>
            </div>

            {/* 20 张外环技能卡片 */}
            {positionedCards.map(({ node, nodeIndex, slot, isSpotlight }) => (
              <button
                type="button"
                aria-pressed={isSpotlight}
                key={node.id}
                data-node-id={node.id}
                aria-label={t(`打开 ${node.code} ${node.name}`, `Open ${node.code} ${node.name}`)}
                onClick={() => {
                  setAutoLoopPlaying(false);
                  setActiveNodeIdx(nodeIndex);
                  setTerminalTab("inspector");
                }}
                style={{
                  gridRowStart: slot.row,
                  gridColumnStart: slot.col,
                  backgroundColor: theme === "light"
                    ? "#FFFFFF"
                    : isSpotlight
                      ? "rgba(18, 28, 44, 0.98)"
                      : "rgba(10, 16, 26, 0.92)",
                  borderColor: isSpotlight
                    ? "var(--ap-tone-12)"
                    : "var(--ap-tone-33)",
                  boxShadow: isSpotlight
                    ? theme === "light"
                      ? "0 0 0 2px rgba(14, 165, 233, 0.45), 0 14px 34px -4px rgba(14, 165, 233, 0.35), 0 4px 12px rgba(15, 23, 42, 0.08), inset 0 1px 0 #FFFFFF"
                      : "0 0 0 2px rgba(56, 189, 248, 0.55), 0 18px 40px -6px rgba(0, 0, 0, 0.85), 0 0 28px rgba(56, 189, 248, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.2)"
                    : theme === "light"
                      ? "0 4px 14px -2px rgba(15, 23, 42, 0.08), 0 2px 5px -1px rgba(15, 23, 42, 0.04), inset 0 1px 0 #FFFFFF"
                      : "0 6px 18px -3px rgba(0, 0, 0, 0.65), 0 1px 2px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.09)",
                  animation: isSpotlight
                    ? theme === "light"
                      ? "ap-spotlight-breathe 2.4s ease-in-out infinite"
                      : "ap-spotlight-breathe-dark 2.4s ease-in-out infinite"
                    : undefined,
                }}
                className={`relative rounded-xl border p-2 flex flex-col justify-between overflow-hidden cursor-pointer transition-all duration-300 group hover:scale-[1.01] ${
                  isSpotlight ? "z-20" : ""
                }`}
              >
                {/* 顶部微排版 */}
                <div className="flex items-start justify-between gap-1 font-mono">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`px-1.5 py-0.2 rounded text-[10px] font-black shrink-0 transition-colors ${
                        isSpotlight
                          ? "bg-cyan-500 text-slate-950 shadow-sm"
                          : theme === "light"
                            ? "bg-slate-100 text-slate-700 border border-slate-200"
                            : "bg-[#141E2B] text-slate-400 border border-white/5"
                      }`}
                    >
                      {node.code}
                    </span>
                    <span className={`text-xs font-bold truncate ${
                      isSpotlight
                        ? theme === "light"
                          ? "text-cyan-900 font-black"
                          : "text-cyan-300 font-black"
                        : theme === "light"
                          ? "text-slate-800"
                          : "text-slate-200"
                    }`}>
                      {node.name}
                    </span>
                  </div>
                  <span className={`px-1.5 py-0.2 rounded text-[8.5px] font-bold font-mono border uppercase tracking-wider shrink-0 ${getNodeTagBadge(node.tag, theme)}`}>
                    {node.tag}
                  </span>
                </div>

                {/* 能力描述 */}
                <div className="my-1">
                  <div className={`text-[10px] truncate ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                    {node.sub}
                  </div>
                </div>

                {/* 下半部微缩蓝图舱 (自动适配深色黑曜石 / 浅色钛金风) */}
                <BlueprintMicroChamber
                  type={node.vizType}
                  isSpotlight={isSpotlight}
                  code={node.code}
                  agent={currentAgent}
                  theme={theme}
                />
              </button>
            ))}

            {/* 中央 4x4 控制台/深度工件工作台 */}
            <div
              style={{
                backgroundColor: "var(--ap-tone-34)",
                borderColor: currentAgent.borderAccent,
                boxShadow: `0 24px 70px -16px rgba(0,0,0,0.92), 0 0 32px ${currentAgent.glowRgba}`,
              }}
              className="row-start-2 row-end-6 col-start-2 col-end-6 rounded-2xl border flex flex-col overflow-hidden z-20"
            >
              {/* 控制台顶栏 */}
              <div
                style={{
                  backgroundColor: "var(--ap-tone-35)",
                  borderColor: "var(--ap-tone-36)",
                }}
                className="h-10 px-4 border-b flex items-center justify-between shrink-0 font-mono text-xs select-none"
              >
                {/* 顶栏左侧品牌 */}
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => openSystemSettings("tools")} aria-label={t(`${runtimeName}，打开 Agent 设置`, `${runtimeName}, open Agent settings`)} className="studio-agent-trigger flex items-center gap-1.5 font-bold" style={{ color: theme === "light" ? "#925509" : currentAgent.primaryHex }}>
                    <StudioRuntimeIcon agentId={currentAgent.id} className="w-6 h-6" />
                    <span>{currentAgent.cliHeaderTitle}</span>
                    <Sliders className="w-3 h-3" aria-hidden="true" />
                  </button>

                  {/* 视图 Tab 切换 */}
                  <div className={`flex items-center gap-1 p-0.5 rounded-lg border ${
                    theme === "light"
                      ? "bg-slate-200/80 border-slate-300"
                      : "bg-black/40 border-white/10"
                  }`}>
                    <button
                      onClick={() => setTerminalTab("terminal")}
                      className={`px-2.5 py-1 rounded text-[11px] font-bold transition flex items-center gap-1.5 ${
                        terminalTab === "terminal"
                          ? "bg-cyan-500 text-slate-950 shadow"
                          : theme === "light"
                            ? "text-slate-600 hover:text-slate-900"
                            : "text-slate-400 hover:text-white"
                      }`}
                    >
                      <Terminal className="w-3 h-3" />
                      <span>{t("能力流程", "Capability flow")}</span>
                    </button>
                    <button
                      onClick={() => setTerminalTab("inspector")}
                      className={`px-2.5 py-1 rounded text-[11px] font-bold transition flex items-center gap-1.5 ${
                        terminalTab === "inspector"
                          ? "bg-cyan-500 text-slate-950 shadow"
                          : theme === "light"
                            ? "text-slate-600 hover:text-slate-900"
                            : "text-slate-400 hover:text-white"
                      }`}
                    >
                      <Eye className="w-3 h-3" />
                      <span>{t("深度工件舱", "Artifact inspector")} (#{activeNode.code})</span>
                    </button>
                  </div>
                </div>

                {/* 顶栏右侧快捷操作 */}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleOpen3DVault}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold font-mono transition flex items-center gap-1 ${
                      theme === "light"
                        ? "text-amber-900 bg-amber-100 border border-amber-300 hover:bg-amber-200"
                        : "text-amber-300 bg-amber-400/15 border border-amber-400/35 hover:bg-amber-400/25"
                    }`}
                  >
                    <Orbit className="w-3 h-3" />
                    <span>{t(`3D 机会金库 (${collected3DJobs.length})`, `3D opportunity vault (${collected3DJobs.length})`)}</span>
                  </button>

                  <div className="flex items-center gap-1.5 text-slate-500 text-[11px]">
                    <span className={`w-2 h-2 rounded-full ${runtimeReady ? "bg-emerald-400" : "bg-slate-400"}`} />
                    <span role="status">{runtimeStatus}</span>
                  </div>
                </div>
              </div>

              {/* 控制台内容区 */}
              <div className="flex-1 min-h-0 overflow-y-auto p-4 font-mono text-xs leading-relaxed">
                {terminalTab === "terminal" ? (
                  <div className="space-y-4">
                    {/* Welcome Banner */}
                    <div
                      style={{
                        backgroundColor: "var(--ap-tone-37)",
                        borderColor: theme === "light" ? "var(--ap-tone-36)" : currentAgent.borderAccent,
                        boxShadow: theme === "light" ? "0 4px 16px rgba(0,0,0,0.03)" : undefined,
                      }}
                      className="p-4 rounded-xl border flex items-start gap-4"
                    >
                      <StudioRuntimeIcon agentId={currentAgent.id} className="w-14 h-14 shrink-0" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <h2 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-white"
                          }`}>
                            <span>{t("BetterMe Autopilot 工作台", "BetterMe Autopilot workbench")} · {operatorName}</span>
                            <span className={`text-xs px-2 py-0.5 rounded border ${
                              theme === "light"
                                ? "bg-cyan-50 text-cyan-800 border-cyan-300 font-bold"
                                : "bg-cyan-500/20 text-cyan-300 border-cyan-500/30"
                            }`}>
                              {t("真实数据模式", "Real data mode")} · {runtimeStatus}
                            </span>
                          </h2>
                          <div className={`flex items-center gap-1 text-[11px] font-bold ${
                            theme === "light"
                              ? "text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200"
                              : "text-emerald-400"
                          }`}>
                            <Lock className="w-3 h-3" />
                            <span>{t(`FactBase ${claimCount} 条要点 · ${resumeSectionCount} 段经历`, `FactBase ${claimCount} claims · ${resumeSectionCount} entries`)}</span>
                          </div>
                        </div>

                        <div className={`text-[11px] flex items-center gap-3 flex-wrap ${
                          theme === "light" ? "text-slate-600" : "text-slate-400"
                        }`}>
                          <span>{t("求职角色：", "Target role: ")}{operatorRole}</span>
                          <span>•</span>
                          <span className={theme === "light" ? "text-cyan-800 font-semibold" : "text-cyan-300"}>
                            {t("只读取本地真实机会与经历，零虚构指标", "Reads local opportunities & facts only, zero invented telemetry")}
                          </span>
                        </div>

                        <p className={`text-[11px] pt-1 ${
                          theme === "light" ? "text-slate-700 font-medium" : "text-slate-300/90"
                        }`}>
                          {t("以全网客观事实与本地真实经历，构建无幻觉、端到端闭环的职业工程中枢。", "Builds a hallucination-free, end-to-end career engineering hub from objective facts on the web and your real local experience.")}
                        </p>

                        {/* 系统模型与工具配置指引 */}
                        <div className="pt-2 flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] font-mono ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                              {t("执行内核：连接系统设置配置的本地 Agent", "Run kernel: connected to configured local Agent")}
                            </span>
                            <button
                              type="button"
                              onClick={() => openSystemSettings("tools")}
                              className="text-[10px] text-cyan-600 hover:text-cyan-500 underline font-bold flex items-center gap-1 font-mono"
                            >
                              <Sliders className="w-2.5 h-2.5" />
                              <span>{t("前往系统设置配置模型与工具", "Configure models and tools in System settings")} &gt;</span>
                            </button>
                          </div>
                          <div className={`text-[10px] font-mono ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                            {t("沙箱边界受控 · 本人确认投递", "Sandboxed runtime · Human-confirmed delivery")}
                          </div>
                        </div>
                      </div>
                    </div>

                    {opportunityError && (
                      <div
                        role="alert"
                        className={`p-3 rounded-xl border text-xs font-mono ${
                          theme === "light"
                            ? "bg-rose-50 border-rose-200 text-rose-800"
                            : "bg-rose-950/30 border-rose-500/35 text-rose-200"
                        }`}
                      >
                        <strong>{t("读取本地机会库失败：", "Failed to read local opportunity library: ")}</strong>
                        <span>{opportunityError}</span>
                      </div>
                    )}

                    {/* 当前聚焦的真实岗位摘要或空状态引导 */}
                    {activeJob ? (
                      <div className="space-y-2.5">
                        <div className={`p-3 rounded-xl border flex items-center justify-between gap-2 flex-wrap ${
                          theme === "light"
                            ? "bg-slate-50 border-slate-200 text-slate-800"
                            : "bg-black/40 border-white/10 text-cyan-300"
                        }`}>
                          <div className={`flex items-center gap-2 font-mono min-w-0 ${
                            theme === "light" ? "text-slate-900 font-semibold" : "text-cyan-300"
                          }`}>
                            <span className="font-bold text-cyan-600">&gt;</span>
                            <span className="truncate">/autopilot --target="{activeJob.company}" --pipeline=real</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setTerminalTab("inspector")}
                            className={`text-[10px] hover:underline flex items-center gap-1 font-mono font-bold shrink-0 ${
                              theme === "light" ? "text-amber-700" : "text-amber-300"
                            }`}
                          >
                            <span>{t(`[展开 #${activeNode.code} 工件]`, `[Expand #${activeNode.code} artifact]`)}</span>
                            <ChevronRight className="w-3 h-3" />
                          </button>
                        </div>

                        {jobs.length > 1 && (
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {jobs.map((j) => (
                              <button
                                key={j.id}
                                type="button"
                                onClick={() => setActiveJobId(j.id)}
                                className={`px-2 py-1 rounded-lg border text-[10.5px] font-mono transition ${
                                  activeJob.id === j.id
                                    ? "bg-cyan-500 text-slate-950 border-cyan-400 font-bold"
                                    : theme === "light"
                                      ? "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                                      : "bg-white/[0.04] border-white/10 text-slate-300 hover:bg-white/[0.08]"
                                }`}
                              >
                                {j.company} · {j.role}
                              </button>
                            ))}
                          </div>
                        )}

                        <div
                          data-job-id={activeJob.id}
                          className={`p-3.5 rounded-xl border space-y-2 ${
                            theme === "light"
                              ? "bg-white border-slate-200 shadow-sm text-slate-800"
                              : "bg-black/45 border-white/10 text-slate-200"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2 flex-wrap">
                            <div className="min-w-0">
                              <div className={`text-sm font-bold truncate ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                                {activeJob.role}
                              </div>
                              <div className={`text-[11px] ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                                {activeJob.company} · {activeJob.sourcePlatform}
                              </div>
                            </div>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                              theme === "light"
                                ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                                : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                            }`}>
                              {stageLabel(activeJob.stage3D, t)}
                            </span>
                          </div>

                          <div className={`flex flex-wrap gap-2 text-[10.5px] font-mono ${theme === "light" ? "text-slate-600" : "text-slate-300"}`}>
                            <span>{t("地点: ", "Location: ")}{activeJob.city}</span>
                            <span>•</span>
                            <span>{t("薪资: ", "Salary: ")}{activeJob.salary}</span>
                            <span>•</span>
                            <span>{activeJob.workHours}</span>
                            <span>•</span>
                            <span>{t(`材料 ${activeJob.materialsCount} · 沟通 ${activeJob.communicationsCount}`, `Materials ${activeJob.materialsCount} · Comms ${activeJob.communicationsCount}`)}</span>
                          </div>

                          <div className={`text-[11px] ${theme === "light" ? "text-slate-700" : "text-slate-300"}`}>
                            {activeJob.nextAction}
                          </div>

                          <div className="pt-1 flex items-center gap-2 flex-wrap">
                            {onAnalyzeOpportunity && (
                              <button
                                type="button"
                                onClick={() => onAnalyzeOpportunity(activeJob.sourceJob)}
                                className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-gradient-to-r from-amber-400 to-cyan-400 text-slate-950 hover:brightness-110 shadow transition"
                              >
                                {t("送入顾问核验", "Run Advisor review")} ➔
                              </button>
                            )}
                            {onOpenOpportunity && (
                              <button
                                type="button"
                                onClick={() => onOpenOpportunity(activeJob.id)}
                                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${
                                  theme === "light"
                                    ? "bg-slate-100 border-slate-300 text-slate-800 hover:bg-slate-200"
                                    : "bg-white/10 border-white/15 text-slate-100 hover:bg-white/15"
                                }`}
                              >
                                {t("核对岗位记录", "Open saved record")}
                              </button>
                            )}
                            {activeJob.sourceUrl && (
                              <a
                                href={activeJob.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[11px] text-cyan-500 hover:underline font-mono ml-auto"
                              >
                                {t("查看原始发布链接", "Original source URL")} ↗
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : loadingOpportunities ? (
                      <div className={`p-4 rounded-xl border text-xs font-mono ${
                        theme === "light" ? "bg-slate-50 border-slate-200 text-slate-600" : "bg-black/40 border-white/10 text-slate-400"
                      }`}>
                        {t("正在读取本地已保存的真实岗位…", "Loading locally saved opportunities…")}
                      </div>
                    ) : (
                      <EmptyState
                        compact
                        align="start"
                        icon={<Orbit size={18} />}
                        title={t("当前还没有接入真实岗位", "No real opportunities saved yet")}
                        description={t("本工坊严格只绑定本地真实机会库与 FactBase 事实经历；在保存首批岗位前，不注入任何模拟公司、薪资、ATS 分数或背调结论。", "This studio binds strictly to your saved opportunities and local FactBase—no demo companies, salaries, ATS scores, or synthetic checks are generated.")}
                        actions={<>
                          {onOpenOpportunitySources && (
                            <Button variant="primary" size="xs" onClick={onOpenOpportunitySources}>
                              {t("接入真实岗位", "Connect real opportunities")}
                            </Button>
                          )}
                          {onRefreshOpportunities && (
                            <Button variant="secondary" size="xs" onClick={onRefreshOpportunities}>
                              {t("刷新机会库", "Refresh library")}
                            </Button>
                          )}
                        </>}
                      />
                    )}

                    {/* 能力流程导航 */}
                    <div className="space-y-2 pt-1 font-mono">
                      {visibleCapabilityFlow.map((item) => (
                        <div key={item.id} className="space-y-0.5">
                          <div className={`flex items-center justify-between ${
                            theme === "light" ? "text-slate-800" : "text-slate-200"
                          }`}>
                            <div className="flex items-center gap-2">
                              <span
                                style={{ color: item.isCurrent ? currentAgent.primaryHex : "#64748B" }}
                                className="font-bold"
                              >
                                ●
                              </span>
                              <span className={`font-bold ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                                #{item.code} {item.name}
                              </span>
                              <span className={`text-[11px] ${theme === "light" ? "text-slate-500" : "text-slate-400"}`}>
                                ({item.cmdTitle})
                              </span>
                            </div>
                          </div>
                          <div className={`pl-4 flex items-center justify-between text-[11px] ${
                            theme === "light" ? "text-slate-600" : "text-slate-400"
                          }`}>
                            <span>⎿ {item.cmdDetail}</span>
                            <button
                              type="button"
                              onClick={() => {
                                setActiveNodeIdx(item.id - 1);
                                setTerminalTab("inspector");
                              }}
                              className={`hover:underline font-bold ${
                                theme === "light" ? "text-cyan-700 hover:text-cyan-900" : "text-cyan-400"
                              }`}
                            >
                              {t("[查看工件 ➔]", "[Inspect node ➔]")}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  /* 深度工件舱 (Inspector) */
                  <div className="space-y-4">
                    {/* Node 11: 简历润色 FactBase 绑定视图 */}
                    {activeNode.id === 11 && (
                      <div className="space-y-3">
                        <div className={`flex items-center justify-between pb-2 border-b gap-2 flex-wrap ${
                          theme === "light" ? "border-slate-200" : "border-white/10"
                        }`}>
                          <h3 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-cyan-300"
                          }`}>
                            <Code2 className="w-4 h-4 text-cyan-500" />
                            <span>{t(`结构化 Diff 准备 · 绑定本地 FactBase (${claimCount} 条要点)`, `Structured diff setup · linked to local FactBase (${claimCount} claims)`)}</span>
                          </h3>
                          <span className={`text-[10px] px-2 py-0.5 rounded border ${
                            theme === "light"
                              ? "bg-emerald-100 text-emerald-900 border-emerald-300 font-bold"
                              : "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                          }`}>
                            {t("0 虚构参数 · 仅保留事实锚定", "0 invented parameters · grounded in FactBase only")}
                          </span>
                        </div>

                        {activeJob ? (
                          <div className={`p-3.5 rounded-xl border space-y-2.5 ${
                            theme === "light" ? "bg-slate-50 border-slate-200 shadow-sm" : "bg-black/50 border-white/10"
                          }`}>
                            <div className="flex items-center justify-between text-[11px] gap-2 flex-wrap">
                              <span className={`font-bold ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                                {activeJob.company} · {activeJob.role}
                              </span>
                              <span className="text-cyan-500 font-mono">
                                {t(`已存档材料 ${activeJob.materialsCount} 份 · 当前简历 ${resumeSectionCount} 段经历`, `Archived materials: ${activeJob.materialsCount} · Resume entries: ${resumeSectionCount}`)}
                              </span>
                            </div>
                            <p className={`text-[11px] leading-relaxed ${theme === "light" ? "text-slate-600" : "text-slate-300"}`}>
                              {t("结构化 old -> new 改写 Diff 仅在你将此真实岗位送入本地顾问并完成 FactBase 对齐后生成，此处不预设虚构改写结果。", "Structured old -> new rewrite diffs are produced only after Advisor reviews this saved job against your FactBase; no synthetic rewrites are pre-filled.")}
                            </p>
                            <div className="flex items-center gap-2 flex-wrap pt-1">
                              {onAnalyzeOpportunity && (
                                <button
                                  type="button"
                                  onClick={() => onAnalyzeOpportunity(activeJob.sourceJob)}
                                  className="px-3 py-1.5 rounded-lg text-xs font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition"
                                >
                                  {t("送入顾问生成 Diff 建议", "Send to Advisor for rewrite diffs")}
                                </button>
                              )}
                              {onOpenOpportunity && (
                                <button
                                  type="button"
                                  onClick={() => onOpenOpportunity(activeJob.id)}
                                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${
                                    theme === "light"
                                      ? "bg-white border-slate-300 text-slate-700 hover:bg-slate-100"
                                      : "bg-white/10 border-white/15 text-slate-200 hover:bg-white/15"
                                  }`}
                                >
                                  {t("查看岗位与已存档材料", "View job & materials")}
                                </button>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className={`p-3.5 rounded-xl border text-[11px] ${
                            theme === "light" ? "bg-slate-50 border-slate-200 text-slate-600" : "bg-black/40 border-white/10 text-slate-400"
                          }`}>
                            {t("请先保存并选择一个真实岗位，再生成基于 FactBase 的结构化简历润色 Diff。", "Save and select a real opportunity first before generating FactBase-anchored resume diffs.")}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Node 13: ATS / 版式与真实材料体检 */}
                    {activeNode.id === 13 && (
                      <div className="space-y-3">
                        <div className={`flex items-center justify-between pb-2 border-b gap-2 flex-wrap ${
                          theme === "light" ? "border-slate-200" : "border-white/10"
                        }`}>
                          <h3 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-cyan-300"
                          }`}>
                            <BookmarkCheck className="w-4 h-4 text-cyan-500" />
                            <span>{t("简历版式与真实投递材料状态", "Resume layout and real application material status")}</span>
                          </h3>
                          <span className={`text-[10px] font-bold ${
                            theme === "light" ? "text-emerald-700" : "text-emerald-400"
                          }`}>
                            {t("只展示本地真实计数 · 无预填评分", "Live local counts only · no pre-filled scores")}
                          </span>
                        </div>

                        <div className="grid grid-cols-3 gap-3">
                          <div className={`p-3 rounded-xl border text-center ${
                            theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                          }`}>
                            <div className={`text-xl font-black ${theme === "light" ? "text-emerald-700" : "text-emerald-400"}`}>
                              {resumeSectionCount}
                            </div>
                            <div className={`text-[10px] mt-1 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              {t("当前投影简历经历", "Projected resume entries")}
                            </div>
                          </div>
                          <div className={`p-3 rounded-xl border text-center ${
                            theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                          }`}>
                            <div className={`text-xl font-black ${theme === "light" ? "text-cyan-700" : "text-cyan-400"}`}>
                              {claimCount}
                            </div>
                            <div className={`text-[10px] mt-1 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              {t("FactBase 可用事实要点", "Available FactBase claims")}
                            </div>
                          </div>
                          <div className={`p-3 rounded-xl border text-center ${
                            theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                          }`}>
                            <div className={`text-xl font-black ${theme === "light" ? "text-amber-700" : "text-amber-400"}`}>
                              {activeJob ? activeJob.materialsCount : 0}
                            </div>
                            <div className={`text-[10px] mt-1 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              {t("该岗位已存档材料快照", "Archived job snapshots")}
                            </div>
                          </div>
                        </div>

                        <div className={`p-3 rounded-xl border text-[11px] space-y-2 ${
                          theme === "light" ? "bg-slate-50 border-slate-200 text-slate-700" : "bg-[#0B121C] border-[#1E2E42] text-slate-300"
                        }`}>
                          {activeJob ? (
                            <>
                              <div className="font-bold">
                                {activeJob.company} · {activeJob.role}
                              </div>
                              <div>
                                {t("如需核查该岗位的关键词覆盖与版式适配，请送入顾问运行实时比对，不要依赖预设虚假百分比。", "Run Advisor against this saved job to inspect keyword fit and formatting with real execution receipts.")}
                              </div>
                            </>
                          ) : (
                            <div>
                              {t("保存真实岗位并在顾问中心执行分析后，这里会关联对应岗位的材料快照数量。", "Save a real opportunity and analyze it in Advisor to track archived material snapshots here.")}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Node 10: 企业来源与原始链接核对 */}
                    {activeNode.id === 10 && (
                      <div className="space-y-3">
                        <div className={`flex items-center justify-between pb-2 border-b gap-2 flex-wrap ${
                          theme === "light" ? "border-slate-200" : "border-white/10"
                        }`}>
                          <h3 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-cyan-300"
                          }`}>
                            <ShieldCheck className="w-4 h-4 text-cyan-500" />
                            <span>
                              {activeJob
                                ? `${activeJob.company} · ${t("来源与原始记录核对", "Source and provenance check")}`
                                : t("企业来源与原始记录核对", "Source and provenance check")}
                            </span>
                          </h3>
                          <span className={`text-[10px] font-bold ${
                            theme === "light" ? "text-emerald-700" : "text-emerald-400"
                          }`}>
                            {t("以已保存记录与原链接为准", "Grounded in saved record & source URL")}
                          </span>
                        </div>

                        {activeJob ? (
                          <>
                            <div className="grid grid-cols-2 gap-3 text-[11px]">
                              <div className={`p-3 rounded-xl border ${
                                theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                              }`}>
                                <span className={theme === "light" ? "text-slate-500" : "text-slate-400"}>{t("采集来源平台：", "Source platform: ")}</span>
                                <div className={`font-bold mt-1 ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                                  {activeJob.sourcePlatform}
                                </div>
                              </div>
                              <div className={`p-3 rounded-xl border ${
                                theme === "light" ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
                              }`}>
                                <span className={theme === "light" ? "text-slate-500" : "text-slate-400"}>{t("地点 / 披露薪资：", "Location / disclosed salary: ")}</span>
                                <div className={`font-bold mt-1 ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                                  {activeJob.city} · {activeJob.salary}
                                </div>
                              </div>
                            </div>

                            <div className={`p-3 rounded-xl border text-[11px] ${
                              theme === "light"
                                ? "bg-cyan-50 border-cyan-200 text-cyan-950"
                                : "bg-cyan-950/25 border-cyan-500/30 text-cyan-200"
                            }`}>
                              <div className={`font-bold mb-1 ${theme === "light" ? "text-cyan-800" : "text-cyan-400"}`}>
                                {t("原始发布链接：", "Original posting URL: ")}
                              </div>
                              {activeJob.sourceUrl ? (
                                <a href={activeJob.sourceUrl} target="_blank" rel="noreferrer" className="underline break-all">
                                  {activeJob.sourceUrl}
                                </a>
                              ) : (
                                <p>{t("未附带原始链接；工商信息、劳动仲裁与真伪验证需打开原站点或由用户自行补录。", "No source URL saved yet; verify company registration and original posting manually or link its URL.")}</p>
                              )}
                            </div>

                            <div className={`p-3 rounded-xl border text-[11px] space-y-2 ${
                              theme === "light"
                                ? "bg-slate-50 border-slate-200 text-slate-700"
                                : "bg-black/40 border-white/10 text-slate-300"
                            }`}>
                              <div className="font-bold">
                                {t(`沟通记录 (${activeJob.communicationsCount}) · 下一步跟进：`, `Communications (${activeJob.communicationsCount}) · Next action:`)}
                              </div>
                              <p>{activeJob.nextAction}</p>
                            </div>
                          </>
                        ) : (
                          <div className={`p-3.5 rounded-xl border text-[11px] ${
                            theme === "light" ? "bg-slate-50 border-slate-200 text-slate-600" : "bg-black/40 border-white/10 text-slate-400"
                          }`}>
                            {t("保存真实岗位后，此处会展示其采集来源、发布链接与沟通记录。", "Save a real opportunity to inspect its source platform, original link, and follow-up records here.")}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Node 19: 薪酬与时薪模拟器 */}
                    {activeNode.id === 19 && (
                      <div className="space-y-4">
                        <div className={`flex items-center justify-between pb-2 border-b ${
                          theme === "light" ? "border-slate-200" : "border-white/10"
                        }`}>
                          <h3 className={`text-sm font-bold flex items-center gap-2 ${
                            theme === "light" ? "text-slate-900" : "text-cyan-300"
                          }`}>
                            <Activity className="w-4 h-4 text-cyan-500" />
                            <span>{t("假设模拟：按税前总包的 88%、每年工作 50 周折算", "Simulated assumption: 88% of the pre-tax package, 50 working weeks a year")}</span>
                          </h3>
                          <span className={`text-[10px] font-bold ${
                            theme === "light" ? "text-amber-800" : "text-amber-300"
                          }`}>
                            {t("纯本地假设计算器", "Local hypothetical calculator")}
                          </span>
                        </div>

                        {activeJob && (
                          <div className={`p-2.5 rounded-xl border text-[11px] flex items-center justify-between gap-2 ${
                            theme === "light" ? "bg-slate-50 border-slate-200 text-slate-700" : "bg-black/35 border-white/10 text-slate-300"
                          }`}>
                            <span>{t(`参考岗位 (${activeJob.company}) 披露薪资：`, `Disclosed salary for ${activeJob.company}: `)}</span>
                            <strong>{activeJob.salary}</strong>
                          </div>
                        )}

                        <div
                          style={{
                            backgroundColor: "var(--ap-tone-38)",
                            borderColor: "var(--ap-tone-39)",
                          }}
                          className="p-4 rounded-xl border flex items-center justify-between"
                        >
                          <div>
                            <div className={`text-[10px] ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              {t("折算假设净时薪 (滑块参数 / 每年 50 周)", "Assumed net hourly rate (slider inputs / 50 weeks)")}
                            </div>
                            <div className={`text-3xl font-black mt-1 ${
                              theme === "light" ? "text-amber-600" : "text-amber-400"
                            }`}>
                              ¥{netHourlyWage} / hr
                            </div>
                          </div>
                          <div className="text-right">
                            <span className={`px-2 py-1 rounded font-bold text-xs border ${
                              theme === "light"
                                ? "bg-emerald-100 text-emerald-900 border-emerald-300"
                                : "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                            }`}>
                              {t(`按每周 ${simWeeklyHours}h 折算`, `Based on ${simWeeklyHours} h/week`)}
                            </span>
                            <div className={`text-[10px] mt-1 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                              {t("非实际到手收入或岗位待遇承诺", "Not actual take-home pay or a promise of job benefits")}
                            </div>
                          </div>
                        </div>

                        {/* 滑块调节 */}
                        <div className="space-y-3 font-mono text-[11px]">
                          <div>
                            <div className={`flex justify-between mb-1 ${
                              theme === "light" ? "text-slate-700 font-bold" : "text-slate-300"
                            }`}>
                              <span>{t(`月薪 Base: ${simBaseK}k`, `Monthly base: ${simBaseK}k`)}</span>
                              <span className={theme === "light" ? "text-cyan-800" : "text-cyan-400"}>
                                {t(`年总包: ¥${simBaseK * simMonths}k`, `Annual package: ¥${simBaseK * simMonths}k`)}
                              </span>
                            </div>
                            <input
                              type="range"
                              min="25"
                              max="70"
                              value={simBaseK}
                              onChange={(e) => setSimBaseK(Number(e.target.value))}
                              className="w-full accent-cyan-500"
                            />
                          </div>

                          <div>
                            <div className={`flex justify-between mb-1 ${
                              theme === "light" ? "text-slate-700 font-bold" : "text-slate-300"
                            }`}>
                              <span>{t(`年终月数: ${simMonths} 薪`, `Bonus months: ${simMonths}`)}</span>
                              <span className={theme === "light" ? "text-cyan-800" : "text-cyan-400"}>
                                {simMonths >= 15 ? t("含年终假设", "Includes bonus assumption") : t("基准", "Baseline")}
                              </span>
                            </div>
                            <input
                              type="range"
                              min="12"
                              max="24"
                              value={simMonths}
                              onChange={(e) => setSimMonths(Number(e.target.value))}
                              className="w-full accent-cyan-500"
                            />
                          </div>

                          <div>
                            <div className={`flex justify-between mb-1 ${
                              theme === "light" ? "text-slate-700 font-bold" : "text-slate-300"
                            }`}>
                              <span>{t(`每周假设工作时长: ${simWeeklyHours} 小时/周`, `Assumed weekly hours: ${simWeeklyHours} h/week`)}</span>
                              <span className={theme === "light" ? "text-emerald-700" : "text-emerald-400"}>
                                {t("按滑块假设工时测算", "Calculated from slider hours")}
                              </span>
                            </div>
                            <input
                              type="range"
                              min="35"
                              max="60"
                              step="2.5"
                              value={simWeeklyHours}
                              onChange={(e) => setSimWeeklyHours(Number(e.target.value))}
                              className="w-full accent-amber-500"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Node 20: 沙箱应用工坊 */}
                    {activeNode.id === 20 && (
                      <div className="space-y-4">
                        {/* 手工内置预设，与下方的模型实验台分开 */}
                        <div className={`flex flex-col gap-2 pb-2.5 border-b ${
                          theme === "light" ? "border-slate-200" : "border-white/10"
                        }`}>
                          <div className="flex items-center justify-between">
                            <h3 className={`text-sm font-bold flex items-center gap-2 ${
                              theme === "light" ? "text-slate-900" : "text-cyan-300"
                            }`}>
                              <Layers className="w-4 h-4 text-cyan-500" />
                              <span>{t("内置微应用 · 手工选择预设", "Built-in micro-apps · pick a preset manually")}</span>
                            </h3>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              theme === "light"
                                ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                                : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                            }`}>
                              {t("不调用模型", "No model call")}
                            </span>
                          </div>

                          {/* 3层隔离说明胶囊 */}
                          <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono">
                            <span className={`px-2 py-0.5 rounded border ${
                              theme === "light" ? "bg-slate-100 text-slate-700 border-slate-300" : "bg-white/5 text-slate-300 border-white/10"
                            }`}>
                              {t("① 核对内置模板", "1. Check the built-in template")}
                            </span>
                            <span className="text-slate-400">➔</span>
                            <span className={`px-2 py-0.5 rounded border ${
                              theme === "light" ? "bg-cyan-50 text-cyan-800 border-cyan-300" : "bg-cyan-950/40 text-cyan-300 border-cyan-500/30"
                            }`}>
                              {t("② 宿主编译与回执", "2. Host compiles and returns a receipt")}
                            </span>
                            <span className="text-slate-400">➔</span>
                            <span className={`px-2 py-0.5 rounded border ${
                              theme === "light" ? "bg-amber-50 text-amber-800 border-amber-300" : "bg-amber-950/40 text-amber-300 border-amber-500/30"
                            }`}>
                              {t("③ 你批准后打开", "3. Opens after you approve")}
                            </span>
                          </div>
                        </div>

                        {/* 实时编译状态横幅 */}
                        {buildStatus === "building" && (
                          <div className={`p-3 rounded-xl border flex items-center gap-3 animate-pulse ${
                            theme === "light"
                              ? "bg-cyan-50 border-cyan-300 text-cyan-900"
                              : "bg-cyan-950/40 border-cyan-500/40 text-cyan-200"
                          }`}>
                            <Loader2 className="w-4 h-4 animate-spin text-cyan-500 shrink-0" />
                            <div className="text-xs font-mono">
                              <div className="font-bold">{t("正在等待内置预设构建回执", "Waiting for the built-in preset build receipt")}</div>
                              <div className="text-[11px] opacity-80 mt-0.5">{buildingStep}</div>
                            </div>
                          </div>
                        )}

                        {/* 已审查的内置模板 */}
                        <div className="space-y-2.5">
                          {Object.entries(PRESET_MICRO_APP_TEMPLATES).map(([appId, tmpl]) => {
                            const isInstalled = installedMicroApps.some((a) => a.appId === appId);
                            const installedApp = installedMicroApps.find((a) => a.appId === appId);
                            const isCompilingThis = buildingAppId === appId;

                            return (
                              <div
                                key={appId}
                                className={`p-3 rounded-xl border transition-all ${
                                  isInstalled
                                    ? theme === "light"
                                      ? "bg-emerald-50/50 border-emerald-300 shadow-sm"
                                      : "bg-emerald-950/20 border-emerald-500/30"
                                    : theme === "light"
                                    ? "bg-slate-50 border-slate-200 hover:border-slate-300"
                                    : "bg-black/40 border-white/10 hover:border-white/20"
                                }`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="flex items-start gap-2.5 min-w-0">
                                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-lg bg-gradient-to-br from-amber-400 to-cyan-400 shadow-sm shrink-0">
                                      {tmpl.icon}
                                    </div>
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className={`font-bold text-xs ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                                          {tmpl.name}
                                        </span>
                                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-black/10 dark:bg-white/10 text-slate-500 dark:text-slate-400">
                                          v{tmpl.version}
                                        </span>
                                        {isInstalled && (
                                          <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5">
                                            <CheckCircle2 size={11} />
                                            {installedApp?.pinnedToDock ? t("已固定到 Dock", "Pinned to Dock") : t("已安装", "Installed")}
                                          </span>
                                        )}
                                      </div>
                                      <p className={`text-[11px] mt-0.5 line-clamp-2 ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                                        {tmpl.description}
                                      </p>
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-2 shrink-0">
                                    {isInstalled && installedApp ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => handleOpenInstalledApp(installedApp)}
                                          className="px-2.5 py-1 rounded-lg text-xs font-bold bg-gradient-to-r from-emerald-500 to-cyan-500 text-slate-950 hover:brightness-110 shadow flex items-center gap-1"
                                        >
                                          <span>{t("唤起沙箱", "Launch sandbox")} ➔</span>
                                        </button>
                                        <button
                                          type="button"
                                          disabled={buildStatus === "building"}
                                          onClick={() => handleTriggerSandboxBuild(appId)}
                                          className={`px-2 py-1 rounded-lg text-[11px] font-medium border transition ${
                                            theme === "light"
                                              ? "border-slate-300 text-slate-600 hover:bg-slate-100"
                                              : "border-white/10 text-slate-400 hover:bg-white/10"
                                          }`}
                                          title={t("请宿主重新核对并编译内置模板", "Ask the host to re-check and compile the built-in template")}
                                        >
                                          {t("重新构建", "Rebuild")}
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        type="button"
                                        disabled={buildStatus === "building"}
                                        onClick={() => handleTriggerSandboxBuild(appId)}
                                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-gradient-to-r from-amber-400 to-cyan-400 text-slate-950 hover:brightness-110 shadow flex items-center gap-1.5 transition-all disabled:opacity-50"
                                      >
                                        {isCompilingThis ? (
                                          <>
                                            <Loader2 size={12} className="animate-spin" />
                                            <span>{t("等待宿主回执…", "Waiting for the host receipt…")}</span>
                                          </>
                                        ) : (
                                          <>
                                            <Zap size={12} />
                                            <span>{t("编译并审阅权限", "Compile and review permissions")} ➔</span>
                                          </>
                                        )}
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {/* 权限范围标签 */}
                                <div className="mt-2 pt-2 border-t flex items-center gap-1.5 flex-wrap text-[10px] font-mono opacity-80 border-black/5 dark:border-white/5">
                                  <Lock size={10} className="text-cyan-500" />
                                  <span className="text-slate-500 dark:text-slate-400">{t("授权边界:", "Authorization boundary:")}</span>
                                  {tmpl.grantedScopes.map((scope) => (
                                    <span
                                      key={scope}
                                      className={`px-1.5 py-0.5 rounded ${
                                        theme === "light"
                                          ? "bg-slate-200/70 text-slate-700"
                                          : "bg-white/10 text-slate-300"
                                      }`}
                                    >
                                      {scope}
                                    </span>
                                  ))}
                                  <span className="ml-auto text-[10px] text-emerald-600 dark:text-emerald-400">
                                    {t("运行于隔离 iframe", "Runs in an isolated iframe")}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        <SandboxCodingLab />
                      </div>
                    )}

                    {/* 其余节点的实时 AgentTaskKernel 运行状态面板 */}
                    {![10, 11, 13, 19, 20].includes(activeNode.id) && (
                      <AutopilotNodeInspector
                        node={activeNode}
                        theme={theme}
                        savedJobsCount={jobs.length}
                        claimCount={claimCount}
                        telemetry={kernelTelemetry}
                        onOpenOpportunitySources={onOpenOpportunitySources}
                        onAnalyzeActiveJob={activeJob && onAnalyzeOpportunity ? () => onAnalyzeOpportunity(activeJob.sourceJob) : undefined}
                        onOpenActiveRecord={activeJob && onOpenOpportunity ? () => onOpenOpportunity(activeJob.id) : undefined}
                      />
                    )}
                  </div>
                )}
              </div>

              {/* 控制台底部状态栏 */}
              <div
                style={{
                  backgroundColor: "var(--ap-tone-35)",
                  borderColor: "var(--ap-tone-36)",
                }}
                className="h-8 px-4 border-t flex items-center justify-between font-mono text-[10px] text-slate-400 shrink-0"
              >
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>
                    &gt;&gt; auto mode {autoLoopPlaying ? "on (patrolling)" : "paused"} • Space to toggle
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span>{jobs.length}{t(" 岗位", " jobs")} · FactBase {claimCount}</span>
                  <span>•</span>
                  <span style={{ color: currentAgent.primaryHex }} className="font-bold">
                    {currentAgent.shortName}
                  </span>
                  <span>•</span>
                  <span>/effort max</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 3D 机会金库模式 */}
        {(workspaceMode === "space3d" || workspaceMode === "split") && (
          <div className="w-full h-full max-w-[1400px] overflow-y-auto p-4 flex flex-col justify-between">
            <div className={`flex items-center justify-between pb-3 border-b gap-2 flex-wrap ${
              theme === "light" ? "border-slate-200" : "border-white/10"
            }`}>
              <div className="font-mono">
                <h2 className={`text-base font-bold flex items-center gap-2 ${
                  theme === "light" ? "text-slate-900" : "text-white"
                }`}>
                  <Orbit className="w-4 h-4 text-cyan-500" />
                  <span>{t(`3D 机会金库 · 立体背调卡册 (${collected3DJobs.length})`, `3D opportunity vault · research card album (${collected3DJobs.length})`)}</span>
                </h2>
                <p className={`text-[11px] ${theme === "light" ? "text-slate-600" : "text-slate-400"}`}>
                  {t("仅展示本地机会库已保存的真实岗位；支持 3D 悬停光影、180° 翻转查看跟进与材料快照，并一键送入顾问。", "Displays only real saved opportunities; hover for 3D lighting, flip 180° for follow-up & materials, or send directly to Advisor.")}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSpace3DLayout(space3DLayout === "grid" ? "carousel" : "grid")}
                  className={`px-3 py-1 rounded-lg text-xs font-mono border transition ${
                    theme === "light"
                      ? "bg-slate-100 border-slate-300 text-slate-700 hover:bg-slate-200"
                      : "bg-white/[0.05] border-white/10 text-slate-300 hover:text-white"
                  }`}
                >
                  {space3DLayout === "grid" ? t("切换 3D 环视轮播", "Switch to 3D carousel") : t("切换 2x2 网格", "Switch to 2x2 grid")}
                </button>
                <button
                  type="button"
                  onClick={() => setWorkspaceMode("studio")}
                  className="px-3 py-1 rounded-lg text-xs font-mono font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 shadow"
                >
                  {t("返回 20-Node 工坊", "Back to the 20-Node studio")}
                </button>
              </div>
            </div>

            {/* 3D 卡片网格或真实空状态 */}
            {collected3DJobs.length > 0 ? (
              <div className={`grid gap-4 my-auto py-4 ${
                space3DLayout === "carousel"
                  ? "grid-cols-1 md:grid-cols-2 max-w-[920px] mx-auto w-full"
                  : "grid-cols-1 md:grid-cols-2 lg:grid-cols-4"
              }`}>
                {collected3DJobs.map((j) => (
                  <CyberJobCard3D
                    key={j.id}
                    job={j}
                    agent={currentAgent}
                    isFlipped={Boolean(flipped3DMap[j.id])}
                    stageLabelText={stageLabel(j.stage3D, t)}
                    onToggleFlip={() => setFlipped3DMap((p) => ({ ...p, [j.id]: !p[j.id] }))}
                    onAnalyze={onAnalyzeOpportunity}
                    onOpenRecord={onOpenOpportunity}
                    onInspectInStudio={(id) => {
                      setActiveJobId(id);
                      setWorkspaceMode("studio");
                      triggerToast(t(`✦ 载入工坊：${j.company}`, `Studio loaded: ${j.company}`), t("已载入该真实岗位与执行节点", "Loaded saved opportunity into studio"));
                    }}
                    theme={theme}
                  />
                ))}
              </div>
            ) : (
              <div className={`my-auto mx-auto max-w-lg p-6 rounded-2xl border text-center space-y-3 ${
                theme === "light" ? "bg-white border-slate-200 shadow-sm text-slate-700" : "bg-[#0B121D] border-[#1E2E42] text-slate-300"
              }`}>
                <div className={`text-base font-bold ${theme === "light" ? "text-slate-900" : "text-white"}`}>
                  {t("3D 机会金库暂无真实收藏岗位", "No real saved opportunities in the 3D vault yet")}
                </div>
                <p className="text-xs leading-relaxed opacity-85">
                  {t("接入并保存任意真实招聘岗位后，系统会在这里生成对应 3D 机会立体卡，零虚构公司与薪资。", "Save any real job opportunity to see its 3D opportunity card here—no demo companies or fabricated pay are injected.")}
                </p>
                <div className="flex items-center justify-center gap-2 pt-1">
                  {onOpenOpportunitySources && (
                    <button
                      type="button"
                      onClick={onOpenOpportunitySources}
                      className="px-3.5 py-1.5 rounded-lg text-xs font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition"
                    >
                      {t("接入真实岗位", "Connect real opportunities")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setWorkspaceMode("studio")}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-bold border transition ${
                      theme === "light" ? "bg-slate-100 border-slate-300 text-slate-700 hover:bg-slate-200" : "bg-white/10 border-white/15 text-slate-200 hover:bg-white/15"
                    }`}
                  >
                    {t("返回 20-Node 工坊", "Back to the 20-Node studio")}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* ====================================================================
          3. 底部 CONTROL TRAY & DOCK 栏
         ==================================================================== */}
      <footer
        aria-label={t("工坊控制 Dock", "Studio control Dock")}
        className="studio-dock relative z-30 px-4 pt-1 pb-2 flex items-center justify-between gap-3 shrink-0 font-mono text-xs select-none"
      >
        {/* 左侧：当前循环节点信息 */}
        <div className="studio-dock__panel studio-dock__status flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-bold" style={{ color: currentAgent.primaryHex }}>
            <span>✦</span>
            <span>{currentAgent.shortName}: The loop</span>
          </div>
          <span className={theme === "light" ? "text-slate-600 font-medium" : "text-slate-400"}>
            - #{activeNode.code} {activeNode.name} ({activeNode.tag})
          </span>
        </div>

        {/* 中间：ASCII 进度条与模式切换 */}
        <div className="studio-dock__panel studio-dock__modes hidden md:flex items-center gap-3">
          <div className={`hidden xl:flex items-center gap-2 text-[11px] ${
            theme === "light" ? "text-slate-600" : "text-slate-400"
          }`}>
            <span className={`font-bold ${theme === "light" ? "text-cyan-700" : "text-cyan-400"}`}>{asciiBar}</span>
            <span>{progressPercent}%</span>
          </div>

          <div className={`flex items-center gap-1 p-0.5 rounded-lg border ${
            theme === "light" ? "bg-slate-100 border-slate-300" : "bg-black/40 border-white/10"
          }`}>
            <button
              onClick={() => setWorkspaceMode("studio")}
              className={`px-2.5 py-1 rounded text-[10.5px] font-bold transition ${
                workspaceMode === "studio"
                  ? "bg-amber-400 text-slate-950 shadow"
                  : theme === "light"
                    ? "text-slate-600 hover:text-slate-900"
                    : "text-slate-400 hover:text-white"
              }`}
            >
              {t("20-Node 工坊", "20-Node studio")}
            </button>
            <button
              onClick={() => setWorkspaceMode("space3d")}
              className={`px-2.5 py-1 rounded text-[10.5px] font-bold transition ${
                workspaceMode === "space3d"
                  ? "bg-amber-400 text-slate-950 shadow"
                  : theme === "light"
                    ? "text-slate-600 hover:text-slate-900"
                    : "text-slate-400 hover:text-white"
              }`}
            >
              {t(`3D 机会金库 (${collected3DJobs.length})`, `3D opportunity vault (${collected3DJobs.length})`)}
            </button>
            <button
              type="button"
              onClick={() => {
                if (typeof window !== "undefined" && window.desktopApi?.toggleStarPrompterHud) {
                  void window.desktopApi.toggleStarPrompterHud();
                } else {
                  triggerToast(t("🎙 STAR 提词 HUD", "STAR prompter HUD"), t("桌面端专享：全局置顶、毛玻璃半透明、多屏跟随悬浮提词窗 (快捷键 ⌘+Shift+H)", "Desktop only: an always-on-top, frosted translucent prompter window that follows you across screens (shortcut ⌘+Shift+H)"));
                }
              }}
              className={`px-2.5 py-1 rounded text-[10.5px] font-bold flex items-center gap-1.5 transition ${
                theme === "light"
                  ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20"
                  : "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
              }`}
              title={t("切换/呼出 STAR 面试全局置顶提词 HUD 悬浮窗 (桌面端快捷键 ⌘+Shift+H)", "Toggle the always-on-top STAR interview prompter HUD (desktop shortcut ⌘+Shift+H)")}
            >
              <Mic className="w-3 h-3 text-emerald-500" />
              <span>{t("STAR 提词 HUD", "STAR prompter HUD")}</span>
            </button>
          </div>
        </div>

        {/* 右侧：步进控制器与 Dock 入口 */}
        <div className="studio-dock__panel studio-dock__controls flex items-center gap-2">
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                setAutoLoopPlaying(false);
                setActiveNodeIdx((p) => (p - 1 + STUDIO_20_NODES.length) % STUDIO_20_NODES.length);
              }}
              className={`p-1.5 rounded-lg border transition ${
                theme === "light"
                  ? "bg-slate-100 border-slate-300 hover:bg-slate-200 text-slate-700"
                  : "bg-white/[0.05] border-white/10 hover:bg-white/10 text-slate-300"
              }`}
              title={t("上一步", "Previous")}
            >
              <SkipBack className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => setAutoLoopPlaying((p) => !p)}
              disabled={!runtimeReady}
              title={runtimeReady ? t("仅预览工序，不执行真实任务", "Preview the process only; no real task is run") : t("请先在系统设置中配置可用 Agent", "Configure an available Agent in System settings first")}
              className={`px-3 py-1 rounded-lg font-bold flex items-center gap-1.5 transition disabled:opacity-50 disabled:cursor-not-allowed ${
                autoLoopPlaying
                  ? "bg-amber-400 text-slate-950 shadow"
                  : theme === "light"
                    ? "bg-slate-200 text-slate-900 border border-slate-300 hover:bg-slate-300"
                    : "bg-white/10 text-white hover:bg-white/20"
              }`}
            >
              {autoLoopPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>{!runtimeReady ? t("Agent 未就绪", "Agent not ready") : autoLoopPlaying ? t("预览中", "Previewing") : t("播放工序", "Play process")}</span>
            </button>

            <button
              onClick={() => {
                setAutoLoopPlaying(false);
                setActiveNodeIdx((p) => (p + 1) % STUDIO_20_NODES.length);
              }}
              className={`p-1.5 rounded-lg border transition ${
                theme === "light"
                  ? "bg-slate-100 border-slate-300 hover:bg-slate-200 text-slate-700"
                  : "bg-white/[0.05] border-white/10 hover:bg-white/10 text-slate-300"
              }`}
              title={t("下一步", "Next")}
            >
              <SkipForward className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setConveyorShiftMode((p) => !p)}
            className={`px-2 py-1 rounded-lg text-[10.5px] border transition ${
              conveyorShiftMode
                ? theme === "light"
                  ? "bg-cyan-500/15 text-cyan-800 border-cyan-500/40 font-bold"
                  : "bg-cyan-400/20 text-cyan-200 border-cyan-400/50 font-bold"
                : theme === "light"
                  ? "bg-slate-100 text-slate-700 border-slate-300"
                  : "bg-white/[0.06] text-slate-300 border-white/15"
            }`}
          >
            {t("履带旋转: ", "Conveyor rotation: ")}{conveyorShiftMode ? "ON" : "OFF"}
          </button>

          {/* 沙箱微应用挂载提示 */}
          <div className={`hidden xl:flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10.5px] ${
            theme === "light"
              ? "bg-slate-100 border-slate-300 text-slate-800"
              : "bg-[#0E1724] border-[#1E2E42] text-slate-300"
          }`}>
            <Layers className="w-3 h-3 text-cyan-500" />
            <span>{t(`已安装微应用 (${installedMicroApps.length})`, `Installed micro-apps (${installedMicroApps.length})`)}</span>
          </div>
        </div>
      </footer>

      {/* 沙箱应用安全审计与授权门禁 (HITL Gate) */}
      <MicroAppPermissionModal
        artifact={pendingArtifact}
        isOpen={isPermissionModalOpen}
        onClose={() => setIsPermissionModalOpen(false)}
        onApprove={handleApproveArtifact}
      />
    </div>
  );
}
