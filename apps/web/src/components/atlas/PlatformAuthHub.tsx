/** @jsxRuntime automatic */
import { useEffect, useState } from "react";
import { cookieBridgeBookmarklet, requestLocalBridgeGrant } from "../../lib/local-bridge-client";
import {
  ShieldCheck,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Lock,
  Sparkles,
  X,
  LogIn,
  Globe,
  Loader2,
  Bookmark,
  Copy,
  Check,
  Monitor,
  FileCode,
} from "lucide-react";
import {
  getPlatformAuthOverview,
  openPlatformLogin,
  focusRealChrome,
  bridgePlatformCookies,
  type PlatformAuthOverview,
} from "../../lib/real-chrome-client";
import { useUiPreferences } from "../../lib/ui-preferences";
import "./platform-auth-hub.css";

export type PlatformAuthHubProps = {
  isOpen: boolean;
  onClose: () => void;
  onRefreshSearch?: () => void;
};

const PLATFORM_CONFIG: Record<
  "boss" | "liepin" | "51job" | "linkedin",
  { color: string; bg: string; tips: string }
> = {
  boss: {
    color: "#00bebd",
    bg: "rgba(0, 190, 189, 0.1)",
    tips: "BOSS 直聘对未登录或匿名访问有严格反爬，需微信扫码或验证码登录一次，后续自动复用 Cookie。",
  },
  liepin: {
    color: "#ff7000",
    bg: "rgba(255, 112, 0, 0.1)",
    tips: "猎聘已支持免密检索；登录后可穿透更多猎头直聘 JD 与企业内部薪酬范围。",
  },
  "51job": {
    color: "#2a75d3",
    bg: "rgba(42, 117, 211, 0.1)",
    tips: "前程无忧免密检索已就绪；登录后可解锁精准联系人及 HR 活跃状态。",
  },
  linkedin: {
    color: "#0a66c2",
    bg: "rgba(10, 102, 194, 0.1)",
    tips: "领英支持免密访客检索，登录后可查询外企跨国 Headcount 及全球直推岗位。",
  },
};

// Generated only after an explicit action; credentials are never persisted.

