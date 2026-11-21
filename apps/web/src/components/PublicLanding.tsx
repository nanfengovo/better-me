/** @jsxRuntime automatic */
import { ArrowRight, Check, Cpu, Download, FileSearch, Github, HardDrive, Lock, Moon, ShieldCheck, Sun } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import { Button } from "../design-system";
import { AtsDiagnosticTool } from "./AtsDiagnosticTool";
import "./public-showcase.css";

const RELEASE_URL = "https://github.com/nanfengovo/better-me/releases/tag/v1.3.0";
const REPO_URL = "https://github.com/nanfengovo/better-me";

export interface PublicLandingProps {
  onEnterStudio: () => void;
  onOpenStandaloneAts?: () => void;
}

/**
 * Editorial, anti-hype public landing page for BetterMe.
 * Inspired by Dossier (dossier.aien.me) & Reactive Resume (rxresu.me):
 * - Honest by Design proof card showing verified facts + explicit gap
 * - Embedded zero-auth deterministic ATS checker
 * - Transparent local-first privacy guarantees and known boundaries
 */
export function PublicLanding({ onEnterStudio }: PublicLandingProps) {
  const { t, locale, setLocale, theme, setTheme } = useUiPreferences();
  const isEn = locale === "en";

  const proofRows = [
    {
      verified: true,
      req: t("TypeScript / React 工程架构经验", "TypeScript & React architecture"),
      source: t("来源 · 北星智能科技 · 重构设计系统与 18 个业务模块", "Source · Northstar Systems · Shared design system across 18 modules"),
    },
    {
      verified: true,
      req: t("PostgreSQL 性能调优与索引设计", "PostgreSQL query & index tuning"),
      source: t("来源 · 北星智能科技 · 核心订单 P99 耗时缩短 62%（已核实基线）", "Source · Northstar Systems · Reduced peak P99 latency by 62% (verified)"),
    },
    {
      verified: true,
      req: t("CI/CD 与端到端回归测试", "CI/CD & automated E2E testing"),
      source: t("来源 · 北星智能科技 · Playwright + GitHub Actions 降低回滚率 70%", "Source · Northstar Systems · Playwright & GitHub Actions pipeline"),
    },
    {
      verified: true,
      req: t("本地优先数据可靠性与离线恢复", "Local-first storage & recovery"),
      source: t("来源 · 云帆数据 · 离线草稿与版本快照机制", "Source · CloudSail Data · Offline draft persistence & snapshots"),
    },
    {
      verified: false,
      req: t("Kubernetes 生产集群运维经验", "Production Kubernetes cluster ops"),
      source: t("事实库未覆盖 · 标为真实 Gap，绝不自动编造写入简历", "Not in FactBase · Flagged honestly as a gap, never fabricated"),
    },
  ];

  const steps = [
    {
      num: "01",
      title: t("一次沉淀结构化事实库", "Write your FactBase once"),
      desc: t("导入 PDF / DOCX / Markdown 或逐条录入真实经历；支持拖拽排序与未核实量化指标隔离。", "Import existing resumes or add verified experiences with drag-and-drop ordering and metric guardrails."),
    },
    {
      num: "02",
      title: t("对照岗位逐条取证定制", "Tailor with verified evidence"),
      desc: t("粘贴目标 JD，系统只引用你的真实经历生成定制视图，缺少的技能明示为 Gap，绝不虚构。", "Paste any posting to match requirements against your real claims. Missing skills stay transparent gaps."),
    },
    {
      num: "03",
      title: t("视觉 + ATS 双视角导出", "Visual & ATS dual-view export"),
      desc: t("40+ 原生版式实时预览、点击纸张直达编辑，一键切换 ATS 纯文本读取视角并导出 PDF / DOCX。", "40+ native layouts, click-to-edit directly on the paper, instant ATS parser view, and clean PDF/DOCX export."),
    },
    {
      num: "04",
      title: t("机会空间与全平台桌面端", "Track applications locally"),
      desc: t("统一管理机会库、跟进节奏与全局快捷键，提供 macOS / Windows / Linux 原生桌面端安装包。", "Organize opportunities, follow-ups, and custom shortcuts across Web and native macOS, Windows, and Linux apps."),
    },
  ];

  const downloads = [
    {
      os: "macOS (Apple Silicon)",
      file: "BetterMe-1.3.0-macos-arm64.dmg",
      href: `${RELEASE_URL}`,
    },
    {
      os: "macOS (Intel x64)",
      file: "BetterMe-1.3.0-macos-x64.dmg",
      href: `${RELEASE_URL}`,
    },
    {
      os: "Windows (x64)",
      file: "BetterMe-1.3.0-windows-x64-setup.exe",
      href: `${RELEASE_URL}`,
    },
    {
      os: "Linux (AppImage)",
      file: "BetterMe-1.3.0-linux-x64.AppImage",
      href: `${RELEASE_URL}`,
    },
  ];

  return (
    <div className="bm-public-page">
      {/* Sticky Calm Navigation */}
      <nav className="bm-public-nav" aria-label={t("主导航", "Main navigation")}>
        <div className="bm-public-nav-inner">
          <a href="#top" className="bm-public-brand" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
            <span className="bm-public-mark" aria-hidden="true">B</span>
            <span>BetterMe</span>
          </a>
          <div className="bm-public-links">
            <a href="#honest">{t("零虚构设计", "Honest by Design")}</a>
            <a href="#how">{t("工作原理", "How it works")}</a>
            <a href="#ats-checker">{t("免费 ATS 诊断", "ATS Checker")}</a>
            <a href="#privacy">{t("隐私与边界", "Privacy")}</a>
            <a href="#download">{t("下载", "Download")}</a>
          </div>
          <div className="bm-public-nav-actions">
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              aria-label={theme === "dark" ? t("切换浅色主题", "Switch to light mode") : t("切换深色主题", "Switch to dark mode")}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setLocale(isEn ? "zh" : "en")}>
              {isEn ? "中文" : "EN"}
            </Button>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="bm-btn" data-variant="secondary" data-size="xs">
              <Github size={13} aria-hidden="true" />
              GitHub
            </a>
            <Button variant="primary" size="xs" onClick={onEnterStudio}>
              {t("进入 Agent OS", "Open Agent OS")}
            </Button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <header id="top" className="bm-public-hero">
        <a href={RELEASE_URL} target="_blank" rel="noreferrer" className="bm-public-release-pill">
          <span className="bm-public-release-dot" aria-hidden="true" />
          <span>{t("v1.3.0 已发布 · MIT 开源 · 100% 本地优先", "Version 1.3.0 is out · MIT Open Source · Local-first")}</span>
          <ArrowRight size={12} aria-hidden="true" />
        </a>

        <h1 className="bm-public-h1">
          {t("你的求职操作系统，", "Your career workspace,")}
          <br />
          <em>{t("只说你做过的事。", "grounded in verified facts.")}</em>
        </h1>

        <p className="bm-public-lead">
          {t(
            "一份结构化事实库（FactBase），按每个目标岗位生成可溯源的定制简历；内置 40+ 原生版式、ATS 解析视角与全平台桌面端，全部运行在你自己的设备上。",
            "One verified FactBase, evidence-backed tailored resumes for every role, 40+ native layouts, ATS parser view, and desktop apps — all running locally on your own machine.",
          )}
        </p>

        <div className="bm-public-hero-ctas">
          <Button variant="primary" size="md" onClick={onEnterStudio}>
            {t("立即进入 Agent OS 体验", "Launch Agent OS Workspace")}
            <ArrowRight size={15} aria-hidden="true" />
          </Button>
          <a href="#ats-checker" className="bm-btn" data-variant="secondary" data-size="md">
            <FileSearch size={15} aria-hidden="true" />
            {t("免登录 ATS 简历诊断", "Free Local ATS Checker")}
          </a>
          <a href={RELEASE_URL} target="_blank" rel="noreferrer" className="bm-btn" data-variant="ghost" data-size="md">
            <Download size={14} aria-hidden="true" />
            {t("下载桌面端 v1.3.0", "Download Desktop v1.3.0")}
          </a>
        </div>

        <p className="bm-public-reassurance">
          {t(
            "无需注册账号，不收集你的简历数据；在线预览运行在独立浏览器存储中。",
            "No signup required. Your resume never leaves your device; the live preview runs in isolated browser storage.",
          )}
        </p>
      </header>

      {/* Honest by Design Split Band */}
      <section id="honest" className="bm-public-section">
        <div className="bm-honest-grid">
          <div>
            <div className="bm-public-eyebrow">{t("HONEST BY DESIGN · 零虚构原则", "HONEST BY DESIGN")}</div>
            <h2 className="bm-public-h2">
              {t("绝不替你编造经历，", "It never invents experience,")}
              <br />
              <em>{t("每一行都有事实依据。", "every line cites your FactBase.")}</em>
            </h2>
            <p className="bm-public-body">
              {t(
                "普通 AI 简历工具喜欢为了高匹配度悄悄塞入你没做过的技能或编造数字，最终让你在面试现场陷入被动。BetterMe 把事实核验写进数据模型本身。",
                "Generic AI resume tools silently invent skills and numbers to chase a match score, leaving you exposed in interviews. BetterMe enforces factual provenance at the schema level.",
              )}
            </p>
            <ul className="bm-honest-list">
              <li>
                <Check size={15} aria-hidden="true" />
                <span>{t("所有量化数字必须补齐对比基线或因果说明，未核实指标默认拦截，绝不投影到导出简历。", "Unverified metrics are blocked from export until backed by a real baseline or causal explanation.")}</span>
              </li>
              <li>
                <Check size={15} aria-hidden="true" />
                <span>{t("岗位要求与事实库的差集显式标为 Gap，帮助你提前准备面试防守或针对性补齐。", "Unmatched job requirements surface honestly as gaps so you can prepare interview defense instead of faking them.")}</span>
              </li>
              <li>
                <Check size={15} aria-hidden="true" />
                <span>{t("AI 仅作为辅助草拟与诊断，绝不未经你确认自动改写底稿或自动投递。", "Human-in-the-loop by default: nothing is overwritten, sent, or applied without your explicit review.")}</span>
              </li>
            </ul>
          </div>

          <div className="bm-proof-card" aria-label={t("事实库核验示例卡片", "FactBase verification example card")}>
            <div className="bm-proof-card-head">
              <strong>{t("岗位匹配核验 · 高级全栈工程师", "Requirement Check · Senior Full-Stack")}</strong>
              <span>{t("4 / 5 项已有事实支撑", "4 of 5 covered")}</span>
            </div>
            <div className="bm-proof-rows">
              {proofRows.map((row) => (
                <div key={row.req} className="bm-proof-row" data-gap={!row.verified ? "true" : undefined}>
                  <span className="bm-proof-badge" data-state={row.verified ? "verified" : "gap"}>
                    {row.verified ? t("已核实", "Verified") : "Gap"}
                  </span>
                  <div className="bm-proof-copy">
                    <strong>{row.req}</strong>
                    <small>{row.source}</small>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="bm-public-section">
        <div className="bm-public-eyebrow">{t("HOW IT WORKS · 工作流", "HOW IT WORKS")}</div>
        <h2 className="bm-public-h2">{t("从零散履历到可信投递，四步闭环。", "Four calm steps from raw history to confident applications.")}</h2>
        <div className="bm-steps-grid">
          {steps.map((step) => (
            <article key={step.num} className="bm-step-card">
              <span className="bm-step-num">{step.num}</span>
              <h3>{step.title}</h3>
              <p>{step.desc}</p>
            </article>
          ))}
        </div>
      </section>

      {/* Embedded Zero-Auth ATS Checker */}
      <section id="ats-checker" className="bm-public-section">
        <AtsDiagnosticTool />
      </section>

      {/* Privacy & Known Boundaries */}
      <section id="privacy" className="bm-public-section">
        <div className="bm-public-eyebrow">{t("PRIVACY & TRANSPARENCY · 隐私与坦诚边界", "PRIVACY & BOUNDARIES")}</div>
        <h2 className="bm-public-h2">{t("你的履历只属于你自己。", "Your career history stays with you.")}</h2>
        <div className="bm-privacy-grid">
          <article className="bm-privacy-card">
            <h3><HardDrive size={15} aria-hidden="true" />{t("100% 本地优先存储", "100% local-first storage")}</h3>
            <p>{t("简历文档、版本快照与机会库均保存在你本地浏览器或桌面端目录，随时导出标准 JSON 备份。", "Documents, version history, and saved opportunities live in your browser or local desktop folder, exportable as JSON anytime.")}</p>
          </article>
          <article className="bm-privacy-card">
            <h3><Cpu size={15} aria-hidden="true" />{t("自由选择本地或云端模型", "Bring your own model — or Ollama")}</h3>
            <p>{t("不配置 AI 也可完整使用简历编辑、排版、ATS 诊断与机会追踪；如需 AI 顾问，支持 Ollama 本地模型或自备 API Key。", "Core editing, layout, ATS diagnostics, and job tracking require no AI. Connect Ollama locally or your own API key when needed.")}</p>
          </article>
          <article className="bm-privacy-card">
            <h3><ShieldCheck size={15} aria-hidden="true" />{t("明确的人工确认边界", "Strict human-in-the-loop")}</h3>
            <p>{t("BetterMe 不会后台静默发送求职邮件或代你点击投递；所有外部动作均需要你的明确授权与核对。", "BetterMe never silently submits applications or sends emails behind your back. Every external action requires confirmation.")}</p>
          </article>
          <article className="bm-privacy-card">
            <h3><Lock size={15} aria-hidden="true" />{t("MIT 开源可审计", "Open source under MIT")}</h3>
            <p>{t("全部前端、桌面端与本地运行时代码公开可读，构建产物均由 GitHub Actions 自动编译并附带 SHA256 校验。", "All source code is open for audit, and desktop installers are built reproducibly via GitHub Actions with SHA256 checksums.")}</p>
          </article>
        </div>

        <div className="bm-limits-box">
          <strong>{t("使用前值得知道的边界：", "Good to know before you start: ")}</strong>
          {t(
            "BetterMe 主要面向桌面与笔记本宽屏打磨（非移动端优先）；GitHub Pages 在线预览为静态演示环境，不含本地招聘抓取与本地 Agent Host 进程——如需完整本地 AI 运行时与桌面级文件保护，请下载桌面端安装包或本地运行仓库。",
            "BetterMe is designed primarily for desktop and laptop screens. The GitHub Pages preview runs purely in browser storage without the local Agent Host — download the desktop app or run locally for the full local runtime.",
          )}
        </div>
      </section>

      {/* Platform Downloads */}
      <section id="download" className="bm-public-section">
        <div className="bm-public-eyebrow">{t("DESKTOP RELEASES · 全平台桌面端", "DESKTOP RELEASES")}</div>
        <h2 className="bm-public-h2">{t("下载 BetterMe v1.3.0，开箱即用。", "Download BetterMe v1.3.0 for your machine.")}</h2>
        <div className="bm-download-grid">
          {downloads.map((item) => (
            <a key={item.os} href={item.href} target="_blank" rel="noreferrer" className="bm-download-card">
              <strong>{item.os}</strong>
              <small>{item.file}</small>
              <span>{t("前往 GitHub Releases 下载 →", "Download on GitHub →")}</span>
            </a>
          ))}
        </div>
      </section>

      <footer className="bm-public-footer">
        <span>{t("BetterMe · MIT License · 本页面不设第三方追踪脚本与广告 Cookie。", "BetterMe · MIT License · This page sets no tracking cookies or third-party analytics.")}</span>
        <div className="flex items-center gap-4">
          <button type="button" className="underline cursor-pointer bg-transparent border-0 text-inherit p-0" onClick={onEnterStudio}>
            {t("进入 Agent OS 工作台", "Open Agent OS")}
          </button>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="underline text-inherit">GitHub</a>
        </div>
      </footer>
    </div>
  );
}
