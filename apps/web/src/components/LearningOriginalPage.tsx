import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type {
  LearningMaterial,
  LearningPage,
} from "@better-me/agent-contracts";
import type { LearningClient } from "../services/learning-client";

const assets = {
  cMapUrl: import.meta.glob<string>(
    "../../node_modules/pdfjs-dist/cmaps/*.bcmap",
    { eager: true, query: "?url", import: "default" },
  ),
  standardFontDataUrl: import.meta.glob<string>(
    "../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}",
    { eager: true, query: "?url", import: "default" },
  ),
};
// Only bundled, matching PDF.js assets. No document-controlled external URLs.
class LearningBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const catalog =
      kind === "cMapUrl"
        ? assets.cMapUrl
        : kind === "standardFontDataUrl"
          ? assets.standardFontDataUrl
          : {};
    const url = Object.entries(catalog).find(
      ([key]) => key.split("/").at(-1) === filename,
    )?.[1];
    if (!url) throw new Error("PDF 本地字体资源不可用");
    const result = await fetch(url, { credentials: "omit" });
    if (!result.ok) throw new Error("PDF 本地字体资源读取失败");
    return new Uint8Array(await result.arrayBuffer());
  }
}

export function LearningOriginalPage({
  material,
  page,
  blockId,
  client,
}: {
  material: LearningMaterial;
  page: LearningPage;
  blockId?: string;
  client: LearningClient;
}) {
  const readBytes = useCallback(
    (signal: AbortSignal) => client.bytes(material, signal),
    [client, material],
  );
  const block = page.blocks.find((item) => item.id === blockId);
  if (material.revoked) return null;
  const caption = `原件 · 第 ${page.number} 页${blockId ? ` · 段落 ${blockId}` : ""}`;
  if (material.mediaType === "application/pdf")
    return (
      <LearningPdfPreview
        readBytes={readBytes}
        number={page.number}
        caption={caption}
        ariaLabel={`原 PDF 第 ${page.number} 页${blockId ? `，高亮 ${blockId}` : ""}`}
        box={block?.box}
      />
    );
  return (
    <figure className="learning-original">
      <figcaption>{caption}</figcaption>
      <pre>
        {block?.text ?? page.blocks.map((item) => item.text).join("\n\n")}
      </pre>
    </figure>
  );
}

/** Source and translated drafts share the same inert canvas renderer, but each
 * caller supplies its own authenticated, byte/hash-verified artifact reader. */
export function LearningPdfPreview({
  readBytes,
  number,
  caption,
  ariaLabel = caption,
  box,
  showText = false,
}: {
  readBytes: (signal: AbortSignal) => Promise<Uint8Array>;
  number: number;
  caption: string;
  ariaLabel?: string;
  box?: [number, number, number, number];
  showText?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("正在核对字节并绘制本页…");
  const [text, setText] = useState("");
  useEffect(() => {
    let live = true,
      loading: pdfjs.PDFDocumentLoadingTask | undefined,
      rendering: pdfjs.RenderTask | undefined;
    const abort = new AbortController();
    setStatus("正在核对字节并绘制本页…");
    setText("");
    void (async () => {
      const bytes = await readBytes(abort.signal);
      if (!live) return;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      loading = pdfjs.getDocument({
        data: bytes,
        useWorkerFetch: false,
        BinaryDataFactory: LearningBinaryDataFactory,
        useWasm: false,
        stopAtErrors: true,
        maxImageSize: 16_000_000,
        canvasMaxAreaInBytes: 32_000_000,
      });
      const pdf = await loading.promise,
        original = await pdf.getPage(number);
      if (!live || !canvas.current) return;
      const dimensions = original.getViewport({ scale: 1 });
      const scale = Math.min(
          1.5,
          1000 / dimensions.width,
          1600 / dimensions.height,
        ),
        viewport = original.getViewport({ scale });
      const target = canvas.current;
      target.width = viewport.width;
      target.height = viewport.height;
      rendering = original.render({ canvas: target, viewport });
      await rendering.promise;
      if (!live) return;
      if (box) {
        const [x, y, width, height] = box;
        const [x1, y1] = viewport.convertToViewportPoint(x, y) as [
          number,
          number,
        ];
        const [x2, y2] = viewport.convertToViewportPoint(
          x + width,
          y + height,
        ) as [number, number];
        const context = target.getContext("2d")!;
        context.fillStyle = "rgba(52,146,102,0.16)";
        context.strokeStyle = "#278358";
        context.lineWidth = 2;
        context.fillRect(
          Math.min(x1, x2) - 3,
          Math.min(y1, y2) - 3,
          Math.abs(x2 - x1) + 6,
          Math.abs(y2 - y1) + 6,
        );
        context.strokeRect(
          Math.min(x1, x2) - 3,
          Math.min(y1, y2) - 3,
          Math.abs(x2 - x1) + 6,
          Math.abs(y2 - y1) + 6,
        );
      }
      if (showText) {
        const content = await original.getTextContent();
        if (live)
          setText(
            content.items
              .filter((item) => "str" in item)
              .map((item) => ("str" in item ? item.str : ""))
              .join("\n"),
          );
      }
      setStatus("");
    })().catch((error) => {
      if (live)
        setStatus(
          `本页未能绘制：${error instanceof Error ? error.message : "读取失败"}。未改用外部预览。`,
        );
    });
    return () => {
      live = false;
      abort.abort();
      rendering?.cancel();
      void loading?.destroy();
    };
  }, [readBytes, number, box, showText]);
  return (
    <figure className="learning-original">
      <figcaption>{caption}</figcaption>
      <canvas ref={canvas} aria-label={ariaLabel} />
      {status && <p role="status">{status}</p>}
      {showText && !status && (
        <details className="translation-extracted">
          <summary>本页可提取文本（不代表阅读顺序正确）</summary>
          <pre>{text || "本页没有可提取文本。"}</pre>
        </details>
      )}
    </figure>
  );
}
