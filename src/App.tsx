import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpRight, Check, CheckCircle2, ChevronLeft, ChevronRight, Download, FileImage, FileText, FileType, Files, Highlighter, Home, Image, Layers, Loader2, LockKeyhole, Maximize, Menu, Minus, MousePointer2, PenLine, Plus, RotateCw, ShieldCheck, Signature, Sparkles, Trash2, Type, Undo2, Upload, X } from 'lucide-react';
import JSZip from 'jszip';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { rasterizeAnnotationImage } from './image-raster';
import { exportDocument, imagesDocument, itemsText, splitDocument, textDocx } from './pdf-engine';
import { getFontBytes, IMAGE_TYPES, isImageFile, loadSource, openPdf, prepareImage, DOC_TYPES, isTextFile, isWordFile, textFileDocument } from './pdf';
import type { PdfProxy } from './pdf';
import { PdfEncryptedMergeError, PdfPasswordCancelledError } from './pdf-password';
import { MAX_PDF_PAGES, PdfPageLimitError, pdfImportErrorMessage } from './pdf-open';
import { pageIndexForInput } from './page-navigation';
import { dimensions, overlayTransform, placeImage, referencedSourceIds, reorderPages, saveBlob, uid } from './model';
import type { Annotation, AnnotationImage, Page, Point, Source, Tool } from './model';
import { pageRangeLabel, parsePageRange } from './page-range';

const COLORS = ['#252a34', '#e44d35', '#317cff', '#21966b', '#f3bf35'];
const COLOR_NAMES = ['Đen', 'Đỏ', 'Xanh dương', 'Xanh lá', 'Vàng'];
const MAX_BYTES = 50 * 1024 * 1024;
const UPLOAD_FORMATS = 'PDF, JPG, PNG, WebP, GIF, BMP, AVIF, TXT, DOCX';
const TAP_SLOP = 8;
const interactiveControl = 'button,input,select,textarea,a[href],[contenteditable],[role="button"]';
const tools = {
  select: { name: 'Chọn chú thích', label: 'Chọn', icon: MousePointer2 },
  text: { name: 'Thêm chữ', label: 'Thêm chữ', icon: Type },
  highlight: { name: 'Tô sáng', label: 'Tô sáng', icon: Highlighter },
  draw: { name: 'Vẽ tự do', label: 'Vẽ', icon: PenLine },
  image: { name: 'Chèn ảnh', label: 'Chèn ảnh', icon: Image },
  signature: { name: 'Ký tên', label: 'Ký tên', icon: Signature },
};
type OpenTask = 'view' | 'annotate' | 'convert';
type PageSnapshot = { pages: Page[]; fileSize: number };
type PasswordPrompt = { name: string; retry: boolean; complete: (password: string | null) => void; opener: HTMLElement | null };

function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" className="icon-button" title={label} aria-label={label} {...props}>{children}</button>;
}

function Modal({ title, children, onClose, returnFocus, fallbackFocus }: { title: string; children: ReactNode; onClose: () => void; returnFocus: HTMLElement | null; fallbackFocus?: () => HTMLElement | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    const root = ref.current!;
    (root.querySelector<HTMLElement>('[data-initial-focus]') ?? root.querySelector<HTMLElement>('button, input, select'))?.focus();
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key === 'Tab') {
        const items = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]'));
        const first = items[0], last = items[items.length-1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
      requestAnimationFrame(() => {
        if (root.isConnected) return;
        if (returnFocus?.isConnected && returnFocus.checkVisibility({visibilityProperty: true})) returnFocus.focus();
        else fallbackFocus?.()?.focus();
      });
    };
  }, [returnFocus, fallbackFocus]);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className="modal" ref={ref} role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><h2>{title}</h2><IconButton label="Đóng" onClick={onClose}><X size={20}/></IconButton></div>{children}</div></div>;
}

function PasswordDialog({ prompt, onComplete }: { prompt: PasswordPrompt; onComplete: (password: string | null) => void }) {
  const close = useCallback(() => onComplete(null), [onComplete]);
  return <Modal title="Mở PDF được bảo vệ" onClose={close} returnFocus={prompt.opener}>
    <p className="modal-description">Nhập mật khẩu của <strong>{prompt.name}</strong>. Mật khẩu chỉ dùng trên thiết bị này.</p>
    {prompt.retry&&<p className="modal-error" role="alert">Mật khẩu không đúng. Vui lòng thử lại.</p>}
    <form className="password-form" onSubmit={e=>{
      e.preventDefault();
      const input = e.currentTarget.elements.namedItem('password') as HTMLInputElement;
      const password = input.value;
      input.value = '';
      onComplete(password);
    }}>
      <label className="field-label">Mật khẩu<input type="password" name="password" autoComplete="off" data-initial-focus required/></label>
      <div className="password-actions"><button className="button secondary" type="button" onClick={close}>Hủy</button><button className="button primary" type="submit">Mở PDF</button></div>
    </form>
  </Modal>;
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
  return <div ref={wrap} className="pdf-canvas" style={{ aspectRatio: `${d.width}/${d.height}` }}><canvas ref={canvas} aria-hidden={thumbnail} role={thumbnail?undefined:'img'} aria-label={thumbnail?undefined:'Bản xem trước trang PDF'}/></div>;
}

