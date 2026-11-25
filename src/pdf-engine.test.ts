import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFArray, PDFDict, PDFDocument, PDFName, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { loadPdfWithPassword, PdfPasswordCancelledError } from './pdf-password.ts';
import { exportDocument, imagesDocument } from './pdf-engine.ts';
import { dimensions, toPdf, overlayTransform } from './model.ts';
import type { Page } from './model.ts';
import { PdfPageLimitError, pdfImportErrorMessage } from './pdf-open.ts';
import { pageIndexForInput } from './page-navigation.ts';

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
  const pdf = await loadPdfWithPassword(getDocument({data:encryptedPdf()}), async retry => {
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
  await assert.rejects(loadPdfWithPassword(task, async () => null), PdfPasswordCancelledError);
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
