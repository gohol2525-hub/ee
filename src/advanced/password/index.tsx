import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, Eye, EyeOff, KeyRound, Loader2, LockKeyhole, ShieldCheck, Unlock } from 'lucide-react';
import type { DocumentToolProps } from '../types.ts';
import { MAX_PASSWORD_BYTES, PASSWORD_ISSUE_MESSAGES, PdfPasswordError, protectPdf, protectedFileName, unlockPdf, unlockedFileName, validateNewPassword, type PasswordStep, type QpdfRunner } from './password-engine.ts';
import { createQpdfRunner, qpdfSupported, QPDF_UNSUPPORTED_MESSAGE } from './qpdf-client.ts';
import './password.css';

const STEP_LABELS: Record<PasswordStep | 'preparing', string> = {
  preparing: 'Đang chuẩn bị tài liệu…',
  loading: 'Đang tải bộ mã hóa…',
  checking: 'Đang kiểm tra tệp…',
  encrypting: 'Đang mã hóa AES-256…',
  decrypting: 'Đang gỡ mật khẩu…',
  verifying: 'Đang kiểm tra kết quả…',
  optimizing: 'Đang tối ưu tệp…',
};

type Done = { kind: 'protected'; fileName: string } | { kind: 'unlocked'; fileName: string; downloaded: boolean };

export default function PasswordTool({ name, locked, getBytes, onApply, onDownload, onClose, onBusyChange }: DocumentToolProps) {
  const [mode] = useState<'protect' | 'unlock'>(locked ? 'unlock' : 'protect');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState(false);
  const [downloadCopy, setDownloadCopy] = useState(false);
  const [step, setStep] = useState<PasswordStep | 'preparing' | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const runner = useRef<QpdfRunner | null>(null);
  const mounted = useRef(true);
  const firstInput = useRef<HTMLInputElement>(null);
  const busyChange = useRef(onBusyChange);
  busyChange.current = onBusyChange;
  const supported = qpdfSupported();
  const busy = step !== null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      runner.current?.dispose();
      runner.current = null;
      busyChange.current?.(false);
    };
  }, []);

  const clearPasswords = () => { setPassword(''); setConfirmation(''); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!supported) { setError(QPDF_UNSUPPORTED_MESSAGE); return; }
    if (mode === 'protect') {
      const issue = validateNewPassword(password, confirmation);
      if (issue) { setError(PASSWORD_ISSUE_MESSAGES[issue]); return; }
    } else if (!password) { setError(PASSWORD_ISSUE_MESSAGES.empty); return; }
    const secret = password;
    setStep('preparing');
    busyChange.current?.(true);
    try {
      const bytes = await getBytes();
      if (!mounted.current) return;
      setStep('loading');
      runner.current = createQpdfRunner();
      const report = (next: PasswordStep) => { if (mounted.current) setStep(next); };
      if (mode === 'protect') {
        const output = await protectPdf(bytes, secret, runner.current, report);
        if (!mounted.current) return;
        const fileName = protectedFileName(name);
        await onDownload(output, fileName);
        clearPasswords();
        setDone({ kind: 'protected', fileName });
      } else {
        const output = await unlockPdf(bytes, secret, runner.current, report);
        if (!mounted.current) return;
        const fileName = unlockedFileName(name);
        await onApply(output, fileName);
        if (downloadCopy) await onDownload(output, fileName);
        clearPasswords();
        if (mounted.current) setDone({ kind: 'unlocked', fileName, downloaded: downloadCopy });
      }
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure instanceof PdfPasswordError ? failure.message : 'Không xử lý được tệp. Vui lòng thử lại.');
      if (failure instanceof PdfPasswordError && failure.kind === 'wrong-password') requestAnimationFrame(() => firstInput.current?.select());
    } finally {
      runner.current?.dispose();
      runner.current = null;
      if (mounted.current) setStep(null);
      busyChange.current?.(false);
    }
  };

  if (done) return <div className="password-tool">
    <div className="password-done" role="status"><CheckCircle2 size={22}/><div>
      <strong>{done.kind === 'protected' ? 'Đã tạo bản PDF có mật khẩu' : 'Đã gỡ mật khẩu'}</strong>
      <p>{done.kind === 'protected' ? `Tệp ${done.fileName} đang được tải xuống. Tài liệu đang mở vẫn không đổi.` : `Bạn có thể chỉnh sửa tài liệu ngay.${done.downloaded ? ` Bản không mật khẩu ${done.fileName} đang được tải xuống.` : ''}`}</p>
    </div></div>
    {done.kind === 'protected' && <p className="password-hint">Hãy ghi nhớ mật khẩu: Giấy PDF không lưu và không thể khôi phục mật khẩu.</p>}
    <button type="button" className="button primary password-submit" onClick={onClose}>Xong</button>
  </div>;

  const inputType = visible ? 'text' : 'password';
  return <form className="password-tool" onSubmit={event => void submit(event)} noValidate>
    <p className="modal-description">{mode === 'protect'
      ? 'Đặt mật khẩu mở tệp với mã hóa AES-256. Bản có mật khẩu sẽ được tải xuống; tài liệu đang mở không đổi.'
      : 'Tài liệu này có mật khẩu mở. Nhập đúng mật khẩu hiện tại để gỡ mã hóa và chỉnh sửa.'}</p>
    {!supported && <div className="modal-error" role="alert">{QPDF_UNSUPPORTED_MESSAGE}</div>}
    {error && supported && <div className="modal-error" role="alert">{error}</div>}
    <label className="field-label password-field">{mode === 'protect' ? 'Mật khẩu mới' : 'Mật khẩu hiện tại'}
      <span className="password-input">
        <input ref={firstInput} type={inputType} value={password} onChange={e => { setPassword(e.target.value); setError(''); }} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy} data-initial-focus/>
        <button type="button" className="password-reveal" onClick={() => setVisible(v => !v)} aria-label={visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} aria-pressed={visible} disabled={busy}>{visible ? <EyeOff size={18}/> : <Eye size={18}/>}</button>
      </span>
    </label>
    {mode === 'protect' && <label className="field-label password-field">Nhập lại mật khẩu
      <span className="password-input"><input type={inputType} value={confirmation} onChange={e => { setConfirmation(e.target.value); setError(''); }} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={busy}/></span>
      <small>Ít nhất 4 ký tự, tối đa {MAX_PASSWORD_BYTES} byte. Nên dùng cụm từ dài, dễ nhớ.</small>
    </label>}
    {mode === 'unlock' && <label className="field-label password-check"><input type="checkbox" checked={downloadCopy} onChange={e => setDownloadCopy(e.target.checked)} disabled={busy}/>Tải thêm bản không mật khẩu</label>}
    {busy && <p className="password-progress" role="status" aria-live="polite"><Loader2 size={16} className="spin"/>{STEP_LABELS[step]}</p>}
    <button type="submit" className="button primary password-submit" disabled={busy || !supported}>
      {busy ? <Loader2 size={18} className="spin"/> : mode === 'protect' ? <LockKeyhole size={18}/> : <Unlock size={18}/>}
      {mode === 'protect' ? 'Đặt mật khẩu & tải xuống' : 'Gỡ mật khẩu'}
    </button>
    <p className="password-footer">{mode === 'protect' ? <KeyRound size={12}/> : <ShieldCheck size={12}/>}Xử lý ngay trên thiết bị. Mật khẩu không được lưu hay gửi đi.</p>
  </form>;
}
