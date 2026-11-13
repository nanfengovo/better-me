import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { TrustRequest } from "./CareerTrustPanel.contracts";
export function useTrustAction(request: TrustRequest) {
  const active = useRef<AbortController | undefined>(undefined), mounted = useRef(true);
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort(); }; }, []);
  async function run<T>(label: string, route: string, body: unknown, schema: z.ZodType<T>): Promise<T | undefined> {
    active.current?.abort(); const controller = new AbortController(); active.current = controller; setBusy(label); setError("");
    try { const value = schema.parse(await request(route, body, controller.signal)); return mounted.current && !controller.signal.aborted && active.current === controller ? value : undefined; }
    catch { if (mounted.current && active.current === controller && !controller.signal.aborted) setError("操作未完成或响应不符合协议。可能发生权限、版本或连接变化；外部操作请先查询结果，勿直接重发。"); return undefined; }
    finally { if (mounted.current && active.current === controller) { active.current = undefined; setBusy(""); } }
  }
  return { busy, error, run, cancel: () => { active.current?.abort(); active.current = undefined; setBusy(""); setError("已停止本地等待；已发送的外部操作结果可能未知，请先核对，不自动重试。"); } };
}
export function TrustActivity({ action }: { action: ReturnType<typeof useTrustAction> }) { return <>{action.busy && <p role="status" className="ctr-status">{action.busy}… <button type="button" onClick={action.cancel}>停止等待</button></p>}{action.error && <p role="alert" className="ctr-warning">{action.error}</p>}</>; }
export function TrustHashDetail({ values }: { values: Record<string, string> }) { return <details className="ctr-proof"><summary>查看精确版本与权限绑定</summary><dl>{Object.entries(values).map(([name, value]) => <div key={name}><dt>{name}</dt><dd><code>{value}</code></dd></div>)}</dl></details>; }
export const futureTime = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
export const toggleTrustValue = (values: string[], value: string) => values.includes(value) ? values.filter(item => item !== value) : [...values, value];
