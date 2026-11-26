import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { degrees, PDFDocument, PDFName, PDFDict, StandardFonts } from 'pdf-lib';
import { CompressionCancelledError, MAX_RASTER_PIXELS, MAX_RASTER_SIDE, optimizeStructure, pageGeometry, rasterCompress, rasterSize } from './engine.ts';
import type { RasterSource, RasterSize, PageGeometry } from './engine.ts';
import { compressedName, compressionOutcome, formatBytes } from './options.ts';

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url)).then(b => new Uint8Array(b));
const lowJpeg = await fixture('page-low.jpg');
const highJpeg = await fixture('page-high.jpg');

function noisePng(width: number, height: number, seed = 1) {
  let state = seed;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let i = 0; i < raw.length; i++) {
    if (i % (width * 3 + 1) === 0) continue;
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ state >>> 15, state | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    raw[i] = (t ^ t >>> 14) >>> 24;
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

async function textPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([200, 120]).drawText('Hello compression', { x: 20, y: 60, size: 12, font });
  return doc.save();
}

function fakeSource(pages: PageGeometry[], jpeg: Uint8Array, calls: { sizes: RasterSize[]; released: number[] } = { sizes: [], released: [] }): RasterSource {
  return {
    pageCount: pages.length,
    geometry: async index => pages[index],
    renderJpeg: async (_index, size) => { calls.sizes.push(size); return jpeg; },
    releasePage: index => { calls.released.push(index); },
  };
}

async function pdfjsSource(bytes: Uint8Array, jpeg: Uint8Array) {
  const pdf = await getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const source: RasterSource = {
    pageCount: pdf.numPages,
    geometry: async index => { const p = await pdf.getPage(index + 1); return pageGeometry(p.view, p.rotate); },
    renderJpeg: async () => jpeg,
  };
  return { source, destroy: () => pdf.destroy() };
}

test('raster sizes follow the chosen dpi and stay inside canvas limits', () => {
  assert.deepEqual(rasterSize({ width: 72, height: 144 }, 144), { pixelWidth: 144, pixelHeight: 288, scale: 2 });
  const huge = rasterSize({ width: 14400, height: 200 }, 200);
  assert.ok(huge.pixelWidth <= MAX_RASTER_SIDE && huge.pixelHeight >= 1);
  const a3 = rasterSize({ width: 842, height: 1191 }, 600);
  assert.ok(a3.pixelWidth * a3.pixelHeight <= MAX_RASTER_PIXELS);
  assert.ok(a3.scale < 600 / 72);
  const tiny = rasterSize({ width: .2, height: .2 }, 72);
  assert.deepEqual([tiny.pixelWidth, tiny.pixelHeight], [1, 1]);
});

test('page geometry uses the visible box and normalizes rotation', () => {
  assert.deepEqual(pageGeometry([10, 20, 310, 420], -90), { width: 300, height: 400, rotation: 270 });
  assert.deepEqual(pageGeometry([0, 0, 100, 50], 450), { width: 100, height: 50, rotation: 90 });
  assert.throws(() => pageGeometry([0, 0, 0, 50], 0));
});

test('raster compression keeps page order, size and rotation and leaves only one image per page', async () => {
  const source = await PDFDocument.create();
  const sizes: [number, number][] = [[612, 792], [842, 595], [300, 500]];
  sizes.forEach(([w, h], i) => source.addPage([w, h]).setRotation(degrees([0, 90, 180][i])));
  source.getPage(2).setCropBox(50, 50, 200, 300);
  const form = source.getForm();
  form.createTextField('name').addToPage(source.getPage(0), { x: 50, y: 50 });
  const { source: raster, destroy } = await pdfjsSource(await source.save(), lowJpeg);
  const progress: number[] = [];
  let bytes: Uint8Array;
  try { bytes = await rasterCompress(raster, { dpi: 100, quality: .6 }, p => progress.push(p.done)); } finally { await destroy(); }
  assert.deepEqual(progress, [0, 1, 2, 3]);

  const out = await PDFDocument.load(bytes);
  assert.equal(out.getPageCount(), 3);
  assert.deepEqual(out.getPages().map(p => [p.getWidth(), p.getHeight(), p.getRotation().angle]), [[612, 792, 0], [842, 595, 90], [200, 300, 180]]);
  assert.equal(out.catalog.get(PDFName.of('AcroForm')), undefined);
  for (const page of out.getPages()) {
    const xObjects = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    assert.equal(xObjects?.keys().length, 1);
    assert.equal(page.node.Annots()?.size() ?? 0, 0);
  }
  const pdf = await getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  try {
    assert.equal(pdf.numPages, 3);
    const page = await pdf.getPage(2);
    assert.equal(page.rotate, 90);
    assert.equal((await page.getTextContent()).items.length, 0);
  } finally { await pdf.destroy(); }
});

