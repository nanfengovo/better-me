import { useEffect, useRef, useState } from "react";
import {
  testLlmConnection,
  LlmConfigSchema,
  type LlmConfig,
} from "@better-me/core";
import {
  Bot,
  Key,
  Globe,
  Cpu,
  X,
  Check,
  ShieldCheck,
  ExternalLink,
  Sparkles,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Edit3,
  List,
} from "lucide-react";

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  provider: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  apiKey: "",
  model: "gemini-1.5-flash",
  temperature: 0.3,
};

const PRESETS = [
  {
    name: "Google Gemini / AI Studio",
    provider: "gemini" as const,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-1.5-flash",
    fallbackModels: ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash-exp"],
    keyDocUrl: "https://aistudio.google.com/app/apikey",
    keyDocLabel: "前往 Google AI Studio 获取 Key",
  },
  {
    name: "DeepSeek (高性价比)",
    provider: "openai-compatible" as const,
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    fallbackModels: ["deepseek-chat", "deepseek-reasoner"],
    keyDocUrl: "https://platform.deepseek.com/api_keys",
    keyDocLabel: "前往 DeepSeek 平台获取 Key",
  },
  {
    name: "OpenAI 官方",
    provider: "openai-compatible" as const,
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    fallbackModels: ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"],
    keyDocUrl: "https://platform.openai.com/api-keys",
    keyDocLabel: "前往 OpenAI 控制台获取 Key",
  },
  {
    name: "Ollama（本地服务）",
    provider: "ollama" as const,
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:latest",
    fallbackModels: ["qwen2.5:latest", "llama3:latest", "deepseek-r1:latest"],
  },
];

type Props = {
  isOpen: boolean;
  onClose: () => void;
  config: LlmConfig;
  onSave: (config: LlmConfig) => Promise<void> | void;
};

