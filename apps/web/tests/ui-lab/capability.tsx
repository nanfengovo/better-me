import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IdentityGate, IdentityMenu } from "../../src/components/IdentityGate";
import { CareerCapabilityTask } from "../../src/components/CareerCapabilityTask";
import { UiPreferencesProvider } from "../../src/lib/ui-preferences";
import "../../src/index.css";
import "../../src/studio.css";
import "../../src/components/identity.css";

createRoot(document.getElementById("root")!).render(<StrictMode><UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light" }}><IdentityGate>
  <main style={{ maxWidth: 920, margin: "0 auto", padding: "24px 20px", minWidth: 0 }}>
    <header style={{ display: "flex", justifyContent: "space-between", gap: 16 }}><div><small>BETTERME / CAREER WORKSPACE</small><h1>岗位与项目证据报告</h1></div><IdentityMenu /></header>
    <p>独立临时账号与库 · 真实本地 Ollama 生成并执行 · 不连接你的真实简历或历史记录</p>
    <CareerCapabilityTask initiallyOpen />
  </main>
</IdentityGate></UiPreferencesProvider></StrictMode>);
