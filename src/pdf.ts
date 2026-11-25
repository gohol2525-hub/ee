import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument } from 'pdf-lib';
import type { Page, Source } from './model';
import { uid } from './model';
import { loadPdfWithTask, PdfEncryptedMergeError } from './pdf-password';
import type { RequestPdfPassword } from './pdf-password';
import { ImageReadError, MAX_PDF_PAGES, PdfPageLimitError } from './pdf-open';
import { imageKind, jpegOrientation } from './pdf-engine';

GlobalWorkerOptions.workerSrc = workerUrl;
const createPdfLoadingTask = (bytes: Uint8Array) => getDocument({ data: bytes.slice(), cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/', isEvalSupported: false });
export const openPdf = (bytes: Uint8Array) => loadPdfWithTask(createPdfLoadingTask(bytes), pdf => pdf);
export type PdfProxy = Awaited<ReturnType<typeof openPdf>>;
export async function loadSource(bytes: Uint8Array, name: string, requestPassword?: RequestPdfPassword): Promise<{ source: Source; pages: Page[]; pdf: PdfProxy; readOnly: boolean }> {
  const { isEncrypted: readOnly } = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (readOnly && !requestPassword) throw new PdfEncryptedMergeError();
  return loadPdfWithTask(createPdfLoadingTask(bytes), async pdf => {
    if (pdf.numPages > MAX_PDF_PAGES) throw new PdfPageLimitError();
    const id = uid();
    const pages: Page[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      pages.push({ id: uid(), sourceId: id, index: i-1, rotation: p.rotate, width: p.view[2]-p.view[0], height: p.view[3]-p.view[1], originX: p.view[0], originY: p.view[1], annotations: [] });
    }
    return { source: { id, bytes, name }, pages, pdf, readOnly };
  }, readOnly ? requestPassword : undefined);
}
let fontPromise: Promise<Uint8Array> | undefined;
export function getFontBytes() {
  return fontPromise ??= fetch('/fonts/NotoSans-Regular.ttf').then(async r => { if (!r.ok) throw new Error('Không tải được phông chữ.'); return new Uint8Array(await r.arrayBuffer()); }).catch(e => { fontPromise = undefined; throw e; });
}

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];
export const isImageFile = (f: File) => /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name) || IMAGE_TYPES.includes(f.type);
// Safari refuses canvases above ~16.7M pixels (e.g. 48 MP iPhone photos).
const MAX_CANVAS_PIXELS = 16_000_000;

// pdf-lib only embeds PNG/JPEG and ignores EXIF orientation, so other formats and rotated photos are redrawn upright first.
export async function prepareImage(file: File): Promise<{ bytes: Uint8Array; type: 'image/png' | 'image/jpeg' }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = imageKind(bytes);
  if (kind === 'image/png' || (kind === 'image/jpeg' && jpegOrientation(bytes) <= 1)) return { bytes, type: kind };
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: file.type }), { imageOrientation: 'from-image' }); }
  catch { throw new ImageReadError(file.name); }
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (bitmap.width * bitmap.height)));
  canvas.width = Math.max(1, Math.floor(bitmap.width * scale)); canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const type = kind === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, .92));
  canvas.width = 0; canvas.height = 0;
  if (!blob) throw new ImageReadError(file.name);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type };
}
