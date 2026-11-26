import { PDFDocument, rgb, pushGraphicsState, popGraphicsState, setLineWidth, setLineCap, setLineJoin, LineCapStyle, LineJoinStyle, setStrokingColor, setFillingColor, setDashPattern, moveTo, lineTo, closePath, stroke, fillAndStroke, concatTransformationMatrix } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { PAPER_MM } from './types.ts';
import type { CadDrawing, CadText, PlotOptions, Point, Primitive } from './types.ts';

export const MM_TO_PT=72/25.4;
export const UNIT_OPTIONS=[{name:'Milimét (mm)',value:1,code:4},{name:'Centimét (cm)',value:10,code:5},{name:'Mét (m)',value:1000,code:6},{name:'Inch',value:25.4,code:1},{name:'Feet',value:304.8,code:2}];
export function drawingUnitMm(unit: number){return UNIT_OPTIONS.find(u=>u.code===unit)?.value||1;}
export function pageSizeMm(options: PlotOptions): [number,number] {
  const size=options.paper==='custom'?[options.customWidth,options.customHeight]:PAPER_MM[options.paper];
  if(!size||size.some(n=>!Number.isFinite(n)||n<50||n>2000))throw new Error('Khổ giấy phải từ 50 đến 2.000 mm mỗi chiều.');
  return options.orientation==='landscape'?[Math.max(...size),Math.min(...size)]:[Math.min(...size),Math.max(...size)];
}
export function printablePrimitives(drawing: CadDrawing,options: PlotOptions) {
  const chosen=new Set(options.layers);
  return drawing.primitives.filter(p=>p.layers.every(l=>chosen.has(l)));
}
type Measure = (text: string,height: number)=>number;
export function textLayout(p: CadText,measure: Measure=(s,h)=>Array.from(s).length*h*0.9) {
  const lines=p.text.split('\n'),widths=lines.map(s=>measure(s,p.height)*p.widthScale),height=p.height*(1+(lines.length-1)*1.35);
  const y=p.vertical==='top'?-p.height:p.vertical==='middle'?height/2-p.height:height-p.height;
  return {lines,widths,height,y};
}
function bounds(primitives: Primitive[],measure?: Measure) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  const add=(p: Point)=>{minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);};
  for(const p of primitives){
    if(p.kind==='path')p.points.forEach(add);
    else{
      const {widths,height,y}=textLayout(p,measure),width=Math.max(...widths,0),x=p.align==='center'?-width/2:p.align==='right'?-width:0,r=p.rotation*Math.PI/180,c=Math.cos(r),s=Math.sin(r);
      for(const [dx,dy]of[[x,y+p.height],[x+width,y+p.height],[x,y+p.height-height-p.height*0.3],[x+width,y+p.height-height-p.height*0.3]])add({x:p.point.x+c*dx-s*dy,y:p.point.y+s*dx+c*dy});
    }
  }
  if(![minX,minY,maxX,maxY].every(Number.isFinite))throw new Error('Không có nội dung trong các layer đã chọn.');
  return{minX,minY,maxX,maxY,width:Math.max(maxX-minX,0.001),height:Math.max(maxY-minY,0.001)};
}
export function plotLayout(drawing: CadDrawing,options: PlotOptions,measure?: Measure) {
  const [width,height]=pageSizeMm(options),margin=options.margin;
  if(!Number.isFinite(margin)||margin<0||margin*2>=Math.min(width,height))throw new Error('Lề không hợp lệ hoặc lớn hơn khổ giấy.');
  if(!Number.isFinite(options.unitMm)||options.unitMm<=0||options.unitMm>1e6)throw new Error('Đơn vị bản vẽ không hợp lệ.');
  if(!Number.isFinite(options.denominator)||options.denominator<0.001||options.denominator>1e6)throw new Error('Mẫu số tỷ lệ phải từ 0,001 đến 1.000.000.');
  if(!Number.isFinite(options.lineWidth)||options.lineWidth<0.05||options.lineWidth>3||!Number.isFinite(options.lineMultiplier)||options.lineMultiplier<0.1||options.lineMultiplier>10)throw new Error('Độ dày nét: 0,05–3 mm; hệ số nét: 0,1–10.');
  const primitives=printablePrimitives(drawing,options).filter(p=>p.kind!=='path'||p.points.length>=2),b=bounds(primitives,measure),availableW=width-2*margin,availableH=height-2*margin;
  // Pen widths are physical, not drawing units. Expand each primitive's own
  // bounds: a thick interior stroke must not inflate thin outer boundaries.
  const origin={x:b.minX,y:b.minY};
  const boxes=primitives.map(p=>{const box=bounds([p],measure);return{minX:box.minX-origin.x,minY:box.minY-origin.y,maxX:box.maxX-origin.x,maxY:box.maxY-origin.y,radius:p.kind==='path'?(options.lineMode==='uniform'?options.lineWidth:p.width*options.lineMultiplier)/2:0};});
  const envelope=(scale:number)=>{
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const p of boxes){minX=Math.min(minX,p.minX*scale-p.radius);minY=Math.min(minY,p.minY*scale-p.radius);maxX=Math.max(maxX,p.maxX*scale+p.radius);maxY=Math.max(maxY,p.maxY*scale+p.radius);}
    return{minX,minY,width:maxX-minX,height:maxY-minY};
  };
  const zero=envelope(0);
  if(zero.width>availableW||zero.height>availableH)throw new Error('Vùng in quá nhỏ cho độ dày nét đã chọn.');
  let scale=options.unitMm/options.denominator;
  if(options.scale==='fit'){
    let low=0,high=Math.min(availableW/b.width,availableH/b.height);
    // Monotone per-primitive envelopes give a tight fit even with mixed pens.
    for(let i=0;i<48;i++){const mid=(low+high)/2,box=envelope(mid);if(box.width<=availableW&&box.height<=availableH)low=mid;else high=mid;}
    scale=low;
  }
  if(!(scale>0)||!Number.isFinite(scale))throw new Error('Vùng in quá nhỏ cho độ dày nét đã chọn.');
  const plotted=envelope(scale),x=margin+(options.centered?(availableW-plotted.width)/2:0)-plotted.minX,y=margin+(options.centered?(availableH-plotted.height)/2:0)-plotted.minY;
  return{width,height,scale,x,y,origin,primitives,denominator:options.unitMm/scale,overflow:plotted.width>availableW+1e-8||plotted.height>availableH+1e-8};
}
export function plotColor(hex: string,mode: PlotOptions['color']) {
  let n=parseInt(hex.slice(1),16);if(n===0xffffff)n=0;
  const r=(n>>16&255)/255,g=(n>>8&255)/255,b=(n&255)/255;
  return mode==='mono'?rgb(0,0,0):mode==='gray'?rgb(...Array(3).fill(0.299*r+0.587*g+0.114*b) as [number,number,number]):rgb(r,g,b);
}

