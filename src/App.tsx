import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Download, FileImage, FileText, FileType, Files, Highlighter, Home, Image, Layers, Loader2, LockKeyhole, Maximize, Menu, Minus, MousePointer2, PenLine, Plus, RotateCw, ShieldCheck, Sparkles, Trash2, Type, Undo2, Upload, X } from 'lucide-react';
import JSZip from 'jszip';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { exportDocument, imagesDocument, textDocx } from './pdf-engine';
import { getFontBytes, loadSource, openPdf } from './pdf';
import type { PdfProxy } from './pdf';
import { dimensions, overlayTransform, saveBlob, uid } from './model';
import type { Annotation, Page, Point, Source, Tool } from './model';

const COLORS = ['#252a34', '#e44d35', '#317cff', '#21966b', '#f3bf35'];
const MAX_BYTES = 50 * 1024 * 1024;
const toolNames = { select: 'Chọn chú thích', text: 'Thêm chữ', highlight: 'Tô sáng', draw: 'Vẽ tự do' };

function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" className="icon-button" title={label} aria-label={label} {...props}>{children}</button>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const root = ref.current!;
    (root.querySelector('button, input, select') as HTMLElement)?.focus();
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const items = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]'));
        const first = items[0], last = items[items.length-1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', listener);
    return () => { document.removeEventListener('keydown', listener); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className="modal" ref={ref} role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><h2>{title}</h2><IconButton label="Đóng" onClick={onClose}><X size={20}/></IconButton></div>{children}</div></div>;
}

function PdfCanvas({ pdf, page, thumbnail = false, onError }: { pdf?: PdfProxy; page: Page; thumbnail?: boolean; onError: (message: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(!thumbnail);
  useEffect(() => {
    const element = wrap.current!;
    const ro = new ResizeObserver(entries => setWidth(entries[0].contentRect.width)); ro.observe(element);
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) setVisible(true); }, { rootMargin: '200px' });
    if (thumbnail) io.observe(element);
    return () => { ro.disconnect(); io.disconnect(); };
  }, [thumbnail]);
  useEffect(() => {
    if (!pdf || !width || !visible) return;
    let cancelled = false;
    let task: ReturnType<Awaited<ReturnType<PdfProxy['getPage']>>['render']> | undefined;
    const render = async () => {
      try {
        const p = await pdf.getPage(page.index+1);
        if (cancelled || !canvas.current) return;
        const view = p.getViewport({ scale: 1, rotation: page.rotation });
        const scale = Math.min(width/view.width * Math.min(devicePixelRatio || 1, 2), Math.sqrt(16000000/(view.width*view.height)));
        const viewport = p.getViewport({ scale, rotation: page.rotation });
        const c = canvas.current; c.width = viewport.width; c.height = viewport.height;
        task = p.render({ canvas: c, canvasContext: c.getContext('2d')!, viewport });
        await task.promise;
      } catch (e) { if (!cancelled && (e as Error).name !== 'RenderingCancelledException') onError('Không thể hiển thị trang PDF này.'); }
    };
    void render();
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, page.index, page.rotation, width, visible, onError]);
  const d = dimensions(page);
  return <div ref={wrap} className="pdf-canvas" style={{ aspectRatio: `${d.width}/${d.height}` }}><canvas ref={canvas}/></div>;
}

