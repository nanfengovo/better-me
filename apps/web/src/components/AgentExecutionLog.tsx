import { useUiPreferences } from "../lib/ui-preferences";
import "./agent-execution-log.css";

export type ExecutionEntry = { id: string; at: string; kind: string; label: string; detail?: string; important?: boolean };
export function groupExecutionEntries(entries: ExecutionEntry[]) {
  const groups: { key: string; entries: ExecutionEntry[] }[] = [];
  for (const entry of entries) {
    const last = groups.at(-1), previous = last?.entries.at(-1);
    if (previous && !entry.important && !previous.important && previous.kind === entry.kind && previous.label === entry.label && previous.detail === entry.detail) last!.entries.push(entry);
    else groups.push({ key: entry.id, entries: [entry] });
  }
  return groups;
}
/** Presentation-only aggregation. Original order and every receipt remain expandable. */
export function AgentExecutionLog({ entries }: { entries: ExecutionEntry[] }) {
  const { t } = useUiPreferences();
  if (!entries.length) return null;
  const groups = groupExecutionEntries(entries);
  return <details className="agent-execution-log"><summary>{t("执行过程", "Execution details")} · {entries.length} {t("条记录", "records")} · {groups.length} {t("组", "groups")}</summary>
    <ol>{groups.map(group => { const first = group.entries[0]!, last = group.entries.at(-1)!; return <li key={group.key} data-important={first.important || undefined}>
      <span>{first.label}{group.entries.length > 1 && <b> × {group.entries.length}</b>}</span>{first.detail && <p>{first.detail}</p>}
      {group.entries.length === 1 ? <time dateTime={first.at}>{new Date(first.at).toLocaleTimeString()}</time> : <details><summary>{new Date(first.at).toLocaleTimeString()}–{new Date(last.at).toLocaleTimeString()} · {t("查看逐条记录", "Show each record")}</summary><ul>{group.entries.map(entry => <li key={entry.id}><time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString()}</time> {entry.label}</li>)}</ul></details>}
    </li>; })}</ol>
  </details>;
}
