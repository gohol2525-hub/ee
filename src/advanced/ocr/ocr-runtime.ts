import type { Worker as TesseractWorker } from 'tesseract.js';
import type { OcrLanguage, OcrPage, Matrix } from './ocr-engine';
import { ocrPageFromTesseract, ocrRenderScale } from './ocr-engine';
import { abortable, OcrCancelledError } from './cancellation.ts';
export { OcrCancelledError } from './cancellation.ts';

export class OcrLoadError extends Error { constructor(cause: unknown) { super('Không tải được bộ nhận dạng hoặc dữ liệu ngôn ngữ OCR. Hãy kiểm tra kết nối tới trang web này rồi tải lại trang.', { cause }); this.name = 'OcrLoadError'; } }

export interface OcrProgress { label: string; value: number }
export interface OcrRun { pages: number[]; language: OcrLanguage; skipPagesWithText: boolean; signal: AbortSignal; onProgress: (p: OcrProgress) => void }
export interface OcrRunResult { pages: OcrPage[]; skipped: number[] }

const asset = (path: string) => new URL(path, document.baseURI).href;
const LOADING_LABELS: Record<string, string> = {
  'loading tesseract core': 'Đang tải bộ nhận dạng',
  'loading language traineddata': 'Đang tải dữ liệu ngôn ngữ',
  'loaded language traineddata': 'Đang tải dữ liệu ngôn ngữ',
  'initializing tesseract': 'Đang khởi tạo bộ nhận dạng',
  'initializing api': 'Đang khởi tạo bộ nhận dạng',
};

async function startWorker(language: OcrLanguage, onLog: (status: string, progress: number) => void): Promise<TesseractWorker> {
  const { createWorker, OEM } = await import('tesseract.js');
  try {
    return await createWorker(language.split('+'), OEM.LSTM_ONLY, {
      workerPath: asset('/ocr/runtime/worker.min.js'),
      corePath: asset('/ocr/runtime/'),
      langPath: asset('/ocr/lang'),
      cachePath: 'giay-pdf-ocr-4.0.0_best_int',
      workerBlobURL: false,
      gzip: true,
      logger: m => onLog(m.status, m.progress),
      errorHandler: () => {},
    });
  } catch (e) { throw new OcrLoadError(e); }
}

const hasNativeText = async (page: { getTextContent(): Promise<{ items: unknown[] }> }) =>
  (await page.getTextContent()).items.reduce<number>((n, item) => n + (typeof item === 'object' && item && 'str' in item ? String(item.str).replace(/\s/g, '').length : 0), 0) >= 10;

/** Renders and recognizes the zero-based `pages` one by one, so only one page image is held in memory at a time. */
export async function recognizePdf(bytes: Uint8Array, run: OcrRun): Promise<OcrRunResult> {
  const { pages, language, skipPagesWithText, signal, onProgress } = run;
  const { openPdf } = await import('../../pdf');
  const pdf = await openPdf(bytes);
  let worker: TesseractWorker | undefined;
  let current = 0;
  const report = (label: string, pageProgress = 0) => {if(!signal.aborted)onProgress({ label, value: Math.min(1, (current + pageProgress) / pages.length) });};
  const cancel = () => { void worker?.terminate(); };
  signal.addEventListener('abort', cancel);
  const check = () => { if (signal.aborted) throw new OcrCancelledError(); };
  try {
    const results: OcrPage[] = [], skipped: number[] = [];
    for (; current < pages.length; current++) {
      check();
      const index = pages[current], label = `Trang ${index + 1} (${current + 1}/${pages.length})`;
      const page = await pdf.getPage(index + 1);
      if (skipPagesWithText && await hasNativeText(page)) { skipped.push(index); page.cleanup(); continue; }
      report(`${label} · Đang dựng ảnh trang`);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: ocrRenderScale(base.width, base.height) });
      const canvas = document.createElement('canvas');
      const width = canvas.width = Math.floor(viewport.width), height = canvas.height = Math.floor(viewport.height);
      let image: Blob;
      try {
        await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, background: '#ffffff' }).promise;
        image = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Không tạo được ảnh trang để nhận dạng. Thiết bị có thể không đủ bộ nhớ.')), 'image/png'));
      } finally { canvas.width = canvas.height = 0; page.cleanup(); }
      check();
      worker ??= await abortable(startWorker(language, (status, progress) => {
        if (status === 'recognizing text') report(`${label} · Đang nhận dạng chữ`, progress);
        else if (LOADING_LABELS[status]) report(`${LOADING_LABELS[status]}${progress > 0 && progress < 1 ? ` ${Math.round(progress * 100)}%` : ''}`);
      }).then(loaded => {
        if (signal.aborted) { void loaded.terminate(); throw new OcrCancelledError(); }
        return loaded;
      }), signal);
      check();
      report(`${label} · Đang nhận dạng chữ`);
      try {
        const { data } = await abortable(worker!.recognize(image, {}, { text: true, blocks: true }), signal);
        results.push(ocrPageFromTesseract(data, { pageIndex: index, width, height, transform: viewport.transform as Matrix }));
      } catch (e) { check(); throw e; }
    }
    check();
    onProgress({ label: 'Hoàn tất', value: 1 });
    return { pages: results, skipped };
  } finally {
    signal.removeEventListener('abort', cancel);
    await worker?.terminate().catch(() => {});
    await pdf.destroy();
  }
}
