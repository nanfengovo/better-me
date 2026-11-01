/** Tutorial state contains lesson IDs only, never a resume, answer, grant or model preference. */
export const AGENT_LESSONS = [
  { id: "evidence", label: "资料授权", title: "授权资料，不等于认领贡献", destination: "writing", action: "在界面中找到授权入口",
    steps: ["从一条经历打开「先对齐项目理解」", "展开资料范围，选择必要的文件或目录", "核对范围后再授权只读；需要时可撤销"],
    result: "Agent 只在你允许的范围取证；是否由你完成，之后另行确认。", caution: "只读不等于不出网。不要授权凭据或未经允许的客户材料。",
    prompt: "示例项目有说明文件和凭据文件。先给哪份资料？", choices: ["只读示例项目说明", "把整个磁盘都交给 Agent"], correct: 0, feedback: "范围应从必要资料开始；真实授权仍由你在正式入口单独确认。",
    targets: ["permissions", "understanding-start", "writing-check"], instruction: "展开「资料范围」；若还没进入项目理解，先点击「先对齐项目理解」。", prerequisite: "先回到简历页，点击「检查当前简历」，再选择一条经历。" },
  { id: "dialogue", label: "动态对话", title: "问题随你的回答变化", destination: "writing", action: "找到补充与纠正入口",
    steps: ["先看 Agent 对术语和流程的理解", "选择符合事实的选项，或自由纠正", "核对本轮资料与运行方式，再决定是否发送"],
    result: "双方先把话说清楚，没有固定轮数，也不要求你接受现成选项。", caution: "教程不发送回答。正式对话每轮仍需你同意。",
    prompt: "如果选项都不符合你们项目的含义，怎么办？", choices: ["选最接近、最漂亮的一项", "都不符合，我自己说明"], correct: 1, feedback: "可以纠正术语、补充边界，也可以说不知道。不要让最初的误解继续传递。",
    targets: ["understanding-answer", "understanding-start"], instruction: "在「补充或纠正理解」中说自己的意思；没有合适选项也可以自由填写。", prerequisite: "先从当前经历进入「先对齐项目理解」，这里才会出现对话输入框。" },
  { id: "consensus", label: "核对共识", title: "确认共同语言，不确认个人功劳", destination: "writing", action: "找到理解卡片",
    steps: ["逐项核对术语、流程与项目边界", "纠正仍不准确的部分，不必急着确认", "理解一致后，明确确认当前版本"],
    result: "保存一版经你确认的项目理解，之后再讨论本人动作。", caution: "原文或材料变化后要重新确认。项目具备某能力，不代表你实现过。",
    prompt: "示例：源码里有车辆路径规划，就能写成我的成果吗？", choices: ["能，代码里有就算我做的", "不能，还要核对我的职责与实际动作"], correct: 1, feedback: "理解项目与认领贡献是两道独立确认；不确定的地方继续追问。",
    targets: ["understanding-summary", "understanding-answer", "understanding-start"], instruction: "先查看理解卡片。只有术语和边界准确时才确认；不准确就回到输入框纠正。", prerequisite: "需要先完成至少一轮项目理解；教程不会为了展示自动发送请求。" },
  { id: "contribution", label: "认领贡献", title: "把项目理解变成你的贡献", destination: "writing", action: "找到贡献线索",
    steps: ["确认理解后展开贡献线索", "区分实际实现、仅设计和非本人完成", "补充本人动作、职责与使用阶段，再带入伴写"],
    result: "得到来自你本人认领的贡献补充，而不是把整个项目当个人功劳。", caution: "客户名可留空，私有备注不会因为练习或定位而发送。",
    prompt: "示例：你只提出了方案，代码由另一团队实现。怎么认领？", choices: ["我独立实现并上线", "仅设计方案，说明团队分工"], correct: 1, feedback: "设计也有价值，准确说清方案与分工，比放大职责更能经得起面试追问。",
    targets: ["contribution-review", "understanding-summary", "understanding-start"], instruction: "在贡献线索中选择真实的参与方式。带入伴写只追加补充，不立即修改简历。", prerequisite: "需先确认项目理解，并由 Agent 生成贡献线索；未生成时可以继续对话说明个人职责。" },
  { id: "annotation", label: "旁批候选", title: "原文、旁批、候选一起核对", destination: "writing", action: "找到当前旁批",
    steps: ["点击旁批的来源，定位对应原文", "补充本人动作，再核对候选及引用依据", "逐字确认后仅采用这一条，需要时撤销"],
    result: "从一条原文到一条可核对表达，保留来源高亮、虚线和撤销。", caution: "窄屏用来源定位代替跨栏连线；教程示例不会写入真实简历。",
    prompt: "试着打开一个候选，再把示例恢复为原文。", choices: ["查看示例候选"], correct: 0, feedback: "这里仅改变示例。真实候选需要你核对，采用只影响对应字段。",
    targets: ["writing-answer", "writing-note", "writing-check"], instruction: "打开一条旁批，点击顶部来源定位原文；「一起完善」展开补充与候选。", prerequisite: "当前还没有旁批。回到简历页点击「检查当前简历」，再选一条需要完善的经历。" },
  { id: "memory", label: "历史与备份", title: "收起继续，重载先核对", destination: "memory", action: "找到备份与历史",
    steps: ["在共识与进度回看任务、共识和对话", "展开备份入口，下载并另存记录", "恢复前先看预览；旧授权和任务不会重新执行"],
    result: "记录有可见的去处，收起不丢草稿；备份可追加为只读档案。", caution: "浏览器、Agent Host 与 Docker 卷分别保存；JSON 不包含未发送草稿和凭据。",
    prompt: "换浏览器前，只复制网址够吗？", choices: ["够，登录后会自动云同步", "先分别备份浏览器记录和服务数据"], correct: 1, feedback: "端口、地址和浏览器可能对应不同存储；恢复追加档案，不覆盖当前内容。",
    targets: ["agent-backup"], instruction: "展开「记忆保存、备份与恢复」。先下载记录，迁移时先预览再追加。", prerequisite: "请先打开「共识与进度」；如果记录还在加载，稍后重新定位。" },
  { id: "tools", label: "模型与工具", title: "分别选择推理模型与阅读工具", destination: "settings", action: "找到模型与阅读工具",
    steps: ["明确选择推理来源与模型", "单独查看受控阅读工具的兼容性", "核对本轮授权；失败时由你决定下一步"],
    result: "知道谁负责推理、谁读取资料，以及不可用的真实原因。", caution: "发现安装不等于兼容；不会自动登录、运行或改用付费 API。",
    prompt: "示例：账号额度不足，Agent 应该怎么处理？", choices: ["停止并提示，由我决定", "偷偷改用另一个付费 API"], correct: 0, feedback: "模型和工具的变更必须明确。选择本身不等于执行，任务运行中也不能偷偷换工具。",
    targets: ["agent-reader"], instruction: "查看「项目阅读运行方式」和兼容性；推理模型在上方单独选择。定位不会替你更改选择。", prerequisite: "先打开「模型与工具」，等待能力检查；不会为了教学安装或执行 CLI。" },
  { id: "recovery", label: "超时恢复", title: "没响应时，不猜测进度", destination: "memory", action: "找到真实任务状态",
    steps: ["先看状态、已等待时间和最近事件", "超时时先刷新状态，确认上一轮是否完成", "保留输入，再决定继续或停止；存储异常先备份"],
    result: "区分正在等待、结果不确定和明确失败，避免重复发送与额外计费。", caution: "没有新事件不等于失败；刷新状态与重新发送是两种不同操作。",
    prompt: "示例：请求超时，但不知道后台有没有完成。第一步做什么？", choices: ["连续点击重新发送", "先核对状态，保留输入"], correct: 1, feedback: "先确认上一轮结果，再手动决定是否重试。重连本地保存不应重发模型请求。",
    targets: ["agent-tasks"], instruction: "打开「任务」，查看状态后回到来源刷新。不要把刷新状态当成重新发送。", prerequisite: "请打开「共识与进度 → 任务」。还没发起任务时，空状态是正常的。" },
] as const;
export type AgentLesson = typeof AGENT_LESSONS[number]["id"];
/** Describe the actual anchor found, not a generic empty-state for a later step. */
export function tutorialInstruction(id: AgentLesson, anchor: string): string {
  const lesson = AGENT_LESSONS.find(item => item.id === id)!;
  if (!anchor) return lesson.prerequisite;
  if (anchor === lesson.targets[0]) return lesson.instruction;
  if (anchor === "understanding-start") return "已找到当前经历的项目理解入口。先点击「先对齐项目理解」，再继续本节；不会自动发送请求。";
  if (anchor === "writing-note") return "已找到当前旁批。点击「一起完善这条经历」展开本人补充，再核对候选和来源；这里只定位，不替你采用。";
  if (anchor === "understanding-answer") return "理解卡片尚未就绪。可以在输入框补充术语和边界，由你决定是否发送；生成后再核对确认。";
  if (anchor === "understanding-summary") return "已找到项目理解卡片。先核对当前版本，再确认共识并继续讨论本人职责；贡献线索出现后再认领。";
  return "先点击「检查当前简历」，再选择需要完善的经历；本节不会自动检查或发送。";
}
export type TutorialProgress = { version: 1; current: AgentLesson; viewed: AgentLesson[]; practiced: AgentLesson[] };
export const tutorialKey = (workspace: string) => `betterme.agent-tutorial.v1:${workspace}`;
const valid = (value: unknown): value is AgentLesson => typeof value === "string" && AGENT_LESSONS.some(item => item.id === value);
export function tutorialStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
export function readTutorial(storage: Pick<Storage, "getItem"> | null, key: string): TutorialProgress {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? "null");
    if (value?.version === 1 && valid(value.current)) return { version: 1, current: value.current,
      viewed: Array.isArray(value.viewed) ? [...new Set<AgentLesson>(value.viewed.filter(valid))] : [],
      practiced: Array.isArray(value.practiced) ? [...new Set<AgentLesson>(value.practiced.filter(valid))] : [] };
  } catch { /* An unavailable tutorial preference never blocks work. */ }
  return { version: 1, current: "evidence", viewed: [], practiced: [] };
}
export function writeTutorial(storage: Pick<Storage, "setItem"> | null, key: string, progress: TutorialProgress): boolean {
  if (!storage) return false;
  try { storage.setItem(key, JSON.stringify({ version: 1, current: progress.current, viewed: progress.viewed, practiced: progress.practiced })); return true; }
  catch { return false; }
}
