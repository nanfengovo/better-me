import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import mammoth from "mammoth";
import { readResumeImage, resolveImageCrop } from "./resume-image";
import { reflowPdfText } from "./pdf-text";

// Register the worker as a Vite asset so linked dependencies are served safely
// in development and the matching, local worker is emitted for production.
if (typeof window !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

export interface ExtractedFileResult {
  fileName: string;
  fileType: "pdf" | "docx" | "doc" | "html" | "md" | "txt" | "json" | "image" | "unknown";
  rawText: string;
  isScannedPdf: boolean;
  pageImages: string[];
  detectedAvatars: string[];
  charCount: number;
  numPages?: number;
}

/**
 * Extracts plain text and structure from uploaded resume files:
 * Supports: .pdf, .docx, .doc, .html/.htm, .md, .txt, .json
 */
export async function extractTextFromFile(file: File): Promise<ExtractedFileResult> {
  const fileName = file.name;
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();

  switch (ext) {
    case ".jpg":
    case ".jpeg":
    case ".png":
    case ".webp": {
      const pageImage = await readResumeImage(file);
      return { fileName, fileType: "image", rawText: "", isScannedPdf: false, pageImages: [pageImage], detectedAvatars: [], charCount: 0, numPages: 1 };
    }
    case ".pdf":
      return extractFromPdf(file);
    case ".docx":
      return extractFromDocx(file);
    case ".doc":
      return extractFromDoc(file);
    case ".html":
    case ".htm":
      return extractFromHtml(file);
    case ".md":
    case ".markdown":
      return extractFromPlainText(file, "md");
    case ".txt":
      return extractFromPlainText(file, "txt");
    case ".json":
      return extractFromPlainText(file, "json");
    default:
      throw new Error("暂不支持此文件格式。请选择 PDF、DOCX、DOC、HTML、Markdown、TXT、JSON 或 JPG / PNG / WebP 图片。");
  }
}

/**
 * Convert a PDF.js image object to a base64 Data URL.
 */
function convertPdfImageObjToDataUrl(imageObj: any): string | null {
  if (!imageObj) return null;
  try {
    const width = Number(imageObj.width);
    const height = Number(imageObj.height);
    if (!width || !height || width < 48 || height < 48) return null;

    // Filter out thin divider lines or banners
    const ratio = width / height;
    if (ratio < 0.4 || ratio > 2.5) return null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    if (imageObj.bitmap && typeof ctx.drawImage === "function") {
      ctx.drawImage(imageObj.bitmap, 0, 0);
      return canvas.toDataURL("image/jpeg", 0.92);
    }

    if (imageObj.data) {
      const imgData = ctx.createImageData(width, height);
      const data = imageObj.data;
      const dataLen = data.length;

      if (dataLen === width * height * 4) {
        imgData.data.set(data);
      } else if (dataLen === width * height * 3) {
        let src = 0;
        for (let dst = 0; dst < imgData.data.length; dst += 4) {
          imgData.data[dst] = data[src++];
          imgData.data[dst + 1] = data[src++];
          imgData.data[dst + 2] = data[src++];
          imgData.data[dst + 3] = 255;
        }
      } else if (dataLen === width * height) {
        let src = 0;
        for (let dst = 0; dst < imgData.data.length; dst += 4) {
          const val = data[src++];
          imgData.data[dst] = val;
          imgData.data[dst + 1] = val;
          imgData.data[dst + 2] = val;
          imgData.data[dst + 3] = 255;
        }
      } else {
        return null;
      }

      ctx.putImageData(imgData, 0, 0);
      return canvas.toDataURL("image/jpeg", 0.92);
    }
  } catch (err) {
    console.warn("Failed to convert PDF image object:", err);
  }
  return null;
}

/**
 * Extracts embedded image objects from a PDF page using operator lists.
 */
async function extractEmbeddedImagesFromPdfPage(page: any): Promise<string[]> {
  const images: string[] = [];
  try {
    const opList = await page.getOperatorList();
    const fnArray = opList.fnArray;
    const argsArray = opList.argsArray;
    const seenKeys = new Set<string>();

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      if (
        fn === pdfjsLib.OPS.paintImageXObject ||
        fn === pdfjsLib.OPS.paintInlineImageXObject ||
        fn === pdfjsLib.OPS.paintImageMaskXObject
      ) {
        const objId = argsArray[i]?.[0];
        if (!objId || seenKeys.has(objId)) continue;
        seenKeys.add(objId);

        try {
          const imgObj = await new Promise((resolve) => {
            try {
              if (page.objs && typeof page.objs.get === "function") {
                const res = page.objs.get(objId, (data: any) => resolve(data));
                if (res !== undefined) resolve(res);
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            }
            setTimeout(() => resolve(null), 300);
          });

          if (imgObj) {
            const dataUrl = convertPdfImageObjToDataUrl(imgObj);
            if (dataUrl) {
              images.push(dataUrl);
            }
          }
        } catch {
          // ignore individual image read error
        }
      }
    }
  } catch (err) {
    console.warn("Operator list image extraction skipped:", err);
  }
  return images;
}

/**
 * Detects if a canvas region is likely a photograph (not empty whitespace or plain text).
 */
function isPhotographicRegion(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  try {
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    const totalPixels = width * height;
    if (totalPixels < 100) return false;

    const step = Math.max(1, Math.floor(totalPixels / 1200));
    let sampleCount = 0;
    let sumR = 0, sumG = 0, sumB = 0;
    let coloredPixels = 0;
    let nonWhitePixels = 0;

    for (let i = 0; i < data.length; i += step * 4) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const a = data[i + 3] ?? 255;

      if (a < 50) continue;

      sampleCount++;
      sumR += r;
      sumG += g;
      sumB += b;

      if (r < 240 || g < 240 || b < 240) {
        nonWhitePixels++;
      }

      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      if (maxC - minC > 16) {
        coloredPixels++;
      }
    }

    if (sampleCount === 0) return false;

    const nonWhiteRatio = nonWhitePixels / sampleCount;
    if (nonWhiteRatio < 0.15) return false;

    const meanR = sumR / sampleCount;
    const meanG = sumG / sampleCount;
    const meanB = sumB / sampleCount;

    let varSum = 0;
    for (let i = 0; i < data.length; i += step * 4) {
      const dr = (data[i] ?? 0) - meanR;
      const dg = (data[i + 1] ?? 0) - meanG;
      const db = (data[i + 2] ?? 0) - meanB;
      varSum += dr * dr + dg * dg + db * db;
    }
    const variance = varSum / sampleCount;
    const colorRatio = coloredPixels / sampleCount;

    return variance > 500 && (colorRatio > 0.10 || nonWhiteRatio > 0.35);
  } catch {
    return false;
  }
}

