import { useCallback, useEffect, useRef, useState } from "react";
import { createCoachState } from "./state";
import { CoachStateSchema, type CoachState } from "./types";
import { CoachStorageConflict, defaultCoachRepository, type CoachRepository } from "./storage";

interface Writer {
  enabled: boolean;
  blocked: boolean;
  revision: number;
  pending: Promise<void>;
  latest: CoachState;
  error?: string;
}

interface RetainedDraft {
  state: CoachState;
  persistedRevision: number;
  conflict: boolean;
  error: string;
}

// Temporary, same-page recovery only: nothing here is a second persistent store
// or permission to retry a failed write. Repository identity prevents test or
// alternate stores with the same workspace key sharing private drafts.
const retainedDrafts = new WeakMap<CoachRepository, Map<string, RetainedDraft>>();
const pendingWrites = new WeakMap<CoachRepository, Map<string, Set<Promise<void>>>>();

function retainDraft(repository: CoachRepository, workspaceKey: string, writer: Writer): void {
  let scopes = retainedDrafts.get(repository);
  if (!scopes) { scopes = new Map(); retainedDrafts.set(repository, scopes); }
  scopes.set(workspaceKey, {
    state: writer.latest, persistedRevision: writer.revision, conflict: writer.blocked,
    error: writer.error ?? "成长内容尚未保存，请立即下载备份。",
  });
}

function trackPending(repository: CoachRepository, workspaceKey: string, pending: Promise<void>): void {
  let scopes = pendingWrites.get(repository);
  if (!scopes) { scopes = new Map(); pendingWrites.set(repository, scopes); }
  let writes = scopes.get(workspaceKey);
  if (!writes) { writes = new Set(); scopes.set(workspaceKey, writes); }
  writes.add(pending);
  const settled = () => { writes.delete(pending); if (writes.size === 0) scopes.delete(workspaceKey); };
  void pending.then(settled, settled);
}

function recoveryMessage(error: string): string {
  return `${error} 已恢复尚未保存的本页草稿，请先下载备份，再明确读取已保存版本；关闭或刷新整个页面后此临时副本会丢失。`;
}

