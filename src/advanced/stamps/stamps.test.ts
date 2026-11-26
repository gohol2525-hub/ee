import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFDict, PDFNumber, StandardFonts, concatTransformationMatrix, degrees } from 'pdf-lib';
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { stampPdf, StampError } from './engine.ts';
import { DEFAULT_FORM, formatPageLabel, parseHexColor, scopePages, stampedName, validateStampForm } from './options.ts';
import type { NumbersJob, StampForm, WatermarkJob } from './options.ts';
import { normalizeRotation, toPdfPoint, visibleBox } from './geometry.ts';

const fonts = {
  regular: new Uint8Array(await readFile('public/fonts/NotoSans-Regular.ttf')),
  bold: new Uint8Array(await readFile('public/fonts/NotoSans-Bold.ttf')),
};

interface PageSpec { media: [number, number, number, number]; crop?: [number, number, number, number]; rotation: number; unbalancedCtm?: boolean }

const SPECS: PageSpec[] = [
  { media: [0, 0, 600, 800], rotation: 0 },
  { media: [-100, -50, 600, 800], crop: [-60, -20, 500, 700], rotation: 90 },
  { media: [0, 0, 600, 800], crop: [40, 60, 420, 640], rotation: 180, unbalancedCtm: true },
  { media: [20, 30, 700, 500], crop: [70, 80, 560, 380], rotation: 270 },
];

async function samplePdf(specs = SPECS): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of specs) {
    const page = doc.addPage([100, 100]);
    page.setMediaBox(...spec.media);
    if (spec.crop) page.setCropBox(...spec.crop);
    page.setRotation(degrees(spec.rotation));
    if (spec.unbalancedCtm) page.pushOperators(concatTransformationMatrix(2, 0, 0, 2, 50, 50));
    page.drawText('original', { x: spec.media[0] + 80, y: spec.media[1] + 120, size: 10, font: helvetica });
  }
  return doc.save();
}

interface Placed { str: string; size: number; angle: number; start: [number, number]; mid: [number, number]; end: [number, number]; width: number; height: number }

/** Finds text as the reader sees it: viewport coordinates (y down) after crop and rotation. */
async function placedText(bytes: Uint8Array, skip = 'original'): Promise<Placed[][]> {
  const pdf = await getDocument({ data: bytes.slice(), standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' }).promise;
  try {
    const out: Placed[][] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      out.push(content.items.flatMap(item => {
        if (!('str' in item) || !item.str.trim() || item.str === skip) return [];
        const m = Util.transform(viewport.transform, item.transform);
        const size = Math.hypot(m[0], m[1]);
        const dir = [m[0] / size, m[1] / size];
        const start: [number, number] = [m[4], m[5]];
        const end: [number, number] = [start[0] + dir[0] * item.width, start[1] + dir[1] * item.width];
        return [{ str: item.str, size, angle: Math.atan2(-m[1], m[0]) * 180 / Math.PI, start, end, mid: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2], width: viewport.width, height: viewport.height }];
      }));
    }
    return out;
  } finally { await pdf.destroy(); }
}

const near = (actual: number, expected: number, tolerance: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);

const numbersJob = (patch: Partial<NumbersJob> = {}): NumbersJob => ({
  mode: 'numbers', pages: [0, 1, 2, 3], font: 'NotoSans-Regular', color: [0.2, 0.2, 0.2], opacity: 1, size: 12,
  template: 'Trang {n} / {total}', start: 1, placement: 'bottom-center', margin: 28, ...patch,
});

const watermarkJob = (patch: Partial<WatermarkJob> = {}): WatermarkJob => ({
  mode: 'watermark', pages: [0, 1, 2, 3], font: 'NotoSans-Bold', color: [0.9, 0.3, 0.2], opacity: 0.25, size: 48,
  text: 'BẢN NHÁP – Không sao chép', angle: 45, ...patch,
});

