import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { exportDocument, imagesDocument } from './pdf-engine.ts';
import { dimensions, toPdf, overlayTransform, importErrorMessage, reorderPages } from './model.ts';
import type { Page } from './model.ts';

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

test('empty documents and missing sources fail instead of producing corrupt files',async()=>{
  await assert.rejects(exportDocument([],[]),/ít nhất/);
  await assert.rejects(exportDocument([makePage()],[]),/gốc/);
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
});
