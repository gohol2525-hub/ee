import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Download, Loader2 } from 'lucide-react';
import type { DocumentToolProps } from '../types';
import type { FormFieldInfo, FormInfo, FormValue } from './engine';
import './forms.css';

const loadEngine = () => import('./engine');
let fontRequest: Promise<Uint8Array> | undefined;
const fontBytes = () => fontRequest ??= fetch('/fonts/NotoSans-Regular.ttf')
  .then(async r => { if (!r.ok) throw new Error('Không tải được phông chữ tiếng Việt.'); return new Uint8Array(await r.arrayBuffer()); })
  .catch(error => { fontRequest = undefined; throw error; });

const message = (error: unknown) => error instanceof Error && error.message ? error.message : 'Đã có lỗi khi xử lý biểu mẫu.';
const sameValue = (a: FormValue, b: FormValue) => Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => v === b[i]) : a === b;
const completedName = (name: string) => `${name.replace(/\.pdf$/i, '') || 'bieu-mau'}-da-dien.pdf`;

export default function FormsPanel({ name, activePage, locked, getBytes, onApply, onDownload, onClose, onBusyChange }: DocumentToolProps) {
  const [info, setInfo] = useState<FormInfo | null>(null);
  const [values, setValues] = useState<Record<string, FormValue>>({});
  const [status, setStatus] = useState('Đang đọc biểu mẫu…');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const running = useRef(0);
  const mounted = useRef(true);
  const busyChange = useRef(onBusyChange);
  busyChange.current = onBusyChange;

  const track = async <T,>(label: string, work: () => Promise<T>) => {
    running.current++;
    busyChange.current?.(true);
    setStatus(label); setError('');
    try { return await work(); }
    finally {
      running.current--;
      if (mounted.current) setStatus('');
      if (!running.current) busyChange.current?.(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    track('Đang đọc biểu mẫu…', async () => {
      const [bytes, engine] = await Promise.all([getBytes(), loadEngine()]);
      const form = await engine.readPdfForm(bytes);
      if (!mounted.current) return;
      setInfo(form);
      setValues(Object.fromEntries(form.fields.map(f => [f.name, f.value])));
    }).catch(e => { if (mounted.current) setError(message(e)); });
    return () => { mounted.current = false; if (running.current) busyChange.current?.(false); };
  }, []);

  const pages = useMemo(() => {
    const groups = new Map<number | null, FormFieldInfo[]>();
    for (const field of info?.fields ?? []) groups.set(field.page, [...groups.get(field.page) ?? [], field]);
    return [...groups];
  }, [info]);
  const editable = info?.fields.filter(f => !f.readOnly) ?? [];
  const changed = editable.filter(f => !sameValue(values[f.name], f.value)).length;
  const busy = !!status;
  const missingRequired = editable.filter(f => f.required && (Array.isArray(values[f.name]) ? !(values[f.name] as string[]).length : !values[f.name])).map(f => f.label);

  const build = async () => {
    const [bytes, engine, font] = await Promise.all([getBytes(), loadEngine(), fontBytes()]);
    const edits = Object.fromEntries(editable.map(f => [f.name, values[f.name]]));
    return engine.fillPdfForm(bytes, edits, font);
  };
  const download = () => track('Đang tạo bản đã điền…', async () => {
    onDownload(await build(), completedName(name));
    if (mounted.current) setDone(true);
  }).catch(e => { if (mounted.current) setError(message(e)); });
  const apply = () => track('Đang áp dụng vào tài liệu…', async () => {
    const bytes = await build();
    await onApply(bytes);
  }).catch(e => { if (mounted.current) setError(message(e)); });

  const set = (field: string, value: FormValue) => { setValues(v => ({ ...v, [field]: value })); setDone(false); };

  const control = (field: FormFieldInfo) => {
    const value = values[field.name];
    const disabled = field.readOnly || busy;
    const id = `pdf-form-${field.name}`;
    const title = <span className="pdf-forms-name">{field.label}{field.required && <span className="pdf-forms-tag required">Bắt buộc</span>}{field.readOnly && <span className="pdf-forms-tag">Chỉ đọc</span>}</span>;
    if (field.kind === 'checkbox') return <label className="pdf-forms-choice"><input type="checkbox" checked={value === true} disabled={disabled} onChange={e => set(field.name, e.target.checked)}/>{title}</label>;
    if (field.kind === 'radio') return <fieldset className="pdf-forms-options" disabled={disabled}>
      <legend className="field-label">{title}</legend>
      {field.options.map(option => <label key={option} className="pdf-forms-choice"><input type="radio" name={id} checked={value === option} onChange={() => set(field.name, option)}/>{option}</label>)}
      {!field.readOnly && value !== '' && <button type="button" className="button secondary pdf-forms-clear" onClick={() => set(field.name, '')}>Bỏ chọn</button>}
    </fieldset>;
    if (field.kind === 'text') {
      const text = String(value ?? '');
      const counter = field.maxLength !== undefined && <span className="pdf-forms-count">{[...text].length}/{field.maxLength}</span>;
      const limit = (next: string) => field.maxLength === undefined ? next : [...next].slice(0, field.maxLength).join('');
      return <label className="field-label">{title}
        {field.multiline
          ? <textarea rows={3} value={text} disabled={disabled} onChange={e => set(field.name, limit(e.target.value))}/>
          : <input type="text" value={text} disabled={disabled} onChange={e => set(field.name, limit(e.target.value))}/>}
        {counter}</label>;
    }
    if (field.kind === 'dropdown' && field.editable) return <label className="field-label">{title}
      <input type="text" list={`${id}-options`} value={String(value ?? '')} disabled={disabled} onChange={e => set(field.name, e.target.value)}/>
      <datalist id={`${id}-options`}>{field.options.map(o => <option key={o} value={o}/>)}</datalist></label>;
    if (field.kind === 'list' && field.multiSelect) {
      const chosen = Array.isArray(value) ? value : [];
      return <fieldset className="pdf-forms-options" disabled={disabled}>
        <legend className="field-label">{title}</legend>
        {field.options.map(option => <label key={option} className="pdf-forms-choice"><input type="checkbox" checked={chosen.includes(option)} onChange={e => set(field.name, e.target.checked ? field.options.filter(o => o === option || chosen.includes(o)) : chosen.filter(o => o !== option))}/>{option}</label>)}
      </fieldset>;
    }
    const selected = Array.isArray(value) ? value[0] ?? '' : String(value ?? '');
    return <label className="field-label">{title}
      <select value={selected} disabled={disabled} onChange={e => set(field.name, e.target.value)}>
        <option value="">— Chưa chọn —</option>
        {field.options.map(o => <option key={o} value={o}>{o}</option>)}
      </select></label>;
  };

  return <div className="pdf-forms">
    <p className="modal-description">Điền trực tiếp trên thiết bị này. Bản hoàn tất sẽ cố định các giá trị vào trang để hiển thị giống nhau khi mở lại.</p>
    {error && <div className="modal-error" role="alert">{error}</div>}
    {status && <p className="pdf-forms-status" role="status"><Loader2 size={20} className="spin"/>{status}</p>}
    {info && <>
      {info.hasXfa && <div className="pdf-forms-notice"><strong>Biểu mẫu XFA chưa được hỗ trợ</strong>Phần XFA (biểu mẫu động của Adobe) sẽ bị bỏ khi lưu; chỉ các trường AcroForm bên dưới được điền.</div>}
      {info.signatureCount > 0 && <div className="pdf-forms-notice"><strong>Có {info.signatureCount} ô chữ ký số</strong>Công cụ này không ký số. Hình chữ ký hiện có được giữ trên trang, nhưng chữ ký số sẽ không còn hiệu lực trong bản đã điền.</div>}
      {info.buttonCount > 0 && <div className="pdf-forms-notice">Có {info.buttonCount} nút bấm trong biểu mẫu; nút sẽ được giữ dạng hình và không còn bấm được.</div>}
      {!info.fields.length && <div className="pdf-forms-notice"><strong>{info.flattenedByApp ? 'Biểu mẫu đã được điền' : 'Không tìm thấy trường để điền'}</strong>{info.flattenedByApp
        ? 'Tài liệu này là bản đã hoàn tất: các giá trị đã được cố định vào trang nên không còn ô để sửa. Mở lại tệp gốc nếu cần điền lại.'
        : 'PDF này không có ô biểu mẫu tương tác (AcroForm). Bạn có thể dùng công cụ Chữ trên thanh công cụ để thêm nội dung.'}</div>}
      {info.fields.length > 0 && <>
        <div className="pdf-forms-list">
          {pages.map(([page, fields]) => <section key={page ?? 'none'} aria-label={page === null ? 'Không gắn với trang' : `Trang ${page + 1}`}>
            <h3 className="pdf-forms-page">{page === null ? 'Không gắn với trang' : `Trang ${page + 1}${page === activePage ? ' · đang xem' : ''}`}</h3>
            {fields.map(field => <div key={field.name} className={`pdf-forms-field${field.readOnly ? ' readonly' : ''}`}>{control(field)}</div>)}
          </section>)}
        </div>
        <p className="pdf-forms-hint">{info.fields.length} trường · {changed ? `${changed} trường đã thay đổi` : 'chưa thay đổi'}{missingRequired.length ? ` · còn thiếu: ${missingRequired.slice(0, 3).join(', ')}${missingRequired.length > 3 ? '…' : ''}` : ''}. Sau khi áp dụng, các ô sẽ thành nội dung cố định và không sửa lại được.</p>
        {done && <p className="pdf-forms-hint" role="status"><CheckCircle2 size={14}/>Đã tải bản đã điền.</p>}
        <div className="pdf-forms-actions">
          <button type="button" className="button secondary" disabled={busy || !editable.length} onClick={download}><Download size={16}/>Tải bản đã điền</button>
          <button type="button" className="button primary" disabled={busy || locked || !editable.length} onClick={apply}>Áp dụng vào tài liệu</button>
        </div>
      </>}
      {!info.fields.length && <div className="pdf-forms-actions"><button type="button" className="button secondary" onClick={onClose}>Đóng</button></div>}
    </>}
    {!info && error && <div className="pdf-forms-actions"><button type="button" className="button secondary" onClick={onClose}>Đóng</button></div>}
  </div>;
}
