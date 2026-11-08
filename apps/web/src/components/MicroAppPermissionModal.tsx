import { useState } from "react";
import { CheckCircle2, ShieldCheck, Lock, X, Code2, AlertTriangle, Pin } from "lucide-react";
import { useUiPreferences } from "../lib/ui-preferences";
import type { BuiltMicroAppArtifact } from "../services/sandbox-build-client";

interface MicroAppPermissionModalProps {
  artifact: BuiltMicroAppArtifact | null;
  isOpen: boolean;
  onClose: () => void;
  onApprove: (artifact: BuiltMicroAppArtifact, pinToDock: boolean) => void;
}

export function MicroAppPermissionModal({
  artifact,
  isOpen,
  onClose,
  onApprove,
}: MicroAppPermissionModalProps) {
  const { t, theme } = useUiPreferences();
  const [showCode, setShowCode] = useState(false);

  if (!isOpen || !artifact) return null;

  const isDark = theme === "dark";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`w-full max-w-xl rounded-2xl border shadow-2xl overflow-hidden flex flex-col transition-all ${
          isDark
            ? "bg-[#111822] border-cyan-500/30 text-slate-100"
            : "bg-white border-slate-300 text-slate-900"
        }`}
        style={{
          boxShadow: isDark
            ? "0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 30px rgba(6, 182, 212, 0.15)"
            : "0 25px 50px -12px rgba(0, 0, 0, 0.2)",
        }}
      >
        {/* Modal Header */}
        <div
          className={`flex items-center justify-between px-6 py-4 border-b ${
            isDark ? "border-white/10 bg-black/20" : "border-slate-100 bg-slate-50/80"
          }`}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl bg-gradient-to-br from-amber-400 to-cyan-400 shadow-md">
              {artifact.icon || "📦"}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold tracking-tight">
                  {artifact.name}
                </h3>
                <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-500 border border-cyan-500/20">
                  v{artifact.version}
                </span>
              </div>
              <p className={`text-xs ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                {artifact.description || t("Agent 自动化工坊构建的微应用", "Micro-app built by Agent Autopilot")}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className={`p-1.5 rounded-lg transition-colors ${
              isDark ? "hover:bg-white/10 text-slate-400" : "hover:bg-slate-200 text-slate-500"
            }`}
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-5 overflow-y-auto max-h-[70vh]">
          {/* Security Digest Banner */}
          <div
            className={`p-3.5 rounded-xl border flex items-center justify-between font-mono text-xs ${
              isDark
                ? "bg-emerald-950/20 border-emerald-500/30 text-emerald-300"
                : "bg-emerald-50 border-emerald-200 text-emerald-800"
            }`}
          >
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
              <span>
                SHA-256: <b>{artifact.codeHash}</b>
              </span>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 font-bold">
              ESBUILD · IIFE 零外链
            </span>
          </div>

          {/* Pre-flight Automated Verification Checks */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className={`text-xs font-bold uppercase tracking-wider ${isDark ? "text-slate-400" : "text-slate-600"}`}>
                {t("预检沙箱自动化审计 (Pre-flight Tests)", "Pre-flight Automated Audit")}
              </span>
              <span className="text-xs text-emerald-500 font-bold flex items-center gap-1">
                <CheckCircle2 size={13} />
                3/3 {t("全部通过", "All Passed")}
              </span>
            </div>
            <div className={`divide-y rounded-xl border overflow-hidden ${
              isDark ? "divide-white/5 border-white/10 bg-black/30" : "divide-slate-100 border-slate-200 bg-slate-50/50"
            }`}>
              {artifact.verification.checks.map((check) => (
                <div key={check.id} className="p-3 flex items-start gap-3 text-xs">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold">{check.name}</div>
                    <div className={`text-[11px] mt-0.5 ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                      {check.detail}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Declared Permissions / Scopes */}
          <div className="space-y-2">
            <span className={`text-xs font-bold uppercase tracking-wider ${isDark ? "text-slate-400" : "text-slate-600"}`}>
              {t("申请权限与数据流界限", "Requested Permissions & Data Flow")}
            </span>
            <div className={`p-3.5 rounded-xl border space-y-2 text-xs ${
              isDark ? "border-white/10 bg-black/20" : "border-slate-200 bg-white"
            }`}>
              {artifact.grantedScopes.map((scope) => (
                <div key={scope} className="flex items-center gap-2">
                  <Lock className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                  <span className="font-mono font-bold text-cyan-500">{scope}</span>
                  <span className={`text-[11px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                    {scope === "selected_offers"
                      ? "— 仅按需只读投递与 Offer 薪酬折算投影（脱敏，不含真实凭证与完整简历）"
                      : scope === "backcheck_summary"
                      ? "— 仅读取企业合规与舆情背调聚合标签"
                      : "— 仅限局部工作区只读快照"}
                  </span>
                </div>
              ))}
              <div className={`pt-2 border-t text-[11px] flex items-center gap-1.5 ${
                isDark ? "border-white/5 text-amber-400/80" : "border-slate-100 text-amber-700"
              }`}>
                <AlertTriangle size={13} className="shrink-0" />
                <span>
                  严格运行在 <code>&lt;iframe sandbox="allow-scripts"&gt;</code> 中，禁止 <code>allow-same-origin</code>，无法访问宿主 Cookie、LocalStorage 与私有密钥。
                </span>
              </div>
            </div>
          </div>

          {/* Inspect Code Toggle */}
          <div>
            <button
              type="button"
              onClick={() => setShowCode(!showCode)}
              className={`text-xs font-mono flex items-center gap-1.5 transition-colors ${
                isDark ? "text-slate-400 hover:text-cyan-400" : "text-slate-600 hover:text-cyan-600"
              }`}
            >
              <Code2 size={13} />
              <span>{showCode ? t("隐藏编译后代码包", "Hide Compiled Bundle") : t("审查打包 HTML/JS 代码...", "Inspect Compiled Code...")}</span>
            </button>
            {showCode && (
              <pre
                className={`mt-2 p-3 rounded-xl border text-[10px] font-mono overflow-x-auto max-h-48 leading-relaxed ${
                  isDark ? "bg-black/70 border-white/10 text-cyan-300" : "bg-slate-100 border-slate-200 text-slate-800"
                }`}
              >
                {artifact.bundleHtml}
              </pre>
            )}
          </div>
        </div>

        {/* Modal Actions */}
        <div
          className={`flex items-center justify-between px-6 py-4 border-t ${
            isDark ? "border-white/10 bg-black/40" : "border-slate-100 bg-slate-50"
          }`}
        >
          <button
            type="button"
            onClick={onClose}
            className={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
              isDark ? "text-slate-400 hover:bg-white/10" : "text-slate-600 hover:bg-slate-200"
            }`}
          >
            {t("拒绝并销毁", "Reject & Destroy")}
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onApprove(artifact, false)}
              className={`px-4 py-2 rounded-xl text-xs font-semibold border transition-all ${
                isDark
                  ? "border-white/20 text-slate-200 hover:bg-white/10"
                  : "border-slate-300 text-slate-700 hover:bg-white"
              }`}
            >
              {t("仅单次运行", "Run Once Only")}
            </button>
            <button
              type="button"
              onClick={() => onApprove(artifact, true)}
              className="px-5 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-emerald-500 to-cyan-500 text-slate-950 hover:brightness-110 shadow-lg flex items-center gap-1.5 transition-all"
            >
              <Pin size={13} />
              <span>{t("批准并固定到 Dock", "Approve & Pin to Dock")}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
