import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFPageLeaf, PDFString, degrees } from 'pdf-lib';
import { getDocument, OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { rasterizeAnnotationImage, rasterizeImage } from './image-raster.ts';
import { loadPdfWithTask, PdfPasswordCancelledError } from './pdf-password.ts';
import { decodeText, docxText, exportDocument, imageKind, imagesDocument, itemsText, jpegOrientation, splitDocument, textDocument, textDocx } from './pdf-engine.ts';
import { dimensions, fontKey, fromPdf, moveAnnotation, resizeImage, toPdf, overlayTransform, importErrorMessage, placeImage, referencedSourceIds, reorderPages } from './model.ts';
import { editableTextBoxes } from './text-edit.ts';
import type { Page } from './model.ts';
import { PdfPageLimitError, pdfImportErrorMessage } from './pdf-open.ts';
import { pageIndexForInput } from './page-navigation.ts';
import { pageRangeLabel, parsePageRange } from './page-range.ts';

const font = new Uint8Array(await readFile('public/fonts/NotoSans-Regular.ttf'));
const makePage = (index=0): Page => ({id:`p${index}`,sourceId:'source',index,rotation:0,width:600,height:800,annotations:[]});

const encryptedPdf = () => new Uint8Array(Buffer.from(
  'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDlkMWE2Yjc3ODk+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBl' +
  'IC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2Vz' +
  'IDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAu' +
  'MCAzMDAgNDAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5' +
  'NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8YTc2MmMyNDQ3OTdhYTI4NjhhOTcwZjJkOWQ3YTA2NzQ4YThmZGVlMTU1Zjcy' +
  'OWJhNjZmNzk2ODFhNjUwZDIzMz4KL1UgPGZiOWFjMmU4OWNiZTM3Yzc3NmU0N2ExOTE1YzYzYmE1MjhiZjRlNWU0ZTc1OGE0MTY0' +
  'MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAK' +
  'MDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAw' +
  'MCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDQxMmNhZTA2NjZlYWI3ZjRmNWI5' +
  'OGYyOWU5MWY1ODliPiA8NDEyY2FlMDY2NmVhYjdmNGY1Yjk4ZjI5ZTkxZjU4OWI+IF0KL0VuY3J5cHQgNSAwIFIKPj4Kc3RhcnR4' +
  'cmVmCjQ3NgolJUVPRgo=', 'base64'
));

test('encrypted PDFs retry a wrong password and can be viewed without stripping encryption', async () => {
  const { isEncrypted } = await PDFDocument.load(encryptedPdf(), { ignoreEncryption: true, updateMetadata: false });
  assert.equal(isEncrypted,true);
  const calls: boolean[] = [];
  const pdf = await loadPdfWithTask(getDocument({data:encryptedPdf()}), pdf => pdf, async retry => {
    calls.push(retry);
    return retry ? 'viewer-test-password' : 'wrong-test-password';
  });
  try {
    assert.deepEqual(calls,[false,true]);
    assert.equal(pdf.numPages,1);
    assert.ok(await pdf.getPage(1));
    await assert.rejects(exportDocument([makePage()], [{id:'source',name:'locked.pdf',bytes:encryptedPdf()}]), /encrypted/i);
  } finally {
    await pdf.destroy();
  }
});

test('canceling a password request aborts and releases the PDF loading task', async () => {
  const task = getDocument({data:encryptedPdf()});
  await assert.rejects(loadPdfWithTask(task, pdf => pdf, async () => null), PdfPasswordCancelledError);
  assert.equal(task.destroyed,true);
});

test('a page lookup failure after unlocking destroys the PDF loading task', async () => {
  const task = getDocument({data:encryptedPdf()});
  const document = loadPdfWithTask(task, async pdf => {
    assert.equal(pdf.numPages,1);
    return pdf.getPage(2);
  }, async () => 'viewer-test-password');
  await assert.rejects(document,/Invalid page request/);
  assert.equal(task.destroyed,true);
});

test('merge, reorder, delete and rotate pages without changing input bytes', async () => {
  const a=await PDFDocument.create(); a.addPage([600,800]); a.addPage([300,400]);
  const b=await PDFDocument.create(); b.addPage([500,500]);
  const aBytes=await a.save(), before=aBytes.slice(), bBytes=await b.save();
  const bytes=await exportDocument([{...makePage(0),sourceId:'b',rotation:90},makePage(1)], [{id:'source',name:'a.pdf',bytes:aBytes},{id:'b',name:'b.pdf',bytes:bBytes}]);
  const result=await PDFDocument.load(bytes);
  assert.equal(result.getPageCount(),2);
  assert.deepEqual(result.getPage(0).getSize(),{width:500,height:500});
  assert.equal(result.getPage(0).getRotation().angle,90);
  assert.deepEqual(result.getPage(1).getSize(),{width:300,height:400});
  assert.deepEqual(aBytes,before);
});

test('Vietnamese text, highlights and ink survive export at all page rotations', async () => {
  const input=await PDFDocument.create(); input.addPage([600,800]);
  const bytes=await input.save();
  const pages=[0,90,180,270].map(rotation=>({...makePage(),id:String(rotation),rotation,annotations:[
    {id:'text',type:'text' as const,x:40,y:70,size:18,color:'#252a34',text:'Xin chào Việt Nam',rotation},
    {id:'highlight',type:'highlight' as const,x:20,y:30,width:100,height:20,size:18,color:'#f3bf35',rotation},
    {id:'ink',type:'draw' as const,x:0,y:0,size:18,color:'#317cff',rotation,points:[{x:30,y:40},{x:50,y:80}]}
  ]}));
  const exported=await exportDocument(pages,[{id:'source',name:'test.pdf',bytes}],font);
  const pdf=await getDocument({data:exported.slice(),useSystemFonts:true}).promise;
  for (let i=0;i<4;i++) {
    const page=await pdf.getPage(i+1), content=await page.getTextContent();
    assert.equal(page.rotate,[0,90,180,270][i]);
    const item=content.items.find(item=>'str' in item && item.str==='Xin chào Việt Nam');
    assert.ok(item && 'transform' in item);
    const viewport=page.getViewport({scale:1});
    const [x,y]=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);
    assert.ok(Math.abs(x-40)<.1,`rotation ${page.rotate}: x=${x}`);
    assert.ok(Math.abs(y-88)<.1,`rotation ${page.rotate}: y=${y}`);
  }
  await pdf.destroy();
});