test('geometry maps the visual frame to PDF space for every rotation', () => {
  const box = { x: 10, y: 20, width: 300, height: 500 };
  assert.deepEqual(toPdfPoint(box, 0, 0, 0), { x: 10, y: 20 });
  assert.deepEqual(toPdfPoint(box, 90, 0, 0), { x: 310, y: 20 });
  assert.deepEqual(toPdfPoint(box, 180, 0, 0), { x: 310, y: 520 });
  assert.deepEqual(toPdfPoint(box, 270, 0, 0), { x: 10, y: 520 });
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
  assert.deepEqual(visibleBox({ x: -50, y: 0, width: 200, height: 200 }, { x: 0, y: 0, width: 100, height: 300 }), { x: 0, y: 0, width: 100, height: 200 });
});

test('page numbers sit upright at the visual footer centre on cropped and rotated pages', async () => {
  const input = await samplePdf(), before = input.slice();
  const { bytes, shrunkPages } = await stampPdf(input, numbersJob(), fonts.regular);
  assert.deepEqual(input, before);
  assert.deepEqual(shrunkPages, []);
  const pages = await placedText(bytes);
  for (const [i, items] of pages.entries()) {
    assert.equal(items.length, 1, `page ${i + 1}`);
    const [label] = items;
    assert.equal(label.str, `Trang ${i + 1} / 4`);
    near(label.angle, 0, 0.5, `page ${i + 1} angle`);
    near(label.size, 12, 0.1, `page ${i + 1} size`);
    near(label.mid[0], label.width / 2, 1, `page ${i + 1} centre`);
    // Baseline sits above the bottom margin by the font's descent (about 0.29 em for Noto Sans).
    near(label.start[1], label.height - 28 - 0.293 * 12, 1, `page ${i + 1} baseline`);
  }
  const sizes = pages.map(p => [Math.round(p[0].width), Math.round(p[0].height)]);
  assert.deepEqual(sizes, [[600, 800], [700, 500], [420, 640], [380, 560]]);
});

test('page numbers honour range, start number, total and the top-right placement', async () => {
  const { bytes } = await stampPdf(await samplePdf(), numbersJob({ pages: [1, 2], start: 5, template: '{n}/{total}', placement: 'top-right', margin: 20 }), fonts.regular);
  const pages = await placedText(bytes);
  assert.deepEqual(pages.map(p => p.map(t => t.str)), [[], ['5/6'], ['6/6'], []]);
  for (const label of [pages[1][0], pages[2][0]]) {
    near(label.angle, 0, 0.5, 'angle');
    near(label.end[0], label.width - 20, 1, 'right edge');
    near(label.start[1], 20 + 1.069 * 12, 1.5, 'top baseline');
  }
});

test('left placements start at the margin', async () => {
  const { bytes } = await stampPdf(await samplePdf(), numbersJob({ pages: [3], placement: 'bottom-left', template: '{n}', margin: 10 }), fonts.regular);
  const [label] = (await placedText(bytes))[3];
  assert.equal(label.str, '1');
  near(label.start[0], 10, 0.5, 'left edge');
});

test('Vietnamese watermark is centred and keeps its visual angle on every rotation', async () => {
  const { bytes, shrunkPages } = await stampPdf(await samplePdf(), watermarkJob({ size: 28 }), fonts.bold);
  assert.deepEqual(shrunkPages, []);
  const pages = await placedText(bytes);
  for (const [i, items] of pages.entries()) {
    assert.equal(items.length, 1, `page ${i + 1}`);
    const [mark] = items;
    assert.equal(mark.str, 'BẢN NHÁP – Không sao chép');
    near(mark.angle, 45, 0.5, `page ${i + 1} angle`);
    near(mark.size, 28, 0.1, `page ${i + 1} size`);
    // The baseline midpoint sits below the visual centre by half the line box, perpendicular to the text.
    const offset = Math.hypot(mark.mid[0] - mark.width / 2, mark.mid[1] - mark.height / 2);
    near(offset, 0.388 * 28, 1.5, `page ${i + 1} centre offset`);
    assert.ok(mark.mid[1] > mark.height / 2, `page ${i + 1} baseline below centre`);
  }
  const doc = await PDFDocument.load(bytes);
  const states = doc.getPage(0).node.Resources()!.lookup(PDFName.of('ExtGState'), PDFDict);
  const opacities = states.keys().map(k => (states.lookup(k, PDFDict).get(PDFName.of('ca')) as PDFNumber).asNumber());
  assert.deepEqual(opacities, [0.25]);
});

