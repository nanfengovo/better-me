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
  const { t } = useUiPreferences();
  const [state, setState] = useState<{ ready: boolean; error: string }>(() => {
    try { return { ready: !recoverySpace(window.location.search), error: "" }; } catch (error) { return { ready: false, error: String(error) }; }
  });
  useEffect(() => {
    let active = true, space: string | undefined;
    try { space = recoverySpace(window.location.search); } catch { return; }
    if (space) void prepareRecoverySpace(space).then(() => { if (active) setState({ ready: true, error: "" }); })
      .catch(error => { if (active) setState({ ready: false, error: error instanceof Error ? error.message : t("恢复未完成，原资料未改动。", "Recovery did not finish. Original data was not changed.") }); });
    return () => { active = false; };
  }, [t]);
  if (!state.ready) return <main className="identity-screen"><section className="identity-card"><h1>{t("打开恢复档案", "Open recovery archive")}</h1><p role={state.error ? "alert" : "status"}>{state.error || t("核对当前账号并保护独立工作副本…", "Verifying the current account and protecting an isolated working copy…")}</p><a href={window.location.pathname}>{t("返回原工作空间", "Return to original workspace")}</a></section></main>;
  return <>{children}</>;
}

function ArchivedSession({ reference }: { reference: string }) {
  const { t } = useUiPreferences();
  const [session, setSession] = useState<UnderstandingSession>(), [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void readRecoverySession(reference).then(value => { if (active) setSession(value); })
      .catch(() => { if (active) setError(t("当前账号无法打开此会话。原记录未改变。", "The current account cannot open this session. Original records were not changed.")); });
    return () => { active = false; };
  }, [reference, t]);
  return <main className="workspace-reading recovery-session">
    <a href={window.location.pathname}>{t("返回原工作空间", "Return to original workspace")}</a><h1>{t("旧 Agent 项目会话 · 只读档案", "Legacy Agent project session · Read-only archive")}</h1>
    <p>{t("原对话、共识和错误记录保留。旧资料授权已停用，不执行任务，也不自动作为新的 Agent 记忆。", "Original conversations, shared understanding and errors are preserved. Previous material grants remain disabled; no task runs and nothing is automatically added to new Agent memory.")}</p>
    {error && <p role="alert">{error}</p>}
    {!session && !error && <p role="status">{t("正在核对当前账号…", "Verifying the current account…")}</p>}
    {session && <><h2>{session.label}</h2><p>{t(`${session.messages.length} 条消息 · 原会话状态：${session.phase} · 版本 ${session.revision}`, `${session.messages.length} messages · Original session state: ${session.phase} · Revision ${session.revision}`)}</p>
      {session.understanding && <details><summary>{t("原项目共识", "Original project understanding")}</summary><p className="recovery-session-copy">{session.understanding.summary}</p></details>}
      {session.error && <p role="note">{t("原错误记录：", "Original error: ")}{session.error.message}</p>}
      {session.messages.map(message => <article className="recovery-session-message" key={message.id}>
        <strong>{message.role === "user" ? t("你", "You") : message.role === "agent" ? "Agent" : t("系统", "System")}</strong>
        <small> · {message.at}</small><p className="recovery-session-copy">{message.text}</p>
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
