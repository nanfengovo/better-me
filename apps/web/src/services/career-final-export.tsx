import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";
import { ResumeTemplate, resolveResumeTemplate } from "../components/ResumeTemplate";
import type { CareerLayoutFinalExportRequest } from "../components/CareerLayoutPanel";
import { projectedResumeToDocx } from "../lib/docx-export";
import { getResumePrintCss } from "../lib/resume-print";
import { finalArtifactSha256, sameLayoutScope, type FinalLayoutExportArtifact, type LayoutScope } from "../lib/layout-compiler";
import type { StudioRequest } from "./career-studio-client";
import paperCss from "../components/resume-paper.css?raw";
import themeCss from "../components/resume-themes.css?raw";

const templates = import.meta.glob<string>("../components/templates/*.css", { query: "?raw", import: "default", eager: true });
const responseSchema = z.object({ operationId: z.string(), contextId: z.string(), format: z.enum(["pdf", "docx"]),
  contentHash: z.string(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), renderedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactBase64: z.string().max(11_000_000), renderedPdfBase64: z.string().max(11_000_000).optional(),
  receipt: z.object({ id: z.string(), renderer: z.object({ name: z.string(), version: z.string() }).strict(), renderedAt: z.string().datetime() }).strict(),
  limitations: z.array(z.string()).max(20),
}).strict();
const encode = (bytes: Uint8Array) => { let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(binary); };
const decode = (base64: string) => Uint8Array.from(atob(base64), character => character.charCodeAt(0));

/** Exact existing serializers, not a second resume generator. The Host rejects
 * external image/font resources instead of fetching or silently removing them.
 * Expected text/hrefs are independently captured by the Panel's source DOM. */
export function createCareerFinalExporter(options: { contextId: string; request: StudioRequest; getCurrentScope(): LayoutScope }) {
  return async (input: CareerLayoutFinalExportRequest): Promise<FinalLayoutExportArtifact> => {
    const assertCurrent = () => { input.signal.throwIfAborted(); if (!sameLayoutScope(input.scope, options.getCurrentScope())) throw new Error("最终文件原稿版本已失效。"); };
    assertCurrent();
    let source: Uint8Array, filename: string;
    if (input.format === "docx") {
      const docx = await projectedResumeToDocx(input.resume); source = new Uint8Array(await docx.blob.arrayBuffer()); filename = docx.filename;
    } else {
      const markup = renderToStaticMarkup(<ResumeTemplate resume={input.resume} templateId={resolveResumeTemplate(input.resume.templateId)} />);
      const css = ["html,body{margin:0;padding:0}*,*::before,*::after{box-sizing:border-box}ul,ol{margin:0;padding:0;list-style:none}button,input{font:inherit}", paperCss, ...Object.keys(templates).sort().map(key => templates[key]), themeCss, getResumePrintCss(input.resume)].join("\n");
      if (/<\/style/i.test(css)) throw new Error("打印样式无效，未导出。");
      source = new TextEncoder().encode(`<!doctype html><html lang="${input.resume.locale === "en" ? "en" : "zh-CN"}"><head><meta charset="utf-8"><title>BetterMe</title><style>${css}</style></head><body>${markup}</body></html>`);
      filename = `better-me-${input.resume.locale}-${input.operationId.slice(0, 80)}.pdf`;
    }
    assertCurrent();
    const sourceHash = await finalArtifactSha256(source);
    const output = responseSchema.parse(await options.request("/layout/export", { contextId: options.contextId, operationId: input.operationId,
      format: input.format, contentHash: input.scope.contentHash, inputSha256: sourceHash, inputBase64: encode(source), consent: true }, input.signal));
    assertCurrent();
    if (output.operationId !== input.operationId || output.contextId !== options.contextId || output.format !== input.format || output.contentHash !== input.scope.contentHash || output.sourceSha256 !== sourceHash) throw new Error("最终文件回执不属于本次输入。");
    const artifact = { bytes: decode(output.artifactBase64), sha256: input.format === "pdf" ? output.renderedSha256 : output.sourceSha256, filename };
    if (input.format === "docx" && !output.renderedPdfBase64 || input.format === "pdf" && output.renderedPdfBase64 !== undefined) throw new Error("最终文件格式回执不匹配。");
    return { operationId: input.operationId, format: input.format, scope: { ...input.scope }, renderBinding: { ...input.renderBinding }, artifact,
      ...(output.renderedPdfBase64 ? { renderedPdf: { bytes: decode(output.renderedPdfBase64), sha256: output.renderedSha256, filename: filename.replace(/\.docx$/i, "-rendered.pdf") } } : {}), receipt: output.receipt };
  };
}
