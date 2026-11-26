import DxfParser from 'dxf-parser';
import type { IDxf, IEntity, IPoint, IInsertEntity, ILineEntity, ILwpolylineEntity, IPolylineEntity, IArcEntity, ICircleEntity, IEllipseEntity, ITextEntity, IMtextEntity, IPointEntity, ISolidEntity, I3DfaceEntity, IDimensionEntity } from 'dxf-parser';
import type { CadDrawing, CadStyle, Point, Primitive } from './types.ts';

type Matrix = [number,number,number,number,number,number];
const IDENTITY: Matrix = [1,0,0,1,0,0];
const TAU = 2*Math.PI;
const radians = (v=0) => v*Math.PI/180;
const apply = (p: Point, m: Matrix): Point => ({x:m[0]*p.x+m[2]*p.y+m[4],y:m[1]*p.x+m[3]*p.y+m[5]});
function multiply(a: Matrix,b: Matrix): Matrix { return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]]; }
function hex(n?: number) { return `#${(Number.isFinite(n)?(n!&0xffffff):0).toString(16).padStart(6,'0')}`; }
function plainText(s: string) {
  return s.replace(/\\U\+([a-f\d]{4})/gi,(_,v)=>String.fromCharCode(parseInt(v,16)))
    .replace(/%%d/gi,'°').replace(/%%p/gi,'±').replace(/%%c/gi,'Ø')
    .replace(/\\[Pp]/g,'\n').replace(/\\~/g,' ').replace(/\\[LlOoKk]/g,'')
    .replace(/\\[AaCcFfHhQqTtWw][^;]*;/g,'').replace(/\\S([^;]*);/g,(_,v)=>v.replace(/[\^#]/g,'/'))
    .replace(/[{}]/g,'').replace(/\\([\\{}])/g,'$1');
}

// DxfParser intentionally skips unknown entities. Inspect group pairs too so missing
// CAD content is always disclosed, including entities skipped before normalization.
const SUPPORTED = new Set(['LINE','LWPOLYLINE','POLYLINE','VERTEX','SEQEND','CIRCLE','ARC','ELLIPSE','POINT','TEXT','MTEXT','SOLID','3DFACE','INSERT','DIMENSION','ATTDEF']);
function auditDxf(text: string) {
  const lines=text.replace(/^\uFEFF/,'').split(/\r\n|\r|\n/), unsupported=new Map<string,number>();
  let section='', nextSection=false;
  for(let i=0;i+1<lines.length;i+=2) {
    const code=lines[i].trim(), value=lines[i+1].trim();
    if(nextSection&&code==='2') {section=value;nextSection=false;continue;}
    if(code!=='0')continue;
    if(value==='SECTION'){nextSection=true;continue;}
    if(value==='ENDSEC'){section='';continue;}
    if((section==='ENTITIES'||section==='BLOCKS')&&!SUPPORTED.has(value)&&!['BLOCK','ENDBLK'].includes(value))unsupported.set(value,(unsupported.get(value)||0)+1);
  }
  return [...unsupported].map(([type,n])=>`${type}: ${n} đối tượng không được vẽ.`);
}

export function decodeDxf(bytes: Uint8Array) {
  const prefix=new TextDecoder().decode(bytes.subarray(0,8192));
  if(prefix.startsWith('AutoCAD Binary DXF'))throw new Error('DXF nhị phân chưa hỗ trợ. Hãy lưu thành ASCII DXF (UTF-8).');
  const page=prefix.match(/\$DWGCODEPAGE\s+3\s+ANSI_(\d+)/)?.[1];
  const version=prefix.match(/\$ACADVER\s+1\s+(AC\d+)/)?.[1];
  const legacy=version&&Number(version.slice(2))<1021;
  const encoding=legacy&&page?({'1258':'windows-1258','1252':'windows-1252','1251':'windows-1251','932':'shift_jis','936':'gbk','950':'big5','949':'euc-kr'} as Record<string,string>)[page]:undefined;
  return new TextDecoder(encoding||'utf-8').decode(bytes);
}

export function parseDxf(text: string,name: string,format: 'DXF'|'DWG'='DXF',layerVisibility?:Record<string,boolean>): CadDrawing {
  if(!/\bSECTION\b/.test(text)||!/\bENTITIES\b/.test(text)||!/\bEOF\b/.test(text))throw new Error('Tệp CAD không hợp lệ hoặc DXF chưa hoàn chỉnh.');
  let db: IDxf|null;
  try{db=new DxfParser().parseSync(text);}catch{throw new Error('Không đọc được DXF. Hãy lưu lại dưới dạng ASCII DXF R2000–R2018.');}
  if(!db)throw new Error('Không đọc được bản vẽ CAD.');
  if(layerVisibility)for(const l of Object.values(db.tables?.layer?.layers||{}))if(l.name in layerVisibility){l.visible=layerVisibility[l.name];l.frozen=false;}
  return normalize(db,name,format,auditDxf(text));
}

function normalize(db: IDxf,name: string,format: 'DXF'|'DWG',initialWarnings: string[]): CadDrawing {
  const primitives: Primitive[]=[], warnings=new Set(initialWarnings), layerTable=db.tables?.layer?.layers||{};
  const layers=new Map(Object.values(layerTable).map(l=>[l.name,{name:l.name,color:hex(l.color),visible:l.visible!==false&&!l.frozen}]));
  let count=0,points=0;
  const ensureLayer=(name: string)=>{if(!layers.has(name))layers.set(name,{name,color:'#000000',visible:true});};
  function append(p: Primitive) {
    points+=p.kind==='path'?p.points.length:1;
    if(primitives.length>=100000||points>1000000)throw new Error('Bản vẽ quá phức tạp (tối đa 100.000 đối tượng / 1 triệu điểm). Hãy tách bản vẽ.');
    const coords=p.kind==='path'?p.points:[p.point];
    if(coords.some(q=>!Number.isFinite(q.x)||!Number.isFinite(q.y)||Math.abs(q.x)>1e12||Math.abs(q.y)>1e12)){warnings.add('Một số tọa độ không hợp lệ đã bị bỏ qua.');return;}
    primitives.push(p);
  }
  function visit(e: IEntity,m=IDENTITY,parentLayer='0',parents: string[]=[],parentColor?: string,stack: string[]=[]) {
    if(++count>150000)throw new Error('Bản vẽ có quá nhiều đối tượng hoặc khối lặp. Hãy tách bản vẽ nhỏ hơn.');
    if(e.inPaperSpace){warnings.add('Chỉ vẽ Model Space; bố cục Paper Space / viewport chưa hỗ trợ.');return;}
    if(e.visible===false)return;
    const layer=e.layer==='0'?parentLayer:(e.layer||parentLayer);ensureLayer(layer);
    const required=[...new Set([...parents,layer])];
    const color=e.colorIndex===0&&parentColor?parentColor:Number.isFinite(e.color)?hex(e.color):(layers.get(layer)?.color||'#000000');
    const line=db.tables?.lineType?.lineTypes?.[e.lineType];
    const style: CadStyle={layers:required,color,width:e.lineweight>0?e.lineweight/100:0.25,dash:line?.pattern?.map(n=>Math.abs(Number(n))).filter(n=>n>0)};
    const path=(vertices: Point[],closed=false,fill=false)=>{if(vertices.some(p=>'z'in p&&Number(p.z)!==0&&p.z!==undefined))warnings.add('Tọa độ có cao độ Z được chiếu xuống mặt phẳng XY, không dựng hình 3D.');append({...style,kind:'path',points:vertices.map(p=>apply(p,m)),closed,fill});};
    const warn=(s: string)=>warnings.add(s);
    const arc=(center: Point,rx:number,ry:number,angle:number,start:number,sweep:number)=>{
      if(!Number.isFinite(rx)||!Number.isFinite(ry)||Math.max(Math.abs(rx),Math.abs(ry))>1e12)return;
      const n=Math.max(8,Math.ceil(Math.abs(sweep)/TAU*256));
      const c=Math.cos(angle),s=Math.sin(angle);
      path(Array.from({length:n+1},(_,i)=>{const t=start+sweep*i/n,x=rx*Math.cos(t),y=ry*Math.sin(t);return{x:center.x+x*c-y*s,y:center.y+x*s+y*c};}),Math.abs(sweep)>=TAU-1e-6);
    };
    if('extrusionDirectionZ'in e&&e.extrusionDirectionZ!==undefined&&e.extrusionDirectionZ!==1){warn('Đối tượng có hệ tọa độ OCS nghiêng chưa được vẽ.');return;}
    if('extrusionDirection'in e){const ext=e.extrusionDirection as IPoint;if(ext&&(ext.x||ext.y||ext.z!==1)){warn('Đối tượng có hệ tọa độ OCS nghiêng chưa được vẽ.');return;}}
    switch(e.type){
      case 'LINE':{const a=e as ILineEntity;path(a.vertices);break;}
      case 'LWPOLYLINE':case 'POLYLINE':{
        const a=e as ILwpolylineEntity&IPolylineEntity;
        if(a.is3dPolyline||a.is3dPolygonMesh||a.isPolyfaceMesh){warn('Polyline/mesh 3D chưa được vẽ.');return;}
        if(a.includesCurveFitVertices||a.includesSplineFitVertices){warn('Polyline có spline/curve fitting chưa được vẽ.');return;}
        const v=a.vertices||[],out:Point[]=[];
        for(let i=0;i<v.length;i++){
          const p=v[i],q=v[(i+1)%v.length];out.push(p);
          if(!q||(i===v.length-1&&!a.shape)||!p.bulge)continue;
          const theta=4*Math.atan(p.bulge),d=Math.hypot(q.x-p.x,q.y-p.y),radius=d*(1+p.bulge*p.bulge)/(4*Math.abs(p.bulge));
          const cx=(p.x+q.x)/2-(q.y-p.y)*(1-p.bulge*p.bulge)/(4*p.bulge),cy=(p.y+q.y)/2+(q.x-p.x)*(1-p.bulge*p.bulge)/(4*p.bulge),angle=Math.atan2(p.y-cy,p.x-cx);
          const n=Math.max(2,Math.ceil(Math.abs(theta)/TAU*256));
          for(let j=1;j<n;j++)out.push({x:cx+radius*Math.cos(angle+theta*j/n),y:cy+radius*Math.sin(angle+theta*j/n)});
        }
        path(out,!!a.shape);if(a.width||v.some(p=>p.startWidth||p.endWidth))warn('Bề rộng polyline được thay bằng độ dày nét in.');break;
      }
      case 'CIRCLE':{const a=e as ICircleEntity;arc(a.center,a.radius,a.radius,0,0,TAU);break;}
      case 'ARC':{const a=e as IArcEntity;arc(a.center,a.radius,a.radius,0,a.startAngle,((a.endAngle-a.startAngle)%TAU+TAU)%TAU||TAU);break;}
      case 'ELLIPSE':{const a=e as IEllipseEntity,r=Math.hypot(a.majorAxisEndPoint.x,a.majorAxisEndPoint.y);arc(a.center,r,r*a.axisRatio,Math.atan2(a.majorAxisEndPoint.y,a.majorAxisEndPoint.x),a.startAngle||0,((a.endAngle-a.startAngle)%TAU+TAU)%TAU||TAU);break;}
      case 'SOLID':case '3DFACE':{const a=e as ISolidEntity&I3DfaceEntity,v=a.points||a.vertices;if(v?.length>=3)path([v[0],v[1],v[3]||v[2],v[2]],true,e.type==='SOLID');break;}
      case 'POINT':{const a=e as IPointEntity;path([a.position,{x:a.position.x+0.001,y:a.position.y}]);break;}
      case 'TEXT':case 'MTEXT':{
        const a=e as ITextEntity&IMtextEntity;
        const str=plainText(a.text||'');if(!str.trim())break;
        const localAngle=a.rotation!==undefined?radians(a.rotation):a.directionVector?Math.atan2(a.directionVector.y,a.directionVector.x):0,u={x:Math.cos(localAngle),y:Math.sin(localAngle)},v={x:-u.y,y:u.x};
        const xlen=Math.hypot(m[0]*u.x+m[2]*u.y,m[1]*u.x+m[3]*u.y),ylen=Math.hypot(m[0]*v.x+m[2]*v.y,m[1]*v.x+m[3]*v.y),height=(a.textHeight||a.height||1)*ylen;
        const position=e.type==='MTEXT'?a.position:((a.halign||a.valign)&&a.endPoint?a.endPoint:a.startPoint);
        if(!position||!Number.isFinite(height)||height<=0)break;
        if(m[0]*m[3]-m[1]*m[2]<0)warn('Chữ trong block lật gương được thay bằng chữ đọc được.');
        if(e.type==='MTEXT'&&a.width)warn('MTEXT giữ ngắt dòng có sẵn, không tái tạo tự động xuống dòng/phông SHX.');
        append({...style,kind:'text',point:apply(position,m),text:str,height,rotation:Math.atan2(m[1]*u.x+m[3]*u.y,m[0]*u.x+m[2]*u.y)*180/Math.PI,widthScale:(a.xScale||1)*xlen/(ylen||1),align:e.type==='MTEXT'?(['left','center','right'] as const)[((a.attachmentPoint||1)-1)%3]:a.halign===1?'center':a.halign===2?'right':'left',vertical:e.type==='MTEXT'?(a.attachmentPoint<=3?'top':a.attachmentPoint<=6?'middle':'bottom'):a.valign===3?'top':a.valign===2?'middle':'bottom'});
        break;
      }
      case 'INSERT':case 'DIMENSION':{
        const a=e as IInsertEntity&IDimensionEntity,key=e.type==='INSERT'?a.name:a.block,block=db.blocks?.[key];
        if(!block){warn(`Khối/tham chiếu ngoài không có dữ liệu: ${key||'(không tên)'}.`);break;}
        if(stack.includes(key)||stack.length>=16){warn('Khối lặp vòng hoặc lồng quá 16 cấp đã bị bỏ qua.');break;}
        if(block.xrefPath){warn('Tham chiếu ngoài (XREF) không được tải; chỉ dùng hình học đã nhúng trong tệp.');}
        const cols=Math.max(1,a.columnCount||1),rows=Math.max(1,a.rowCount||1);
        if(cols*rows>10000)throw new Error('Mảng block quá lớn. Hãy tách bản vẽ.');
        for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
          let local=IDENTITY;
          if(e.type==='INSERT'){
            const r=radians(a.rotation),c=Math.cos(r),s=Math.sin(r),sx=a.xScale??1,sy=a.yScale??1,b=block.position||{x:0,y:0};
            const dx=col*(a.columnSpacing||0)-b.x*sx,dy=row*(a.rowSpacing||0)-b.y*sy;
            local=[sx*c,sx*s,-sy*s,sy*c,(a.position?.x||0)+c*dx-s*dy,(a.position?.y||0)+s*dx+c*dy];
          }
          for(const child of block.entities||[])visit(child,multiply(m,local),layer,required,color,[...stack,key]);
        }
        break;
      }
      case 'ATTDEF':break; // attribute definitions are templates, not inserted values
      default:warn(`${e.type}: chưa hỗ trợ vẽ đối tượng này.`);
    }
  }
  for(const e of db.entities||[])visit(e);
  if(!primitives.length)throw new Error('Không tìm thấy đối tượng 2D có thể vẽ trong Model Space. Hãy xuất bản vẽ thành DXF 2D.');
  return{name,format,version:String(db.header?.$ACADVER||''),unit:Number(db.header?.$INSUNITS||0),layers:[...layers.values()],primitives,warnings:[...warnings]};
}
