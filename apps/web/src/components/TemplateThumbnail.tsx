/** @jsxRuntime automatic */
import { memo, useLayoutEffect, useRef } from "react";
import type { ProjectedResume } from "@better-me/core";
import type { UiLocale } from "../lib/ui-preferences";
import { ResumeTemplate, type ResumeTemplateId } from "./ResumeTemplate";
import { getResumeTemplate } from "./template-catalog";

// Deliberately synthetic catalogue content. Never derive thumbnails from a
// user's FactBase, stored resume, imported document or career memory.
const CATALOGUE_RESUMES: Record<UiLocale, ProjectedResume> = {
  zh: {
    locale: "zh", templateId: "zh-classic",
    profile: {
      displayName: "林 予", headline: "产品工程师 / 把想法变成好用的产品",
      location: "上海", email: "alex@example.com", links: [],
      targetRoles: ["产品工程师", "前端开发"], traits: ["系统化思考", "体验设计", "跨团队协作"],
    },
    skills: ["TypeScript", "React", "Node.js", "Design Systems", "SQL"],
    experiences: [
      {
        id: "catalogue-work-one", type: "work", org: "山海科技（示例）", title: "产品工程师", start: "2023.03", end: null,
        techStack: ["React", "TypeScript", "Node.js"], claims: [
          { id: "catalogue-claim-one", kind: "action", text: "负责协作工作台的体验与前端开发，让复杂流程以清晰、自然的方式呈现。", tags: [] },
          { id: "catalogue-claim-two", kind: "action", text: "与设计、产品和研发共同建立组件规范，保持不同业务场景的一致体验。", tags: [] },
          { id: "catalogue-claim-three", kind: "action", text: "梳理真实用户反馈，持续打磨关键路径中的交互细节与可访问性。", tags: [] },
        ],
      },
      {
        id: "catalogue-work-two", type: "work", org: "拾光工作室（示例）", title: "前端开发工程师", start: "2021.07", end: "2023.02",
        techStack: ["JavaScript", "CSS", "REST API"], claims: [
          { id: "catalogue-claim-four", kind: "action", text: "参与内容管理工具建设，完成从页面原型到稳定交付的完整开发流程。", tags: [] },
          { id: "catalogue-claim-five", kind: "action", text: "完善响应式布局、表单反馈与数据展示，让工具在不同设备上都便于使用。", tags: [] },
        ],
      },
      {
        id: "catalogue-project", type: "opensource", org: "留白 · 开源阅读工具", title: "独立设计与开发", start: "2024.01", end: "2024.06",
        techStack: ["React", "IndexedDB"], claims: [
          { id: "catalogue-claim-six", kind: "action", text: "设计一款本地优先的阅读与标注工具，专注内容组织和舒适的阅读体验。", tags: [] },
          { id: "catalogue-claim-seven", kind: "action", text: "提供键盘导航、主题切换和离线保存，记录每一次细小而有意义的改进。", tags: [] },
        ],
      },
      { id: "catalogue-education", type: "education", org: "示例大学", title: "计算机科学与技术 · 本科", start: "2017.09", end: "2021.06", techStack: [], claims: [] },
    ],
  },
  en: {
    locale: "en", templateId: "zh-classic",
    profile: {
      displayName: "Alex Lin", headline: "Product Engineer / Thoughtful digital experiences",
      location: "Shanghai", email: "alex@example.com", links: [],
      targetRoles: ["Product Engineer", "Frontend Developer"], traits: ["Systems thinking", "Interaction design", "Collaboration"],
    },
    skills: ["TypeScript", "React", "Node.js", "Design Systems", "SQL"],
    experiences: [
      {
        id: "catalogue-work-one", type: "work", org: "Mountain & Sea (Sample)", title: "Product Engineer", start: "2023.03", end: null,
        techStack: ["React", "TypeScript", "Node.js"], claims: [
          { id: "catalogue-claim-one", kind: "action", text: "Built a collaborative workspace, translating complex workflows into clear and natural interactions.", tags: [] },
          { id: "catalogue-claim-two", kind: "action", text: "Partnered with design and product teams to establish a shared component system across the product.", tags: [] },
          { id: "catalogue-claim-three", kind: "action", text: "Refined core journeys through user feedback, with particular care for accessibility and interaction detail.", tags: [] },
        ],
      },
      {
        id: "catalogue-work-two", type: "work", org: "Daylight Studio (Sample)", title: "Frontend Developer", start: "2021.07", end: "2023.02",
        techStack: ["JavaScript", "CSS", "REST API"], claims: [
          { id: "catalogue-claim-four", kind: "action", text: "Delivered content tools from early prototypes through implementation and release.", tags: [] },
          { id: "catalogue-claim-five", kind: "action", text: "Improved responsive layouts, form feedback and information design across devices.", tags: [] },
        ],
      },
      {
        id: "catalogue-project", type: "opensource", org: "Margin / Open-source reading tool", title: "Designer & Developer", start: "2024.01", end: "2024.06",
        techStack: ["React", "IndexedDB"], claims: [
          { id: "catalogue-claim-six", kind: "action", text: "Designed a local-first reader and annotation tool around a focused, comfortable reading experience.", tags: [] },
          { id: "catalogue-claim-seven", kind: "action", text: "Added keyboard navigation, themes and offline persistence, refining the experience with each release.", tags: [] },
        ],
      },
      { id: "catalogue-education", type: "education", org: "Example University", title: "BSc, Computer Science", start: "2017.09", end: "2021.06", techStack: [], claims: [] },
    ],
  },
};

/** The actual paper renderer at A4 size, scaled into a noninteractive viewport. */
export const TemplateThumbnail = memo(function TemplateThumbnail({ id, locale }: { id: ResumeTemplateId; locale: UiLocale }) {
  const viewport = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const resize = () => {
      const width = node.getBoundingClientRect().width;
      if (width > 0) node.style.setProperty("--thumbnail-scale", String(width / (210 * 96 / 25.4)));
    };
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return <span className="template-thumbnail" ref={viewport} aria-hidden="true" inert>
    <span className="template-thumbnail-sheet"><ResumeTemplate resume={{ ...CATALOGUE_RESUMES[locale], layout: { ...CATALOGUE_RESUMES[locale].layout, ...getResumeTemplate(id).recommended } }} templateId={id} showAvatar={false} decorative /></span>
  </span>;
});