test('cropped page origin and annotation coordinates are preserved', async () => {
  const input=await PDFDocument.create(); const p=input.addPage([700,900]);p.setCropBox(50,50,600,800);p.setRotation(degrees(90));
  const model={...makePage(),originX:50,originY:50,rotation:90,annotations:[{id:'t',type:'text' as const,x:30,y:40,size:18,color:'#252a34',text:'Ghi chú',rotation:90}]};
  const bytes=await exportDocument([model],[{id:'source',name:'crop.pdf',bytes:await input.save()}],font);
  const pdf=await getDocument({data:bytes,useSystemFonts:true}).promise;
  const page=await pdf.getPage(1), content=await page.getTextContent();
  const item=content.items.find(item=>'str' in item && item.str==='Ghi chú'); assert.ok(item && 'transform' in item);
  const [x,y]=page.getViewport({scale:1}).convertToViewportPoint(item.transform[4],item.transform[5]);
  assert.ok(Math.abs(x-30)<.1); assert.ok(Math.abs(y-58)<.1);
  await pdf.destroy();
});

test('rotating after annotating keeps original content-space coordinates', () => {
  const p={...makePage(),rotation:90};
  assert.deepEqual(dimensions(p),{width:800,height:600});
  assert.equal(overlayTransform(p,{id:'x',type:'text',x:20,y:30,size:18,color:'#252a34',rotation:0}),'translate(800 0) rotate(90)');
  assert.deepEqual(toPdf({x:20,y:30},p,0),{x:20,y:770});
  assert.deepEqual(toPdf({x:20,y:30},p,90),{x:30,y:20});
});

test('PNG image conversion creates a valid A4 PDF', async () => {
  const bytes=new Uint8Array(await readFile('public/icon-192.png'));
  const pdf=await PDFDocument.load(await imagesDocument([{bytes,type:'image/png'}]));
  assert.equal(pdf.getPageCount(),1);
  assert.deepEqual(pdf.getPage(0).getSize(),{width:595.28,height:841.89});
});

