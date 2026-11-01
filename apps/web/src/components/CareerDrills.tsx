import { useState } from "react";
import { createDrill, drillMatches, evaluateDrill, saveDrillAnswer } from "../lib/career-coach/journey";
import type { CoachRecord, CoachRequest, CoachState, DrillAttempt } from "../lib/career-coach/types";

export function CareerDrills({ state, context, disabled, mutate, request, run, onPlan }: {
  state: CoachState; context: string; disabled: boolean;
  mutate: (fn: (current: CoachState) => CoachState) => boolean;
  request: (mode: "drill", input?: string) => CoachRequest;
  run: (request: CoachRequest, apply?: (next: CoachState, record: CoachRecord) => CoachState) => Promise<void>;
  onPlan: (text: string, source?: CoachRecord) => void;
}) {
  const [topic, setTopic] = useState("");
  const attempts = state.drills ?? [], latest = attempts.at(-1);
  const current = latest && drillMatches(latest, state, context) ? latest : undefined;
  const evaluate = (attempt: DrillAttempt) => void run({ ...request("drill", "请引用本次回答评价，不把模型意见当认证。"),
    sourceRecordIds: [attempt.questionRecordId],
    drill: { topic: attempt.topic, question: attempt.question, answer: attempt.answer } }, (next, record) => evaluateDrill(next, attempt.id, record));
  const nextQuestion = (selectedTopic = topic, previous?: DrillAttempt) => {
    if (!selectedTopic.trim()) return;
    const reference = previous?.feedbackRecordId && state.records.find(item => item.id === previous.feedbackRecordId);
    const feedback = reference && reference.payload.kind === "drill" ? reference.payload.feedback : undefined;
    const history = previous ? `\n上次原题：${previous.question.text}\n本人原答：${previous.answer.slice(0, 6000)}\n${previous.disputed ? "本人已质疑上次评价，不沿用其判断；请从原答重新判断。" : feedback ? `上次参考反馈（不代表认证）：${feedback.explanation}\n建议：${feedback.nextAction}` : "尚无有效评价。"}\n请据此选择下一道题，检验理解迁移而不是简单重复原题。` : "";
    void run({ ...request("drill", `围绕本次主题生成一道新题。题目和评价条件要清楚，资料不足可追问。${history}`.slice(0, 12000)),
      sourceRecordIds: previous ? [previous.questionRecordId, ...(!previous.disputed && reference ? [reference.id] : [])] : undefined,
      drill: { topic: selectedTopic.trim() } }, (next, record) => createDrill(next, record, selectedTopic.trim(), context));
  };
  const feedbackRecord = current?.feedbackRecordId && state.records.find(item => item.id === current.feedbackRecordId);
  const feedback = feedbackRecord && feedbackRecord.payload.kind === "drill" ? feedbackRecord.payload.feedback : undefined;
  return <>
    <section className="coach-compose"><p>Agent 按目标和你选定的主题出题；逐次保存作答与评价依据，不随机计分，也不自动调用模型。</p>
      <label>这次练什么<input value={topic} maxLength={400} onChange={event => setTopic(event.target.value)} placeholder="例如：幂等与重试、接口测试、项目取舍" /></label>
      <button type="button" className="coach-primary" disabled={disabled || !topic.trim() || Boolean(current && !current.answer)} onClick={() => nextQuestion()}>生成一道练习题</button>
      {current && !current.answer && <small>请先回答或明确跳过当前题目；不会丢弃输入。</small>}
    </section>
    {latest && !current && <p role="status" className="coach-note">目标或资料授权已变化，旧题仅保留在历史。请在新范围内重新出题。</p>}
    {current && <section className="coach-result"><h3>{current.question.text}</h3><p>考察：{current.question.skill} · {current.question.why}</p>
      <ul>{current.question.criteria.map(item => <li key={item}>{item}</li>)}</ul>
      {!current.answer ? <><label>我的练习回答<textarea rows={6} maxLength={12000} value={current.draft ?? ""} disabled={disabled} onChange={event => mutate(previous => ({ ...previous, drills: previous.drills?.map(item => item.id === current.id ? { ...item, draft: event.target.value } : item) }))} /></label>
        <div className="coach-inline-actions"><button type="button" className="coach-primary" disabled={disabled || !current.draft?.trim()} onClick={() => {
          const answered = { ...current, answer: current.draft!.trim() };
          if (mutate(previous => saveDrillAnswer(previous, current.id, answered.answer))) evaluate(answered);
        }}>保存回答并请求评价</button><button type="button" disabled={disabled} onClick={() => mutate(previous => saveDrillAnswer(previous, current.id, [current.draft, "本人选择：暂时不会或题目不适用，跳过本题；未评价。"].filter(Boolean).join("\n")))}>保留草稿并跳过</button></div>
      </> : <><div className="coach-answer"><small>本次实际回答</small><p className="coach-prewrap">{current.answer}</p></div>
        {feedback ? <div className="coach-feedback"><strong>{current.disputed ? "评价已标记待核对，不作为可靠能力依据" : { supported: "本次回答有依据支持", needs_practice: "建议继续练习", uncertain: "无法确定，需核对" }[feedback.verdict]}</strong>
          <blockquote>{feedback.quote}</blockquote><p>{feedback.explanation}</p><p>下一步：{feedback.nextAction}</p><small>引用核对仅证明文字来自回答，不证明模型判断正确。</small>
          <div className="coach-inline-actions"><button type="button" disabled={disabled} onClick={() => mutate(previous => ({ ...previous, drills: previous.drills?.map(item => item.id === current.id ? { ...item, disputed: true, reviewAt: undefined } : item) }))}>题目或评价有误</button>
            <button type="button" disabled={disabled || current.disputed} onClick={() => onPlan(`本人请求核对这道练习的反馈并提出计划调整（不是已核实能力）：\n题目：${current.question.text}\n回答：${current.answer}\n依据：${feedback.quote}\n模型解释：${feedback.explanation}\n建议：${feedback.nextAction}`, feedbackRecord || undefined)}>用本次反馈调整方案</button></div>
        </div> : <p className="coach-note">回答已保存，尚无有效评价。可手动重试，不追加同一回答。</p>}
        <div className="coach-inline-actions"><button type="button" disabled={disabled} onClick={() => evaluate(current)}>重试本题评价</button>
          <button type="button" disabled={disabled} onClick={() => { setTopic(current.topic); nextQuestion(current.topic, current); }}>根据这次回答继续练</button></div>
        <label>本人安排复习<select value="" disabled={disabled} onChange={event => { if (!event.target.value) return; const at = new Date(Date.now() + Number(event.target.value) * 86400000).toISOString(); mutate(previous => ({ ...previous, drills: previous.drills?.map(item => item.id === current.id ? { ...item, reviewAt: at } : item) })); }}>
          <option value="">选择复习间隔（不是掌握度计算）</option><option value="1">明天</option><option value="3">3 天后</option><option value="7">7 天后</option></select></label>
      </>}
    </section>}
    <details className="coach-result"><summary>作答历史与复习 · {attempts.length} 次</summary><div className="coach-history-scroll">{[...attempts].reverse().map(item => {
      const record = state.records.find(record => record.id === item.feedbackRecordId);
      const feedback = record?.payload.kind === "drill" ? record.payload.feedback : undefined;
      return <article className="coach-submission" key={item.id}>
      <strong>{item.question.skill} · {item.question.text}</strong><p className="coach-prewrap">{item.answer || item.draft || "等待回答"}</p><small>{item.disputed ? "评价待核对" : item.feedbackRecordId ? "已有模型参考评价" : "未评价"} · {item.reviewAt ? `复习：${new Date(item.reviewAt).toLocaleDateString()}${Date.parse(item.reviewAt) <= Date.now() ? "（已到期）" : ""}` : "未安排复习"}</small>
      {feedback && <details><summary>当次评价与引用</summary><blockquote>{feedback.quote}</blockquote><p>{feedback.explanation}</p><p>{feedback.nextAction}</p></details>}
      <button type="button" disabled={disabled || !item.answer || Boolean(current && !current.answer) || !drillMatches(item, state, context)} onClick={() => { setTopic(item.topic); nextQuestion(item.topic, item); }}>基于这次记录复习</button>
    </article>; })}</div></details>
  </>;
}
