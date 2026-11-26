import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, FileCheck2, Hash, Loader2, LockKeyhole, Stamp } from 'lucide-react';
import type { DocumentToolProps } from '../types.ts';
import { DEFAULT_FORM, PLACEMENTS, TEMPLATE_PRESETS, formatPageLabel, stampedName, validateStampForm } from './options.ts';
import type { StampField, StampFont, StampForm, StampMode } from './options.ts';
import './stamps.css';

const fontCache = new Map<StampFont, Promise<Uint8Array>>();
function loadFont(key: StampFont): Promise<Uint8Array> {
  if (!fontCache.has(key)) fontCache.set(key, fetch(`${import.meta.env.BASE_URL}fonts/${key}.ttf`).then(async r => {
    if (!r.ok) throw new Error('Không tải được phông chữ tiếng Việt.');
    return new Uint8Array(await r.arrayBuffer());
  }).catch(e => { fontCache.delete(key); throw e; }));
  return fontCache.get(key)!;
}

const FONT_FAMILIES = [{ id: 'NotoSans', label: 'Không chân (Noto Sans)' }, { id: 'NotoSerif', label: 'Có chân (Noto Serif)' }] as const;
const CUSTOM = '__custom';
const DEFAULT_SIZE: Record<StampMode, string> = { watermark: '64', numbers: '11' };
const DEFAULT_FONT: Record<StampMode, StampFont> = { watermark: 'NotoSans-Bold', numbers: 'NotoSans-Regular' };
const DEFAULT_COLOR: Record<StampMode, string> = { watermark: '#e44d35', numbers: '#252a34' };
const DEFAULT_OPACITY: Record<StampMode, number> = { watermark: 25, numbers: 100 };