test('inserted images stay inside the page and survive export and rotation', async () => {
  const input = await PDFDocument.create();
  input.addPage([600,800]);
  const png = await readFile('public/icon-192.png');
  const image = { name: 'stamp.png', type: 'image/png' as const, width: 192, height: 192, data: `data:image/png;base64,${png.toString('base64')}` };
  const page = { ...makePage(), rotation: 90 };
  const annotation = placeImage(page, image, { x: 795, y: 595 });
  assert.deepEqual([annotation.x, annotation.y, annotation.width, annotation.height], [600,400,200,200]);
  const pages = [{...page, annotations: [annotation]}, {...page, rotation: 180, annotations: [annotation]}];
  const bytes = await exportDocument(pages, [{ id: 'source', name: 'image.pdf', bytes: await input.save() }]);
  const pdf = await getDocument({data: bytes}).promise;
  try {
    for (const [i, expected] of [[0,[600,600]], [1,[0,600]]] as const) {
      const rendered = await pdf.getPage(i+1);
      const ops = await rendered.getOperatorList();
      const imageIndex = ops.fnArray.indexOf(OPS.paintImageXObject);
      assert.ok(imageIndex > 0);
      const [a,b,c,d,x,y] = ops.fnArray.slice(0,imageIndex).reduce<number[]>(
        (matrix, op, index) => op === OPS.transform ? Util.transform(matrix, ops.argsArray[index]) : matrix, [1,0,0,1,0,0]
      );
      assert.deepEqual([a,b,c,d].map(Math.round), [0,200,-200,0]);
      assert.deepEqual(rendered.getViewport({scale:1}).convertToViewportPoint(x,y), expected);
    }
  } finally { await pdf.destroy(); }
});

test('image stamps use the oriented static raster for preview and export', async t => {
  const bitmap = { width: 40, height: 60, close: t.mock.fn() };
  const decode = t.mock.fn(async (_input: Blob, _options: ImageBitmapOptions) => bitmap);
  const drawImage = t.mock.fn();
  let encodedSize: number[] = [];
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ drawImage }),
    toBlob: t.mock.fn((callback: BlobCallback, type: string) => {
      encodedSize = [canvas.width, canvas.height];
      callback(new Blob(['canvas raster'], { type }));
    }),
  };
  const globals = { createImageBitmap: decode, document: { createElement: () => canvas } };
  Object.assign(globalThis, globals);
  t.after(() => { for (const key of Object.keys(globals)) Reflect.deleteProperty(globalThis, key); });

  for (const [type, header] of [
    ['image/jpeg', [255,216,255]],
    ['image/png', [137,80,78,71,13,10,26,10]],
  ] as const) {
    const file = new File([new Uint8Array(header)], 'stamp');
    const raster = await rasterizeAnnotationImage(file);
    assert.equal(await raster.blob.text(), 'canvas raster');
    assert.deepEqual([raster.type, raster.width, raster.height], [type,40,60]);
    assert.deepEqual(encodedSize, [40,60]);
    assert.deepEqual(drawImage.mock.calls.at(-1)?.arguments, [bitmap,0,0,40,60]);
    assert.deepEqual(decode.mock.calls.at(-1)?.arguments[1], { imageOrientation: 'from-image' });
    assert.equal(decode.mock.calls.at(-1)?.arguments[0].type, type);
  }
  assert.equal(bitmap.close.mock.callCount(), 2);

  await t.test('large photos are proportionally scaled before allocating the raster canvas', async () => {
    const file = new File([new Uint8Array([255,216,255])], 'large.jpg');
    for (const [original, expected] of [
      [[10000,2500], [4096,1024]],
      [[8000,8000], [4000,4000]],
    ]) {
      [bitmap.width, bitmap.height] = original;
      const raster = await rasterizeAnnotationImage(file);
      assert.deepEqual([raster.width, raster.height], expected);
      assert.deepEqual(encodedSize, expected);
      assert.deepEqual(drawImage.mock.calls.at(-1)?.arguments, [bitmap,0,0,...expected]);
    }
  });

  await t.test('page imports share the pixel cap without the annotation side cap', async () => {
    [bitmap.width, bitmap.height] = [5000,2000];
    const image = new Blob();
    const raster = await rasterizeImage(image, 'image/jpeg');
    assert.deepEqual([raster.width, raster.height], [5000,2000]);
    assert.deepEqual(encodedSize, [5000,2000]);
    assert.equal(decode.mock.calls.at(-1)?.arguments[0], image);
    assert.deepEqual([canvas.width, canvas.height], [0,0]);
  });
});

test('empty documents and missing sources fail instead of producing corrupt files',async()=>{
  await assert.rejects(exportDocument([],[]),/ít nhất/);
  await assert.rejects(exportDocument([makePage()],[]),/gốc/);
});

test('invalid PDF errors are localized without losing the page limit message', async () => {
  await assert.rejects(PDFDocument.load(new TextEncoder().encode('not a PDF')), error => {
    assert.equal(pdfImportErrorMessage(error), 'Không thể mở tệp. Tệp có thể bị hỏng hoặc sai định dạng.');
    return true;
  });
  assert.equal(pdfImportErrorMessage(new PdfPageLimitError()), 'Tài liệu tối đa 200 trang.');
});

