import { PDFArray, PDFDocument, PDFName, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import JSZip from 'jszip';
import { toPdf } from './model.ts';
import type { Page, Source } from './model.ts';

export async function exportDocument(pages: Page[], sources: Source[], fontBytes?: Uint8Array): Promise<Uint8Array> {
  if (!pages.length) throw new Error('Tài liệu cần có ít nhất một trang.');
  const output = await PDFDocument.create();
  const hasText = pages.some(p => p.annotations.some(a => a.type === 'text'));
  output.registerFontkit(fontkit);
  const font = hasText && fontBytes ? await output.embedFont(fontBytes, { subset: true }) : undefined;
  if (hasText && !font) throw new Error('Không thể tải phông chữ. Vui lòng thử lại.');
  const copies = new Map<string, Awaited<ReturnType<PDFDocument['copyPages']>>>();
  for (const sourceId of new Set(pages.map(page => page.sourceId))) {
    const source = sources.find(s => s.id === sourceId);
    if (!source) throw new Error('Không tìm thấy tài liệu gốc.');
    const input = await PDFDocument.load(source.bytes);
    // One copier per source preserves shared images and fonts across its pages.
    copies.set(sourceId, await output.copyPages(input, pages.filter(p => p.sourceId === sourceId).map(p => p.index)));
  }
  for (const page of pages) {
    const copy = copies.get(page.sourceId)!.shift()!;
    // Keep resource streams shared, but never append annotations to a shared array.
    const contents = copy.node.Contents();
    if (page.annotations.length && contents instanceof PDFArray) copy.node.set(PDFName.of('Contents'), contents.clone(output.context));
    output.addPage(copy); copy.setRotation(degrees(page.rotation));
    for (const a of page.annotations) {
      const color = rgb(parseInt(a.color.slice(1,3),16)/255, parseInt(a.color.slice(3,5),16)/255, parseInt(a.color.slice(5,7),16)/255);
      if (a.type === 'text') {
        const pos = toPdf({ x: a.x, y: a.y + a.size }, page, a.rotation);
        copy.drawText(a.text || '', { x: pos.x, y: pos.y, font, size: a.size, color, rotate: degrees(a.rotation), lineHeight: a.size * 1.35 });
      } else if (a.type === 'highlight') {
        const points = [toPdf({ x: a.x, y: a.y }, page, a.rotation), toPdf({ x: a.x + (a.width || 0), y: a.y + (a.height || 0) }, page, a.rotation)];
        copy.drawRectangle({ x: Math.min(points[0].x, points[1].x), y: Math.min(points[0].y, points[1].y), width: Math.abs(points[1].x-points[0].x), height: Math.abs(points[1].y-points[0].y), color, opacity: .3 });
      } else {
        const points = a.points || [];
        for (let i = 1; i < points.length; i++) copy.drawLine({ start: toPdf(points[i-1], page, a.rotation), end: toPdf(points[i], page, a.rotation), thickness: a.size / 7, color });
      }
    }
  }
  output.setProducer('Giấy PDF');
  return output.save();
}

export async function imagesDocument(images: { bytes: Uint8Array; type: string }[]) {
  const pdf = await PDFDocument.create();
  for (const image of images) {
    const embedded = image.type === 'image/png' ? await pdf.embedPng(image.bytes) : await pdf.embedJpg(image.bytes);
    const landscape = embedded.width > embedded.height;
    const size: [number, number] = landscape ? [841.89, 595.28] : [595.28, 841.89];
    const page = pdf.addPage(size);
    const scale = Math.min((size[0]-48)/embedded.width, (size[1]-48)/embedded.height);
    const width = embedded.width*scale, height = embedded.height*scale;
    page.drawImage(embedded, { x:(size[0]-width)/2, y:(size[1]-height)/2, width, height });
  }
  return pdf.save();
}

export function imageKind(bytes: Uint8Array): 'image/png' | 'image/jpeg' | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
}