/**
 * Scans standard resume candidate regions on Page 1 canvas to detect photo crops.
 */
function detectAndCropPhotosFromPageCanvas(sourceCanvas: HTMLCanvasElement): string[] {
  const candidates: string[] = [];
  try {
    const W = sourceCanvas.width;
    const H = sourceCanvas.height;

    // Typical resume photo regions in standard 1寸/2寸 proportions
    const regions = [
      { x: 0.70, y: 0.025, w: 0.24, h: 0.20 }, // Top Right outer
      { x: 0.62, y: 0.025, w: 0.24, h: 0.20 }, // Top Right inner
      { x: 0.04, y: 0.025, w: 0.24, h: 0.20 }, // Top Left outer
      { x: 0.04, y: 0.035, w: 0.28, h: 0.22 }, // Top Left sidebar
    ];

    for (const r of regions) {
      const rx = Math.round(W * r.x);
      const ry = Math.round(H * r.y);
      const rw = Math.round(W * r.w);
      const rh = Math.round(H * r.h);

      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = rw;
      cropCanvas.height = rh;
      const cropCtx = cropCanvas.getContext("2d");
      if (!cropCtx) continue;

      cropCtx.drawImage(sourceCanvas, rx, ry, rw, rh, 0, 0, rw, rh);

      if (isPhotographicRegion(cropCtx, rw, rh)) {
        candidates.push(cropCanvas.toDataURL("image/jpeg", 0.92));
        if (candidates.length >= 2) break;
      }
    }
  } catch (e) {
    console.warn("Canvas photo candidate detection error:", e);
  }
  return candidates;
}

