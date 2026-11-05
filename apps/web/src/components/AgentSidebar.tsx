import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bot, CircleHelp, PanelRightClose, Settings2 } from "lucide-react";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import "./agent-sidebar.css";
import { AGENT_LESSONS, AgentWorkflowGuide, type AgentLesson } from "./AgentWorkflowGuide";
import { AgentReaderTools } from "./AgentReaderTools";
import { AgentGuideCoach } from "./AgentGuideCoach";
import { readTutorial, tutorialKey, tutorialStorage } from "../lib/agent-tutorial";
import { privateStorage as localStorage } from "../lib/private-storage";
import { useUiPreferences } from "../lib/ui-preferences";
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
};
const Context = createContext<Sidebar | null>(null);
export const useAgentSidebar = () => useContext(Context);

/** UI lifetime is separate from task lifetime. Stable portal targets never move on tab/route changes. */
export function AgentSurface({ name, children }: { name: Surface; children: ReactNode }) {
  const sidebar = useAgentSidebar();
  if (!sidebar) return children;
  const target = sidebar.slots[name];
  return target ? createPortal(children, target) : null;
}
function Slot({ name }: { name: Surface }) {
  const { register } = useAgentSidebar()!;
  const ref = useCallback((node: HTMLDivElement | null) => register(name, node), [name, register]);
  return <div ref={ref} className={`agent-sidebar-slot agent-sidebar-slot-${name}`} />;
}

export function AgentSidebarProvider({ children, understandingClient }: { children: ReactNode; understandingClient?: UnderstandingClient }) {
  const { t } = useUiPreferences();
  const [open, setOpen] = useState(false), [tab, setTab] = useState<Tab>("conversation"), [conversation, setConversation] = useState<Conversation>("writing");
  const [slots, setSlots] = useState<Sidebar["slots"]>({});
  const [coversApp, setCoversApp] = useState(() => window.matchMedia("(max-width: 840px), (max-height: 500px)").matches);
  const panel = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null), trigger = useRef<HTMLElement | null>(null);
  const launcher = useRef<HTMLButtonElement>(null), wasOpen = useRef(false);
  const tutorialButton = useRef<HTMLButtonElement>(null), tutorialTrigger = useRef<HTMLElement | null>(null);
  const tutorialFocus = useRef<"return" | "coach" | null>(null);
  const { agent, snapshot } = useBetterMeAgent();
  const [guide, setGuide] = useState<number | null>(null);
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
    const update = () => setCoversApp(media.matches);
    media.addEventListener("change", update); return () => media.removeEventListener("change", update);
  }, []);
  const register = useCallback((name: Surface, node: HTMLDivElement | null) => setSlots(current => {
    if (current[name] === (node ?? undefined)) return current;
    return { ...current, [name]: node ?? undefined };
  }), []);
  const show = useCallback((nextTab: Tab = "conversation", nextConversation?: Conversation) => {
    if (document.activeElement instanceof HTMLElement && !panel.current?.contains(document.activeElement)) trigger.current = document.activeElement;
    setTab(nextTab); setGuide(null); if (nextConversation) setConversation(nextConversation); setOpen(true);
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
    tutorialTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const next = lesson ?? readTutorial(tutorialStorage(), guideKey).current;
    setCoach(null); prepareGuide(AGENT_LESSONS.findIndex(item => item.id === next)); setOpen(true);
  }, [guideKey, prepareGuide]);
  useEffect(() => {
    if (guide !== null || !tutorialFocus.current) return;
    const destination = tutorialFocus.current;
    tutorialFocus.current = null;
    const previous = tutorialTrigger.current;
    const target = destination === "coach" ? panel.current?.querySelector<HTMLElement>(".agent-guide-coach")
      : previous?.isConnected && !previous.closest("[hidden], [inert]") ? previous : tutorialButton.current;
    target?.focus({ preventScroll: true });
  }, [guide]);
  const hide = useCallback(() => setOpen(false), []);
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
  const value = useMemo(() => ({ open, tab, conversation, show, hide, slots, register, learn, readerRuntime, setReaderRuntime }), [open, tab, conversation, show, hide, slots, register, learn, readerRuntime, setReaderRuntime]);
  const tabs = [["conversation", t("伴写对话", "Writing & chat")], ["memory", t("共识与进度", "Shared memory")], ["settings", t("模型与工具", "Models & tools")]] as const;
  // Layout/visibility only; no model selection, authorization or autosave mutations here.
  return <Context.Provider value={value}><div className={`agent-layout ${open ? "is-agent-open" : ""}`}>
    <div className="agent-layout-app" inert={open && coversApp} aria-hidden={open && coversApp ? true : undefined}>{children}</div>
    <aside ref={panel} id={id} className="agent-sidebar no-print" role={coversApp ? "dialog" : undefined} aria-modal={coversApp ? true : undefined} aria-label="BetterMe Agent" hidden={!open}
      onKeyDown={event => {
        if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); hide(); }
        if (coversApp && event.key === "Tab") {
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')].filter(item => item.tabIndex >= 0 && item.getClientRects().length > 0 && !item.closest("[hidden]"));
          const target = event.shiftKey && document.activeElement === items[0] ? items.at(-1) : !event.shiftKey && document.activeElement === items.at(-1) ? items[0] : undefined;
          if (target) { event.preventDefault(); target.focus(); }
        }
      }}>
      <header className="agent-sidebar-header"><div><strong><Bot size={18} />BetterMe Agent</strong><small role="status">{running ? t(`${running} 项任务运行中 · 收起不停止`, `${running} running · Hiding keeps tasks active`) : t("同一份记忆，继续当前对话", "Shared memory across your current conversation")}</small></div>
        <div className="agent-sidebar-header-actions"><button ref={tutorialButton} type="button" aria-label={t("Agent 协作教程", "Agent collaboration tutorial")} title={t("协作教程 · 可继续上次章节", "Collaboration tutorial · Resumes last lesson")} onClick={() => learn()}><CircleHelp size={18} /></button><button ref={close} type="button" aria-label={t("收起 BetterMe Agent", "Collapse BetterMe Agent")} onClick={hide}><PanelRightClose size={18} /></button></div></header>
      {guide !== null && <AgentWorkflowGuide key={guideKey} step={guide} active={open} storageKey={guideKey} onStep={prepareGuide} onClose={() => { tutorialFocus.current = "return"; setGuide(null); }} onAction={(destination, lesson) => { tutorialFocus.current = "coach"; setGuide(null); show(destination === "writing" ? "conversation" : destination, destination === "writing" ? "writing" : undefined); setCoach(lesson); }} />}
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
        <h3><Settings2 size={15} />{t("伴写参与方式", "Writing copilot mode")}</h3><Slot name="writing-settings" />
        <h3>{t("统一模型与对话授权", "Unified model & chat access")}</h3><Slot name="companion-settings" /><Slot name="tools" />
        <h3>{t("已安装 Agent 与受控取证", "Installed agents & evidence tools")}</h3><AgentReaderTools client={understandingClient} />{preferenceError && <p role="status">{preferenceError}</p>}
      </section>
      </div>
    </aside>
    <button ref={launcher} hidden={open} type="button" className="agent-sidebar-launcher no-print" aria-label={t("打开 BetterMe Agent", "Open BetterMe Agent")} aria-controls={id} aria-expanded={open} onClick={() => show()}><Bot size={20} />{running > 0 && <span>{running}</span>}</button>
  </div></Context.Provider>;
}
