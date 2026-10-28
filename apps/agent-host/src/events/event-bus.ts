import { randomUUID } from "node:crypto";
import { AgentEventSchema, type AgentEvent, type AgentEventType, type JsonValue } from "@better-me/agent-contracts";

export type EventPayload = Record<string, JsonValue>;
export type EventListener = (event: AgentEvent) => void;

function boundedPayload(payload: EventPayload): EventPayload {
  const serialized = JSON.stringify(payload);
  if (serialized.length <= 32_000) return payload;
  return { detail: "event_payload_truncated", preview: serialized.slice(0, 31_500) };
}

export class AgentEventBus {
  private readonly events = new Map<string, AgentEvent[]>();
  private readonly listeners = new Map<string, Set<EventListener>>();

  publish(runId: string, type: AgentEventType, payload: EventPayload = {}, agentId?: string): AgentEvent {
    const runEvents = this.events.get(runId) ?? [];
    const event = AgentEventSchema.parse({
      id: `${runId}:${runEvents.length + 1}:${randomUUID().slice(0, 8)}`,
      runId,
      sequence: runEvents.length + 1,
      type,
      timestamp: new Date().toISOString(),
      ...(agentId ? { agentId } : {}),
      payload: boundedPayload(payload),
    });
    runEvents.push(event);
    this.events.set(runId, runEvents);
    for (const listener of this.listeners.get(runId) ?? []) listener(event);
    return event;
  }

  get(runId: string, afterSequence = 0): AgentEvent[] {
    return (this.events.get(runId) ?? []).filter((event) => event.sequence > afterSequence);
  }

  latestSequence(runId: string): number {
    return this.events.get(runId)?.at(-1)?.sequence ?? 0;
  }

  /** Restore a validated event log without notifying live subscribers. */
  restore(runId: string, restored: AgentEvent[]): void {
    const events = restored
      .filter((event) => event.runId === runId)
      .map((event) => AgentEventSchema.parse(event))
      .sort((left, right) => left.sequence - right.sequence);
    if (events.length === 0) return;
    this.events.set(runId, events);
  }

  subscribe(runId: string, listener: EventListener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  clear(runId: string): void {
    this.events.delete(runId);
    this.listeners.delete(runId);
  }
}

export function encodeSseEvent(event: AgentEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
