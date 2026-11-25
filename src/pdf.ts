import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument } from 'pdf-lib';
import type { Page, Source } from './model';
import { uid } from './model';

GlobalWorkerOptions.workerSrc = workerUrl;
export const openPdf = (bytes: Uint8Array) => getDocument({ data: bytes.slice(), cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/', isEvalSupported: false }).promise;
export type PdfProxy = Awaited<ReturnType<typeof openPdf>>;
export async function loadSource(bytes: Uint8Array, name: string): Promise<{ source: Source; pages: Page[]; pdf: PdfProxy }> {
  // Reject encryption rather than silently stripping permissions or losing encrypted content.
  await PDFDocument.load(bytes);
  const pdf = await openPdf(bytes);
  if (pdf.numPages > 200) { await pdf.destroy(); throw new Error('Vui lòng chọn PDF không quá 200 trang.'); }
  const id = uid();
  const pages: Page[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    pages.push({ id: uid(), sourceId: id, index: i-1, rotation: p.rotate, width: p.view[2]-p.view[0], height: p.view[3]-p.view[1], originX: p.view[0], originY: p.view[1], annotations: [] });
  }
  return { source: { id, bytes, name }, pages, pdf };
}
let fontPromise: Promise<Uint8Array> | undefined;
export function getFontBytes() {
  return fontPromise ??= fetch('/fonts/NotoSans-Regular.ttf').then(async r => { if (!r.ok) throw new Error('Không tải được phông chữ.'); return new Uint8Array(await r.arrayBuffer()); }).catch(e => { fontPromise = undefined; throw e; });
}
