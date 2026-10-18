import { useUiPreferences } from "../lib/ui-preferences";
/** @jsxRuntime automatic */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isBossDescriptionCollapsed, snapshotFailureMessage } from "../lib/jd-capture-diagnostics";
import {
  analyzeJdMatch,
  getJdMatchReadiness,
  type JdMatchReport,
  type LlmConfig,
  type ProjectedResume,
} from "@better-me/core";
import {
  Target,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Copy,
  Check,
  X,
  Loader2,
  Settings2,
  FileText,
  Link2,
  ImagePlus,
  Upload,
  ExternalLink,
  Globe,
  ShieldCheck,
  Clock3,
} from "lucide-react";
import {
  extractJdLink,
  isJdLinkOnly,
  startJdBrowserSession,
  focusJdBrowserSession,
  extendJdBrowserSession,
  readJdBrowserSession,
  inspectJdBrowserSession,
  closeJdBrowserSession,
  cancelJdBrowserStartRequest,
  stopJdPersistentBrowser,
  normalizeJobShare,
  readJdDraft,
  saveJdDraft,
  readScreenshot,
  reserveScreenshotBatch,
  completeScreenshotBatch,
  recognizeJdScreenshots,
  type JdImportResult,
  type JdExtractionMode,
  type JdBrowserSession,
  type JdBrowserSessionInspection,
  type JdProvenance,
  type JdScreenshot,
} from "../lib/jd-import";
import { JdBrowserStartCleanupError, JdExtractionError, jdFailureGuidance, type JdFailure } from "../lib/jd-errors";
import { jdBrowserCleanupTracker } from "../lib/jd-browser-cleanup";
import { SourcePublicationBadges } from "./atlas/JobSourceBadges";

async function closeTrackedBrowserSession(sessionId: string): Promise<void> {
  const key = `session:${sessionId}`;
  try {
    await closeJdBrowserSession(sessionId);
    jdBrowserCleanupTracker.confirm(key);
  } catch (cause) {
    jdBrowserCleanupTracker.record(key, () => closeJdBrowserSession(sessionId));
    throw cause;
  }
}

type Props = {
  isOpen: boolean;
  onClose: () => void;
  resume: ProjectedResume;
  llmConfig: LlmConfig;
  onOpenConfig: () => void;
  onOpenNetworkSettings: () => void;
  onImportResume?: () => void;
  onEditResume?: () => void;
  initialText?: string;
  initialSource?: { title: string; url?: string; platform: string; observedAt?: string; sourcePublishedAt?: string; sourcePublishedText?: string };
  onSaveOpportunity?: (draft: { text: string; provenance: JdProvenance | null }) => void;
};

const SAMPLE_JD = `【外企/高端智能装备】高级工业软件研发工程师 (.NET / C#)
岗位职责：
1. 负责新一代半导体/新能源自动化物流系统调度平台（RCS / WCS）核心模块架构与研发；
2. 负责异构设备通信协议驱动开发（支持西门子 S7、Modbus TCP、OPC-UA 等工业总线）；
3. 主导多机台/AGV 交通调度算法设计与状态机流转控制，保证 7x24 高并发高可靠运行；
4. 参与设备抽象层与统一 Adapter 接口设计，提升跨工厂项目的标准化复用率。

任职要求：
1. 3 年以上 C# / .NET Core 研发经验，精通 ASP.NET Core、多线程并发与异步 I/O；
2. 熟悉常用工业通讯协议（OPC-UA、Modbus、PLC 通信），有半导体或仓储物流调度系统（RCS/WCS）经验者优先；
3. 具备良好的软件架构设计能力，注重代码质量与单元测试；
4. 英语良好，能阅读英文技术文档与参与国际化团队技术协作。`;

