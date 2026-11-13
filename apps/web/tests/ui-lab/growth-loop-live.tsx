import { createRoot } from "react-dom/client";
import { GrowthJourneyWorkspace } from "../../src/components/GrowthJourneyWorkspace";
import { activatePrincipal } from "../../src/lib/identity";
import { readRuntimeConnection } from "../../src/lib/runtime-connection";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";

async function start() {
  const runtime = readRuntimeConnection(); if (!runtime) throw new Error("Synthetic growth runtime missing");
  const headers = { Authorization: `Bearer ${runtime.agentToken}`, "Content-Type": "application/json" };
  const session = await (await fetch("/api/v1/agent/identity/session", { headers })).json();
  const requestedUser = new URL(window.location.href).searchParams.get("user") ?? "synthetic-growth-browser";
  const username = /^synthetic-growth-[a-z0-9-]{1,48}$/.test(requestedUser) ? requestedUser : "synthetic-growth-browser";
  let account = session;
  if (!account.principal) {
    const credentials = { username, displayName: "隔离成长闭环验收", password: "synthetic-only-growth-2026" };
    const registration = await fetch("/api/v1/agent/identity/register", { method: "POST", headers, body: JSON.stringify(credentials) });
    account = await registration.json();
    if (!registration.ok) account = await (await fetch("/api/v1/agent/identity/sign-in", { method: "POST", headers,
      body: JSON.stringify({ username, password: credentials.password }) })).json();
  }
  if (!account.principal) throw new Error("Synthetic growth login failed");
  activatePrincipal(account.principal);
  createRoot(document.getElementById("root")!).render(<main className="growth-loop-live"><GrowthJourneyWorkspace /></main>);
}
void start().catch(error => { document.getElementById("root")!.textContent = String(error); });
