import { createDefaultResumeView } from "@better-me/core";
import type { BetterMeDocument } from "@better-me/storage";

export function duplicateResumeView(document: BetterMeDocument, id: string, options: { name?: string; targetJdId?: string } = {}): BetterMeDocument {
  const source = document.resumeViews.find((view) => view.id === id);
  if (!source) throw new Error("找不到这份简历，请重新选择。");
  const view = { ...structuredClone(source), id: crypto.randomUUID(), name: options.name?.trim() || `${source.name} · 副本`, updatedAt: new Date().toISOString() };
  if (options.targetJdId) view.targetJdId = options.targetJdId;
  return { ...document, activeResumeId: view.id, resumeViews: [...document.resumeViews, view] };
}

export function addResumeView(document: BetterMeDocument): BetterMeDocument {
  const view = createDefaultResumeView(document.factBase);
  view.id = crypto.randomUUID();
  view.name = `我的简历 ${document.resumeViews.length + 1}`;
  return { ...document, resumeViews: [...document.resumeViews, view], activeResumeId: view.id };
}

export function removeResumeView(document: BetterMeDocument, id: string): BetterMeDocument {
  if (document.resumeViews.length <= 1) throw new Error("至少需要保留一份简历。");
  if (!document.resumeViews.some((view) => view.id === id)) throw new Error("找不到这份简历。");
  const views = document.resumeViews.filter((view) => view.id !== id);
  return { ...document, resumeViews: views, activeResumeId: document.activeResumeId === id ? views[0]!.id : document.activeResumeId };
}

export function resumeNamesByOpportunity(document: BetterMeDocument): Record<string, string[]> {
  const names: Record<string, string[]> = Object.create(null);
  for (const view of document.resumeViews) {
    if (view.targetJdId) (names[view.targetJdId] ??= []).push(view.name);
  }
  return names;
}
