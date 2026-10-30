/** @jsxRuntime automatic */
import { useEffect, useState } from "react";
import { Loader2, ShieldCheck, RefreshCw, ExternalLink, Sparkles, CheckCircle2 } from "lucide-react";
import { getRealChromeStatus, launchRealChrome, restartRealChrome, focusRealChrome, type RealChromeStatus } from "../../lib/real-chrome-client";
import { useUiPreferences } from "../../lib/ui-preferences";
import { readRuntimeConnection } from "../../lib/runtime-connection";
import "./real-chrome-launch-bar.css";

export type RealChromeLaunchBarProps = {
  compact?: boolean;
  onLaunched?: (status: RealChromeStatus) => void;
};

export function RealChromeLaunchBar({ compact = false, onLaunched }: RealChromeLaunchBarProps) {
  const { t } = useUiPreferences();
  const [status, setStatus] = useState<RealChromeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const refreshStatus = async () => {
    setLoading(true);
    try {
      const res = await getRealChromeStatus();
      setStatus(res);
      return res;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (readRuntimeConnection()) return;
    if (typeof window !== "undefined") {
      const host = window.location?.hostname || "";
      const isTestEnv = host.includes("fixture.invalid") || host.includes("test") || (typeof process !== "undefined" && Boolean(process.env?.NODE_TEST_CONTEXT));
      if (isTestEnv) {
        return;
      }
    }
    void refreshStatus();
  }, []);

  const pollUntilReady = async (maxAttempts = 15): Promise<RealChromeStatus | null> => {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 450));
      const cur = await getRealChromeStatus();
      if (cur.running) {
        setStatus(cur);
        return cur;
      }
    }
    return null;
  };

  const handleLaunch = async () => {
    setLoading(true);
    setActionMessage(t("正在启动独立调试 Chrome 窗口并建立接管通道…", "Launching Chrome debug window..."));
    try {
      const res = await launchRealChrome();
      setStatus(res);
      if (res.running) {
        setActionMessage(t("✅ 真实 Chrome 浏览器已成功启动并接管，可正常规避滑块与反爬！", "✅ Real Chrome browser launched and connected!"));
        onLaunched?.(res);
        return;
      }
      // If not immediately confirmed, poll automatically
      const ready = await pollUntilReady(14);
      if (ready?.running) {
        setActionMessage(t("✅ 真实 Chrome 浏览器已成功启动并接管，可正常规避滑块与反爬！", "✅ Real Chrome browser launched and connected!"));
        onLaunched?.(ready);
      } else {
        const finalStatus = await getRealChromeStatus();
        setStatus(finalStatus);
        setActionMessage(finalStatus.running ? t("✅ 真实 Chrome 浏览器已就绪！", "✅ Real Chrome ready!") : finalStatus.message);
      }
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : t("启动失败，请检查浏览器安装", "Failed to launch browser"));
    } finally {
      setLoading(false);
    }
  };

  const handleRestart = async () => {
    setLoading(true);
    setActionMessage(t("正在释放占用端口并重新启动真实 Chrome…", "Releasing port and restarting Chrome..."));
    try {
      const res = await restartRealChrome();
      setStatus(res);
      if (res.running) {
        setActionMessage(t("✅ 真实 Chrome 浏览器已重启并重新接管！", "✅ Real Chrome restarted and connected!"));
        onLaunched?.(res);
        return;
      }
      const ready = await pollUntilReady(14);
      if (ready?.running) {
        setActionMessage(t("✅ 真实 Chrome 浏览器已重启并重新接管！", "✅ Real Chrome restarted and connected!"));
        onLaunched?.(ready);
      } else {
        const finalStatus = await getRealChromeStatus();
        setStatus(finalStatus);
        setActionMessage(finalStatus.message);
      }
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : t("重启失败", "Restart failed"));
    } finally {
      setLoading(false);
    }
  };

  const handleFocus = async () => {
    setActionMessage(null);
    await focusRealChrome();
  };

  const isRunning = status?.running ?? false;

  if (readRuntimeConnection()) return <div className="real-chrome-bar-compact" role="note">{t("Docker 模式不接管个人浏览器。请粘贴岗位原文，或使用本机 pnpm dev 完成人工登录与网页读取。", "Docker does not attach your personal browser. Paste a job description, or use pnpm dev for interactive sign-in and page reading.")}</div>;

  if (compact) {
    return (
      <div className={`real-chrome-bar-compact ${isRunning ? "running" : "idle"}`} aria-label="真实浏览器接管状态">
        <span className="real-chrome-status-indicator">
          {isRunning ? (
            <>
              <span className="status-dot green" />
              <ShieldCheck size={14} className="icon-shield" />
              <strong>{t("真实环境已接管 (CDP 9222)", "Real Chrome Connected (CDP 9222)")}</strong>
            </>
          ) : (
            <>
              <span className="status-dot gray" />
              <span>{t("真实 Chrome 未启动", "Real Chrome not running")}</span>
            </>
          )}
        </span>
        <div className="real-chrome-compact-actions">
          {isRunning ? (
            <>
              <button type="button" className="btn-chrome-focus" onClick={handleFocus} title={t("置顶真实浏览器窗口", "Bring browser to front")}>
                {t("置顶窗口", "Bring to Front")}
              </button>
              <button type="button" className="btn-chrome-refresh" disabled={loading} onClick={handleRestart} title={t("重启接管窗口", "Restart Chrome")}>
                <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              </button>
            </>
          ) : (
            <button type="button" className="btn-chrome-launch-compact" disabled={loading} onClick={handleLaunch}>
              {loading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {loading ? t("启动中…", "Launching…") : t("一键启动真实 Chrome", "1-Click Launch Chrome")}
            </button>
          )}
          <button type="button" className="btn-chrome-refresh" disabled={loading} onClick={refreshStatus} title={t("刷新状态", "Refresh status")}>
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`real-chrome-launch-bar ${isRunning ? "running" : "idle"}`}>
      <div className="real-chrome-bar-main">
        <div className="real-chrome-bar-info">
          <div className="real-chrome-badge-row">
            <span className={`real-chrome-badge ${isRunning ? "active" : "inactive"}`}>
              <span className={`status-dot ${isRunning ? "green" : "gray"}`} />
              {isRunning ? (
                <>
                  <ShieldCheck size={14} />
                  <span>{t("真实 Chrome 环境已接管 (防风控)", "Real Chrome Connected (Anti-Bot)")}</span>
                </>
              ) : (
                <span>{t("未连接独立调试浏览器", "No Debug Browser Connected")}</span>
              )}
            </span>
            <span className="real-chrome-port-tag">
              {isRunning ? `CDP Port: ${status?.port ?? 9222}` : t("推荐启动以规避滑块风控", "Recommended to avoid anti-bot sliders")}
            </span>
          </div>
          <p className="real-chrome-bar-desc">
            {isRunning
              ? t(
                  "当前采集已无缝接管本地真实 Chrome，享有完全一致的 TLS、Canvas 指纹及登录 Cookie，大幅降低人机验证拦截率。",
                  "Web scraping is taking over your real Chrome browser, sharing authentic TLS, Canvas fingerprints, and cookies to bypass anti-bot mechanisms.",
                )
              : t(
                  "点击右侧按钮一键启动带独立 Profile 的真实 Chrome。您可在打开的窗口中登录招聘网站，登录态将持久保存并自动复用。",
                  "Click the button to launch a dedicated real Chrome instance. You can log in once to platforms; sessions persist in your local profile.",
                )}
          </p>
        </div>
        <div className="real-chrome-bar-actions">
          {isRunning ? (
            <>
              <button type="button" className="btn-chrome-focus-full" onClick={handleFocus}>
                <ExternalLink size={14} />
                {t("置顶浏览器窗口", "Bring Window to Front")}
              </button>
              <button type="button" className="btn-chrome-restart-full" disabled={loading} onClick={handleRestart} title={t("重置端口并重启", "Restart Chrome")}>
                <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
                {t("重新接管", "Restart")}
              </button>
              <button type="button" className="btn-chrome-refresh-full" disabled={loading} onClick={refreshStatus} title={t("重新检测连接", "Check connection")}>
                <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              </button>
            </>
          ) : (
            <button type="button" className="btn-chrome-launch-primary" disabled={loading} onClick={handleLaunch}>
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              <span>{loading ? t("正在启动并检测…", "Launching & Checking…") : t("一键启动真实 Chrome 接管", "1-Click Launch Real Chrome")}</span>
            </button>
          )}
        </div>
      </div>
      {actionMessage && (
        <div className={`real-chrome-action-notice ${isRunning ? "success" : "info"}`} aria-live="polite">
          {isRunning ? <CheckCircle2 size={15} /> : <ShieldCheck size={15} />}
          <span>{actionMessage}</span>
        </div>
      )}
    </div>
  );
}
