/** Editorial guidance, not applicant evidence. Public sources and reading notes:
 * docs/research/resume-writing-exemplars-2026-11-10.md. Never put sample CVs
 * or user-specific facts into the model's system message. */
export function resumeWritingMethod(scope: "review" | "tailor" | "headline" | "claim"): string {
  const contribution = "一条贡献只讲一件事：交付对象 → 本人动作或机制 → 有依据的结果。无统计也可写可观察的行为；若只知道目的，就写目的，不宣称效果。写改善幅度须有基线、范围和来源。技术名跟着实际交付物走；团队做过、本人参与、独立负责、原型验证、生产使用不可互换。";
  const evidence = "范例只教结构，不是候选人事实。项目、JD 或技术清单不能单独证明本人贡献。缺依据时先问一个会改变写法的问题（如输入与输出是什么、哪一步由本人做、怎样验收）；没看到不等于没做过。";
  switch (scope) {
    case "review":
      return `【仅用于简历审阅】先问这份简历要让读者记住哪个岗位方向。全稿可见时，有相关工作经验优先展示最近且对口的交付；学生或转行者可先放最相关的教育或项目。标题定方向，短概述不重复技能表；“全栈”“AI”等定位回指具体项目。看不到全稿或成品 PDF 时，不断言教育缺失、页数或实际分页。\n${contribution}\n${evidence}`;
    case "tailor":
      return `【岗位定制】从 JD 原句找已有依据，优先重排或精简最相关的贡献，不用 JD 关键词填补未知；不改未授权字段。\n${contribution}\n${evidence}`;
    case "headline":
      return `【简介写法】用短概述串起目标方向和已确认的代表性交付；不把标题或技能表再写一遍。只看到了当前字段，不推算年限、不替整份简历重排、不宣称某经历不存在。\n${evidence}`;
    case "claim":
      return `【经历写法】保留原责任边界；把职责清单收束成一个具体动作。不要为删掉“参与”而把协作写成独立完成。\n${contribution}\n${evidence}`;
  }
}
