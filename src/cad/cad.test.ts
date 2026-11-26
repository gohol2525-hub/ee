import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { LibreDwg } from '@mlightcad/libredwg-web';
import { parseDxf, decodeDxf } from './parse.ts';
import { dwgToDxf } from './dwg.ts';
import { DEFAULT_PLOT } from './types.ts';
import { drawingUnitMm, MM_TO_PT, pageSizeMm, plotColor, plotLayout, plotPdf, printablePrimitives } from './plot.ts';

const fixture=await readFile(new URL('./fixtures/workshop.dxf',import.meta.url),'utf8');
const drawing=parseDxf(fixture,'workshop.dxf');
const options={...DEFAULT_PLOT,layers:drawing.layers.filter(l=>l.visible).map(l=>l.name)};
const almost=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-6,`${actual} != ${expected}`);

test('DXF preserves millimetres, Vietnamese text and hidden layer defaults',()=>{
  assert.equal(drawing.unit,4);assert.equal(drawing.version,'AC1021');assert.equal(drawing.primitives.length,7);
  assert.equal(drawing.layers.find(l=>l.name==='HIDDEN')?.visible,false);
  assert.equal(printablePrimitives(drawing,options).length,6);
  assert.ok(drawing.primitives.some(p=>p.kind==='text'&&p.text==='Xưởng thiết kế Việt'));
});
test('block base point, rotation, inherited layer and color are applied',()=>{
  const p=drawing.primitives[5];assert.equal(p.kind,'path');if(p.kind!=='path')return;
  assert.deepEqual(p.layers,['DOORS']);assert.equal(p.color,'#ff0000');
  almost(p.points[0].x,140);almost(p.points[0].y,40);almost(p.points[1].x,140);almost(p.points[1].y,70);
});
test('bulge polylines produce a curved vector path, not a straight chord',()=>{
  const p=drawing.primitives[2];assert.equal(p.kind,'path');if(p.kind!=='path')return;
  assert.ok(p.points.length>20);almost(p.points[0].x,100);almost(p.points.at(-1)!.y,100);
});
test('truecolor overrides implicit ByLayer without a color-index group',()=>{
  const d=parseDxf(fixture.replace('370\n50','420\n65280\n370\n50'),'color.dxf');
  assert.equal(d.primitives[1].color,'#00ff00');
});
test('paper, orientation, custom dimensions, units and 1:1/1:100 scale are physical',()=>{
  assert.deepEqual(pageSizeMm(options),[297,210]);assert.deepEqual(pageSizeMm({...options,paper:'A3',orientation:'portrait'}),[297,420]);
  assert.deepEqual(pageSizeMm({...options,paper:'custom',customWidth:500,customHeight:200}),[500,200]);
  almost(plotLayout(drawing,{...options,scale:'fixed',denominator:1}).scale,1);
  almost(plotLayout(drawing,{...options,scale:'fixed',denominator:100,unitMm:1000}).scale,10);
  assert.equal(drawingUnitMm(1),25.4);
});
test('fit uses only selected visible layers and fixed scale detects overflow',()=>{
  const base=plotLayout(drawing,options),withHidden=plotLayout(drawing,{...options,layers:drawing.layers.map(l=>l.name)});
  assert.ok(withHidden.scale<base.scale);
  assert.equal(plotLayout(drawing,{...options,scale:'fixed',denominator:0.1}).overflow,true);
  assert.throws(()=>plotLayout(drawing,{...options,layers:[]}),/Không có nội dung/);
});
test('invalid numeric inputs cannot produce corrupt PDF coordinates',()=>{
  for(const patch of [{margin:NaN},{margin:120},{lineWidth:0},{lineMultiplier:100},{denominator:0},{unitMm:Infinity},{paper:'custom' as const,customWidth:10}])assert.throws(()=>plotLayout(drawing,{...options,...patch}));
});
test('black-white, color and grayscale modes are predictable on white paper',()=>{
  assert.deepEqual(plotColor('#ff0000','color'),{type:'RGB',red:1,green:0,blue:0});
  assert.deepEqual(plotColor('#ff0000','mono'),{type:'RGB',red:0,green:0,blue:0});
  assert.equal(plotColor('#ff0000','gray').red,0.299);assert.equal(plotColor('#ffffff','color').red,0);
});
test('unsupported content is disclosed; invalid and binary DXF are rejected',()=>{
  const d=parseDxf(fixture.replace('0\nENDSEC\n0\nEOF','0\nHATCH\n8\nWALLS\n0\nENDSEC\n0\nEOF'),'unsupported.dxf');
  assert.ok(d.warnings.some(w=>w.startsWith('HATCH:')));
  assert.throws(()=>parseDxf('not a drawing','bad.dxf'),/không hợp lệ/);
  assert.throws(()=>decodeDxf(new TextEncoder().encode('AutoCAD Binary DXF')),/nhị phân/);
});
test('recursive blocks terminate with a clear warning',()=>{
  const d=parseDxf(fixture.replace('0\nENDBLK','0\nINSERT\n8\n0\n2\nDESK\n10\n0\n20\n0\n0\nENDBLK'),'recursive.dxf');
  assert.ok(d.warnings.some(w=>w.includes('lặp vòng')));
});
test('exports a real vector PDF of the chosen paper size and blocks clipping',async()=>{
  const font=await readFile(new URL('../../public/fonts/NotoSans-Regular.ttf',import.meta.url));
  const {bytes}=await plotPdf(drawing,{...options,paper:'A3',orientation:'portrait',color:'color',lineWidth:0.5},font);
  const pdf=await PDFDocument.load(bytes);assert.equal(pdf.getPageCount(),1);
  almost(pdf.getPage(0).getWidth(),297*MM_TO_PT);almost(pdf.getPage(0).getHeight(),420*MM_TO_PT);
  assert.ok(bytes.length>2000);
  await assert.rejects(plotPdf(drawing,{...options,scale:'fixed',denominator:0.01},font),/vượt vùng in/);
  await assert.rejects(plotPdf(drawing,options,font,AbortSignal.abort()),/aborted|abort/i);
});
test('genuine DWG fixture decodes through WASM, preserving native layer visibility',async()=>{
  const lib=await LibreDwg.create(new URL('../../node_modules/@mlightcad/libredwg-web/wasm',import.meta.url).pathname);
  const b=await readFile(new URL('./fixtures/entities-2d.dwg',import.meta.url)),out=dwgToDxf(lib,new Uint8Array(b).buffer);
  const d=parseDxf(decodeDxf(out.bytes),'entities-2d.dwg','DWG',out.layers);
  assert.ok(d.primitives.length>=10);assert.equal(d.layers.find(l=>l.name==='0')?.visible,true);
  assert.equal(d.layers.find(l=>l.name==='Defpoints')?.visible,false);
  assert.ok(printablePrimitives(d,{...options,layers:['0']}).length>0);
});
