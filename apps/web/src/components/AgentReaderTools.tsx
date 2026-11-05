import { useCallback, useEffect, useState } from "react";
import type { UnderstandingCapability } from "@better-me/agent-contracts";
import { defaultUnderstandingClient, type UnderstandingClient } from "../services/understanding-client";
import { useAgentSidebar } from "./AgentSidebar";
import { useBetterMeAgent } from "../lib/betterme-agent/react";
import { nativeToolStatus } from "../lib/native-tool-status";
import { NativeToolConnections } from "./NativeToolConnections";

export function AgentReaderTools({ client = defaultUnderstandingClient }: { client?: UnderstandingClient }) {
  const sidebar = useAgentSidebar();
  const { snapshot } = useBetterMeAgent();
  const [items, setItems] = useState<UnderstandingCapability[]>([]), [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false), [version, setVersion] = useState(0);
  const refresh = useCallback(() => { setVersion(value => value + 1); window.dispatchEvent(new Event("betterme:native-tools-changed")); }, []);
  const shown = sidebar?.open && sidebar.tab === "settings";
  useEffect(() => {
    if (!shown) return;
    const controller = new AbortController(); setLoading(true);
    void client.getCapabilities(controller.signal).then(result => { if (!controller.signal.aborted) { setItems(result); setNotice(result.length ? "已核对本机工具能力。" : "未发现可用于受控阅读的本机 Agent；仍可明确选择配置模型。"); } }).catch(() => {
      if (!controller.signal.aborted) { setItems([]); setNotice("暂时无法连接本机 Agent，未自动改用其他工具。请检查配套服务后刷新。"); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, shown, version]);
  if (!sidebar) return null;
  const selected = items.find(item => item.id === sidebar.readerRuntime);
  const unavailable = sidebar.readerRuntime !== "model" && !selected;
  return <section tabIndex={-1} className="agent-reader-tools" data-agent-guide="agent-reader" aria-label="项目阅读工具"><strong>已安装底座 · 本账号独立授权</strong><p>与伴写推理模型分开选择；仅影响下一轮项目理解。工具与资料仍需分别授权，不继承电脑共享登录。</p>
    <label>项目阅读运行方式<select aria-label="项目阅读运行方式" value={sidebar.readerRuntime} disabled={loading || snapshot?.data.tasks.some(task => task.status === "running")} onChange={event => sidebar.setReaderRuntime(event.target.value)}><option value="model">统一 Agent 所选模型</option>{unavailable && <option value={sidebar.readerRuntime} disabled>此前工具 · 当前不可确认</option>}{items.map(item => <option key={item.id} value={item.id} disabled={!item.available || !item.supported}>{item.name} · {nativeToolStatus(item)}</option>)}</select></label>
    <p role="status">{loading ? "正在检查已安装工具…" : notice}</p>{items.length > 0 && <details><summary>本账号工具授权与状态</summary><NativeToolConnections items={items} client={client} onChange={refresh} /></details>}
    <button type="button" disabled={loading} onClick={refresh}>刷新工具能力</button><button type="button" onClick={() => sidebar.learn("tools")}>如何选择与授权</button>
    <p>原生工具仍可能使用云端账号。不会绕过登录、安装工具或静默切换付费 API；Docker 内未安装的宿主机工具不会自动可用。</p>
  </section>;
}