export function jpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1], length = view.getUint16(offset + 2);
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xe1 && offset + 10 <= bytes.length && view.getUint32(offset + 4) === 0x45786966) {
      const tiff = offset + 10;
      if (tiff + 8 > bytes.length) return 1;
      const little = view.getUint16(tiff) === 0x4949;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      if (ifd + 2 > bytes.length) return 1;
      const count = view.getUint16(ifd, little);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > bytes.length) break;
        if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { return new TextDecoder('windows-1258').decode(bytes); }
}

const entities: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : entities[e] ?? m);

const MAX_DOCX_XML = 32 * 1024 * 1024;
type ZipStream = { on(event: 'data', cb: (chunk: Uint8Array) => void): ZipStream; on(event: 'error' | 'end', cb: () => void): ZipStream; pause(): void; resume(): void };

// Text only: Word formatting, tables and images are flattened to paragraphs; '\f' marks a page break.
export async function docxText(bytes: Uint8Array): Promise<string> {
  let entry: JSZip.JSZipObject | null = null;
  try { entry = (await JSZip.loadAsync(bytes)).file('word/document.xml'); } catch { /* not a zip */ }
  if (!entry) throw new Error('Không đọc được tài liệu Word. Hãy lưu lại dưới dạng .docx.');
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    let total = 0;
    const stream = (entry as unknown as { internalStream(type: 'uint8array'): ZipStream }).internalStream('uint8array');
    stream.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_DOCX_XML) { stream.pause(); reject(new Error('Tài liệu Word quá lớn để chuyển đổi.')); } else chunks.push(chunk);
    }).on('error', () => reject(new Error('Không đọc được tài liệu Word. Hãy lưu lại dưới dạng .docx.'))).on('end', () => resolve()).resume();
  });
  const doc = await new Blob(chunks as BlobPart[]).text();
  const paragraphs = doc.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>|<w:(delText|instrText)\b[^>]*>[\s\S]*?<\/w:\1>/g, '').split('</w:p>').slice(0, -1).map(p => {
    let out = '';
    for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:cr\/>|<w:br\b([^>]*)\/>/g))
      out += m[1] !== undefined ? unxml(m[1]) : m[0] === '<w:tab/>' ? '\t' : /w:type="page"/.test(m[2] ?? '') ? '\f' : '\n';
    return out;
  });
  return paragraphs.join('\n').replace(/\s+$/, '');
}

export async function textDocument(text: string, fontBytes: Uint8Array, maxPages = 200): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const size = 11, leading = 16, margin = 56, [w, h] = [595.28, 841.89], width = w - margin * 2;
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
  const maxChars = Math.floor(width / (size * .2));
  const addPage = () => {
    if (pdf.getPageCount() >= maxPages) throw new Error(`Tài liệu tối đa ${maxPages} trang.`);
    return pdf.addPage([w, h]);
  };
  let page = addPage(), y = h - margin - size;
  const line = (s: string) => {
    if (y < margin) { page = addPage(); y = h - margin - size; }
    if (s) page.drawText(s, { x: margin, y, size, font });
    y -= leading;
  };
  const clean = text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/[^\n\f\P{Cc}]/gu, '');
  clean.split('\f').forEach((block, i) => {
    if (i) { page = addPage(); y = h - margin - size; }
    for (const para of block.split('\n')) {
      let current = '';
      for (const word of para.match(/\s*\S+/g) ?? ['']) {
        if (fits(current + word)) { current += word; continue; }
        if (current) line(current);
        current = word.trimStart();
        while (current.length > maxChars || !fits(current)) {
          let lo = 1, hi = Math.min(current.length - 1, maxChars);
          while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(current.slice(0, mid))) lo = mid; else hi = mid - 1; }
          const n = lo;
          line(current.slice(0, n)); current = current.slice(n);
        }
      }
      line(current);
    }
  });
  return pdf.save();
}
