import { useCallback, useRef, useState } from "react";

export class UndoStack<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastRecordedAt = 0;

  constructor(
    private readonly maxSize = 50,
    private readonly coalesceMs = 400,
  ) {}

  record(previous: T, now = Date.now(), forceSeparate = false): void {
    const snapshot = structuredClone(previous);
    if (!forceSeparate && this.past.length > 0 && now - this.lastRecordedAt < this.coalesceMs) {
      // Coalesce rapid consecutive keystrokes into one undo step by keeping the earlier snapshot
      this.lastRecordedAt = now;
      this.future = [];
      return;
    }
    this.past.push(snapshot);
    if (this.past.length > this.maxSize) this.past.shift();
    this.future = [];
    this.lastRecordedAt = now;
  }

  undo(current: T): T | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(structuredClone(current));
    this.lastRecordedAt = 0;
    return previous;
  }

  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(structuredClone(current));
    this.lastRecordedAt = 0;
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.lastRecordedAt = 0;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}

export function useDocumentUndo<T>(maxSize = 50) {
  const stackRef = useRef<UndoStack<T> | null>(null);
  if (!stackRef.current) stackRef.current = new UndoStack<T>(maxSize);
  const [counts, setCounts] = useState({ canUndo: false, canRedo: false });

  const sync = useCallback(() => {
    const s = stackRef.current!;
    setCounts((prev) => (prev.canUndo === s.canUndo && prev.canRedo === s.canRedo ? prev : { canUndo: s.canUndo, canRedo: s.canRedo }));
  }, []);

  const record = useCallback((previous: T, forceSeparate = false) => {
    stackRef.current!.record(previous, Date.now(), forceSeparate);
    sync();
  }, [sync]);

  const undo = useCallback((current: T): T | null => {
    const result = stackRef.current!.undo(current);
    sync();
    return result;
  }, [sync]);

  const redo = useCallback((current: T): T | null => {
    const result = stackRef.current!.redo(current);
    sync();
    return result;
  }, [sync]);

  const clear = useCallback(() => {
    stackRef.current!.clear();
    sync();
  }, [sync]);

  return {
    record,
    undo,
    redo,
    clear,
    canUndo: counts.canUndo,
    canRedo: counts.canRedo,
  };
}
