import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

export function reorderList<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return [...items];
  next.splice(toIndex, 0, moved);
  return next;
}

interface DragState {
  activeId: string;
  fromIndex: number;
  overIndex: number;
  offsetY: number;
  itemStep: number;
}

const DRAG_THRESHOLD_PX = 4;

/**
 * Smooth pointer-driven vertical list sorting with GPU-accelerated displacement
 * and keyboard fallback (ArrowUp / ArrowDown on the handle).
 */
export function useSortableList<T extends { id: string }>(
  items: readonly T[],
  onReorder: (nextItems: T[]) => void,
) {
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const registerItem = useCallback((id: string) => (node: HTMLElement | null) => {
    if (node) itemRefs.current.set(id, node);
    else itemRefs.current.delete(id);
  }, []);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  const startDrag = useCallback((id: string, index: number, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || itemsRef.current.length < 2) return;
    const targetEl = itemRefs.current.get(id);
    if (!targetEl) return;

    event.preventDefault();
    const startY = event.clientY;

    // Snapshot bounding rects of all items in order before dragging starts
    const rects = itemsRef.current.map((item) => {
      const el = itemRefs.current.get(item.id);
      const r = el?.getBoundingClientRect();
      return { id: item.id, top: r?.top ?? 0, height: r?.height ?? 0, midY: r ? r.top + r.height / 2 : 0 };
    });

    const currentRect = rects[index]!;
    const neighbor = rects[index + 1] ?? rects[index - 1];
    const gap = neighbor
      ? Math.max(0, index + 1 < rects.length ? neighbor.top - (currentRect.top + currentRect.height) : currentRect.top - (neighbor.top + neighbor.height))
      : 12;
    const itemStep = currentRect.height + gap;

    let started = false;

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const dy = moveEvent.clientY - startY;
      if (!started) {
        if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        started = true;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }

      const draggedMidY = currentRect.midY + dy;
      let overIndex = index;
      if (dy > 0) {
        for (let i = index + 1; i < rects.length; i += 1) {
          if (draggedMidY > rects[i]!.midY) overIndex = i;
        }
      } else if (dy < 0) {
        for (let i = index - 1; i >= 0; i -= 1) {
          if (draggedMidY < rects[i]!.midY) overIndex = i;
        }
      }

      const nextState: DragState = {
        activeId: id,
        fromIndex: index,
        overIndex,
        offsetY: dy,
        itemStep,
      };
      dragRef.current = nextState;
      setDrag(nextState);
    };

    const finish = (commit: boolean) => {
      const finalDrag = dragRef.current;
      cleanup();
      dragRef.current = null;
      setDrag(null);
      if (commit && finalDrag && finalDrag.fromIndex !== finalDrag.overIndex) {
        onReorderRef.current(reorderList(itemsRef.current, finalDrag.fromIndex, finalDrag.overIndex));
      }
    };

    const onPointerUp = () => finish(true);
    const onPointerCancel = () => finish(false);
    const onKeyDown = (keyEvent: globalThis.KeyboardEvent) => {
      if (keyEvent.key === "Escape") finish(false);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown);
  }, []);

  const getItemProps = useCallback(
    (id: string, index: number): { ref: (node: HTMLElement | null) => void; style: CSSProperties | undefined; "data-dragging"?: "true"; "data-sorting"?: "true" } => {
      const ref = registerItem(id);
      if (!drag) return { ref, style: undefined };

      if (drag.activeId === id) {
        return {
          ref,
          "data-dragging": "true",
          style: {
            transform: `translate3d(0, ${drag.offsetY}px, 0) scale(1.012)`,
            zIndex: 25,
            position: "relative",
          },
        };
      }

      let shift = 0;
      if (drag.fromIndex < drag.overIndex && index > drag.fromIndex && index <= drag.overIndex) {
        shift = -drag.itemStep;
      } else if (drag.fromIndex > drag.overIndex && index >= drag.overIndex && index < drag.fromIndex) {
        shift = drag.itemStep;
      }

      return {
        ref,
        "data-sorting": "true",
        style: {
          transform: shift !== 0 ? `translate3d(0, ${shift}px, 0)` : "translate3d(0, 0, 0)",
        },
      };
    },
    [drag, registerItem],
  );

  const getHandleProps = useCallback(
    (id: string, index: number) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => startDrag(id, index, event),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === "ArrowUp" && index > 0) {
          event.preventDefault();
          onReorderRef.current(reorderList(itemsRef.current, index, index - 1));
        } else if (event.key === "ArrowDown" && index < itemsRef.current.length - 1) {
          event.preventDefault();
          onReorderRef.current(reorderList(itemsRef.current, index, index + 1));
        }
      },
    }),
    [startDrag],
  );

  return {
    isDragging: drag !== null,
    activeId: drag?.activeId ?? null,
    getItemProps,
    getHandleProps,
  };
}