test('page jumps accept whole page numbers and clamp them to the document', () => {
  assert.equal(pageIndexForInput(' 6 ', 12), 5);
  assert.equal(pageIndexForInput('0', 12), 0);
  assert.equal(pageIndexForInput('99', 12), 11);
  assert.equal(pageIndexForInput('2.5', 12), null);
  assert.equal(pageIndexForInput('', 12), null);
});

test('page ranges follow document order and deduplicate overlapping selections', () => {
  const selected = parsePageRange('5, 1 - 3, 2',5);
  assert.deepEqual(selected,[1,2,3,5]);
  assert.equal(pageRangeLabel(selected),'1-3_5');
  assert.equal(pageRangeLabel(parsePageRange('2',5)),'2');
  assert.equal(pageRangeLabel([]),'');
});

test('empty, malformed and out-of-bounds page ranges are rejected in Vietnamese', () => {
  for (const value of ['', ' ', '1,', '1--2', 'a', '1.5']) {
    assert.throws(()=>parsePageRange(value,5),/Khoảng trang không hợp lệ/);
  }
  for (const value of ['0', '4-2', '1-6', '5, 6', '90071992547409999']) {
    assert.throws(()=>parsePageRange(value,5),/1–5/);
  }
});

test('splitting an edited PDF preserves page order, rotation and size', async () => {
  const input=await PDFDocument.create(); input.addPage([600,800]); input.addPage([800,600]);
  const bytes=await exportDocument([{...makePage(1),rotation:90},makePage(0)],[{id:'source',name:'input.pdf',bytes:await input.save()}]);
  const parts=[];
  for await (const part of splitDocument(bytes)) {
    const pdf=await PDFDocument.load(part);
    assert.equal(pdf.getPageCount(),1);
    parts.push([pdf.getPage(0).getSize(),pdf.getPage(0).getRotation().angle]);
  }
  assert.deepEqual(parts,[[{width:800,height:600},90],[{width:600,height:800},0]]);
});

test('splitting produces no files for an empty PDF and rejects unreadable input', async () => {
  const empty=await PDFDocument.create();
  const bytes=await empty.save({addDefaultPage:false});
  assert.ok((await splitDocument(bytes).next()).done);
  await assert.rejects(splitDocument(new Uint8Array()).next());
});

test('internal links cannot copy omitted page objects into a page range or split PDF', async () => {
  const input = await PDFDocument.create();
  const [first,second,third] = [600,700,800].map(width=>input.addPage([width,800]));
  const dest = (page: typeof first) => input.context.obj([page.ref,PDFName.of('XYZ'),PDFNull,PDFNull,PDFNull]);
  const link = (entries: Record<string,PDFArray|PDFDict>) => input.context.obj({
    Type:'Annot',Subtype:'Link',Rect:[0,0,100,100],P:first.ref,...entries
  });
  const uri = {S:'URI',URI:PDFString.of('https://example.com')};
  first.node.set(PDFName.of('Annots'),input.context.obj([
    link({Dest:dest(third)}),
    link({A:input.context.obj({S:'GoTo',D:dest(third)})}),
    link({A:input.context.obj({S:'GoTo',D:dest(second)})}),
    link({A:input.context.obj({...uri,Next:{S:'GoTo',D:dest(third)}})}),
  ]));
  const source = {id:'source',name:'links.pdf',bytes:await input.save()};
  const bytes = await exportDocument([makePage(1),makePage(0)],[source]);
  const range = await PDFDocument.load(bytes);
  const allPageObjects = (doc: PDFDocument) => doc.context.enumerateIndirectObjects().filter(([,object])=>object instanceof PDFPageLeaf).length;
  assert.equal(range.getPageCount(),2);
  assert.equal(allPageObjects(range),2);
  const links = range.getPage(1).node.Annots()!;
  assert.equal(links.size(),2);
  const keptLink = links.lookup(0,PDFDict);
  assert.equal(keptLink.get(PDFName.of('P')),range.getPage(1).ref);
  const keptDestination = keptLink.lookup(PDFName.of('Dest'),PDFArray);
  assert.equal(keptDestination.get(0),range.getPage(0).ref);
  assert.deepEqual(keptDestination.asArray().slice(1),[PDFName.of('XYZ'),PDFNull,PDFNull,PDFNull]);
  const keptUri = links.lookup(1,PDFDict).lookup(PDFName.of('A'),PDFDict);
  assert.equal(keptUri.lookup(PDFName.of('URI'),PDFString).decodeText(),'https://example.com');
  assert.equal(keptUri.get(PDFName.of('Next')),undefined);

  const widths = [];
  for await (const part of splitDocument(bytes)) {
    const split = await PDFDocument.load(part);
    assert.equal(split.getPageCount(),1);
    assert.equal(allPageObjects(split),1);
    widths.push(split.getPage(0).getWidth());
    if (split.getPage(0).getWidth()===600) assert.equal(split.getPage(0).node.Annots()!.size(),1);
  }
  assert.deepEqual(widths,[700,600]);
});

