import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNull, PDFPageLeaf, PDFString, degrees } from 'pdf-lib';
import { getDocument, OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { rasterizeAnnotationImage, rasterizeImage } from './image-raster.ts';
import { exportDocument, imageKind, imagesDocument, jpegOrientation, splitDocument } from './pdf-engine.ts';
import { dimensions, toPdf, overlayTransform, importErrorMessage, placeImage, referencedSourceIds, reorderPages } from './model.ts';
import type { Page } from './model.ts';
import { pageRangeLabel, parsePageRange } from './page-range.ts';

const font = new Uint8Array(await readFile('public/fonts/NotoSans-Regular.ttf'));
const makePage = (index=0): Page => ({id:`p${index}`,sourceId:'source',index,rotation:0,width:600,height:800,annotations:[]});

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
