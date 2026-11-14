import { useCallback, useEffect, useState } from "react";
import type { UnderstandingCapability } from "@better-me/agent-contracts";
import { defaultUnderstandingClient, type UnderstandingClient } from "../services/understanding-client";
import { useAgentSidebar } from "./AgentSidebar";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import { nativeToolStatus } from "../lib/native-tool-status";
import { NativeToolConnections } from "./NativeToolConnections";
import { agentBaseLabel, useAgentRouting } from "../lib/agent-routing";
import { useUiPreferences } from "../lib/ui-preferences";

type Notice = "checked" | "none" | "offline" | "";

export function AgentReaderTools({ client = defaultUnderstandingClient, active = true }: { client?: UnderstandingClient; active?: boolean }) {
  const { t } = useUiPreferences();
  const sidebar = useAgentSidebar();
  const { snapshot } = useBetterMeAgent();
  const routing = useAgentRouting();
  const [items, setItems] = useState<UnderstandingCapability[]>([]), [notice, setNotice] = useState<Notice>("");
  const [loading, setLoading] = useState(false), [version, setVersion] = useState(0);
  const refresh = useCallback(() => { setVersion(value => value + 1); window.dispatchEvent(new Event("betterme:native-tools-changed")); }, []);
  const hasSidebar = Boolean(sidebar);
  useEffect(() => {
    if (!active || !hasSidebar) return;
    const controller = new AbortController(); setLoading(true);
    void client.getCapabilities(controller.signal).then(result => { if (!controller.signal.aborted) { setItems(result); setNotice(result.length ? "checked" : "none"); } }).catch(() => {
      if (!controller.signal.aborted) { setItems([]); setNotice("offline"); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, client, hasSidebar, version]);
  if (!sidebar) return null;
  const selected = items.find(item => item.id === sidebar.readerRuntime);
  const unavailable = sidebar.readerRuntime !== "model" && !selected;
  const noticeText = notice === "checked" ? t("已核对本机工具能力。", "Local tool capabilities checked.")
    : notice === "none" ? t("未发现可用于受控阅读的本机 Agent；仍可明确选择配置模型。", "No local agent available for controlled reading was found; you can still choose a configured model explicitly.")
    : notice === "offline" ? t("暂时无法连接本机 Agent，未自动改用其他工具。请检查配套服务后刷新。", "Cannot reach the local agent right now, and no other tool was substituted. Check the companion service and refresh.")
    : "";
  const runtimeLabel = t("项目阅读运行方式", "Project reading runtime");
  return <section tabIndex={-1} className="agent-reader-tools" data-agent-guide="agent-reader" aria-label={t("项目阅读工具", "Project reading tools")}><strong>{t("已安装底座 · 本账号独立授权", "Installed bases · authorized per account")}</strong>
    <p>{routing?.enabled
      ? t(`项目理解跟随 ${agentBaseLabel(routing.policy)}；各业务入口仍使用自己的资料授权，不共享目录权限。`, `Project understanding follows ${agentBaseLabel(routing.policy, t)}; each workflow keeps its own material authorization and shares no folder access.`)
      : t("在上方统一底座中可选择原生工具或自动备援。尚未启用时保留原有项目阅读选择，不改动旧记录。", "Choose a native tool or automatic fallback in the unified base above. Until it is enabled, your existing project reading choice is kept and old records are untouched.")}</p>
    {!routing?.enabled && <label>{runtimeLabel}<select aria-label={runtimeLabel} value={sidebar.readerRuntime} disabled={loading || snapshot?.data.tasks.some(task => task.status === "running")} onChange={event => sidebar.setReaderRuntime(event.target.value)}><option value="model">{t("统一 Agent 所选模型", "Model chosen in the unified Agent")}</option>{unavailable && <option value={sidebar.readerRuntime} disabled>{t("此前工具 · 当前不可确认", "Previous tool · cannot be confirmed now")}</option>}{items.map(item => <option key={item.id} value={item.id} disabled={!item.available || !item.supported}>{item.name} · {nativeToolStatus(item, t)}</option>)}</select></label>}
    <p role="status">{loading ? t("正在检查已安装工具…", "Checking installed tools…") : noticeText}</p>{items.length > 0 && <details><summary>{t("本账号工具授权与状态", "Tool authorization and status for this account")}</summary><NativeToolConnections items={items} client={client} onChange={refresh} /></details>}
    <button type="button" disabled={loading} onClick={refresh}>{t("刷新工具能力", "Refresh tool capabilities")}</button><button type="button" onClick={() => sidebar.learn("tools")}>{t("如何选择与授权", "How to choose and authorize")}</button>
    <p>{t("原生工具仍可能使用云端账号。不会绕过登录、安装工具或静默切换付费 API；Docker 内未安装的宿主机工具不会自动可用。", "Native tools may still use a cloud account. This never bypasses sign-in, installs tools, or silently switches to a paid API; host tools not installed inside Docker are not available automatically.")}</p>
  </section>;
}
