import { app, dialog, type BrowserWindow } from "electron";
import path from "node:path";

export type PdfExportResult =
  | { ok: true; filePath: string }
  | { ok: false; cancelled?: boolean; error?: string };

export function sanitizePdfFilename(suggested?: string): string {
  const cleaned = (suggested ?? "resume")
    .trim()
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
  return `${cleaned || "resume"}.pdf`;
}

export async function exportWindowToPdf(win: BrowserWindow | null, suggestedFilename?: unknown): Promise<PdfExportResult> {
  if (!win || win.isDestroyed()) {
    return { ok: false, error: "当前窗口不可用。" };
  }
  const defaultName = sanitizePdfFilename(typeof suggestedFilename === "string" ? suggestedFilename : undefined);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "导出简历 PDF",
    defaultPath: path.join(app.getPath("documents"), defaultName),
    filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) {
    return { ok: false, cancelled: true };
  }
  const pdfBuffer = await win.webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    pageSize: "A4",
  });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, pdfBuffer);
  return { ok: true, filePath };
}
