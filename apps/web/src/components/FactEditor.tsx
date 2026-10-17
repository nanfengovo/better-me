import { useState, useRef, useEffect, useCallback } from "react";
import type {
  FactBase,
  Experience,
  FactClaim,
  Profile,
  TextStyleRange,
} from "@better-me/core";
import { TextFormattingField } from "./TextFormattingField";
import { selectEditorFollowTarget } from "../lib/editor-follow";
import type { PreviewFollowTarget } from "../lib/preview-follow";
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
} from "lucide-react";

type Props = {
  factBase: FactBase;
  onChange: (next: FactBase) => void;
  textStyles?: Record<string, TextStyleRange[]>;
  onTextStylesChange?: (key: string, ranges: TextStyleRange[]) => void;
  onPreviewTargetChange?: (target: PreviewFollowTarget) => void;
};

type ViewMode = "bilingual" | "zh" | "en";

const EXPERIENCE_TYPES: { value: Experience["type"]; label: string }[] = [
  { value: "work", label: "工作经历" },
  { value: "opensource", label: "开源经历" },
  { value: "education", label: "教育经历" },
  { value: "other", label: "项目 / 其他经历" },
];

export function FactEditor({ factBase, onChange, textStyles, onTextStylesChange, onPreviewTargetChange }: Props) {
  const [activeTab, setActiveTab] = useState<"experiences" | "profile">("experiences");
  const [viewMode, setViewMode] = useState<ViewMode>("zh");
  const [collapsedExps, setCollapsedExps] = useState<Record<string, boolean>>({});
  const [newExperienceType, setNewExperienceType] = useState<Experience["type"]>("work");
  const [avatarError, setAvatarError] = useState("");
  const factBaseRef = useRef(factBase);
  const onChangeRef = useRef(onChange);
  const avatarReadIdRef = useRef(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followCallbackRef = useRef(onPreviewTargetChange);
  const pendingFollowFrameRef = useRef<number | undefined>(undefined);

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
    // Typing takes over from scroll even when the browser kept the same input focused.
    if (pendingFollowFrameRef.current !== undefined) {
      cancelAnimationFrame(pendingFollowFrameRef.current);
      pendingFollowFrameRef.current = undefined;
    }
    emitPreviewTarget({ ...target, source: "focus" });
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

  useEffect(() => () => { avatarReadIdRef.current += 1; }, []);

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
      setAvatarError("请选择图片文件。");
      return;
    }
    const readId = ++avatarReadIdRef.current;
    setAvatarError("");
    const reader = new FileReader();
    reader.onload = () => {
      if (readId !== avatarReadIdRef.current) return;
      if (typeof reader.result !== "string") {
        setAvatarError("图片读取失败，请重新选择。");
        return;
      }
      const dataUrl = reader.result;
      updateProfile((profile) => ({ ...profile, avatarUrl: dataUrl }));
    };
    reader.onerror = () => {
      if (readId === avatarReadIdRef.current) setAvatarError("图片读取失败，请重新选择。");
    };
    reader.readAsDataURL(file);
  }, [updateProfile]);

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
      if (target instanceof HTMLElement && (target.closest("input, textarea, select") || target.isContentEditable)) return;
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

  const deleteExperience = (id: string) => {
    if (confirm("确定要删除这条经历及其所有事实要点吗？")) {
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
    <section onPointerDownCapture={followEditingTarget} onFocusCapture={followEditingTarget} onInputCapture={followEditingTarget} onChangeCapture={followEditingTarget} className="fact-editor flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-sm">
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
              <span>经历与成果</span>
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
              <span>个人信息</span>
            </button>
          </div>
        </div>

        {/* Bilingual / Locale Toggle */}
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-ink-muted)]">
          <Languages className="h-3.5 w-3.5 text-slate-400" />
          <span className="font-medium">编辑视图:</span>
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
              中英双语
            </button>
            <button
              type="button"
              onClick={() => setViewMode("zh")}
              className={`rounded px-2 py-1 font-medium transition ${
                viewMode === "zh"
                  ? "bg-slate-800 text-white"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              仅中文
            </button>
            <button
              type="button"
              onClick={() => setViewMode("en")}
              className={`rounded px-2 py-1 font-medium transition ${
                viewMode === "en"
                  ? "bg-slate-800 text-white"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              仅英文
            </button>
          </div>
        </div>
      </div>

      {/* Editor Content Area */}
      <div ref={scrollerRef} onScroll={followEditorScroll} className="min-h-0 flex-1 overflow-y-auto p-5 space-y-5">
        {activeTab === "profile" ? (
          /* ================= Profile Editor ================= */
          <div data-editor-anchor="profile" className="space-y-6 max-w-2xl mx-auto py-2">
            <div className="rounded-xl border border-[var(--color-line)] bg-white p-5 shadow-xs space-y-4">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 border-b border-slate-100 pb-3">
                <User className="h-4 w-4 text-[var(--color-accent)]" />
                基本个人信息
              </h3>

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
                      <span className="text-[10px] mt-1 font-medium">无头像</span>
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
                      <span>{factBase.profile.avatarUrl ? "更换照片" : "上传个人头像"}</span>
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
                        移除
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400">上传 JPG、PNG 或粘贴照片。在「排版设计」中选择是否展示；照片设置随简历保存。</p>
                  {avatarError && <p role="alert" className="text-xs text-rose-700">{avatarError}</p>}
                </div>
              </div>

              <div data-editor-anchor="profile:displayName" className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {(viewMode === "bilingual" || viewMode === "zh") && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      中文姓名
                    </label>
                    <TextFormattingField
                      label="中文姓名"
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
                      英文姓名 (English Name)
                    </label>
                    <TextFormattingField
                      label="英文姓名"
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
                      个人定位 / 一句话简介 (中文)
                    </label>
                    <TextFormattingField
                      label="中文个人定位"
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
                      placeholder="例如：高级工业软件研发工程师 · 工业 AI 落地实践者"
                    />
                  </div>
                )}

                {(viewMode === "bilingual" || viewMode === "en") && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Professional Headline (English)
                    </label>
                    <TextFormattingField
                      label="英文个人定位"
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
                    学历 (Education)
                  </label>
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
                    所在城市 (Location)
                  </label>
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
                    邮箱 (Email)
                  </label>
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
                    电话 (Phone)
                  </label>
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
                求职偏好与硬性红线 (SSOT)
              </h3>

              <div data-editor-anchor="profile:targetRoles" className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold text-slate-700">目标岗位</h4>
                  <button type="button" onClick={() => updateProfile((profile) => ({ ...profile, targetRoles: [...profile.targetRoles, { zh: "", en: "" }] }))} className="text-xs font-medium text-[var(--color-accent)]">+ 添加目标岗位</button>
                </div>
                {factBase.profile.targetRoles.map((role, index) => (
                  <div key={index} className="flex items-start gap-2 rounded-lg border border-slate-200 p-2">
                    <div className="grid flex-1 gap-2 sm:grid-cols-2">
                      {viewMode !== "en" && (
                        <div>
                          <label htmlFor={`target-role-zh-${index}`} className="mb-1 block text-[11px] text-slate-600">目标岗位（中文）</label>
                          <input id={`target-role-zh-${index}`} value={role.zh} placeholder="填写实际目标岗位" onChange={(event) => updateProfile((profile) => ({ ...profile, targetRoles: profile.targetRoles.map((item, itemIndex) => itemIndex === index ? { ...item, zh: event.target.value } : item) }))} className="w-full rounded border border-slate-200 px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]" />
                        </div>
                      )}
                      {viewMode !== "zh" && (
                        <div>
                          <label htmlFor={`target-role-en-${index}`} className="mb-1 block text-[11px] text-slate-600">Target role (English)</label>
                          <input id={`target-role-en-${index}`} value={role.en ?? ""} placeholder="Optional English role" onChange={(event) => updateProfile((profile) => ({ ...profile, targetRoles: profile.targetRoles.map((item, itemIndex) => itemIndex === index ? { ...item, en: event.target.value } : item) }))} className="w-full rounded border border-slate-200 px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]" />
                        </div>
                      )}
                    </div>
                    <button type="button" aria-label={`删除第 ${index + 1} 个目标岗位`} onClick={() => updateProfile((profile) => ({ ...profile, targetRoles: profile.targetRoles.filter((_, itemIndex) => itemIndex !== index) }))} className="rounded p-1 text-slate-400 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>

              <div data-editor-anchor="profile:traits" className="space-y-2 border-t border-slate-100 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold text-slate-700">核心优势与专长</h4>
                  <button type="button" onClick={() => updateProfile((profile) => ({ ...profile, traits: [...profile.traits, ""] }))} className="text-xs font-medium text-[var(--color-accent)]">+ 添加优势</button>
                </div>
                {factBase.profile.traits.map((trait, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <input aria-label={`第 ${index + 1} 条核心优势`} value={trait} placeholder="填写有经历或作品支持的优势" onChange={(event) => updateProfile((profile) => ({ ...profile, traits: profile.traits.map((item, itemIndex) => itemIndex === index ? event.target.value : item) }))} className="w-full rounded border border-slate-200 px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]" />
                    <button type="button" aria-label={`删除第 ${index + 1} 条核心优势`} onClick={() => updateProfile((profile) => ({ ...profile, traits: profile.traits.filter((_, itemIndex) => itemIndex !== index) }))} className="rounded p-1 text-slate-400 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
                <p className="text-[11px] text-slate-500">优势字段目前共用一份文字，不随编辑语言自动翻译。</p>
              </div>

              <div data-editor-anchor="profile:links" className="space-y-2 border-t border-slate-100 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-xs font-semibold text-slate-700">作品与个人链接</h4>
                  <button type="button" onClick={() => updateProfile((profile) => ({ ...profile, links: [...profile.links, { label: "", url: "" }] }))} className="text-xs font-medium text-[var(--color-accent)]">+ 添加链接</button>
                </div>
                {factBase.profile.links.map((link, index) => (
                  <div key={index} className="flex items-start gap-2 rounded-lg border border-slate-200 p-2">
                    <div className="grid flex-1 gap-2">
                      <input aria-label={`第 ${index + 1} 个链接名称`} value={link.label} placeholder="链接名称，如 GitHub / 作品集" onChange={(event) => updateProfile((profile) => ({ ...profile, links: profile.links.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) }))} className="w-full rounded border border-slate-200 px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]" />
                      <input type="url" aria-label={`第 ${index + 1} 个链接地址`} value={link.url} placeholder="https://" onChange={(event) => updateProfile((profile) => ({ ...profile, links: profile.links.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value.trim() } : item) }))} className="w-full rounded border border-slate-200 px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]" />
                    </div>
                    <button type="button" aria-label={`删除第 ${index + 1} 个链接`} onClick={() => updateProfile((profile) => ({ ...profile, links: profile.links.filter((_, itemIndex) => itemIndex !== index) }))} className="rounded p-1 text-slate-400 hover:text-rose-600"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>

              {/* Salary Range */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  期望薪资范围 (K / 月)
                </label>
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
                  <span className="text-slate-400">至</span>
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
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  求职红线约束（绝不妥协的原则）
                </label>
                <div className="flex flex-wrap gap-2">
                  {factBase.profile.constraints.map((c, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200/80 px-2.5 py-1 text-xs font-medium text-amber-900"
                    >
                      {c}
                      <button
                        type="button"
                        onClick={() =>
                          updateProfile((p) => ({
                            ...p,
                            constraints: p.constraints.filter((_, idx) => idx !== i),
                          }))
                        }
                        className="text-amber-500 hover:text-amber-800"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      const val = prompt("输入新的约束规则（例如：0出差、0Oncall）");
                      if (val?.trim()) {
                        updateProfile((p) => ({
                          ...p,
                          constraints: [...p.constraints, val.trim()],
                        }));
                      }
                    }}
                    className="rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  >
                    + 添加约束
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* ================= Experiences Editor ================= */
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                新增内容保持空白，补齐必填字段后保存。未核实的量化不会投影到最终简历。
              </p>
              <div className="flex items-center gap-2">
                <select aria-label="新增经历类型" value={newExperienceType} onChange={(event) => setNewExperienceType(event.target.value as Experience["type"])} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]">
                  {EXPERIENCE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              <button
                type="button"
                onClick={addExperience}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-[var(--color-accent-hover)] transition"
              >
                <Plus className="h-3.5 w-3.5" />
                新增经历
              </button>
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
                            {(viewMode === "en" ? exp.org.en || exp.org.zh : exp.org.zh || exp.org.en) || "机构 / 学校待填写"}
                          </span>
                          <span className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 uppercase">
                            {exp.type}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500">
                          {(viewMode === "en" ? exp.title.en || exp.title.zh : exp.title.zh || exp.title.en) || "职位 / 学位待填写"}
                          {exp.projectName?.zh ? ` · ${exp.projectName.zh}` : ""} (
                          {exp.start || "起始月份待填"} ~ {exp.end === null ? "至今" : exp.end || "结束月份待填"})
                        </p>
                      </div>
                    </button>

                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400">
                        {exp.claims.length} 条事实
                      </span>
                      <button
                        type="button"
                        onClick={() => deleteExperience(exp.id)}
                        className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition"
                        title="删除此经历"
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
                          <label htmlFor={`experience-type-${exp.id}`} className="mb-1 block text-[11px] font-semibold text-slate-600">经历类型</label>
                          <select id={`experience-type-${exp.id}`} value={exp.type} onChange={(event) => updateExperiences((experiences) => experiences.map((item) => item.id === exp.id ? { ...item, type: event.target.value as Experience["type"] } : item))} className="w-full rounded-md border border-[var(--color-line)] bg-white px-2.5 py-1 text-xs outline-none focus:border-[var(--color-accent)]">
                            {EXPERIENCE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                          </select>
                        </div>
                        {viewMode !== "en" && (
                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                            公司 / 机构 (中文)
                          </label>
                          <input
                            type="text"
                            value={exp.org.zh}
                            placeholder="填写实际机构 / 学校名称"
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
                            职位 / 角色 / 学位 (中文)
                          </label>
                          <input
                            type="text"
                            value={exp.title.zh}
                            placeholder="填写实际职位、角色或学位专业"
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
                            起始月份 (YYYY-MM)
                          </label>
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
                            placeholder="YYYY-MM，按实际经历填写"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                            结束月份 (YYYY-MM)
                          </label>
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
                            placeholder="填写结束月份，或勾选仍在进行"
                          />
                          <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-600">
                            <input type="checkbox" checked={exp.end === null} onChange={(event) => updateExperiences((experiences) => experiences.map((item) => item.id === exp.id ? { ...item, end: event.target.checked ? null : "" } : item))} />
                            仍在进行 / 就读至今
                          </label>
                        </div>

                        <div>
                          <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                            项目名称 (可选)
                          </label>
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
                          技术栈标签 (Tech Stack)
                        </label>
                        <div className="flex flex-wrap gap-1.5 items-center">
                          {exp.techStack.map((tech, idx) => (
                            <span
                              key={idx}
                              className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                            >
                              {tech}
                              <button
                                type="button"
                                onClick={() =>
                                  updateExperiences((exps) =>
                                    exps.map((it) =>
                                      it.id === exp.id
                                        ? {
                                            ...it,
                                            techStack: it.techStack.filter(
                                              (_, i) => i !== idx,
                                            ),
                                          }
                                        : it,
                                    ),
                                  )
                                }
                                className="text-slate-400 hover:text-rose-600"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          <button
                            type="button"
                            onClick={() => {
                              const t = prompt("输入技术栈名称 (例如：C#, React, Redis)");
                              if (t?.trim()) {
                                updateExperiences((exps) =>
                                  exps.map((it) =>
                                    it.id === exp.id
                                      ? {
                                          ...it,
                                          techStack: [...it.techStack, t.trim()],
                                        }
                                      : it,
                                  ),
                                );
                              }
                            }}
                            className="rounded border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-500 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                          >
                            + 标签
                          </button>
                        </div>
                      </div>

                      {/* Claims / Bullets Section */}
                      <div className="border-t border-slate-100 pt-3">
                        <div className="flex items-center justify-between mb-3">
                          <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                            成果与职责
                          </h4>
                          <button
                            type="button"
                            onClick={() => addClaim(exp.id)}
                            className="flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition shadow-2xs"
                          >
                            <Plus className="h-3 w-3" />
                            添加要点
                          </button>
                        </div>

                        <div className="space-y-3">
                          {exp.claims.map((claim, claimIndex) => (
                            <div
                              key={claim.id}
                              data-editor-anchor={`claim:${claim.id}`}
                              className="rounded-lg border border-slate-200/90 bg-slate-50/40 p-3 space-y-2.5 hover:border-slate-300 transition"
                            >
                              {/* Claim Header / Controls */}
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5">
                                  {/* Kind Selector */}
                                  <select
                                    value={claim.kind}
                                    onChange={(e) =>
                                      updateClaim(exp.id, claim.id, (c) => ({
                                        ...c,
                                        kind: e.target.value as FactClaim["kind"],
                                        // Missing values stay invalid in the page draft until supplied.
                                        metric:
                                          e.target.value === "metric" && !c.metric
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
                                    className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 outline-none"
                                  >
                                    <option value="action">行动 (Action)</option>
                                    <option value="metric">量化指标 (Metric)</option>
                                    <option value="note">备忘 (Note)</option>
                                    <option value="pitfall">防坑/避雷 (Pitfall)</option>
                                    <option value="interview">答辩考点 (Interview)</option>
                                  </select>

                                  {/* Metric Confirmed Switch */}
                                  {claim.kind === "metric" || claim.metric ? (
                                    <label className="flex items-center gap-1 text-xs font-medium cursor-pointer ml-2">
                                      <input
                                        type="checkbox"
                                        checked={claim.metric?.confirmed ?? false}
                                        disabled={!claim.metric || !Number.isFinite(claim.metric.value) || !claim.metric.unit.trim()}
                                        onChange={(e) =>
                                          updateClaim(exp.id, claim.id, (c) => c.metric && Number.isFinite(c.metric.value) && c.metric.unit.trim()
                                            ? { ...c, metric: { ...c.metric, confirmed: e.target.checked } }
                                            : c)
                                        }
                                        className="rounded text-[var(--color-accent)] focus:ring-0 cursor-pointer"
                                      />
                                      <span
                                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                          claim.metric?.confirmed
                                            ? "bg-emerald-100 text-emerald-800"
                                            : "bg-amber-100 text-amber-800"
                                        }`}
                                      >
                                        {claim.metric?.confirmed
                                          ? "✓ 已核实量化（将进入简历）"
                                          : "⚠ 待核实（简历将过滤此条）"}
                                      </span>
                                    </label>
                                  ) : null}
                                </div>

                                <button
                                  type="button"
                                  onClick={() => deleteClaim(exp.id, claim.id)}
                                  className="text-slate-400 hover:text-rose-600 p-1 rounded transition"
                                  title="删除此要点"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>

                              {/* Claim Text Area (Zh) */}
                              {(viewMode === "bilingual" || viewMode === "zh") && (
                                <div>
                                  <TextFormattingField
                                    label={`${exp.org.zh || "新经历"} · 中文要点 ${claimIndex + 1}`}
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
                                    placeholder="中文事实要点描述（尽量包含 STAR：动作、工具、对标结果）..."
                                  />
                                </div>
                              )}

                              {/* Claim Text Area (En) */}
                              {(viewMode === "bilingual" || viewMode === "en") && (
                                <div>
                                  <TextFormattingField
                                    label={`${exp.org.en || exp.org.zh || "新经历"} · 英文要点 ${claimIndex + 1}`}
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
                                        数值 (Value)
                                      </label>
                                      <input
                                        type="number"
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
                                        className="w-full rounded border border-slate-200 bg-white px-2 py-1 outline-none text-xs"
                                        placeholder="填写原始数值"
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-[10px] font-semibold text-slate-600 mb-0.5">
                                        单位 (Unit)
                                      </label>
                                      <input
                                        type="text"
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
                                        className="w-full rounded border border-slate-200 bg-white px-2 py-1 outline-none text-xs"
                                        placeholder="%, 台, ms"
                                      />
                                    </div>
                                    <div className="col-span-2">
                                      <label className="block text-[10px] font-semibold text-slate-600 mb-0.5">
                                        对比基线 (Baseline)
                                      </label>
                                      <input
                                        type="text"
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
                                        className="w-full rounded border border-slate-200 bg-white px-2 py-1 outline-none text-xs"
                                        placeholder="例如：优化前单次解析耗时 120ms"
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
