import type { ChatMessage } from "@better-me/agent-contracts";

export type ChatImageAttachment = NonNullable<ChatMessage["attachments"]>[number];
export const MAX_CHAT_IMAGE_BYTES = 2_000_000;
export const MAX_CHAT_IMAGES = 3;
const mimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Read the original bytes once. No canvas, resampling, format conversion or clipping. */
export function readChatImage(file: File): Promise<ChatImageAttachment> {
  if (!mimeTypes.has(file.type.toLowerCase())) return Promise.reject(new Error("unsupported_type"));
  if (!file.size || file.size > MAX_CHAT_IMAGE_BYTES) return Promise.reject(new Error("image_too_large"));
  const name = file.name || "image";
  if (name.length > 160) return Promise.reject(new Error("image_name_too_long"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reader.onabort = () => reject(new Error("image_read_failed"));
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string" || !dataUrl.toLowerCase().startsWith(`data:${file.type.toLowerCase()};base64,`)) {
        reject(new Error("image_read_failed")); return;
      }
      resolve({ name, mimeType: file.type.toLowerCase(), dataUrl });
    };
    reader.readAsDataURL(file);
  });
}

export function chatImageErrorMessage(error: unknown, t: (zh: string, en: string) => string): string {
  const code = error instanceof Error ? error.message : "image_read_failed";
  if (code === "unsupported_type") return t("图片格式仅支持 PNG、JPEG 或 WebP。", "Only PNG, JPEG or WebP images are supported.");
  if (code === "image_too_large") return t("原始图片需为 1 字节至 2 MB；未压缩或裁切，请自行选择合适的文件。", "Choose an original image between 1 byte and 2 MB. Nothing was compressed or cropped.");
  if (code === "image_name_too_long") return t("图片文件名超过 160 字符；未截短，请重命名后选择。", "The image filename exceeds 160 characters. Rename it to attach it; it was not shortened.");
  return t("图片读取失败，请重新选择。", "Could not read the image. Please choose it again.");
}
