import type { LearningPath } from "@better-me/agent-contracts";

export const LEARNING_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const learningQuestions = {
  "receipt-present-v1": {
    prompt:
      "已有工具的成功回执和完整结果。窗口关闭后重新打开，你的 Agent 应做什么？保存原答和解释，并实现 decide(input)：首次通过唯一 lookup 取所选段落，有 checkpoint 时返回带原答及引用哈希的 finish。",
    hint: "成功回执可复用，不重新执行。首次返回 {kind:'lookup',noteId:input.sourceId}；有 checkpoint 时返回 finish，并引用 checkpoint.noteId / resultHash。",
  },
  "receipt-missing-v1": {
    prompt:
      "新情境：外部请求可能已执行，但成功回执在断网时丢失。没有回执是否等于执行失败？先独立作答并实现 decide(input)。验证输入 delivery 为 confirmed 或 unknown，携带原 operationId；允许输出 lookup、finish 或 {kind:'reconcile',operationId}。恢复也必须保持这个决定。",
    hint: "缺回执不是失败证明。unknown 时先按原 operationId 对账；不得直接重试。confirmed 且有 checkpoint 时使用原结果。lookup 仅用于首次读取本次选段，不可访问整库。",
  },
  "receipt-transfer-v1": {
    prompt:
      "迁移情境：你正在处理一笔全新的操作。上次练习的成功回执属于旧操作，不可作为这笔新操作已完成的证据。新操作的回执暂时丢失，输入提供当前 operationId 和 delivery。请保存自己的决定、解释和代码；对账必须针对本次输入编号，不能写死旧题编号，不能直接重试。confirmed 时仍复用本次 checkpoint。",
    hint: "把回执与当前操作身份一起核对。unknown 时返回 {kind:'reconcile',operationId:input.operationId}，不要复用或写死旧编号。已确认时使用本次 checkpoint。首次读取资料仍只允许当前选段。",
  },
} as const;
export function pathPresentation(
  path: LearningPath,
  time: number,
): Pick<LearningPath, "stage" | "next"> {
  if (path.sourceRevoked)
    return {
      stage: "source_revoked",
      next: {
        title: "所选资料使用权限已撤回",
        reason: "原尝试保留，正文不再检索、朗读或发送；不会自动换资料或重做。",
        minutes: 0,
      },
    };
  if (
    path.pendingCommand ||
    path.attempts.at(-1)?.task?.practice.phase === "outcome_unknown"
  )
    return {
      stage: "outcome_unknown",
      next: {
        title: "先核对上次结果",
        reason: "有已派送但回执未确认的动作，重新打开不会重新执行。",
        minutes: 0,
      },
    };
  if (path.project)
    return {
      stage: "completed",
      next: {
        title: "学习项目已由本人验收",
        reason: "保留代码、运行说明与贡献边界，不自动生成简历或生产经历。",
        minutes: 0,
      },
    };
  if (!path.citation)
    return {
      stage: "choose_source",
      next: {
        title: "选择一个有出处的段落",
        reason: "练习只会读取你明确选择的不可变版本与片段。",
        minutes: 5,
      },
    };
  const current = path.attempts.at(-1);
  if (
    current &&
    (!current.task ||
      ["ready", "lookup_saved"].includes(current.task.practice.phase))
  )
    return {
      stage:
        current.task?.practice.phase === "lookup_saved"
          ? "checkpoint_saved"
          : "practice",
      next: {
        title:
          current.task?.practice.phase === "lookup_saved"
            ? "从保存的断点继续检查"
            : "完成当前题的原答与代码",
        reason: "原答先保存，工具执行需要另一次明确点击；恢复不自动继续。",
        minutes: 10,
      },
    };
  const plan = path.plans.at(-1)!;
  if (path.reviews.at(-1)?.status === "accepted" && plan.nextStep === "project")
    return {
      stage: "project",
      next: {
        title: "提交一份可复核的学习项目",
        reason:
          "已采纳进入项目的建议；补齐运行说明、样例、限制和本人/工具贡献。历史失败仍保留。",
        minutes: 15,
      },
    };
  if (path.attempts.length >= 2)
    return {
      stage: "review",
      next: {
        title:
          plan.nextStep === "supplement" &&
          path.reviews.at(-1)?.status === "accepted" &&
          path.reviews.at(-1)?.evidenceAttemptIds.at(-1) === current?.id
            ? "按已采纳计划补练"
            : "对照原答与检查做周复盘",
        reason:
          "通过和失败都保留，建议不会自动修改计划。解释正文仍需本人审阅，不冒充语义评分。",
        minutes: 10,
      },
    };
  if (path.dueAt) {
    const due = time >= Date.parse(path.dueAt);
    return {
      stage: due ? "retest_due" : "pending_retest",
      next: {
        title: due ? "做一道没有见过的换题复测" : "等待隔时复测",
        reason: due
          ? "首次程序检查已结束；现在用回执丢失的新情境检验独立决定。"
          : "一次通过不代表长期掌握。到期后才开放新题，不自动创建或执行。",
        minutes: due ? 10 : 0,
      },
    };
  }
  return {
    stage: "practice",
    next: {
      title: "开始第一道有据练习",
      reason: "先学习已选段落，再保存自己的原答、代码和提示使用记录。",
      minutes: 10,
    },
  };
}