export function PlatformAuthHub({ isOpen, onClose, onRefreshSearch }: PlatformAuthHubProps) {
  const { t } = useUiPreferences();
  const [activeTab, setActiveTab] = useState<"browser" | "bridge">("browser");
  const [overview, setOverview] = useState<PlatformAuthOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [actingPlatform, setActingPlatform] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Cookie bridge form state
  const [cookieJson, setCookieJson] = useState("");
  const [bridgePlatform, setBridgePlatform] = useState<string>("auto");
  const [importing, setImporting] = useState(false);
  const [copiedBookmarklet, setCopiedBookmarklet] = useState(false);
  const [bookmarklet, setBookmarklet] = useState("");
  const [extensionOrigin, setExtensionOrigin] = useState("");

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const data = await getPlatformAuthOverview();
      setOverview(data);
      return data;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void fetchStatus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleOpenLogin = async (platformId: "boss" | "liepin" | "51job" | "linkedin" | "all") => {
    setActingPlatform(platformId);
    setMessage(platformId === "all" ? "正在接管 Chrome 打开所有平台登录页并置顶窗口…" : `正在打开 ${platformId.toUpperCase()} 登录页…`);
    try {
      await openPlatformLogin(platformId);
      await focusRealChrome();
      setMessage(t("✅ 已在接管浏览器打开登录页并置顶窗口，请扫码或输入验证码完成登录。", "Login page opened. Please log in in the Chrome window."));
      setTimeout(() => {
        void fetchStatus();
      }, 3000);
    } catch {
      setMessage("打开登录页失败，请确认 Chrome 浏览器已启动。");
    } finally {
      setActingPlatform(null);
    }
  };

  const handleFocus = async () => {
    await focusRealChrome();
  };

  const handleCopyBookmarklet = async () => {
    try {
      const grant = await requestLocalBridgeGrant("cookies");
      const script = cookieBridgeBookmarklet(window.location.origin, grant.token);
      setBookmarklet(script);
      await navigator.clipboard.writeText(script);
      setCopiedBookmarklet(true);
      setMessage(t("✅ 单次授权书签已复制，10 分钟内有效；每次同步前请重新生成。", "Single-use bookmark copied. Valid for 10 minutes; regenerate before each sync."));
      setTimeout(() => setCopiedBookmarklet(false), 2500);
    } catch {
      setMessage(t("授权或复制失败，请在本机工作台重试。", "Authorization or copy failed. Retry in the local workbench."));
    }
  };

  const handleImportJson = async () => {
    if (!cookieJson.trim()) {
      setMessage("请先粘贴 Cookie-Editor 导出的 JSON 内容。");
      return;
    }
    setImporting(true);
    try {
      let parsed: any;
      try {
        parsed = JSON.parse(cookieJson.trim());
      } catch {
        parsed = cookieJson.trim();
      }
      const res = await bridgePlatformCookies({
        platform: bridgePlatform === "auto" ? undefined : bridgePlatform,
        cookies: parsed,
      });
      if (res.success) {
        setMessage(`🎉 成功同步 ${res.count} 个 Cookie 到 BetterMe 本地独立 Profile！`);
        setCookieJson("");
        await fetchStatus();
      } else {
        setMessage(`❌ 同步失败: ${res.error || "未知原因"}`);
      }
    } catch (err: any) {
      setMessage(`❌ 同步异常: ${err.message}`);
    } finally {
      setImporting(false);
    }
  };

  const platforms = overview?.platforms ? Object.values(overview.platforms) : [];

  return (
    <div className="platform-auth-hub-overlay" role="dialog" aria-modal="true" aria-labelledby="platform-auth-title">
      <div className="platform-auth-hub-container">
        <header className="platform-auth-hub-header">
          <div className="platform-auth-hub-title-group">
            <div className="platform-auth-hub-icon-wrap">
              <ShieldCheck size={24} className="platform-auth-hub-icon" />
            </div>
            <div>
              <h2 id="platform-auth-title">全网平台统一登录与会话接管中心</h2>
              <p className="platform-auth-hub-subtitle">
                BOSS直聘 · 猎聘 · 51JOB · 领英 · 一次登录持久复用 · 规避反爬与验证墙
              </p>
            </div>
          </div>
          <button type="button" className="platform-auth-close-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        {/* Tab switcher */}
        <div className="platform-auth-tabs">
          <button
            type="button"
            className={`platform-tab-btn ${activeTab === "browser" ? "active" : ""}`}
            onClick={() => setActiveTab("browser")}
          >
            <Monitor size={15} />
            <span>独立接管窗口（扫码登录 / 人机介入）</span>
          </button>
          <button
            type="button"
            className={`platform-tab-btn ${activeTab === "bridge" ? "active" : ""}`}
            onClick={() => setActiveTab("bridge")}
          >
            <Bookmark size={15} />
            <span>日常浏览器 Cookie 桥接（零扫码推荐）</span>
            <span className="tab-pill-recommend">零扫码</span>
          </button>
        </div>

        <section className="platform-auth-hub-banner">
          {activeTab === "browser" ? (
            <p>
              商业招聘平台普遍拥有严格的登录与反爬策略（如 BOSS 直聘对匿名访问高频弹出滑块或重定向）。BetterMe 采用
              <strong> 真实独立 Chrome 浏览器接管（端口 9222）</strong>。您只需在弹出的 Chrome 窗口中<strong>登录一次</strong>，本地 Profile 目录将永久持久化保存账号与 Cookie。后续所有全网检索将直接享受登录特权！
            </p>
          ) : (
            <p>
              <strong>无需重复扫码！</strong>如果您在日常使用的主力浏览器（Chrome / Edge / Arc）中已经登录过 BOSS直聘、猎聘或领英，只需点击书签或导入 Cookie，即可一键同步到 BetterMe 本地独立 Profile 中，彻底复用已有登录态！
            </p>
          )}
        </section>

        {activeTab === "browser" ? (
          <>
            <div className="platform-auth-hub-quick-actions">
              <button
                type="button"
                className="btn-quick-open-all"
                disabled={actingPlatform !== null}
                onClick={() => handleOpenLogin("all")}
              >
                {actingPlatform === "all" ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                <span>一键打开全部平台登录页（推荐）</span>
              </button>
              <button type="button" className="btn-quick-focus" onClick={handleFocus}>
                <ExternalLink size={15} />
                <span>置顶接管浏览器窗口</span>
              </button>
              <button
                type="button"
                className="btn-quick-refresh"
                disabled={loading}
                onClick={() => void fetchStatus()}
                title="重新检测登录态"
              >
                <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                <span>检测登录态</span>
              </button>
            </div>

            {message && (
              <div className="platform-auth-hub-notice" role="status">
                <CheckCircle2 size={16} />
                <span>{message}</span>
              </div>
            )}

            <div className="platform-auth-hub-grid">
              {platforms.map((p) => {
                const cfg = PLATFORM_CONFIG[p.platformId];
                const isActing = actingPlatform === p.platformId;
                const isGood = p.status === "logged_in" || p.status === "ready";
                const isWarning = p.status === "login_required";

                return (
                  <div key={p.platformId} className={`platform-card ${p.status}`}>
                    <div className="platform-card-header">
                      <div className="platform-card-brand">
                        <span className="platform-brand-badge" style={{ backgroundColor: cfg.bg, color: cfg.color }}>
                          {p.name.slice(0, 2)}
                        </span>
                        <div>
                          <strong className="platform-card-name">{p.name}</strong>
                          <span className="platform-card-sub">{p.platformId.toUpperCase()}</span>
                        </div>
                      </div>
                      <span className={`platform-status-badge ${p.status}`}>
                        {isGood ? <CheckCircle2 size={13} /> : isWarning ? <AlertTriangle size={13} /> : <Lock size={13} />}
                        {p.status === "logged_in" ? "已登录 (Cookie有效)" : p.status === "ready" ? "免密可用" : p.status === "guest" ? "访客模式" : "待登录"}
                      </span>
                    </div>

                    <div className="platform-card-body">
                      <p className="platform-card-status-text">{p.statusText}</p>
                      <p className="platform-card-tips">{cfg.tips}</p>
                    </div>

                    <div className="platform-card-footer">
                      <button
                        type="button"
                        className={`btn-platform-login ${isGood ? "secondary" : "primary"}`}
                        disabled={isActing}
                        onClick={() => handleOpenLogin(p.platformId)}
                      >
                        {isActing ? <Loader2 size={13} className="animate-spin" /> : isGood ? <Globe size={13} /> : <LogIn size={13} />}
                        <span>{isGood ? "在浏览器中查看" : "在 Chrome 打开登录"}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="cookie-bridge-container">
            {message && (
              <div className="platform-auth-hub-notice" role="status">
                <CheckCircle2 size={16} />
                <span>{message}</span>
              </div>
            )}

            <div className="cookie-bridge-grid">
              <div className="cookie-bridge-card">
                <label>
                  {t("岗位同步扩展来源（完整 Origin）", "Job-sync extension origin (full Origin)")}
                  <input value={extensionOrigin} onChange={event => setExtensionOrigin(event.target.value)} placeholder="chrome-extension://extension-id" />
                </label>
                <button type="button" disabled={!extensionOrigin.trim()} onClick={async () => {
                  try {
                    const normalizedOrigin = extensionOrigin.trim().replace(/\/+$/, "");
                    const grant = await requestLocalBridgeGrant("job", normalizedOrigin);
                    await navigator.clipboard.writeText(JSON.stringify({ endpoint: window.location.origin + "/api/jd/sync-extension", ...grant }));
                    setMessage(t("单次岗位同步授权已复制，10 分钟内有效；仅允许填写的来源写入。", "Single-use job-sync authorization copied. Valid for 10 minutes, restricted to the specified origin."));
                  } catch (error) {
                    setMessage(error instanceof Error && error.message ? error.message : t("生成或复制同步授权失败。", "Failed to generate or copy sync authorization."));
                  }
                }}>{t("生成并复制单次同步授权", "Generate and copy one-time sync authorization")}</button>
              </div>
              {/* Method 1: Bookmarklet */}
              <div className="cookie-bridge-card">
                <div className="cookie-bridge-card-header">
                  <div className="bridge-header-title">
                    <Bookmark size={18} className="text-blue-500" />
                    <strong>方案 A：书签脚本一键同步（推荐·最简）</strong>
                  </div>
                  <span className="bridge-badge-fast">零插件 · 点击即同步</span>
                </div>
                <p className="bridge-card-desc">
                  {t("先点击生成单次授权，再拖到书签栏或粘贴到书签。仅限招聘网站，10 分钟内有效，用后失效；旧书签需重新生成。", "Generate a single-use authorization before dragging or copying. Recruitment sites only, expires in 10 minutes. Regenerate old bookmarks.")}
                </p>

                <div className="bookmarklet-action-row">
                  <a
                    href={bookmarklet || "#"}
                    className="bookmarklet-pill-link"
                    title="拖动我到书签栏"
                    onClick={(e) => {
                      e.preventDefault();
                      handleCopyBookmarklet();
                    }}
                  >
                    <Bookmark size={14} />
                    <span>🔖 同步Cookie到BetterMe</span>
                  </a>
                  <button
                    type="button"
                    className="btn-copy-bookmarklet"
                    onClick={handleCopyBookmarklet}
                  >
                    {copiedBookmarklet ? <Check size={14} /> : <Copy size={14} />}
                    <span>{copiedBookmarklet ? "已复制脚本" : "生成并复制书签代码"}</span>
                  </button>
                </div>

                <div className="bridge-steps">
                  <div className="bridge-step-item">
                    <span className="step-num">1</span>
                    <span>把上方蓝色的 <strong>🔖 书签按钮</strong> 拖拽到日常浏览器书签栏（或复制新建书签）</span>
                  </div>
                  <div className="bridge-step-item">
                    <span className="step-num">2</span>
                    <span>在日常浏览器中打开并登录 <strong>BOSS直聘 / 猎聘 / 领英</strong></span>
                  </div>
                  <div className="bridge-step-item">
                    <span className="step-num">3</span>
                    <span>点击一下该书签，看到成功弹窗后即可享受免密/已登录特权检索！</span>
                  </div>
                </div>
              </div>

              {/* Method 2: Cookie-Editor JSON */}
              <div className="cookie-bridge-card">
                <div className="cookie-bridge-card-header">
                  <div className="bridge-header-title">
                    <FileCode size={18} className="text-purple-500" />
                    <strong>方案 B：Cookie-Editor JSON 导入</strong>
                  </div>
                  <span className="bridge-badge-advanced">支持 HttpOnly 全量凭证</span>
                </div>
                <p className="bridge-card-desc">
                  支持从常用开源插件 <code>Cookie-Editor</code> 导出的标准 JSON 数据，可穿透 HttpOnly 安全字段（如 BOSS 的 wt2）。
                </p>

                <div className="cookie-editor-controls">
                  <div className="cookie-editor-field">
                    <label htmlFor="bridge-platform-select">目标平台：</label>
                    <select
                      id="bridge-platform-select"
                      value={bridgePlatform}
                      onChange={(e) => setBridgePlatform(e.target.value)}
                      className="bridge-select"
                    >
                      <option value="auto">自动识别 (根据域名判断)</option>
                      <option value="boss">BOSS直聘 (zhipin.com)</option>
                      <option value="liepin">猎聘 (liepin.com)</option>
                      <option value="51job">前程无忧 51JOB</option>
                      <option value="linkedin">领英 (LinkedIn)</option>
                    </select>
                  </div>
                  <textarea
                    className="cookie-json-textarea"
                    rows={4}
                    placeholder="在此粘贴 Cookie-Editor 导出的 JSON 数组（或 name=val; 格式的 Cookie 文本）..."
                    value={cookieJson}
                    onChange={(e) => setCookieJson(e.target.value)}
                    onInput={(e: any) => setCookieJson(e.target?.value || "")}
                  />
                  <button
                    type="button"
                    className="btn-import-cookies"
                    disabled={importing || !cookieJson.trim()}
                    onClick={handleImportJson}
                  >
                    {importing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                    <span>一键注入 Cookie 到本地独立环境</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <footer className="platform-auth-hub-footer">
          <div className="platform-auth-hub-footer-info">
            <span className="footer-dot-running" />
            <span>独立 Chrome CDP 端口：{overview?.port ?? 9222} · 本地 Profile 持久化存储</span>
          </div>
          <div className="platform-auth-hub-footer-actions">
            {onRefreshSearch && (
              <button
                type="button"
                className="btn-finish-and-search"
                onClick={() => {
                  onClose();
                  onRefreshSearch();
                }}
              >
                <Sparkles size={15} />
                <span>我已完成登录，立即全网检索岗位</span>
              </button>
            )}
            <button type="button" className="btn-auth-done" onClick={onClose}>
              完成
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