test('moving a thumbnail inserts it at the target without changing the previous order', () => {
  const [first, second, third, fourth] = [0,1,2,3].map(makePage);
  const pages = [first,second,third,fourth];
  assert.deepEqual(reorderPages(pages,0,2),[second,third,first,fourth]);
  assert.deepEqual(reorderPages(pages,3,0),[fourth,first,second,third]);
  assert.deepEqual(pages,[first,second,third,fourth]);
  assert.equal(reorderPages(pages,1,1),pages);
  assert.equal(reorderPages(pages,1,4),pages);
  const empty: Page[] = [];
  assert.equal(reorderPages(empty,0,1),empty);
});

test('PDF import errors show Vietnamese guidance without raw parser details', () => {
  assert.match(importErrorMessage(new Error('Invalid PDF structure.')), /Tệp có thể bị hỏng/);
  assert.match(importErrorMessage(undefined), /Không thể mở tệp/);
  assert.match(importErrorMessage(new Error('Input document is encrypted')), /Hãy mở khóa bản sao/);
  const limit = 'Vui lòng chọn PDF không quá 200 trang.';
  assert.equal(importErrorMessage(new Error(limit)),limit);
  const imageError = 'Không đọc được ảnh photo.webp. Hãy thử ảnh JPG hoặc PNG.';
  assert.equal(importErrorMessage(new Error(imageError)),imageError);
});

test('sources remain reachable through undo or redo until their snapshots are discarded', () => {
  const current = [makePage()];
  const undo = [{...makePage(1), sourceId:'undo'}];
  const redo = [makePage(), {...makePage(2), sourceId:'redo'}];
  assert.deepEqual(referencedSourceIds(current,undo,redo),new Set(['source','undo','redo']));
  assert.deepEqual(referencedSourceIds(current,undo),new Set(['source','undo']));
  assert.deepEqual(referencedSourceIds(current),new Set(['source']));
  assert.deepEqual(referencedSourceIds([]),new Set());
});

test('JPEG EXIF orientation is read so rotated phone photos can be redrawn upright', () => {
  const exif=(little:boolean,orientation:number)=>{
    const tiff=little?[0x49,0x49,0x2a,0,8,0,0,0,1,0,0x12,0x01,3,0,1,0,0,0,orientation,0,0,0,0,0,0,0]:[0x4d,0x4d,0,0x2a,0,0,0,8,0,1,0x01,0x12,0,3,0,0,0,1,0,orientation,0,0,0,0,0,0];
    const app1=[0x45,0x78,0x69,0x66,0,0,...tiff];
    return new Uint8Array([0xff,0xd8,0xff,0xe0,0,4,0,0,0xff,0xe1,(app1.length+2)>>8,(app1.length+2)&255,...app1,0xff,0xda,0,2]);
  };
  assert.equal(jpegOrientation(exif(true,6)),6);
  assert.equal(jpegOrientation(exif(false,8)),8);
  assert.equal(jpegOrientation(new Uint8Array([0xff,0xd8,0xff,0xda,0,2])),1);
  assert.equal(imageKind(exif(true,1)),'image/jpeg');
  assert.equal(imageKind(new Uint8Array([0x52,0x49,0x46,0x46])),undefined);
});

test('pages sharing an image keep a single image resource after export', async () => {
  const input = await PDFDocument.create();
  const image = await input.embedPng(new Uint8Array(await readFile('public/icon-192.png')));
  input.addPage([600,800]).drawImage(image);
  input.addPage([600,800]).drawImage(image);
  const result = await PDFDocument.load(await exportDocument([makePage(1), makePage(0)], [{id:'source', name:'shared.pdf', bytes:await input.save()}]));
  const refs = result.getPages().map(p => p.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).values()[0].toString());
  assert.equal(refs[0], refs[1]);
});

test('text runs separated by a visible gap keep a space, adjacent runs do not', () => {
  const at=(str:string,x:number,width:number,hasEOL=false)=>({str,transform:[12,0,0,12,x,700],width,hasEOL});
  assert.deepEqual(itemsText([at('Họ tên:',72,40),at('Nguyễn Văn Ánh',130,80,true),at('INV-',72,24),at('1234',96,24),{type:'beginMarkedContent'},at(' đã trả ',120,40)]),['Họ tên: Nguyễn Văn Ánh','INV-1234 đã trả']);
  const sized=(str:string,x:number,width:number,size:number)=>({str,transform:[size,0,0,size,x,700],width});
  assert.deepEqual(itemsText([sized('T Ư',72,40,20),sized('ỚC',115,12,8)]),['T ƯỚC']);
});