/**
 * PDF text extraction with layout-aware line grouping + avatar detection + canvas rendering
 */
async function extractFromPdf(file: File): Promise<ExtractedFileResult> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    useSystemFonts: true,
  });

  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  const textChunks: string[] = [];
  const pageImages: string[] = [];
  const detectedAvatars: string[] = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    const pageText = reflowPdfText(textContent.items.filter((item) => "str" in item));

    if (pageText.trim()) {
      textChunks.push(pageText.trim());
    }

    // Render page as image thumbnail for preview, avatar extraction, or vision OCR
    try {
      const scale = pageNum === 1 ? 1.5 : 1.0;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const context = canvas.getContext("2d");
      if (context) {
        await (page as any).render({ canvasContext: context, viewport }).promise;
        pageImages.push(canvas.toDataURL("image/jpeg", 0.85));

        // On Page 1: extract embedded image objects and detect photo crops
        if (pageNum === 1) {
          try {
            const embeddedImages = await extractEmbeddedImagesFromPdfPage(page);
            for (const img of embeddedImages) {
              if (!detectedAvatars.includes(img)) {
                detectedAvatars.push(img);
              }
            }

            const canvasPhotos = detectAndCropPhotosFromPageCanvas(canvas);
            for (const photo of canvasPhotos) {
              if (!detectedAvatars.includes(photo)) {
                detectedAvatars.push(photo);
              }
            }
          } catch (e) {
            console.warn("Page 1 avatar extraction error:", e);
          }
        }
      }
    } catch (e) {
      console.warn("PDF page thumbnail rendering skipped:", e);
    }
  }

  const combinedText = textChunks.join("\n\n");
  const charCount = combinedText.replace(/\s/g, "").length;
  const isScannedPdf = charCount < 50 && numPages > 0;

  return {
    fileName: file.name,
    fileType: "pdf",
    rawText: combinedText,
    isScannedPdf,
    pageImages,
    detectedAvatars,
    charCount,
    numPages,
  };
}

/**
 * Word DOCX extraction via Mammoth with embedded image extraction
 */
