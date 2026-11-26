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
test('single-line TEXT preserves literal braces and backslash commands',()=>{
  const label=String.raw`{A} C:\Projects\Plan`;
  const d=parseDxf(fixture.replace('Xưởng thiết kế Việt',label),'literal-text.dxf');
  const text=d.primitives.find(p=>p.kind==='text');assert.ok(text&&text.kind==='text');assert.equal(text.text,label);
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
test('physical stroke extents are inside paper, even with zero margins',()=>{
  const d={...drawing,primitives:[{kind:'path' as const,layers:['WALLS'],color:'#000000',width:0.5,points:[{x:0,y:0},{x:297,y:0}],closed:false}]};
  assert.equal(plotLayout(d,{...options,margin:0,scale:'fixed',denominator:1,lineWidth:0.5}).overflow,true);
  const fit=plotLayout(d,{...options,margin:0,lineWidth:0.5});
  almost(fit.x,0.25);almost(fit.scale*297+fit.x,296.75);
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
test('3DFACE perimeter order and fourth vertex survive trailing edge flags',()=>{
  const face='0\n3DFACE\n8\nWALLS\n10\n0\n20\n0\n11\n10\n21\n0\n12\n10\n22\n10\n13\n0\n23\n10\n70\n0\n';
  const d=parseDxf(fixture.replace('0\nENDSEC\n0\nEOF',face+'0\nENDSEC\n0\nEOF'),'face.dxf');
  const p=d.primitives.at(-1)!;assert.equal(p.kind,'path');if(p.kind==='path')assert.deepEqual(p.points,[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}]);
});
test('DXF nonplot layers default off but new-viewport frozen layers stay on',()=>{
  const d=parseDxf(fixture.replace('2\nWALLS\n70\n0','2\nWALLS\n70\n2').replace('2\nDOORS\n70\n0','2\nDOORS\n290\n0\n70\n0'),'layer-flags.dxf');
  assert.equal(d.layers.find(l=>l.name==='WALLS')?.visible,true);assert.equal(d.layers.find(l=>l.name==='DOORS')?.visible,false);
});
test('tilted CIRCLE and TEXT are omitted with a coordinate-system warning',()=>{
  const d=parseDxf(fixture.replace('40\n15','40\n15\n210\n0\n220\n1\n230\n0').replace('Xưởng thiết kế Việt','Xưởng thiết kế Việt\n210\n0\n220\n1\n230\n0'),'tilted.dxf');
  assert.equal(d.primitives.length,5);assert.ok(d.warnings.some(w=>w.includes('OCS nghiêng')));
});
test('negative-Z WCS ellipses and elliptical arcs retain their geometry',()=>{
  const ellipse=(end:number)=>'0\nSECTION\n2\nENTITIES\n0\nELLIPSE\n10\n20\n20\n30\n11\n10\n21\n0\n40\n0.5\n41\n0\n42\n'+end+'\n210\n0\n220\n0\n230\n-1\n0\nENDSEC\n0\nEOF';
  for(const end of [2*Math.PI,Math.PI/2]){
    const d=parseDxf(ellipse(end),'ellipse.dxf'),p=d.primitives[0];assert.equal(d.primitives.length,1);assert.equal(d.warnings.length,0);assert.equal(p.kind,'path');if(p.kind!=='path')continue;
    almost(p.points[0].x,30);almost(p.points[0].y,30);
    if(end===Math.PI/2){almost(p.points.at(-1)!.x,20);almost(p.points.at(-1)!.y,25);}
  }
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
