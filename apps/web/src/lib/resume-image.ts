export function resumeImageMime(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) return "image/png";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

export function resolveImageCrop(rect: { x: number; y: number; width: number; height: number }, imageWidth: number, imageHeight: number, percentage = true) {
  if (![rect.x, rect.y, rect.width, rect.height, imageWidth, imageHeight].every(Number.isFinite) ||
      rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || imageWidth <= 0 || imageHeight <= 0) throw new Error("裁剪区域必须位于图片内，并具有有效宽度和高度。");
  const x = percentage ? rect.x * imageWidth / 100 : rect.x;
  const y = percentage ? rect.y * imageHeight / 100 : rect.y;
  const width = percentage ? rect.width * imageWidth / 100 : rect.width;
  const height = percentage ? rect.height * imageHeight / 100 : rect.height;
  if (x >= imageWidth || y >= imageHeight) throw new Error("裁剪起点超出图片范围，请重新选择识别区域。");
  if (x + width > imageWidth + 1e-7 || y + height > imageHeight + 1e-7) throw new Error("裁剪区域超出图片边界，请缩小宽度或高度后重试。");
  // Only remove floating point error at a mathematically exact edge.
  return { x, y, width: Math.min(width, imageWidth - x), height: Math.min(height, imageHeight - y) };
}

/** A cancelled or replaced crop must never apply to a subsequently selected file. */
export function createCropTaskRunner() {
  let generation = 0;
  return {
    cancel() { generation += 1; },
    async run<T>(read: () => Promise<T>, apply: (result: T) => void): Promise<boolean> {
      const current = ++generation;
      let result: T;
      try { result = await read(); }
      catch (error) {
        if (current !== generation) return false;
        throw error;
      }
      if (current !== generation) return false;
      apply(result);
      return true;
    },
  };
}

/** Validate actual bytes and decoding; binary image data must never be read as text. */
export async function readResumeImage(file: File): Promise<string> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const mime = resumeImageMime(header);
  if (!mime) throw new Error("图片内容不是有效的 JPG、PNG 或 WebP，请重新导出原图后上传。");
  const blob = new Blob([await file.arrayBuffer()], { type: mime });
  const objectUrl = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        if (!image.naturalWidth || !image.naturalHeight) reject(new Error("图片尺寸无效，请重新选择图片。"));
        else if (image.naturalWidth * image.naturalHeight > 50_000_000) reject(new Error("图片超过 5000 万像素，请按页裁剪后上传，避免浏览器内存不足。"));
        else resolve();
      };
      image.onerror = () => reject(new Error("图片无法解码，文件可能已损坏，请重新导出 JPG / PNG / WebP。"));
      image.src = objectUrl;
    });
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("无法读取图片。"));
      reader.onerror = () => reject(new Error("无法读取图片，请重试。"));
      reader.readAsDataURL(blob);
    });
  } finally { URL.revokeObjectURL(objectUrl); }
}
