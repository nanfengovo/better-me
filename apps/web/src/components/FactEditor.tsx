import { useUiPreferences } from "../lib/ui-preferences";
import { useState, useRef, useEffect, useLayoutEffect, useCallback, type SyntheticEvent } from "react";
import { scanClaim } from "@better-me/core";
import type {
  FactBase,
  Experience,
  FactClaim,
  FactClaimKind,
  Profile,
  TextStyleRange,
} from "@better-me/core";
import { TextFormattingField } from "./TextFormattingField";
import { TagListEditor } from "./TagListEditor";
import { ClaimKindSelector } from "./ClaimKindSelector";
import { useConfirm } from "./ConfirmationDialog";
import { selectEditorFollowTarget } from "../lib/editor-follow";
import type { PreviewFollowTarget } from "../lib/preview-follow";
import { getIssueGuidance } from "../lib/issue-guidance";
import type { IssueNavigationRequest } from "../lib/issue-navigation";
import {
  Briefcase,
  User,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Tag,
  Languages,
  Camera,
  MessageSquare,
} from "lucide-react";

type Props = {
  factBase: FactBase;
  onChange: (next: FactBase) => void;
  /** Open the Agent with an auditable quote from the resume editor. */
  onAskAgentReference?: (reference: { type: "resume_text"; text: string; sourceLabel: string }) => void;
  textStyles?: Record<string, TextStyleRange[]>;
  onTextStylesChange?: (key: string, ranges: TextStyleRange[]) => void;
  onPreviewTargetChange?: (target: PreviewFollowTarget) => void;
  issueNavigation?: IssueNavigationRequest | null;
  onDismissIssue?: () => void;
};

type ViewMode = "bilingual" | "zh" | "en";