export default function App() {
  const [screen, setScreen] = useState<'home'|'editor'>('home');
  const [pages, setPages] = useState<Page[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const proxies = useRef(new Map<string, PdfProxy>());
  const [name, setName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [active, setActive] = useState(0);
  const [tool, setTool] = useState<Tool>('select');
  const [text, setText] = useState('Ghi chú của bạn');
  const [color, setColor] = useState(COLORS[0]);
  const [fontSize, setFontSize] = useState(18);
  const [selected, setSelected] = useState<string|null>(null);
  const [history, setHistory] = useState<Page[][]>([]);
  const [future, setFuture] = useState<Page[][]>([]);
  const [saved, setSaved] = useState('');
  const [zoom, setZoom] = useState(100);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [convert, setConvert] = useState(false);
  const [format, setFormat] = useState('png');
  const [scope, setScope] = useState('all');
  const [resolution, setResolution] = useState('2');
  const [draft, setDraft] = useState<Annotation|null>(null);
  const start = useRef<Point|null>(null);
  const input = useRef<HTMLInputElement>(null);
  const importMode = useRef<'replace'|'merge'>('replace');
  const svg = useRef<SVGSVGElement>(null);
  const page = pages[active];
  const dirty = pages.length > 0 && JSON.stringify(pages) !== saved;
  const reportError = useCallback((message: string) => setError(message), []);
  const closeConvert = useCallback(() => { if (!busy) { setConvert(false); setError(''); } }, [busy]);
  const pushPages = (next: Page[], keepSelection = false) => { setHistory(h => [...h.slice(-29), pages]); setFuture([]); setPages(next); if (!keepSelection) setSelected(null); };
  const updatePage = (update: (p: Page) => Page, keepSelection = false) => pushPages(pages.map((p,i) => i === active ? update(p) : p), keepSelection);
  const chooseFiles = (mode: 'replace'|'merge' = 'replace', images = false) => {
    if (busy) return;
    importMode.current = mode;
    if (input.current) { input.current.accept = images ? 'image/png,image/jpeg' : '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg'; input.current.click(); }
  };
  useEffect(() => {
    if (!dirty) return;
    const before = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before);
  }, [dirty]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 4500); return () => clearTimeout(id); }, [toast]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable]') || convert || busy) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if ((e.ctrlKey || e.metaKey) && key === 's' && pages.length) { e.preventDefault(); void downloadPdf(); }
      if (e.key === 'Escape') { setSelected(null); setTool('select'); }
    };
    document.addEventListener('keydown',handler); return () => document.removeEventListener('keydown',handler);
  });
  function undo() { if (!history.length || busy) return; const previous = history[history.length-1]; setFuture(f => [...f,pages]); setPages(previous); setHistory(h=>h.slice(0,-1)); setActive(a=>Math.min(a,previous.length-1)); setSelected(null); }
  function redo() { if (!future.length || busy) return; const next = future[future.length-1]; setHistory(h=>[...h,pages]); setPages(next); setFuture(f=>f.slice(0,-1)); setActive(a=>Math.min(a,next.length-1)); setSelected(null); }

  async function importFiles(files: File[], mode: 'replace'|'merge') {
    if (!files.length || busy) return;
    if (mode === 'replace' && dirty && !window.confirm('Thay tài liệu? Các thay đổi chưa tải xuống sẽ bị mất.')) return;
    setError('');
    if (files.reduce((sum,f)=>sum+f.size,0) + (mode === 'merge' ? fileSize : 0) > MAX_BYTES) { setError('Tổng dung lượng tối đa là 50 MB. Vui lòng chọn tệp nhỏ hơn.'); return; }
    const isImage = (f: File) => /\.(png|jpe?g)$/i.test(f.name) || ['image/png','image/jpeg'].includes(f.type);
    if (!files.every(f=>isImage(f) || /\.pdf$/i.test(f.name) || f.type === 'application/pdf')) { setError('Định dạng chưa hỗ trợ. Hãy chọn PDF, JPG hoặc PNG.'); return; }
    setBusy('Đang mở tài liệu…');
    const loaded: Awaited<ReturnType<typeof loadSource>>[] = [];
    try {
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const image = isImage(f);
        const data = image ? await imagesDocument([{bytes, type: /\.png$/i.test(f.name) || f.type === 'image/png' ? 'image/png' : 'image/jpeg'}]) : bytes;
        loaded.push(await loadSource(data, f.name));
      }
      const nextPages = loaded.flatMap(l=>l.pages);
      if (nextPages.length + (mode === 'merge' ? pages.length : 0) > 200) throw new Error('Tài liệu tối đa 200 trang.');
      if (mode === 'replace') {
        proxies.current.forEach(p=>void p.destroy()); proxies.current.clear();
        setSources(loaded.map(l=>l.source)); setPages(nextPages); setHistory([]); setFuture([]); setActive(0);
        const converted = files.some(isImage);
        setSaved(converted ? '' : JSON.stringify(nextPages));
        setName(files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') + '.pdf' : 'Tai-lieu-da-gop.pdf');
        setFileSize(files.reduce((s,f)=>s+f.size,0));
      } else {
        setSources(old=>[...old,...loaded.map(l=>l.source)]); pushPages([...pages,...nextPages]); setActive(pages.length);
        setFileSize(s=>s+files.reduce((sum,f)=>sum+f.size,0));
      }
      for (const l of loaded) proxies.current.set(l.source.id,l.pdf);
      setScreen('editor'); setTool('select'); setSelected(null); setZoom(100); setMobileNav(false);
      if (mode === 'merge') setToast(`Đã thêm ${nextPages.length} trang vào tài liệu.`);
    } catch (e) {
      loaded.forEach(l=>void l.pdf.destroy());
      const message = (e as Error).message || '';
      setError(/encrypt|password/i.test(message) ? 'PDF có mật khẩu chưa được hỗ trợ. Hãy mở khóa bản sao trước khi sử dụng.' : /PDF|phông|trang|tài liệu/.test(message) ? message : 'Không thể mở tệp. Tệp có thể bị hỏng hoặc sai định dạng.');
    } finally { setBusy(''); }
  }

  async function openDemo() {
    if (busy) return;
    setBusy('Đang chuẩn bị bản mẫu…'); setError('');
    try {
      const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
      const font = await doc.embedFont(await getFontBytes(), {subset:true});
      const accent = rgb(.89,.30,.21), ink = rgb(.15,.17,.2), muted = rgb(.43,.46,.5);
      for (let n=0;n<3;n++) {
        const p = doc.addPage([595.28,841.89]);
        p.drawText('GIẤY / WORKSPACE', {x:52,y:776,size:12,font,color:accent});
        p.drawText(['Ý tưởng lớn,','Từ ý tưởng','Sẵn sàng cho'][n], {x:52,y:688,size:39,font,color:ink});
        p.drawText(['bắt đầu từ đây.','đến hành động.','chương tiếp theo.'][n], {x:52,y:632,size:39,font,color:ink});
        p.drawRectangle({x:52,y:535,width:491,height:56,color:rgb(.98,.95,.91)});
        p.drawText(['Một không gian nhỏ cho những điều quan trọng.','Mỗi bước nhỏ đều tạo nên một thay đổi lớn.','Tài liệu của bạn. Theo cách của bạn.'][n], {x:68,y:557,size:13,font,color:ink});
        const lines = ['Đây là tài liệu mẫu để bạn khám phá Giấy PDF.','Thử thêm một ghi chú, tô sáng nội dung hoặc vẽ tự do.','Bạn cũng có thể xoay, sắp xếp và xóa các trang.','','Khi hoàn tất, tải xuống bản PDF đã chỉnh sửa hoặc','chuyển tài liệu thành hình ảnh và văn bản.','','Mọi thao tác được xử lý ngay trên thiết bị của bạn.','Không tài khoản. Không tải tệp lên máy chủ.'];
        lines.forEach((line,i)=>p.drawText(line,{x:52,y:483-i*26,size:14,font,color:muted}));
        p.drawLine({start:{x:52,y:88},end:{x:543,y:88},thickness:1,color:rgb(.88,.88,.87)});
        p.drawText('GỌN MỌI TÀI LIỆU', {x:52,y:59,size:9,font,color:muted});
        p.drawText(`0${n+1} / 03`, {x:499,y:59,size:9,font,color:muted});
      }
      const bytes = await doc.save();
      setBusy('');
      await importFiles([new File([bytes as BlobPart], 'Chao-ban-Giay-PDF.pdf', {type:'application/pdf'})], 'replace');
    } catch { setError('Không thể mở tài liệu mẫu. Vui lòng thử lại.'); setBusy(''); }
  }

  async function pdfBytes(selectedPages = pages) { return exportDocument(selectedPages, sources, selectedPages.some(p=>p.annotations.some(a=>a.type==='text')) ? await getFontBytes() : undefined); }
  async function downloadPdf() {
    if (!pages.length || busy) return;
    setBusy('Đang lưu PDF…'); setError('');
    try { const bytes = await pdfBytes(); saveBlob(new Blob([bytes as BlobPart],{type:'application/pdf'}), name.replace(/\.pdf$/i,'')+'-da-chinh-sua.pdf'); setSaved(JSON.stringify(pages)); setToast('PDF đã sẵn sàng trong thư mục tải xuống.'); }
    catch (e) { setError((e as Error).message || 'Không thể lưu PDF.'); }
    finally { setBusy(''); }
  }

  async function convertFile() {
    if (busy || !pages.length) return;
    setBusy('Đang chuyển đổi…'); setError('');
    let pdf: PdfProxy|undefined;
    try {
      const bytes = await pdfBytes(scope === 'current' ? [page] : pages);
      const base = name.replace(/\.pdf$/i,'');
      if (format === 'pdf') saveBlob(new Blob([bytes as BlobPart],{type:'application/pdf'}), `${base}-da-chuyen-doi.pdf`);
      else {
        pdf = await openPdf(bytes);
        if (format === 'txt' || format === 'docx') {
          const all: string[][] = [];
          for (let i=1;i<=pdf.numPages;i++) {
            const content = await (await pdf.getPage(i)).getTextContent();
            all.push(content.items.map(item=>'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('').split('\n').map(line=>line.trimEnd()));
          }
          if (!all.flat().join('').trim()) throw new Error('PDF này không có lớp văn bản. Tài liệu quét cần OCR (chưa hỗ trợ).');
          if (format === 'txt') saveBlob(new Blob(['\uFEFF'+all.map(lines=>lines.join('\n')).join('\n\n')],{type:'text/plain;charset=utf-8'}),`${base}.txt`);
          else saveBlob(new Blob([await textDocx(all) as BlobPart],{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),`${base}.docx`);
        } else {
          const zip = new JSZip();
          for (let i=1;i<=pdf.numPages;i++) {
            setBusy(`Đang chuyển trang ${i}/${pdf.numPages}…`);
            const p = await pdf.getPage(i);
            const v = p.getViewport({scale:1});
            const scale = Math.min(Number(resolution),Math.sqrt(16000000/(v.width*v.height)));
            const viewport = p.getViewport({scale});
            const c = document.createElement('canvas'); c.width = viewport.width; c.height = viewport.height;
            await p.render({canvas:c,canvasContext:c.getContext('2d')!,viewport,background:'#ffffff'}).promise;
            const blob = await new Promise<Blob>((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('Không thể tạo ảnh.')),format==='png'?'image/png':'image/jpeg',.92));
            const file = `${base}-trang-${scope==='current'?active+1:i}.${format}`;
            if (pdf.numPages === 1) saveBlob(blob,file); else zip.file(file,blob);
            c.width = 0; c.height = 0;
          }
          if (pdf.numPages>1) saveBlob(await zip.generateAsync({type:'blob'}),`${base}-${format}.zip`);
        }
      }
      setConvert(false); setToast('Chuyển đổi xong. Tệp đã được tải xuống.');
    } catch (e) { setError((e as Error).message || 'Chuyển đổi thất bại. Vui lòng thử lại.'); }
    finally { if (pdf) await pdf.destroy(); setBusy(''); }
  }

  function pointer(e: ReactPointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect(), d=dimensions(page);
    return {x:Math.max(0,Math.min(d.width,(e.clientX-rect.left)/rect.width*d.width)),y:Math.max(0,Math.min(d.height,(e.clientY-rect.top)/rect.height*d.height))};
  }
  function pointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (busy) return;
    if (tool==='select') {
      const id=(e.target as SVGElement).closest('[data-annotation]')?.getAttribute('data-annotation');
      setSelected(id||null); return;
    }
    const point=pointer(e);
    if (tool==='text') {
      if (!text.trim()) { setError('Nhập nội dung chữ ở bảng công cụ trước.'); return; }
      const annotation: Annotation={id:uid(),type:'text',color,size:fontSize,...point,text,rotation:page.rotation};
      updatePage(p=>({...p,annotations:[...p.annotations,annotation]})); setSelected(annotation.id); return;
    }
    e.currentTarget.setPointerCapture(e.pointerId); start.current=point;
    setDraft({id:uid(),type:tool,color:tool==='highlight'&&color===COLORS[0]?'#f3bf35':color,size:fontSize,...point,width:0,height:0,points:[point],rotation:page.rotation});
  }
  function pointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!start.current || !draft) return;
    const point=pointer(e), origin=start.current;
    setDraft(d=>!d?null:d.type==='draw'?{...d,points:[...(d.points||[]),point]}:{...d,x:Math.min(origin.x,point.x),y:Math.min(origin.y,point.y),width:Math.abs(point.x-origin.x),height:Math.abs(point.y-origin.y)});
  }
  function pointerUp() {
    if (draft && (draft.type==='draw'?(draft.points?.length||0)>1:(draft.width||0)>2&&(draft.height||0)>2)) updatePage(p=>({...p,annotations:[...p.annotations,draft]}));
    setDraft(null); start.current=null;
  }
  function movePage(direction: number) {
    const destination=active+direction;
    if (destination<0 || destination>=pages.length) return;
    const next=[...pages]; [next[active],next[destination]]=[next[destination],next[active]]; pushPages(next); setActive(destination);
  }
  const annotationShape = (a: Annotation) => <g key={a.id} data-annotation={a.id} transform={overlayTransform(page,a)} className={selected===a.id?'annotation-selected':''} style={{cursor:tool==='select'?'pointer':undefined}}>
    {a.type==='text'?<text x={a.x} y={a.y+a.size} fill={a.color} fontSize={a.size} fontFamily="Noto Sans">{(a.text||'').split('\n').map((line,i)=><tspan key={i} x={a.x} dy={i?a.size*1.35:0}>{line}</tspan>)}</text>:a.type==='highlight'?<rect x={a.x} y={a.y} width={a.width} height={a.height} fill={a.color} fillOpacity=".3"/>:<polyline points={a.points?.map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke={a.color} strokeWidth={a.size/7} strokeLinecap="round" strokeLinejoin="round"/>}
  </g>;

  return <div className={`app ${screen==='editor'?'is-editor':''}`}>
    <input ref={input} type="file" multiple hidden onChange={e=>{ const files=Array.from(e.target.files||[]); e.target.value=''; void importFiles(files,importMode.current); }}/>
    {mobileNav&&<div className="nav-scrim" onClick={()=>setMobileNav(false)}/>}
    <aside className={`sidebar ${mobileNav?'open':''}`}>
      <button className="brand" onClick={()=>{setScreen('home');setMobileNav(false);}} aria-label="Giấy PDF — Trang chủ"><span className="brand-icon"><FileText size={23}/></span><span>giấy<span className="brand-pdf">PDF</span><small>GỌN MỌI TÀI LIỆU</small></span></button>
      <button className="button primary new-file" onClick={()=>chooseFiles()} disabled={!!busy}><Plus size={18}/> Mở tài liệu mới</button>
      <p className="nav-label">KHÔNG GIAN LÀM VIỆC</p>
      <nav>
        <button className={screen==='home'?'active':''} onClick={()=>{setScreen('home');setMobileNav(false);}}><Home size={18}/>Tổng quan</button>
        <button className={screen==='editor'?'active':''} onClick={()=>pages.length?(setScreen('editor'),setMobileNav(false)):chooseFiles()}><PenLine size={18}/>Chỉnh sửa PDF{pages.length>0&&<span className="nav-dot"/>}</button>
        <button onClick={()=>pages.length?(setScreen('editor'),setMobileNav(false),setTool('select')):chooseFiles()}><Layers size={18}/>Sắp xếp trang</button>
        <button onClick={()=>pages.length?setConvert(true):chooseFiles()}><Files size={18}/>Chuyển đổi file<ArrowUpRight size={14} className="nav-arrow"/></button>
      </nav>
      <div className="sidebar-bottom"><div className="private-card"><span className="privacy-symbol"><ShieldCheck size={22}/></span><strong>Tài liệu chỉ của bạn.</strong><p>Tệp được xử lý trên thiết bị,<br/>không tải lên máy chủ.</p><span className="private-tag"><span/>Riêng tư từ thiết kế</span></div><a className="feedback" href="https://app.devin.ai/sessions/7fab2748a4e9496395a92a586f7f59bb" target="_blank" rel="noreferrer">Góp ý & yêu cầu thay đổi<ArrowUpRight size={14}/></a><div className="sidebar-signature"><span>G</span><div>Không gian cá nhân<small>Miễn phí · Không cần tài khoản</small></div></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><IconButton label="Mở menu" className="icon-button menu-toggle" onClick={()=>setMobileNav(!mobileNav)}><Menu size={20}/></IconButton><span>Không gian làm việc</span><ChevronRight size={14}/><strong>{screen==='home'?'Tổng quan':'Trình chỉnh sửa'}</strong></div><div className="topbar-right"><span className="local-status"><span/>Xử lý trên thiết bị</span><span className="avatar">G</span></div></header>
      {error&&!convert&&<div className="error-banner" role="alert"><span>{error}</span><IconButton label="Đóng thông báo lỗi" onClick={()=>setError('')}><X size={17}/></IconButton></div>}
      {screen==='home'?<main className="home-content">
        <div className="intro"><div><div className="eyebrow"><span/>CÔNG CỤ NHỎ, KHẢ NĂNG LỚN</div><h1>Mọi thứ với PDF.<br/><span>Nhẹ nhàng hơn.</span></h1><p>Mở, chỉnh sửa và chuyển đổi tài liệu trong một nơi.<br/>Đơn giản, riêng tư và luôn sẵn sàng cùng bạn.</p></div><div className="hero-art" aria-hidden="true"><div className="art-dot dot-one"/><div className="art-dot dot-two"/><div className="paper-back"/><div className="paper-front"><span className="paper-label">PDF</span><span className="paper-fold"/><div className="paper-line long"/><div className="paper-line"/><div className="paper-line medium"/><div className="paper-highlight"/><div className="paper-line long"/><div className="paper-line medium"/><div className="paper-signature">giấy.</div></div><div className="art-badge"><Check size={18}/>Tất cả trong một</div><div className="pen-float"><PenLine size={23}/></div></div></div>
        <section className={`upload-zone ${dragOver?'drag-over':''}`} onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={e=>{e.preventDefault();setDragOver(false);void importFiles(Array.from(e.dataTransfer.files),'replace');}} aria-label="Vùng mở tài liệu">
          <div className="upload-icon"><Upload size={27}/><span><Plus size={11}/></span></div><h2>{dragOver?'Thả tài liệu tại đây':'Thả tài liệu, bắt đầu thôi.'}</h2><p>Kéo thả PDF hoặc ảnh vào đây, mọi thứ còn lại để Giấy lo.</p><button className="button primary upload-button" onClick={()=>chooseFiles()} disabled={!!busy}>{busy?<Loader2 className="spin" size={18}/>:<Plus size={18}/>}Chọn tệp từ thiết bị<ChevronDown size={15}/></button><div className="upload-meta">PDF, JPG, PNG <span/>Tối đa 50 MB · 200 trang</div><div className="upload-lock"><LockKeyhole size={12}/>Tệp của bạn không rời khỏi thiết bị</div>
        </section>
        {pages.length>0&&<button className="resume-document" onClick={()=>setScreen('editor')}><FileText size={22}/><span><strong>Tiếp tục với {name}</strong><small>{pages.length} trang{dirty?' · Có thay đổi chưa tải xuống':''}</small></span><ArrowRight size={20}/></button>}
        <section className="tools-section"><div className="section-heading"><div><h2>Một bộ công cụ. Mọi nhu cầu.</h2><p>Ít thao tác hơn, nhiều việc hoàn thành hơn.</p></div><span>ĐƯỢC THIẾT KẾ CHO BẠN</span></div><div className="tool-cards">
          <button className="tool-card" onClick={()=>pages.length?(setScreen('editor'),setTool('text')):chooseFiles()}><div className="tool-card-top"><span className="tool-card-icon coral"><PenLine size={23}/></span><ArrowUpRight size={18}/></div><h3>Chỉnh sửa PDF</h3><p>Thêm chữ, tô sáng và ghi chú.<br/>Biến tài liệu thành của riêng bạn.</p><span className="tool-card-link">Thêm dấu ấn của bạn<ArrowRight size={14}/></span></button>
          <button className="tool-card" onClick={()=>pages.length?(setScreen('editor'),setTool('select')):chooseFiles()}><div className="tool-card-top"><span className="tool-card-icon purple"><Layers size={23}/></span><ArrowUpRight size={18}/></div><h3>Sắp xếp trang</h3><p>Gộp, xoay, xóa và đổi thứ tự trang.<br/>Mọi trang đều ở đúng vị trí.</p><span className="tool-card-link">Sắp xếp theo ý bạn<ArrowRight size={14}/></span></button>
          <button className="tool-card" onClick={()=>pages.length?setConvert(true):chooseFiles()}><div className="tool-card-top"><span className="tool-card-icon blue"><Files size={23}/></span><ArrowUpRight size={18}/></div><h3>Chuyển đổi định dạng</h3><p>PDF sang ảnh, văn bản và ảnh sang PDF.<br/>Đúng định dạng, đúng nhu cầu.</p><span className="tool-card-link">Chuyển đổi dễ dàng<ArrowRight size={14}/></span></button>
        </div></section>
        <section className="demo-strip"><span className="demo-icon"><Sparkles size={21}/></span><div><strong>Chưa có tài liệu? Cứ thử trước nhé.</strong><p>Mở bản mẫu và khám phá không gian làm việc của bạn.</p></div><button className="button secondary" onClick={()=>void openDemo()} disabled={!!busy}>Mở tài liệu mẫu<ArrowUpRight size={16}/></button></section>
        <footer className="home-footer"><span>Được làm để công việc nhẹ hơn.</span><span><LockKeyhole size={13}/>Không tải lên · Không lưu trữ · Không giới hạn lượt dùng</span></footer>
      </main>:<main className="editor-content">
        <div className="document-header"><div className="document-info"><span className="document-icon"><FileText size={23}/></span><div><h1>{name}</h1><span>{pages.length} trang · {(fileSize/1024/1024).toFixed(2)} MB <b>·</b> {dirty?'Có thay đổi chưa tải xuống':'Đã mở trên thiết bị'}</span></div></div><div className="document-actions"><button className="button secondary" onClick={()=>setConvert(true)} disabled={!!busy}><Files size={17}/><span>Chuyển đổi</span></button><button className="button primary" onClick={()=>void downloadPdf()} disabled={!!busy}><Download size={17}/><span>Tải PDF</span></button></div></div>
        <div className="editor-toolbar"><div className="toolbar-tools">{(['select','text','highlight','draw'] as Tool[]).map((t,i)=><button key={t} className={`toolbar-tool ${tool===t?'selected':''}`} title={toolNames[t]} aria-label={toolNames[t]} aria-pressed={tool===t} onClick={()=>{setTool(t);setSelected(null);}} disabled={!!busy}>{[<MousePointer2 size={18}/>,<Type size={19}/>,<Highlighter size={18}/>,<PenLine size={18}/>][i]}<span>{t==='select'?'Chọn':t==='text'?'Thêm chữ':t==='highlight'?'Tô sáng':'Vẽ'}</span></button>)}<span className="toolbar-divider"/><IconButton label="Hoàn tác (Ctrl+Z)" onClick={undo} disabled={!history.length||!!busy}><Undo2 size={18}/></IconButton><IconButton label="Làm lại (Ctrl+Shift+Z)" onClick={redo} disabled={!future.length||!!busy}><Undo2 size={18} style={{transform:'scaleX(-1)'}}/></IconButton></div><div className="zoom-tools"><IconButton label="Thu nhỏ" onClick={()=>setZoom(z=>Math.max(50,z-25))} disabled={zoom<=50}><Minus size={16}/></IconButton><span>{zoom}%</span><IconButton label="Phóng to" onClick={()=>setZoom(z=>Math.min(200,z+25))} disabled={zoom>=200}><Plus size={16}/></IconButton><IconButton label="Vừa chiều rộng" onClick={()=>setZoom(100)}><Maximize size={17}/></IconButton></div></div>
        <div className="editor-workspace"><aside className="pages-panel"><div className="panel-heading"><strong>Trang</strong><span>{pages.length}</span></div><div className="thumbnail-list">{pages.map((p,i)=><button key={p.id} className={`thumbnail-button ${i===active?'current':''}`} onClick={()=>{setActive(i);setSelected(null);}} aria-label={`Đến trang ${i+1}`} aria-current={i===active?'page':undefined}><div className="thumbnail-paper"><PdfCanvas pdf={proxies.current.get(p.sourceId)} page={p} thumbnail onError={reportError}/>{p.annotations.length>0&&<span className="thumbnail-edited"><PenLine size={11}/></span>}</div><span>{i+1}</span></button>)}</div><button className="add-pages" onClick={()=>chooseFiles('merge')} disabled={!!busy}><Plus size={16}/>Thêm trang</button></aside>
        <div className="page-stage"><div className="stage-label"><LockKeyhole size={12}/>Chỉnh sửa an toàn trên thiết bị của bạn</div>{page&&<div className="page-scroll"><div className={`page-sheet tool-${tool}`} style={{width:`${zoom}%`,maxWidth:`${750*zoom/100}px`}}><PdfCanvas pdf={proxies.current.get(page.sourceId)} page={page} onError={reportError}/><svg ref={svg} className="annotation-layer" viewBox={`0 0 ${dimensions(page).width} ${dimensions(page).height}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={()=>{start.current=null;setDraft(null);}} aria-label="Vùng thêm chú thích PDF">{page.annotations.map(annotationShape)}{draft&&annotationShape(draft)}</svg></div></div>}<div className="page-pagination"><IconButton label="Trang trước" disabled={active===0} onClick={()=>{setActive(i=>i-1);setSelected(null);}}><ChevronLeft size={17}/></IconButton><span>Trang <strong>{active+1}</strong> / {pages.length}</span><IconButton label="Trang sau" disabled={active>=pages.length-1} onClick={()=>{setActive(i=>i+1);setSelected(null);}}><ChevronRight size={17}/></IconButton></div></div>
        <aside className="properties-panel"><div className="panel-heading"><strong>{tool==='select'?'Tài liệu':'Công cụ chú thích'}</strong><span><PenLine size={14}/></span></div><div className="property-content">{tool!=='select'?<><h3>{toolNames[tool]}</h3><p className="property-help">{tool==='text'?'Nhập nội dung rồi nhấn vào vị trí trên trang.':tool==='highlight'?'Kéo trên trang để tô sáng một vùng.':'Giữ và kéo trên trang để vẽ hoặc ký tên.'}</p>{tool==='text'&&<label className="field-label">Nội dung<textarea value={text} onChange={e=>setText(e.target.value)} maxLength={1000} rows={4}/></label>}<label className="field-label">{tool==='highlight'?'Màu tô sáng':'Màu sắc'}<div className="color-swatches">{COLORS.map(c=><button key={c} aria-label={`Màu ${c}`} aria-pressed={color===c} className={color===c?'chosen':''} style={{background:c}} onClick={()=>setColor(c)}>{color===c&&<Check size={14} color="white"/>}</button>)}</div></label>{tool!=='highlight'&&<label className="field-label">{tool==='text'?'Cỡ chữ':'Độ dày nét'}<select value={fontSize} onChange={e=>setFontSize(Number(e.target.value))}>{[12,14,18,24,32,48].map(n=><option key={n} value={n}>{tool==='text'?`${n} pt`:`${(n/7).toFixed(1)} pt`}</option>)}</select></label>}<div className="annotation-tip"><Sparkles size={16}/><p>Chú thích được giữ lại trong tệp PDF khi bạn tải xuống.</p></div></>:<><h3>Từng trang, theo ý bạn</h3><p className="property-help">Chọn trang bên trái để sắp xếp hoặc chỉnh sửa.</p><div className="document-detail"><span>Định dạng<strong>PDF</strong></span><span>Số trang<strong>{pages.length}</strong></span><span>Trang đang chọn<strong>{active+1}</strong></span></div><div className="annotation-tip"><MousePointer2 size={16}/><p>Chọn một chú thích để sửa nội dung hoặc xóa. Nội dung gốc trong PDF không thể sửa trực tiếp.</p></div></>}
          {selected&&<div className="selected-annotation"><h3>Chú thích đã chọn</h3>{page?.annotations.find(a=>a.id===selected)?.type==='text'&&<label className="field-label">Sửa nội dung<textarea rows={3} maxLength={1000} value={page.annotations.find(a=>a.id===selected)?.text || ''} key={selected} onChange={e=>{const value=e.target.value;updatePage(p=>({...p,annotations:p.annotations.map(a=>a.id===selected?{...a,text:value}:a)}),true);}}/></label>}<button className="button danger" onClick={()=>updatePage(p=>({...p,annotations:p.annotations.filter(a=>a.id!==selected)}))}><Trash2 size={15}/>Xóa chú thích</button></div>}
          <div className="page-properties"><span className="field-label">THAO TÁC VỚI TRANG {active+1}</span><button onClick={()=>updatePage(p=>({...p,rotation:(p.rotation+90)%360}))} disabled={!!busy}><RotateCw size={16}/>Xoay phải 90°</button><button onClick={()=>movePage(-1)} disabled={active===0||!!busy}><ArrowUp size={16}/>Chuyển lên trước</button><button onClick={()=>movePage(1)} disabled={active===pages.length-1||!!busy}><ArrowDown size={16}/>Chuyển ra sau</button><button className="delete-page" onClick={()=>{pushPages(pages.filter((_,i)=>i!==active));setActive(a=>Math.max(0,a-1));}} disabled={pages.length<=1||!!busy}><Trash2 size={16}/>Xóa trang</button></div></div><div className="properties-footer"><ShieldCheck size={16}/>Không tải lên máy chủ</div></aside></div>
        <div className="editor-status"><span><span className="status-dot"/>Mọi thao tác được xử lý trên trình duyệt</span><span>Ctrl + Z hoàn tác <b>·</b> Ctrl + S tải xuống</span></div>
      </main>}
    </div>
    {busy&&<div className="busy-toast" role="status"><Loader2 size={18} className="spin"/>{busy}</div>}
    {toast&&<div className="success-toast" role="status"><CheckCircle2 size={19}/>{toast}<IconButton label="Đóng thông báo" onClick={()=>setToast('')}><X size={15}/></IconButton></div>}
    {convert&&<Modal title="Chuyển đổi tài liệu" onClose={closeConvert}><p className="modal-description">Đúng định dạng bạn cần. Vẫn riêng tư như cũ.</p>{error&&<div className="modal-error" role="alert">{error}</div>}<div className="convert-source"><span className="tool-card-icon coral"><FileText size={23}/></span><div><strong>{name}</strong><small>{pages.length} trang · Bao gồm chú thích và thay đổi</small></div><CheckCircle2 size={19}/></div><label className="field-label">Chuyển sang</label><div className="format-options">{[{id:'png',name:'PNG',sub:'Ảnh sắc nét',icon:<Image size={22}/>},{id:'jpg',name:'JPG',sub:'Ảnh gọn nhẹ',icon:<FileImage size={22}/>},{id:'docx',name:'Word',sub:'DOCX sửa được',icon:<FileType size={22}/>},{id:'txt',name:'TXT',sub:'Văn bản thuần',icon:<FileText size={22}/>},{id:'pdf',name:'PDF',sub:'Giữ tài liệu',icon:<Files size={22}/>}].map(f=><button key={f.id} disabled={!!busy} className={format===f.id?'chosen':''} onClick={()=>setFormat(f.id)}>{f.icon}<strong>{f.name}</strong><small>{f.sub}</small>{format===f.id&&<span className="format-check"><Check size={11}/></span>}</button>)}</div><div className="convert-fields"><label className="field-label">Phạm vi<select value={scope} onChange={e=>setScope(e.target.value)} disabled={!!busy}><option value="all">Tất cả {pages.length} trang</option><option value="current">Trang hiện tại ({active+1})</option></select></label>{['png','jpg'].includes(format)&&<label className="field-label">Chất lượng ảnh<select value={resolution} onChange={e=>setResolution(e.target.value)} disabled={!!busy}><option value="1.5">Tiêu chuẩn · 108 dpi</option><option value="2">Cao · 144 dpi</option><option value="3">Rất cao · 216 dpi</option></select></label>}</div><div className="convert-note"><ShieldCheck size={17}/><p>{format==='docx'?'Lấy chữ từng dòng sang Word để chỉnh sửa. Hình ảnh và bố cục phức tạp không được giữ lại.':format==='txt'?'Chỉ trích xuất lớp văn bản có sẵn, không OCR tài liệu quét.':format==='pdf'?'Xuất tài liệu với thứ tự trang và các chú thích hiện tại.':'Mỗi trang là một ảnh. Nhiều ảnh được gói trong tệp ZIP.'}</p></div><button className="button primary convert-submit" onClick={()=>void convertFile()} disabled={!!busy}>{busy?<Loader2 size={18} className="spin"/>:<Download size={18}/>}Chuyển đổi & tải xuống</button><p className="convert-footer"><LockKeyhole size={12}/>Không tệp nào được gửi lên máy chủ</p></Modal>}
  </div>;
}