export function useCareerCoach(workspaceKey: string, repository: CoachRepository = defaultCoachRepository) {
  const [state, setState] = useState(() => createCoachState(workspaceKey));
  const [ready, setReady] = useState(false);
  const [persistenceError, setPersistenceError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const current = useRef(state);
  const appliedScope = useRef({ workspaceKey, repository });
  const generation = useRef(0);
  const usable = useRef(false);
  const writer = useRef<Writer>({ enabled: false, blocked: false, revision: 0, pending: Promise.resolve(), latest: state });

  const loadWorkspace = useCallback(async (discardDraft = false) => {
    const ticket = ++generation.current;
    const draftAtRequest = retainedDrafts.get(repository)?.get(workspaceKey);
    usable.current = false; setReady(false);
    // Drain the previous scope's writer before loading; do not disable queued saves.
    await writer.current.pending;
    // A previous mount may still be saving this scope. Wait for its outcome so
    // a late failure cannot disappear after the replacement already read disk.
    await Promise.all(pendingWrites.get(repository)?.get(workspaceKey) ?? []);
    if (ticket !== generation.current) return;
    const retained = retainedDrafts.get(repository)?.get(workspaceKey);
    const initial = current.current.workspaceKey === workspaceKey && appliedScope.current.repository === repository
      ? current.current : createCoachState(workspaceKey);
    writer.current = { enabled: false, blocked: false, revision: 0, pending: Promise.resolve(), latest: initial };
    // Reload can discard only a failure the caller could already see. A save
    // failing while this reload drains must first be exposed for backup.
    if (retained && (!discardDraft || retained !== draftAtRequest)) {
      appliedScope.current = { workspaceKey, repository };
      current.current = retained.state; setState(retained.state);
      writer.current.latest = retained.state; writer.current.revision = retained.persistedRevision;
      writer.current.blocked = retained.conflict; writer.current.error = retained.error;
      setConflict(retained.conflict); setPersistenceError(recoveryMessage(retained.error));
      usable.current = true; setReady(true);
      return;
    }
    try {
      const saved = await repository.load(workspaceKey);
      if (ticket !== generation.current) return;
      const next = saved ?? createCoachState(workspaceKey);
      // Only a successful, explicit reload discards a retained failed draft.
      retainedDrafts.get(repository)?.delete(workspaceKey);
      appliedScope.current = { workspaceKey, repository };
      current.current = next; writer.current.latest = next; writer.current.revision = next.revision; setState(next);
      writer.current.enabled = true; setConflict(false); setPersistenceError(undefined);
    } catch (error) {
      if (ticket !== generation.current) return;
      const next = retained?.state ?? initial;
      appliedScope.current = { workspaceKey, repository };
      current.current = next; writer.current.latest = next; setState(next);
      writer.current.revision = retained?.persistedRevision ?? 0;
      writer.current.blocked = retained?.conflict ?? false;
      writer.current.error = error instanceof Error ? error.message : "成长记录未能读取；当前内容仅留在本页。";
      setConflict(writer.current.blocked);
      setPersistenceError(retained ? recoveryMessage(writer.current.error) : writer.current.error);
    } finally { if (ticket === generation.current) { usable.current = true; setReady(true); } }
  }, [workspaceKey, repository]);

  const reload = useCallback(() => loadWorkspace(true), [loadWorkspace]);
  const invalidateLoads = useCallback(() => {
    // Invalidate the latest load (including an explicit reload), not merely the
    // initial setup's ticket. Accepted writes still drain independently.
    generation.current += 1;
    usable.current = false;
  }, []);
  useEffect(() => { void loadWorkspace(); return invalidateLoads; }, [loadWorkspace, invalidateLoads]);

  const update = useCallback((updater: (state: CoachState) => CoachState) => {
    if (!usable.current || current.current.workspaceKey !== workspaceKey || appliedScope.current.repository !== repository) throw new Error("成长记录尚未就绪，请稍后重试。");
    const activeWriter = writer.current;
    if (activeWriter.blocked) throw new CoachStorageConflict();
    const previous = current.current;
    const result = updater(previous);
    if (result === previous) return;
    const next = CoachStateSchema.parse({ ...result, workspaceKey, revision: previous.revision + 1, updatedAt: new Date().toISOString() });
    current.current = next; activeWriter.latest = next; setState(next);
    if (!activeWriter.enabled) { retainDraft(repository, workspaceKey, activeWriter); return; }
    const ticket = generation.current;
    activeWriter.pending = activeWriter.pending.then(async () => {
      if (!activeWriter.enabled) return;
      try { await repository.save(next, activeWriter.revision); activeWriter.revision = next.revision; }
      catch (error) {
        activeWriter.enabled = false;
        activeWriter.blocked = error instanceof CoachStorageConflict;
        activeWriter.error = error instanceof Error ? error.message : "成长内容尚未保存，请立即下载备份。";
        // Preserve the latest accepted state, including later queued edits, even
        // after unmount or a scope switch invalidated this writer's UI ticket.
        retainDraft(repository, workspaceKey, activeWriter);
        if (ticket !== generation.current) return;
        setConflict(activeWriter.blocked);
        setPersistenceError(activeWriter.error);
      }
    });
    trackPending(repository, workspaceKey, activeWriter.pending);
  }, [workspaceKey, repository]);

  const clear = useCallback(async () => {
    if (!usable.current || current.current.workspaceKey !== workspaceKey || appliedScope.current.repository !== repository) throw new Error("记录尚未就绪。");
    const activeWriter = writer.current;
    const ticket = generation.current;
    usable.current = false; setReady(false);
    const clearing = activeWriter.pending.then(async () => {
      if (activeWriter.blocked) throw new CoachStorageConflict();
      // A failed read must never authorize deleting unknown stored data.
      if (!activeWriter.enabled) throw new Error("尚不能确认已保存记录；请先下载备份并重新读取，再清除。");
      await repository.clear(workspaceKey, activeWriter.revision);
      activeWriter.revision++;
      const fresh = { ...createCoachState(workspaceKey), revision: activeWriter.revision };
      activeWriter.latest = fresh;
      retainedDrafts.get(repository)?.delete(workspaceKey);
      if (ticket !== generation.current) return;
      current.current = fresh; setState(fresh); setPersistenceError(undefined);
    });
    activeWriter.pending = clearing.then(() => undefined, () => undefined);
    trackPending(repository, workspaceKey, activeWriter.pending);
    try { await clearing; }
    finally { if (ticket === generation.current) { usable.current = true; setReady(true); } }
  }, [workspaceKey, repository]);

  const matchesScope = state.workspaceKey === workspaceKey && appliedScope.current.repository === repository;
  return { state: matchesScope ? state : createCoachState(workspaceKey), ready: ready && matchesScope,
    persistenceError: matchesScope ? persistenceError : undefined,
    conflict: matchesScope && conflict, update, reload, clear };
}