export function FactEditor({ factBase, onChange, onAskAgentReference, textStyles, onTextStylesChange, onPreviewTargetChange, issueNavigation, onDismissIssue }: Props) {
  const { t, locale } = useUiPreferences();
  const EXPERIENCE_TYPES: { value: Experience["type"]; label: string }[] = [
    { value: "work", label: t("工作经历", "Work experience") },
    { value: "opensource", label: t("开源经历", "Open-source experience") },
    { value: "education", label: t("教育经历", "Education") },
    { value: "other", label: t("项目 / 其他经历", "Projects / other experience") },
  ];

  const confirm = useConfirm();
  const [activeTab, setActiveTab] = useState<"experiences" | "profile">("experiences");
  const [viewMode, setViewMode] = useState<ViewMode>("zh");
  const [collapsedExps, setCollapsedExps] = useState<Record<string, boolean>>({});
  const [newExperienceType, setNewExperienceType] = useState<Experience["type"]>("work");
  const [avatarError, setAvatarError] = useState("");
  const [selectedResumeText, setSelectedResumeText] = useState<{ text: string; sourceLabel: string } | null>(null);
  const factBaseRef = useRef(factBase);
  const onChangeRef = useRef(onChange);
  const avatarReadIdRef = useRef(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followCallbackRef = useRef(onPreviewTargetChange);
  const pendingFollowFrameRef = useRef<number | undefined>(undefined);
  const pendingHoverFrameRef = useRef<number | undefined>(undefined);
  const lastHoverAnchorRef = useRef<string | undefined>(undefined);
  const focusedIssueRequestRef = useRef<IssueNavigationRequest | null>(null);

  const captureResumeSelection = useCallback((event: SyntheticEvent) => {
    if (!onAskAgentReference) return;
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) return;
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    if (end <= start) return;
    const text = target.value.slice(start, end).trim();
    if (!text) return;
    const fieldLabel = target.getAttribute("aria-label") || t("当前简历字段", "Current resume field");
    setSelectedResumeText({ text: text.slice(0, 12_000), sourceLabel: `简历 · ${fieldLabel}` });
  }, [onAskAgentReference, t]);

  const issueExperience = issueNavigation && factBase.experiences.find((item) => item.id === issueNavigation.issue.experienceId);
  const issueClaim = issueExperience?.claims.find((item) => item.id === issueNavigation?.issue.claimId);
  const issueGuidance = issueNavigation && getIssueGuidance(issueNavigation.issue.code, locale);
  const issueResolved = !!issueNavigation && !!issueClaim && (issueNavigation.issue.code === "missing_locale_en"
    ? !!issueClaim.text.en?.trim()
    : !scanClaim(issueClaim, issueNavigation.issue.experienceId).some((item) => item.code === issueNavigation.issue.code));
  const isIssueField = (expId: string, claimId: string, field: IssueNavigationRequest["field"]) =>
    issueNavigation?.issue.experienceId === expId && issueNavigation.issue.claimId === claimId && issueNavigation.field === field;

  useEffect(() => {
    if (!issueNavigation) { focusedIssueRequestRef.current = null; return; }
    setActiveTab("experiences");
    setCollapsedExps((previous) => ({ ...previous, [issueNavigation.issue.experienceId]: false }));
    if (issueNavigation.field === "text-zh") setViewMode((previous) => previous === "en" ? "zh" : previous);
    if (issueNavigation.field === "text-en") setViewMode((previous) => previous === "zh" ? "en" : previous);
  }, [issueNavigation]);

  useEffect(() => {
    factBaseRef.current = factBase;
    onChangeRef.current = onChange;
  }, [factBase, onChange]);

  useEffect(() => { followCallbackRef.current = onPreviewTargetChange; }, [onPreviewTargetChange]);

  useEffect(() => () => {
    if (pendingFollowFrameRef.current !== undefined) cancelAnimationFrame(pendingFollowFrameRef.current);
  }, []);

  const emitPreviewTarget = useCallback((target: PreviewFollowTarget) => {
    const progress = target.progress === undefined ? undefined : Math.round(target.progress * 50) / 50;
    const normalized = { ...target, ...(progress === undefined ? {} : { progress }) };
    // A fresh object resumes following after independent preview browsing, even
    // when the same field or short scroll block is still the active target.
    followCallbackRef.current?.(normalized);
  }, []);

  const targetForElement = useCallback((element: Element) => {
    const scroller = scrollerRef.current;
    const block = element.closest<HTMLElement>("[data-editor-anchor]");
    if (!scroller || !block || !scroller.contains(block)) return;
    const anchor = block.dataset.editorAnchor;
    if (!anchor) return;
    const fallbacks: string[] = [];
    let current: HTMLElement | null = block;
    while (current && scroller.contains(current)) {
      const parentAnchor = current.dataset.editorAnchor;
      if (parentAnchor && parentAnchor !== anchor) fallbacks.push(parentAnchor);
      current = current.parentElement;
    }
    return { anchor, fallbackAnchors: [...new Set(fallbacks)] };
  }, []);

  const followEditingTarget = useCallback((event: React.SyntheticEvent) => {
    if (!(event.target instanceof Element)) return;
    const target = targetForElement(event.target);
    if (!target) return;
    lastHoverAnchorRef.current = target.anchor;
    // Typing takes over from scroll even when the browser kept the same input focused.
    if (pendingFollowFrameRef.current !== undefined) {
      cancelAnimationFrame(pendingFollowFrameRef.current);
      pendingFollowFrameRef.current = undefined;
    }
    emitPreviewTarget({ ...target, source: "focus" });
  }, [emitPreviewTarget, targetForElement]);

  const followHoverTarget = useCallback((event: React.PointerEvent) => {
    if (!(event.target instanceof Element)) return;
    const target = targetForElement(event.target);
    if (!target) return;
    if (target.anchor === lastHoverAnchorRef.current) return;
    if (pendingHoverFrameRef.current !== undefined) {
      cancelAnimationFrame(pendingHoverFrameRef.current);
    }
    pendingHoverFrameRef.current = requestAnimationFrame(() => {
      pendingHoverFrameRef.current = undefined;
      lastHoverAnchorRef.current = target.anchor;
      emitPreviewTarget({ ...target, source: "focus" });
    });
  }, [emitPreviewTarget, targetForElement]);

  const followEditorScroll = useCallback(() => {
    if (!followCallbackRef.current || pendingFollowFrameRef.current !== undefined) return;
    pendingFollowFrameRef.current = requestAnimationFrame(() => {
      pendingFollowFrameRef.current = undefined;
      const scroller = scrollerRef.current;
      if (!scroller || !scroller.isConnected || scroller.clientWidth === 0 || scroller.clientHeight === 0) return;
      const bounds = scroller.getBoundingClientRect();
      const candidates = Array.from(scroller.querySelectorAll<HTMLElement>("[data-editor-anchor]")).map((element) => {
        const target = targetForElement(element);
        if (!target) return undefined;
        const rect = element.getBoundingClientRect();
        let depth = 0;
        let parent: HTMLElement | null = element;
        while (parent && parent !== scroller) { depth += 1; parent = parent.parentElement; }
        return { ...target, top: rect.top, bottom: rect.bottom, depth };
      }).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
      const target = selectEditorFollowTarget({ top: bounds.top + scroller.clientTop, height: scroller.clientHeight }, candidates);
      if (target) emitPreviewTarget(target);
    });
  }, [emitPreviewTarget, targetForElement]);

  const experienceTarget = (id: string): PreviewFollowTarget => ({ anchor: `experience:${id}`, source: "focus" });

  useLayoutEffect(() => {
    if (!issueNavigation || focusedIssueRequestRef.current === issueNavigation || activeTab !== "experiences") return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Compare imported IDs as attribute values, never interpolate them into selectors.
    const experience = Array.from(scroller.querySelectorAll<HTMLElement>("[data-editor-anchor]"))
      .find((element) => element.dataset.editorAnchor === `experience:${issueNavigation.issue.experienceId}`);
    const claim = experience && Array.from(experience.querySelectorAll<HTMLElement>("[data-editor-anchor]"))
      .find((element) => element.dataset.editorAnchor === `claim:${issueNavigation.issue.claimId}`);
    const field = claim?.querySelector<HTMLElement>(`[data-issue-field="${issueNavigation.field}"]`);
    const control = field?.matches("input, textarea") ? field : field?.querySelector<HTMLElement>("textarea, input");
    if (!control || control.matches(":disabled")) return;
    focusedIssueRequestRef.current = issueNavigation;
    if (pendingFollowFrameRef.current !== undefined) {
      cancelAnimationFrame(pendingFollowFrameRef.current);
      pendingFollowFrameRef.current = undefined;
    }
    control.focus({ preventScroll: true });
    control.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
    emitPreviewTarget({ anchor: `claim:${issueNavigation.issue.claimId}`, fallbackAnchors: [`experience:${issueNavigation.issue.experienceId}`], source: "focus" });
  }, [issueNavigation, activeTab, collapsedExps, viewMode, factBase, emitPreviewTarget]);

  useEffect(() => () => {
    avatarReadIdRef.current += 1;
    if (pendingHoverFrameRef.current !== undefined) {
      cancelAnimationFrame(pendingHoverFrameRef.current);
    }
  }, []);

  const toggleExpCollapse = (id: string) => {
    setCollapsedExps((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? (factBaseRef.current.experiences.findIndex((item) => item.id === id) > 0)),
    }));
    emitPreviewTarget(experienceTarget(id));
  };

  // --- Profile Helpers ---
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const updateProfile = useCallback((updater: (p: Profile) => Profile) => {
    const current = factBaseRef.current;
    const next = { ...current, profile: updater(current.profile) };
    factBaseRef.current = next;
    onChangeRef.current(next);
  }, []);

  const readAvatar = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      setAvatarError(t("请选择图片文件。", "Choose an image file."));
      return;
    }
    const readId = ++avatarReadIdRef.current;
    setAvatarError("");
    const reader = new FileReader();
    reader.onload = () => {
      if (readId !== avatarReadIdRef.current) return;
      if (typeof reader.result !== "string") {
        setAvatarError(t("图片读取失败，请重新选择。", "The image could not be read. Choose it again."));
        return;
      }
      const dataUrl = reader.result;
      updateProfile((profile) => ({ ...profile, avatarUrl: dataUrl }));
    };
    reader.onerror = () => {
      if (readId === avatarReadIdRef.current) setAvatarError(t("图片读取失败，请重新选择。", "The image could not be read. Choose it again."));
    };
    reader.readAsDataURL(file);
  }, [updateProfile, t]);

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    readAvatar(file);
    e.target.value = "";
  };

  useEffect(() => {
    if (activeTab !== "profile") return;
    const handlePaste = (e: ClipboardEvent) => {
      const target = e.target;
      // Other pages stay mounted; their screenshots must never become an avatar.
      if (!(target instanceof HTMLElement) || !scrollerRef.current?.contains(target)
        || !scrollerRef.current.getClientRects().length
        || target.closest("input, textarea, select") || target.isContentEditable) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item) continue;
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            readAvatar(file);
            break;
          }
        }
      }
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [activeTab, readAvatar]);

  // --- Experiences Helpers ---
  const updateExperiences = (updater: (exps: Experience[]) => Experience[]) => {
    const current = factBaseRef.current;
    const next = { ...current, experiences: updater(current.experiences) };
    factBaseRef.current = next;
    onChangeRef.current(next);
  };

  const addExperience = () => {
    const newExp: Experience = {
      id: crypto.randomUUID(),
      type: newExperienceType,
      org: { zh: "", en: "" },
      title: { zh: "", en: "" },
      start: "",
      end: "",
      techStack: [],
      claims: [],
    };
    updateExperiences((exps) => [newExp, ...exps]);
  };

  const deleteExperience = async (id: string) => {
    if (await confirm(t("确定要删除这条经历及其所有事实要点吗？", "Delete this experience and all its fact entries?"), { title: t("删除经历", "Delete experience"), confirmLabel: t("删除经历", "Delete experience"), danger: true })) {
      updateExperiences((exps) => exps.filter((e) => e.id !== id));
    }
  };

  const addClaim = (expId: string) => {
    const newClaim: FactClaim = {
      id: crypto.randomUUID(),
      kind: "action",
      text: { zh: "", en: "" },
      tags: [],
    };
    updateExperiences((exps) =>
      exps.map((e) =>
        e.id === expId ? { ...e, claims: [...e.claims, newClaim] } : e,
      ),
    );
  };

  const updateClaim = (
    expId: string,
    claimId: string,
    updater: (c: FactClaim) => FactClaim,
  ) => {
    updateExperiences((exps) =>
      exps.map((e) => {
        if (e.id !== expId) return e;
        return {
          ...e,
          claims: e.claims.map((c) => (c.id === claimId ? updater(c) : c)),
        };
      }),
    );
  };

  const deleteClaim = (expId: string, claimId: string) => {
    updateExperiences((exps) =>
      exps.map((e) => {
        if (e.id !== expId) return e;
        return {
          ...e,
          claims: e.claims.filter((c) => c.id !== claimId),
        };
      }),
    );
  };

  return (
    <section
      onPointerDownCapture={followEditingTarget}
      onFocusCapture={followEditingTarget}
      onPointerOverCapture={followHoverTarget}
      onSelectCapture={captureResumeSelection}
      className="fact-editor flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-sm"
    >
      {/* Editor Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-5 py-3.5 bg-slate-50/50">
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-[var(--color-line)] bg-white p-0.5 shadow-xs">
            <button
              type="button"
              onClick={() => {
                setActiveTab("experiences");
                const first = factBase.experiences[0];
                if (first) emitPreviewTarget(experienceTarget(first.id));
              }}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === "experiences"
                  ? "bg-[var(--color-accent)] text-white shadow-xs"
                  : "text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              }`}
            >
              <Briefcase className="h-3.5 w-3.5" />
              <span>{t("经历与成果", "Experience & achievements")}</span>
              <span className="ml-1 rounded-full bg-slate-200/60 px-1.5 py-0.2 text-[10px] text-slate-700">
                {factBase.experiences.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => { setActiveTab("profile"); emitPreviewTarget({ anchor: "profile", source: "focus" }); }}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                activeTab === "profile"
                  ? "bg-[var(--color-accent)] text-white shadow-xs"
                  : "text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              }`}
            >
              <User className="h-3.5 w-3.5" />
              <span>{t("个人信息", "Personal information")}</span>
            </button>
          </div>
        </div>

        {/* Bilingual / Locale Toggle */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-ink-muted)]" aria-describedby="editor-fields-help">
          <Languages className="h-3.5 w-3.5 text-slate-400" />
          <span className="font-medium">{t("编辑字段：", "Editor fields:")}</span>
          <div className="inline-flex rounded-lg border border-[var(--color-line)] bg-white p-0.5 text-xs shadow-xs">
            <button
              type="button"
              onClick={() => setViewMode("bilingual")}
              className={`rounded px-2 py-1 font-medium transition ${
                viewMode === "bilingual"
                  ? "bg-slate-800 text-white"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {t("中英双语", "Chinese & English")}</button>
            <button
              type="button"
              onClick={() => setViewMode("zh")}
              className={`rounded px-2 py-1 font-medium transition ${
                viewMode === "zh"
                  ? "bg-slate-800 text-white"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {t("仅中文", "Chinese only")}</button>
            <button
              type="button"
              onClick={() => setViewMode("en")}
              className={`rounded px-2 py-1 font-medium transition ${
                viewMode === "en"
                  ? "bg-slate-800 text-white"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {t("仅英文", "English only")}</button>
          </div>
          <p id="editor-fields-help" className="w-full text-[10px] leading-relaxed">{t("仅显示所选语言的编辑字段，不会翻译内容或更改简历输出语言。", "Shows fields in the selected language only. It does not translate content or change the resume output language.")}</p>
        </div>
      </div>

      {onAskAgentReference && selectedResumeText && (
        <div className="no-print flex items-center gap-2 border-b border-emerald-100 bg-emerald-50/80 px-5 py-2 text-[11px] text-emerald-900">
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-emerald-700" />
          <span className="min-w-0 flex-1 truncate" title={selectedResumeText.text}>
            {t("已选中简历内容：", "Resume text selected: ")}{selectedResumeText.text}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md bg-emerald-700 px-2.5 py-1 font-semibold text-white shadow-xs transition hover:bg-emerald-800"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onAskAgentReference({ type: "resume_text", ...selectedResumeText })}
          >
            {t("在伴侣中提问", "Ask in Companion")}
          </button>
          <button type="button" className="shrink-0 rounded-md px-1.5 py-1 text-emerald-700 hover:bg-emerald-100" onClick={() => setSelectedResumeText(null)} aria-label={t("清除引用", "Clear quote")}>×</button>
        </div>
      )}

      {issueNavigation && issueGuidance && (
        <aside className={`issue-guide no-print ${issueResolved ? "resolved" : ""}`} aria-label={t("内容检查修改指引", "Content review guidance")} id="content-issue-guidance">
          <div className="issue-guide-heading"><strong>{issueResolved ? t("此项已处理 · ", "Resolved · ") : t("修改指引 · ", "Editing guidance · ")}{issueGuidance.title}</strong><button type="button" aria-label={t("关闭修改指引", "Close editing guidance")} onClick={onDismissIssue}>×</button></div>
          {!issueClaim ? <p role="status">{t("这条要点已删除或不在当前文档中，请重新选择检查项。", "This entry was deleted or is unavailable in the current document. Select another review item.")}</p> : <>
            <p className="issue-guide-context">{issueExperience?.org.zh || issueExperience?.org.en || t("当前经历", "Current experience")}{t(` · 第 ${(issueExperience?.claims.findIndex((item) => item.id === issueClaim.id) ?? 0) + 1} 条要点`, ` · Entry ${(issueExperience?.claims.findIndex((item) => item.id === issueClaim.id) ?? 0) + 1}`)}</p>
            <p role="status" aria-live="polite">{issueResolved ? t("当前草稿已不再触发这项提醒。请核对真实内容，并按保存设置保存修改。", "The current draft no longer triggers this warning. Verify the facts and save using your selected settings.") : issueGuidance.description}</p>
            {!issueResolved && (issueNavigation.field === "value" || issueNavigation.field === "unit") && <p>{t("请先填写有效数值与单位，再核对并确认量化。", "Enter a valid value and unit, then verify the metric before confirming it.")}</p>}
            <details key={issueNavigation.requestId}><summary>{t("查看具体修改步骤", "View editing steps")}</summary><ol>{issueGuidance.steps.map((step) => <li key={step}>{step}</li>)}</ol>{issueGuidance.example && <p>{issueGuidance.example}</p>}</details>
          </>}
        </aside>
      )}
      {/* Editor Content Area */}
      <div ref={scrollerRef} onScroll={followEditorScroll} className="fact-editor-scroller min-h-0 flex-1 overflow-y-auto p-5 space-y-5">
        {activeTab === "profile" ? (
          /* ================= Profile Editor ================= */
          <div data-editor-anchor="profile" className="space-y-6 max-w-2xl mx-auto py-2">
            <div className="rounded-xl border border-[var(--color-line)] bg-white p-5 shadow-xs space-y-4">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 border-b border-slate-100 pb-3">
                <User className="h-4 w-4 text-[var(--color-accent)]" />
                {t("基本个人信息", "Basic information")}</h3>

              {/* Avatar Photo Section */}
              <div data-editor-anchor="profile:photo" className="flex items-center gap-4 border-b border-slate-100 pb-4">
                <div className="relative group shrink-0">
                  {factBase.profile.avatarUrl ? (
                    <img
                      src={factBase.profile.avatarUrl}
                      alt="Avatar"
                      className="h-20 w-16 rounded-lg border border-slate-300 object-cover shadow-xs"
                    />
                  ) : (
                    <div className="flex h-20 w-16 flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-200 bg-slate-50 text-slate-400">
                      <User className="h-6 w-6" />
                      <span className="text-[10px] mt-1 font-medium">{t("无头像", "No photo")}</span>
                    </div>
                  )}
                </div>
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <input
                      type="file"
                      ref={avatarInputRef}
                      onChange={handleAvatarUpload}
                      accept="image/*"
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => avatarInputRef.current?.click()}
                      className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 transition"
                    >
                      <Camera className="h-3.5 w-3.5 text-slate-500" />
                      <span>{factBase.profile.avatarUrl ? t("更换照片", "Change photo") : t("上传个人头像", "Upload photo")}</span>
                    </button>
                    {factBase.profile.avatarUrl && (
                      <button
                        type="button"
                        onClick={() => {
                          avatarReadIdRef.current += 1;
                          setAvatarError("");
                          updateProfile((p) => ({ ...p, avatarUrl: undefined }));
                        }}
                        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-rose-600 hover:bg-rose-50 transition"
                      >
                        {t("移除", "Remove")}</button>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400">{t("上传 JPG、PNG 或粘贴照片。在「排版设计」中选择是否展示；照片设置随简历保存。", "Upload JPG or PNG, or paste a photo. Choose whether to show it in Design; this preference is saved with the resume.")}</p>
                  {avatarError && <p role="alert" className="text-xs text-rose-700">{avatarError}</p>}
                </div>
              </div>

              <div data-editor-anchor="profile:displayName" className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {(viewMode === "bilingual" || viewMode === "zh") && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      {t("中文姓名", "Name in Chinese")}</label>
                    <TextFormattingField
                      label={t("中文姓名", "Name in Chinese")}
                      rows={1}
                      ranges={textStyles?.["profile:displayName:zh"]}
                      onStylesChange={onTextStylesChange ? (ranges) => onTextStylesChange("profile:displayName:zh", ranges) : undefined}
                      value={factBase.profile.displayName.zh}
                      onChange={(value) =>
                        updateProfile((p) => ({
                          ...p,
                          displayName: { ...p.displayName, zh: value },
                        }))
                      }
                    />
                  </div>
                )}

                {(viewMode === "bilingual" || viewMode === "en") && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      {t("英文姓名 (English Name)", "Name in English")}</label>
                    <TextFormattingField
                      label={t("英文姓名", "Name in English")}
                      rows={1}
                      ranges={textStyles?.["profile:displayName:en"]}
                      onStylesChange={onTextStylesChange ? (ranges) => onTextStylesChange("profile:displayName:en", ranges) : undefined}
                      value={factBase.profile.displayName.en ?? ""}
                      onChange={(value) =>
                        updateProfile((p) => ({
                          ...p,
                          displayName: { ...p.displayName, en: value },
                        }))
                      }
                    />
                  </div>
                )}
              </div>

              {/* Headline */}
              <div data-editor-anchor="profile:headline" className="space-y-3 pt-1">
                {(viewMode === "bilingual" || viewMode === "zh") && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      {t("个人定位 / 一句话简介 (中文)", "Headline / short introduction (Chinese)")}</label>
                    <TextFormattingField
                      label={t("中文个人定位", "Headline in Chinese")}
                      rows={1}
                      ranges={textStyles?.["profile:headline:zh"]}
                      onStylesChange={onTextStylesChange ? (ranges) => onTextStylesChange("profile:headline:zh", ranges) : undefined}
                      value={factBase.profile.headline?.zh ?? ""}
                      onChange={(value) =>
                        updateProfile((p) => ({
                          ...p,
                          headline: {
                            zh: value,
                            en: p.headline?.en ?? "",
                          },
                        }))
                      }
                      placeholder={t("例如：高级工业软件研发工程师 · 工业 AI 落地实践者", "For example: Senior Industrial Software Engineer · Applied Industrial AI")}
                    />
                  </div>
                )}

                {(viewMode === "bilingual" || viewMode === "en") && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Professional Headline (English)
                    </label>
                    <TextFormattingField
                      label={t("英文个人定位", "Headline in English")}
                      rows={1}
                      ranges={textStyles?.["profile:headline:en"]}
                      onStylesChange={onTextStylesChange ? (ranges) => onTextStylesChange("profile:headline:en", ranges) : undefined}
                      value={factBase.profile.headline?.en ?? ""}
                      onChange={(value) =>
                        updateProfile((p) => ({
                          ...p,
                          headline: {
                            zh: p.headline?.zh ?? "",
                            en: value,
                          },
                        }))
                      }
                      placeholder="e.g. Industrial Software Engineer · Industrial AI Practitioner"
                    />
                  </div>
                )}
              </div>

              {/* Education & Location */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                <div data-editor-anchor="profile:education">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {t("学历 (Education)", "Education")}</label>
                  <input
                    type="text"
                    value={factBase.profile.education?.zh ?? ""}
                    onChange={(e) =>
                      updateProfile((p) => ({
                        ...p,
                        education: {
                          zh: e.target.value,
                          en: p.education?.en ?? e.target.value,
                        },
                      }))
                    }
                    className="w-full rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
                  />
                </div>
                <div data-editor-anchor="profile:location">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {t("所在城市 (Location)", "Location")}</label>
                  <input
                    type="text"
                    value={factBase.profile.location?.zh ?? ""}
                    onChange={(e) =>
                      updateProfile((p) => ({
                        ...p,
                        location: {
                          zh: e.target.value,
                          en: p.location?.en ?? e.target.value,
                        },
                      }))
                    }
                    className="w-full rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
                  />
                </div>
              </div>

              {/* Contact */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                <div data-editor-anchor="profile:email">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {t("邮箱 (Email)", "Email")}</label>
                  <input
                    type="email"
                    value={factBase.profile.email ?? ""}
                    onChange={(e) =>
                      updateProfile((p) => ({ ...p, email: e.target.value.trim() || undefined }))
                    }
                    className="w-full rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
                    placeholder="name@example.com"
                  />
                </div>
                <div data-editor-anchor="profile:phone">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {t("电话 (Phone)", "Phone")}</label>
                  <input
                    type="text"
                    value={factBase.profile.phone ?? ""}
                    onChange={(e) =>
                      updateProfile((p) => ({ ...p, phone: e.target.value }))
                    }
                    className="w-full rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm focus:border-[var(--color-accent)] outline-none"
                    placeholder="+86 138-0000-0000"
                  />
                </div>
              </div>
            </div>

            {/* Career Goals & Constraints */}
            <div className="rounded-xl border border-[var(--color-line)] bg-white p-5 shadow-xs space-y-4">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 border-b border-slate-100 pb-3">
                <Tag className="h-4 w-4 text-[var(--color-accent)]" />
                {t("求职偏好与硬性红线 (SSOT)", "Job preferences & firm constraints (SSOT)")}</h3>

              <div data-editor-anchor="profile:targetRoles" className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold text-slate-700">{t("目标岗位", "Target roles")}</h4>
                  <button type="button" onClick={() => updateProfile((profile) => ({ ...profile, targetRoles: [...profile.targetRoles, { zh: "", en: "" }] }))} className="text-xs font-medium text-[var(--color-accent)]">{t("+ 添加目标岗位", "+ Add target role")}</button>
                </div>
                {factBase.profile.targetRoles.map((role, index) => (
                  <div key={index} className="flex items-start gap-2 rounded-lg border border-slate-200 p-2">
                    <div className="grid flex-1 gap-2 sm:grid-cols-2">
                      {viewMode !== "en" && (
                        <div>
                          <label htmlFor={`target-role-zh-${index}`} className="mb-1 block text-[11px] text-slate-600">{t("目标岗位（中文）", "Target role (Chinese)")}</label>
                          <input id={`target-role-zh-${index}`} value={role.zh} placeholder={t("填写实际目标岗位", "Enter your actual target role")} onChange={(event) => updateProfile((profile) => ({ ...profile, targetRoles: profile.targetRoles.map((item, itemIndex) => itemIndex === index ? { ...item, zh: event.target.value } : item) }))} className="w-full rounded border border-slate-200 px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]" />
                        </div>
                      )}
                      {viewMode !== "zh" && (
                        <div>
                          <label htmlFor={`target-role-en-${index}`} className="mb-1 block text-[11px] text-slate-600">Target role (English)</label>
                          <input id={`target-role-en-${index}`} value={role.en ?? ""} placeholder="Optional English role" onChange={(event) => updateProfile((profile) => ({ ...profile, targetRoles: profile.targetRoles.map((item, itemIndex) => itemIndex === index ? { ...item, en: event.target.value } : item) }))} className="w-full rounded border border-slate-200 px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]" />
                        </div>
                      )}
                    </div>
                    <button type="button" aria-label={t(`删除第 ${index + 1} 个目标岗位`, `Delete target role ${index + 1}`)} onClick={() => updateProfile((profile) => ({ ...profile, targetRoles: profile.targetRoles.filter((_, itemIndex) => itemIndex !== index) }))} className="rounded p-1 text-slate-400 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>

              <div data-editor-anchor="profile:traits" className="space-y-2 border-t border-slate-100 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold text-slate-700">{t("核心优势与专长", "Strengths & expertise")}</h4>
                  <button type="button" onClick={() => updateProfile((profile) => ({ ...profile, traits: [...profile.traits, ""] }))} className="text-xs font-medium text-[var(--color-accent)]">{t("+ 添加优势", "+ Add strength")}</button>
                </div>
                {factBase.profile.traits.map((trait, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <input aria-label={t(`第 ${index + 1} 条核心优势`, `Strength ${index + 1}`)} value={trait} placeholder={t("填写有经历或作品支持的优势", "Enter a strength supported by experience or work samples")} onChange={(event) => updateProfile((profile) => ({ ...profile, traits: profile.traits.map((item, itemIndex) => itemIndex === index ? event.target.value : item) }))} className="w-full rounded border border-slate-200 px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]" />
                    <button type="button" aria-label={t(`删除第 ${index + 1} 条核心优势`, `Delete strength ${index + 1}`)} onClick={() => updateProfile((profile) => ({ ...profile, traits: profile.traits.filter((_, itemIndex) => itemIndex !== index) }))} className="rounded p-1 text-slate-400 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
                <p className="text-[11px] text-slate-500">{t("优势字段目前共用一份文字，不随编辑语言自动翻译。", "Strengths use one shared text value and are not translated when the editing language changes.")}</p>
              </div>

              <div data-editor-anchor="profile:links" className="space-y-2 border-t border-slate-100 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold text-slate-700">{t("作品与个人链接", "Portfolio & personal links")}</h4>
                  <button type="button" onClick={() => updateProfile((profile) => ({ ...profile, links: [...profile.links, { label: "", url: "" }] }))} className="text-xs font-medium text-[var(--color-accent)]">{t("+ 添加链接", "+ Add link")}</button>
                </div>
                {factBase.profile.links.map((link, index) => (
                  <div key={index} className="flex items-start gap-2 rounded-lg border border-slate-200 p-2">
                    <div className="grid flex-1 gap-2">
                      <input aria-label={t(`第 ${index + 1} 个链接名称`, `Link ${index + 1} label`)} value={link.label} placeholder={t("链接名称，如 GitHub / 作品集", "Link label, such as GitHub / Portfolio")} onChange={(event) => updateProfile((profile) => ({ ...profile, links: profile.links.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) }))} className="w-full rounded border border-slate-200 px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]" />
                      <input type="url" aria-label={t(`第 ${index + 1} 个链接地址`, `Link ${index + 1} URL`)} value={link.url} placeholder="https://" onChange={(event) => updateProfile((profile) => ({ ...profile, links: profile.links.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value.trim() } : item) }))} className="w-full rounded border border-slate-200 px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]" />
                    </div>
                    <button type="button" aria-label={t(`删除第 ${index + 1} 个链接`, `Delete link ${index + 1}`)} onClick={() => updateProfile((profile) => ({ ...profile, links: profile.links.filter((_, itemIndex) => itemIndex !== index) }))} className="rounded p-1 text-slate-400 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>

              {/* Salary Range */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  {t("期望薪资范围 (K / 月)", "Expected salary (thousands / month)")}</label>
                <div className="flex items-center gap-2 max-w-xs">
                  <input
                    type="number"
                    value={factBase.profile.salaryRange?.minK ?? 20}
                    onChange={(e) =>
                      updateProfile((p) => ({
                        ...p,
                        salaryRange: {
                          minK: Number(e.target.value),
                          maxK: p.salaryRange?.maxK ?? 28,
                          currency: "CNY",
                        },
                      }))
                    }
                    className="w-24 rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
                  />
                  <span className="text-slate-400">{t("至", "to")}</span>
                  <input
                    type="number"
                    value={factBase.profile.salaryRange?.maxK ?? 28}
                    onChange={(e) =>
                      updateProfile((p) => ({
                        ...p,
                        salaryRange: {
                          minK: p.salaryRange?.minK ?? 20,
                          maxK: Number(e.target.value),
                          currency: "CNY",
                        },
                      }))
                    }
                    className="w-24 rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
                  />
                  <span className="text-xs text-slate-500 font-medium">K / CNY</span>
                </div>
              </div>

              {/* Constraints */}
              <div data-editor-anchor="profile:constraints">
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  {t("求职红线约束（绝不妥协的原则）", "Firm job constraints")}</label>
                <TagListEditor
                  tags={factBase.profile.constraints}
                  onChange={(nextConstraints) =>
                    updateProfile((p) => ({ ...p, constraints: nextConstraints }))
                  }
                  variant="warning"
                  pillShape="pill"
                  addLabel={t("添加约束", "Add constraint")}
                  placeholder={t("输入约束规则 (例如：0出差、0Oncall)", "Enter constraint (e.g. no travel, no on-call)")}
                  ariaLabel={t("求职红线约束", "Job constraints")}
                  inputAriaLabel={t("约束规则名称", "Constraint rule name")}
                />
              </div>
            </div>
          </div>
        ) : (
          /* ================= Experiences Editor ================= */
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                {t("新增内容保持空白，补齐必填字段后保存。未核实的量化不会投影到最终简历。", "New entries start blank. Complete required fields before saving. Unverified metrics stay out of the final resume.")}</p>
              <div className="flex items-center gap-2">
                <select aria-label={t("新增经历类型", "New experience type")} value={newExperienceType} onChange={(event) => setNewExperienceType(event.target.value as Experience["type"])} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]">
                  {EXPERIENCE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              <button
                type="button"
                onClick={addExperience}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[var(--color-accent-hover)] transition"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("新增经历", "Add experience")}</button>
              </div>
            </div>

            {factBase.experiences.map((exp, index) => {
              const isCollapsed = collapsedExps[exp.id] ?? (index > 0);

              return (
                <article
                  key={exp.id}
                  data-editor-anchor={`experience:${exp.id}`}
                  className="rounded-xl border border-[var(--color-line)] bg-white shadow-xs overflow-hidden transition"
                >
                  {/* Experience Card Header */}
                  <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleExpCollapse(exp.id)}
                      className="flex items-center gap-2.5 text-left flex-1"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-4 w-4 text-slate-400" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-slate-400" />
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-slate-900">
                            {(viewMode === "en" ? exp.org.en || exp.org.zh : exp.org.zh || exp.org.en) || t("机构 / 学校待填写", "Organization / school not entered")}
                          </span>
                          <span className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 uppercase">
                            {exp.type}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500">
                          {(viewMode === "en" ? exp.title.en || exp.title.zh : exp.title.zh || exp.title.en) || t("职位 / 学位待填写", "Role / degree not entered")}
                          {exp.projectName?.zh ? ` · ${exp.projectName.zh}` : ""} (
                          {exp.start || t("起始月份待填", "Start month not entered")} ~ {exp.end === null ? t("至今", "Present") : exp.end || t("结束月份待填", "End month not entered")})
                        </p>
                      </div>
                    </button>

                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400">
                        {exp.claims.length} {t("条事实", "facts")}</span>
                      <button
                        type="button"
                        onClick={() => deleteExperience(exp.id)}
                        className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition"
                        title={t("删除此经历", "Delete this experience")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {/* Experience Card Body */}
                  {!isCollapsed && (
                    <div className="p-4 space-y-4">
                      {/* Basic Meta Inputs */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label htmlFor={`experience-type-${exp.id}`} className="mb-1 block text-[11px] font-semibold text-slate-600">{t("经历类型", "Experience type")}</label>
                          <select id={`experience-type-${exp.id}`} value={exp.type} onChange={(event) => updateExperiences((experiences) => experiences.map((item) => item.id === exp.id ? { ...item, type: event.target.value as Experience["type"] } : item))} className="w-full rounded-md border border-[var(--color-line)] bg-white px-2.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]">
                            {EXPERIENCE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                          </select>
                        </div>
                        {viewMode !== "en" && (
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                            {t("公司 / 机构 (中文)", "Company / organization (Chinese)")}</label>
                          <input
                            type="text"
                            value={exp.org.zh}
                            placeholder={t("填写实际机构 / 学校名称", "Enter the actual organization / school name")}
                            onChange={(e) =>
                              updateExperiences((exps) =>
                                exps.map((it) =>
                                  it.id === exp.id
                                    ? { ...it, org: { ...it.org, zh: e.target.value } }
                                    : it,
                                ),
                              )
                            }
                            className="w-full rounded-md border border-[var(--color-line)] px-2.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                          />
                        </div>
                        )}

                        {(viewMode === "bilingual" || viewMode === "en") && (
                          <div>
                            <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                              Organization (English)
                            </label>
                            <input
                              type="text"
                              value={exp.org.en ?? ""}
                              placeholder="Optional English organization"
                              onChange={(e) =>
                                updateExperiences((exps) =>
                                  exps.map((it) =>
                                    it.id === exp.id
                                      ? { ...it, org: { ...it.org, en: e.target.value } }
                                      : it,
                                  ),
                                )
                              }
                              className="w-full rounded-md border border-[var(--color-line)] px-2.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                            />
                          </div>
                        )}

                        {viewMode !== "en" && (
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                            {t("职位 / 角色 / 学位 (中文)", "Title / role / degree (Chinese)")}</label>
                          <input
                            type="text"
                            value={exp.title.zh}
                            placeholder={t("填写实际职位、角色或学位专业", "Enter your actual title, role or degree subject")}
                            onChange={(e) =>
                              updateExperiences((exps) =>
                                exps.map((it) =>
                                  it.id === exp.id
                                    ? { ...it, title: { ...it.title, zh: e.target.value } }
                                    : it,
                                ),
                              )
                            }
                            className="w-full rounded-md border border-[var(--color-line)] px-2.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                          />
                        </div>
                        )}

                        {viewMode !== "zh" && (
                          <div>
                            <label className="mb-1 block text-[11px] font-semibold text-slate-600">Title / Role / Degree (English)</label>
                            <input type="text" value={exp.title.en ?? ""} placeholder="Optional English title / degree" onChange={(event) => updateExperiences((experiences) => experiences.map((item) => item.id === exp.id ? { ...item, title: { ...item.title, en: event.target.value } } : item))} className="w-full rounded-md border border-[var(--color-line)] px-2.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]" />
                          </div>
                        )}

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                            {t("起始月份 (YYYY-MM)", "Start month (YYYY-MM)")}</label>
                          <input
                            type="text"
                            value={exp.start}
                            onChange={(e) =>
                              updateExperiences((exps) =>
                                exps.map((it) =>
                                  it.id === exp.id
                                    ? { ...it, start: e.target.value }
                                    : it,
                                ),
                              )
                            }
                            className="w-full rounded-md border border-[var(--color-line)] px-2.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                            placeholder={t("YYYY-MM，按实际经历填写", "YYYY-MM, based on your actual experience")}
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                            {t("结束月份 (YYYY-MM)", "End month (YYYY-MM)")}</label>
                          <input
                            type="text"
                            value={exp.end ?? ""}
                            disabled={exp.end === null}
                            onChange={(e) => {
                              const val = e.target.value.trim();
                              updateExperiences((exps) =>
                                exps.map((it) =>
                                  it.id === exp.id
                                    ? { ...it, end: val }
                                    : it,
                                ),
                              );
                            }}
                            className="w-full rounded-md border border-[var(--color-line)] px-2.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                            placeholder={t("填写结束月份，或勾选仍在进行", "Enter an end month or mark as ongoing")}
                          />
                          <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-600">
                            <input type="checkbox" checked={exp.end === null} onChange={(event) => updateExperiences((experiences) => experiences.map((item) => item.id === exp.id ? { ...item, end: event.target.checked ? null : "" } : item))} />
                            {t("仍在进行 / 就读至今", "Ongoing / currently enrolled")}</label>
                        </div>

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                            {t("项目名称 (可选)", "Project name (optional)")}</label>
                          <input
                            type="text"
                            value={exp.projectName?.zh ?? ""}
                            onChange={(e) =>
                              updateExperiences((exps) =>
                                exps.map((it) =>
                                  it.id === exp.id
                                    ? {
                                        ...it,
                                        projectName: {
                                          zh: e.target.value,
                                          en: it.projectName?.en ?? "",
                                        },
                                      }
                                    : it,
                                ),
                              )
                            }
                            className="w-full rounded-md border border-[var(--color-line)] px-2.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                          />
                        </div>
                      </div>

                      {/* Tech Stack Tags */}
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1.5">
                          {t("技术栈标签 (Tech Stack)", "Technology tags")}</label>
                        <TagListEditor
                          tags={exp.techStack}
                          onChange={(nextTechStack) =>
                            updateExperiences((exps) =>
                              exps.map((it) =>
                                it.id === exp.id
                                  ? { ...it, techStack: nextTechStack }
                                  : it,
                              ),
                            )
                          }
                          variant="dopamine"
                          pillShape="rounded"
                          addLabel={t("标签", "Tag")}
                          placeholder={t("输入技术栈名称 (例如：C#, React, Redis)", "Enter a technology (for example: C#, React, Redis)")}
                          ariaLabel={t("技术栈标签", "Technology tags")}
                          inputAriaLabel={t("技术栈名称", "Technology name")}
                        />
                      </div>

                      {/* Claims / Bullets Section */}
                      <div className="border-t border-slate-100 pt-3">
                        <div className="flex items-center justify-between mb-3">
                          <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                            {t("成果与职责", "Achievements & responsibilities")}</h4>
                          <button
                            type="button"
                            onClick={() => addClaim(exp.id)}
                            className="flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition shadow-2xs"
                          >
                            <Plus className="h-3 w-3" />
                            {t("添加要点", "Add entry")}</button>
                        </div>

                        <div className="space-y-3">
                          {exp.claims.map((claim, claimIndex) => (
                            <div
                              key={claim.id}
                              data-editor-anchor={`claim:${claim.id}`}
                              data-issue-active={issueNavigation?.issue.experienceId === exp.id && issueNavigation.issue.claimId === claim.id ? "true" : undefined}
                              className="rounded-lg border border-slate-200/90 bg-slate-50/40 p-3 space-y-2.5 hover:border-slate-300 transition"
                            >
                              {/* Claim Header / Controls */}
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5">
                                  {/* Kind Selector */}
                                  <ClaimKindSelector
                                    value={claim.kind}
                                    onChange={(nextKind) =>
                                      updateClaim(exp.id, claim.id, (c) => ({
                                        ...c,
                                        kind: nextKind as FactClaimKind,
                                        // Missing values stay invalid in the page draft until supplied.
                                        metric:
                                          nextKind === "metric" && !c.metric
                                            ? {
                                                value: Number.NaN,
                                                unit: "",
                                                confirmed: false,
                                              }
                                            : c.metric && Number.isFinite(c.metric.value) && c.metric.unit.trim()
                                              ? c.metric
                                              : undefined,
                                      }))
                                    }
                                    ariaLabel={t(
                                      `${exp.org.zh || exp.org.en || t("新经历", "New experience")} · 要点 ${claimIndex + 1} · 类型`,
                                      `${exp.org.zh || exp.org.en || t("新经历", "New experience")} · Entry ${claimIndex + 1} · Kind`
                                    )}
                                  />

                                  {/* Metric Confirmed Switch */}
                                  {claim.kind === "metric" || claim.metric ? (
                                    <label className="flex items-center gap-1 text-xs font-medium cursor-pointer ml-2">
                                      <input
                                        type="checkbox"
                                        data-issue-field="confirmation"
                                        className={`rounded text-[var(--color-accent)] cursor-pointer ${isIssueField(exp.id, claim.id, "confirmation") ? "issue-field-highlight" : ""}`}
                                        aria-label={t(`${exp.org.zh || exp.org.en || t("新经历", "New experience")} · 要点 ${claimIndex + 1} · 已核实量化`, `${exp.org.zh || exp.org.en || t("新经历", "New experience")} · Entry ${claimIndex + 1} · Verified metric`)}
                                        aria-describedby={isIssueField(exp.id, claim.id, "confirmation") ? "content-issue-guidance" : undefined}
                                        checked={claim.metric?.confirmed ?? false}
                                        disabled={!claim.metric || !Number.isFinite(claim.metric.value) || !claim.metric.unit.trim()}
                                        onChange={(e) =>
                                          updateClaim(exp.id, claim.id, (c) => c.metric && Number.isFinite(c.metric.value) && c.metric.unit.trim()
                                            ? { ...c, metric: { ...c.metric, confirmed: e.target.checked } }
                                            : c)
                                        }
                                      />
                                      <span
                                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                          claim.metric?.confirmed
                                            ? "bg-emerald-100 text-emerald-800"
                                            : "bg-amber-100 text-amber-800"
                                        }`}
                                      >
                                        {claim.metric?.confirmed
                                          ? t("✓ 已核实量化（将进入简历）", "✓ Metric verified (included in resume)")
                                          : t("⚠ 待核实（简历将过滤此条）", "⚠ Unverified (excluded from resume)")}
                                      </span>
                                    </label>
                                  ) : null}
                                </div>

                                <button
                                  type="button"
                                  onClick={() => deleteClaim(exp.id, claim.id)}
                                  className="text-slate-400 hover:text-rose-600 p-1 rounded transition"
                                  title={t("删除此要点", "Delete this entry")}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>

                              {/* Claim Text Area (Zh) */}
                              {(viewMode === "bilingual" || viewMode === "zh") && (
                                <div data-issue-field="text-zh" className={isIssueField(exp.id, claim.id, "text-zh") ? "issue-field-highlight" : undefined}>
                                  <TextFormattingField
                                    label={t(`${exp.org.zh || t("新经历", "New experience")} · 中文要点 ${claimIndex + 1}`, `${exp.org.zh || t("新经历", "New experience")} · Chinese entry ${claimIndex + 1}`)}
                                    describedBy={isIssueField(exp.id, claim.id, "text-zh") ? "content-issue-guidance" : undefined}
                                    ranges={textStyles?.[`claim:${claim.id}:zh`]}
                                    onStylesChange={onTextStylesChange ? (ranges) => onTextStylesChange(`claim:${claim.id}:zh`, ranges) : undefined}
                                    value={claim.text.zh}
                                    onChange={(value) =>
                                      updateClaim(exp.id, claim.id, (c) => ({
                                        ...c,
                                        text: { ...c.text, zh: value },
                                        ...(c.metric ? { metric: { ...c.metric, confirmed: false } } : {}),
                                      }))
                                    }
                                    rows={2}
                                    placeholder={t("中文事实要点描述（尽量包含 STAR：动作、工具、对标结果）...", "Describe the fact in Chinese (consider STAR: action, tools and supported results)...")}
                                  />
                                </div>
                              )}

                              {/* Claim Text Area (En) */}
                              {(viewMode === "bilingual" || viewMode === "en") && (
                                <div data-issue-field="text-en" className={isIssueField(exp.id, claim.id, "text-en") ? "issue-field-highlight" : undefined}>
                                  <TextFormattingField
                                    label={t(`${exp.org.en || exp.org.zh || t("新经历", "New experience")} · 英文要点 ${claimIndex + 1}`, `${exp.org.en || exp.org.zh || t("新经历", "New experience")} · English entry ${claimIndex + 1}`)}
                                    describedBy={isIssueField(exp.id, claim.id, "text-en") ? "content-issue-guidance" : undefined}
                                    ranges={textStyles?.[`claim:${claim.id}:en`]}
                                    onStylesChange={onTextStylesChange ? (ranges) => onTextStylesChange(`claim:${claim.id}:en`, ranges) : undefined}
                                    value={claim.text.en ?? ""}
                                    onChange={(value) =>
                                      updateClaim(exp.id, claim.id, (c) => ({
                                        ...c,
                                        text: { ...c.text, en: value },
                                        ...(c.metric ? { metric: { ...c.metric, confirmed: false } } : {}),
                                      }))
                                    }
                                    rows={2}
                                    placeholder="English bullet point (Action verb + context + impact)..."
                                  />
                                </div>
                              )}

                              {/* Metric Sub-Form */}
                              {(claim.kind === "metric" || claim.metric) && (
                                <div className="rounded-md border border-amber-200/80 bg-amber-50/40 p-2.5 space-y-2 text-xs">
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                    <div>
                                      <label className="block text-[10px] font-semibold text-slate-600 mb-0.5">
                                        {t("数值 (Value)", "Value")}</label>
                                      <input
                                        type="number"
                                        data-issue-field="value"
                                        aria-label={t(`${exp.org.zh || exp.org.en || t("新经历", "New experience")} · 要点 ${claimIndex + 1} · 数值`, `${exp.org.zh || exp.org.en || t("新经历", "New experience")} · Entry ${claimIndex + 1} · Value`)}
                                        aria-describedby={isIssueField(exp.id, claim.id, "value") ? "content-issue-guidance" : undefined}
                                        step="any"
                                        value={claim.metric && Number.isFinite(claim.metric.value) ? claim.metric.value : ""}
                                        onChange={(e) =>
                                          updateClaim(exp.id, claim.id, (c) => ({
                                            ...c,
                                            metric: {
                                              value: e.target.value === "" ? Number.NaN : Number(e.target.value),
                                              unit: c.metric?.unit ?? "",
                                              baseline: c.metric?.baseline,
                                              causal: c.metric?.causal,
                                              confirmed: false,
                                            },
                                          }))
                                        }
                                        className={`w-full rounded border border-slate-200 bg-white px-2 py-1 outline-none text-xs ${isIssueField(exp.id, claim.id, "value") ? "issue-field-highlight" : ""}`}
                                        placeholder={t("填写原始数值", "Enter the original value")}
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-[10px] font-semibold text-slate-600 mb-0.5">
                                        {t("单位 (Unit)", "Unit")}</label>
                                      <input
                                        type="text"
                                        data-issue-field="unit"
                                        aria-label={t(`${exp.org.zh || exp.org.en || t("新经历", "New experience")} · 要点 ${claimIndex + 1} · 单位`, `${exp.org.zh || exp.org.en || t("新经历", "New experience")} · Entry ${claimIndex + 1} · Unit`)}
                                        aria-describedby={isIssueField(exp.id, claim.id, "unit") ? "content-issue-guidance" : undefined}
                                        value={claim.metric?.unit ?? ""}
                                        onChange={(e) =>
                                          updateClaim(exp.id, claim.id, (c) => ({
                                            ...c,
                                            metric: {
                                              value: c.metric?.value ?? Number.NaN,
                                              unit: e.target.value,
                                              baseline: c.metric?.baseline,
                                              causal: c.metric?.causal,
                                              confirmed: false,
                                            },
                                          }))
                                        }
                                        className={`w-full rounded border border-slate-200 bg-white px-2 py-1 outline-none text-xs ${isIssueField(exp.id, claim.id, "unit") ? "issue-field-highlight" : ""}`}
                                        placeholder={t("%, 台, ms", "%, devices, ms")}
                                      />
                                    </div>
                                    <div className="col-span-2">
                                      <label className="block text-[10px] font-semibold text-slate-600 mb-0.5">
                                        {t("对比基线 (Baseline)", "Comparison baseline")}</label>
                                      <input
                                        type="text"
                                        data-issue-field="baseline"
                                        aria-label={t(`${exp.org.zh || exp.org.en || t("新经历", "New experience")} · 要点 ${claimIndex + 1} · 对比基线`, `${exp.org.zh || exp.org.en || t("新经历", "New experience")} · Entry ${claimIndex + 1} · Comparison baseline`)}
                                        aria-describedby={isIssueField(exp.id, claim.id, "baseline") ? "content-issue-guidance" : undefined}
                                        value={claim.metric?.baseline ?? ""}
                                        onChange={(e) =>
                                          updateClaim(exp.id, claim.id, (c) => ({
                                            ...c,
                                            metric: {
                                              value: c.metric?.value ?? Number.NaN,
                                              unit: c.metric?.unit ?? "",
                                              baseline: e.target.value,
                                              causal: c.metric?.causal,
                                              confirmed: false,
                                            },
                                          }))
                                        }
                                        className={`w-full rounded border border-slate-200 bg-white px-2 py-1 outline-none text-xs ${isIssueField(exp.id, claim.id, "baseline") ? "issue-field-highlight" : ""}`}
                                        placeholder={t("写明真实原值、比较对象和统计口径", "State the actual original value, comparison and measurement method")}
                                      />
                                    </div>
                                    <div className="col-span-2 sm:col-span-4">
                                      <label className="block text-[10px] font-semibold text-slate-600 mb-0.5" htmlFor={`claim-causal-${claim.id}`}>{t("因果说明（与对比基线至少补充一项）", "Cause and action (provide this or a comparison baseline)")}</label>
                                      <textarea
                                        id={`claim-causal-${claim.id}`}
                                        aria-label={t(`${exp.org.zh || exp.org.en || t("新经历", "New experience")} · 要点 ${claimIndex + 1} · 因果说明`, `${exp.org.zh || exp.org.en || t("新经历", "New experience")} · Entry ${claimIndex + 1} · Cause and action`)}
                                        value={claim.metric?.causal ?? ""}
                                        rows={2}
                                        onChange={(event) => updateClaim(exp.id, claim.id, (current) => ({ ...current, metric: { value: current.metric?.value ?? Number.NaN, unit: current.metric?.unit ?? "", baseline: current.metric?.baseline, causal: event.target.value, confirmed: false } }))}
                                        className="w-full rounded border border-slate-200 bg-white px-2 py-1 outline-none text-xs"
                                        placeholder={t("写清实际采取的措施，以及它如何带来可核对的结果；不要推测因果关系", "Describe the actions actually taken and how they produced a verifiable result; do not assume causation")}
                                      />
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