export default function App() {
  const [screen, setScreen] = useState<'home'|'editor'>('home');
  const [pages, setPages] = useState<Page[]>([]);
  const documents = useRef(new Map<string, {source: Source; pdf: PdfProxy}>());
  const [name, setName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [readOnly, setReadOnly] = useState(false);
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt|null>(null);
  const [active, setActive] = useState(0);
  const [pageJump, setPageJump] = useState<string|null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [text, setText] = useState('Ghi chú của bạn');
  const [color, setColor] = useState(COLORS[0]);
  const [highlightColor, setHighlightColor] = useState(COLORS[4]);
  const [image, setImage] = useState<AnnotationImage|null>(null);
  const [fontSize, setFontSize] = useState(18);
  const [selected, setSelected] = useState<string|null>(null);
  const [history, setHistory] = useState<PageSnapshot[]>([]);
  const [future, setFuture] = useState<PageSnapshot[]>([]);
  const [saved, setSaved] = useState<Page[]|null>(null);
  const [zoom, setZoom] = useState(100);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before'|'after' }|null>(null);
  const draggedPage = useRef<string|null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [convert, setConvert] = useState(false);
  const [convertError, setConvertError] = useState('');
  const [format, setFormat] = useState('png');
  const [scope, setScope] = useState('all');
  const [range, setRange] = useState('');
  const [separatePages, setSeparatePages] = useState(false);
  const [resolution, setResolution] = useState('2');
  const [draft, setDraft] = useState<Exclude<Annotation, { type: 'image' }>|null>(null);
  const start = useRef<Point|null>(null);
  const touchTextStart = useRef<(Point & { pointerId: number })|null>(null);
  const input = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const importMode = useRef<'replace'|'merge'>('replace');
  const openTask = useRef<OpenTask>('view');
  const convertOpener = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pageScroll = useRef<HTMLDivElement>(null);
  const thumbnailList = useRef<HTMLDivElement>(null);
  const pageJumpInput = useRef<HTMLInputElement>(null);
  const discardPageJumpOnBlur = useRef(false);
  const page = pages[active];
  const selectedAnnotation = page?.annotations.find(a=>a.id===selected);
  const dirty = !readOnly && pages.length > 0 && pages !== saved;
  const latestDirty = useRef(dirty);
  const toolColor = tool === 'highlight' ? highlightColor : color;
  const reportError = useCallback((message: string) => setError(message), []);
  const finishPassword = useCallback((password: string | null) => {
    setPasswordPrompt(null);
    passwordPrompt?.complete(password);
  }, [passwordPrompt]);
  const navigateTo = (index: number) => {
    if (start.current) return;
    setActive(Math.max(0, Math.min(pages.length - 1, index)));
    setSelected(null);
    setPageJump(null);
  };
  const commitPageJump = () => {
    if (pageJump === null) return;
    const index = pageIndexForInput(pageJump,pages.length);
    setPageJump(null);
    if (index !== null) navigateTo(index);
  };
  const closeConvert = useCallback(() => { if (!busy) { setConvert(false); setConvertError(''); } }, [busy]);
  const showConvert = () => {
    const current = document.activeElement;
    convertOpener.current = mobileNav ? menuButton.current : current instanceof HTMLElement && current !== document.body ? current : null;
    setToast(''); setConvertError(''); setConvert(true);
  };
  const convertFallbackFocus = useCallback(() => document.querySelector<HTMLButtonElement>('.document-actions .secondary'), []);
  const closeMenu = useCallback(() => {
    setMobileNav(false);
    requestAnimationFrame(() => {
      if (!document.querySelector('[aria-modal=true]')) menuButton.current?.focus();
    });
  }, []);
  useEffect(() => {
    if (!mobileNav) return;
    sidebar.current?.querySelector('button')?.focus();
    const media = matchMedia('(max-width: 1100px)');
    const resize = () => { if (!media.matches) closeMenu(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    media.addEventListener('change', resize);
    document.addEventListener('keydown', escape);
    return () => { media.removeEventListener('change', resize); document.removeEventListener('keydown', escape); };
  }, [mobileNav, closeMenu]);
  const pushPages = (next: Page[], {keepSelection = false, nextFileSize = fileSize} = {}) => { setHistory(h => [...h.slice(-29), {pages, fileSize}]); setFuture([]); setPages(next); setFileSize(nextFileSize); if (!keepSelection) setSelected(null); };
  const updatePage = (update: (p: Page) => Page, keepSelection = false) => pushPages(pages.map((p,i) => i === active ? update(p) : p), {keepSelection});
  const chooseFiles = (mode: 'replace'|'merge' = 'replace', task: OpenTask = 'view') => {
    if (busy) return;
    importMode.current = mode;
    openTask.current = task;
    input.current?.click();
  };
  const startTask = (task: OpenTask) => {
    if (!pages.length) chooseFiles('replace', task);
    else if (task === 'convert') showConvert();
    else { setScreen('editor'); setTool(task === 'annotate' ? 'text' : 'select'); }
    if (mobileNav) closeMenu();
  };
  const onFileDrop = useEffectEvent((files: File[]) => { void importFiles(files, 'replace'); });
  const canDropFiles = useEffectEvent(() => !busy && !convert);
  useEffect(() => {
    let depth = 0;
    const isFileDrag = (event: DragEvent) => event.dataTransfer?.types.includes('Files');
    const enter = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      depth++;
      setDragOver(canDropFiles());
    };
    const over = (event: DragEvent) => {
      if (!event.dataTransfer || !isFileDrag(event)) return;
      event.preventDefault();
      const allowed = canDropFiles();
      event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
      setDragOver(allowed);
    };
    const leave = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragOver(false);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer || (!isFileDrag(event) && !event.dataTransfer.files.length)) return;
      event.preventDefault();
      depth = 0;
      setDragOver(false);
      if (canDropFiles()) onFileDrop(Array.from(event.dataTransfer.files));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);
  useLayoutEffect(() => {
    latestDirty.current = dirty;
  }, [dirty]);
  useLayoutEffect(() => {
    pageScroll.current?.scrollTo(0, 0);
  }, [screen, page?.id]);
  useLayoutEffect(() => {
    const list = thumbnailList.current;
    const selected = list?.querySelector('[aria-current="page"]');
    if (!list || !selected) return;
    const bounds = list.getBoundingClientRect();
    const thumbnail = selected.getBoundingClientRect();
    if (thumbnail.top < bounds.top) list.scrollTop += thumbnail.top - bounds.top;
    else if (thumbnail.bottom > bounds.bottom) list.scrollTop += thumbnail.bottom - bounds.bottom;
  }, [screen, page?.id, active]);
  useEffect(() => {
    if (!dirty) return;
    const before = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before);
  }, [dirty]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 4500); return () => clearTimeout(id); }, [toast]);
  useEffect(() => {
    const retained = referencedSourceIds(pages, ...history.map(entry=>entry.pages), ...future.map(entry=>entry.pages));
    for (const [id, document] of documents.current) {
      if (retained.has(id)) continue;
      documents.current.delete(id);
      void document.pdf.destroy();
    }
  }, [pages, history, future]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable]')) || convert || mobileNav || passwordPrompt || busy) return;
      if (screen === 'editor' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const direction = e.key === 'ArrowRight' || e.key === 'PageDown' ? 1
          : e.key === 'ArrowLeft' || e.key === 'PageUp' ? -1 : 0;
        const destination = active + direction;
        const scroll = pageScroll.current;
        const canPan = (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && scroll &&
          scroll.contains(document.activeElement) && scroll.scrollWidth > scroll.clientWidth;
        if (direction && destination >= 0 && destination < pages.length && !canPan && !start.current) {
          e.preventDefault();
          navigateTo(destination);
        }
      }
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if ((e.ctrlKey || e.metaKey) && key === 's' && pages.length) { e.preventDefault(); void downloadPdf(); }
      if (e.key === 'Escape') { setSelected(null); setTool('select'); }
    };
    document.addEventListener('keydown',handler); return () => document.removeEventListener('keydown',handler);
  });
  function undo() { if (!history.length || busy) return; const previous = history[history.length-1]; setFuture(f => [...f,{pages, fileSize}]); restorePages(previous); setHistory(h=>h.slice(0,-1)); }
  function redo() { if (!future.length || busy) return; const next = future[future.length-1]; setHistory(h=>[...h,{pages, fileSize}]); restorePages(next); setFuture(f=>f.slice(0,-1)); }
  function restorePages(snapshot: PageSnapshot) { setPages(snapshot.pages); setFileSize(snapshot.fileSize); setActive(a=>Math.min(a,snapshot.pages.length-1)); setSelected(null); }

  async function importFiles(files: File[], mode: 'replace'|'merge', task: OpenTask = 'view') {
    if (!files.length || busy || (mode === 'merge' && readOnly)) return;
    setError('');
    const addedSize = files.reduce((sum,f)=>sum+f.size,0);
    if (addedSize + (mode === 'merge' ? fileSize : 0) > MAX_BYTES) { setError('Tổng dung lượng tối đa là 50 MB. Vui lòng chọn tệp nhỏ hơn.'); return; }
    const isImage = isImageFile, isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    if (files.some(f=>/\.doc$/i.test(f.name))) { setError('Tệp .doc (Word 97–2003) chưa hỗ trợ. Hãy lưu lại dưới dạng .docx.'); return; }
    const invalid = files.find(f=>!isImage(f) && !isPdf(f) && !isTextFile(f) && !isWordFile(f));
    if (invalid) { setError(`Không hỗ trợ tệp “${invalid.name}”. Hãy chọn một trong các định dạng: ${UPLOAD_FORMATS}.`); return; }
    const opener = mobileNav ? menuButton.current : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusy('Đang mở tài liệu…');
    const loaded: Awaited<ReturnType<typeof loadSource>>[] = [];
    try {
      for (const f of files) {
        const data = isImage(f) ? await imagesDocument([await prepareImage(f)]) : isPdf(f) ? new Uint8Array(await f.arrayBuffer()) : await textFileDocument(f);
        loaded.push(await loadSource(data, f.name, mode === 'replace'
          ? retry => new Promise(complete => setPasswordPrompt({ name: f.name, retry, complete, opener }))
          : undefined));
      }
      const nextPages = loaded.flatMap(l=>l.pages);
      const protectedDocument = loaded.some(l=>l.readOnly);
      if (nextPages.length + (mode === 'merge' ? pages.length : 0) > MAX_PDF_PAGES) throw new PdfPageLimitError();
      if (mode === 'replace') {
        if (latestDirty.current && !window.confirm('Thay tài liệu? Các thay đổi chưa tải xuống sẽ bị mất.')) {
          await Promise.all(loaded.map(({pdf}) => pdf.destroy()));
          return;
        }
        setPages(nextPages); setHistory([]); setFuture([]); setActive(0);
        setSaved(files.length > 1 || !files.every(isPdf) ? null : nextPages); setImage(null);
        setName(files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') + '.pdf' : 'Tai-lieu-da-gop.pdf');
        setFileSize(addedSize);
        setReadOnly(protectedDocument);
        setConvert(false);
      } else {
        pushPages([...pages,...nextPages], {nextFileSize:fileSize + addedSize}); setActive(pages.length);
      }
      for (const {source, pdf} of loaded) documents.current.set(source.id,{source,pdf});
      setScreen('editor'); setTool(task === 'annotate' && !protectedDocument ? 'text' : 'select'); setSelected(null); setZoom(100); setMobileNav(false);
      if (task === 'convert' && !protectedDocument) showConvert();
      if (mode === 'merge') setToast(`Đã thêm ${nextPages.length} trang vào tài liệu.`);
    } catch (e) {
      loaded.forEach(l=>void l.pdf.destroy());
      if (e instanceof PdfPasswordCancelledError) return;
      if (e instanceof PdfEncryptedMergeError) { setError(e.message); return; }
      setError(pdfImportErrorMessage(e));
    } finally { setBusy(''); }
  }

  async function loadAnnotationImage(file: File) {
    if (busy) return;
    setError('');
    if (file.size > MAX_BYTES) { setError('Ảnh tối đa 50 MB. Vui lòng chọn tệp nhỏ hơn.'); return; }
    setBusy('Đang mở ảnh…');
    try {
      const { blob, type, width, height } = await rasterizeAnnotationImage(file);
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      setImage({ data, type, width, height, name: file.name });
    } catch { setError('Không thể mở ảnh. Vui lòng chọn ảnh PNG hoặc JPG hợp lệ.'); }
    finally { setBusy(''); }
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

  async function pdfBytes(selectedPages = pages) { return exportDocument(selectedPages, [...documents.current.values()].map(document=>document.source), selectedPages.some(p=>p.annotations.some(a=>a.type==='text')) ? await getFontBytes() : undefined); }
  async function downloadPdf() {
    if (!pages.length || busy || readOnly) return;
    setBusy('Đang lưu PDF…'); setError('');
    try { const bytes = await pdfBytes(); saveBlob(new Blob([bytes as BlobPart],{type:'application/pdf'}), name.replace(/\.pdf$/i,'')+'-da-chinh-sua.pdf'); setSaved(pages); setToast('PDF đã sẵn sàng trong thư mục tải xuống.'); }
    catch (e) { setError((e as Error).message || 'Không thể lưu PDF.'); }
    finally { setBusy(''); }
  }

  async function convertFile() {
    if (busy || !pages.length || readOnly) return;
    setBusy('Đang chuyển đổi…'); setConvertError('');
    let pdf: PdfProxy|undefined;
    try {
      const selected = scope === 'current' ? [active+1] : scope === 'range' ? parsePageRange(range, pages.length) : pages.map((_,i)=>i+1);
      const bytes = await pdfBytes(selected.map(n=>pages[n-1]));
      const base = name.replace(/\.pdf$/i,'');
      if (format === 'pdf') {
        const filename = scope === 'all' && !separatePages ? `${base}-da-chuyen-doi` : `${base}-trang-${pageRangeLabel(selected)}`;
        if (separatePages && selected.length > 1) {
          const zip = new JSZip();
          let i = 0;
          for await (const part of splitDocument(bytes)) zip.file(`${base}-trang-${selected[i++]}.pdf`, part);
          saveBlob(await zip.generateAsync({type:'blob'}), `${filename}.zip`);
        } else saveBlob(new Blob([bytes as BlobPart],{type:'application/pdf'}), `${filename}.pdf`);
      } else {
        pdf = await openPdf(bytes);
        if (format === 'txt' || format === 'docx') {
          const all: string[][] = [];
          for (let i=1;i<=pdf.numPages;i++) {
            const content = await (await pdf.getPage(i)).getTextContent();
            all.push(itemsText(content.items));
          }
          if (!all.flat().join('').trim()) throw new Error('Không tìm thấy chữ có thể sao chép. Nếu đây là bản quét hoặc ảnh, hãy chọn PNG hoặc JPG thay cho TXT.');
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
    } catch (e) { setConvertError((e as Error).message || 'Chuyển đổi thất bại. Vui lòng thử lại.'); }
    finally { if (pdf) await pdf.destroy(); setBusy(''); }
  }

  function pointer(e: ReactPointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect(), d=dimensions(page);
    return {x:Math.max(0,Math.min(d.width,(e.clientX-rect.left)/rect.width*d.width)),y:Math.max(0,Math.min(d.height,(e.clientY-rect.top)/rect.height*d.height))};
  }
  function placeText(point: Point) {
    if (!text.trim()) { setError('Nhập nội dung chữ ở bảng công cụ trước.'); return; }
    const annotation: Annotation={id:uid(),type:'text',color,size:fontSize,...point,text,rotation:page.rotation};
    updatePage(p=>({...p,annotations:[...p.annotations,annotation]})); setSelected(annotation.id);
  }
  function pointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (busy) return;
    if (tool==='select') {
      const id=(e.target as SVGElement).closest('[data-annotation]')?.getAttribute('data-annotation');
      setSelected(id||null); return;
    }
    if (tool==='text') {
      if (e.pointerType==='touch') {
        touchTextStart.current = e.isPrimary ? {x:e.clientX,y:e.clientY,pointerId:e.pointerId} : null;
      } else {
        placeText(pointer(e));
      }
      return;
    }
    const point=pointer(e);
    if (tool==='image') {
      if (!image) { imageInput.current?.click(); return; }
      const annotation = placeImage(page, image, point);
      updatePage(p=>({...p,annotations:[...p.annotations,annotation]})); setSelected(annotation.id); return;
    }
    e.currentTarget.setPointerCapture(e.pointerId); start.current=point;
    setDraft({id:uid(),type:tool==='highlight'?'highlight':'draw',color:toolColor,size:fontSize,...point,width:0,height:0,points:[point],rotation:page.rotation});
  }
  function pointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    const tap = touchTextStart.current;
    if (tap?.pointerId === e.pointerId && Math.hypot(e.clientX-tap.x,e.clientY-tap.y) > TAP_SLOP) touchTextStart.current = null;
    if (!start.current || !draft) return;
    const point=pointer(e), origin=start.current;
    setDraft(d=>!d?null:d.type==='draw'?{...d,points:[...(d.points||[]),point]}:{...d,x:Math.min(origin.x,point.x),y:Math.min(origin.y,point.y),width:Math.abs(point.x-origin.x),height:Math.abs(point.y-origin.y)});
  }
  function pointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    const tap = touchTextStart.current;
    if (tap?.pointerId === e.pointerId) {
      touchTextStart.current = null;
      if (!busy && tool==='text' && Math.hypot(e.clientX-tap.x,e.clientY-tap.y) <= TAP_SLOP) placeText(pointer(e));
      return;
    }
    if (draft && (draft.type==='draw'?(draft.points?.length||0)>1:(draft.width||0)>2&&(draft.height||0)>2)) updatePage(p=>({...p,annotations:[...p.annotations,draft]}));
    setDraft(null); start.current=null;
  }
  function movePage(from: number, to: number) {
    if (busy || readOnly) return;
    const next = reorderPages(pages, from, to);
    if (next !== pages) { pushPages(next); setActive(to); }
  }
  function clearPageDrag() {
    draggedPage.current = null; setDropTarget(null);
  }
  const annotationShape = (a: Annotation) => <g key={a.id} data-annotation={a.id} transform={overlayTransform(page,a)} className={selected===a.id?'annotation-selected':''} style={{cursor:tool==='select'?'pointer':undefined}}>
    {a.type==='image'?<image href={a.image.data} x={a.x} y={a.y} width={a.width} height={a.height}/>
      :a.type==='text'?<text x={a.x} y={a.y+a.size} fill={a.color} fontSize={a.size} fontFamily="Noto Sans">{(a.text||'').split('\n').map((line,i)=><tspan key={i} x={a.x} dy={i?a.size*1.35:0}>{line}</tspan>)}</text>
      :a.type==='highlight'?<rect x={a.x} y={a.y} width={a.width} height={a.height} fill={a.color} fillOpacity=".3"/>
      :<polyline points={a.points?.map(p=>`${p.x},${p.y}`).join(' ')} fill="none" stroke={a.color} strokeWidth={a.size/7} strokeLinecap="round" strokeLinejoin="round"/>}
  </g>;

  return <div className={`app ${screen==='editor'?'is-editor':''}`} onPointerDownCapture={e=>{
    const control = e.target instanceof Element ? e.target.closest(interactiveControl) : null;
    if (pageJump !== null && control && control !== pageJumpInput.current) {
      discardPageJumpOnBlur.current = true;
      setPageJump(null);
    }
  }}>
    <input ref={input} type="file" accept={['.pdf', 'application/pdf', ...IMAGE_TYPES, ...DOC_TYPES].join(',')} multiple hidden onChange={e=>{ const files=Array.from(e.target.files||[]); e.target.value=''; void importFiles(files,importMode.current,openTask.current); }}/>
    <input ref={imageInput} type="file" accept="image/png,image/jpeg" hidden onChange={e=>{ const file=e.target.files?.[0]; e.target.value=''; if (file) void loadAnnotationImage(file); }}/>
    {mobileNav&&<div className="nav-scrim" onClick={closeMenu}/>}
    <aside ref={sidebar} id="workspace-menu" className={`sidebar ${mobileNav?'open':''}`} inert={convert||!!passwordPrompt}>
      {mobileNav&&<IconButton label="Đóng menu" className="icon-button menu-close" onClick={closeMenu}><X size={20}/></IconButton>}
      <button className="brand" onClick={()=>{setScreen('home');if(mobileNav)closeMenu();}} aria-label="Giấy PDF — Trang chủ"><span className="brand-icon"><FileText size={23}/></span><span>giấy<span className="brand-pdf">PDF</span><small>GỌN MỌI TÀI LIỆU</small></span></button>
      <button className="button primary new-file" onClick={()=>{chooseFiles();if(mobileNav)closeMenu();}} disabled={!!busy}><Plus size={18}/> Mở tài liệu mới</button>
      <p className="nav-label">KHÔNG GIAN LÀM VIỆC</p>
      <nav aria-label="Không gian làm việc">
        <button className={screen==='home'?'active':''} aria-current={screen==='home'?'page':undefined} onClick={()=>{setScreen('home');if(mobileNav)closeMenu();}}><Home size={18}/>Tổng quan</button>
        <button className={screen==='editor'?'active':''} aria-current={screen==='editor'?'page':undefined} onClick={()=>startTask(readOnly?'view':'annotate')}><PenLine size={18}/>{readOnly?'Xem PDF':'Chú thích PDF'}{pages.length>0&&<span className="nav-dot"/>}</button>
        <button disabled={readOnly} onClick={()=>startTask('view')}><Layers size={18}/>Sắp xếp trang</button>
        <button disabled={readOnly} onClick={()=>startTask('convert')}><Files size={18}/>Chuyển đổi tệp<ArrowUpRight size={14} className="nav-arrow"/></button>
      </nav>
      <div className="sidebar-bottom"><div className="private-card"><span className="privacy-symbol"><ShieldCheck size={22}/></span><strong>Tài liệu chỉ của bạn.</strong><p>Tệp được xử lý trên thiết bị,<br/>không tải lên máy chủ.</p><span className="private-tag"><span/>Riêng tư từ thiết kế</span></div><a className="feedback" href="https://app.devin.ai/sessions/7fab2748a4e9496395a92a586f7f59bb" target="_blank" rel="noreferrer">Góp ý & yêu cầu thay đổi<ArrowUpRight size={14}/></a><div className="sidebar-signature"><span>G</span><div>Không gian cá nhân<small>Miễn phí · Không cần tài khoản</small></div></div></div>
    </aside>
    <div className="main-shell" inert={convert||mobileNav||!!passwordPrompt}>
      <header className="topbar"><div className="breadcrumb"><button ref={menuButton} type="button" aria-label="Mở menu" aria-expanded={mobileNav} aria-controls="workspace-menu" className="icon-button menu-toggle" onClick={()=>setMobileNav(true)}><Menu size={20}/></button><span>Không gian làm việc</span><ChevronRight size={14}/><strong>{screen==='home'?'Tổng quan':readOnly?'Trình xem':'Trình chỉnh sửa'}</strong></div><div className="topbar-right"><span className="local-status"><span/>Xử lý trên thiết bị</span><span className="avatar" aria-hidden="true">G</span></div></header>
      {error&&!convert&&<div className="error-banner" role="alert"><span>{error}</span><IconButton label="Đóng thông báo lỗi" onClick={()=>setError('')}><X size={17}/></IconButton></div>}
      {screen==='home'?<main className="home-content">
        <div className="intro"><div><div className="eyebrow"><span/>CÔNG CỤ NHỎ, KHẢ NĂNG LỚN</div><h1>Mọi thứ với PDF.<br/><span>Nhẹ nhàng hơn.</span></h1><p>Mở, chỉnh sửa và chuyển đổi tài liệu ngay trong trình duyệt. Tệp không được gửi lên máy chủ.</p></div><div className="hero-art" aria-hidden="true"><div className="art-dot dot-one"/><div className="art-dot dot-two"/><div className="paper-back"/><div className="paper-front"><span className="paper-label">PDF</span><span className="paper-fold"/><div className="paper-line long"/><div className="paper-line"/><div className="paper-line medium"/><div className="paper-highlight"/><div className="paper-line long"/><div className="paper-line medium"/><div className="paper-signature">giấy.</div></div><div className="art-badge"><Check size={18}/>Tất cả trong một</div><div className="pen-float"><PenLine size={23}/></div></div></div>
        <section className={`upload-zone ${dragOver?'drag-over':''}`} aria-label="Vùng mở tài liệu">
          <div className="upload-icon"><Upload size={27}/><span><Plus size={11}/></span></div><h2>{dragOver?'Thả tệp để mở':'Mở tệp PDF, ảnh hoặc văn bản'}</h2><p>Chọn tệp từ thiết bị hoặc kéo thả vào đây.</p><button className="button primary upload-button" onClick={()=>chooseFiles()} disabled={!!busy}>{busy?<Loader2 className="spin" size={18}/>:<Plus size={18}/>}Chọn tệp từ thiết bị</button><div className="upload-meta">{UPLOAD_FORMATS} · Tối đa 50 MB và 200 trang</div><div className="upload-lock"><LockKeyhole size={12}/>Tệp của bạn không rời khỏi thiết bị</div>
        </section>
        {pages.length>0&&<button className="resume-document" onClick={()=>setScreen('editor')}><FileText size={22}/><span><strong>Tiếp tục với {name}</strong><small>{pages.length} trang{dirty?' · Có thay đổi chưa tải xuống':''}</small></span><ArrowRight size={20}/></button>}
        <section className="tools-section"><div className="section-heading"><div><h2>Một bộ công cụ. Mọi nhu cầu.</h2><p>Ít thao tác hơn, nhiều việc hoàn thành hơn.</p></div><span>ĐƯỢC THIẾT KẾ CHO BẠN</span></div><div className="tool-cards">
          <button className="tool-card" disabled={readOnly} onClick={()=>startTask('annotate')}><div className="tool-card-top"><span className="tool-card-icon coral"><PenLine size={23}/></span><ArrowUpRight size={18}/></div><h3>Chú thích PDF</h3><p>Thêm chữ, tô sáng hoặc vẽ lên trang. Không sửa trực tiếp chữ có sẵn.</p><span className="tool-card-link">{pages.length?'Mở công cụ chú thích':'Chọn tệp để chú thích'}<ArrowRight size={14}/></span></button>
          <button className="tool-card" disabled={readOnly} onClick={()=>startTask('view')}><div className="tool-card-top"><span className="tool-card-icon purple"><Layers size={23}/></span><ArrowUpRight size={18}/></div><h3>Sắp xếp trang</h3><p>Thêm, xoay, xóa hoặc đổi thứ tự trang PDF.</p><span className="tool-card-link">{pages.length?'Mở công cụ sắp xếp':'Chọn tệp để sắp xếp'}<ArrowRight size={14}/></span></button>
          <button className="tool-card" disabled={readOnly} onClick={()=>startTask('convert')}><div className="tool-card-top"><span className="tool-card-icon blue"><Files size={23}/></span><ArrowUpRight size={18}/></div><h3>Chuyển đổi định dạng</h3><p>Đổi PDF sang ảnh, TXT hoặc Word, hoặc gộp ảnh thành PDF.</p><span className="tool-card-link">{pages.length?'Chọn định dạng':'Chọn tệp để chuyển đổi'}<ArrowRight size={14}/></span></button>
        </div></section>
        <section className="demo-strip"><span className="demo-icon"><Sparkles size={21}/></span><div><strong>Chưa có tài liệu? Cứ thử trước nhé.</strong><p>Mở bản mẫu và khám phá không gian làm việc của bạn.</p></div><button className="button secondary" onClick={()=>void openDemo()} disabled={!!busy}>Mở tài liệu mẫu<ArrowUpRight size={16}/></button></section>
        <footer className="home-footer"><span>Được làm để công việc nhẹ hơn.</span><span><LockKeyhole size={13}/>Không tải lên · Không lưu trữ · Không giới hạn lượt dùng</span></footer>
      </main>:<main className="editor-content">
        <div className="document-header"><div className="document-info"><span className="document-icon"><FileText size={23}/></span><div><h1>{name}</h1><span>{pages.length} trang · {(fileSize/1024/1024).toFixed(2)} MB <b>·</b> {readOnly?'PDF được bảo vệ · Chỉ xem':dirty?'Có thay đổi chưa tải xuống':'Đã mở trên thiết bị'}</span></div></div><div className="document-actions"><button className="button secondary" onClick={showConvert} disabled={readOnly||!!busy}><Files size={17}/><span>Chuyển đổi</span></button><button className="button primary" onClick={()=>void downloadPdf()} disabled={readOnly||!!busy}><Download size={17}/><span>Tải PDF xuống</span></button></div></div>
        <div className="editor-toolbar">{readOnly?<span className="read-only-label"><LockKeyhole size={15}/>Chỉ xem</span>:<><div className="toolbar-tools" role="group" aria-label="Công cụ chú thích">{(Object.keys(tools) as Tool[]).map(t=>{
          const {name: label, label: shortLabel, icon: Icon}=tools[t];
          return <button key={t} className={`toolbar-tool ${tool===t?'selected':''}`} title={label} aria-label={label} aria-pressed={tool===t} onClick={()=>{setTool(t);setSelected(null);}} disabled={!!busy}><Icon size={18}/><span>{shortLabel}</span></button>;
        })}</div><div className="toolbar-history" role="group" aria-label="Lịch sử chỉnh sửa"><IconButton label="Hoàn tác (Ctrl+Z)" onClick={undo} disabled={!history.length||!!busy}><Undo2 size={18}/></IconButton><IconButton label="Làm lại (Ctrl+Shift+Z)" onClick={redo} disabled={!future.length||!!busy}><Undo2 size={18} style={{transform:'scaleX(-1)'}}/></IconButton></div></>}<div className="zoom-tools" role="group" aria-label="Thu phóng trang"><IconButton label="Thu nhỏ" onClick={()=>setZoom(z=>Math.max(50,z-25))} disabled={zoom<=50}><Minus size={16}/></IconButton><span>{zoom}%</span><IconButton label="Phóng to" onClick={()=>setZoom(z=>Math.min(200,z+25))} disabled={zoom>=200}><Plus size={16}/></IconButton><IconButton label="Vừa chiều rộng" onClick={()=>setZoom(100)}><Maximize size={17}/></IconButton></div></div>
        <div className="editor-workspace"><aside className="pages-panel"><div className="panel-heading"><strong>Trang</strong><span>{pages.length}</span></div><div className="thumbnail-list" ref={thumbnailList}>{pages.map((p,i)=><button key={p.id}
          className={`thumbnail-button ${i===active?'current':''}${dropTarget?.id===p.id?` drop-${dropTarget.side}`:''}`}
          onClick={()=>navigateTo(i)} aria-label={`Đến trang ${i+1}`} aria-current={i===active?'page':undefined}
          draggable={!readOnly&&pages.length>1&&!busy}
          onDragStart={e=>{draggedPage.current=p.id; e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', p.id);}}
          onDragOver={e=>{
            const from=pages.findIndex(page=>page.id===draggedPage.current);
            if (from<0 || from===i || busy) return;
            e.preventDefault(); e.dataTransfer.dropEffect='move';
            const side=from<i?'after':'before';
            setDropTarget(target=>target?.id===p.id&&target.side===side?target:{id:p.id,side});
          }}
          onDragLeave={e=>{
            if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDropTarget(target=>target?.id===p.id?null:target);
          }}
          onDrop={e=>{
            if (draggedPage.current===null) return;
            e.preventDefault(); movePage(pages.findIndex(page=>page.id===draggedPage.current), i); clearPageDrag();
          }}
          onDragEnd={clearPageDrag}>
          <div className="thumbnail-paper"><PdfCanvas pdf={documents.current.get(p.sourceId)?.pdf} page={p} thumbnail onError={reportError}/>{p.annotations.length>0&&<span className="thumbnail-edited"><PenLine size={11}/></span>}</div><span>{i+1}</span></button>)}</div><button className="add-pages" onClick={()=>chooseFiles('merge')} aria-label="Thêm trang từ tệp" disabled={readOnly||!!busy}><Plus size={16}/>Thêm trang</button></aside>
        <div className="page-stage"><div className="stage-label"><LockKeyhole size={12}/>{readOnly?'Xem an toàn trên thiết bị của bạn':'Chỉnh sửa an toàn trên thiết bị của bạn'}</div>{page&&<div className="page-scroll" ref={pageScroll} tabIndex={0} aria-label="Trang PDF"><div className={`page-sheet tool-${tool}`} style={{width:`${zoom}%`}}><PdfCanvas pdf={documents.current.get(page.sourceId)?.pdf} page={page} onError={reportError}/>{!readOnly&&<svg ref={svg} className="annotation-layer" viewBox={`0 0 ${dimensions(page).width} ${dimensions(page).height}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={()=>{touchTextStart.current=null;start.current=null;setDraft(null);}} aria-label="Vùng thêm chú thích PDF">{page.annotations.map(annotationShape)}{draft&&annotationShape(draft)}</svg>}</div></div>}<form className="page-pagination" onSubmit={e=>{e.preventDefault(); commitPageJump();}}><IconButton label="Trang trước" disabled={active===0} onClick={()=>navigateTo(active-1)}><ChevronLeft size={17}/></IconButton><label>Trang <input ref={pageJumpInput} aria-label="Số trang cần đến" title="Nhập số trang rồi nhấn Enter" inputMode="numeric" value={pageJump??active+1} onChange={e=>{discardPageJumpOnBlur.current=false;setPageJump(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.currentTarget.form?.requestSubmit();}}} onBlur={e=>{const discard=discardPageJumpOnBlur.current||e.relatedTarget?.closest(interactiveControl);discardPageJumpOnBlur.current=false;if(discard)setPageJump(null);else commitPageJump();}} onFocus={e=>e.target.select()} style={{width:`${String(pages.length).length+2}ch`}}/> / {pages.length}</label><IconButton label="Trang sau" disabled={active>=pages.length-1} onClick={()=>navigateTo(active+1)}><ChevronRight size={17}/></IconButton></form></div>
        <aside className="properties-panel"><div className="panel-heading"><strong>{tool==='select'?'Tài liệu':'Công cụ chú thích'}</strong><span><PenLine size={14}/></span></div><div className="property-content">{readOnly?<div className="annotation-tip" role="note"><LockKeyhole size={16}/><p>PDF được bảo vệ chỉ có thể xem. Hãy mở bản sao đã bỏ mật khẩu để chỉnh sửa, thêm trang hoặc xuất tệp.</p></div>:tool!=='select'?<>
          <h3>{tools[tool].name}</h3>
          <p className="property-help">{tool==='text'?'Nhập nội dung rồi nhấn vào vị trí trên trang.':tool==='highlight'?'Kéo trên trang để tô sáng một vùng.':tool==='image'?(image?`Ảnh đã chọn: ${image.name}. Nhấn vào trang để chèn ảnh.`:'Chọn ảnh PNG hoặc JPG, rồi nhấn vào vị trí trên trang.'):tool==='signature'?'Kéo trên trang để ký tên bằng tay. Đây không phải chữ ký số.':'Giữ và kéo trên trang để vẽ.'}</p>
          {tool==='image'?<button className="button secondary choose-annotation-image" onClick={()=>imageInput.current?.click()} disabled={!!busy}><Image size={16}/>{image?'Đổi ảnh':'Chọn ảnh'}</button>:<>
            {tool==='text'&&<label className="field-label">Nội dung<textarea value={text} onChange={e=>setText(e.target.value)} maxLength={1000} rows={4}/></label>}<div className="field-label">{tool==='highlight'?'Màu tô sáng':'Màu sắc'}<div className="color-swatches" role="group" aria-label={tool==='highlight'?'Màu tô sáng':'Màu sắc'}>{COLORS.map((c,i)=><button key={c} aria-label={COLOR_NAMES[i]} aria-pressed={toolColor===c} className={toolColor===c?'chosen':''} style={{background:c}} onClick={()=>tool==='highlight'?setHighlightColor(c):setColor(c)}>{toolColor===c&&<Check size={14} color={i===4?'#252a34':'white'}/>}</button>)}</div></div>{tool!=='highlight'&&<label className="field-label">{tool==='text'?'Cỡ chữ':'Độ dày nét'}<select value={fontSize} onChange={e=>setFontSize(Number(e.target.value))}>{[12,14,18,24,32,48].map(n=><option key={n} value={n}>{tool==='text'?`${n} pt`:`${(n/7).toFixed(1)} pt`}</option>)}</select></label>}
          </>}
          <div className="annotation-tip"><Sparkles size={16}/><p>Chú thích được giữ lại trong tệp PDF khi bạn tải xuống.</p></div>
        </>:<><h3>Từng trang, theo ý bạn</h3><p className="property-help">Chọn trang rồi dùng các nút bên dưới để sắp xếp.</p><div className="document-detail"><span>Định dạng<strong>PDF</strong></span><span>Số trang<strong>{pages.length}</strong></span><span>Trang đang chọn<strong>{active+1}</strong></span></div><div className="annotation-tip"><MousePointer2 size={16}/><p>Chọn một chú thích để sửa nội dung hoặc xóa. Nội dung gốc trong PDF không thể sửa trực tiếp.</p></div></>}
          {!readOnly&&selectedAnnotation&&<div className="selected-annotation"><h3>Chú thích đã chọn</h3>{selectedAnnotation.type==='text'&&<label className="field-label">Sửa nội dung<textarea rows={3} maxLength={1000} value={selectedAnnotation.text || ''} key={selected} onChange={e=>{const value=e.target.value; updatePage(p=>({...p,annotations:p.annotations.map(a=>a.id===selected&&a.type==='text'?{...a,text:value}:a)}),true);}}/></label>}<button className="button danger" onClick={()=>updatePage(p=>({...p,annotations:p.annotations.filter(a=>a.id!==selected)}))}><Trash2 size={15}/>Xóa chú thích</button></div>}
          {!readOnly&&<div className="page-properties"><span className="field-label">Thao tác với trang {active+1}</span><button onClick={()=>updatePage(p=>({...p,rotation:(p.rotation+90)%360}))} disabled={!!busy}><RotateCw size={16}/>Xoay phải 90°</button><button onClick={()=>movePage(active,active-1)} disabled={active===0||!!busy}><ArrowUp size={16}/>Chuyển lên trước</button><button onClick={()=>movePage(active,active+1)} disabled={active===pages.length-1||!!busy}><ArrowDown size={16}/>Chuyển ra sau</button><button className="delete-page" onClick={()=>{pushPages(pages.filter((_,i)=>i!==active));setActive(a=>Math.max(0,a-1));}} disabled={pages.length<=1||!!busy}><Trash2 size={16}/>Xóa trang</button></div>}</div><div className="properties-footer"><ShieldCheck size={16}/>Không tải lên máy chủ</div></aside></div>
        <div className="editor-status"><span><span className="status-dot"/>Mọi thao tác được xử lý trên trình duyệt</span><span>Ctrl + Z hoàn tác <b>·</b> Ctrl + S tải xuống</span></div>
      </main>}
    </div>
    {busy&&!passwordPrompt&&<div className="busy-toast" role="status"><Loader2 size={18} className="spin"/>{busy}</div>}
    {passwordPrompt&&<PasswordDialog prompt={passwordPrompt} onComplete={finishPassword}/>}
    {dragOver&&screen==='editor'&&<div className="busy-toast" role="status" style={{pointerEvents:'none'}}><Upload size={18}/>Thả tài liệu để mở</div>}
    {toast&&<div className="success-toast" role="status"><CheckCircle2 size={19}/>{toast}<IconButton label="Đóng thông báo" onClick={()=>setToast('')}><X size={15}/></IconButton></div>}
    {convert&&!readOnly&&!passwordPrompt&&<Modal title="Chuyển đổi tài liệu" onClose={closeConvert} returnFocus={convertOpener.current} fallbackFocus={convertFallbackFocus}><p className="modal-description">Chọn định dạng để tải tài liệu xuống.</p>{convertError&&<div className="modal-error" role="alert">{convertError}</div>}<div className="convert-source"><span className="tool-card-icon coral"><FileText size={23}/></span><div><strong>{name}</strong><small>{pages.length} trang · Bao gồm chú thích và thay đổi</small></div><CheckCircle2 size={19}/></div><p className="field-label">Chuyển sang</p><div className="format-options" role="group" aria-label="Định dạng tải xuống">{[{id:'png',name:'PNG',sub:'Ảnh sắc nét',icon:<Image size={22}/>},{id:'jpg',name:'JPG',sub:'Ảnh gọn nhẹ',icon:<FileImage size={22}/>},{id:'docx',name:'Word',sub:'DOCX sửa được',icon:<FileType size={22}/>},{id:'txt',name:'TXT',sub:'Văn bản thuần',icon:<FileText size={22}/>},{id:'pdf',name:'PDF',sub:'Giữ tài liệu',icon:<Files size={22}/>}].map(f=><button key={f.id} disabled={!!busy} className={format===f.id?'chosen':''} aria-pressed={format===f.id} onClick={()=>{setFormat(f.id); if (f.id!=='pdf'&&scope==='range') setScope('all'); setConvertError('');}}>{f.icon}<strong>{f.name}</strong><small>{f.sub}</small>{format===f.id&&<span className="format-check"><Check size={11}/></span>}</button>)}</div>
      <div className="convert-fields"><label className="field-label">Phạm vi<select value={scope} onChange={e=>{setScope(e.target.value); setConvertError('');}} disabled={!!busy}><option value="all">Tất cả {pages.length} trang</option><option value="current">Trang hiện tại ({active+1})</option>{format==='pdf'&&<option value="range">Khoảng trang</option>}</select></label>{['png','jpg'].includes(format)&&<label className="field-label">Chất lượng ảnh<select value={resolution} onChange={e=>setResolution(e.target.value)} disabled={!!busy}><option value="1.5">Tiêu chuẩn · 108 dpi</option><option value="2">Cao · 144 dpi</option><option value="3">Rất cao · 216 dpi</option></select></label>}</div>
      {format==='pdf'&&<>
        {scope==='range'&&<label className="field-label range-field">Khoảng trang<input type="text" value={range} onChange={e=>{setRange(e.target.value); setConvertError('');}} placeholder="1-3, 5" aria-describedby="range-help" disabled={!!busy}/><small id="range-help">Ví dụ: 1-3, 5. Số trang theo thứ tự hiện tại của tài liệu.</small></label>}
        <label className="field-label split-option"><input type="checkbox" checked={separatePages} onChange={e=>setSeparatePages(e.target.checked)} disabled={!!busy}/>Tách mỗi trang đã chọn thành một tệp PDF</label>
      </>}
      <div className="convert-note"><ShieldCheck size={17}/><p>{format==='docx'?'Lấy chữ từng dòng sang Word để chỉnh sửa. Hình ảnh và bố cục phức tạp không được giữ lại.':format==='txt'?'Chỉ lấy chữ có thể sao chép. Không nhận dạng chữ trong ảnh hoặc bản quét.':format==='pdf'?(separatePages?'Khi tách nhiều trang, các tệp PDF được gói trong một tệp ZIP.':'Xuất tài liệu với thứ tự trang và các chú thích hiện tại.'):'Mỗi trang là một ảnh. Nếu có nhiều trang, các ảnh nằm chung trong một tệp ZIP.'}</p></div><button className="button primary convert-submit" onClick={()=>void convertFile()} disabled={!!busy}>{busy?<Loader2 size={18} className="spin"/>:<Download size={18}/>}Chuyển đổi & tải xuống</button><p className="convert-footer"><LockKeyhole size={12}/>Không tệp nào được gửi lên máy chủ</p></Modal>}
  </div>;
}
