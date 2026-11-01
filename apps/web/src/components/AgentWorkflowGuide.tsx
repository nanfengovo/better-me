import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, FileText, MessageSquare, ShieldCheck, Sparkles } from "lucide-react";
import "./agent-workflow-guide.css";

export const AGENT_LESSONS = [
  { id: "evidence", title: "授权资料，不等于认领贡献", text: "在当前经历中打开「先对齐项目理解」，展开资料范围，填写你允许只读的完整路径。可以只授权一个文件，随时撤销。凭据、客户私密资料不要授权。", action: "回到当前经历", destination: "writing" },
  { id: "dialogue", title: "问题随你的回答变化", text: "Agent 先解释它理解的术语、流程与边界，再生成问题和选项。没有固定轮数；选项不默认勾选，也可以自由补充、纠正或说明不知道。每轮发送前由你授权。", action: "查看当前对话", destination: "writing" },
  { id: "consensus", title: "确认共同语言，不确认个人功劳", text: "核对理解卡片的术语、边界和待验证推断，明确确认本版理解。材料或原文变化会让旧确认失效，但不会删掉历史。项目功能不能自动写成你的成果。", action: "查看项目共识", destination: "memory" },
  { id: "contribution", title: "把项目理解变成你的贡献", text: "确认项目理解后，展开贡献线索。区分「我实际实现过」「仅设计」「不是我做的」；补充本人动作、职责、使用阶段。客户名可留空，私有备注不发送。核对后带入伴写，不立即改简历。", action: "回到贡献与伴写", destination: "writing" },
  { id: "annotation", title: "原文、旁批、候选一起核对", text: "打开一条伴写批注，点击来源定位原文。宽屏下高亮与虚线连接旁批，窄屏保留高亮与定位。候选会列出引用依据，逐字核对后才采用；一次只改这一条，并可撤销。", action: "查看旁批工作区", destination: "writing" },
  { id: "memory", title: "收起继续，重载先核对", text: "切 Tab、收起、切页面不会停止任务或清空草稿。浏览器保存对话索引，配套服务保存项目会话；刷新后需核对任务状态，不自动重发。下载记录可迁移为只读档案，旧授权不会恢复。", action: "打开备份与历史", destination: "memory" },
  { id: "tools", title: "分别选择推理模型与阅读工具", text: "统一模型可以选择当前明确配置的模型或 ChatGPT 账号授权。项目阅读工具单独选择；只有显示兼容且可用的本机 Agent 才能参与受控取证。安装不等于支持，不会自动安装、运行或回退付费 API。", action: "打开模型与工具", destination: "settings" },
  { id: "recovery", title: "没响应时，不猜测进度", text: "查看真实任务状态、已等待时间和最近事件；执行日志默认聚合。超时保留输入，先刷新状态再决定重试。存储断开可重连；冲突时先下载本页记录，不覆盖另一窗口。", action: "查看任务与恢复", destination: "memory" },
] as const;
export type AgentLesson = typeof AGENT_LESSONS[number]["id"];
export function AgentWorkflowGuide({ step, onStep, onClose, onAction }: { step: number; onStep: (step: number) => void; onClose: () => void; onAction: (destination: "writing" | "memory" | "settings") => void }) {
  const [keyboard, setKeyboard] = useState(false);
  const lesson = AGENT_LESSONS[step] ?? AGENT_LESSONS[0];
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [step]);
  return <section className="agent-workflow-guide" data-keyboard={keyboard} onKeyDownCapture={() => setKeyboard(true)} onPointerDownCapture={() => setKeyboard(false)} aria-label="Agent 协作教程">
    <header><span>协作教程 · {step + 1} / {AGENT_LESSONS.length}</span><button type="button" onClick={onClose}>返回工作</button></header>
    <nav aria-label="教程章节">{AGENT_LESSONS.map((item, index) => <button key={item.id} type="button" aria-current={step === index ? "step" : undefined} onClick={() => onStep(index)} aria-label={`第 ${index + 1} 节：${item.title}`}>{index < step ? <Check size={12} /> : index + 1}</button>)}</nav>
    <div className="agent-workflow-illustration" aria-label="协作流程示意，不是任务进度"><div className={step < 2 ? "is-current" : ""}><FileText size={20} /><span>授权原文</span></div><i /><div className={step >= 2 && step < 4 ? "is-current" : ""}><MessageSquare size={20} /><span>核对共识</span></div><i /><div className={step >= 4 ? "is-current" : ""}><ShieldCheck size={20} /><span>本人确认</span></div></div>
    <article key={lesson.id}><h3 tabIndex={-1} ref={heading}>{lesson.title}</h3><p>{lesson.text}</p><button type="button" className="agent-guide-action" onClick={() => onAction(lesson.destination)}><Sparkles size={14} />{lesson.action}</button><small>这个入口只切换视图，不发送资料、不调用模型、不修改简历。</small></article>
    <footer><button type="button" disabled={step === 0} onClick={() => onStep(step - 1)}><ArrowLeft size={14} />上一节</button><button type="button" onClick={() => step === AGENT_LESSONS.length - 1 ? onClose() : onStep(step + 1)}>{step === AGENT_LESSONS.length - 1 ? "完成，继续协作" : "下一节"}<ArrowRight size={14} /></button></footer>
  </section>;
}
