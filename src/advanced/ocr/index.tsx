import { useEffect, useRef, useState } from 'react';
import { Download, FileCheck2, FileText, Loader2, ScanText, Square } from 'lucide-react';
import type { DocumentToolProps } from '../types';
import { parsePageRange } from '../../page-range';
import { OCR_LANGUAGES, baseName, ocrDocumentText, ocrErrorMessage, txtBytes } from './ocr-engine';
import type { OcrLanguage, OcrPage } from './ocr-engine';
import type { OcrProgress } from './ocr-runtime';
import './ocr.css';

type Scope = 'current' | 'all' | 'range';
const LOW_CONFIDENCE = 60;

export default function OcrPanel({ name, pageCount, activePage, locked, getBytes, onApply, onDownload, onClose, onBusyChange }: DocumentToolProps) {
  const [scope, setScope] = useState<Scope>(pageCount > 1 ? 'current' : 'all');
  const [range, setRange] = useState('');
  const [language, setLanguage] = useState<OcrLanguage>('vie');
  const [skipText, setSkipText] = useState(true);
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [saving, setSaving] = useState<'' | 'download' | 'apply'>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [results, setResults] = useState<{ pages: OcrPage[]; skipped: number[] } | null>(null);
  const [text, setText] = useState('');
  const snapshot = useRef<Uint8Array | null>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = !!progress || !!saving;
  const base = baseName(name);
  const words = results?.pages.reduce((n, p) => n + p.lines.reduce((m, l) => m + l.words.length, 0), 0) ?? 0;

  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { abort.current?.abort(); onBusyChange?.(false); }, [onBusyChange]);

  const selectedPages = () => scope === 'current' ? [activePage] : scope === 'all' ? Array.from({ length: pageCount }, (_, i) => i) : parsePageRange(range, pageCount).map(n => n - 1);

  async function recognize() {
    if (busy || locked) return;
    setError(''); setNotice('');
    let pages: number[];
    try { pages = selectedPages(); } catch (e) { setError((e as Error).message); return; }
    const controller = new AbortController();
    abort.current = controller;
    setProgress({ label: 'Đang chuẩn bị tài liệu', value: 0 });
    try {
      const bytes = await getBytes();
      const { recognizePdf } = await import('./ocr-runtime');
      const run = await recognizePdf(bytes, { pages, language, skipPagesWithText: skipText, signal: controller.signal, onProgress: setProgress });
      snapshot.current = bytes;
      setResults(run);
      setText(ocrDocumentText(run.pages));
      if (!run.pages.length) setNotice('Các trang đã chọn đều có chữ chọn được nên không cần OCR. Bỏ chọn “Bỏ qua trang đã có chữ” nếu vẫn muốn nhận dạng.');
    } catch (e) {
      if (!controller.signal.aborted) setError(ocrErrorMessage(e));
      else setNotice('Đã dừng nhận dạng. Chưa có thay đổi nào được áp dụng.');
    } finally {
      if (abort.current === controller) abort.current = null;
      setProgress(null);
    }
  }

  async function searchablePdf() {
    const { addOcrTextLayer } = await import('./ocr-pdf');
    const { getFontBytes } = await import('../../pdf');
    return addOcrTextLayer(snapshot.current!, results!.pages, await getFontBytes({}));
  }

  async function savePdf(mode: 'download' | 'apply') {
    if (busy || !results || !snapshot.current) return;
    setError(''); setNotice(''); setSaving(mode);
    try {
      const bytes = await searchablePdf();
      if (mode === 'download') await onDownload(bytes, `${base}-ocr.pdf`);
      else { await onApply(bytes); setNotice('Đã thêm lớp chữ ẩn vào tài liệu. Giờ có thể tìm và chọn chữ trên các trang đã nhận dạng.'); }
    } catch (e) { setError(e instanceof Error && /[À-ỹ]/.test(e.message) ? e.message : 'Không tạo được PDF có thể tìm kiếm. Hãy thử lại.'); }
    finally { setSaving(''); }
  }

  const pct = progress ? Math.round(progress.value * 100) : 0;
  return <div className="ocr-panel">
    <p className="modal-description">Nhận dạng chữ tiếng Việt trong bản quét ngay trên thiết bị — tài liệu không được tải lên máy chủ. Lần đầu cần tải khoảng 5–8 MB dữ liệu nhận dạng.</p>
    {locked && <p className="modal-error" role="alert">PDF đang được bảo vệ. Hãy gỡ mật khẩu trước khi nhận dạng chữ.</p>}
    <div className="ocr-fields">
      <label className="field-label">Phạm vi<select value={scope} onChange={e => { setScope(e.target.value as Scope); setError(''); }} disabled={busy}>
        <option value="current">Trang hiện tại ({activePage + 1})</option>
        <option value="all">Tất cả {pageCount} trang</option>
        <option value="range">Khoảng trang</option>
      </select></label>
      <label className="field-label">Ngôn ngữ<select value={language} onChange={e => setLanguage(e.target.value as OcrLanguage)} disabled={busy}>
        {OCR_LANGUAGES.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select></label>
    </div>
    {scope === 'range' && <label className="field-label">Khoảng trang<input type="text" inputMode="numeric" value={range} onChange={e => { setRange(e.target.value); setError(''); }} placeholder="1-3, 5" disabled={busy}/></label>}
    <label className="field-label ocr-check"><input type="checkbox" checked={skipText} onChange={e => setSkipText(e.target.checked)} disabled={busy}/>Bỏ qua trang đã có chữ chọn được</label>
    {scope === 'all' && pageCount > 10 && !busy && <p className="property-help">Mỗi trang mất khoảng vài giây đến hơn chục giây tùy thiết bị.</p>}
    {error && <p className="modal-error" role="alert">{error}</p>}
    {notice && <p className="ocr-notice" role="status">{notice}</p>}
    {progress ? <div className="ocr-progress" role="status" aria-live="polite">
      <div className="ocr-progress-label"><Loader2 size={16} className="spin"/><span>{progress.label}</span><strong>{pct}%</strong></div>
      <progress max={100} value={pct} aria-label="Tiến độ nhận dạng"/>
      <button type="button" className="button secondary" onClick={() => abort.current?.abort()}><Square size={15}/>Dừng</button>
    </div> : <div className="password-actions">
      <button type="button" className="button secondary" onClick={onClose} disabled={busy}>Đóng</button>
      <button type="button" className="button primary" onClick={() => void recognize()} disabled={busy || locked}><ScanText size={17}/>{results ? 'Nhận dạng lại' : 'Nhận dạng chữ'}</button>
    </div>}
    {results && !progress && (results.pages.length > 0 || results.skipped.length > 0) && <div className="ocr-results">
      <ul className="ocr-summary">
        {results.pages.map(p => <li key={p.pageIndex} className={p.confidence < LOW_CONFIDENCE || !p.text ? 'low' : ''}>Trang {p.pageIndex + 1}: {p.text ? `độ tin cậy ${p.confidence}%${p.confidence < LOW_CONFIDENCE ? ' · nên kiểm tra kỹ' : ''}` : 'không tìm thấy chữ'}</li>)}
        {results.skipped.length > 0 && <li>Đã bỏ qua trang {results.skipped.map(i => i + 1).join(', ')} vì đã có chữ.</li>}
      </ul>
      {results.pages.length > 0 && <>
        <label className="field-label">Văn bản nhận dạng (sửa được)<textarea value={text} onChange={e => setText(e.target.value)} rows={9} spellCheck={false} lang="vi" disabled={busy}/></label>
        <p className="property-help">Hãy kiểm tra dấu, số và tên riêng. Chỉnh sửa ở đây chỉ áp dụng cho tệp TXT; lớp chữ ẩn trong PDF dùng kết quả nhận dạng gốc và không thay đổi hình ảnh bản quét.</p>
        <div className="ocr-actions">
          <button type="button" className="button secondary" onClick={() => onDownload(txtBytes(text), `${base}-ocr.txt`)} disabled={busy || !text.trim()}><FileText size={17}/>Tải TXT</button>
          <button type="button" className="button secondary" onClick={() => void savePdf('download')} disabled={busy || !words}>{saving === 'download' ? <Loader2 size={17} className="spin"/> : <Download size={17}/>}Tải PDF tìm kiếm được</button>
          <button type="button" className="button primary" onClick={() => void savePdf('apply')} disabled={busy || !words}>{saving === 'apply' ? <Loader2 size={17} className="spin"/> : <FileCheck2 size={17}/>}Áp dụng vào tài liệu</button>
        </div>
      </>}
    </div>}
  </div>;
}
