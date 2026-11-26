import { useEffect, useRef, useState } from 'react';
import { Download, Eye, FileUp, Loader2, RotateCcw } from 'lucide-react';
import { getFontBytes, openPdf } from '../pdf';
import { saveBlob } from '../model';
import { CAD_TYPES, DEFAULT_PLOT, isCadFile, PAPER_MM } from './types';
import type { CadDrawing, PlotOptions } from './types';
import { drawingUnitMm, plotPdf, UNIT_OPTIONS } from './plot';
import { readCad } from './runtime';
import './style.css';

type Output = Awaited<ReturnType<typeof plotPdf>> & { key:string; name:string };
export default function CadTool({ initialFile,onOpen }: { initialFile?: File; onOpen:(bytes:Uint8Array,name:string,signal:AbortSignal)=>Promise<void> }) {
  const [drawing,setDrawing]=useState<CadDrawing|null>(null),[options,setOptions]=useState<PlotOptions>(DEFAULT_PLOT);
  const [output,setOutput]=useState<Output|null>(null),[working,setWorking]=useState(''),[error,setError]=useState(''),[accepted,setAccepted]=useState(false);
  const [previewError,setPreviewError]=useState('');
  const input=useRef<HTMLInputElement>(null),canvas=useRef<HTMLCanvasElement>(null),operation=useRef<AbortController|null>(null);
  const busy=!!working,stale=output?.key!==JSON.stringify(options),name=drawing?.name.replace(/\.(dxf|dwg)$/i,'')+'.pdf';
  const acceptedWarnings=!drawing?.warnings.length||accepted;
  function change<K extends keyof PlotOptions>(key:K,value:PlotOptions[K]){setOptions(o=>({...o,[key]:value}));}
  async function generate(d:CadDrawing,o:PlotOptions,signal:AbortSignal){
    setWorking('Đang tạo bản in PDF…');
    const result=await plotPdf(d,o,await getFontBytes(),signal);signal.throwIfAborted();
    setOutput({...result,key:JSON.stringify(o),name:d.name.replace(/\.(dwg|dxf)$/i,'')+'.pdf'});
  }
  async function load(file:File){
    if(!isCadFile(file)){setError('Hãy chọn tệp DXF hoặc DWG.');return;}
    operation.current?.abort();const controller=new AbortController();operation.current=controller;
    setError('');setDrawing(null);setOutput(null);setAccepted(false);setWorking('Đang đọc CAD…');
    try{
      const d=await readCad(file,controller.signal,setWorking);controller.signal.throwIfAborted();
      const o={...DEFAULT_PLOT,layers:d.layers.filter(l=>l.visible).map(l=>l.name),unitMm:drawingUnitMm(d.unit)};
      setDrawing(d);setOptions(o);
      await generate(d,o,controller.signal);
    }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Không thể chuyển CAD.');}
    finally{if(operation.current===controller){setWorking('');operation.current=null;}}
  }
  async function updatePreview(){
    if(!drawing||busy)return;
    const controller=new AbortController();operation.current=controller;setError('');
    try{await generate(drawing,options,controller.signal);}catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Không thể tạo PDF.');}
    finally{if(operation.current===controller){setWorking('');operation.current=null;}}
  }
  useEffect(()=>{if(initialFile)void load(initialFile);return()=>operation.current?.abort();},[]);
  useEffect(()=>{
    if(!output||!canvas.current)return;
    let disposed=false,task:{cancel:()=>void}|undefined;
    setPreviewError('');
    const promise=openPdf(output.bytes);
    void promise.then(async pdf=>{
      try{
        if(disposed)return;
        const page=await pdf.getPage(1),base=page.getViewport({scale:1});
        if(disposed||!canvas.current)return;
        const viewport=page.getViewport({scale:Math.min(1400/base.width,1800/base.height)}),c=canvas.current;
        c.width=Math.ceil(viewport.width);c.height=Math.ceil(viewport.height);
        const render=page.render({canvas:c,viewport});task=render;await render.promise;
      }catch(e){if(!disposed)setPreviewError(e instanceof Error?e.message:'Không hiển thị được xem trước.');}
      finally{await pdf.destroy();}
    }).catch(()=>{if(!disposed)setPreviewError('Không hiển thị được xem trước. Hãy tải lại bản in.');});
    return()=>{disposed=true;task?.cancel();};
  },[output]);
  const cancel=()=>{operation.current?.abort();setWorking('');};
  async function openInEditor(){
    if(!output||stale||!acceptedWarnings||busy)return;
    const controller=new AbortController();operation.current=controller;
    setWorking('Đang mở PDF…');setError('');
    try{await onOpen(output.bytes,output.name,controller.signal);}catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Không mở được PDF.');}finally{if(operation.current===controller){setWorking('');operation.current=null;}}
  }
  return <div className="cad-tool">
    <p className="modal-description">Chuyển bản vẽ DXF / DWG 2D sang PDF vector ngay trên thiết bị. Không tải bản vẽ lên máy chủ.</p>
    <input ref={input} type="file" accept={CAD_TYPES} hidden onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void load(f);}}/>
    <div className="cad-source"><div><strong>{drawing?.name||'Chọn bản vẽ CAD'}</strong><small>{drawing?`${drawing.format} · ${drawing.version} · Model Space · ${drawing.primitives.length.toLocaleString('vi')} đối tượng`:'DXF ASCII / DWG R13–R2018 · tối đa 50 MB'}</small></div><button className="button secondary" onClick={()=>input.current?.click()} disabled={busy}><FileUp size={16}/>{drawing?'Đổi tệp':'Chọn DXF / DWG'}</button></div>
    <p className="cad-help">Chỉ xuất mặt bằng 2D trong Model Space. Không tái tạo layout/viewport, mô hình 3D, hatch, spline, ảnh/XREF ngoài và font SHX. Chữ dùng phông thay thế; kiểm tra bản in trước khi dùng.</p>
    {error&&<div className="modal-error" role="alert">{error}</div>}
    {working&&<div className="cad-status" role="status"><Loader2 size={17} className="spin"/>{working}<button onClick={cancel} className="text-button">Hủy</button></div>}
    {drawing&&<>
      <div className="cad-grid">
        <fieldset className="cad-options" disabled={busy}>
          <legend>Thiết lập bản in</legend>
          <div className="cad-fields"><label>Khổ giấy<select value={options.paper} onChange={e=>change('paper',e.target.value as PlotOptions['paper'])}>{Object.keys(PAPER_MM).map(p=><option key={p}>{p}</option>)}<option value="custom">Tùy chỉnh</option></select></label><label>Hướng giấy<select value={options.orientation} onChange={e=>change('orientation',e.target.value as PlotOptions['orientation'])}><option value="landscape">Ngang</option><option value="portrait">Dọc</option></select></label></div>
          {options.paper==='custom'&&<div className="cad-fields"><label>Rộng (mm)<input type="number" min="50" max="2000" value={options.customWidth} onChange={e=>change('customWidth',e.target.valueAsNumber)}/></label><label>Cao (mm)<input type="number" min="50" max="2000" value={options.customHeight} onChange={e=>change('customHeight',e.target.valueAsNumber)}/></label></div>}
          <div className="cad-fields"><label>Lề (mm)<input type="number" min="0" max="100" value={options.margin} onChange={e=>change('margin',e.target.valueAsNumber)}/></label><label>Đơn vị bản vẽ<select value={options.unitMm} onChange={e=>change('unitMm',Number(e.target.value))}>{UNIT_OPTIONS.map(u=><option key={u.value} value={u.value}>{u.name}</option>)}</select></label></div>
          {!UNIT_OPTIONS.some(u=>u.code===drawing.unit)&&<small className="cad-help">Tệp không khai báo đơn vị được hỗ trợ. Mặc định mm; chọn đúng đơn vị trước khi in theo tỷ lệ.</small>}
          <div className="cad-fields"><label>Tỷ lệ<select value={options.scale} onChange={e=>change('scale',e.target.value as PlotOptions['scale'])}><option value="fit">Vừa trang</option><option value="fixed">Tỷ lệ cố định</option></select></label><label>Tỷ lệ 1 :<input aria-label="Mẫu số tỷ lệ" type="number" min="0.001" max="1000000" step="any" disabled={options.scale!=='fixed'} value={options.denominator} onChange={e=>change('denominator',e.target.valueAsNumber)}/></label></div>
          <label className="cad-check"><input type="checkbox" checked={options.centered} onChange={e=>change('centered',e.target.checked)}/>Căn giữa vùng in</label>
          <label>Màu bản in<select value={options.color} onChange={e=>change('color',e.target.value as PlotOptions['color'])}><option value="mono">Đen trắng</option><option value="color">Giữ màu CAD</option><option value="gray">Thang xám</option></select></label>
          <div className="cad-fields"><label>Kiểu nét<select value={options.lineMode} onChange={e=>change('lineMode',e.target.value as PlotOptions['lineMode'])}><option value="uniform">Đồng nhất</option><option value="cad">Theo đối tượng CAD</option></select></label>{options.lineMode==='uniform'?<label>Độ dày nét (mm)<input type="number" min="0.05" max="3" step="0.05" value={options.lineWidth} onChange={e=>change('lineWidth',e.target.valueAsNumber)}/></label>:<label>Hệ số nét CAD<input type="number" min="0.1" max="10" step="0.1" value={options.lineMultiplier} onChange={e=>change('lineMultiplier',e.target.valueAsNumber)}/></label>}</div>
          <small className="cad-help">Nét CAD dùng lineweight của đối tượng, mặc định 0,25 mm khi ByLayer/ByBlock. Không dùng bảng CTB/STB.</small>
          <div className="cad-layer-heading"><strong>Layer ({options.layers.length}/{drawing.layers.length})</strong><button type="button" className="text-button" onClick={()=>change('layers',drawing.layers.map(l=>l.name))}>Chọn hết</button><button type="button" className="text-button" onClick={()=>change('layers',[])}>Bỏ hết</button></div>
          <div className="cad-layers">{drawing.layers.map(layer=><label key={layer.name} className="cad-check"><input type="checkbox" checked={options.layers.includes(layer.name)} onChange={e=>change('layers',e.target.checked?[...options.layers,layer.name]:options.layers.filter(l=>l!==layer.name))}/><i style={{background:layer.color==='#ffffff'?'#000':layer.color}}/>{layer.name}{!layer.visible&&<small>ẩn trong CAD</small>}</label>)}</div>
          <button type="button" className="text-button" onClick={()=>{setOptions({...DEFAULT_PLOT,layers:drawing.layers.filter(l=>l.visible).map(l=>l.name),unitMm:drawingUnitMm(drawing.unit)});}}><RotateCcw size={14}/>Đặt lại thiết lập</button>
        </fieldset>
        <section className="cad-preview" aria-label="Bản in xem trước"><div className="cad-preview-heading"><strong>Xem trước PDF</strong><button className="button secondary" disabled={busy||!options.layers.length} onClick={()=>void updatePreview()}><Eye size={16}/>Cập nhật xem trước</button></div>{stale&&<p role="status" className="cad-stale">Thiết lập đã đổi. Cập nhật xem trước để tạo đúng bản PDF mới.</p>}{previewError&&<p role="alert">{previewError}</p>}{output?<><div className={`cad-paper ${stale?'is-stale':''}`}><canvas ref={canvas} aria-label="Trang PDF từ bản vẽ CAD" role="img"/></div><p className="cad-help">{output.layout.width.toFixed(1)} × {output.layout.height.toFixed(1)} mm · 1 : {output.layout.denominator.toLocaleString('vi',{maximumFractionDigits:3})} · {output.layout.primitives.length.toLocaleString('vi')} đối tượng{stale?' · bản xem trước cũ':''}</p></>:<p className="cad-empty">Chọn layer và cập nhật xem trước.</p>}</section>
      </div>
      {drawing.warnings.length>0&&<div className="cad-warnings"><details open><summary>Cần kiểm tra ({drawing.warnings.length})</summary><ul>{drawing.warnings.map(w=><li key={w}>{w}</li>)}</ul></details><label className="cad-check"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)}/>Tôi đã kiểm tra bản xem trước và chấp nhận các giới hạn trên.</label></div>}
      <div className="cad-actions"><button className="button secondary" disabled={!output||stale||busy||!acceptedWarnings} onClick={()=>void openInEditor()}>Mở PDF để chỉnh sửa</button><button className="button primary" disabled={!output||stale||busy||!acceptedWarnings} onClick={()=>{if(output)saveBlob(new Blob([output.bytes.slice().buffer],{type:'application/pdf'}),name);}}><Download size={17}/>Tải PDF CAD</button></div>
      <p className="cad-help">Khi in PDF, chọn “Kích thước thực / 100%” để giữ tỷ lệ cố định.</p>
    </>}
    <p className="cad-license">Bộ đọc DWG: <a href="/cad-assets/NOTICE.txt" target="_blank" rel="noreferrer">LibreDWG / GPL-3.0 · giấy phép và mã nguồn</a>.</p>
  </div>;
}
