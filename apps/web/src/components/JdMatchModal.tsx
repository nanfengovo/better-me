import { useEffect, useRef, useState } from "react";
import {
  analyzeJdMatch,
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
} from "lucide-react";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  resume: ProjectedResume;
  llmConfig: LlmConfig;
  onOpenConfig: () => void;
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
}: Props) {
  const [jdText, setJdText] = useState("");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<JdMatchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const requestVersion = useRef(0);

  useEffect(() => {
    requestVersion.current += 1;
    setLoading(false);
    setReport(null);
    setError(null);
    setCopied(false);
    return () => { requestVersion.current += 1; };
  }, [isOpen, jdText, resume, llmConfig]);

  if (!isOpen) return null;

  const handleStartAnalysis = async () => {
    if (!jdText.trim()) {
      alert("请先粘贴目标职位的 JD 需求文本。");
      return;
    }
    if (!llmConfig.apiKey?.trim() && llmConfig.provider === "gemini") {
      alert("请先配置 Gemini API Key。");
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
      setError(err instanceof Error ? err.message : "分析匹配失败，请检查网络或配置。");
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  };

  const handleCopyReport = async () => {
    if (!report) return;
    const version = requestVersion.current;
    const text = `# BetterMe 岗位匹配度诊断报告
匹配评分：${report.matchScore} / 100
总体评价：${report.scoreSummary}

## 核心契合亮点
${report.matchingStrengths.map((s) => `- ${s}`).join("\n")}

## 关键短板与差距
${report.missingGaps.map((g) => `- ${g}`).join("\n")}

## 针对性润色建议（防编造原则）
${report.tailoredSuggestions
  .map(
    (t, i) =>
      `### 建议 ${i + 1}
原表述：${t.currentText ?? "无"}
建议修改：${t.suggestedText}
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
      setError("复制失败，请检查浏览器剪贴板权限，或手动选择并复制报告内容。");
    }
  };

  return (
    <div className="no-print fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-3 sm:p-5">
      <div className="flex h-full max-h-[92vh] w-full max-w-4xl flex-col rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--color-accent)] text-white shadow-xs">
              <Target className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <span>目标 JD 匹配度评估与 AI 诊断</span>
                <span className="rounded bg-slate-200/70 px-2 py-0.5 text-[10px] font-medium text-slate-700">
                  防编造模式
                </span>
              </h2>
              <p className="text-xs text-slate-500">
                对标岗位要求 · 诊断技能差距 · 建议 STAR 针对性强调 · 面试考点预警
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenConfig}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-2xs hover:bg-slate-50 transition"
              title="配置 AI 模型"
            >
              <Settings2 className="h-3.5 w-3.5 text-slate-500" />
              <span>{llmConfig.model}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-5">
          {/* JD Input Area */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/40 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5 text-slate-500" />
                粘贴目标岗位的招聘需求 (JD)
              </label>
              <button
                type="button"
                onClick={() => setJdText(SAMPLE_JD)}
                className="text-xs text-[var(--color-accent)] font-medium hover:underline"
              >
                填入工业软件工程师范例 JD
              </button>
            </div>

            <textarea
              value={jdText}
              onChange={(e) => setJdText(e.target.value)}
              rows={5}
              placeholder="在此粘贴 BOSS直聘 / 猎聘 / LinkedIn / 官网的岗位职责与任职要求..."
              className="w-full resize-y rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed outline-none focus:border-[var(--color-accent)]"
            />

            <div className="flex items-center justify-between pt-1">
              <span className="text-[11px] text-slate-400">
                当前简历投影条数：{resume.experiences.length} 段经历，语言：
                {resume.locale}
              </span>
              <button
                type="button"
                onClick={() => void handleStartAnalysis()}
                disabled={loading}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-[var(--color-accent-hover)] transition disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>AI 深度诊断中...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>开始智能匹配与诊断</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Error Notice */}
          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800 flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600 mt-0.5" />
                <div>
                  <p className="font-bold">操作失败</p>
                  <p className="mt-0.5 leading-relaxed text-rose-700">{error}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onOpenConfig}
                className="shrink-0 rounded-lg bg-rose-700 hover:bg-rose-800 text-white px-3 py-1.5 text-xs font-semibold shadow-xs transition"
              >
                配置与重新选择模型
              </button>
            </div>
          )}

          {/* Report Results */}
          {report && (
            <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-200">
              {/* Score & Summary Banner */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-emerald-200/90 bg-emerald-50/70 p-5 shadow-xs">
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-white font-bold text-xl shadow-xs">
                    {report.matchScore}
                    <span className="text-xs font-normal ml-0.5">%</span>
                  </div>
                  <div>
                    <h3 className="font-bold text-sm text-emerald-950">
                      岗位契合度总体评分
                    </h3>
                    <p className="mt-1 text-xs text-emerald-800 leading-relaxed max-w-xl">
                      {report.scoreSummary}
                    </p>
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
                      <span>已复制报告</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>复制诊断结果</span>
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
                    核心契合亮点 (Strengths)
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
                    关键短板与差距 (Gaps)
                  </h4>
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

              {/* Targeted Suggestions (Anti-Hallucination) */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs space-y-3">
                <div>
                  <h4 className="font-bold text-xs text-slate-900 flex items-center gap-1.5 uppercase tracking-wide">
                    <Sparkles className="h-4 w-4 text-[var(--color-accent)]" />
                    针对性表达强化建议 (仅优化表述，绝不造假)
                  </h4>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    基于你已有的真实事实，将表述重点向该 JD 的痛点靠拢。
                  </p>
                </div>

                <div className="space-y-3 pt-1">
                  {report.tailoredSuggestions.map((sug, idx) => (
                    <div
                      key={idx}
                      className="rounded-lg border border-slate-100 bg-slate-50/60 p-3 space-y-2 text-xs"
                    >
                      {sug.currentText && (
                        <div>
                          <span className="text-[10px] font-semibold text-slate-400 uppercase">
                            当前简历表述：
                          </span>
                          <p className="text-slate-600 line-through decoration-slate-300">
                            {sug.currentText}
                          </p>
                        </div>
                      )}
                      <div>
                        <span className="text-[10px] font-semibold text-emerald-700 uppercase">
                          建议优化表述 (更突出匹配关键词与因果链)：
                        </span>
                        <p className="text-emerald-950 font-medium bg-emerald-50/70 p-2 rounded border border-emerald-200/60 mt-0.5 leading-relaxed">
                          {sug.suggestedText}
                        </p>
                      </div>
                      <p className="text-[11px] text-slate-500 italic">
                        优化理由：{sug.reason}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Interview Defense Tips */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-2xs space-y-3">
                <h4 className="font-bold text-xs text-slate-900 flex items-center gap-1.5 uppercase tracking-wide">
                  <HelpCircle className="h-4 w-4 text-indigo-600" />
                  面试官深挖考点与刁钻追问预警 (Defense Tips)
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
