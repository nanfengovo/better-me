import { createRoot } from "react-dom/client";
import { useState } from "react";
import { GrowthWorkspace } from "../../src/components/GrowthWorkspace";
import { activatePrincipal } from "../../src/lib/identity";
import { readRuntimeConnection } from "../../src/lib/runtime-connection";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";

function Lab() {
  const [dark, setDark] = useState(false);
  return <main><header style={{ padding: "12px 26px", borderBottom: "1px solid var(--ui-border)", display: "flex", gap: 16, flexWrap: "wrap" }}><span>原创样本 · 独立临时账号与 Host · 不连接职业服务</span><button onClick={() => { setDark(!dark); document.documentElement.dataset.theme = dark ? "light" : "dark"; }}>切换{dark ? "浅色" : "深色"}</button></header><GrowthWorkspace /></main>;
}

async function start() {
  const runtime = readRuntimeConnection(); if (!runtime) throw new Error("Isolated learning runtime missing");
  const headers = { Authorization: `Bearer ${runtime.agentToken}`, "Content-Type": "application/json" };
  const requested = new URL(window.location.href).searchParams.get("user") ?? "synthetic-growth-learning";
  const username = /^synthetic-growth-[a-z0-9-]{1,48}$/.test(requested) ? requested : "synthetic-growth-learning";
  let account = await (await fetch("/api/v1/agent/identity/session", { headers })).json();
  if (!account.principal) {
    const credentials = { username, displayName: "原创资料学习验收", password: "synthetic-only-growth-2026" };
    const register = await fetch("/api/v1/agent/identity/register", { method: "POST", headers, body: JSON.stringify(credentials) });
    account = await register.json();
    if (!register.ok) account = await (await fetch("/api/v1/agent/identity/sign-in", { method: "POST", headers, body: JSON.stringify({ username, password: credentials.password }) })).json();
  }
  if (!account.principal) throw new Error("Isolated learning sign-in failed");
  activatePrincipal(account.principal);
  createRoot(document.getElementById("root")!).render(<Lab />);
}
void start().catch(error => { document.getElementById("root")!.textContent = String(error); });
