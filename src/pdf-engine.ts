import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, PDFRef, degrees, rgb } from 'pdf-lib';
import JSZip from 'jszip';
import type { PDFImage, PDFObject } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { toPdf } from './model.ts';
import type { Page, Source } from './model.ts';

const annotsKey = PDFName.of('Annots'), pageKey = PDFName.of('P');
const destKey = PDFName.of('Dest'), actionKey = PDFName.of('A');
const nextKey = PDFName.of('Next'), actionTypeKey = PDFName.of('S'), goTo = PDFName.of('GoTo');

function includesLocalAction(input: PDFDocument, first: PDFObject) {
  const pending = [first], seen = new Set<PDFObject>();
  while (pending.length) {
    const action = input.context.lookup(pending.pop());
    if (!action || seen.has(action)) continue;
    seen.add(action);
    if (action instanceof PDFArray) pending.push(...action.asArray());
    if (action instanceof PDFDict) {
      if (action.lookup(actionTypeKey) === goTo) return true;
      const next = action.get(nextKey);
      if (next) pending.push(next);
    }
  }
  return false;
}

async function copySelectedPages(output: PDFDocument, input: PDFDocument, indices: number[]) {
  const inputPages = input.getPages();
  const selected = new Set(indices.map(i=>inputPages[i].ref));
  const prepared = indices.map(i=>{
    const page = inputPages[i];
    const original = page.node.get(annotsKey);
    const annots = input.context.lookup(original);
    const links: {index: number; target?: PDFRef; tail: (PDFName|PDFNumber|typeof PDFNull)[]; owner: boolean}[] = [];
    if (!(annots instanceof PDFArray)) return {page, original, links};
    const filtered = input.context.obj([]);
    for (let j=0;j<annots.size();j++) {
      const annotation = annots.lookup(j);
      if (!(annotation instanceof PDFDict) || annotation.get(PDFName.of('Subtype')) !== PDFName.of('Link')) {
        filtered.push(annots.get(j)); continue;
      }
      const action = input.context.lookup(annotation.get(actionKey));
      const localAction = action instanceof PDFDict && action.lookup(actionTypeKey) === goTo;
      const rawDestination = annotation.get(destKey) ?? (localAction ? action.get(PDFName.of('D')) : undefined);
      const tail: (PDFName|PDFNumber|typeof PDFNull)[] = [];
      let target: PDFRef|undefined;
      if (rawDestination !== undefined || localAction) {
        const destination = input.context.lookup(rawDestination);
        if (!(destination instanceof PDFArray)) continue;
        const ref = destination.get(0);
        if (!(ref instanceof PDFRef) || !selected.has(ref)) continue;
        target = ref;
        for (let k=1;k<destination.size();k++) {
          const raw = destination.get(k);
          if (raw === PDFNull) tail.push(PDFNull);
          else {
            const value = input.context.lookup(raw);
            if (value instanceof PDFName || value instanceof PDFNumber) tail.push(value);
          }
        }
      }
      const clean = annotation.clone();
      if (target) { clean.delete(destKey); clean.delete(actionKey); }
      else if (action instanceof PDFDict && includesLocalAction(input,action)) {
        const cleanAction = action.clone();
        cleanAction.delete(nextKey); clean.set(actionKey,cleanAction);
      }
      const owner = clean.delete(pageKey);
      links.push({index:filtered.size(), target, tail, owner});
      filtered.push(clean);
    }
    return {page, original, filtered, links};
  });
  let copies: Awaited<ReturnType<PDFDocument['copyPages']>>;
  try {
    for (const {page, filtered} of prepared) if (filtered) page.node.set(annotsKey,filtered);
    copies = await output.copyPages(input,indices);
  } finally {
    for (const {page, original, filtered} of prepared) if (filtered && original) page.node.set(annotsKey,original);
  }
  const refs = new Map(indices.map((i,j)=>[inputPages[i].ref,copies[j].ref]));
  for (const [i,{links}] of prepared.entries()) for (const {index,target,tail,owner} of links) {
    const annotation = copies[i].node.Annots()!.lookup(index,PDFDict);
    if (owner) annotation.set(pageKey,copies[i].ref);
    if (target) annotation.set(destKey,output.context.obj([refs.get(target)!,...tail]));
  }
  return copies;
}

