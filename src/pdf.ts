import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument } from 'pdf-lib';
import type { Page, Source } from './model';
import { fontKey, uid } from './model';
import { loadPdfWithTask, PdfEncryptedMergeError } from './pdf-password';
import type { RequestPdfPassword } from './pdf-password';
import { ImageReadError, MAX_PDF_PAGES, PdfPageLimitError, TextImportError } from './pdf-open';
import { decodeText, docxText, imageKind, jpegOrientation, textDocument } from './pdf-engine';
import { rasterizeImage } from './image-raster';

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
const fontPromises = new Map<string, Promise<Uint8Array>>();
export function getFontBytes(style: import('./model').TextStyle = {}) {
  const key = fontKey(style);
  if (!fontPromises.has(key)) fontPromises.set(key, fetch(`/fonts/${key}.ttf`).then(async r => { if (!r.ok) throw new Error('Không tải được phông chữ.'); return new Uint8Array(await r.arrayBuffer()); }).catch(e => { fontPromises.delete(key); throw e; }));
  return fontPromises.get(key)!;
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

const WORD_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const DOC_TYPES = ['.txt', 'text/plain', '.docx', WORD_TYPE];
export const isTextFile = (f: File) => /\.txt$/i.test(f.name) || f.type === 'text/plain';
export const isWordFile = (f: File) => /\.docx$/i.test(f.name) || f.type === WORD_TYPE;

export async function textFileDocument(file: File): Promise<Uint8Array> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = isWordFile(file) ? await docxText(bytes) : decodeText(bytes);
    if (!text.trim()) throw new Error(`Tệp ${file.name} không có văn bản để chuyển sang PDF.`);
    return await textDocument(text, await getFontBytes(), MAX_PDF_PAGES);
  } catch (e) { throw new TextImportError(e instanceof Error && e.message ? e.message : `Không đọc được tệp ${file.name}.`); }
}
