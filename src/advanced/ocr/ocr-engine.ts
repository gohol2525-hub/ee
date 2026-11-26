export type OcrLanguage = 'vie' | 'vie+eng' | 'eng';
export type Matrix = [number, number, number, number, number, number];
export interface OcrBox { x0: number; y0: number; x1: number; y1: number }
export interface OcrWord { text: string; confidence: number; bbox: OcrBox }
export interface OcrLine { words: OcrWord[]; bbox: OcrBox; baseline?: OcrBox; height?: number }
/** One recognized page. Pixel coordinates are in the rendered image; `transform` is PDF.js viewport.transform (PDF space → pixels). */
export interface OcrPage { pageIndex: number; width: number; height: number; transform: Matrix; lines: OcrLine[]; text: string; confidence: number }

export const OCR_LANGUAGES: { id: OcrLanguage; label: string }[] = [
  { id: 'vie', label: 'Tiếng Việt (khuyên dùng)' },
  { id: 'vie+eng', label: 'Tiếng Việt + tiếng Anh' },
  { id: 'eng', label: 'Tiếng Anh' },
];

export const OCR_TARGET_DPI = 300;
export const OCR_MAX_SIDE = 4000;
export const OCR_MAX_PIXELS = 8_000_000;

/** Scale for rendering a page (size in PDF points) so OCR gets ~300 dpi without exceeding pixel limits. */
export function ocrRenderScale(width: number, height: number, limits: { dpi?: number; maxSide?: number; maxPixels?: number } = {}): number {
  const { dpi = OCR_TARGET_DPI, maxSide = OCR_MAX_SIDE, maxPixels = OCR_MAX_PIXELS } = limits;
  if (!(width > 0 && height > 0)) throw new Error('Kích thước trang không hợp lệ.');
  return Math.min(dpi / 72, maxSide / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
}

const hasLetterOrDigit = (s: string) => /[\p{L}\p{N}]/u.test(s);
/** Speckles on scans are often read as isolated low-confidence punctuation. */
export const isNoiseWord = (w: OcrWord) => !w.text.trim() || (!hasLetterOrDigit(w.text) && w.confidence < 60);

type TesseractBox = { x0: number; y0: number; x1: number; y1: number };
type TesseractLine = { bbox: TesseractBox; baseline?: TesseractBox & { has_baseline?: boolean }; rowAttributes?: { rowHeight?: number; row_height?: number }; words: { text: string; confidence: number; bbox: TesseractBox }[] };
export type TesseractPageData = { confidence: number; blocks: { paragraphs: { lines: TesseractLine[] }[] }[] | null };

const box = (b: TesseractBox): OcrBox => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });

/** Converts tesseract.js `blocks` output into clean lines/text; paragraphs are separated by a blank line. */
export function ocrPageFromTesseract(data: TesseractPageData, meta: Omit<OcrPage, 'lines' | 'text' | 'confidence'>): OcrPage {
  const lines: OcrLine[] = [];
  const paragraphs: string[] = [];
  for (const block of data.blocks ?? []) for (const paragraph of block.paragraphs) {
    const texts: string[] = [];
    for (const line of paragraph.lines) {
      const words = line.words.map(w => ({ text: w.text.normalize('NFC').trim(), confidence: w.confidence, bbox: box(w.bbox) })).filter(w => !isNoiseWord(w));
      if (!words.length) continue;
      const height = line.rowAttributes?.rowHeight ?? line.rowAttributes?.row_height;
      const baseline = line.baseline && line.baseline.has_baseline !== false && line.baseline.x1 !== line.baseline.x0 ? box(line.baseline) : undefined;
      lines.push({ words, bbox: box(line.bbox), baseline, height: height && height > 0 ? height : undefined });
      texts.push(words.map(w => w.text).join(' '));
    }
    if (texts.length) paragraphs.push(texts.join('\n'));
  }
  return { ...meta, lines, text: paragraphs.join('\n\n'), confidence: Math.round(data.confidence || 0) };
}

export const pageHeading = (pageIndex: number) => `--- Trang ${pageIndex + 1} ---`;
export const ocrDocumentText = (pages: Pick<OcrPage, 'pageIndex' | 'text'>[]) => pages.map(p => `${pageHeading(p.pageIndex)}\n${p.text}`).join('\n\n');
/** UTF-8 with BOM and CRLF so Vietnamese opens correctly in Windows Notepad too. */
export const txtBytes = (text: string) => new TextEncoder().encode('\uFEFF' + text.replace(/\r?\n/g, '\r\n'));
export const baseName = (name: string) => name.replace(/\.pdf$/i, '') || 'tai-lieu';

export function invert([a, b, c, d, e, f]: Matrix): Matrix {
  const det = a * d - b * c;
  if (!det) throw new Error('Không thể đổi tọa độ của trang.');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
/** Matrix that applies `first`, then `then`. */
export const compose = (first: Matrix, then: Matrix): Matrix => [
  first[0] * then[0] + first[1] * then[2], first[0] * then[1] + first[1] * then[3],
  first[2] * then[0] + first[3] * then[2], first[2] * then[1] + first[3] * then[3],
  first[4] * then[0] + first[5] * then[2] + then[4], first[4] * then[1] + first[5] * then[3] + then[5],
];
export const applyMatrix = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Text-space → pixel-space matrix (font size 1) stretching `text` over the word box along the line baseline. */
export function wordPixelMatrix(word: OcrWord, line: OcrLine, naturalWidth: number): Matrix {
  const { x0, y0, x1, y1 } = word.bbox;
  const b = line.baseline;
  const slope = b ? (b.y1 - b.y0) / (b.x1 - b.x0) : 0;
  const angle = Math.atan(slope);
  const baselineY = b ? b.y0 + slope * (x0 - b.x0) : y1 - (y1 - y0) * 0.2;
  const size = Math.max(1, line.height ?? (line.bbox.y1 - line.bbox.y0) * 0.8);
  const width = Math.max(1, (x1 - x0) / Math.cos(angle));
  const stretch = naturalWidth > 0 ? width / (naturalWidth * size) : 1;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return [size * stretch * cos, size * stretch * sin, size * sin, -size * cos, x0, baselineY];
}


export function ocrErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/traineddata|language|lang/i.test(message)) return 'Không tải được dữ liệu ngôn ngữ OCR. Hãy tải lại trang rồi thử lại.';
  if (/TesseractCore|importScripts|wasm|worker/i.test(message)) return 'Không khởi động được bộ nhận dạng chữ trên trình duyệt này. Hãy tải lại trang hoặc dùng trình duyệt mới hơn.';
  if (/memory|allocation|out of bounds/i.test(message)) return 'Thiết bị không đủ bộ nhớ để nhận dạng trang này. Hãy thử từng trang một.';
  if (/password|encrypt/i.test(message)) return 'PDF đang được bảo vệ. Hãy gỡ mật khẩu trước khi nhận dạng chữ.';
  return message && /[À-ỹ]/.test(message) ? message : 'Không nhận dạng được chữ. Hãy thử lại với ít trang hơn.';
}