test('watermarks shrink to fit small pages and support several lines and the current page scope', async () => {
  const input = await samplePdf([{ media: [0, 0, 600, 800], rotation: 0 }, { media: [0, 0, 200, 120], rotation: 90 }]);
  const { bytes, shrunkPages } = await stampPdf(input, watermarkJob({ pages: [1], text: 'MẬT\nKhông phát tán', angle: 0, size: 72 }), fonts.bold);
  assert.deepEqual(shrunkPages, [1]);
  const pages = await placedText(bytes);
  assert.deepEqual(pages[0], []);
  assert.deepEqual(pages[1].map(t => t.str), ['MẬT', 'Không phát tán']);
  for (const line of pages[1]) {
    near(line.angle, 0, 0.5, 'angle');
    near(line.mid[0], line.width / 2, 1, 'horizontal centre');
    assert.ok(line.start[0] >= 0 && line.end[0] <= line.width, 'inside the page');
    assert.ok(line.size < 72);
  }
  assert.ok(pages[1][0].start[1] < pages[1][1].start[1], 'first line is above the second');
});

test('stamping rejects bad input with Vietnamese messages', async () => {
  const input = await samplePdf();
  await assert.rejects(stampPdf(input, numbersJob({ pages: [4] }), fonts.regular), (e: Error) => e instanceof StampError && /1–4/.test(e.message));
  await assert.rejects(stampPdf(input, watermarkJob({ text: 'Dấu 😀' }), fonts.bold), (e: Error) => e instanceof StampError && /không|chưa hỗ trợ/i.test(e.message));
  await assert.rejects(stampPdf(new Uint8Array([1, 2, 3]), watermarkJob(), fonts.bold), /Không đọc được/);
});

const form = (patch: Partial<StampForm>): StampForm => ({ ...DEFAULT_FORM, ...patch });

test('form validation returns localized field errors and zero-based jobs', () => {
  const ok = validateStampForm(form({ mode: 'numbers', scope: 'range', range: '2-3, 5', start: '3', size: '11' }), 5, 0);
  assert.ok(ok.ok);
  assert.deepEqual(ok.job.pages, [1, 2, 4]);
  assert.equal(ok.job.mode === 'numbers' && ok.job.start, 3);
  assert.equal(ok.job.opacity, 0.25);

  const current = validateStampForm(form({ scope: 'current' }), 5, 3);
  assert.ok(current.ok);
  assert.deepEqual(current.job.pages, [3]);

  const bad = validateStampForm(form({ mode: 'numbers', scope: 'range', range: '4-2', template: 'Trang', start: '-1', size: '200', margin: 'abc', color: 'red', opacity: 2 }), 5, 0);
  assert.ok(!bad.ok);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['color', 'margin', 'opacity', 'range', 'size', 'start', 'template']);
  assert.match(bad.errors.template!, /\{n\}/);
  assert.match(bad.errors.range!, /tăng dần/);

  const emptyRange = validateStampForm(form({ scope: 'range', range: ' ' }), 5, 0);
  assert.ok(!emptyRange.ok && /khoảng trang/i.test(emptyRange.errors.range!));
  const watermark = validateStampForm(form({ watermarkText: '  \n ', angle: '200' }), 5, 0);
  assert.ok(!watermark.ok);
  assert.deepEqual(Object.keys(watermark.errors).sort(), ['angle', 'watermarkText']);
  const outOfRange = validateStampForm(form({ scope: 'current' }), 2, 5);
  assert.ok(!outOfRange.ok && outOfRange.errors.pages);
});

test('helpers format labels, colours, scopes and file names', () => {
  assert.equal(formatPageLabel('Trang {n} / {total}', 3, 9), 'Trang 3 / 9');
  assert.deepEqual(parseHexColor('#ff0000'), [1, 0, 0]);
  assert.deepEqual(parseHexColor('0f0'), [0, 1, 0]);
  assert.equal(parseHexColor('#12'), null);
  assert.deepEqual(scopePages('all', '', 3, 0), [0, 1, 2]);
  assert.equal(stampedName('Hợp đồng.PDF', 'numbers'), 'Hợp đồng-danh-so.pdf');
  assert.equal(stampedName('a.pdf', 'watermark'), 'a-dau-chim.pdf');
});