export async function plotPdf(drawing: CadDrawing,options: PlotOptions,fontBytes: Uint8Array,signal?: AbortSignal) {
  signal?.throwIfAborted();
  const doc=await PDFDocument.create();doc.registerFontkit(fontkit);
  const font=await doc.embedFont(fontBytes,{subset:true});
  const measure=(s:string,h:number)=>font.widthOfTextAtSize(s,h);
  const layout=plotLayout(drawing,options,measure);
  if(layout.overflow)throw new Error('Bản vẽ vượt vùng in ở tỷ lệ này. Hãy tăng mẫu số tỷ lệ, chọn khổ lớn hơn hoặc Vừa trang.');
  const page=doc.addPage([layout.width*MM_TO_PT,layout.height*MM_TO_PT]);
  doc.setTitle(drawing.name.replace(/\.(dwg|dxf)$/i,''));doc.setCreator('Giấy PDF — CAD 2D');
  const factor=layout.scale*MM_TO_PT,project=(p:Point)=>({x:((p.x-layout.origin.x)*layout.scale+layout.x)*MM_TO_PT,y:((p.y-layout.origin.y)*layout.scale+layout.y)*MM_TO_PT});
  for(let i=0;i<layout.primitives.length;i++){
    if(i%500===0){await new Promise(resolve=>setTimeout(resolve,0));signal?.throwIfAborted();}
    const p=layout.primitives[i],color=plotColor(p.color,options.color);
    if(p.kind==='path'){
      if(p.points.length<2)continue;
      const coordinates=p.points.map(project),first=coordinates[0];
      page.pushOperators(pushGraphicsState(),setStrokingColor(color),setFillingColor(color),setLineWidth((options.lineMode==='uniform'?options.lineWidth:p.width*options.lineMultiplier)*MM_TO_PT),setLineCap(LineCapStyle.Round),setLineJoin(LineJoinStyle.Round),setDashPattern((p.dash||[]).map(n=>n*factor),0),moveTo(first.x,first.y));
      // Avoid spreading a million operators onto the JS stack.
      for(const q of coordinates.slice(1))page.pushOperators(lineTo(q.x,q.y));
      if(p.closed)page.pushOperators(closePath());
      page.pushOperators(p.fill?fillAndStroke():stroke(),popGraphicsState());
    }else{
      const point=project(p.point),r=p.rotation*Math.PI/180,c=Math.cos(r),s=Math.sin(r),{lines,widths,y}=textLayout(p,measure);
      page.pushOperators(pushGraphicsState(),concatTransformationMatrix(c*p.widthScale,s*p.widthScale,-s,c,point.x,point.y));
      for(let j=0;j<lines.length;j++){
        const line=lines[j];if(!line)continue;
        const dx=(p.align==='center'?-widths[j]/2:p.align==='right'?-widths[j]:0)/(p.widthScale||1);
        page.drawText(line,{font,size:p.height*factor,x:dx*factor,y:(y-j*p.height*1.35)*factor,color});
      }
      page.pushOperators(popGraphicsState());
    }
  }
  signal?.throwIfAborted();
  return{bytes:await doc.save(),layout};
}
