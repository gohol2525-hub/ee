import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFNumber, PDFRef, degrees, rgb } from 'pdf-lib';
import type { PDFObject } from 'pdf-lib';
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
