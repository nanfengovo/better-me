import type { FactBase } from "@better-me/core";
import { makeInventorySource, type InventoryGroup } from "@better-me/agent-contracts";

/** Inventory works on the local active fact snapshot, before public resume filters drop material. */
export function inventorySource(documentId: string, resumeId: string, facts: FactBase) {
  const prose = (v?: { zh: string; en?: string }) => [v?.zh, v?.en].filter(Boolean).join(" / ");
  const dated = [...facts.experiences].sort((a,b) =>
    (b.end ?? "9999").localeCompare(a.end ?? "9999") || b.start.localeCompare(a.start) || a.id.localeCompare(b.id));
  const mapped: InventoryGroup[] = dated.map(e => ({
    id: "exp:" + e.id, kind: e.type, experienceId: e.id,
    label: [prose(e.org), prose(e.title), prose(e.projectName)].filter(Boolean).join(" · ") || "未命名经历",
    period: [e.start, e.end ?? "原稿写至今，需核对"].join(" — "),
    evidence: [...e.claims.filter(c => c.kind !== "pitfall" && c.kind !== "interview" && (!c.metric || c.metric.confirmed)).map(c => prose(c.text)), ...(e.url ? [e.url] : [])],
  }));
  const education = mapped.filter(g => g.kind === "education");
  if (facts.profile.education) education.push({ id: "school-summary", kind: "education", label: "教育摘要", evidence: [prose(facts.profile.education)] });
  return makeInventorySource({ documentId, resumeId, importedAt: facts.importSource?.importedAt,
    fileModifiedAt: facts.importSource?.fileModifiedAt, groups: [
      ...mapped.filter(g => g.kind !== "education"),
      ...facts.profile.links.map((link,i) => ({ id: "link:" + i, kind: "link" as const, label: link.label || "原稿链接", evidence: [link.url] })),
      ...(facts.importSource?.unparsedLines ?? []).filter(s => s.trim()).map((line,i) => ({ id: "line:" + i, kind: "unparsed" as const, label: "待归位材料 " + (i+1), evidence: [line] })),
      ...education,
    ] });
}
