import { PDFDocument, PDFHexString, beginText, endText, popGraphicsState, pushGraphicsState, setFontAndSize, setTextMatrix, setTextRenderingMode, showText, TextRenderingMode } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Matrix, OcrPage } from './ocr-engine.ts';
import { invert, compose, wordPixelMatrix } from './ocr-engine.ts';

/** Adds an invisible, selectable/searchable text layer to the given pages; page content and appearance are left unchanged. */
export async function addOcrTextLayer(pdfBytes: Uint8Array, pages: OcrPage[], fontBytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const charset = new Set(font.getCharacterSet());
  const docPages = doc.getPages();
  for (const result of pages) {
    const page = docPages[result.pageIndex];
    if (!page) throw new Error(`Không tìm thấy trang ${result.pageIndex + 1} trong tài liệu.`);
    const words = result.lines.flatMap(line => line.words.map(word => ({ line, word })));
    if (!words.length) continue;
    const toPdf = invert(result.transform);
    const fontName = page.node.newFontDictionary('OCR', font.ref);
    const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible), setFontAndSize(fontName, 1)];
    for (const { line, word } of words) {
      const text = [...word.text].filter(ch => charset.has(ch.codePointAt(0)!)).join('');
      if (!text) continue;
      const m = compose(wordPixelMatrix(word, line, font.widthOfTextAtSize(text, 1)), toPdf);
      ops.push(setTextMatrix(...m), showText(font.encodeText(text + ' ') as PDFHexString));
    }
    ops.push(endText(), popGraphicsState());
    page.pushOperators(...ops);
  }
  return doc.save();
}