test('TXT and Word files become PDFs with Vietnamese text, wrapping and page breaks', async () => {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Báo cáo</w:t></w:r><w:r><w:t xml:space="preserve"> quý 3 &amp; 4</w:t></w:r></w:p><w:p><w:r><w:t>Tên</w:t><w:tab/><w:t>Nguyễn Văn Ánh</w:t><w:br w:type="page"/><w:t>Trang hai</w:t></w:r><w:r><w:delText>xóa</w:delText></w:r></w:p><w:sectPr/></w:body></w:document>');
  assert.equal(await docxText(await zip.generateAsync({type:'uint8array'})), 'Báo cáo quý 3 & 4\nTên\tNguyễn Văn Ánh\fTrang hai');
  await assert.rejects(docxText(new Uint8Array([1,2,3])), /Word/);
  assert.equal(decodeText(new TextEncoder().encode('\uFEFFTiếng Việt')), 'Tiếng Việt');
  assert.equal(decodeText(new Uint8Array([0xff,0xfe,0x2f,0x01,0x20,0x00])), 'į ');
  const font = new Uint8Array(await readFile('public/fonts/NotoSans-Regular.ttf'));
  const bytes = await textDocument(`Hợp đồng thuê nhà\n${'Điều khoản dài '.repeat(60)}\fTrang hai: Trần Thị Hương`, font);
  const pdf = await getDocument({ data: bytes }).promise;
  assert.equal(pdf.numPages, 2);
  const first = (await (await pdf.getPage(1)).getTextContent()).items.map(i => 'str' in i ? i.str : '').join(' ');
  const second = (await (await pdf.getPage(2)).getTextContent()).items.map(i => 'str' in i ? i.str : '').join(' ');
  assert.match(first, /Hợp đồng thuê nhà/);
  assert.ok((first.match(/Điều khoản dài/g)?.length ?? 0) >= 59);
  assert.match(second, /Trần Thị Hương/);
  const long = await getDocument({ data: await textDocument('x'.repeat(20000), font) }).promise;
  assert.equal((await (await long.getPage(1)).getTextContent()).items.map(i => 'str' in i ? i.str : '').join('').length > 3000, true);
  await assert.rejects(textDocument('trang\f'.repeat(250), font), /200 trang/);
});

test('annotations do not mutate another page sharing the original Contents array', async () => {
  const input = await PDFDocument.create();
  const first = input.addPage([600,800]);
  first.drawRectangle({x:10,y:10,width:20,height:20});
  const second = input.addPage([600,800]);
  const sharedContents = input.context.register(first.node.Contents()!);
  first.node.set(PDFName.of('Contents'), sharedContents);
  second.node.set(PDFName.of('Contents'), sharedContents);
  const marked = {...makePage(), annotations:[{id:'mark',type:'highlight' as const,x:50,y:50,width:40,height:20,color:'#f3bf35',size:18,rotation:0}]};
  const result = await PDFDocument.load(await exportDocument([marked,makePage(1)], [{id:'source',name:'shared-contents.pdf',bytes:await input.save()}]));
  const untouched = result.getPage(1).node.Contents();
  assert.ok(untouched instanceof PDFArray);
  assert.equal(untouched.size(), 1);
});

test('existing text targets respect crop origins and reject text that cannot be laid out safely', () => {
  const page={...makePage(),originX:50,originY:100,rotation:90};
  const text={str:'Tiếng Việt',width:120,transform:[18,0,0,18,80,600],fontName:'F1'};
  const styles={F1:{ascent:.8,descent:-.2,fontFamily:'serif'}};
  const boxes=editableTextBoxes([text,{type:'beginMarkedContent'},null,{...text,str:' '},{...text,dir:'rtl'},{...text,transform:[0,18,-18,0,80,600]}],styles,page);
  assert.equal(boxes.length,1);
  assert.equal(boxes[0].x,30);
  assert.equal(boxes[0].baseline,300);
  assert.equal(boxes[0].y,285.6);
  assert.equal(boxes[0].height,18);
  assert.equal(boxes[0].fontFamily,'serif');
});