export function AiConfigModal({ isOpen, onClose, config, onSave }: Props) {
  const [formData, setFormData] = useState<LlmConfig>(config);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [customModelMode, setCustomModelMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  useEffect(() => {
    requestVersion.current += 1;
    if (!isOpen) return;
    setFormData({ ...config });
    setShowKey(false);
    setTesting(false);
    setSaving(false);
    setTestResult(null);
    setSaveError(null);
    setAvailableModels([]);
    setCustomModelMode(false);
  }, [isOpen, config]);

  if (!isOpen) return null;

  const currentPreset = PRESETS.find((p) =>
    formData.baseUrl.trim().replace(/\/+$/, "") === p.baseUrl.replace(/\/+$/, ""),
  );

  const updateDraft = (changes: Partial<LlmConfig>) => {
    setFormData((prev) => ({ ...prev, ...changes }));
    setSaveError(null);
    if ("baseUrl" in changes || "apiKey" in changes) {
      setTestResult(null);
      setAvailableModels([]);
    }
  };

  const handleApplyPreset = (preset: (typeof PRESETS)[0]) => {
    setFormData((prev) => ({
      ...prev,
      provider: preset.provider,
      baseUrl: preset.baseUrl,
      model: preset.defaultModel,
    }));
    setTestResult(null);
    setAvailableModels([]);
    setSaveError(null);
  };

  const validatedConfig = () => {
    const parsed = LlmConfigSchema.safeParse({
      ...formData,
      baseUrl: formData.baseUrl.trim(),
      apiKey: formData.apiKey?.trim() ?? "",
      model: formData.model.trim(),
    });
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path[0]))];
      const labels: Record<string, string> = {
        baseUrl: "API Base URL（须为完整地址）", model: "模型名称（不能为空）",
        temperature: "温度（0–2）", provider: "服务商类型", apiKey: "API Key",
      };
      throw new Error(`请检查配置：${fields.map((field) => labels[String(field)] ?? String(field)).join("、")}。`);
    }
    if (!["http:", "https:"].includes(new URL(parsed.data.baseUrl).protocol)) {
      throw new Error("API Base URL 必须使用 http 或 https 地址。");
    }
    return parsed.data;
  };

  const handleTestConnection = async () => {
    const version = ++requestVersion.current;
    setTesting(true);
    setTestResult(null);
    setAvailableModels([]);
    try {
      const res = await testLlmConnection(validatedConfig());
      if (version !== requestVersion.current) return;
      setTestResult({
        success: res.success,
        message: res.message,
      });

      if (res.success && res.models.length > 0) {
        setAvailableModels(res.models);
        // If current model is not in available models, suggest the first valid one
        if (!res.models.includes(formData.model)) {
          const preferred =
            res.models.find(
              (m) =>
                m.includes("flash") ||
                m.includes("chat") ||
                m.includes("mini"),
            ) ?? res.models[0];
          if (preferred) {
            setFormData((prev) => ({ ...prev, model: preferred }));
          }
        }
      }
    } catch (err) {
      if (version !== requestVersion.current) return;
      setTestResult({
        success: false,
        message: (err as Error).message || "获取模型列表失败",
      });
    } finally {
      if (version === requestVersion.current) setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaveError(null);
    setSaving(true);
    try {
      await onSave(validatedConfig());
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "配置保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  const isGemini =
    formData.provider === "gemini" ||
    formData.baseUrl.includes("generativelanguage.googleapis.com");

  // Models to display: either fetched models, or preset fallbacks
  const displayModels =
    availableModels.length > 0
      ? availableModels
      : currentPreset?.fallbackModels ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 space-y-4 animate-in fade-in zoom-in-95 duration-150 max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">
                AI 模型接入配置
              </h2>
              <p className="text-xs text-slate-500">
                读取模型列表 · 支持 Google Gemini、DeepSeek、OpenAI 与 Ollama
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭 AI 配置"
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Quick Presets */}
        <fieldset disabled={saving || testing} className="contents">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              模型服务商预设
            </label>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((p) => {
                const active = currentPreset === p;

                return (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => handleApplyPreset(p)}
                    className={`rounded-xl border p-2 text-left text-xs transition ${
                      active
                        ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]/40 font-semibold text-slate-900 shadow-2xs"
                        : "border-slate-200 bg-slate-50/60 font-medium text-slate-600 hover:border-slate-300 hover:bg-white"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span>{p.name}</span>
                      {active && (
                        <Check className="h-3.5 w-3.5 text-[var(--color-accent)]" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Google Gemini Highlight Guide */}
          {isGemini && (
            <div className="rounded-xl border border-blue-200/90 bg-blue-50/70 p-3 text-xs text-blue-900 space-y-1.5">
              <div className="flex items-center gap-1.5 font-bold">
                <Sparkles className="h-4 w-4 text-blue-600" />
                <span>Google AI Studio / Gemini 原生兼容支持</span>
              </div>
              <p className="text-[11px] text-blue-800 leading-relaxed">
                Google 官方原生开放了 OpenAI 规范的端点，你可以使用在{" "}
                <strong>Google AI Studio</strong> 创建的 Gemini API Key 直接调用。模型名称、可用地区、配额与费用以服务商当前规则为准。
              </p>
              <div className="pt-0.5">
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:underline"
                >
                  <span>前往 Google AI Studio 获取 API Key</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          )}

          {/* Form Inputs */}
          <div className="space-y-3">
            {/* Base URL */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5 text-slate-400" />
                API Base URL
              </label>
              <input
                type="text"
                value={formData.baseUrl}
                onChange={(e) =>
                  updateDraft({ baseUrl: e.target.value })
                }
                className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs outline-none focus:border-[var(--color-accent)] font-mono"
                placeholder="https://generativelanguage.googleapis.com/v1beta/openai/"
              />
            </div>

            {/* API Key */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                  <Key className="h-3.5 w-3.5 text-slate-400" />
                  API Key
                </label>
                <div className="flex items-center gap-2">
                  {currentPreset?.keyDocUrl && (
                    <a
                      href={currentPreset.keyDocUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-[var(--color-accent)] hover:underline inline-flex items-center gap-0.5"
                    >
                      <span>{currentPreset.keyDocLabel}</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="text-[11px] text-slate-400 hover:text-slate-600"
                  >
                    {showKey ? "隐藏" : "显示"}
                  </button>
                </div>
              </div>
              <input
                type={showKey ? "text" : "password"}
                value={formData.apiKey ?? ""}
                onChange={(e) =>
                  updateDraft({ apiKey: e.target.value })
                }
                className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs outline-none focus:border-[var(--color-accent)] font-mono"
                placeholder={
                  isGemini
                    ? "AIzaSy... (在 aistudio.google.com 创建的 Key)"
                    : "sk-... (如果使用本地 Ollama 可留空)"
                }
              />
            </div>

            {/* Model Name & Dynamic Model Selector */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                  <Cpu className="h-3.5 w-3.5 text-slate-400" />
                  模型名称 (Model)
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCustomModelMode(!customModelMode)}
                    className="text-[11px] text-slate-500 hover:text-slate-800 flex items-center gap-1"
                  >
                    {customModelMode ? (
                      <>
                        <List className="h-3 w-3" />
                        <span>下拉选择</span>
                      </>
                    ) : (
                      <>
                        <Edit3 className="h-3 w-3" />
                        <span>手动输入</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {customModelMode ? (
                <input
                  type="text"
                  value={formData.model}
                  onChange={(e) =>
                    updateDraft({ model: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs outline-none focus:border-[var(--color-accent)] font-mono"
                  placeholder="例如：gemini-1.5-flash, deepseek-chat"
                />
              ) : (
                <div className="flex gap-2">
                  <select
                    value={formData.model}
                    onChange={(e) =>
                      updateDraft({ model: e.target.value })
                    }
                    className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-[var(--color-accent)] font-mono"
                  >
                    {displayModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {/* Keep current model in options if not listed */}
                    {!displayModels.includes(formData.model) && formData.model && (
                      <option value={formData.model}>
                        {formData.model} (当前自定义)
                      </option>
                    )}
                  </select>
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={testing}
                    className="shrink-0 flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition disabled:opacity-50"
                    title="请求服务商的模型列表；不发送生成请求"
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${testing ? "animate-spin" : ""}`}
                    />
                    <span>刷新列表</span>
                  </button>
                </div>
              )}

              {availableModels.length > 0 && (
                <p className="text-[10px] text-emerald-600 mt-1 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  已获取 {availableModels.length} 个模型标识；生成权限与文本/视觉能力尚未验证
                </p>
              )}
              {availableModels.length === 0 && (
                <p className="text-[10px] text-slate-500 mt-1">
                  预设名称仅作示例，可能已变更或停用。请获取列表或按服务商文档手动填写。
                </p>
              )}
            </div>

            {/* Test Connection Banner & Button */}
            <div className="pt-1">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={handleTestConnection}
                  disabled={testing}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-white hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition disabled:opacity-50"
                >
                  {testing ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>正在获取模型列表...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>获取模型列表（不测试生成）</span>
                    </>
                  )}
                </button>
              </div>

              {testResult && (
                <div
                  className={`mt-2 rounded-lg p-2.5 text-xs flex items-start gap-2 ${
                    testResult.success
                      ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                      : "bg-rose-50 border border-rose-200 text-rose-800"
                  }`}
                >
                  {testResult.success ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                  )}
                  <div className="leading-relaxed">
                    <p className="font-semibold">
                      {testResult.success ? "模型列表已获取" : "未获得模型列表"}
                    </p>
                    <p className="text-[11px] mt-0.5">{testResult.message}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Privacy Note */}
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5 flex items-start gap-2 text-[11px] text-slate-600">
              <ShieldCheck className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
              <span>
                配置与简历保存在本机浏览器 localStorage。使用云模型时，相关简历、JD 或页面图片会直接发往所选服务商；本项目没有中转服务。使用本机 Ollama 且地址指向本机时，推理才在本机进行。模型列表请求也会携带 API Key。
              </span>
            </div>
          </div>
        </fieldset>

        {saveError && (
          <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-800">
            {saveError}
          </p>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || testing}
            className="flex items-center gap-1 rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[var(--color-accent-hover)] transition"
          >
            <Check className="h-3.5 w-3.5" />
            {saving ? "正在保存..." : "保存配置"}
          </button>
        </div>
      </div>
    </div>
  );
}
