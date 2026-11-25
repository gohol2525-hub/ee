import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument } from 'pdf-lib';
import type { Page, Source } from './model';
import { uid } from './model';
import { ImageReadError, MAX_PDF_PAGES, PdfPageLimitError } from './pdf-open';
import { imageKind, jpegOrientation } from './pdf-engine';
import { rasterizeImage } from './image-raster';

GlobalWorkerOptions.workerSrc = workerUrl;
export const openPdf = (bytes: Uint8Array) => getDocument({ data: bytes.slice(), cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/', isEvalSupported: false }).promise;
export type PdfProxy = Awaited<ReturnType<typeof openPdf>>;
export async function loadSource(bytes: Uint8Array, name: string): Promise<{ source: Source; pages: Page[]; pdf: PdfProxy }> {
  // Reject encryption rather than silently stripping permissions or losing encrypted content.
  await PDFDocument.load(bytes);
  const pdf = await openPdf(bytes);
  try {
    if (pdf.numPages > MAX_PDF_PAGES) throw new PdfPageLimitError();
    const id = uid();
    const pages: Page[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      pages.push({ id: uid(), sourceId: id, index: i-1, rotation: p.rotate, width: p.view[2]-p.view[0], height: p.view[3]-p.view[1], originX: p.view[0], originY: p.view[1], annotations: [] });
    }
    return { source: { id, bytes, name }, pages, pdf };
  } catch (error) {
    await pdf.destroy();
    throw error;
  }
}
let fontPromise: Promise<Uint8Array> | undefined;
export function getFontBytes() {
  return fontPromise ??= fetch('/fonts/NotoSans-Regular.ttf').then(async r => { if (!r.ok) throw new Error('Không tải được phông chữ.'); return new Uint8Array(await r.arrayBuffer()); }).catch(e => { fontPromise = undefined; throw e; });
}

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];
export const isImageFile = (f: File) => /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name) || IMAGE_TYPES.includes(f.type);

// pdf-lib only embeds PNG/JPEG and ignores EXIF orientation, so other formats and rotated photos are redrawn upright first.
export async function prepareImage(file: File): Promise<{ bytes: Uint8Array; type: 'image/png' | 'image/jpeg' }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = imageKind(bytes);
  if (kind === 'image/png' || (kind === 'image/jpeg' && jpegOrientation(bytes) <= 1)) return { bytes, type: kind };
  const type = kind === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  try {
    const { blob } = await rasterizeImage(file, type);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type };
  } catch { throw new ImageReadError(file.name); }
}
