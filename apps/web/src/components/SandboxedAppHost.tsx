import { useCallback, useEffect, useRef, useState } from "react";
import { Pin, PinOff, ShieldAlert, ShieldCheck } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import { sandboxOfferProjection } from "../lib/sandbox-offer-projection";
import { DesktopWindow } from "./desktop/DesktopWindow";
import {
  revokeAndUninstallMicroApp,
  togglePinMicroApp,
  type InstalledMicroApp,
  type OfferBackcheckProjection,
} from "../lib/micro-app-registry";

export interface SandboxedAppDecisionEvent {
  appId: string;
  action: "onboard" | "negotiate";
  company: string;
  offerId: string;
}


export function SandboxedAppHost({
  app,
  offers,
  onClose,
  onDecision,
}: {
  app: InstalledMicroApp;
  offers?: OfferBackcheckProjection[];
  onClose: () => void;
  onDecision?: (decision: SandboxedAppDecisionEvent) => void;
}) {
  const { t, theme } = useUiPreferences();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [pinned, setPinned] = useState(app.pinnedToDock);
  const [bridgeStatus, setBridgeStatus] = useState<"connecting" | "connected">("connecting");

  const pushAuthorizedProjection = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    // Only send data projections that match the app's explicitly granted scopes.
    const allowedOffers = sandboxOfferProjection(app.grantedScopes, offers);
    win.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/initialize",
        params: {
          appId: app.appId,
          version: app.version,
          codeHash: app.codeHash,
          grantedScopes: app.grantedScopes,
          theme,
          offers: allowedOffers,
        },
      },
      "*"
    );
    setBridgeStatus("connected");
  }, [app.appId, app.codeHash, app.grantedScopes, app.version, offers, theme]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Strict source window verification (MCP-UI security boundary).
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const payload = event.data;
      if (!payload || payload.jsonrpc !== "2.0" || typeof payload.method !== "string") return;

      if (payload.method === "ui/ready") {
        pushAuthorizedProjection();
        return;
      }

      if (payload.method === "workspace/proposeDecision" && payload.params) {
        const { action, company, offerId } = payload.params as {
          action?: string;
          company?: string;
          offerId?: string;
        };
        if ((action === "onboard" || action === "negotiate") && typeof company === "string" && typeof offerId === "string"
          && app.grantedScopes.includes("selected_offers") && offers?.slice(0,20).some(o => o.id === offerId && o.company === company)) {
          onDecision?.({ appId: app.appId, action, company, offerId });
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [app.appId, app.grantedScopes, offers, onDecision, pushAuthorizedProjection]);

  function handleTogglePin() {
    if (app.sessionOnly) return;
    const next = !pinned;
    setPinned(next);
    togglePinMicroApp(app.appId, next);
  }

  function handleRevoke() {
    if (!app.sessionOnly) revokeAndUninstallMicroApp(app.appId);
    onClose();
  }

  return (
    <DesktopWindow
      title={`${app.icon} ${t(app.name, app.nameEn)} · ${t("Agent 微应用", "Agent Micro-App")}`}
      layoutKey={`microapp-${app.appId}`}
      defaultSnap="centered"
      onHide={onClose}
      actions={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className="autopilot-sandbox-origin-tag"
            title="sandbox='allow-scripts' (no allow-same-origin)"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "#38bdf8" }}
          >
            <ShieldCheck size={12} />
            <span>{t("隔离源域", "Isolated")} {bridgeStatus === "connected" ? "· RPC ✓" : ""}</span>
          </span>
          <button
            type="button"
            className="os-toolbar-icon-btn"
            onClick={handleTogglePin}
            hidden={app.sessionOnly === true}
            title={pinned ? t("从 Dock 取消固定", "Unpin from Dock") : t("固定到 Dock", "Pin to Dock")}
          >
            {pinned ? <PinOff size={12} /> : <Pin size={12} />}
            <span>{pinned ? t("已固定", "Pinned") : t("固定", "Pin")}</span>
          </button>
          <button
            type="button"
            className="os-toolbar-icon-btn"
            style={{ borderColor: "rgba(239, 68, 68, 0.35)", color: "#f87171" }}
            onClick={handleRevoke}
            title={app.sessionOnly ? t("结束本次预览", "End this preview") : t("撤权并卸载微应用", "Revoke and uninstall micro-app")}
          >
            <ShieldAlert size={12} />
            <span>{t("撤权", "Revoke")}</span>
          </button>
        </div>
      }
    >
      <div className="autopilot-sandbox-body" style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <iframe
          ref={iframeRef}
          data-testid="sandboxed-microapp-iframe"
          title={app.name}
          sandbox="allow-scripts"
          srcDoc={app.bundleHtml}
          onLoad={pushAuthorizedProjection}
          className="autopilot-sandbox-iframe"
          style={{ width: "100%", height: "100%", border: "none", flex: 1, display: "block" }}
        />
      </div>
    </DesktopWindow>
  );
}
