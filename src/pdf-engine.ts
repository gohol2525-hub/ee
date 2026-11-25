import { PDFDocument, degrees, rgb } from 'pdf-lib';
import type { PDFImage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { toPdf } from './model.ts';
import type { Page, Source } from './model.ts';

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
    copies.set(sourceId, await output.copyPages(input, pages.filter(p => p.sourceId === sourceId).map(p => p.index)));
  }
  for (const page of pages) {
    const copy = copies.get(page.sourceId)!.shift()!;
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