export default function StampsPanel({ name, pageCount, activePage, locked, getBytes, onApply, onDownload, onClose, onBusyChange }: DocumentToolProps) {
  const [form, setForm] = useState<StampForm>(DEFAULT_FORM);
  const [errors, setErrors] = useState<Partial<Record<StampField, string>>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<'' | 'apply' | 'download'>('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [customTemplate, setCustomTemplate] = useState(false);
  const mounted = useRef(true);
  const busyChange = useRef(onBusyChange);
  busyChange.current = onBusyChange;

  const busyRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (busyRef.current) busyChange.current?.(false); };
  }, []);

  const set = <K extends keyof StampForm>(key: K, value: StampForm[K]) => {
    setForm(f => ({ ...f, [key]: value }));
    setErrors(e => { const { [key as StampField]: _, pages: __, ...rest } = e; return rest; });
    setError(''); setNotice('');
  };
  const setMode = (mode: StampMode) => {
    if (mode === form.mode) return;
    setForm(f => ({ ...f, mode, size: DEFAULT_SIZE[mode], font: DEFAULT_FONT[mode], color: DEFAULT_COLOR[mode], opacity: DEFAULT_OPACITY[mode] }));
    setErrors({}); setError(''); setNotice('');
  };
  const family = form.font.split('-')[0] as 'NotoSans' | 'NotoSerif';
  const bold = form.font.endsWith('Bold');
  const setFont = (nextFamily: string, nextBold: boolean) => set('font', `${nextFamily}-${nextBold ? 'Bold' : 'Regular'}` as StampFont);

  const preview = useMemo(() => {
    if (form.mode === 'watermark') return form.watermarkText.trim() || 'BẢN NHÁP';
    const start = Number(form.start);
    const first = Number.isInteger(start) && start >= 0 ? start : 1;
    return /\{n\}/i.test(form.template) ? formatPageLabel(form.template, first, first + Math.max(pageCount, 1) - 1) : form.template;
  }, [form.mode, form.watermarkText, form.template, form.start, pageCount]);

  async function run(action: 'apply' | 'download') {
    if (busy || locked) return;
    const result = validateStampForm(form, pageCount, activePage);
    if (!result.ok) { setErrors(result.errors); setError('Hãy kiểm tra lại các ô được đánh dấu.'); return; }
    setErrors({}); setError(''); setNotice('');
    setBusy(action); busyRef.current = true; busyChange.current?.(true);
    setProgress({ done: 0, total: result.job.pages.length });
    try {
      const [{ stampPdf }, bytes, font] = await Promise.all([import('./engine.ts'), getBytes(), loadFont(result.job.font)]);
      const stamped = await stampPdf(bytes, result.job, font, (done, total) => { if (mounted.current) setProgress({ done, total }); });
      const file = stampedName(name, form.mode);
      if (action === 'apply') await onApply(stamped.bytes);
      else onDownload(stamped.bytes, file);
      if (!mounted.current) return;
      const shrunk = stamped.shrunkPages.length ? ` Chữ được thu nhỏ cho vừa ${stamped.shrunkPages.length} trang nhỏ.` : '';
      setNotice(`${action === 'apply' ? 'Đã áp dụng vào tài liệu' : `Đã tạo ${file}`} · ${result.job.pages.length} trang.${shrunk}`);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error && e.message ? e.message : 'Không thể đóng dấu tài liệu. Hãy thử lại.');
    } finally {
      busyRef.current = false; busyChange.current?.(false);
      if (mounted.current) { setBusy(''); setProgress(null); }
    }
  }

  const fieldError = (field: StampField) => errors[field] ? <small className="stamps-field-error" id={`stamps-${field}-error`}>{errors[field]}</small> : null;
  const invalid = (field: StampField) => errors[field] ? { 'aria-invalid': true, 'aria-describedby': `stamps-${field}-error` } : {};
  const disabled = !!busy || !!locked;
  const templateSelect = customTemplate || !TEMPLATE_PRESETS.includes(form.template) ? CUSTOM : form.template;
  const [vertical, horizontal] = form.placement.split('-');

  return (
    <div className="stamps-panel">
      <p className="modal-description">Thêm dấu chìm hoặc số trang tiếng Việt. Tệp được xử lý ngay trên thiết bị của bạn.</p>
      {locked && <div className="modal-error" role="alert"><LockKeyhole size={14}/> PDF đang được bảo vệ. Hãy gỡ mật khẩu trước khi đóng dấu.</div>}

      <div className="stamps-mode" role="radiogroup" aria-label="Chọn chức năng">
        {([['watermark', 'Dấu chìm', <Stamp key="i" size={18}/>], ['numbers', 'Đánh số trang', <Hash key="i" size={18}/>]] as const).map(([id, label, icon]) =>
          <button key={id} type="button" role="radio" aria-checked={form.mode === id} className={form.mode === id ? 'chosen' : ''} onClick={() => setMode(id)} disabled={disabled}>{icon}{label}</button>)}
      </div>

      <div className="stamps-layout">
        <div className="stamps-fields">
          {form.mode === 'watermark' ? <>
            <label className="field-label stamps-wide">Nội dung dấu chìm
              <textarea rows={2} value={form.watermarkText} maxLength={260} onChange={e => set('watermarkText', e.target.value)} disabled={disabled} {...invalid('watermarkText')}/>
              {fieldError('watermarkText')}
            </label>
            <label className="field-label">Góc xoay · {form.angle || 0}°
              <input type="range" min={-90} max={90} step={5} value={Number(form.angle) || 0} onChange={e => set('angle', e.target.value)} disabled={disabled} aria-label="Góc xoay"/>
              <input type="number" min={-180} max={180} value={form.angle} onChange={e => set('angle', e.target.value)} disabled={disabled} aria-label="Góc xoay (độ)" {...invalid('angle')}/>
              {fieldError('angle')}
            </label>
          </> : <>
            <label className="field-label">Mẫu số trang
              <select value={templateSelect} onChange={e => { const v = e.target.value; if (v === CUSTOM) setCustomTemplate(true); else { setCustomTemplate(false); set('template', v); } }} disabled={disabled}>
                {TEMPLATE_PRESETS.map(t => <option key={t} value={t}>{formatPageLabel(t, 1, Math.max(pageCount, 1))}</option>)}
                <option value={CUSTOM}>Tùy chỉnh…</option>
              </select>
            </label>
            {templateSelect === CUSTOM && <label className="field-label">Mẫu tùy chỉnh
              <input type="text" value={form.template} maxLength={220} onChange={e => set('template', e.target.value)} disabled={disabled} placeholder="Trang {n} / {total}" {...invalid('template')}/>
              <small className="stamps-help">{'{n}'} là số trang, {'{total}'} là số cuối cùng.</small>
              {fieldError('template')}
            </label>}
            <label className="field-label">Bắt đầu từ số
              <input type="number" inputMode="numeric" min={0} max={99999} step={1} value={form.start} onChange={e => set('start', e.target.value)} disabled={disabled} {...invalid('start')}/>
              {fieldError('start')}
            </label>
            <div className="field-label stamps-wide">Vị trí
              <div className="stamps-placement" role="radiogroup" aria-label="Vị trí số trang">
                {PLACEMENTS.map(p => <button key={p.id} type="button" role="radio" aria-checked={form.placement === p.id} className={form.placement === p.id ? 'chosen' : ''} onClick={() => set('placement', p.id)} disabled={disabled}>{form.placement === p.id && <Check size={12}/>}{p.label}</button>)}
              </div>
            </div>
            <label className="field-label">Lề (pt)
              <input type="number" min={0} max={144} value={form.margin} onChange={e => set('margin', e.target.value)} disabled={disabled} {...invalid('margin')}/>
              {fieldError('margin')}
            </label>
          </>}

          <label className="field-label">Cỡ chữ (pt)
            <input type="number" inputMode="decimal" min={form.mode === 'watermark' ? 8 : 6} max={form.mode === 'watermark' ? 300 : 72} value={form.size} onChange={e => set('size', e.target.value)} disabled={disabled} {...invalid('size')}/>
            {fieldError('size')}
          </label>
          <label className="field-label">Phông chữ
            <select value={family} onChange={e => setFont(e.target.value, bold)} disabled={disabled}>{FONT_FAMILIES.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
          </label>
          <label className="field-label stamps-check"><input type="checkbox" checked={bold} onChange={e => setFont(family, e.target.checked)} disabled={disabled}/>Chữ đậm</label>
          <label className="field-label">Màu chữ
            <input type="color" value={form.color} onChange={e => set('color', e.target.value)} disabled={disabled} {...invalid('color')}/>
            {fieldError('color')}
          </label>
          <label className="field-label">Độ đậm · {form.opacity}%
            <input type="range" min={5} max={100} step={5} value={form.opacity} onChange={e => set('opacity', Number(e.target.value))} disabled={disabled} {...invalid('opacity')}/>
            {fieldError('opacity')}
          </label>

          <label className="field-label">Áp dụng cho
            <select value={form.scope} onChange={e => set('scope', e.target.value as StampForm['scope'])} disabled={disabled} {...invalid('pages')}>
              <option value="all">Tất cả {pageCount} trang</option>
              <option value="current">Trang hiện tại ({activePage + 1})</option>
              <option value="range">Khoảng trang</option>
            </select>
            {fieldError('pages')}
          </label>
          {form.scope === 'range' && <label className="field-label">Khoảng trang
            <input type="text" inputMode="numeric" value={form.range} onChange={e => set('range', e.target.value)} placeholder="1-3, 5" disabled={disabled} {...invalid('range')}/>
            <small className="stamps-help">Ví dụ: 1-3, 5 (trong 1–{pageCount}).</small>
            {fieldError('range')}
          </label>}
        </div>

        <figure className="stamps-preview" aria-label="Xem trước minh họa">
          <div className={`stamps-sheet ${form.mode}`}>
            <span className={`stamps-preview-text ${form.mode === 'numbers' ? `v-${vertical} h-${horizontal}` : ''}`}
              style={{ color: form.color, opacity: form.opacity / 100, fontFamily: family === 'NotoSerif' ? "'Noto Serif', serif" : "'Noto Sans', sans-serif", fontWeight: bold ? 700 : 400,
                transform: form.mode === 'watermark' ? `translate(-50%,-50%) rotate(${-(Number(form.angle) || 0)}deg)` : undefined }}>
              {preview}
            </span>
          </div>
          <figcaption>Minh họa vị trí · không đúng tỉ lệ</figcaption>
        </figure>
      </div>

      {error && <div className="modal-error" role="alert">{error}</div>}
      {progress && <div className="stamps-progress" role="status"><span>Đang xử lý {progress.done}/{progress.total} trang…</span><progress max={progress.total} value={progress.done}/></div>}
      {notice && !progress && <p className="stamps-notice" role="status"><Check size={14}/>{notice}</p>}

      <div className="password-actions stamps-actions">
        <button className="button secondary" type="button" onClick={onClose} disabled={!!busy}>Đóng</button>
        <button className="button secondary" type="button" onClick={() => void run('download')} disabled={disabled}>{busy === 'download' ? <Loader2 className="spin" size={16}/> : <Download size={16}/>}Tải PDF xuống</button>
        <button className="button primary" type="button" onClick={() => void run('apply')} disabled={disabled}>{busy === 'apply' ? <Loader2 className="spin" size={16}/> : <FileCheck2 size={16}/>}Áp dụng vào tài liệu</button>
      </div>
    </div>
  );
}
