import type { ClaimIssue } from "@better-me/core";

export type IssueField = "confirmation" | "baseline" | "text-zh" | "text-en";

type IssueGuidance = {
  title: string;
  field: IssueField;
  description: string;
  steps: string[];
  example?: string;
};

const GUIDANCE: Record<ClaimIssue["code"], IssueGuidance> = {
  metric_unconfirmed: {
    title: "量化数字还没核实",
    field: "confirmation",
    description: "这条要点包含尚未由你确认的量化数据，因此暂不进入对外简历。模型提取或字段校验通过不能替代本人核实。",
    steps: [
      "对照原始记录或可核查材料，逐项检查正文中的数字、单位、统计时间和范围，确认属于这段经历及你的实际贡献。",
      "核对量化输入框与正文是否一致；有误时先修正，并检查基线或因果说明是否有依据。",
      "只有你已核实这些数据，才勾选“已核实”。暂时无法证实时保留未核实状态，不要为消除提醒随手确认。",
    ],
  },
  metric_missing_baseline: {
    title: "量化缺少比较依据或原因",
    field: "baseline",
    description: "数字本身不能说明成果来自哪里。请补充真实的比较基线，或说明你的具体动作如何带来这项变化。",
    steps: [
      "若有可核对的前后数据，在基线中写明原始状态、比较对象、统计时间和口径，避免把不同条件下的数字直接比较。",
      "若没有比较基线，但有明确因果依据，可在因果说明中写清实际问题、你采取的措施，以及可证明的结果。两者至少补充一项。",
      "没有依据时继续核对记录；不要编造原值、百分比或因果关系。只有确认真实的数据才勾选已核实。",
    ],
    example: "仅作填写结构，不能直接作为事实：[相同统计口径]下，由[真实原值]变为[真实现值]；通过[你实际采取的措施]带来[可核对的结果]。括号内容必须有真实依据。",
  },
  hollow_phrase: {
    title: "要点需要写得更具体",
    field: "text-zh",
    description: "规则发现了较笼统的措辞。这是修改线索，不代表经历不真实；请让读者看清你实际做了什么、交付了什么。",
    steps: [
      "先核对当前要点对应的真实场景、任务和你的职责范围，区分个人完成与团队共同成果。",
      "在对应语言的正文中写清具体动作、使用的方法，以及可核对的产出或变化，避免只写“参与项目”或“负责相关工作”。",
      "没有可靠数字也可以写具体交付物和工作范围，不必为了显得有成果而添加指标。若笼统措辞在英文中，也请同步核对对应英文正文。",
    ],
    example: "仅作表达结构，不能直接作为事实：在[真实场景]中，完成[你亲自实施的动作]，交付[可核对的产出]。只填写实际发生的内容。",
  },
  missing_locale_en: {
    title: "这条要点还没有英文",
    field: "text-en",
    description: "如需输出英文简历，请为同一条真实事实补充英文表达，保持职责范围、时间、数字和单位与原文一致。",
    steps: [
      "先确认中文要点准确，再在英文正文中翻译同一事实，不额外增加技术、职责、项目或成果。",
      "逐项核对人名、机构名、专业术语、数字和单位；没有确定英文名称时先核实，不猜写官方名称。",
      "如果目前只准备中文简历，可以稍后补充英文。这条提醒不意味着必须添加原文没有的内容。",
    ],
  },
};

const ENGLISH_GUIDANCE: Record<ClaimIssue["code"], IssueGuidance> = {
  metric_unconfirmed: {
    title: "Metric not yet verified",
    field: "confirmation",
    description: "This entry contains metrics you have not personally verified, so it is excluded from the resume. Model extraction or field validation cannot replace your own verification.",
    steps: [
      "Compare with original records or verifiable material. Check every number, unit, measurement period and scope, and confirm that they belong to this experience and your actual contribution.",
      "Check that the metric fields match the entry text. Correct any errors first, then check the evidence for the baseline or causal explanation.",
      "Select Verified only after you have checked the data yourself. If you cannot verify it yet, leave it unverified rather than confirming it just to dismiss the warning.",
    ],
  },
  metric_missing_baseline: {
    title: "Metric needs a baseline or explanation",
    field: "baseline",
    description: "A number alone does not explain the result. Add a real comparison baseline or explain how your specific actions produced this change.",
    steps: [
      "If you have verifiable before-and-after data, state the original situation, comparison, measurement period and method. Avoid comparing figures measured under different conditions.",
      "If no comparison baseline exists but you have evidence of causation, describe the actual problem, the actions you took and a verifiable result. Provide at least a baseline or a causal explanation.",
      "Keep checking the records when evidence is missing. Do not invent original values, percentages or causation. Mark metrics as verified only after checking that they are true.",
    ],
    example: "Structure only, not a fact to copy: Under [the same measurement method], [actual original value] changed to [actual current value]; [actions you actually took] produced [a verifiable result]. Every placeholder needs real supporting evidence.",
  },
  hollow_phrase: {
    title: "Make this entry more specific",
    field: "text-zh",
    description: "The rule detected general wording. This is an editing cue, not a verdict that the experience is untrue. Help the reader understand what you actually did and delivered.",
    steps: [
      "Check the real situation, task and scope of your responsibilities. Distinguish your own work from results achieved by the team.",
      "In the relevant language field, state the specific action, method and verifiable deliverable or change. Avoid relying on phrases such as participated in the project or responsible for related work.",
      "You can describe concrete deliverables and scope without reliable metrics. Do not add numbers just to make an achievement sound stronger. Check the English entry too if it contains the general wording.",
    ],
    example: "Structure only, not a fact to copy: In [a real situation], I completed [an action I personally took] and delivered [a verifiable output]. Include only what actually happened.",
  },
  missing_locale_en: {
    title: "English version missing",
    field: "text-en",
    description: "To produce an English resume, add an English version of the same true fact. Keep the responsibilities, time, numbers and units consistent with the original.",
    steps: [
      "Confirm that the Chinese entry is accurate, then translate the same fact into the English field. Do not add technologies, responsibilities, projects or results.",
      "Check names, organizations, technical terms, numbers and units individually. Verify uncertain English names instead of guessing an official name.",
      "If you are only preparing a Chinese resume for now, you can add English later. This warning does not require you to add anything absent from the original.",
    ],
  },
};

/** Localized UI copy only; issue codes, scan rules and user content are unchanged. */
export function getIssueGuidance(code: ClaimIssue["code"], locale: "zh" | "en" = "zh"): IssueGuidance {
  return locale === "en" ? ENGLISH_GUIDANCE[code] : GUIDANCE[code];
}
