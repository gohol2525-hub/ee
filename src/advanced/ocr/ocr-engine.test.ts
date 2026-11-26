import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFRawStream, degrees, decodePDFRawStream } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applyMatrix, compose, invert, isNoiseWord, ocrDocumentText, ocrPageFromTesseract, ocrRenderScale, txtBytes, wordPixelMatrix } from './ocr-engine.ts';
import { addOcrTextLayer } from './ocr-pdf.ts';
import type { Matrix, OcrPage } from './ocr-engine.ts';

const font = () => readFile('public/fonts/NotoSans-Regular.ttf').then(b => new Uint8Array(b));
const textItems = async (bytes: Uint8Array, pageNumber = 1) => {
  const pdf = await getDocument({ data: bytes.slice(), isEvalSupported: false, standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' }).promise;
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  return { page, items: content.items.filter((i): i is typeof i & { str: string; transform: number[] } => 'str' in i && !!i.str.trim()) };
};
const viewportOf = async (bytes: Uint8Array, scale: number) => {
  const pdf = await getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const page = await pdf.getPage(1);
  const v = page.getViewport({ scale });
  return { transform: v.transform as Matrix, width: Math.round(v.width), height: Math.round(v.height) };
};

test('render scale aims for 300 dpi but bounds pixels and side length', () => {
  assert.equal(ocrRenderScale(200, 100), 300 / 72);
  const a4 = ocrRenderScale(595, 842);
  assert.ok(595 * 842 * a4 * a4 <= 8_000_000 + 1);
  assert.ok(Math.max(5000, 100) * ocrRenderScale(5000, 100) <= 4000 + 1e-9);
  assert.throws(() => ocrRenderScale(0, 100));
});

test('matrix helpers invert and compose', () => {
  const m: Matrix = [0, 2, -2, 0, 30, 40];
  const [x, y] = applyMatrix(compose(m, invert(m)), 7, 9);
  assert.ok(Math.abs(x - 7) < 1e-9 && Math.abs(y - 9) < 1e-9);
});

test('tesseract output becomes clean lines and page-marked text', () => {
  const w = (text: string, confidence: number, x0: number) => ({ text, confidence, bbox: { x0, y0: 10, x1: x0 + 40, y1: 40 } });
  const page = ocrPageFromTesseract({ confidence: 81.6, blocks: [{ paragraphs: [
    { lines: [{ bbox: { x0: 0, y0: 10, x1: 200, y1: 40 }, baseline: { x0: 0, y0: 34, x1: 200, y1: 34, has_baseline: true }, rowAttributes: { rowHeight: 30 }, words: [w(':', 20, 0), w('Xin', 90, 10), w('chào', 88, 60), w('. -', 30, 120)] }] },
    { lines: [{ bbox: { x0: 0, y0: 60, x1: 200, y1: 90 }, words: [w('Việt', 91, 0), w('Nam.', 92, 50)] }, { bbox: { x0: 0, y0: 100, x1: 200, y1: 130 }, words: [w('–', 10, 0)] }] },
  ] }] }, { pageIndex: 2, width: 200, height: 300, transform: [1, 0, 0, -1, 0, 300] });
  assert.equal(page.text, 'Xin chào\n\nViệt Nam.');
  assert.equal(page.lines.length, 2);
  assert.equal(page.lines[0].height, 30);
  assert.equal(page.confidence, 82);
  assert.equal(ocrDocumentText([page]), '--- Trang 3 ---\nXin chào\n\nViệt Nam.');
  assert.deepEqual([...txtBytes('a\nđ').slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(new TextDecoder().decode(txtBytes('a\nđ')), 'a\r\nđ');
  assert.equal(isNoiseWord({ text: '2024,', confidence: 10, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }), false);
});

test('decomposed Vietnamese is normalized to NFC', () => {
  const page = ocrPageFromTesseract({ confidence: 90, blocks: [{ paragraphs: [{ lines: [{ bbox: { x0: 0, y0: 0, x1: 9, y1: 9 }, words: [{ text: 'Nguye\u0302\u0303n', confidence: 90, bbox: { x0: 0, y0: 0, x1: 9, y1: 9 } }] }] }] }] }, { pageIndex: 0, width: 9, height: 9, transform: [1, 0, 0, -1, 0, 9] });
  assert.equal(page.text, 'Nguyễn');
});

test('word matrix follows a sloped baseline and spans the word width', () => {
  const line = { words: [], bbox: { x0: 0, y0: 0, x1: 1000, y1: 40 }, baseline: { x0: 0, y0: 30, x1: 1000, y1: 40 }, height: 32 };
  const m = wordPixelMatrix({ text: 'x', confidence: 90, bbox: { x0: 100, y0: 5, x1: 300, y1: 35 } }, line, 0.5);
  assert.ok(Math.abs(m[5] - 31) < 1e-9);
  const [endX] = applyMatrix(m, 0.5, 0);
  assert.ok(Math.abs(endX - 300) < 0.1);
  assert.ok(m[3] < 0);
});

async function scanPdf(rotate = 0) {
  const doc = await PDFDocument.create();
  const jpg = await doc.embedJpg(await readFile('src/advanced/ocr/fixtures/vietnamese-scan.jpg'));
  const page = doc.addPage([595.2, 432]);
  page.drawImage(jpg, { x: 0, y: 0, width: 595.2, height: 432 });
  if (rotate) page.setRotation(degrees(rotate));
  doc.addPage([300, 300]).drawText('Native text', { x: 20, y: 200 });
  return doc.save();
}

test('searchable PDF keeps the scan and adds invisible Vietnamese text where it was recognized', async () => {
  const bytes = await scanPdf();
  const view = await viewportOf(bytes, 1240 / 595.2);
  const result: OcrPage = { pageIndex: 0, ...view, confidence: 90, text: '', lines: [
    { bbox: { x0: 90, y0: 425, x1: 1000, y1: 470 }, baseline: { x0: 90, y0: 462, x1: 1000, y1: 462 }, height: 40, words: [
      { text: 'Nguyễn', confidence: 92, bbox: { x0: 175, y0: 425, x1: 330, y1: 470 } },
      { text: 'Văn', confidence: 92, bbox: { x0: 345, y0: 425, x1: 420, y1: 470 } },
    ] },
  ] };
  const out = await addOcrTextLayer(bytes, [result], await font());
  const before = await PDFDocument.load(bytes), after = await PDFDocument.load(out);
  assert.equal(after.getPageCount(), 2);
  assert.deepEqual(after.getPage(0).getSize(), before.getPage(0).getSize());
  const { items } = await textItems(out);
  const word = items.find(i => i.str.includes('Nguyễn'));
  assert.ok(word, `missing OCR text: ${items.map(i => i.str).join('|')}`);
  const [px, py] = applyMatrix(view.transform, word.transform[4], word.transform[5]);
  assert.ok(Math.abs(px - 175) < 1 && Math.abs(py - 462) < 1, `${px},${py}`);
  const streams = after.getPage(0).node.Contents()!;
  const ops = (after.context.lookup((streams as unknown as { asArray(): unknown[] }).asArray().at(-1) as never) as PDFRawStream);
  assert.match(new TextDecoder().decode(decodePDFRawStream(ops).decode()), /3 Tr/);
  assert.equal((await textItems(out, 2)).items.map(i => i.str).join(''), 'Native text');
});

test('searchable PDF text lines up on rotated pages and after unbalanced page graphics state', async () => {
  const doc = await PDFDocument.load(await scanPdf(90));
  const page = doc.getPage(0);
  page.node.set(PDFName.of('Contents'), doc.context.obj([doc.context.register(doc.context.flateStream('q 0.5 0 0 0.5 0 0 cm')), ...(page.node.Contents() as unknown as { asArray(): never[] }).asArray()]));
  const bytes = await doc.save();
  const view = await viewportOf(bytes, 2);
  assert.equal(view.width, 864);
  const result: OcrPage = { pageIndex: 0, ...view, confidence: 90, text: '', lines: [{ bbox: { x0: 100, y0: 200, x1: 500, y1: 240 }, height: 36, words: [{ text: 'Hương', confidence: 90, bbox: { x0: 120, y0: 200, x1: 260, y1: 240 } }] }] };
  const { items } = await textItems(await addOcrTextLayer(bytes, [result], await font()));
  const word = items.find(i => i.str.includes('Hương'))!;
  assert.ok(word);
  const [px, py] = applyMatrix(view.transform, word.transform[4], word.transform[5]);
  assert.ok(Math.abs(px - 120) < 1 && Math.abs(py - 232) < 1, `${px},${py}`);
});
