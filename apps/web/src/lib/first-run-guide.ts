export const FIRST_RUN_GUIDE_KEY = "betterme:onboarding:v1";
export type GuideStorage = Pick<Storage, "getItem" | "setItem">;
export function shouldShowGuide(storage: Pick<Storage, "getItem">): boolean {
  try {
    const saved = JSON.parse(storage.getItem(FIRST_RUN_GUIDE_KEY) ?? "null");
    return saved?.version !== 1 || !["completed", "skipped"].includes(saved.state);
  } catch { return true; }
}
export function rememberGuide(storage: GuideStorage, state: "completed" | "skipped"): boolean {
  try { storage.setItem(FIRST_RUN_GUIDE_KEY, JSON.stringify({ version: 1, state })); return true; }
  catch { return false; }
}
export type GuideRect = { x: number; y: number; width: number; height: number };
/** Never position the guide outside the visual viewport; missing targets get a centered explanation. */
export function placeGuide(target: GuideRect | null, viewport: { width: number; height: number }, panel: { width: number; height: number }) {
  const margin = 16, gap = 24;
  const width = Math.min(panel.width, Math.max(0, viewport.width - margin * 2));
  const height = Math.min(panel.height, Math.max(0, viewport.height - margin * 2));
  const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, max - margin));
  if (!target) return { x: (viewport.width - width) / 2, y: (viewport.height - height) / 2 };
  if (viewport.width < 700) return { x: margin, y: Math.max(margin, viewport.height - height - margin) };
  if (target.x + target.width + gap + width <= viewport.width - margin) return { x: target.x + target.width + gap, y: clamp(target.y, viewport.height - height) };
  if (target.x - gap - width >= margin) return { x: target.x - gap - width, y: clamp(target.y, viewport.height - height) };
  if (target.y + target.height + gap + height <= viewport.height - margin) return { x: clamp(target.x, viewport.width - width), y: target.y + target.height + gap };
  return { x: clamp(target.x, viewport.width - width), y: clamp(target.y - height - gap, viewport.height - height) };
}

export const GUIDE_STEPS = [
  { id: "welcome", target: null, label: ["欢迎", "Welcome"], title: ["下一段精彩，从这里开始。", "Your next chapter starts here."], description: ["用一场小小的探索，认识你的简历与求职工作台。无需配置模型，也不用先准备一份完美简历。", "A short tour of your resume and career workspace. No model setup or perfect first draft required."], hint: ["约 1 分钟 · 随时跳过 · 不修改简历", "About a minute · Skip anytime · No resume changes"] },
  { id: "editor", target: '[data-onboarding="editor"]', label: ["真实经历", "Your experience"], title: ["先把做过的事情写下来。", "Start with what you actually did."], description: ["在这里整理工作、项目与教育经历。先写场景、你的行动和结果；不知道的数据可以留空，不必为了好看编一个数字。", "Organize work, projects and education here. Describe the context, your actions and results. Leave unknown numbers blank."], hint: ["这些是共享事实；多份简历可以选择不同呈现。", "These are shared facts; each resume can present them differently."] },
  { id: "writing", target: '.writing-toolbar', label: ["主动伴写", "Writing copilot"], title: ["写成流水账时，Agent 会留意到。", "A little help beyond a list of duties."], description: ["停笔后，本地伴写会提醒缺少上下文、空泛表达和待核实数字。点击批注，一步步补充；模型追问需要配置与同意，改写先对照再采用。", "Local checks flag missing context, vague wording and unsupported numbers. Open a note to add detail. Model questions require setup and consent; rewrites need your review."], hint: ["提醒可以暂停。Agent 不会擅自修改事实。", "Pause reminders anytime. The Agent never silently changes facts."] },
  { id: "preview", target: '.preview-toolbar', label: ["预览与导出", "Preview & export"], title: ["内容不动，换一种漂亮的呈现。", "A new look, the same true story."], description: ["实时预览会跟随你的编辑。选择模板、调整缩放，再导出 PDF、DOCX 或 Markdown。版式可以变化，事实不会因换模板而重写。", "The live preview follows your edits. Pick a template, adjust the view, then export PDF, DOCX or Markdown. Switching templates does not rewrite facts."], hint: ["长简历导出前，记得检查实际分页。", "Check page breaks before exporting a long resume."] },
  { id: "save", target: '[data-onboarding="save"]', label: ["草稿保护", "Draft protection"], title: ["大胆打磨，也留好退路。", "Make progress with a way back."], description: ["自动保存、草稿保护和历史版本各司其职。重要修改前可创建版本；跨浏览器或更换地址前，请下载 JSON 备份。", "Autosave, protected drafts and version history work together. Keep versions for important edits and export JSON before changing browser or address."], hint: ["简历保存在当前浏览器，不等于云端同步。", "Resumes live in this browser, not in a cloud account."] },
  { id: "ai", target: '.agent-top-bar-btn-group', label: ["你的 Agent", "Your Agent"], title: ["一个侧栏，继续同一段协作。", "One sidebar, one continuing collaboration."], description: ["点击「AI Agent 助手」打开唯一侧栏：伴写对话、共识与进度、模型与工具各有位置。先对齐项目含义，再认领本人贡献；收起或切页不会停止进行中的任务。", "Open AI Agent for writing, shared understanding, progress and tools in one sidebar. Align project meaning before claiming contributions. Hiding it or changing pages does not stop running tasks."], hint: ["侧栏问号可打开逐步练习；本次引导不调用模型或消耗额度。", "Use the sidebar help button for hands-on lessons. This tour makes no model calls or paid requests."] },
  { id: "atlas", target: '[data-onboarding="atlas"]', label: ["探索机会", "Explore opportunities"], title: ["让下一步，有迹可循。", "Give your next move some direction."], description: ["在岗位地图查看来源、职位与有证据的位置。无精确地址的岗位仍留在列表；采集需要你发起，登录和验证码由你完成。", "Explore job sources and evidence-backed locations in the atlas. Jobs without precise addresses stay in the list. Collection is explicit; sign-in and verification stay under your control."], hint: ["地图、顾问与机会区，都可以从侧栏进入。", "Find the atlas, Agent and applications in the sidebar."] },
  { id: "finish", target: null, label: ["准备就绪", "Ready"], title: ["现在，轮到你的故事了。", "Now make it your story."], description: ["从一条真实经历开始，不必一次写得完美。顶部头像「工作台设置 → 新手引导」可重播；Agent 侧栏问号能继续上次的协作教程，并定位真实入口。", "Start with one real experience. Replay from Workspace settings → Workspace tour. The Agent sidebar help button resumes your last lesson and locates real controls."], hint: ["不改变你的自动保存设置，不保存、替换或清空简历。", "Your autosave preference stays unchanged. This tour never saves, replaces or clears your resume."] },
] as const;
