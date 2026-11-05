import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { IdentityGate, IdentityMenu } from "../../src/components/IdentityGate";
import { captureIdentity, currentPrincipal, ownedFetch } from "../../src/lib/identity";
import { UiPreferencesProvider, useUiPreferences } from "../../src/lib/ui-preferences";
import "../../src/index.css";
import "../../src/studio.css";
import "../../src/atelier.css";
import "../../src/themes/workspace-theme.css";

function Workspace() {
  const user = currentPrincipal()!;
  const [note, setNote] = useState(""), [revision, setRevision] = useState(0), [status, setStatus] = useState("");
  useEffect(() => {
    const assert = captureIdentity();
    void ownedFetch("/api/v1/agent/records/continuity?key=social-fixture", { headers: { Authorization: "Bearer better-me-agent-token" } })
      .then(response => response.json()).then(value => { assert(); setNote(value.value?.note ?? ""); setRevision(value.revision); }).catch(() => undefined);
  }, []);
  async function save() {
    const assert = captureIdentity();
    const response = await ownedFetch("/api/v1/agent/records/continuity?key=social-fixture", { method: "POST",
      headers: { Authorization: "Bearer better-me-agent-token", "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: revision, value: { workspaceKey: "social-fixture", revision: revision + 1, note } }) });
    const result = await response.json(); assert();
    if (response.ok) { setRevision(result.revision); setStatus("合成记录已保存"); } else setStatus("保存未完成");
  }
  return <main className="identity-screen"><section className="identity-card">
    <h1>合成账号工作空间</h1><p>仅独立验收，不读取真实简历、不调用模型。</p>
    <p data-testid="owner">{user.id}</p>
    <label>合成职业记录<textarea aria-label="合成职业记录" value={note} onChange={event => setNote(event.target.value)} style={{ width: "100%", minHeight: 80 }} /></label>
    <button className="studio-button" onClick={() => void save()}>保存合成工作记录</button><p role="status">{status}</p>
    <IdentityMenu />
  </section></main>;
}
function ThemeToggle() {
  const { theme, setTheme } = useUiPreferences();
  return <button type="button" style={{ position: "fixed", top: 4, right: 8, zIndex: 3, fontSize: 11 }} onClick={() => setTheme(theme === "light" ? "dark" : "light")}>合成验收 · 切换明暗</button>;
}
function Lab() {
  return <UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light" }}>
    <ThemeToggle />
    <IdentityGate><Workspace /></IdentityGate>
  </UiPreferencesProvider>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Lab /></StrictMode>);
