import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bot, CircleHelp, PanelRightClose, Settings2 } from "lucide-react";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import "./agent-sidebar.css";
import { AGENT_LESSONS, AgentWorkflowGuide, type AgentLesson } from "./AgentWorkflowGuide";
import { AgentReaderTools } from "./AgentReaderTools";
import { AgentGuideCoach } from "./AgentGuideCoach";
import { AgentHelpHome } from "./AgentHelpHome";
import { readTutorial, tutorialKey, tutorialStorage } from "../lib/agent-tutorial";
import { privateStorage as localStorage } from "../lib/private-storage";
import { useUiPreferences } from "../lib/ui-preferences";
import { openSystemSettings } from "../lib/settings-navigation";
import type { UnderstandingClient } from "../services/understanding-client";

type Tab = "conversation" | "memory" | "settings";
type Conversation = "writing" | "companion";
type Surface = Conversation | "memory" | "writing-settings" | "companion-settings" | "tools";
type Sidebar = {
  open: boolean; tab: Tab; conversation: Conversation;
  show: (tab?: Tab, conversation?: Conversation) => void; hide: () => void;
  slots: Partial<Record<Surface, HTMLDivElement>>;
  register: (name: Surface, node: HTMLDivElement | null) => void;
  learn: (lesson?: AgentLesson) => void;
  readerRuntime: string; setReaderRuntime: (runtime: string) => void;
  understandingClient?: UnderstandingClient;
};
const Context = createContext<Sidebar | null>(null);
const AGENT_WIDTH_KEY = "betterme.agent.sidebar-width.v1";
const AGENT_WIDTH_DEFAULT = 380;
const AGENT_WIDTH_MIN = 320;
function clampAgentWidth(value: number) {
  const viewportMax = Math.max(AGENT_WIDTH_MIN, Math.min(680, Math.round(window.innerWidth * .52)));
  return Math.min(viewportMax, Math.max(AGENT_WIDTH_MIN, Math.round(value)));
}
export const useAgentSidebar = () => useContext(Context);

/** UI lifetime is separate from task lifetime. Stable portal targets never move on tab/route changes. */
export function AgentSurface({ name, children }: { name: Surface; children: ReactNode }) {
  const sidebar = useAgentSidebar();
  if (!sidebar) return children;
  const target = sidebar.slots[name];
  return target ? createPortal(children, target) : null;
}
export function AgentSettingsPanel({ understandingClient }: { understandingClient?: UnderstandingClient }) {
  const { t } = useUiPreferences();
  const sidebar = useAgentSidebar();
  if (!sidebar) return null;
  understandingClient ??= sidebar.understandingClient;
  return <div className="agent-sidebar-settings unified-agent-settings">
    <h3>{t("统一推理与对话授权", "Inference & conversation access")}</h3><Slot name="companion-settings" /><Slot name="tools" />
    <h3>{t("伴写参与方式", "Writing participation")}</h3><Slot name="writing-settings" />
    <h3>{t("已安装 Agent 与受控取证", "Installed agents & evidence tools")}</h3><AgentReaderTools client={understandingClient} />
  </div>;
}
function Slot({ name }: { name: Surface }) {
  const { register } = useAgentSidebar()!;
  const ref = useCallback((node: HTMLDivElement | null) => register(name, node), [name, register]);
  return <div ref={ref} className={`agent-sidebar-slot agent-sidebar-slot-${name}`} />;
}

