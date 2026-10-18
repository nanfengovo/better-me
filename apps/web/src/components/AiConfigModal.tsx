import { useUiPreferences } from "../lib/ui-preferences";
/** @jsxRuntime automatic */
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



type Props = {
  isOpen: boolean;
  onClose: () => void;
  config: LlmConfig;
  onSave: (config: LlmConfig) => Promise<void> | void;
};

export function AiConfigModal({ isOpen, onClose, config, onSave }: Props) {
  const { t } = useUiPreferences();

const PRESETS = [
  {
    name: "Google Gemini / AI Studio",
    provider: "gemini" as const,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-1.5-flash",
    fallbackModels: ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash-exp"],
    keyDocUrl: "https://aistudio.google.com/app/apikey",
    keyDocLabel: t("前往 Google AI Studio 获取 Key", "Get a key from Google AI Studio"),
  },
  {
    name: t("DeepSeek (高性价比)", "DeepSeek (cost effective)"),
    provider: "openai-compatible" as const,
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    fallbackModels: ["deepseek-chat", "deepseek-reasoner"],
    keyDocUrl: "https://platform.deepseek.com/api_keys",
    keyDocLabel: t("前往 DeepSeek 平台获取 Key", "Get a key from DeepSeek"),
  },
  {
    name: t("OpenAI 官方", "OpenAI"),
    provider: "openai-compatible" as const,
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    fallbackModels: ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"],
    keyDocUrl: "https://platform.openai.com/api-keys",
    keyDocLabel: t("前往 OpenAI 控制台获取 Key", "Get a key from OpenAI"),
  },
  {
    name: t("Ollama（本地服务）", "Ollama (local server)"),
    provider: "ollama" as const,
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:latest",
    fallbackModels: ["qwen2.5:latest", "llama3:latest", "deepseek-r1:latest"],
  },
];

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
  const requestController = useRef<AbortController | null>(null);

  useEffect(() => {
    requestVersion.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    if (isOpen) {
      setFormData({ ...config });
      setShowKey(false);
      setTesting(false);
      setSaving(false);
      setTestResult(null);
      setSaveError(null);
      setAvailableModels([]);
      setCustomModelMode(false);
    }
    return () => {
      requestVersion.current += 1;
      requestController.current?.abort();
      requestController.current = null;
    };
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
        baseUrl: t("API Base URL（须为完整地址）", "API Base URL (full URL required)"), model: t("模型名称（不能为空）", "Model name (required)"),
        temperature: t("温度（0–2）", "Temperature (0–2)"), provider: t("服务商类型", "Provider type"), apiKey: "API Key",
      };
      throw new Error(t(`请检查配置：${fields.map((field) => labels[String(field)] ?? String(field)).join("、")}。`, `Check configuration: ${fields.map((field) => labels[String(field)] ?? String(field)).join(", ")}.`));
    }
    if (!["http:", "https:"].includes(new URL(parsed.data.baseUrl).protocol)) {
      throw new Error(t("API Base URL 必须使用 http 或 https 地址。", "API Base URL must use http or https."));
    }
    return parsed.data;
  };

  const handleTestConnection = async () => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const version = ++requestVersion.current;
    setTesting(true);
    setTestResult(null);
    setAvailableModels([]);
    try {
      const res = await testLlmConnection(validatedConfig(), { signal: controller.signal });
      if (controller.signal.aborted || version !== requestVersion.current) return;
      setTestResult({
        success: res.success,
        message: res.message,
      });

      if (res.success && res.models.length > 0) {
        setAvailableModels(res.models);
      }
    } catch (err) {
      if (controller.signal.aborted || version !== requestVersion.current) return;
      setTestResult({
        success: false,
        message: (err as Error).message || t("获取模型列表失败", "Could not retrieve the model list"),
      });
    } finally {
      if (version === requestVersion.current) {
        requestController.current = null;
        setTesting(false);
      }
    }
  };

  const handleClose = () => {
    requestVersion.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    setTesting(false);
    setShowKey(false);
    onClose();
  };

  const handleSave = async () => {
    setSaveError(null);
    setSaving(true);
    try {
      await onSave(validatedConfig());
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("配置保存失败，请重试。", "Could not save the configuration. Please try again."));
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
      <div role="dialog" aria-modal="true" aria-labelledby="ai-config-title" className="w-full min-w-0 max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 space-y-4 animate-in fade-in zoom-in-95 duration-150 max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h2 id="ai-config-title" className="text-base font-bold text-slate-900">
                {t("AI 模型接入配置", "AI model configuration")}
              </h2>
              <p className="text-xs text-slate-500">
                {t("读取模型列表 · 支持 Google Gemini、DeepSeek、OpenAI 与 Ollama", "Model discovery · Google Gemini, DeepSeek, OpenAI and Ollama")}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={saving}
            aria-label={t("关闭 AI 配置", "Close AI configuration")}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Quick Presets */}
        <fieldset disabled={saving || testing} className="contents">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              {t("模型服务商预设", "Provider presets")}
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
                <span>{t("Google AI Studio / Gemini 原生兼容支持", "Google AI Studio / native Gemini compatibility")}</span>
              </div>
              <p className="text-[11px] text-blue-800 leading-relaxed">
                {t("Google 官方原生开放了 OpenAI 规范的端点，你可以使用在", "Google provides an OpenAI compatible endpoint. Use a Gemini API key created in")}{" "}
                <strong>Google AI Studio</strong> {t("创建的 Gemini API Key 直接调用。模型名称、可用地区、配额与费用以服务商当前规则为准。", "to make requests directly. Model names, regions, quotas and pricing follow the provider's current policies.")}
              </p>
              <div className="pt-0.5">
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:underline"
                >
                  <span>{t("前往 Google AI Studio 获取 API Key", "Get an API key from Google AI Studio")}</span>
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          )}

          {/* Form Inputs */}
          <div className="min-w-0 space-y-3">
            {/* Base URL */}
            <div>
              <label htmlFor="ai-base-url" className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5 text-slate-400" />
                API Base URL
              </label>
              <input
                id="ai-base-url"
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
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-1">
                <label htmlFor="ai-api-key" className="shrink-0 text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                  <Key className="h-3.5 w-3.5 text-slate-400" />
                  API Key
                </label>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
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
                    className="shrink-0 text-[11px] text-slate-400 hover:text-slate-600"
                  >
                    {showKey ? t("隐藏", "Hide") : t("显示", "Show")}
                  </button>
                </div>
              </div>
              <input
                id="ai-api-key"
                type={showKey ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={formData.apiKey ?? ""}
                onChange={(e) =>
                  updateDraft({ apiKey: e.target.value })
                }
                className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs outline-none focus:border-[var(--color-accent)] font-mono"
                placeholder={
                  isGemini
                    ? t("AIzaSy... (在 aistudio.google.com 创建的 Key)", "AIzaSy... (key created at aistudio.google.com)")
                    : t("sk-... (如果使用本地 Ollama 可留空)", "sk-... (optional for local Ollama)")
                }
              />
            </div>

            {/* Model Name & Dynamic Model Selector */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="ai-model" className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                  <Cpu className="h-3.5 w-3.5 text-slate-400" />
                  {t("模型名称 (Model)", "Model name")}
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
                        <span>{t("下拉选择", "Select from list")}</span>
                      </>
                    ) : (
                      <>
                        <Edit3 className="h-3 w-3" />
                        <span>{t("手动输入", "Enter manually")}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {customModelMode ? (
                <input
                  id="ai-model"
                  type="text"
                  value={formData.model}
                  onChange={(e) =>
                    updateDraft({ model: e.target.value })
                  }
                  className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs outline-none focus:border-[var(--color-accent)] font-mono"
                  placeholder={t("例如：gemini-1.5-flash, deepseek-chat", "For example: gemini-1.5-flash, deepseek-chat")}
                />
              ) : (
                <div className="flex min-w-0 flex-wrap gap-2 sm:flex-nowrap">
                  <select
                    id="ai-model"
                    value={formData.model}
                    onChange={(e) =>
                      updateDraft({ model: e.target.value })
                    }
                    className="min-w-0 flex-1 basis-44 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-[var(--color-accent)] font-mono"
                  >
                    {displayModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {/* Keep current model in options if not listed */}
                    {!displayModels.includes(formData.model) && formData.model && (
                      <option value={formData.model}>
                        {formData.model} {t("(当前自定义)", "(current custom model)")}
                      </option>
                    )}
                  </select>
                  <button
                    type="button"
                    onClick={handleTestConnection}
                    disabled={testing}
                    className="shrink-0 flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition disabled:opacity-50"
                    title={t("请求服务商的模型列表；不发送生成请求", "Request the provider's model list; no generation request is sent")}
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${testing ? "animate-spin" : ""}`}
                    />
                    <span>{t("刷新列表", "Refresh list")}</span>
                  </button>
                </div>
              )}

              {availableModels.length > 0 && (
                <p className="text-[10px] text-emerald-600 mt-1 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  {t("已获取", "Retrieved")} {availableModels.length} {t("个模型标识；生成权限与文本/视觉能力尚未验证", "model identifiers; generation access and text/vision capabilities have not been verified")}
                </p>
              )}
              {availableModels.length === 0 && (
                <p className="text-[10px] text-slate-500 mt-1">
                  {t("预设名称仅作示例，可能已变更或停用。请获取列表或按服务商文档手动填写。", "Preset names are examples and may change or be retired. Retrieve the list or enter a name from the provider's documentation.")}
                </p>
              )}
              <p className="text-[10px] text-slate-500 mt-1">
                {t("AI 请求跟随浏览器与系统代理／TUN；“网络与代理”中的岗位连接设置不作用于此处。刷新列表后保留当前模型，由你选择是否更换。", "AI requests use the browser and system proxy/TUN. Job connection settings in Network & proxy do not apply here. Refreshing the list keeps your current model until you choose another.")}
              </p>
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
                      <span>{t("正在获取模型列表...", "Retrieving model list...")}</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>{t("获取模型列表（不测试生成）", "Get model list (no generation test)")}</span>
                    </>
                  )}
                </button>
              </div>

              {testResult && (
                <div
                  role={testResult.success ? "status" : "alert"}
                  className={`mt-2 min-w-0 rounded-lg p-2.5 text-xs flex items-start gap-2 ${
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
                  <div className="min-w-0 break-words [overflow-wrap:anywhere] leading-relaxed">
                    <p className="font-semibold">
                      {testResult.success ? t("模型列表已获取", "Model list retrieved") : t("未获得模型列表", "Model list not retrieved")}
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
                {t("配置与简历保存在本机浏览器 localStorage。使用云模型时，相关简历、JD 或页面图片会直接发往所选服务商；本项目没有中转服务。使用本机 Ollama 且地址指向本机时，推理才在本机进行。模型列表请求也会携带 API Key。", "Configuration and resumes are stored in this browser's localStorage. Cloud models receive the relevant resume, job description or page images directly, without a BetterMe relay. Inference is local only when Ollama and its address are on this computer. Model list requests also include your API key.")}
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
            onClick={handleClose}
            disabled={saving}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition"
          >
            {t("取消", "Cancel")}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || testing}
            className="flex items-center gap-1 rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[var(--color-accent-hover)] transition"
          >
            <Check className="h-3.5 w-3.5" />
            {saving ? t("正在保存...", "Saving...") : t("保存配置", "Save configuration")}
          </button>
        </div>
      </div>
    </div>
  );
}