test('raster compression renders at bounded sizes and releases every page', async () => {
  const calls = { sizes: [] as RasterSize[], released: [] as number[] };
  await rasterCompress(fakeSource([{ width: 612, height: 792, rotation: 0 }, { width: 20000, height: 400, rotation: 0 }], lowJpeg, calls), { dpi: 150, quality: .6 });
  assert.deepEqual(calls.sizes[0], { pixelWidth: 1275, pixelHeight: 1650, scale: 150 / 72 });
  assert.ok(calls.sizes[1].pixelWidth <= MAX_RASTER_SIDE);
  assert.deepEqual(calls.released, [0, 1]);
});

test('scan-like PDFs shrink while compact text PDFs report no savings', async () => {
  const scan = await PDFDocument.create();
  for (let i = 0; i < 2; i++) {
    const image = await scan.embedPng(noisePng(400, 520, i + 1));
    scan.addPage([600, 780]).drawImage(image, { x: 0, y: 0, width: 600, height: 780 });
  }
  const scanBytes = await scan.save();
  const geometry = { width: 600, height: 780, rotation: 0 };
  const low = await rasterCompress(fakeSource([geometry, geometry], lowJpeg), { dpi: 72, quality: .45 });
  const high = await rasterCompress(fakeSource([geometry, geometry], highJpeg), { dpi: 200, quality: .9 });
  assert.ok(high.length > low.length);
  const shrunk = compressionOutcome(scanBytes.length, low.length);
  assert.equal(shrunk.kind, 'smaller');
  assert.ok(shrunk.savedPercent > 90, JSON.stringify(shrunk));

  const text = await textPdf();
  const { source, destroy } = await pdfjsSource(text, highJpeg);
  try {
    const result = await rasterCompress(source, { dpi: 200, quality: .9 });
    assert.equal(compressionOutcome(text.length, result.length).kind, 'larger');
  } finally { await destroy(); }
});

test('cancellation stops after the current page and invalid page images are rejected', async () => {
  const controller = new AbortController();
  const calls = { sizes: [] as RasterSize[], released: [] as number[] };
  const pages = Array.from({ length: 5 }, () => ({ width: 100, height: 100, rotation: 0 }));
  await assert.rejects(rasterCompress(fakeSource(pages, lowJpeg, calls), { dpi: 72, quality: .6 }, p => { if (p.done === 1) controller.abort(); }, controller.signal), CompressionCancelledError);
  assert.equal(calls.sizes.length, 1);
  assert.deepEqual(calls.released, [0]);
  await assert.rejects(rasterCompress(fakeSource(pages, new Uint8Array([1, 2, 3, 4])), { dpi: 72, quality: .6 }), /JPEG/);
  await assert.rejects(rasterCompress(fakeSource([], lowJpeg), { dpi: 72, quality: .6 }), /Không có trang/);
});

test('structure optimization keeps text and form fields and removes unused objects', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 300]);
  page.drawText('Giữ chữ'.normalize('NFD').replace(/[^\x00-\x7f]/g, ''), { x: 20, y: 200, size: 14, font });
  doc.getForm().createTextField('email').addToPage(page, { x: 20, y: 100 });
  const unused = doc.context.obj({ Junk: doc.context.obj(Array.from({ length: 2000 }, (_, i) => i)) });
  doc.context.register(unused);
  const original = await doc.save({ useObjectStreams: false });
  const optimized = await optimizeStructure(original);
  const out = await PDFDocument.load(optimized);
  assert.equal(out.getPageCount(), 1);
  assert.deepEqual(out.getForm().getFields().map(f => f.getName()), ['email']);
  const pdf = await getDocument({ data: optimized.slice(), isEvalSupported: false }).promise;
  try {
    const text = (await (await pdf.getPage(1)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join('');
    assert.match(text, /Giu chu/);
  } finally { await pdf.destroy(); }
  assert.ok(optimized.length < original.length);
});

test('outcomes never claim savings below the threshold', () => {
  assert.deepEqual(compressionOutcome(100_000, 40_000), { originalBytes: 100_000, resultBytes: 40_000, savedBytes: 60_000, savedPercent: 60, kind: 'smaller' });
  assert.equal(compressionOutcome(100_000, 99_500).kind, 'unchanged');
  assert.equal(compressionOutcome(100_000, 100_500).kind, 'unchanged');
  assert.equal(compressionOutcome(100_000, 120_000).kind, 'larger');
  assert.equal(compressionOutcome(2_000, 900).kind, 'smaller');
  assert.equal(compressionOutcome(0, 0).kind, 'unchanged');
  assert.equal(compressedName('Hop dong.PDF'), 'Hop dong-da-nen.pdf');
  assert.equal(compressedName('.pdf'), 'tai-lieu-da-nen.pdf');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1,5 KB');
  assert.equal(formatBytes(2.25 * 1024 * 1024), '2,3 MB');
});
