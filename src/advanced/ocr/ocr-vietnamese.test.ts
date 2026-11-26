import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker, OEM } from 'tesseract.js';
import { ocrPageFromTesseract } from './ocr-engine.ts';
import { addOcrTextLayer } from './ocr-pdf.ts';
import type { Matrix } from './ocr-engine.ts';

const EXPECTED = `CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM
Độc lập - Tự do - Hạnh phúc
GIẤY XÁC NHẬN
Hôm nay, ngày 15 tháng 3 năm 2024, tại Hà Nội, chúng tôi xác nhận
ông Nguyễn Văn Bình đã hoàn thành khóa đào tạo quản lý tài liệu.
Mọi thông tin trong giấy này được lưu trữ an toàn trên thiết bị.
Người ký: Trần Thị Hương Giang`;

const squash = (s: string) => s.normalize('NFC').replace(/\s+/g, '');
function distance(a: string, b: string) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) { const tmp = prev[j]; prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1)); diag = tmp; }
  }
  return prev[b.length];
}

test('recognizes a noisy Vietnamese scan with bundled language data and makes it searchable', { timeout: 120_000 }, async () => {
  const image = await readFile('src/advanced/ocr/fixtures/vietnamese-scan.jpg');
  const doc = await PDFDocument.create();
  doc.addPage([595.2, 432]).drawImage(await doc.embedJpg(image), { x: 0, y: 0, width: 595.2, height: 432 });
  const pdfBytes = await doc.save();
  const pdfPage = await (await getDocument({ data: pdfBytes.slice(), isEvalSupported: false }).promise).getPage(1);
  const viewport = pdfPage.getViewport({ scale: 1240 / 595.2 });

  const worker = await createWorker(['vie'], OEM.LSTM_ONLY, { langPath: 'public/ocr/lang', cacheMethod: 'none', gzip: true });
  try {
    const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
    const page = ocrPageFromTesseract(data, { pageIndex: 0, width: 1240, height: 900, transform: viewport.transform as Matrix });
    const cer = distance(squash(page.text), squash(EXPECTED)) / squash(EXPECTED).length;
    assert.ok(cer < 0.05, `character error rate ${(cer * 100).toFixed(1)}%:\n${page.text}`);
    for (const phrase of ['CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', 'GIẤY XÁC NHẬN', 'Nguyễn Văn Bình', 'Trần Thị Hương Giang', 'được lưu trữ']) assert.ok(page.text.includes(phrase), `missing “${phrase}”:\n${page.text}`);
    assert.doesNotMatch(page.text, /^[:.'\- ]+$/m);

    const out = await addOcrTextLayer(pdfBytes, [page], new Uint8Array(await readFile('public/fonts/NotoSans-Regular.ttf')));
    const content = await (await (await getDocument({ data: out.slice(), isEvalSupported: false }).promise).getPage(1)).getTextContent();
    const extracted = content.items.map(i => 'str' in i ? i.str : '').join(' ');
    for (const phrase of ['Nguyễn', 'Hương', 'thiết']) assert.ok(extracted.includes(phrase), `searchable layer is missing ${phrase}`);
  } finally { await worker.terminate(); }
});
