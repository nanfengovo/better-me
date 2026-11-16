import { inventoryTargets, type InventorySession } from "@better-me/agent-contracts";
export const topics:Record<string,string>={baseline:"底稿时效",current:"近况",new:"新增材料",style:"做事和协作方式",like:"喜欢的工作",atmosphere:"喜欢的团队氛围",avoid:"不喜欢的工作或氛围",redline:"不可接受的条件",intent:"未来方向"};
const questions:Record<string,string>={
  baseline:"这份底稿的内容大约写到什么时候？记不清也没关系。",
  current:"从那之后到现在，你在做什么？哪件变化最值得先说？",
  new:"有没有旧稿里没有的工作、独立作品或学习项目？先说一件。",
  style:"回想一次配合顺畅的合作，你喜欢用什么方式做事？",
  like:"上一段经历里，哪件事你愿意在下一份工作里做得更多？",
  atmosphere:"什么样的团队相处方式或管理方式，让你愿意长期留下？",
  avoid:"哪类事情或团队氛围，即使你能应付，也不想再把它当日常？",
  redline:"哪些条件是你明确不会接受的？有例外也请一起说。",
  intent:"一到三年后，你最想多承担哪一类工作？还没决定也可以。",
};
export const choiceLabels={feature:"重点展开",compress:"压缩",omit:"不选",pending:"待补"};
export function interviewStep(s:InventorySession) {
  const targets=inventoryTargets(s.source), target=targets[s.cursor], group=s.source.groups.find(g=>g.id===target);
  const stage=target==="baseline"||target==="current" ? 1 : target==="new"||group ? 2 : 3;
  const prompt=group ? group.kind==="unparsed" ? "这段未归位的文字是什么材料？如果不重要，可以跳过。" :
    group.kind==="link" ? "这个链接指向什么作品？哪个部分是你自己做的？" :
    group.kind==="education" ? "这段教育经历中，有哪个项目或研究值得保留？" :
    "在这段经历里，哪件事最能说明你亲自做了什么？" :
    target==="current" && s.previousAt ? "从上一次盘点到现在，工作、项目或求职方向有哪些变化？" : questions[target??""]??"";
  return {target,group,stage,prompt,heading:group?.label??topics[target??""]??"",total:targets.length};
}