export function JdMatchModal({
  isOpen,
  onClose,
  resume,
  llmConfig,
  onOpenConfig,
  onOpenNetworkSettings,
  onImportResume,
  onEditResume,
  initialText,
  initialSource,
  onSaveOpportunity,
}: Props) {
  const { t, locale } = useUiPreferences();
  const uiTextRef = useRef(t);
  uiTextRef.current = t;

  const [initialDraft] = useState(() => {
    const previous = readJdDraft();
    return initialText === undefined ? previous : { text: initialText, shareInput: "", provenance: null };
  });
  const [draftEdited, setDraftEdited] = useState(false);
  const [jdText, setJdText] = useState(initialDraft.text);
  const [provenance, setProvenance] = useState<JdProvenance | null>(initialDraft.provenance);
  const [shareInput, setShareInput] = useState(initialDraft.shareInput);
  const [tab, setTab] = useState<"text" | "link" | "screenshot">("text");
  const [screenshots, setScreenshots] = useState<JdScreenshot[]>([]);
  const [pending, setPending] = useState<JdImportResult | null>(null);
  const [acquiring, setAcquiring] = useState<"link" | "browser" | "browser-stop" | "session-start" | "session-focus" | "session-extend" | "session-read" | "session-inspect" | "session-close" | "ocr" | "images" | null>(null);
  const closingBrowser = acquiring === "session-close" || acquiring === "browser-stop";
  const [browserSession, setBrowserSession] = useState<JdBrowserSession | null>(null);
  const [sessionInspection, setSessionInspection] = useState<JdBrowserSessionInspection | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const cleanupStatus = useSyncExternalStore(jdBrowserCleanupTracker.subscribe, jdBrowserCleanupTracker.getSnapshot, jdBrowserCleanupTracker.getSnapshot);
  const [draftStatus, setDraftStatus] = useState(t("JD 文字与来源保存在此浏览器", "JD text and sources are stored in this browser"));
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<JdMatchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<"link" | "other">("other");
  const [linkFailure, setLinkFailure] = useState<JdFailure | null>(null);
  const [copied, setCopied] = useState(false);
  const requestVersion = useRef(0);
  const acquisitionVersion = useRef(0);
  const acquisitionController = useRef<AbortController | null>(null);
  const browserSessionRef = useRef<JdBrowserSession | null>(null);
  const sessionUiActive = useRef(isOpen);
  const imageVersion = useRef(0);
  const screenshotsRef = useRef<JdScreenshot[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const readiness = getJdMatchReadiness(resume);
  const readinessMessage = t(readiness.message, readiness.reason === "mixed-demo" ? "The current resume still mixes in demo experience, wording or sample education. Replace or hide that content before analyzing your match." : readiness.reason === "demo" ? "This resume contains demo content and cannot assess your own job match. Import your resume or replace the sample with your actual experience and achievements." : readiness.reason === "insufficient" ? "This view lacks experience evidence for analysis. Add your work, projects or education and related content; a name, contact details, target roles or a skills list alone are insufficient." : "This view has experience content for analysis. This does not verify the facts or your capabilities.");

  useEffect(() => {
    requestVersion.current += 1;
    setLoading(false);
    setReport(null);
    setError(null);
    setLinkFailure(null);
    setCopied(false);
    return () => { requestVersion.current += 1; };
  }, [isOpen, jdText, resume, llmConfig]);

  useEffect(() => {
    sessionUiActive.current = isOpen;
    acquisitionVersion.current += 1;
    acquisitionController.current?.abort();
    acquisitionController.current = null;
    const previousSession = browserSessionRef.current;
    browserSessionRef.current = null;
    setBrowserSession(null);
    setSessionInspection(null);
    setSessionNotice(null);
    if (previousSession) void closeTrackedBrowserSession(previousSession.sessionId).catch(() => undefined);
    imageVersion.current += 1;
    screenshotsRef.current = screenshotsRef.current.filter((image) => image.dataUrl);
    setScreenshots(screenshotsRef.current);
    setAcquiring(null);
    setPending(null);
    return () => {
      sessionUiActive.current = false;
      acquisitionVersion.current += 1;
      acquisitionController.current?.abort();
      acquisitionController.current = null;
      const session = browserSessionRef.current;
      browserSessionRef.current = null;
      if (session) void closeTrackedBrowserSession(session.sessionId).catch(() => undefined);
      imageVersion.current += 1;
    };
  }, [isOpen, llmConfig]);

  useEffect(() => {
    if (!browserSession) return;
    const expire = () => {
      if (browserSessionRef.current?.sessionId !== browserSession.sessionId || browserSessionRef.current.expiresAt !== browserSession.expiresAt) return;
      acquisitionVersion.current += 1;
      acquisitionController.current?.abort();
      acquisitionController.current = null;
      browserSessionRef.current = null;
      setBrowserSession(null);
      setSessionInspection(null);
      setAcquiring(null);
      setPending(null);
      const failure: JdFailure = { code: "browser_session_expired", stage: "service", message: uiTextRef.current("本次岗位页已到期，请重新打开。专用浏览器保留本站登录，是否需要重新验证由原网站决定。", "This job page has expired. Open it again. The dedicated browser keeps the site's login; the original site decides whether verification is required.") };
      setErrorSource("link");
      setLinkFailure(failure);
      setError(failure.message);
      void closeTrackedBrowserSession(browserSession.sessionId).catch(() => undefined);
    };
    const timer = setTimeout(expire, Math.max(0, Date.parse(browserSession.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [browserSession]);

  useEffect(() => {
    const endOnPageHide = () => {
      acquisitionVersion.current += 1;
      acquisitionController.current?.abort();
      acquisitionController.current = null;
      const session = browserSessionRef.current;
      browserSessionRef.current = null;
      setBrowserSession(null);
      setSessionInspection(null);
      setAcquiring(null);
      if (session) void closeTrackedBrowserSession(session.sessionId).catch(() => undefined);
    };
    window.addEventListener("pagehide", endOnPageHide);
    return () => window.removeEventListener("pagehide", endOnPageHide);
  }, []);

  useEffect(() => {
    if (initialText !== undefined) {
      setDraftStatus(uiTextRef.current("当前为收藏岗位的分析副本；修改仅保留在本次窗口，原始 JD 草稿和岗位记录保持原样。", "This is an analysis copy of a saved job. Edits stay in this window; the original JD draft and job record are unchanged."));
      return;
    }
    if (initialDraft.recoveryRaw !== undefined && !draftEdited) {
      setDraftStatus(uiTextRef.current("原 JD 草稿部分数据无法读取，已保留原文；编辑后先备份再保存。", "Some JD draft data could not be read. The source is kept; back it up before saving edits."));
      return;
    }
    setDraftStatus(uiTextRef.current("正在保存 JD 草稿…", "Saving JD draft…"));
    const persist = () => {
      try {
        saveJdDraft({ text: jdText, shareInput, provenance, recoveryRaw: initialDraft.recoveryRaw });
        setDraftStatus(uiTextRef.current("JD 草稿已自动保存到此浏览器", "JD draft saved automatically in this browser"));
      } catch (err) {
        setDraftStatus(err instanceof Error ? uiTextRef.current(`草稿未保存：${err.message}`, `Draft not saved: ${err.message}`) : uiTextRef.current("草稿保存失败，请手动复制文字。", "Draft save failed. Copy the text manually."));
      }
    };
    const timer = setTimeout(persist, 500);
    window.addEventListener("pagehide", persist);
    return () => { clearTimeout(timer); window.removeEventListener("pagehide", persist); };
  }, [jdText, shareInput, provenance, initialDraft.recoveryRaw, draftEdited, initialText]);

  function invalidateAcquisition(cancelImages = true, keepBrowserSession = false) {
    acquisitionVersion.current += 1;
    acquisitionController.current?.abort();
    acquisitionController.current = null;
    setSessionNotice(null);
    setSessionInspection(null);
    if (!keepBrowserSession) {
      const session = browserSessionRef.current;
      browserSessionRef.current = null;
      setBrowserSession(null);
      if (session) {
        const version = acquisitionVersion.current;
        void closeTrackedBrowserSession(session.sessionId).catch(() => {
          if (sessionUiActive.current && version === acquisitionVersion.current) setSessionNotice(t("未能确认岗位页已关闭。再次点击“浏览器读取”时会先重试结束上一岗位页，确认关闭后再打开新岗位；专用浏览器及本站登录保留。", "The job page closure is unconfirmed. Browser reading will retry closing it before opening another job. The dedicated browser and site login are kept."));
        });
      }
    }
    setAcquiring(null);
    setPending(null);
    setError(null);
    setLinkFailure(null);
    setErrorSource("other");
    if (cancelImages) {
      imageVersion.current += 1;
      screenshotsRef.current = screenshotsRef.current.filter((image) => image.dataUrl);
      setScreenshots(screenshotsRef.current);
    }
  }

  function changeJdText(value: string) {
    requestVersion.current += 1;
    invalidateAcquisition();
    setJdText(value);
    setDraftEdited(true);
    setProvenance((current) => current ? { ...current, edited: true } : { kind: "text", observedAt: new Date().toISOString() });
  }

  async function handleExtractLink(mode: JdExtractionMode = "static") {
    if (browserSessionRef.current || acquiring) return;
    invalidateAcquisition();
    requestVersion.current += 1;
    setLoading(false);
    const version = acquisitionVersion.current;
    const controller = new AbortController();
    acquisitionController.current = controller;
    const timeoutMs = mode === "browser" ? 65_000 : 20_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    setAcquiring(mode === "browser" ? "browser" : "link");
    setErrorSource("link");
    setError(null);
    try {
      const result = await extractJdLink(shareInput, controller.signal, mode);
      if (version !== acquisitionVersion.current) return;
      setPending(result);
    } catch (err) {
      if (version !== acquisitionVersion.current) return;
      const failure: JdFailure = controller.signal.aborted
        ? { code: "timeout", stage: mode === "browser" ? "page" : "connect", message: mode === "browser" ? t("浏览器读取超过 65 秒，已取消本次请求。", "Browser reading exceeded 65 seconds; this request was canceled.") : t("岗位读取超过 20 秒，已取消本次请求。", "Job reading exceeded 20 seconds; this request was canceled.") }
        : err instanceof JdExtractionError ? err.failure
          : { code: "service_unavailable", stage: "service", message: err instanceof Error ? err.message : t("岗位读取服务未能完成请求，请确认本地服务正在运行。", "The job reader could not complete the request. Check that the local server is running.") };
      setErrorSource("link");
      setLinkFailure(failure);
      setError(failure.message);
    } finally {
      clearTimeout(timeout);
      if (acquisitionController.current === controller) acquisitionController.current = null;
      if (version === acquisitionVersion.current) setAcquiring(null);
    }
  }

  async function handleStartBrowserSession(readAfterOpen = false) {
    if (browserSessionRef.current || acquisitionController.current || acquiring) return;
    invalidateAcquisition();
    requestVersion.current += 1;
    setLoading(false);
    const version = acquisitionVersion.current;
    const controller = new AbortController();
    acquisitionController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 40_000);
    setAcquiring("session-start");
    setErrorSource("link");
    let openedSession: JdBrowserSession | undefined;
    try {
      const session = await startJdBrowserSession(shareInput, controller.signal);
      if (version !== acquisitionVersion.current) {
        void closeTrackedBrowserSession(session.sessionId).catch(() => undefined);
        return;
      }
      browserSessionRef.current = session;
      setBrowserSession(session);
      openedSession = session;
    } catch (cause) {
      if (cause instanceof JdBrowserStartCleanupError) {
        jdBrowserCleanupTracker.record(`start:${cause.requestId}`, () => cancelJdBrowserStartRequest(cause.input, cause.requestId));
      }
      if (version !== acquisitionVersion.current) return;
      const failure: JdFailure = cause instanceof JdExtractionError ? cause.failure : controller.signal.aborted
        ? { code: "timeout", stage: "service", message: t("打开独立浏览器超过 40 秒，本次请求已取消。", "Opening the dedicated browser exceeded 40 seconds; the request was canceled.") }
        : { code: "service_unavailable", stage: "service", message: cause instanceof Error ? cause.message : t("无法打开独立浏览器。", "Could not open the dedicated browser.") };
      setErrorSource("link"); setLinkFailure(failure); setError(failure.message);
    } finally {
      clearTimeout(timeout);
      if (acquisitionController.current === controller) acquisitionController.current = null;
      if (version === acquisitionVersion.current) setAcquiring(null);
    }
    if (readAfterOpen && openedSession && version === acquisitionVersion.current
      && browserSessionRef.current?.sessionId === openedSession.sessionId && !controller.signal.aborted) {
      await handleReadBrowserSession();
    }
  }

  async function handleFocusBrowserSession() {
    const session = browserSessionRef.current;
    if (!session || acquisitionController.current || acquiring) return;
    const version = ++acquisitionVersion.current;
    const controller = new AbortController();
    acquisitionController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 7_000);
    setSessionNotice(null);
    setAcquiring("session-focus");
    try {
      await focusJdBrowserSession(session, controller.signal);
      if (version !== acquisitionVersion.current || browserSessionRef.current?.sessionId !== session.sessionId) return;
      setSessionNotice(t("已请求显示本次岗位页；若未切到前台，请从任务栏打开工具 Edge。", "Requested this job page to be shown. If it stays in the background, open the dedicated Edge from the taskbar."));
    } catch (cause) {
      if (version !== acquisitionVersion.current || browserSessionRef.current?.sessionId !== session.sessionId) return;
      if (cause instanceof JdExtractionError && cause.failure.code === "browser_session_expired") {
        browserSessionRef.current = null;
        setBrowserSession(null);
        setSessionInspection(null);
        void closeTrackedBrowserSession(session.sessionId).catch(() => undefined);
      }
      setSessionNotice(controller.signal.aborted ? t("请求显示本次岗位页超时，未确认标签页已激活；请从任务栏打开工具 Edge 核对。", "Showing the job page timed out; tab activation is unconfirmed. Check the dedicated Edge from the taskbar.")
        : cause instanceof JdExtractionError ? cause.failure.message : t("未能请求显示本次岗位页，请从任务栏打开工具 Edge 核对。", "Could not request this job page to be shown. Check the dedicated Edge from the taskbar."));
    } finally {
      clearTimeout(timeout);
      if (acquisitionController.current === controller) acquisitionController.current = null;
      if (version === acquisitionVersion.current) setAcquiring(null);
    }
  }

  async function handleExtendBrowserSession() {
    const session = browserSessionRef.current;
    if (!session || acquisitionController.current || acquiring) return;
    const version = ++acquisitionVersion.current;
    const controller = new AbortController();
    acquisitionController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 7_000);
    setAcquiring("session-extend");
    setSessionNotice(null);
    try {
      const extended = await extendJdBrowserSession(session, controller.signal);
      if (version !== acquisitionVersion.current || browserSessionRef.current?.sessionId !== session.sessionId) return;
      browserSessionRef.current = extended;
      setBrowserSession(extended);
      setSessionNotice(t(`已延长当前岗位页的保留时间，到 ${new Date(extended.expiresAt).toLocaleTimeString(locale === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit" })} 时尝试关闭。可继续在同一页面处理登录或验证。`, `The page is kept until ${new Date(extended.expiresAt).toLocaleTimeString(locale === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit" })}, when closure will be attempted. Continue login or verification on the same page.`));
    } catch (cause) {
      if (version !== acquisitionVersion.current || browserSessionRef.current?.sessionId !== session.sessionId) return;
      if (cause instanceof JdExtractionError && cause.failure.code === "browser_session_expired") {
        browserSessionRef.current = null;
        setBrowserSession(null);
        setSessionInspection(null);
        void closeTrackedBrowserSession(session.sessionId).catch(() => undefined);
        setSessionNotice(t("本次岗位页已结束，无法延长。需要再次读取时请重新打开岗位。", "This job page has ended and cannot be extended. Open the job again to read it."));
      } else {
        setSessionNotice(t("未确认延长，仍按原到期时间处理；当前岗位页保留，可再次尝试。若原期限已到，页面会结束。", "Extension is unconfirmed, so the original expiry still applies. The current page is kept and you can retry before it expires."));
      }
    } finally {
      clearTimeout(timeout);
      if (acquisitionController.current === controller) acquisitionController.current = null;
      if (version === acquisitionVersion.current) setAcquiring(null);
    }
  }

  async function handleReadBrowserSession() {
    const session = browserSessionRef.current;
    if (!session || acquisitionController.current || acquiring) return;
    invalidateAcquisition(true, true);
    requestVersion.current += 1;
    setLoading(false);
    const version = acquisitionVersion.current;
    const controller = new AbortController();
    acquisitionController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 50_000);
    setAcquiring("session-read");
    setErrorSource("link");
    try {
      const result = await readJdBrowserSession(session, controller.signal);
      if (version !== acquisitionVersion.current || browserSessionRef.current?.sessionId !== session.sessionId) return;
      browserSessionRef.current = null;
      setBrowserSession(null);
      setPending(result);
      try { await closeTrackedBrowserSession(session.sessionId); }
      catch { if (sessionUiActive.current && version === acquisitionVersion.current) setSessionNotice(t("正文已取得，但未能确认岗位页关闭。再次点击“浏览器读取”时会先重试结束上一岗位页，确认关闭后再打开新岗位；专用浏览器及本站登录保留。", "The description was retrieved, but closure is unconfirmed. Browser reading will retry closing the previous page before opening another. The dedicated browser and site login are kept.")); }
    } catch (cause) {
      if (version !== acquisitionVersion.current || browserSessionRef.current?.sessionId !== session.sessionId) return;
      const failure: JdFailure = controller.signal.aborted
        ? { code: "timeout", stage: "page", message: t("岗位读取超过 50 秒，已取消本次读取；当前岗位页按原期限保留，可以稍后检查或再次读取。", "Reading exceeded 50 seconds and was canceled. The current job page stays until its original expiry; check or read it again later.") }
        : cause instanceof JdExtractionError ? cause.failure : { code: "service_unavailable", stage: "service", message: cause instanceof Error ? cause.message : t("独立浏览器尚未取得正文。", "The dedicated browser has not retrieved the description.") };
      if (failure.code === "timeout") failure.message = t("本次读取超时，已取消本次读取；当前岗位页按原期限保留，可以稍后检查或再次读取。需要更多时间时可点击“再保留 10 分钟”。", "Reading timed out and was canceled. The job page stays until its original expiry; check or read it again later. Choose Keep for 10 more minutes if needed.");
      if (failure.code === "browser_session_expired") {
        browserSessionRef.current = null;
        setBrowserSession(null);
        setSessionInspection(null);
        void closeTrackedBrowserSession(session.sessionId).catch(() => undefined);
      }
      setErrorSource("link"); setLinkFailure(failure); setError(failure.message);
    } finally {
      clearTimeout(timeout);
      if (acquisitionController.current === controller) acquisitionController.current = null;
      if (version === acquisitionVersion.current) setAcquiring(null);
    }
  }

  async function handleEndBrowserSession() {
    const session = browserSessionRef.current;
    if (!session) return;
    browserSessionRef.current = null;
    setBrowserSession(null);
    invalidateAcquisition();
    const version = acquisitionVersion.current;
    setAcquiring("session-close");
    setSessionNotice(t("正在关闭本次岗位页…", "Closing this job page…"));
    try {
      await closeTrackedBrowserSession(session.sessionId);
      if (sessionUiActive.current && version === acquisitionVersion.current) setSessionNotice(t("岗位页已关闭，专用招聘浏览器及本站登录保留，可继续读取其他岗位。", "Job page closed. The dedicated browser and site login are kept for reading other jobs."));
    } catch {
      if (sessionUiActive.current && version === acquisitionVersion.current) setSessionNotice(t("未能确认岗位页已关闭。再次点击“浏览器读取”时会先重试结束上一岗位页，确认关闭后再打开新岗位；专用浏览器及本站登录保留。", "The job page closure is unconfirmed. Browser reading will retry closing it before opening another job. The dedicated browser and site login are kept."));
    } finally {
      if (version === acquisitionVersion.current) setAcquiring(null);
    }
  }

  async function handleStopPersistentBrowser() {
    if (acquisitionController.current || acquiring) return;
    invalidateAcquisition();
    const version = acquisitionVersion.current;
    setAcquiring("browser-stop");
    try {
      await stopJdPersistentBrowser();
      if (sessionUiActive.current && version === acquisitionVersion.current) setSessionNotice(t("专用招聘浏览器已关闭。本站登录保存在本机，再次读取时沿用；原网站可能要求重新登录或验证。", "Dedicated browser closed. Site login is kept locally for later reads; the site may still request login or verification."));
    } catch (cause) {
      if (sessionUiActive.current && version === acquisitionVersion.current) setSessionNotice(cause instanceof Error ? cause.message : t("无法确认招聘浏览器已关闭，请检查专用窗口。", "Browser closure is unconfirmed. Check the dedicated window."));
    } finally {
      if (version === acquisitionVersion.current) setAcquiring(null);
    }
  }

  async function handleInspectBrowserSession() {
    const session = browserSessionRef.current;
    if (!session || acquisitionController.current || acquiring) return;
    invalidateAcquisition(true, true);
    requestVersion.current += 1;
    setLoading(false);
    const version = acquisitionVersion.current;
    const controller = new AbortController();
    acquisitionController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setAcquiring("session-inspect");
    setErrorSource("link");
    try {
      const inspection = await inspectJdBrowserSession(session, controller.signal);
      if (version !== acquisitionVersion.current || browserSessionRef.current?.sessionId !== session.sessionId) return;
      setSessionInspection(inspection);
    } catch (cause) {
      if (version !== acquisitionVersion.current || browserSessionRef.current?.sessionId !== session.sessionId) return;
      const failure: JdFailure = controller.signal.aborted
        ? { code: "timeout", stage: "page", message: t("检查当前窗口超过 15 秒，已取消本次检查；当前岗位页按原期限保留，可以稍后再次检查或读取。", "Checking exceeded 15 seconds and was canceled. The job page stays until its original expiry; check or read it again later.") }
        : cause instanceof JdExtractionError ? cause.failure : { code: "service_unavailable", stage: "service", message: cause instanceof Error ? cause.message : t("无法检查当前独立浏览器窗口。", "Could not inspect the dedicated browser window.") };
      if (failure.code === "timeout") failure.message = t("检查当前窗口超时，已取消本次检查；当前岗位页按原期限保留，可以稍后再次检查或读取。需要更多时间时可点击“再保留 10 分钟”。", "Inspection timed out and was canceled. The page stays until its original expiry; check or read it again later. Choose Keep for 10 more minutes if needed.");
      if (failure.code === "browser_session_expired") {
        browserSessionRef.current = null;
        setBrowserSession(null);
        void closeTrackedBrowserSession(session.sessionId).catch(() => undefined);
      }
      setErrorSource("link"); setLinkFailure(failure); setError(failure.message);
    } finally {
      clearTimeout(timeout);
      if (acquisitionController.current === controller) acquisitionController.current = null;
      if (version === acquisitionVersion.current) setAcquiring(null);
    }
  }

  async function addScreenshots(files: File[]) {
    if (!files.length) return;
    setErrorSource("other");
    invalidateAcquisition(false);
    const version = imageVersion.current;
    let reserved: JdScreenshot[] = [];
    setError(null);
    setAcquiring("images");
    try {
      reserved = reserveScreenshotBatch(files, screenshotsRef.current);
      screenshotsRef.current = [...screenshotsRef.current, ...reserved];
      setScreenshots(screenshotsRef.current);
      const loaded = await Promise.all(files.map(readScreenshot));
      if (version !== imageVersion.current) return;
      screenshotsRef.current = completeScreenshotBatch(screenshotsRef.current, reserved, loaded);
      setScreenshots(screenshotsRef.current);
    } catch (err) {
      if (version === imageVersion.current) {
        const failed = new Set(reserved.map((image) => image.id));
        screenshotsRef.current = screenshotsRef.current.filter((image) => !failed.has(image.id));
        setScreenshots(screenshotsRef.current);
        setError(err instanceof Error ? err.message : t("截图读取失败。", "Could not read the screenshot."));
      }
    } finally {
      if (version === imageVersion.current) setAcquiring(screenshotsRef.current.some((image) => !image.dataUrl) ? "images" : null);
    }
  }

  async function handleRecognize() {
    setErrorSource("other");
    setLinkFailure(null);
    if (!llmConfig.apiKey?.trim() && llmConfig.provider === "gemini") {
      setError(t("请先配置 Gemini API Key，并选择支持图片输入的模型。", "Configure a Gemini API key and select a model that accepts images first."));
      onOpenConfig();
      return;
    }
    invalidateAcquisition();
    const version = acquisitionVersion.current;
    setAcquiring("ocr");
    setError(null);
    let sourceUrl: string | undefined;
    try { sourceUrl = normalizeJobShare(shareInput).url; } catch { /* Screenshots can be used without a link. */ }
    try {
      const result = await recognizeJdScreenshots(llmConfig, screenshots, sourceUrl);
      if (version !== acquisitionVersion.current) return;
      setPending(result);
    } catch (err) {
      if (version === acquisitionVersion.current) setError(`${err instanceof Error ? err.message : t("截图识别失败。", "Screenshot recognition failed.")} ${t("请确认当前模型支持图片输入。", "Check that the current model accepts images.")}`);
    } finally {
      if (version === acquisitionVersion.current) setAcquiring(null);
    }
  }

  let originalLink: string | undefined;
  try { originalLink = normalizeJobShare(shareInput).url; } catch { /* Display an original link only when it is recognized. */ }

  if (!isOpen) return null;

  const handleStartAnalysis = async () => {
    invalidateAcquisition();
    setErrorSource("other");
    setLinkFailure(null);
    if (!readiness.ready) {
      setReport(null);
      setError(readinessMessage);
      return;
    }
    if (!jdText.trim() || isJdLinkOnly(jdText)) {
      setError(t("请先输入岗位正文，或提取链接/截图后确认文字。", "Enter a job description, or extract and confirm text from a link or screenshot first."));
      return;
    }
    if (!llmConfig.apiKey?.trim() && llmConfig.provider === "gemini") {
      setError(t("请先配置 Gemini API Key。", "Configure a Gemini API key first."));
      onOpenConfig();
      return;
    }

    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    setReport(null);
    setCopied(false);
    try {
      const res = await analyzeJdMatch(llmConfig, resume, jdText);
      if (version !== requestVersion.current) return;
      setReport(res);
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err instanceof Error ? err.message : t("分析匹配失败，请检查网络或配置。", "Match analysis failed. Check your connection or configuration."));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  };

  const handleCopyReport = async () => {
    if (!report || !readiness.ready) return;
    setErrorSource("other");
    setLinkFailure(null);
    const version = requestVersion.current;
    const text = `# BetterMe 岗位材料匹配参考报告
AI 文本参考评分：${report.matchScore} / 100
仅比较当前选择的简历内容与岗位文本，不是能力认证或录用概率；简历未提及不等于本人不会。
AI 结论与改写均待核实。引用对应原文，不代表改写中的技能、数字、职责或业务场景已确认。
总体评价：${report.scoreSummary}

## 模型提出的契合点（待核对）
${report.matchingStrengths.map((s) => `- ${s}`).join("\n")}

## 待核对的要求与材料依据
${report.missingGaps.map((g) => `- ${g}`).join("\n")}

## 表达建议（原文已定位，改写待核实）
${report.unverifiedSuggestionCount ? `已排除 ${report.unverifiedSuggestionCount} 条无法对应当前简历原文的建议。` : ""}
${report.tailoredSuggestions
  .map(
    (t, i) =>
      `### 建议 ${i + 1}
引用要点：${t.claimId}
原表述：${t.currentText ?? "无"}
候选改写（逐项核实后再使用）：${t.suggestedText}
理由：${t.reason}`,
  )
  .join("\n\n")}

## 面试深挖追问预警
${report.interviewDefenseTips.map((tip) => `- ${tip}`).join("\n")}
`;
    try {
      await navigator.clipboard.writeText(text);
      if (version !== requestVersion.current) return;
      setError(null);
      setCopied(true);
      setTimeout(() => {
        if (version === requestVersion.current) setCopied(false);
      }, 2000);
    } catch {
      if (version !== requestVersion.current) return;
      setCopied(false);
      setError(t("复制失败，请检查浏览器剪贴板权限，或手动选择并复制报告内容。", "Copying failed. Check clipboard permissions, or select and copy the report manually."));
    }
  };

  const failureGuidance = errorSource === "link" && linkFailure ? jdFailureGuidance(linkFailure) : null;
  const englishFailureGuidance: Partial<Record<JdFailure["code"], [string, string]>> = {
    network: linkFailure?.stage === "page" ? ["Job text reading interrupted", "The website responded, but its text did not finish transferring. Check the network route and retry; incomplete text is not used."] : ["Not connected to the job website", "No page response was received. Login or verification requirements are unknown. Check the proxy route; system TUN or global networking can still affect direct connections."],
    timeout: ["Job reading timed out", "The current route did not finish in time. Check the connection and avoid repeated requests."],
    login_required: ["Website requires login", "Log in yourself in the dedicated job browser, then return to read the original job. Login stays on this computer; the site may request verification again."],
    verification_required: ["Website requires verification", "Open the dedicated browser, complete the original site's verification yourself, then return to read the job. Verification is not automated."],
    access_denied: ["Website denied access", "The site rejected access. This response alone does not establish whether login, verification, region or another restriction caused it. Check the original job."],
    rate_limited: ["Website rate limit", linkFailure?.retryAfterSeconds ? "The site recommends waiting at least " + linkFailure.retryAfterSeconds + " seconds. Try later; no automatic retry is performed." : "Try reading later; no automatic retry is performed."],
    unavailable: ["Job page unavailable", "Check the original job for removal, an expired link or site maintenance. Recommended jobs are not substituted."],
    ambiguous_jobs: ["Target job is unclear", "The page contains multiple jobs. Use the specific job details link instead of a search or recommendation page."],
    job_mismatch: ["Job source mismatch", "The returned text could not be confirmed as this job. Review the original page; another job will not be used automatically."],
    invalid_link: ["Check the job link", "Paste one complete official job link or sharing message."],
    service_unavailable: ["Job reader unavailable", "Check that the local server is running. Static hosting requires a separate job reading service."],
    browser_unavailable: ["Browser reading unavailable", "No usable browser runtime is available, or startup failed. Complete the setup indicated by the service and try browser reading again."],
    browser_setup_required: ["Complete Edge first run setup", "Complete or skip account and sync setup in the dedicated Edge window, then retry reading. You can skip Microsoft sign in; the window is kept and is accessible from the taskbar."],
    browser_required: ["Job text needs a browser", "The page responded, but its description requires scripts to load. Use browser reading, then verify the text and source."],
    browser_session_expired: ["This job page has ended", "Open the job again. Pages are kept for up to 10 minutes; the dedicated browser and site login remain. The original site controls any new login or verification requirement."],
    unsupported_page: ["No confirmed job description found", "The page may load dynamically or use an unsupported structure. Review the original page; connectivity alone does not establish text retrieval."],
  };
  const displayedFailureGuidance = failureGuidance && linkFailure ? {
    ...failureGuidance,
    title: t(failureGuidance.title, englishFailureGuidance[linkFailure.code]?.[0] ?? "Job reading failed"),
    guidance: t(failureGuidance.guidance, englishFailureGuidance[linkFailure.code]?.[1] ?? "Review the original job page before trying again."),
  } : null;

  const sessionStatus = (() => {
    if (acquiring === "session-inspect") return { title: t("岗位页已创建 · 正在检查内容", "Job page created · Inspecting content"), guidance: t("正在检查当前岗位页的显示内容与加载记录，请稍候。", "Checking the current job page and loading records. Please wait.") };
    if (acquiring === "session-read") return { title: t("岗位页已创建 · 正在读取原岗位", "Job page created · Reading original job"), guidance: t("正在核对当前页面是否属于原岗位，并等待可见正文稳定。读取结果将在完成后供你核对。", "Verifying that this is the original job and waiting for visible text to stabilize. Review the result when reading finishes.") };
    const gate = sessionInspection?.snapshotState === "ready" ? sessionInspection.gate : undefined;
    if (gate === "verification_required" || linkFailure?.code === "verification_required") return {
      title: t("岗位页要求访问验证 · 尚未取得正文", "Verification required · No description retrieved"),
      guidance: t("请在专用 Edge 中自行完成原网站的访问验证。若验证区域空白或按钮无响应，先查看下方资源错误并检查网络路线；完成后再检查或读取原岗位，当前岗位页已保留。", "Complete the site's verification yourself in the dedicated Edge. If the verification area is blank or unresponsive, check resource errors and the network route below. The current page is kept for inspection or reading afterward."),
    };
    if (gate === "login_required" || linkFailure?.code === "login_required") return {
      title: t("岗位页要求登录 · 尚未取得正文", "Login required · No description retrieved"),
      guidance: t("请在专用 Edge 中按原网站提示自行登录。看到完整岗位正文后，回到这里点击“完成后读取原岗位”；当前岗位页已保留。", "Follow the site's login instructions in the dedicated Edge. Once the full description is visible, return and choose Read original job when ready. The current page is kept."),
    };
    if (browserSession?.platform === "BOSS直聘" && sessionInspection?.snapshotState === "failed" && isBossDescriptionCollapsed(sessionInspection.snapshotFailure)) return {
      title: t("职位描述仍被折叠 · 尚未取得完整正文", "Description is collapsed · Full text not retrieved"),
      guidance: t("请点击“显示岗位窗口”，在专用 Edge 的职位描述区域点击“查看全部”。确认职责和任职要求全部显示后，再点击“完成后读取原岗位”；当前岗位页已保留。", "Choose Show job window and expand the description on the original site. Once responsibilities and requirements are fully visible, choose Read original job when ready. The page is kept."),
    };
    if (sessionInspection?.snapshotState === "ready") {
      if (sessionInspection.pageState === "blank") return {
        title: t("岗位页当前为空白 · 尚未取得正文", "Job page is blank · No description retrieved"),
        guidance: t("请核对专用 Edge 的当前岗位标签页，并查看下方资源错误。页面恢复后点击“检查当前窗口”；看到完整岗位正文后再读取。当前岗位页已保留，空白页上无需重复登录。", "Check the dedicated Edge tab and resource errors below. Once the page recovers, inspect it and read after the full description appears. The page is kept; a blank page does not require repeated login."),
      };
      if (sessionInspection.pageState === "original_job") return {
        title: t("最近检查已识别原岗位 · 等待读取正文", "Original job identified · Waiting to read"),
        guidance: t("最近一次检查识别到了原岗位页面。请核对专用 Edge 中的标题与职责，再点击“完成后读取原岗位”，取得正文后还可核对并确认使用。", "The latest inspection identified the original job page. Check its title and responsibilities in Edge, then read it. You can review the retrieved text before using it."),
      };
      if (sessionInspection.pageState === "different_job") return {
        title: t("当前页面与原岗位不匹配 · 尚未取得正文", "Page does not match original job · No text retrieved"),
        guidance: t("请在专用 Edge 中核对当前岗位标签页，确认回到本次原岗位链接后，再点击“检查当前窗口”。当前岗位页已保留。", "Check the dedicated Edge tab, return to the original job link, then inspect the window. The current page is kept."),
      };
      if (sessionInspection.pageState === "platform_intermediate") return {
        title: t("岗位页停在平台中转页 · 待确认内容", "Platform redirect page · Content unconfirmed"),
        guidance: t("请核对专用 Edge 中的当前页面，等待平台跳转或按原网站提示操作。看到原岗位正文后再读取；若页面没有变化，可再次检查加载记录。", "Check Edge and wait for the redirect or follow the original site's instructions. Read once the description appears; if the page does not change, inspect its loading records again."),
      };
    }
    if (sessionInspection?.snapshotState === "navigation_in_progress") return { title: t("岗位页正在跳转 · 待确认内容", "Job page is navigating · Content unconfirmed"), guidance: t("请等待专用 Edge 中的页面跳转结束，再点击“检查当前窗口”。当前岗位页已保留。", "Wait for navigation to finish in Edge, then inspect the window. The current page is kept.") };
    if (sessionInspection && sessionInspection.snapshotState !== "ready") return { title: t("岗位页内容尚未确认 · 请核对当前窗口", "Content unconfirmed · Check current window"), guidance: t("本次检查未能确认页面内容。请核对专用 Edge 中的当前岗位标签页及下方检查结果，稍后可再次检查；当前岗位页已保留。", "The inspection could not confirm page content. Check the Edge tab and results below, then inspect again later. The page is kept.") };
    if (errorSource === "link" && linkFailure) return { title: t("岗位页已保留 · 尚未取得可确认正文", "Job page kept · No confirmed text retrieved"), guidance: t("请点击“检查当前窗口”查看当前页面和资源错误，再根据检查结果处理。看到完整原岗位正文后再读取。", "Inspect the current window for page and resource errors, then act on those results. Read after the full original description appears.") };
    return {
      title: t("岗位页已创建 · 待确认内容", "Job page created · Content unconfirmed"),
      guidance: t("尚未确认当前页面是否显示原岗位正文。请先核对专用 Edge 中的岗位标签页；若显示登录或访问验证，按原网站提示自行完成。看到完整正文后，点击“完成后读取原岗位”。", "The original job description is not yet confirmed. Check the Edge job tab and complete any site login or verification yourself. Once the full text appears, choose Read original job when ready."),
    };
  })();
  const handleManualInput = (nextTab: "text" | "screenshot") => {
    invalidateAcquisition();
    setTab(nextTab);
    if (nextTab === "text") document.getElementById("jd-text")?.focus();
  };

  return (
    <div className="no-print fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-3 sm:p-5">
      <div role="dialog" aria-modal="true" aria-labelledby="jd-modal-title" onPaste={(event) => {
        if (tab !== "screenshot") return;
        const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
        if (files.length) { event.preventDefault(); void addScreenshots(files); }
      }} className="flex h-full max-h-[92vh] w-full max-w-5xl flex-col rounded-2xl bg-[#fbfaf7] shadow-2xl border border-slate-200 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--color-accent)] text-white shadow-xs">
              <Target className="h-4 w-4" />
            </div>
            <div>
              <h2 id="jd-modal-title" className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <span>{t("目标岗位 · 采集与匹配", "Target job · Capture & match")}</span>
                <span className="rounded bg-slate-200/70 px-2 py-0.5 text-[10px] font-medium text-slate-700">
                  {readiness.ready ? t("依据当前简历内容", "Based on the current resume") : t("先准备自己的简历", "Prepare your own resume first")}
                </span>
              </h2>
              <p className="text-xs text-slate-500">
                {t("采集岗位正文 · 核对简历依据 · AI 匹配参考与表达建议", "Capture job descriptions · Review resume evidence · AI match reference and wording suggestions")}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenConfig}
              disabled={closingBrowser}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-2xs hover:bg-slate-50 transition disabled:opacity-45"
              title={t("配置 AI 模型", "Configure AI model")}
            >
              <Settings2 className="h-3.5 w-3.5 text-slate-500" />
              <span>{llmConfig.model}</span>
            </button>
            <button
              type="button"
              onClick={() => { invalidateAcquisition(); onClose(); }}
              disabled={closingBrowser}
              aria-label={t("关闭岗位匹配", "Close job matching")}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition disabled:opacity-45"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-5">
          {!readiness.ready && <section role="status" aria-label={t("简历分析准备状态", "Resume analysis readiness")} className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-2.5">
            <h3 className="text-sm font-semibold text-amber-950">{readiness.reason === "demo" || readiness.reason === "mixed-demo" ? t("先把示例简历换成自己的经历", "Replace the sample resume with your experience") : t("先补充可分析的简历内容", "Add resume content for analysis")}</h3>
            <p className="text-xs leading-relaxed text-amber-900">{readinessMessage}</p>
            <p className="text-xs leading-relaxed text-amber-800">{t("可以先采集、核对和收藏岗位。准备好自己的简历后，再比较岗位要求。", "You can capture, review and save jobs first. Compare requirements after preparing your own resume.")}</p>
            <div className="flex flex-wrap gap-2">
              {onImportResume && <button type="button" disabled={!!acquiring} onClick={onImportResume} className="studio-button primary disabled:opacity-45"><Upload className="h-3.5 w-3.5" />{t("导入我的简历", "Import my resume")}</button>}
              {onEditResume && <button type="button" disabled={!!acquiring} onClick={onEditResume} className="studio-button disabled:opacity-45"><FileText className="h-3.5 w-3.5" />{t("填写真实经历", "Enter actual experience")}</button>}
            </div>
          </section>}
          {cleanupStatus.pending > 0 && <section role="status" aria-label={t("岗位页清理状态", "Job page cleanup status")} className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-2">
            <p className="text-xs font-semibold text-amber-900">{t("先前岗位页尚未确认结束", "Previous job pages are not confirmed closed")}</p>
            <p className="text-xs leading-relaxed text-amber-800">{t("取消或切换前的岗位页还未确认清理。可以重试结束这些页面；已提取的正文会保留。若仍无法确认，请检查专用招聘窗口后重试。", "Cleanup of earlier canceled or switched pages is unconfirmed. Retry closing them; extracted text is kept. If closure remains unconfirmed, check the dedicated job browser and retry.")}</p>
            <button type="button" disabled={cleanupStatus.retrying} onClick={() => void jdBrowserCleanupTracker.retry()} className="text-xs font-semibold text-amber-900 underline disabled:opacity-45">{cleanupStatus.retrying ? t("正在重试清理…", "Retrying cleanup…") : t("重试清理先前岗位页", "Retry closing previous job pages")}</button>
          </section>}
          {/* JD Input Area */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 space-y-4 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">{t("把目标岗位带进来", "Bring in a target job")}</h3>
                <p className="mt-1 text-xs text-slate-500">{t("文字、分享链接或截图，提取后核对正文再分析。", "Use text, a shared link or screenshots. Review extracted text before analysis.")}</p>
              </div>
              <div role="tablist" aria-label={t("岗位采集方式", "Job capture method")} className="flex rounded-xl bg-[#f1f2ee] p-1">
                {([{ id: "text", label: t("粘贴文字", "Paste text"), icon: FileText }, { id: "link", label: t("分享链接", "Shared link"), icon: Link2 }, { id: "screenshot", label: t("截图识别", "Screenshot OCR"), icon: ImagePlus }] as const).map(({ id, label, icon: Icon }) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} aria-controls={`jd-${id}-panel`} disabled={closingBrowser} onClick={() => { invalidateAcquisition(); setTab(id); setError(null); }} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition disabled:opacity-45 ${tab === id ? "bg-white text-[#244e43] shadow-sm" : "text-slate-500 hover:text-slate-800"}`}><Icon className="h-3.5 w-3.5" />{label}</button>
                ))}
              </div>
            </div>

            {tab === "link" && <div id="jd-link-panel" role="tabpanel" className="rounded-xl border border-[#dce5dd] bg-[#f4f7f2] p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#244e43]"><Link2 className="h-4 w-4" />{t("LinkedIn · 猎聘 · 51JOB · BOSS直聘", "LinkedIn · Liepin · 51JOB · BOSS Zhipin")}</div>
              <label htmlFor="jd-share" className="block text-xs text-slate-600">{t("粘贴岗位链接或完整分享消息", "Paste a job URL or the full shared message")}</label>
              <textarea id="jd-share" value={shareInput} disabled={closingBrowser} onChange={(event) => { invalidateAcquisition(); setShareInput(event.target.value); setDraftEdited(true); setError(null); }} rows={3} placeholder={t("例如：我发现了这个职位，https://www.zhipin.com/job_detail/...", "For example: I found this role, https://www.zhipin.com/job_detail/...")} className="w-full rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed outline-none focus:border-[#244e43] disabled:opacity-45" />
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => void handleExtractLink()} disabled={!shareInput.trim() || !!acquiring || !!browserSession} className="inline-flex items-center gap-2 rounded-lg bg-[#244e43] px-4 py-2 text-xs font-semibold text-white hover:bg-[#193c32] disabled:opacity-45">{acquiring === "link" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}{acquiring === "link" ? t("正在读取公开正文…", "Reading public description…") : t("提取岗位正文", "Extract job description")}</button>
                <button type="button" onClick={() => void handleStartBrowserSession(true)} disabled={!shareInput.trim() || !!acquiring || !!browserSession} className="inline-flex items-center gap-2 rounded-lg border border-[#b9cdbf] bg-white px-4 py-2 text-xs font-semibold text-[#244e43] hover:bg-[#e9f0e8] disabled:opacity-45">{acquiring === "session-start" || acquiring === "session-read" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}{acquiring === "session-start" || acquiring === "session-read" ? t("浏览器正在加载正文…", "Browser is loading the description…") : t("浏览器读取", "Read in browser")}</button>
                <button type="button" onClick={() => void (browserSession ? handleFocusBrowserSession() : handleStartBrowserSession())} disabled={!!acquiring || (!browserSession && !shareInput.trim())} className="inline-flex items-center gap-2 rounded-lg border border-[#b9cdbf] bg-white px-4 py-2 text-xs font-semibold text-[#244e43] hover:bg-[#e9f0e8] disabled:opacity-45">{acquiring === "session-start" || acquiring === "session-focus" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}{acquiring === "session-focus" ? t("正在请求显示岗位页…", "Requesting job page display…") : acquiring === "session-start" ? t("正在打开独立浏览器…", "Opening dedicated browser…") : browserSession ? t("显示岗位窗口", "Show job window") : t("打开独立浏览器", "Open dedicated browser")}</button>
                {(["link", "browser", "session-start", "session-read", "session-inspect"] as const).some((state) => acquiring === state) && <button type="button" onClick={() => invalidateAcquisition()} className="text-xs font-medium text-slate-600 hover:underline">{acquiring === "session-inspect" ? t("取消检查并结束会话", "Cancel inspection and end session") : t("取消读取", "Cancel reading")}</button>}
                {originalLink && <a href={originalLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-[#244e43] hover:underline"><ExternalLink className="h-3.5 w-3.5" />{t("打开原岗位", "Open original job")}</a>}
                <button type="button" onClick={onOpenNetworkSettings} disabled={closingBrowser} className="inline-flex items-center gap-1 text-xs font-medium text-[#244e43] hover:underline disabled:opacity-45"><Settings2 className="h-3.5 w-3.5" />{t("网络与代理设置", "Network & proxy settings")}</button>
                <button type="button" onClick={() => handleManualInput("screenshot")} disabled={closingBrowser} className="text-xs text-slate-600 hover:underline disabled:opacity-45">{t("无法复制？用截图识别", "Cannot copy? Use screenshot OCR")}</button>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">{t("读取公开页面；登录、验证码或仅 App 可见的岗位可能无法提取。可在原页面截图后识别，保留来源链接。", "Reads public pages. Login, verification or app only jobs may prevent extraction. Use screenshots of the original page while keeping its source link.")}</p>
              <p className="text-[11px] leading-relaxed text-slate-500">{t("浏览器读取会打开专用 Edge 并加载原岗位；遇到登录或访问验证时保留当前岗位页。请在该窗口自行操作，再回来点击“完成后读取原岗位”，取得正文后请核对再使用。", "Browser reading opens a dedicated Edge at the original job. The page stays open for login or verification. Complete those steps yourself, return and read the job, then review its text before use.")}</p>
              <p className="text-[11px] leading-relaxed text-slate-500">{t("各平台的专用浏览器在本机保留本站登录。每次新开岗位页，结束读取只关闭该页；再次读取沿用同一专用浏览器。本软件不会自动处理验证码。", "Each platform's browser keeps its login locally. Reading opens a job tab and closes only that tab afterward. Later reads reuse the browser. Verification is not automated.")}</p>
              <button type="button" onClick={() => void handleStopPersistentBrowser()} disabled={!!acquiring} className="text-xs font-medium text-slate-600 hover:underline disabled:opacity-45">{acquiring === "browser-stop" ? t("正在关闭招聘浏览器…", "Closing job browser…") : t("关闭招聘浏览器", "Close job browser")}</button>
              {browserSession && <section aria-label={t("独立浏览器会话", "Dedicated browser session")} className="rounded-lg border border-slate-200 bg-white p-3 space-y-2.5">
                <div role="status" className="rounded-md bg-slate-50 p-2.5 space-y-1.5">
                  <p className="text-xs font-semibold text-slate-800">{sessionStatus.title}</p>
                  <p className="text-[11px] text-slate-500">{browserSession.platform} {t("· 本次原岗位页", "· Current original job page")}</p>
                  <p className="text-xs leading-relaxed text-slate-600">{sessionStatus.guidance}</p>
                </div>
                <p className="text-[11px] leading-relaxed text-slate-500">{t("读取和检查都保留当前页面，不会自动刷新或返回原链接。请先在专用 Edge 中自行完成登录或验证，并回到原岗位正文，再点击读取。", "Reading and inspection keep the page without refreshing or navigating. Complete login or verification in Edge and return to the original description before reading.")}</p>
                <p className="text-[11px] leading-relaxed text-slate-500">{t("没有看到 Edge 窗口时，先点击“显示岗位窗口”。若任务栏也没有该窗口，请先“关闭招聘浏览器”再重新打开；当前状态只说明岗位页已创建，尚未确认窗口可见。", "If Edge is not visible, choose Show job window. If it is missing from the taskbar too, close the job browser and reopen it. Page creation alone does not confirm window visibility.")}</p>
                <p className="text-[11px] leading-relaxed text-slate-500">{t("页面空白、持续加载或按钮无响应时，可点击“检查当前窗口”查看加载状态与资源错误；检查不会刷新或跳转页面，也不会修改用于匹配的岗位正文。", "For blank, loading or unresponsive pages, inspect the window for loading status and resource errors. Inspection does not refresh, navigate or change the JD used for matching.")}</p>
                <p className="text-[11px] leading-relaxed text-slate-500">{t("当前岗位页保留到", "Current job page kept until")} {new Date(browserSession.expiresAt).toLocaleTimeString(locale === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit" })}{t("，届时会尝试关闭。登录或验证需要更多时间时，请在到期前点击“再保留 10 分钟”，继续使用当前页面。关闭本面板、修改链接、切换采集方式或取消读取也会结束并尝试关闭本次岗位页；专用浏览器及本站登录保留。", "; closure will then be attempted. Extend before expiry if needed. Closing this panel, changing links or capture methods, or canceling reading ends this page. The browser and login are kept.")}</p>
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" onClick={() => void handleReadBrowserSession()} disabled={!!acquiring} className="inline-flex items-center gap-2 rounded-lg bg-[#244e43] px-4 py-2 text-xs font-semibold text-white hover:bg-[#193c32] disabled:opacity-45">{acquiring === "session-read" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}{acquiring === "session-read" ? t("正在读取原岗位…", "Reading original job…") : t("完成后读取原岗位", "Read original job when ready")}</button>
                  <button type="button" onClick={() => void handleInspectBrowserSession()} disabled={!!acquiring} className="inline-flex items-center gap-2 rounded-lg border border-[#b9cdbf] bg-white px-4 py-2 text-xs font-semibold text-[#244e43] hover:bg-[#e9f0e8] disabled:opacity-45">{acquiring === "session-inspect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}{acquiring === "session-inspect" ? t("正在检查当前窗口…", "Inspecting current window…") : t("检查当前窗口", "Inspect current window")}</button>
                  <button type="button" onClick={() => void handleExtendBrowserSession()} disabled={!!acquiring} className="inline-flex items-center gap-2 rounded-lg border border-[#b9cdbf] bg-white px-4 py-2 text-xs font-semibold text-[#244e43] hover:bg-[#e9f0e8] disabled:opacity-45">{acquiring === "session-extend" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock3 className="h-3.5 w-3.5" />}{acquiring === "session-extend" ? t("正在保留当前岗位页…", "Extending current job page…") : t("再保留 10 分钟", "Keep for 10 more minutes")}</button>
                  <button type="button" onClick={() => void handleEndBrowserSession()} className="text-xs font-medium text-slate-600 hover:underline">{t("关闭本次岗位页", "Close this job page")}</button>
                </div>
                {sessionInspection && <div role="status" aria-label={t("当前窗口检查结果", "Current window inspection results")} className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2 text-xs leading-relaxed text-slate-600">
                  {sessionInspection.mainDocumentRequests !== undefined && <p>{t("本次岗位页已发生", "This job page has made")} {sessionInspection.mainDocumentRequests === 1000 ? t("至少 1000", "at least 1000") : sessionInspection.mainDocumentRequests} {t("次主页面网络请求（包含跳转）。", "main document requests (including redirects).")}</p>}
                  <p>{sessionInspection.mainDocument.state === "response" ? t(`最近一次主文档网络请求收到 HTTP ${sessionInspection.mainDocument.status} 响应；当前显示内容请结合下方页面检查结果核对。`, `The latest main document request received HTTP ${sessionInspection.mainDocument.status}. Review the displayed content using the inspection results below.`) : { pending: t("主文档网络请求尚未收到响应。", "The main document request has not received a response."), failed: t("最近一次主文档网络请求失败，请结合下方资源错误检查网络。", "The latest main document request failed. Review the resource errors below and check the connection."), unknown: t("暂未记录到主文档网络请求结果。", "No main document request result has been recorded.") }[sessionInspection.mainDocument.state]}</p>
                  {sessionInspection.snapshotState === "ready" ? <>
                    <p>{t("当前页面检查已完成。", "Current page inspection completed.")}</p>
                    <p>{{ loading: t("主页面仍在加载。", "The main page is still loading."), interactive: t("主页面文档已就绪，部分资源可能仍在加载。", "The main document is ready; some resources may still be loading."), complete: t("主页面已完成加载；动态内容仍可能继续更新。", "The main page finished loading; dynamic content may continue updating."), unknown: t("暂时无法确认主页面加载阶段。", "The main page loading stage is unconfirmed.") }[sessionInspection.pageLoad.readyState]}</p>
                    <p>{{ empty: t("主页面暂未检测到可见文字或可见内嵌页面；图片或画布仍可能有内容。", "No visible text or embedded frame was detected; images or canvases may still contain content."), visible_text: t("主页面检测到可见文字，尚需核对是否为原岗位正文。", "Visible text was detected; confirm that it is the original job description."), embedded_content: t("主页面没有可见文字，但有可见内嵌页面；本次未检查其中内容。", "No visible main page text, but an embedded frame is visible. Its content was not inspected."), unknown: t("本次无法确认页面是否显示内容。", "Could not confirm whether the page displays content.") }[sessionInspection.pageLoad.content]}{sessionInspection.pageLoad.visibleFrames > 0 && t(` 可见内嵌页面：${sessionInspection.pageLoad.visibleFrames} 个。`, ` Visible embedded frames: ${sessionInspection.pageLoad.visibleFrames}.`)}</p>
                    <p>{{ original_job: t("当前窗口已识别为原岗位页面。", "This window was identified as the original job page."), platform_intermediate: t("当前窗口位于该平台的中转、登录或验证页面。", "This window is on the platform's redirect, login or verification page."), different_job: t("当前窗口与原岗位不匹配，请核对独立 Edge 中打开的页面。", "This window does not match the original job. Check the page open in the dedicated Edge."), blank: t("当前窗口停在浏览器空白页，尚未取得原岗位内容。", "This window is on a blank browser page; no original job content was retrieved."), unknown: t("暂时无法确认当前窗口是否为原岗位。", "Could not confirm whether this window is the original job.") }[sessionInspection.pageState]}</p>
                    <p>{sessionInspection.gate === "login_required" ? t("当前页面仍要求登录，请在独立 Edge 中自行完成。", "Login is still required. Complete it yourself in the dedicated Edge.") : sessionInspection.gate === "verification_required" ? t("当前页面仍要求访问验证，请在独立 Edge 中自行完成。", "Verification is still required. Complete it yourself in the dedicated Edge.") : t("当前未识别到登录或验证提示。", "No login or verification prompt was detected.")}</p>
                  </> : <p>{{ navigation_in_progress: t("页面仍在跳转，请稍后再次检查；本次无法判断登录或访问验证状态。", "The page is navigating. Inspect again later; login and verification status are unconfirmed."), failed: t("本次未能检查当前页面，无法判断登录或访问验证状态，请稍后再次检查。", "The page could not be inspected. Login and verification status are unconfirmed; try again later."), oversized: t("当前页面过大，无法检查页面状态，也无法判断登录或访问验证状态。", "This page is too large to inspect; page, login and verification states are unconfirmed.") }[sessionInspection.snapshotState]}</p>}
                  {sessionInspection.snapshotFailure && <p>{snapshotFailureMessage(sessionInspection.snapshotFailure)}</p>}
                  <p>{sessionInspection.scriptErrorsCollected === false ? t("当前读取方式未采集脚本错误，无法判断页面是否发生脚本异常。", "This reading method does not collect script errors, so script failure status is unknown.") : sessionInspection.scriptErrors > 0 ? t(`本次会话已记录 ${sessionInspection.scriptErrors} 次未处理的脚本错误，尚不能据此确定页面故障原因。`, `${sessionInspection.scriptErrors} unhandled script errors recorded in this session; they do not establish the cause of a page failure.`) : t("本次会话暂未记录到未处理的脚本错误。", "No unhandled script errors have been recorded in this session.")}</p>
                  {sessionInspection.blockedPopups > 0 && <p>{t("本工具已阻止", "This tool blocked")} {sessionInspection.blockedPopups} {t("个新窗口。", "new windows.")}</p>}
                  {sessionInspection.blockedSockets > 0 && <p>{t("本工具已阻止", "This tool blocked")} {sessionInspection.blockedSockets} {t("个实时连接。", "realtime connections.")}</p>}
                  {sessionInspection.resources.length > 0 ? <ul className="space-y-1">
                    {sessionInspection.resources.map((resource, index) => <li key={`${resource.host}-${resource.type}-${resource.outcome}-${index}`} className="break-words">{{ blocked_by_tool: t("被本工具限制", "Restricted by this tool"), load_failed: t("加载失败或已取消", "Loading failed or canceled"), http_error: t("HTTP错误", "HTTP error") }[resource.outcome]} · {resource.host} · {resource.type} · {{ main: t("主页面", "Main page"), child: t("内嵌页面", "Embedded page"), unknown: t("所属页面未知", "Unknown owning page") }[resource.frame]} · {{ unknown: t("失败原因未知", "Unknown failure reason"), blocked_by_tool: t("资源范围限制", "Resource scope restriction"), cancelled: t("请求已取消", "Request canceled"), dns: t("域名解析失败", "DNS lookup failed"), proxy: t("代理连接失败", "Proxy connection failed"), connection: t("连接中断或失败", "Connection interrupted or failed"), tls: t("TLS连接失败", "TLS connection failed"), timeout: t("请求超时", "Request timed out"), http: `HTTP ${resource.httpStatus}`, other: t("其他加载失败", "Other loading failure") }[resource.detail]}</li>)}
                  </ul> : <p>{t("暂未记录到页面、脚本、样式、图片、字体或接口的资源错误。", "No page, script, style, image, font or API resource errors have been recorded.")}</p>}
                  {sessionInspection.truncated && <p>{t("资源错误最多显示 30 项，以上列表未包含全部记录。", "Up to 30 resource errors are shown; this list does not include all records.")}</p>}
                  {sessionInspection.verificationNetwork && <details className="mt-2">
                    <summary className="cursor-pointer">{t("验证请求记录（", "Verification request records (")}{sessionInspection.verificationNetwork.requests.length} {t("项）", "items)")}</summary>
                    <p>{t("用于核对验证服务的请求是否返回和完成。HTTP 成功仍需结合原站页面判断验证结果。", "Check whether verification service requests responded and completed. HTTP success still requires checking the original page's verification result.")}</p>
                    {sessionInspection.verificationNetwork.requests.length === 0 ? <p>{t("本次岗位页暂未观察到所支持验证服务的请求。", "No supported verification service requests have been observed on this job page.")}</p> : <ol className="space-y-2">
                      {sessionInspection.verificationNetwork.requests.map(request => <li key={request.id} className="break-words">
                        <div>#{request.id} · {request.host} · {request.type}</div>
                        <div>{sessionInspection.verificationNetwork?.events.filter(event => event.requestId === request.id).map(event => `${({ request: t("请求开始", "Request started"), response: t("收到响应", "Response received"), finished: t("传输完成", "Transfer completed"), failed: t("加载失败或取消", "Loading failed or canceled") })[event.phase]} +${event.atMs}ms${event.status !== undefined ? ` / HTTP ${event.status}` : ""}`).join(" → ")}</div>
                      </li>)}
                    </ol>}
                    {sessionInspection.verificationNetwork.truncated && <p>{t("记录已达到上限，后续请求可能未包含在内。", "The record limit was reached; later requests may be missing.")}</p>}
                  </details>}
                  <p className="text-[11px] text-slate-500">{t("以上是本次会话的加载记录，尚不能确定按钮无响应的原因。看到原岗位正文后，请点击“完成后读取原岗位”。", "These loading records do not establish why a button is unresponsive. Once the original description is visible, choose Read original job when ready.")}</p>
                </div>}
              </section>}
              {sessionNotice && <p role="status" className="text-xs leading-relaxed text-slate-600">{sessionNotice}</p>}
            </div>}

            {tab === "screenshot" && <div id="jd-screenshot-panel" role="tabpanel" className="rounded-xl border border-slate-200 bg-[#faf9f5] p-4 space-y-3">
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(event) => { void addScreenshots(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
              <button type="button" onClick={() => fileInput.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void addScreenshots(Array.from(event.dataTransfer.files)); }} className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-[#b9cbbf] bg-white px-4 py-6 text-center hover:bg-[#f4f7f2] transition">
                <Upload className="h-6 w-6 text-[#244e43]" />
                <span className="text-xs font-semibold text-slate-800">{t("选择或拖入岗位截图，也可以 Ctrl + V 粘贴", "Select or drop job screenshots, or paste with Ctrl + V")}</span>
                <span className="text-[11px] text-slate-500">{t("PNG / JPEG / WebP · 最多 6 张 · 每张 10 MB · 按上传顺序识别", "PNG / JPEG / WebP · Up to 6 images · 10 MB each · Read in upload order")}</span>
              </button>
              {screenshots.length > 0 && <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {screenshots.map((shot, index) => <div key={shot.id} className="relative overflow-hidden rounded-lg border border-slate-200 bg-white">{shot.dataUrl ? <img src={shot.dataUrl} alt={t(`岗位截图 ${index + 1}`, `Job screenshot ${index + 1}`)} className="h-28 w-full object-contain bg-slate-50" /> : <div role="status" className="flex h-28 flex-col items-center justify-center gap-2 bg-slate-50 text-[11px] text-slate-500"><Loader2 className="h-5 w-5 animate-spin text-[#244e43]" /><span>{t("正在读取截图…", "Reading screenshots…")}</span></div>}<div className="truncate px-2 py-2 text-[11px] text-slate-600">{index + 1}. {shot.name}</div><button type="button" aria-label={t(`移除截图 ${index + 1}`, `Remove screenshot ${index + 1}`)} onClick={() => { invalidateAcquisition(false); screenshotsRef.current = screenshotsRef.current.filter((image) => image.id !== shot.id); setScreenshots(screenshotsRef.current); setAcquiring(screenshotsRef.current.some((image) => !image.dataUrl) ? "images" : null); }} className="absolute top-1 right-1 rounded-md bg-white/90 p-1 text-slate-500 hover:text-rose-700"><X className="h-3.5 w-3.5" /></button></div>)}
              </div>}
              <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={!screenshots.length || !!acquiring || screenshots.some((image) => !image.dataUrl)} onClick={() => void handleRecognize()} className="inline-flex items-center gap-2 rounded-lg bg-[#244e43] px-4 py-2 text-xs font-semibold text-white hover:bg-[#193c32] disabled:opacity-45">{acquiring === "ocr" || acquiring === "images" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}{acquiring === "ocr" ? t("正在识别截图…", "Recognizing screenshots…") : acquiring === "images" ? t("正在读取图片…", "Reading images…") : t("识别截图文字", "Recognize screenshot text")}</button><span className="text-[11px] text-slate-500">{t("当前模型：", "Current model:")}{llmConfig.model}{t("，需支持图片输入", "; image input support required")}</span></div>
              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t("点击识别后才将截图发送给你配置的模型服务。截图仅保留在本次页面中；确认后的文字与来源自动保存。", "Screenshots are sent to your configured provider only after recognition starts. Images stay in this page session; confirmed text and sources are saved automatically.")}</p>
            </div>}

            {pending && <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2"><h4 className="text-xs font-semibold text-amber-900">{t("提取完成，请核对后使用", "Extraction complete; review before use")}</h4><span className="text-[11px] text-amber-700">{pending.method}</span></div>
              <SourcePublicationBadges sourceLabel={pending.provenance.platform ?? t("岗位来源", "Job source")} sourceUrl={pending.provenance.url} publishedAt={pending.provenance.sourcePublishedAt} publishedRaw={pending.provenance.sourcePublishedText} link />
              <label htmlFor="jd-extracted" className="sr-only">{t("核对提取的岗位文字", "Review extracted job text")}</label><textarea id="jd-extracted" rows={7} value={pending.text} onChange={(event) => setPending({ ...pending, text: event.target.value, provenance: { ...pending.provenance, edited: true } })} className="w-full rounded-lg border border-amber-200 bg-white p-3 text-xs leading-relaxed outline-none focus:border-[#244e43]" />
              <div className="flex items-center gap-3"><button type="button" disabled={!pending.text.trim()} onClick={() => { requestVersion.current += 1; setJdText(pending.text); setDraftEdited(true); setProvenance(pending.provenance); setPending(null); setTab("text"); }} className="inline-flex items-center gap-1.5 rounded-lg bg-[#244e43] px-4 py-2 text-xs font-semibold text-white disabled:opacity-45"><Check className="h-3.5 w-3.5" />{t("确认并使用正文", "Confirm and use text")}</button><button type="button" onClick={() => setPending(null)} className="text-xs text-slate-500 hover:underline">{t("放弃本次提取", "Discard extraction")}</button></div>
            </div>}

            <div id="jd-text-panel" role={tab === "text" ? "tabpanel" : undefined} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><label htmlFor="jd-text" className="flex items-center gap-1.5 text-xs font-semibold text-slate-800"><FileText className="h-3.5 w-3.5 text-slate-500" />{t("用于匹配的岗位正文", "Job description used for matching")}</label><button type="button" disabled={closingBrowser} onClick={() => { requestVersion.current += 1; invalidateAcquisition(); setJdText(SAMPLE_JD); setDraftEdited(true); setProvenance({ kind: "text", title: t("工业软件工程师范例（演示）", "Industrial software engineer example (demo)"), observedAt: new Date().toISOString() }); setTab("text"); }} className="text-[11px] text-[#244e43] hover:underline disabled:opacity-45">{t("填入演示 JD", "Insert demo JD")}</button></div>
              <textarea id="jd-text" value={jdText} disabled={closingBrowser} onChange={(event) => changeJdText(event.target.value)} rows={tab === "text" ? 9 : 5} placeholder={t("粘贴岗位职责与任职要求，或通过上方链接/截图提取。你可以在这里继续修改和核对原文。", "Paste responsibilities and requirements, or extract them from a link or screenshot above. Edit and review the original text here.")} className="w-full resize-y rounded-lg border border-slate-200 bg-[#fdfdfb] p-3 text-xs leading-relaxed outline-none focus:border-[#244e43] disabled:opacity-45" />
              {isJdLinkOnly(jdText) && <p role="status" className="text-xs text-amber-800">{t("这里目前只有链接，还没有岗位正文。请在“分享链接”中读取并确认正文，再开始匹配或收藏。", "Only a link is present. Read and confirm its description under Shared link before matching or saving.")}</p>}
              {initialSource && <p className="text-xs text-slate-500">{initialSource.title} · {initialSource.platform}{initialSource.url && <> · <a href={initialSource.url} target="_blank" rel="noreferrer" className="text-[#244e43] underline">{t("原始岗位", "Original job")}</a></>}</p>}
              {initialSource && <SourcePublicationBadges sourceLabel={initialSource.platform} sourceUrl={initialSource.url} publishedAt={initialSource.sourcePublishedAt} publishedRaw={initialSource.sourcePublishedText} link />}
              {provenance && jdText.trim() && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500"><span>{provenance.platform ?? (provenance.kind === "screenshot" ? t("截图识别", "Screenshot OCR") : t("文字输入", "Text input"))}{provenance.edited ? t(" · 已编辑", " · Edited") : ""}</span><span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />{t("采集于", "Captured")} {new Date(provenance.observedAt).toLocaleString(locale === "en" ? "en-US" : "zh-CN", { timeZone: "Asia/Shanghai" })}{t("（北京时间）", "(Beijing time)")}</span>{provenance.url && <a href={provenance.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#244e43] hover:underline"><ExternalLink className="h-3 w-3" />{t("原岗位链接", "Original job link")}</a>}{provenance.title && <span>{provenance.title}</span>}</div>}
              {provenance && jdText.trim() && <SourcePublicationBadges sourceLabel={provenance.platform ?? (provenance.kind === "screenshot" ? t("截图识别", "Screenshot OCR") : t("文字输入", "Text input"))} sourceUrl={provenance.url} publishedAt={provenance.sourcePublishedAt} publishedRaw={provenance.sourcePublishedText} link />}
              <p className={`text-[11px] ${draftStatus.includes("未保存") || draftStatus.includes("失败") || /not saved|failed/i.test(draftStatus) ? "text-rose-700" : "text-slate-400"}`}>{draftStatus}</p>
              {initialDraft.recoveryRaw !== undefined && <button type="button" onClick={() => {
                const url = URL.createObjectURL(new Blob([initialDraft.recoveryRaw!], { type: "application/json;charset=utf-8" }));
                const link = document.createElement("a"); link.href = url; link.download = "betterme-jd-recovery.json"; link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }} className="text-[11px] text-amber-800 underline">{t("下载原始 JD 草稿以便恢复", "Download the original JD draft for recovery")}</button>}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <span className="text-[11px] text-slate-400">
                {t("当前简历投影条数：", "Current resume projection:")}{resume.experiences.length} {t("段经历，语言：", "experiences, language:")}
                {resume.locale}
              </span>
              {onSaveOpportunity && <button type="button" disabled={!jdText.trim() || isJdLinkOnly(jdText) || !!pending || !!acquiring} onClick={() => onSaveOpportunity({ text: jdText, provenance })} className="studio-button"><Check className="h-3.5 w-3.5" />{t("收藏到机会库", "Save to opportunity library")}</button>}
              <button
                type="button"
                onClick={() => void handleStartAnalysis()}
                disabled={!readiness.ready || loading || !!acquiring || !!pending || !jdText.trim() || isJdLinkOnly(jdText)}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-[var(--color-accent-hover)] transition disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>{t("AI 深度诊断中...", "AI analysis in progress...")}</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>{t("开始智能匹配与诊断", "Start AI match analysis")}</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Error Notice */}
          {error && (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800 flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
                <div>
                  <p className="font-bold">{displayedFailureGuidance?.title ?? t("操作失败", "Operation failed")}</p>
                  <p className="mt-0.5 leading-relaxed text-rose-700">{error}</p>
                  {failureGuidance && <p className="mt-2 leading-relaxed text-rose-700">{browserSession && (linkFailure?.code === "login_required" || linkFailure?.code === "verification_required") ? t("当前岗位页和专用浏览器仍保留。请在已打开的 Edge 中自行完成原网站的登录或访问验证，再点击“完成后读取原岗位”。本软件不会自动处理验证码。", "The job page and browser are kept. Complete the site's login or verification yourself in Edge, then read the original job. Verification is not automated.") : displayedFailureGuidance?.guidance}</p>}
                  {errorSource === "link" && linkFailure?.status !== undefined && <p className="mt-1 text-[11px] text-rose-600">{linkFailure.stage === "service" ? t("读取服务响应", "Reader service response") : t("网站响应", "Website response")}：HTTP {linkFailure.status}</p>}
                </div>
              </div>
              {errorSource === "link" ? <div className="flex flex-wrap items-center gap-2">
                {failureGuidance?.network && <button type="button" onClick={onOpenNetworkSettings} className="rounded-lg bg-rose-700 px-3 py-1.5 font-semibold text-white hover:bg-rose-800">{t("网络与代理设置", "Network & proxy settings")}</button>}
                {originalLink && <a href={originalLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-3 py-1.5 font-medium text-rose-800 hover:bg-rose-100"><ExternalLink className="h-3.5 w-3.5" />{t("打开原岗位", "Open original job")}</a>}
                <button type="button" onClick={() => handleManualInput("text")} className="rounded-lg border border-rose-200 bg-white px-3 py-1.5 font-medium text-rose-800 hover:bg-rose-100">{t("粘贴岗位正文", "Paste job description")}</button>
                <button type="button" onClick={() => handleManualInput("screenshot")} className="rounded-lg border border-rose-200 bg-white px-3 py-1.5 font-medium text-rose-800 hover:bg-rose-100">{t("用截图识别", "Use screenshot OCR")}</button>
              </div> : <button
                type="button"
                onClick={onOpenConfig}
                className="shrink-0 rounded-lg bg-rose-700 hover:bg-rose-800 text-white px-3 py-1.5 text-xs font-semibold shadow-xs transition"
              >
                {t("配置与重新选择模型", "Configure or change model")}
              </button>}
            </div>
          )}

          {/* Report Results */}
          {report && readiness.ready && (
            <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-200">
              {/* Score & Summary Banner */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-emerald-200/90 bg-emerald-50/70 p-5 shadow-xs">
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-white font-bold text-xl shadow-xs">
                    {report.matchScore}
                    <span className="text-xs font-normal ml-0.5">/100</span>
                  </div>
                  <div>
                    <h3 className="font-bold text-sm text-emerald-950">
                      {t("AI 文本参考评分", "AI text reference score")}
                    </h3>
                    <p className="mt-1 text-xs text-emerald-800 leading-relaxed max-w-xl">
                      {report.scoreSummary}
                    </p>
                    <p className="mt-1.5 text-[11px] text-slate-600 leading-relaxed max-w-xl">{t("仅比较当前选择的简历内容与岗位文本，不是能力认证或录用概率。所有 AI 结论均待核对；简历未提及不等于本人不会。", "Compares only the selected resume content and job text; this is not a capability assessment or hiring probability. Verify all AI conclusions. Missing resume details do not imply missing skills.")}</p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleCopyReport()}
                  className="flex items-center gap-1 rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-900 shadow-2xs hover:bg-emerald-50 transition"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                      <span>{t("已复制报告", "Report copied")}</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>{t("复制诊断结果", "Copy analysis report")}</span>
                    </>
                  )}
                </button>
              </div>

              {/* Two Column Grid: Strengths vs Gaps */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Strengths */}
                <div className="rounded-xl border border-emerald-200/80 bg-white p-4 shadow-2xs space-y-2.5">
                  <h4 className="font-bold text-xs text-emerald-900 flex items-center gap-1.5 uppercase tracking-wide">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    {t("模型提出的契合点（待核对）", "AI suggested matches (review required)")}
                  </h4>
                  <ul className="space-y-1.5 text-xs text-slate-700">
                    {report.matchingStrengths.map((str, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="text-emerald-500 font-bold shrink-0 mt-0.5">
                          ✓
                        </span>
                        <span>{str}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Missing Gaps */}
                <div className="rounded-xl border border-amber-200/80 bg-white p-4 shadow-2xs space-y-2.5">
                  <h4 className="font-bold text-xs text-amber-900 flex items-center gap-1.5 uppercase tracking-wide">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    {t("待核对的要求与材料依据", "Requirements and evidence to review")}
                  </h4>
                  <p className="text-[11px] text-slate-500">{t("当前材料缺少依据，可能需要补充经历或进一步确认，不代表能力缺失。", "Current materials lack evidence. Add experience or confirm details; this does not establish a lack of ability.")}</p>
                  <ul className="space-y-1.5 text-xs text-slate-700">
                    {report.missingGaps.map((gap, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="text-amber-500 font-bold shrink-0 mt-0.5">
                          !
                        </span>
                        <span>{gap}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Grounded source references do not verify generated rewrites. */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs space-y-3">
                <div>
                  <h4 className="font-bold text-xs text-slate-900 flex items-center gap-1.5 uppercase tracking-wide">
                    <Sparkles className="h-4 w-4 text-[var(--color-accent)]" />
                    {t("表达建议（逐项核实后再使用）", "Wording suggestions (verify each before use)")}
                  </h4>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {t("仅核对了引用原文。AI 仍可能补出原文没有的技能、数字、职责或业务场景，请逐项确认；建议不会自动写入简历。", "Only the quoted source was checked. AI may still add skills, numbers, duties or scenarios absent from it. Verify each suggestion; none is added to the resume automatically.")}
                  </p>
                </div>
                {report.unverifiedSuggestionCount > 0 && <p role="status" className="rounded-lg bg-amber-50 p-2.5 text-xs text-amber-900">{t("已排除", "Excluded")} {report.unverifiedSuggestionCount} {t("条无法对应当前简历原文的建议。", "suggestions that could not be linked to the current resume text.")}</p>}
                {report.tailoredSuggestions.length === 0 && <p className="text-xs text-slate-500">{t("本次没有可定位原文的表达建议。", "No wording suggestions could be linked to source text.")}</p>}

                <div className="space-y-3 pt-1">
                  {report.tailoredSuggestions.map((sug, idx) => (
                    <div
                      key={idx}
                      className="rounded-lg border border-slate-100 bg-slate-50/60 p-3 space-y-2 text-xs"
                    >
                      <p className="text-[11px] text-slate-500">{t("原文已定位，改写待核实 · 引用要点：", "Source located; rewrite unverified · Claim:")}{sug.claimId}</p>
                      {sug.currentText && (
                        <div>
                          <span className="text-[10px] font-semibold text-slate-400 uppercase">
                            {t("当前简历表述：", "Current resume text:")}
                          </span>
                          <p className="text-slate-700">
                            {sug.currentText}
                          </p>
                        </div>
                      )}
                      <div>
                        <span className="text-[10px] font-semibold text-slate-600 uppercase">
                          {t("候选改写（待核实）：", "Suggested rewrite (unverified):")}
                        </span>
                        <p className="text-slate-800 bg-white p-2 rounded border border-slate-200 mt-0.5 leading-relaxed">
                          {sug.suggestedText}
                        </p>
                      </div>
                      <p className="text-[11px] text-slate-500 italic">
                        {t("优化理由：", "Reason:")}{sug.reason}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Interview Defense Tips */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs space-y-3">
                <h4 className="font-bold text-xs text-slate-900 flex items-center gap-1.5 uppercase tracking-wide">
                  <HelpCircle className="h-4 w-4 text-indigo-600" />
                  {t("面试官深挖考点与刁钻追问预警 (Defense Tips)", "Interview follow-up questions and preparation tips")}
                </h4>
                <ul className="space-y-2 text-xs text-slate-700">
                  {report.interviewDefenseTips.map((tip, idx) => (
                    <li
                      key={idx}
                      className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-2.5 flex items-start gap-2"
                    >
                      <span className="font-mono text-[11px] font-bold text-indigo-600 shrink-0">
                        Q{idx + 1}:
                      </span>
                      <span className="font-medium text-slate-800">{tip}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
