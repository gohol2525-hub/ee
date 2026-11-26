import { AnnotationMode } from 'pdfjs-dist';
import { openPdf, type PdfProxy } from '../../pdf';
import { pageGeometry, type RasterSource } from './engine.ts';

type PdfPage = Awaited<ReturnType<PdfProxy['getPage']>>;

async function canvasJpeg(canvas: HTMLCanvasElement, quality: number) {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob || blob.type !== 'image/jpeg') throw new Error('Trình duyệt không tạo được ảnh JPEG.');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Opens a PDF with PDF.js and renders each visible page box, annotations and form appearances included, onto a white canvas. */
export async function openRasterSource(bytes: Uint8Array): Promise<RasterSource & { destroy: () => Promise<void> }> {
  const pdf = await openPdf(bytes);
  const pages = new Map<number, PdfPage>();
  const page = async (index: number) => {
    let p = pages.get(index);
    if (!p) { p = await pdf.getPage(index + 1); pages.set(index, p); }
    return p;
  };
  return {
    pageCount: pdf.numPages,
    geometry: async index => { const p = await page(index); return pageGeometry(p.view, p.rotate); },
    renderJpeg: async (index, size, quality) => {
      const p = await page(index);
      const base = p.getViewport({ scale: 1, rotation: 0 });
      const viewport = base.clone({ scale: Math.min(size.pixelWidth / base.width, size.pixelHeight / base.height) });
      const canvas = document.createElement('canvas');
      canvas.width = size.pixelWidth; canvas.height = size.pixelHeight;
      try {
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Trình duyệt không tạo được vùng vẽ.');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await p.render({ canvas, canvasContext: context, viewport, background: '#ffffff', annotationMode: AnnotationMode.ENABLE }).promise;
        return await canvasJpeg(canvas, quality);
      } finally {
        canvas.width = 0; canvas.height = 0;
      }
    },
    releasePage: index => { pages.get(index)?.cleanup(); pages.delete(index); },
    destroy: () => pdf.destroy(),
  };
}
