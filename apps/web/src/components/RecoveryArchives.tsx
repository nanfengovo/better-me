import { useEffect, useState, type ReactNode } from "react";
import { listRecoveryArchives, prepareRecoverySpace, readRecoverySession, type RecoveryArchive } from "../lib/recovery";
import { recoverySpace } from "../lib/private-storage";
import { useUiPreferences } from "../lib/ui-preferences";
import type { UnderstandingSession } from "@better-me/agent-contracts";

export function RecoverySpaceGate({ children }: { children: ReactNode }) {
  const sessionReference = new URLSearchParams(window.location.search).get("recoverySession");
  if (sessionReference) return <ArchivedSession reference={sessionReference} />;
  return <DocumentSpaceGate>{children}</DocumentSpaceGate>;
}
function DocumentSpaceGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ ready: boolean; error: string }>(() => {
    try { return { ready: !recoverySpace(window.location.search), error: "" }; } catch (error) { return { ready: false, error: String(error) }; }
  });
  useEffect(() => {
    let active = true, space: string | undefined;
    try { space = recoverySpace(window.location.search); } catch { return; }
    if (space) void prepareRecoverySpace(space).then(() => { if (active) setState({ ready: true, error: "" }); })
      .catch(error => { if (active) setState({ ready: false, error: error instanceof Error ? error.message : "恢复未完成，原资料未改动。" }); });
    return () => { active = false; };
  }, []);
  if (!state.ready) return <main className="identity-screen"><section className="identity-card"><h1>打开恢复档案</h1><p role={state.error ? "alert" : "status"}>{state.error || "核对当前账号并保护独立工作副本…"}</p><a href={window.location.pathname}>返回原工作空间</a></section></main>;
  return <>{children}</>;
}

function ArchivedSession({ reference }: { reference: string }) {
  const [session, setSession] = useState<UnderstandingSession>(), [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void readRecoverySession(reference).then(value => { if (active) setSession(value); })
      .catch(() => { if (active) setError("当前账号无法打开此会话。原记录未改变。"); });
    return () => { active = false; };
  }, [reference]);
  return <main style={{ maxWidth: 880, margin: "3rem auto", padding: "0 1.5rem" }}>
    <a href={window.location.pathname}>返回原工作空间</a><h1>旧 Agent 项目会话 · 只读档案</h1>
    <p>原对话、共识和错误记录保留。旧资料授权已停用，不执行任务，也不自动作为新的 Agent 记忆。</p>
    {error && <p role="alert">{error}</p>}
    {!session && !error && <p role="status">正在核对当前账号…</p>}
    {session && <><h2>{session.label}</h2><p>{session.messages.length} 条消息 · 原会话状态：{session.phase} · 版本 {session.revision}</p>
      {session.understanding && <details><summary>原项目共识</summary><p style={{ whiteSpace: "pre-wrap" }}>{session.understanding.summary}</p></details>}
      {session.error && <p role="note">原错误记录：{session.error.message}</p>}
      {session.messages.map(message => <article key={message.id} style={{ borderTop: "1px solid #d7ded8", padding: "1rem 0" }}>
        <strong>{message.role === "user" ? "你" : message.role === "agent" ? "Agent" : "系统"}</strong>
        <small> · {message.at}</small><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.text}</p>
        {message.question && <ul>{message.question.options.map(option => <li key={option.id}>{message.selectedOptionIds?.includes(option.id) ? "✓ " : ""}{option.label}</li>)}</ul>}
      </article>)}</>}
  </main>;
}

export function RecoveryArchives() {
  const { t } = useUiPreferences();
  const [archives, setArchives] = useState<RecoveryArchive[]>(), [error, setError] = useState("");
  return <details className="recovery-archives" onToggle={event => {
    if (event.currentTarget.open && !archives) void listRecoveryArchives().then(setArchives).catch(error => setError(error instanceof Error ? error.message : t("档案读取失败。", "Failed to load recovery archives.")));
  }}><summary>{t("恢复档案", "Recovery archives")}</summary>
    <p>{t("独立打开，不替换当前文档。原始版本与 Agent 历史保留；旧授权不会自动恢复。", "Opens in an isolated tab without replacing the current document. Original versions and Agent history remain intact.")}</p>
    {error && <p role="alert">{error}</p>}
    {archives?.length === 0 && <p>{t("当前账号没有已确认的恢复档案。", "No confirmed recovery archives for this account.")}</p>}
    {archives?.map(archive => <section key={archive.id}><strong>{archive.label}</strong><small> · {t(`${archive.sessionCount} 份项目会话 · ${archive.artifactCount} 份原始资料`, `${archive.sessionCount} sessions · ${archive.artifactCount} artifacts`)}</small>
      <ul>{archive.documents.map(document => <li key={document.key}><a target="_blank" rel="noopener noreferrer" href={`${window.location.pathname}?recovery=${archive.id}.${document.key}`}>{document.label}</a></li>)}</ul>
      <ul>{archive.sessions.map(session => <li key={session.id}><a target="_blank" rel="noopener noreferrer" href={`${window.location.pathname}?recoverySession=${archive.id}.${session.id}`}>{session.label} · {t(`${session.messageCount} 条消息（只读）`, `${session.messageCount} messages (read-only)`)}</a></li>)}</ul>
    </section>)}
  </details>;
}