export function AgentSidebarProvider({ children, understandingClient }: { children: ReactNode; understandingClient?: UnderstandingClient }) {
  const { t } = useUiPreferences();
  const [open, setOpen] = useState(false), [mounted, setMounted] = useState(false), [tab, setTab] = useState<Tab>("conversation"), [conversation, setConversation] = useState<Conversation>("writing");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return clampAgentWidth(Number(localStorage.getItem(AGENT_WIDTH_KEY)) || AGENT_WIDTH_DEFAULT); }
    catch { return clampAgentWidth(AGENT_WIDTH_DEFAULT); }
  });
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const [slots, setSlots] = useState<Sidebar["slots"]>({});
  const [coversApp, setCoversApp] = useState(() => window.matchMedia("(max-width: 840px), (max-height: 500px)").matches);
  const panel = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null), trigger = useRef<HTMLElement | null>(null);
  const launcher = useRef<HTMLButtonElement>(null), wasOpen = useRef(false), closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tutorialButton = useRef<HTMLButtonElement>(null), tutorialTrigger = useRef<HTMLElement | null>(null);
  const tutorialFocus = useRef<"return" | "coach" | null>(null);
  const { agent, snapshot } = useBetterMeAgent();
  const [guide, setGuide] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const guideOrigin = useRef<{ tab: Tab; conversation: Conversation } | null>(null);
  function openHelp() {
    tutorialTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    guideOrigin.current = { tab, conversation };
    setHelpOpen(true);
  }
  function closeHelp() {
    if (guideOrigin.current) { setTab(guideOrigin.current.tab); setConversation(guideOrigin.current.conversation); }
    tutorialFocus.current = "return";
    setHelpOpen(false); setGuide(null);
  }
  const [coach, setCoach] = useState<AgentLesson | null>(null);
  const guideKey = tutorialKey(snapshot?.data.workspaceKey ?? "standalone");
  const readerKey = `betterme.project-reader.v1:${snapshot?.data.workspaceKey ?? "standalone"}`;
  const [readerRuntime, setReader] = useState(() => { try { return localStorage.getItem(readerKey) || "model"; } catch { return "model"; } });
  const [preferenceError, setPreferenceError] = useState("");
  const setReaderRuntime = useCallback((runtime: string) => {
    if (snapshot?.data.tasks.some(task => task.status === "running")) { setPreferenceError("当前任务仍在运行，未切换阅读工具或打断任务。"); return; }
    setReader(runtime);
    try { localStorage.setItem(readerKey, runtime); setPreferenceError(""); } catch { setPreferenceError("本次工具选择仅在本页有效，浏览器未能保存偏好。"); }
  }, [readerKey, snapshot?.data.tasks]);
  const running = snapshot?.data.tasks.filter(task => task.status === "running").length ?? 0;
  const id = useId();
  useEffect(() => {
    const media = window.matchMedia("(max-width: 840px), (max-height: 500px)");
    const update = () => { setCoversApp(media.matches); setSidebarWidth(width => clampAgentWidth(width)); };
    media.addEventListener("change", update); window.addEventListener("resize", update);
    return () => { media.removeEventListener("change", update); window.removeEventListener("resize", update); };
  }, []);
  const register = useCallback((name: Surface, node: HTMLDivElement | null) => setSlots(current => {
    if (current[name] === (node ?? undefined)) return current;
    return { ...current, [name]: node ?? undefined };
  }), []);
  const show = useCallback((nextTab: Tab = "conversation", nextConversation?: Conversation) => {
    if (document.activeElement instanceof HTMLElement && !panel.current?.contains(document.activeElement)) trigger.current = document.activeElement;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setMounted(true); setTab(nextTab); setGuide(null); setHelpOpen(false); if (nextConversation) setConversation(nextConversation); setOpen(true);
  }, []);
  const prepareGuide = useCallback((index: number) => {
    const next = Math.max(0, Math.min(AGENT_LESSONS.length - 1, index));
    const destination = AGENT_LESSONS[next]!.destination;
    // Show the actual surface behind the spotlight, without clicking any domain control.
    setTab(destination === "writing" ? "conversation" : destination);
    if (destination === "writing") setConversation("writing");
    setGuide(next);
  }, []);
  const learn = useCallback((lesson?: AgentLesson) => {
    if (!helpOpen && guide === null) {
      tutorialTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      guideOrigin.current = { tab, conversation };
    }
    const next = lesson ?? readTutorial(tutorialStorage(), guideKey).current;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setMounted(true); setHelpOpen(false); setCoach(null); prepareGuide(AGENT_LESSONS.findIndex(item => item.id === next)); setOpen(true);
  }, [guideKey, prepareGuide, helpOpen, guide, tab, conversation]);
  useEffect(() => {
    if (guide !== null || helpOpen || !tutorialFocus.current) return;
    const destination = tutorialFocus.current;
    tutorialFocus.current = null;
    const previous = tutorialTrigger.current;
    const target = destination === "coach" ? panel.current?.querySelector<HTMLElement>(".agent-guide-coach")
      : previous?.isConnected && !previous.closest("[hidden], [inert]") ? previous : tutorialButton.current;
    target?.focus({ preventScroll: true });
  }, [guide, helpOpen]);
  const hide = useCallback(() => {
    setOpen(false);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setMounted(false);
    else closeTimer.current = setTimeout(() => setMounted(false), 240);
  }, []);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (open) { if (!document.querySelector("dialog[open]")) close.current?.focus(); }
    else if (wasOpen.current) {
      const target = trigger.current?.isConnected && !trigger.current.closest("[hidden]") ? trigger.current : launcher.current;
      target?.focus();
    }
    wasOpen.current = open;
  }, [open]);
  // Older producers may still request the shared memory view through the kernel.
  useEffect(() => { if (snapshot?.centerOpen) { show("memory"); agent?.setCenterOpen(false); } }, [snapshot?.centerOpen, show, agent]);
  const value = useMemo(() => ({ open, tab, conversation, show, hide, slots, register, learn, readerRuntime, setReaderRuntime, understandingClient }), [open, tab, conversation, show, hide, slots, register, learn, readerRuntime, setReaderRuntime, understandingClient]);
  const tabs = [["conversation", t("伴写对话", "Writing & chat")], ["memory", t("共识与进度", "Shared memory")], ["settings", t("模型与工具", "Models & tools")]] as const;
  // Layout/visibility only; no model selection, authorization or autosave mutations here.
  const commitSidebarWidth = (width: number) => {
    const next = clampAgentWidth(width); setSidebarWidth(next);
    try { localStorage.setItem(AGENT_WIDTH_KEY, String(next)); } catch { /* Width remains available for this session. */ }
  };
  return <Context.Provider value={value}><div className={`agent-layout ${open ? "is-agent-open" : ""} ${resizing ? "is-agent-resizing" : ""}`} style={{ "--agent-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
    <div className="agent-layout-app" inert={open && coversApp} aria-hidden={open && coversApp ? true : undefined}>{children}</div>
    <div className="agent-sidebar-resizer no-print" role="separator" aria-label={t("调节 Agent 面板宽度", "Resize Agent panel")} aria-orientation="vertical" aria-valuemin={AGENT_WIDTH_MIN} aria-valuemax={clampAgentWidth(Number.POSITIVE_INFINITY)} aria-valuenow={sidebarWidth} tabIndex={open && !coversApp ? 0 : -1} hidden={!open || coversApp}
      title={t("拖动调节宽度，双击恢复默认", "Drag to resize; double-click to reset")}
      onDoubleClick={() => commitSidebarWidth(AGENT_WIDTH_DEFAULT)}
      onPointerDown={event => { event.preventDefault(); resizeStart.current = { x: event.clientX, width: sidebarWidth }; event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); }}
      onPointerMove={event => { if (!resizeStart.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return; setSidebarWidth(clampAgentWidth(resizeStart.current.width + resizeStart.current.x - event.clientX)); }}
      onPointerUp={event => { if (!resizeStart.current) return; const next = clampAgentWidth(resizeStart.current.width + resizeStart.current.x - event.clientX); resizeStart.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setResizing(false); commitSidebarWidth(next); }}
      onPointerCancel={() => { if (resizeStart.current) setSidebarWidth(resizeStart.current.width); resizeStart.current = null; setResizing(false); }}
      onKeyDown={event => { const step = event.shiftKey ? 32 : 8; const next = event.key === "Home" ? AGENT_WIDTH_MIN : event.key === "End" ? clampAgentWidth(Number.POSITIVE_INFINITY) : event.key === "ArrowLeft" ? sidebarWidth + step : event.key === "ArrowRight" ? sidebarWidth - step : undefined; if (next === undefined) return; event.preventDefault(); commitSidebarWidth(next); }} />
    <aside ref={panel} id={id} className="agent-sidebar no-print" role={coversApp ? "dialog" : undefined} aria-modal={coversApp ? true : undefined} aria-label="BetterMe Agent" aria-hidden={!open} inert={!open} hidden={!mounted} data-state={open ? "open" : "closed"}
      onAnimationEnd={event => { if (event.currentTarget === event.target && !open && event.animationName === "agent-sidebar-exit") { if (closeTimer.current) clearTimeout(closeTimer.current); setMounted(false); } }}
      onKeyDown={event => {
        if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); hide(); }
        if (coversApp && event.key === "Tab") {
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')].filter(item => item.tabIndex >= 0 && item.getClientRects().length > 0 && !item.closest("[hidden]"));
          const target = event.shiftKey && document.activeElement === items[0] ? items.at(-1) : !event.shiftKey && document.activeElement === items.at(-1) ? items[0] : undefined;
          if (target) { event.preventDefault(); target.focus(); }
        }
      }}>
      <header className="agent-sidebar-header"><div><strong><Bot size={18} />BetterMe Agent</strong><small role="status">{running ? t(`${running} 项任务运行中 · 收起不停止`, `${running} running · Hiding keeps tasks active`) : t("同一份记忆，继续当前对话", "Shared memory across your current conversation")}</small></div>
        <div className="agent-sidebar-header-actions"><button ref={tutorialButton} type="button" className="agent-help-launcher" aria-label={t("打开 Agent 使用指南", "Open Agent guide")} aria-haspopup="dialog" title={t("指南", "Guide")} onClick={openHelp}><CircleHelp size={18} /></button><button ref={close} type="button" aria-label={t("收起 BetterMe Agent", "Collapse BetterMe Agent")} onClick={hide}><PanelRightClose size={18} /></button></div></header>
      {helpOpen && open && <AgentHelpHome context={guideOrigin.current?.tab ?? tab} onLesson={learn} onClose={closeHelp} />}
      {guide !== null && <AgentWorkflowGuide key={guideKey} step={guide} active={open} storageKey={guideKey} onStep={prepareGuide} onDirectory={() => { setGuide(null); setHelpOpen(true); }} onClose={closeHelp} onAction={(destination, lesson) => { tutorialFocus.current = "coach"; setGuide(null); show(destination === "writing" ? "conversation" : destination, destination === "writing" ? "writing" : undefined); setCoach(lesson); }} />}
      <div className="agent-sidebar-work">
      {coach && <AgentGuideCoach lessonId={coach} active={guide === null && open && (AGENT_LESSONS.find(item => item.id === coach)!.destination === "writing" ? tab === "conversation" && conversation === "writing" : tab === AGENT_LESSONS.find(item => item.id === coach)!.destination)} onBack={() => learn(coach)} onClose={() => setCoach(null)} onNavigate={() => { const destination = AGENT_LESSONS.find(item => item.id === coach)!.destination; show(destination === "writing" ? "conversation" : destination, destination === "writing" ? "writing" : undefined); }} />}
      {snapshot?.error && <button type="button" className="agent-sidebar-storage-warning" onClick={() => setTab("memory")}>{t("本地记录需要处理 · 查看恢复选项", "Local records need attention · View recovery options")}</button>}
      <div role="tablist" aria-label={t("BetterMe Agent 视图", "BetterMe Agent views")} className="agent-sidebar-tabs" onKeyDown={event => {
        const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!offset && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault(); const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (tabs.findIndex(([key]) => key === tab) + offset + tabs.length) % tabs.length;
        setTab(tabs[index]![0]); event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
      }}>{tabs.map(([key, label]) => <button type="button" role="tab" key={key} id={`${id}-${key}`} aria-controls={`${id}-${key}-panel`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)}>{label}</button>)}</div>
      <section role="tabpanel" id={`${id}-conversation-panel`} aria-labelledby={`${id}-conversation`} hidden={tab !== "conversation"} className="agent-sidebar-conversation">
        <div className="agent-sidebar-context" role="group" aria-label={t("对话上下文", "Conversation context")}><button type="button" aria-pressed={conversation === "writing"} onClick={() => setConversation("writing")}>{t("当前经历", "Current experience")}</button><button type="button" aria-pressed={conversation === "companion"} onClick={() => setConversation("companion")}>{t("自由对话", "Free chat")}</button></div>
        <div hidden={conversation !== "writing"} className="agent-sidebar-conversation-body"><Slot name="writing" /></div>
        <div hidden={conversation !== "companion"} className="agent-sidebar-conversation-body"><Slot name="companion" /></div>
      </section>
      <section role="tabpanel" id={`${id}-memory-panel`} aria-labelledby={`${id}-memory`} hidden={tab !== "memory"} className="agent-sidebar-memory"><Slot name="memory" /></section>
      <section role="tabpanel" id={`${id}-settings-panel`} aria-labelledby={`${id}-settings`} hidden={tab !== "settings"} className="agent-sidebar-settings">
        <h3><Settings2 size={15} />{t("统一设置", "System settings")}</h3>
        <p>{t("模型、工具与授权统一在系统设置管理。当前对话与任务会保持。", "Manage models, tools and permissions in system settings without losing this conversation.")}</p>
        <button type="button" onClick={() => { hide(); openSystemSettings("tools"); }}>{t("打开系统设置", "Open system settings")}</button>
        {preferenceError && <p role="status">{preferenceError}</p>}
      </section>
      </div>
    </aside>
    <button ref={launcher} hidden={open} type="button" className="agent-sidebar-launcher no-print" aria-label={t("打开 BetterMe Agent", "Open BetterMe Agent")} aria-controls={id} aria-expanded={open} onClick={() => show()}><Bot size={20} />{running > 0 && <span>{running}</span>}</button>
  </div></Context.Provider>;
}