test('existing text with NaN font metrics still gets clickable joined lines', () => {
  const run = (str: string, x: number, width: number, font: string) => ({ str, width, transform: [20, 0, 0, 20, x, 700], fontName: font });
  const boxes = editableTextBoxes(
    [run('HƯ', 121.78, 29.12, 'F1'), run('Ớ', 151.65, 14.02, 'F2'), run('NG D', 166.42, 47.96, 'F1')],
    { F1: { ascent: NaN, descent: NaN }, F2: { ascent: NaN, descent: NaN } },
    makePage()
  );
  assert.deepEqual(boxes.map(b => b.text), ['HƯỚNG D']);
  assert.ok([boxes[0].y, boxes[0].height, boxes[0].width].every(Number.isFinite));
});

test('tall font ascents do not merge adjacent rows', () => {
  const run = (str: string, x: number, width: number, y: number, font: string) => ({ str, width, transform: [12, 0, 0, 12, x, y], fontName: font });
  const boxes = editableTextBoxes(
    [run('Upper row', 40, 60, 700, 'F1'), run('Lower row', 100, 60, 686, 'F2')],
    { F1: { ascent: NaN, descent: NaN }, F2: { ascent: 1.514, descent: -0.2 } },
    makePage()
  );
  assert.deepEqual(boxes.map(b => b.text), ['Upper row', 'Lower row']);
  assert.ok(boxes[1].height > 12 * 1.7 - 0.01);
});

test('deep subscripts join their line but larger neighbouring rows do not', () => {
  const run = (str: string, x: number, width: number, y: number, size: number) => ({ str, width, transform: [size, 0, 0, size, x, y], fontName: 'F1' });
  const styles = { F1: { ascent: 0.8, descent: -0.2 } };
  const sub = editableTextBoxes([run('H', 40, 9, 700, 12), run('2', 49, 4, 694.5, 7), run('O is water', 53, 60, 700, 12)], styles, makePage());
  assert.deepEqual(sub.map(b => b.text), ['H2O is water']);
  const rows = editableTextBoxes([run('Small note', 40, 40, 700, 8), run('Big heading', 80.5, 70, 691, 14)], styles, makePage());
  assert.deepEqual(rows.map(b => b.text), ['Small note', 'Big heading']);
});

test('existing text runs on one visual line are edited as a single line', () => {
  const page=makePage();
  const run=(str:string,x:number,width:number,y=700,size=12)=>({str,width,transform:[size,0,0,size,x,y],fontName:'F1'});
  const boxes=editableTextBoxes([run('Xin',40,20),run('chào',64,28),run('thế giới',96,46),run('Far away',400,50),run('Next line',40,52,680),run('Big',40,30,650,24)],{F1:{ascent:.8,descent:-.2}},page);
  assert.deepEqual(boxes.map(b=>b.text),['Xin chào thế giới','Far away','Next line','Big']);
  assert.equal(boxes[0].key,'0+1+2');
  assert.equal(boxes[0].x,40);
  assert.equal(boxes[0].width,102);
});

test('line joining keeps separate spaces, superscripts and slightly raised words', () => {
  const page=makePage();
  const run=(str:string,x:number,width:number,y=700,size=12)=>({str,width,transform:[size,0,0,size,x,y],fontName:'F1'});
  const styles={F1:{ascent:.8,descent:-.2}};
  const spaced=editableTextBoxes([run('Xin',40,20),run(' ',60,1),run('chào',61,28)],styles,page);
  assert.deepEqual(spaced.map(b=>b.text),['Xin chào']);
  const raised=editableTextBoxes([run('right',70,30,701.5),run('left',40,24)],styles,page);
  assert.deepEqual(raised.map(b=>b.text),['left right']);
  const superscript=editableTextBoxes([run('E = mc',40,40),run('2',80,4,705,7),run('is famous',86,50)],styles,page);
  assert.deepEqual(superscript.map(b=>b.text),['E = mc2 is famous']);
  assert.equal(superscript[0].size,12);
  assert.equal(superscript[0].baseline,100);
  const table=editableTextBoxes([run('Name',40,30),run(' ',70,120),run('Price',190,30)],styles,page);
  assert.deepEqual(table.map(b=>b.text),['Name','Price']);
  const justified=editableTextBoxes([run('Một',40,22),run(' ',62,18),run('dòng',80,30)],styles,page);
  assert.deepEqual(justified.map(b=>b.text),['Một dòng']);
  assert.equal(justified[0].width,70);
  const labelled=editableTextBoxes([run('Title',40,60,700,24),run('new',106,15,696,10)],styles,page);
  assert.deepEqual(labelled.map(b=>b.text),['Title','new']);
  const spacedLabel=editableTextBoxes([run('Title',40,60,700,24),run(' ',100,6,700,24),run('new',106,15,696,10)],styles,page);
  assert.deepEqual(spacedLabel.map(b=>b.text),['Title','new']);
});

