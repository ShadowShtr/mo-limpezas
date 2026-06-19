// TASK 02 — Compressão de foto no telemóvel antes do upload.
// Reduz o tamanho mantendo qualidade suficiente para comprovar a limpeza.
// Tudo corre no browser; nunca bloqueia indefinidamente (timeout + fallback).

export interface CompressedImage {
  blob: Blob;
  fileName: string;
  mimeType: string;
  width: number;
  height: number;
  originalSize: number;
  compressedSize: number;
}

export interface CompressOptions {
  maxEdge?: number;        // maior lado em px (default 1600)
  initialQuality?: number; // qualidade JPEG/WebP inicial (default 0.78)
  targetBytes?: number;    // alvo de tamanho (default 1.2 MB)
  timeoutMs?: number;      // tempo máx antes de fallback (default 15s)
}

const DEFAULTS = {
  maxEdge: 1600,
  initialQuality: 0.78,
  targetBytes: 1.2 * 1024 * 1024,
  timeoutMs: 15_000,
};

// Garante que apenas uma compressão corre de cada vez (telemóveis fracos).
let activeChain: Promise<unknown> = Promise.resolve();

function pickOutputType(): "image/webp" | "image/jpeg" {
  // WebP comprime melhor; usa-o quando o canvas o suporta.
  try {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    const url = c.toDataURL("image/webp");
    if (url.startsWith("data:image/webp")) return "image/webp";
  } catch { /* fallback abaixo */ }
  return "image/jpeg";
}

function renameTo(name: string, mime: string): string {
  const ext = mime === "image/webp" ? ".webp" : ".jpg";
  return name.replace(/\.[^.]+$/, "") + ext || `foto${ext}`;
}

async function decode(file: File): Promise<{ width: number; height: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; cleanup: () => void }> {
  // createImageBitmap respeita a orientação EXIF e é mais leve que <img>.
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
        cleanup: () => bitmap.close(),
      };
    } catch { /* fallback para <img> */ }
  }

  const url = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("decode-failed"));
    el.src = url;
  });
  return {
    width: img.naturalWidth,
    height: img.naturalHeight,
    draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
    cleanup: () => URL.revokeObjectURL(url),
  };
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, quality));
}

async function compressOnce(file: File, opts: Required<CompressOptions>): Promise<CompressedImage> {
  const src = await decode(file);
  try {
    const outType = pickOutputType();

    async function attempt(maxEdge: number, quality: number): Promise<Blob | null> {
      const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
      const w = Math.max(1, Math.round(src.width * scale));
      const h = Math.max(1, Math.round(src.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      src.draw(ctx, w, h);
      const blob = await toBlob(canvas, outType, quality);
      return blob ? Object.assign(blob, { _w: w, _h: h }) as Blob : null;
    }

    // 1ª tentativa: maxEdge × qualidade inicial.
    let blob = await attempt(opts.maxEdge, opts.initialQuality);
    let usedW = Math.round(src.width * Math.min(1, opts.maxEdge / Math.max(src.width, src.height)));
    let usedH = Math.round(src.height * Math.min(1, opts.maxEdge / Math.max(src.width, src.height)));

    // 2ª: se ainda passa do alvo, baixar qualidade para 0.70.
    if (blob && blob.size > opts.targetBytes) {
      const b2 = await attempt(opts.maxEdge, 0.7);
      if (b2 && b2.size < blob.size) blob = b2;
    }

    // 3ª: se continua grande, reduzir para 1280px.
    if (blob && blob.size > opts.targetBytes) {
      const reduced = Math.min(opts.maxEdge, 1280);
      const b3 = await attempt(reduced, 0.7);
      if (b3 && b3.size < blob.size) {
        blob = b3;
        const s = Math.min(1, reduced / Math.max(src.width, src.height));
        usedW = Math.round(src.width * s);
        usedH = Math.round(src.height * s);
      }
    }

    if (!blob) throw new Error("compress-failed");

    return {
      blob,
      fileName: renameTo(file.name, outType),
      mimeType: outType,
      width: usedW,
      height: usedH,
      originalSize: file.size,
      compressedSize: blob.size,
    };
  } finally {
    src.cleanup();
  }
}

/** Resultado de fallback: devolve o ficheiro original sem alterações. */
function passthrough(file: File): CompressedImage {
  return {
    blob: file,
    fileName: file.name,
    mimeType: file.type || "image/jpeg",
    width: 0,
    height: 0,
    originalSize: file.size,
    compressedSize: file.size,
  };
}

/**
 * Comprime uma imagem no telemóvel. Garante:
 *  - uma compressão de cada vez (serializada);
 *  - timeout com fallback para o ficheiro original;
 *  - nunca lança — em erro devolve o original (o backend ainda valida tamanho).
 */
export async function compressClientImage(
  file: File,
  options: CompressOptions = {},
): Promise<CompressedImage> {
  const opts: Required<CompressOptions> = { ...DEFAULTS, ...options };

  if (!file.type.startsWith("image/")) return passthrough(file);
  // Ficheiros já pequenos não precisam de recompressão.
  if (file.size < 350 * 1024) return passthrough(file);

  const run = async (): Promise<CompressedImage> => {
    const timeout = new Promise<CompressedImage>((resolve) =>
      setTimeout(() => resolve(passthrough(file)), opts.timeoutMs),
    );
    try {
      const result = await Promise.race([compressOnce(file, opts), timeout]);
      // Se a "compressão" ficou maior que o original, usar o original.
      if (result.compressedSize >= file.size) return passthrough(file);
      return result;
    } catch {
      return passthrough(file);
    }
  };

  // Serializa: encadeia na promessa ativa para evitar compressões simultâneas.
  const chained = activeChain.then(run, run);
  activeChain = chained.catch(() => undefined);
  return chained;
}
