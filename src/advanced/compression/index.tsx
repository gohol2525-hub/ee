import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Download, Loader2 } from 'lucide-react';
import type { DocumentToolProps } from '../types';
import { compressedName, compressionOutcome, DEFAULT_RASTER_SETTINGS, formatBytes, QUALITY_OPTIONS, RESOLUTION_OPTIONS } from './options';
import type { CompressionOutcome } from './options';
import './compression.css';

type Mode = 'raster' | 'structure';
type Status =
  | { kind: 'idle' }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'done'; bytes: Uint8Array; outcome: CompressionOutcome }
  | { kind: 'error'; message: string };

const percent = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });

function errorMessage(error: unknown) {
  if (error instanceof Error && /encrypt|password/i.test(error.message)) return 'PDF đang được bảo vệ bằng mật khẩu. Hãy bỏ mật khẩu trước khi nén.';
  if (error instanceof Error && error.message && /[À-ỹ]/.test(error.message)) return error.message;
  return 'Không nén được tài liệu. Tệp có thể quá lớn so với bộ nhớ của thiết bị hoặc bị hỏng.';
}

export default function CompressionPanel({ name, pageCount, locked, getBytes, onApply, onDownload, onClose, onBusyChange }: DocumentToolProps) {
  const [mode, setMode] = useState<Mode>('raster');
  const [dpi, setDpi] = useState(DEFAULT_RASTER_SETTINGS.dpi);
  const [quality, setQuality] = useState(DEFAULT_RASTER_SETTINGS.quality);
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [applying, setApplying] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const busyChange = useRef(onBusyChange);
  busyChange.current = onBusyChange;

  const setBusy = (value: boolean) => {
    if (busy.current === value) return;
    busy.current = value;
    busyChange.current?.(value);
  };
  useEffect(() => () => { abort.current?.abort(); setBusy(false); }, []);

  const running = status.kind === 'running';
  const resetResult = () => { if (!running) setStatus({ kind: 'idle' }); };
  const fileName = compressedName(name);

  async function compress() {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setStatus({ kind: 'running', done: 0, total: mode === 'raster' ? pageCount : 0 });
    try {
      const original = await getBytes();
      const engine = await import('./engine');
      let bytes: Uint8Array;
      if (mode === 'structure') {
        bytes = await engine.optimizeStructure(original);
      } else {
        const { openRasterSource } = await import('./pdfjs-source');
        const source = await openRasterSource(original);
        try {
          bytes = await engine.rasterCompress(source, { dpi, quality }, progress => {
            if (!controller.signal.aborted) setStatus({ kind: 'running', ...progress });
          }, controller.signal);
        } finally {
          await source.destroy();
        }
      }
      if (controller.signal.aborted) { setStatus({ kind: 'idle' }); return; }
      setStatus({ kind: 'done', bytes, outcome: compressionOutcome(original.length, bytes.length) });
    } catch (error) {
      if (controller.signal.aborted) setStatus({ kind: 'idle' });
      else setStatus({ kind: 'error', message: errorMessage(error) });
    } finally {
      if (abort.current === controller) abort.current = null;
      setBusy(false);
    }
  }

  async function apply(bytes: Uint8Array) {
    setApplying(true);
    setBusy(true);
    try {
      await onApply(bytes, fileName);
      onClose();
    } catch (error) {
      setStatus({ kind: 'error', message: errorMessage(error) });
    } finally {
      setApplying(false);
      setBusy(false);
    }
  }

  if (locked) return <div className="compression-panel">
    <p className="modal-error" role="alert">PDF này đang được bảo vệ bằng mật khẩu nên chưa thể nén. Hãy bỏ mật khẩu trước, rồi mở lại công cụ nén.</p>
    <div className="compression-actions"><button type="button" className="button secondary" onClick={onClose}>Đóng</button></div>
  </div>;

  const canStart = !running && !applying && (mode === 'structure' || acknowledged);
  return <div className="compression-panel">
    <p className="modal-description">Nén ngay trên thiết bị, tệp không được tải lên máy chủ. Kết quả chỉ được dùng khi bạn tải xuống hoặc áp dụng.</p>
    <fieldset className="compression-modes" disabled={running || applying}>
      <legend className="field-label">Cách nén</legend>
      <label className={mode === 'raster' ? 'chosen' : ''}><input type="radio" name="compression-mode" value="raster" checked={mode === 'raster'} onChange={() => { setMode('raster'); resetResult(); }} data-initial-focus/><span><strong>Nén mạnh cho bản scan, ảnh chụp</strong><small>Chuyển mỗi trang thành ảnh JPEG. Giảm nhiều nhất với tài liệu scan.</small></span></label>
      <label className={mode === 'structure' ? 'chosen' : ''}><input type="radio" name="compression-mode" value="structure" checked={mode === 'structure'} onChange={() => { setMode('structure'); resetResult(); }}/><span><strong>Tối ưu nhẹ, giữ nguyên chữ</strong><small>Giữ chữ, liên kết và biểu mẫu của tệp gốc chưa chỉnh sửa; thường chỉ giảm ít hoặc không giảm. Nếu đã sửa hoặc sắp xếp trong trình chỉnh sửa, bản đầu vào có thể đã làm phẳng biểu mẫu — hãy điền trước.</small></span></label>
    </fieldset>
    {mode === 'raster' && <>
      <div className="compression-fields">
        <label className="field-label">Độ phân giải<select value={dpi} disabled={running || applying} onChange={e => { setDpi(Number(e.target.value)); resetResult(); }}>{RESOLUTION_OPTIONS.map(o => <option key={o.dpi} value={o.dpi}>{o.label}</option>)}</select></label>
        <label className="field-label">Chất lượng ảnh<select value={quality} disabled={running || applying} onChange={e => { setQuality(Number(e.target.value)); resetResult(); }}>{QUALITY_OPTIONS.map(o => <option key={o.quality} value={o.quality}>{o.label}</option>)}</select></label>
      </div>
      <div className="compression-warning" role="note"><AlertTriangle size={18} aria-hidden="true"/><p>Sau khi nén mạnh, mỗi trang chỉ còn là ảnh: <strong>không thể chọn, tìm hoặc sao chép chữ; liên kết và ô biểu mẫu điền được sẽ mất</strong> (nội dung đã điền vẫn hiện trên ảnh). Kích thước, chiều xoay và hình thức trang được giữ nguyên.</p></div>
      <label className="compression-ack"><input type="checkbox" checked={acknowledged} disabled={running || applying} onChange={e => setAcknowledged(e.target.checked)}/><span>Tôi hiểu bản nén sẽ mất chữ chọn được, liên kết và biểu mẫu.</span></label>
    </>}
    {status.kind === 'running' && <div className="compression-progress" role="status" aria-live="polite">
      <div className="compression-progress-label"><Loader2 className="spin" size={16} aria-hidden="true"/>{status.total ? `Đang nén trang ${Math.min(status.done + 1, status.total)}/${status.total}…` : 'Đang tối ưu tài liệu…'}</div>
      {status.total > 0 && <progress max={status.total} value={status.done}/>}
    </div>}
    {status.kind === 'error' && <p className="modal-error" role="alert">{status.message}</p>}
    {status.kind === 'done' && <Result outcome={status.outcome}/>}
    <div className="compression-actions">
      {status.kind === 'running'
        ? <button type="button" className="button secondary" onClick={() => abort.current?.abort()}>Hủy nén</button>
        : status.kind === 'done'
          ? <>
            {status.outcome.kind !== 'smaller' && <button type="button" className="button primary" onClick={onClose} disabled={applying}>Giữ bản gốc</button>}
            <button type="button" className="button secondary" onClick={() => onDownload(status.bytes, fileName)} disabled={applying}><Download size={16} aria-hidden="true"/>{status.outcome.kind === 'smaller' ? 'Tải bản nén' : 'Vẫn tải bản này'}</button>
            <button type="button" className={`button ${status.outcome.kind === 'smaller' ? 'primary' : 'secondary'}`} onClick={() => void apply(status.bytes)} disabled={applying}>{applying ? <Loader2 className="spin" size={16} aria-hidden="true"/> : <Check size={16} aria-hidden="true"/>}{status.outcome.kind === 'smaller' ? 'Dùng bản nén' : 'Vẫn dùng bản này'}</button>
          </>
          : <>
            <button type="button" className="button secondary" onClick={onClose}>Hủy</button>
            <button type="button" className="button primary" onClick={() => void compress()} disabled={!canStart}>{status.kind === 'error' ? 'Thử lại' : 'Bắt đầu nén'}</button>
          </>}
    </div>
  </div>;
}

function Result({ outcome }: { outcome: CompressionOutcome }) {
  const summary = outcome.kind === 'smaller'
    ? `Giảm ${formatBytes(outcome.savedBytes)} (${percent.format(outcome.savedPercent)}%).`
    : outcome.kind === 'larger'
      ? `Bản nén lớn hơn bản gốc ${formatBytes(-outcome.savedBytes)}. Nên giữ bản gốc, hoặc thử độ phân giải/chất lượng thấp hơn.`
      : 'Dung lượng gần như không đổi. Tài liệu này đã gọn sẵn, nên giữ bản gốc.';
  return <div className={`compression-result ${outcome.kind}`} role="status">
    <dl>
      <div><dt>Bản gốc</dt><dd>{formatBytes(outcome.originalBytes)}</dd></div>
      <div><dt>Sau khi nén</dt><dd>{formatBytes(outcome.resultBytes)}</dd></div>
    </dl>
    <p>{summary}</p>
  </div>;
}
