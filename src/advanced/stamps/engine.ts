import { PDFDocument, degrees, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { formatPageLabel } from './options.ts';
import type { NumbersJob, StampJob, WatermarkJob } from './options.ts';
import { normalizeRotation, pdfAngle, rotateVector, toPdfPoint, visibleBox, visualSize } from './geometry.ts';
import type { Box, Rotation } from './geometry.ts';

export class StampError extends Error {}

export interface StampResult {
  bytes: Uint8Array;
  /** Zero-based pages where the text was shrunk to fit. */
  shrunkPages: number[];
}

const LINE_HEIGHT = 1.2;
const FIT = 0.9;

interface Frame { page: PDFPage; box: Box; rotation: Rotation; width: number; height: number }

function frameOf(page: PDFPage): Frame {
  const box = visibleBox(page.getCropBox(), page.getMediaBox());
  const rotation = normalizeRotation(page.getRotation().angle);
  return { page, box, rotation, ...visualSize(box, rotation) };
}

function metrics(font: PDFFont, size: number) {
  const ascent = font.heightAtSize(size, { descender: false });
  return { ascent, descent: ascent - font.heightAtSize(size) };
}

function draw(frame: Frame, text: string, u: number, v: number, visualAngle: number, font: PDFFont, size: number, job: StampJob) {
  const at = toPdfPoint(frame.box, frame.rotation, u, v);
  frame.page.drawText(text, {
    x: at.x, y: at.y, font, size, color: rgb(...job.color), opacity: job.opacity,
    rotate: degrees(pdfAngle(visualAngle, frame.rotation)),
  });
}

function drawWatermark(frame: Frame, job: WatermarkJob, font: PDFFont): boolean {
  const lines = job.text.split('\n');
  const layout = (size: number) => {
    const widths = lines.map(l => font.widthOfTextAtSize(l, size));
    const { ascent, descent } = metrics(font, size);
    const lh = size * LINE_HEIGHT;
    const blockW = Math.max(...widths), blockH = (lines.length - 1) * lh + ascent - descent;
    const r = job.angle * Math.PI / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
    return { widths, ascent, descent, lh, bw: c * blockW + s * blockH, bh: s * blockW + c * blockH };
  };
  let size = job.size, l = layout(size);
  const scale = Math.min(1, FIT * frame.width / l.bw, FIT * frame.height / l.bh);
  if (scale < 1) { size *= scale; l = layout(size); }
  const cu = frame.width / 2, cv = frame.height / 2;
  lines.forEach((line, i) => {
    const local = { x: -l.widths[i] / 2, y: ((lines.length - 1) / 2 - i) * l.lh - (l.ascent + l.descent) / 2 };
    const off = rotateVector(local.x, local.y, job.angle);
    draw(frame, line, cu + off.x, cv + off.y, job.angle, font, size, job);
  });
  return scale < 1;
}

function drawNumber(frame: Frame, job: NumbersJob, label: string, font: PDFFont): boolean {
  let size = job.size, width = font.widthOfTextAtSize(label, size);
  const room = frame.width - 2 * job.margin, height = frame.height - 2 * job.margin;
  if(room<=0||height<=0)throw new StampError('Lề đánh số quá lớn so với kích thước trang. Hãy giảm lề và thử lại.');
  const full = metrics(font,size);
  const scale = Math.min(1,room/width,height/(full.ascent-full.descent));
  const shrunk = scale<1;
  if (shrunk) { size *= scale; width *= scale; }
  const { ascent, descent } = metrics(font, size);
  const [vertical, horizontal] = job.placement.split('-');
  const u = horizontal === 'left' ? job.margin : horizontal === 'right' ? frame.width - job.margin - width : (frame.width - width) / 2;
  const v = vertical === 'top' ? frame.height - job.margin - ascent : job.margin - descent;
  draw(frame, label, u, v, 0, font, size, job);
  return shrunk;
}

const jobText = (job: StampJob) => job.mode === 'watermark' ? job.text : job.template.replace(/\{n\}|\{total\}/gi, '0123456789');

function assertGlyphs(font: PDFFont, text: string) {
  const known = new Set(font.getCharacterSet());
  const missing = [...new Set([...text.replace(/\s/g, '')])].filter(ch => !known.has(ch.codePointAt(0)!));
  if (missing.length) throw new StampError(`Phông chữ chưa hỗ trợ ký tự: ${missing.slice(0, 10).join(' ')}`);
}

export async function stampPdf(input: Uint8Array, job: StampJob, fontBytes: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<StampResult> {
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(input, { updateMetadata: false }); }
  catch (e) {
    if (e instanceof Error && /encrypt/i.test(e.message)) throw new StampError('PDF đang được đặt mật khẩu. Hãy gỡ mật khẩu trước khi đóng dấu.');
    throw new StampError('Không đọc được tệp PDF để đóng dấu.');
  }
  const count = doc.getPageCount();
  if (!job.pages.length) throw new StampError('Chưa chọn trang nào.');
  if (job.pages.some(p => !Number.isInteger(p) || p < 0 || p >= count)) throw new StampError(`Trang đã chọn nằm ngoài tài liệu (1–${count}).`);
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  assertGlyphs(font, jobText(job));
  const shrunkPages: number[] = [];
  const total = job.mode === 'numbers' ? job.start + job.pages.length - 1 : 0;
  for (const [i, index] of job.pages.entries()) {
    const frame = frameOf(doc.getPage(index));
    const shrunk = job.mode === 'watermark'
      ? drawWatermark(frame, job, font)
      : drawNumber(frame, job, formatPageLabel(job.template, job.start + i, total), font);
    if (shrunk) shrunkPages.push(index);
    onProgress?.(i + 1, job.pages.length);
    if (i % 10 === 9) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { bytes: await doc.save(), shrunkPages };
}