async function extractFromDocx(file: File): Promise<ExtractedFileResult> {
  const arrayBuffer = await file.arrayBuffer();
  try {
    const result = await mammoth.extractRawText({ arrayBuffer });
    const rawText = result.value.trim();

    const detectedAvatars: string[] = [];
    try {
      const mammothAny = mammoth as any;
      const htmlResult = await mammothAny.convertToHtml(
        { arrayBuffer },
        {
          convertImage: mammothAny.images?.imgElement?.(async (image: any) => {
            const buffer = await image.read("base64");
            return {
              src: `data:${image.contentType};base64,${buffer}`,
            };
          }),
        },
      );
      const imgRegex = /<img[^>]+src=["'](data:image\/[^"']+)["']/gi;
      let m: RegExpExecArray | null;
      while ((m = imgRegex.exec(htmlResult.value)) !== null) {
        if (m[1] && m[1].length > 1200) {
          detectedAvatars.push(m[1]);
        }
      }
    } catch (e) {
      console.warn("DOCX 图片提取跳过:", e);
    }

    return {
      fileName: file.name,
      fileType: "docx",
      rawText,
      isScannedPdf: false,
      pageImages: [],
      detectedAvatars,
      charCount: rawText.length,
    };
  } catch (err) {
    throw new Error(`DOCX 解析失败: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/**
 * Word DOC (Legacy binary 97-2003 format) fallback
 */
async function extractFromDoc(file: File): Promise<ExtractedFileResult> {
  // Mammoth occasionally parses simple binary doc files, otherwise fallback to text extraction
  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    if (result.value.trim().length > 20) {
      return {
        fileName: file.name,
        fileType: "doc",
        rawText: result.value.trim(),
        isScannedPdf: false,
        pageImages: [],
        detectedAvatars: [],
        charCount: result.value.trim().length,
      };
    }
  } catch {
    // ignore mammoth error on binary doc
  }

  // Fallback: read text streams from binary file
  const text = await file.text();
  const readableText = text
    // eslint-disable-next-line no-control-regex -- Legacy DOC text recovery intentionally strips binary control characters while preserving line breaks and tabs.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, " ")
    .replace(/\s{2,}/g, "\n")
    .trim();

  return {
    fileName: file.name,
    fileType: "doc",
    rawText: readableText,
    isScannedPdf: false,
    pageImages: [],
    detectedAvatars: [],
    charCount: readableText.length,
  };
}

/**
 * HTML resume extraction with DOM formatting and image extraction
 */
async function extractFromHtml(file: File): Promise<ExtractedFileResult> {
  const htmlContent = await file.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, "text/html");

  const detectedAvatars: string[] = [];
  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (src && (src.startsWith("data:image/") || src.startsWith("http") || src.startsWith("blob:"))) {
      detectedAvatars.push(src);
    }
  });

  // Remove scripts, styles, metadata
  doc.querySelectorAll("script, style, link, meta, noscript").forEach((el) => el.remove());

  // Replace block elements with line breaks before text extraction
  const blocks = doc.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, tr, div, section, article");
  blocks.forEach((el) => {
    el.prepend(document.createTextNode("\n"));
    el.append(document.createTextNode("\n"));
  });

  const rawText = (doc.body.textContent || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");

  return {
    fileName: file.name,
    fileType: "html",
    rawText,
    isScannedPdf: false,
    pageImages: [],
    detectedAvatars,
    charCount: rawText.length,
  };
}

/**
 * Plain text / Markdown / JSON extraction
 */
async function extractFromPlainText(
  file: File,
  type: "md" | "txt" | "json" | "unknown",
): Promise<ExtractedFileResult> {
  const rawText = (await file.text()).trim();
  return {
    fileName: file.name,
    fileType: type,
    rawText,
    isScannedPdf: false,
    pageImages: [],
    detectedAvatars: [],
    charCount: rawText.length,
  };
}

/**
 * Crops a sub-region from an image data URL (e.g. Page 1 canvas screenshot)
 * using percentage coordinates (0-100) or pixel coordinates.
 */
export async function cropImageRegion(
  sourceImageUrl: string,
  rect: { x: number; y: number; width: number; height: number },
  isPercentage = true,
  outputType: "image/jpeg" | "image/png" = "image/jpeg",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const { x: clampedX, y: clampedY, width: clampedW, height: clampedH } = resolveImageCrop(rect, img.width, img.height, isPercentage);

        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(clampedW));
        canvas.height = Math.max(1, Math.round(clampedH));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("浏览器无法创建图片裁剪画布，请重试。"));
          return;
        }

        ctx.drawImage(
          img,
          clampedX,
          clampedY,
          clampedW,
          clampedH,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        resolve(canvas.toDataURL(outputType, 0.92));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error("Failed to load source image for cropping"));
    img.src = sourceImageUrl;
  });
}

/**
 * Crops a normalized bounding box [ymin, xmin, ymax, xmax] (0-1000 scale, as returned by Gemini Vision)
 * from a Page 1 image data URL.
 */
export async function cropBboxFromImage(
  sourceImageUrl: string,
  bbox: [number, number, number, number] | number[],
): Promise<string> {
  const [ymin, xmin, ymax, xmax] = bbox;
  return cropImageRegion(
    sourceImageUrl,
    {
      x: (xmin ?? 0) / 10,
      y: (ymin ?? 0) / 10,
      width: ((xmax ?? 1000) - (xmin ?? 0)) / 10,
      height: ((ymax ?? 1000) - (ymin ?? 0)) / 10,
    },
    true,
  );
}
