import { FactBaseSchema, type FactBase } from "@better-me/core";

/** Read a FactBase, document backup, or review download without discarding its diagnostics. */
export function parseResumeImportJson(raw: string, fileName: string, importedAt = new Date().toISOString()): { factBase: FactBase; warnings: string[] } {
  const parsed: unknown = JSON.parse(raw);
  const wrapper = parsed && typeof parsed === "object" && !Array.isArray(parsed) && "factBase" in parsed
    ? parsed as Record<string, unknown> : undefined;
  const validation = FactBaseSchema.safeParse(wrapper ? wrapper.factBase : parsed);
  if (!validation.success) throw new Error("JSON 不符合 FactBase 规范，请检查 schemaVersion 和字段。完整备份请用首页“恢复”入口保留所有视图。");
  const factBase = validation.data;
  const warnings: string[] = [];
  if (!wrapper) return { factBase, warnings };
  for (const key of ["unparsedLines", "warnings"] as const) {
    if (wrapper[key] !== undefined && (!Array.isArray(wrapper[key]) || wrapper[key].some((value) => typeof value !== "string"))) {
      throw new Error(`JSON 核对文件的 ${key} 必须是字符串数组，未导入。`);
    }
  }
  for (const key of ["rawText", "ocrText"] as const) {
    if (wrapper[key] !== undefined && typeof wrapper[key] !== "string") throw new Error(`JSON 核对文件的 ${key} 必须是字符串，未导入。`);
  }
  warnings.push(...(wrapper.warnings as string[] | undefined ?? []));
  if (wrapper.unparsedLines !== undefined || wrapper.rawText !== undefined || wrapper.ocrText !== undefined) {
    const prior = factBase.importSource;
    factBase.importSource = {
      fileName: prior?.fileName ?? fileName,
      importedAt: prior?.importedAt ?? importedAt,
      rawText: prior?.rawText ?? (wrapper.rawText as string | undefined) ?? "",
      ...(prior?.ocrText !== undefined ? { ocrText: prior.ocrText } : typeof wrapper.ocrText === "string" ? { ocrText: wrapper.ocrText } : {}),
      unparsedLines: prior ? [...prior.unparsedLines, ...((wrapper.unparsedLines as string[] | undefined) ?? []).filter((line) => !prior.unparsedLines.includes(line))] : (wrapper.unparsedLines as string[] | undefined) ?? [],
    };
    if (!prior && wrapper.rawText === undefined && wrapper.ocrText === undefined) warnings.push("此旧版核对文件未包含完整提取原文；已保留其中的待补录内容，完整内容仍需对照原始 PDF / Word / 图片。");
  }
  return { factBase, warnings };
}