test('formatted Vietnamese replacements embed all real font faces and keep cover layers reversible', async () => {
  const input=await PDFDocument.create();
  input.addPage([600,800]).drawText('Original text', {x:40,y:730,size:18});
  const source={id:'source',name:'original.pdf',bytes:await input.save()};
  const variants=Object.fromEntries(await Promise.all(['sans','serif'].flatMap(fontFamily=>[false,true].flatMap(bold=>[false,true].map(async italic=>{
    const key=fontKey({fontFamily:fontFamily as 'sans'|'serif',bold,italic});
    return [key,new Uint8Array(await readFile(`public/fonts/${key}.ttf`))];
  })))));
  const styles=['sans','serif'].flatMap(fontFamily=>[false,true].flatMap(bold=>[false,true].map(italic=>({fontFamily:fontFamily as 'sans'|'serif',bold,italic}))));
  const pages=styles.map((style,i)=>({...makePage(),id:`style-${i}`,rotation:(i%4)*90,annotations:[{
    id:`t${i}`,type:'text' as const,text:'Chữ mới: tiếng Việt',size:18,color:'#317cff',x:40,y:52,rotation:0,...style,
    cover:{key:'0',x:39,y:49,width:240,height:28,color:'#fff0dd'}
  }]}));
  const output=await exportDocument(pages,[source],variants);
  const parsed=await PDFDocument.load(output);
  const pdf=await getDocument({data:output.slice(),useSystemFonts:true}).promise;
  try {
    for(let i=0;i<styles.length;i++){
      const page=await pdf.getPage(i+1);
      const content=await page.getTextContent();
      const strings=content.items.flatMap(item=>'str' in item?[item.str]:[]);
      assert.ok(strings.includes('Original text'),'a cover must not claim to redact original text');
      assert.ok(strings.includes('Chữ mới: tiếng Việt'));
      const replacement=content.items.find(item=>'str' in item&&item.str==='Chữ mới: tiếng Việt');
      assert.ok(replacement&&'transform' in replacement);
      const [x,y]=page.getViewport({scale:1,rotation:0}).convertToViewportPoint(replacement.transform[4],replacement.transform[5]);
      assert.ok(Math.abs(x-40)<.1&&Math.abs(y-70)<.1);
      const resources=parsed.getPage(i).node.Resources()!.lookup(PDFName.of('Font'),PDFDict);
      const names=resources.values().map(ref=>parsed.context.lookup(ref,PDFDict).lookup(PDFName.of('BaseFont'),PDFName).decodeText());
      assert.ok(names.some(name=>name.includes(fontKey(styles[i]))),`${fontKey(styles[i])}: ${names}`);
      const ops=await page.getOperatorList();
      assert.ok(ops.fnArray.indexOf(OPS.constructPath)<ops.fnArray.lastIndexOf(OPS.showText),'cover precedes replacement glyphs');
    }
  } finally { await pdf.destroy(); }
  await assert.rejects(exportDocument(pages,[source],font),/phông chữ/);
});

test('dragging and resizing retain image bounds and coordinate systems after rotation', () => {
  const page={...makePage(),originX:50,originY:100};
  for(const rotation of [0,90,180,270]){
    const point={x:70,y:120};
    assert.deepEqual(fromPdf(toPdf(point,page,rotation),page,rotation),point);
    const image=placeImage({...page,rotation},{data:'data:image/png;base64,AA==',type:'image/png',width:300,height:150,name:'photo.png'},{x:40,y:50});
    const resized=resizeImage(image,10000,page);
    const bounds=dimensions({...page,rotation});
    assert.equal(resized.width/resized.height,2);
    assert.ok(resized.x>=0&&resized.x+resized.width<=bounds.width);
    assert.ok(resized.y>=0&&resized.y+resized.height<=bounds.height);
    const moved=moveAnnotation(resized,-10000,10000,page);
    assert.ok(moved.type==='image');
    assert.equal(moved.x,0);
    assert.equal(moved.y,bounds.height-moved.height);
  }
  const ink={id:'ink',type:'draw' as const,x:20,y:30,size:18,color:'#000000',rotation:0,points:[{x:20,y:30},{x:40,y:50}]};
  const moved=moveAnnotation(ink,5,-10);
  assert.ok(moved.type!=='image');
  assert.deepEqual(moved.points,[{x:25,y:20},{x:45,y:40}]);
  assert.deepEqual(ink.points,[{x:20,y:30},{x:40,y:50}]);
});