export async function exportDocument(pages: Page[], sources: Source[], fontBytes?: Uint8Array): Promise<Uint8Array> {
  if (!pages.length) throw new Error('Tài liệu cần có ít nhất một trang.');
  const output = await PDFDocument.create();
  const hasText = pages.some(p => p.annotations.some(a => a.type === 'text'));
  output.registerFontkit(fontkit);
  const font = hasText && fontBytes ? await output.embedFont(fontBytes, { subset: true }) : undefined;
  if (hasText && !font) throw new Error('Không thể tải phông chữ. Vui lòng thử lại.');
  const images = new Map<string, PDFImage>();
  const copies = new Map<string, Awaited<ReturnType<PDFDocument['copyPages']>>>();
  for (const sourceId of new Set(pages.map(page => page.sourceId))) {
    const source = sources.find(s => s.id === sourceId);
    if (!source) throw new Error('Không tìm thấy tài liệu gốc.');
    const input = await PDFDocument.load(source.bytes);
    // One copier per source preserves shared images and fonts across its pages.
    copies.set(sourceId, await copySelectedPages(output, input, pages.filter(p => p.sourceId === sourceId).map(p => p.index)));
  }
  for (const page of pages) {
    const copy = copies.get(page.sourceId)!.shift()!;
    // Keep resource streams shared, but never append annotations to a shared array.
    const contents = copy.node.Contents();
    if (page.annotations.length && contents instanceof PDFArray) copy.node.set(PDFName.of('Contents'), contents.clone(output.context));
    output.addPage(copy); copy.setRotation(degrees(page.rotation));
    for (const a of page.annotations) {
      if (a.type === 'image') {
        let image = images.get(a.image.data);
        if (!image) {
          image = await (a.image.type === 'image/png' ? output.embedPng(a.image.data) : output.embedJpg(a.image.data));
          images.set(a.image.data, image);
        }
        const pos = toPdf({ x: a.x, y: a.y + a.height }, page, a.rotation);
        copy.drawImage(image, { ...pos, width: a.width, height: a.height, rotate: degrees(a.rotation) });
        continue;
      }
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

export async function* splitDocument(bytes: Uint8Array) {
  const input = await PDFDocument.load(bytes);
  for (let i=0;i<input.getPageCount();i++) {
    const output = await PDFDocument.create();
    const [page] = await copySelectedPages(output,input,[i]);
    output.addPage(page);
    output.setProducer('Giấy PDF');
    yield await output.save();
  }
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

const xml = (s: string) => s.replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function textDocx(pages: string[][]): Promise<Uint8Array> {
  const run = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  const body = pages.map((lines, i) => (i ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : '') + (lines.length ? lines : ['']).map(run).join('')).join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:lang w:val="vi-VN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'uint8array', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

type TextItem = { str: string; transform: number[]; width: number; hasEOL?: boolean };

// PDF.js may return adjacent runs (e.g. a label and a form value) with a visible gap but no space item.
export function itemsText(items: (TextItem | object)[]): string[] {
  let text = '', end: number | undefined, y = 0, last = 0;
  for (const item of items) {
    if (!('str' in item)) continue;
    const [, , c, d, x, iy] = item.transform, size = Math.max(Math.hypot(c, d) || 10, end === undefined ? 0 : last);
    if (end !== undefined && item.str && !/\s$/.test(text) && !/^\s/.test(item.str) && Math.abs(iy - y) < size / 2 && x - end > size * .2) text += ' ';
    text += item.str; end = x + item.width; y = iy; last = Math.hypot(c, d) || 10;
    if (item.hasEOL) { text += '\n'; end = undefined; }
  }
  return text.split('\n').map(line => line.trimEnd());
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
