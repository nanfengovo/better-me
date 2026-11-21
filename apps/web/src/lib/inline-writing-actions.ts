import type { Locale } from "@better-me/core";

export type InlineWritingActionId = "sharpen_verb" | "metric_placeholder";

export interface BulletScaffold {
  id: string;
  zhLabel: string;
  enLabel: string;
  zhTemplate: string;
  enTemplate: string;
}

/**
 * Zero-fabrication bullet scaffolds inspired by cvfree.io & refit:
 * Every object, baseline, and metric uses explicit `[bracket]` placeholders so
 * structure is provided without ever inventing facts.
 */
export const BULLET_SCAFFOLDS: readonly BulletScaffold[] = [
  {
    id: "architecture",
    zhLabel: "架构 / 性能优化",
    enLabel: "Architecture & Perf",
    zhTemplate: "重构 [核心模块/链路]，采用 [关键方案]，将 [目标指标] 从 [基线X] 优化至 [结果Y]。",
    enTemplate: "Redesigned [core module] using [approach], improving [metric] from [baseline X] to [result Y].",
  },
  {
    id: "delivery",
    zhLabel: "端到端项目交付",
    enLabel: "End-to-End Delivery",
    zhTemplate: "主导 [系统/产品名称] 的架构设计与上线交付，支撑 [业务规模X]，解决 [核心痛点]。",
    enTemplate: "Led end-to-end delivery of [system/feature] supporting [scale X] to solve [core bottleneck].",
  },
  {
    id: "efficiency",
    zhLabel: "工程效率与质量",
    enLabel: "Engineering Velocity",
    zhTemplate: "建设 [自动化测试/发布流水线]，覆盖 [范围X]，将 [交付耗时/回滚率] 降低 [真实比例Y]。",
    enTemplate: "Built [CI/CD or test harness] covering [scope X], cutting [release time / regressions] by [verified Y].",
  },
  {
    id: "ai",
    zhLabel: "AI / 自动化落地",
    enLabel: "AI & Automation",
    zhTemplate: "落地 [Agent/RAG 工作流]，对接 [真实数据源/工具]，将 [人工处理步骤] 耗时由 [基线X] 缩短至 [结果Y]。",
    enTemplate: "Shipped [Agent/RAG workflow] integrated with [data/tools], cutting [manual workflow] from [baseline X] to [result Y].",
  },
];

const WEAK_ZH_REPLACEMENTS: Array<[RegExp, string]> = [
  [/^主要负责(?:了)?/, "主导设计与交付"],
  [/^负责日常/, "系统化建设并维护"],
  [/^负责(?:了)?/, "主导实现"],
  [/^深度参与(?:了)?/, "核心参与并交付"],
  [/^参与(?:了)?/, "独立实现"],
  [/^协助完成(?:了)?/, "协作交付"],
  [/^协助(?:了)?/, "协同实现"],
  [/^配合完成(?:了)?/, "协同交付"],
  [/^配合(?:了)?/, "协同实现"],
];

const WEAK_EN_REPLACEMENTS: Array<[RegExp, string]> = [
  [/^responsible for\s+/i, "Owned and delivered "],
  [/^helped (?:with|to)\s+/i, "Built and shipped "],
  [/^helped\s+/i, "Delivered "],
  [/^assisted (?:with|in)\s+/i, "Implemented "],
  [/^worked on\s+/i, "Designed and built "],
  [/^involved in\s+/i, "Contributed directly to "],
  [/^participated in\s+/i, "Delivered "],
];

/**
 * Deterministic, zero-LLM inline writing transformation on a selected substring.
 * Never fabricates numbers — missing metrics always use explicit `[X]` placeholders.
 */
export function applyInlineWritingAction(
  text: string,
  start: number,
  end: number,
  action: InlineWritingActionId,
  locale: Locale,
): { nextText: string; nextStart: number; nextEnd: number; changed: boolean } {
  const safeStart = Math.max(0, Math.min(start, text.length));
  const safeEnd = Math.max(safeStart, Math.min(end, text.length));
  const selected = text.slice(safeStart, safeEnd);
  if (!selected.trim()) {
    return { nextText: text, nextStart: safeStart, nextEnd: safeEnd, changed: false };
  }

  let replacement = selected;
  const isZh = /[\u4e00-\u9fa5]/.test(selected) || locale === "zh";

  if (action === "sharpen_verb") {
    const trimmedStart = selected.replace(/^\s+/, "");
    const leadingWs = selected.slice(0, selected.length - trimmedStart.length);
    let updated = trimmedStart;
    const rules = isZh ? WEAK_ZH_REPLACEMENTS : WEAK_EN_REPLACEMENTS;
    for (const [pattern, target] of rules) {
      if (pattern.test(updated)) {
        updated = updated.replace(pattern, target);
        break;
      }
    }
    if (updated === trimmedStart) {
      updated = isZh ? `主导实现${trimmedStart}` : `Built ${trimmedStart.charAt(0).toLowerCase()}${trimmedStart.slice(1)}`;
    }
    replacement = `${leadingWs}${updated}`;
  } else if (action === "metric_placeholder") {
    const clean = selected.replace(/[。.;；\s]+$/, "");
    const suffix = isZh
      ? "，将 [目标指标] 从 [基线X] 优化至 [结果Y]。"
      : ", improving [target metric] from [baseline X] to [result Y].";
    replacement = clean.includes("[基线X]") || clean.includes("[baseline X]") ? selected : `${clean}${suffix}`;
  }

  if (replacement === selected) {
    return { nextText: text, nextStart: safeStart, nextEnd: safeEnd, changed: false };
  }

  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return {
    nextText,
    nextStart: safeStart,
    nextEnd: safeStart + replacement.length,
    changed: true,
  };
}
