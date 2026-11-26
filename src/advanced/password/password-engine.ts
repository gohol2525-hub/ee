import type { QpdfResult } from './qpdf-core.ts';

export interface QpdfRunner {
  run(args: string[], inputs: Record<string, Uint8Array>, outputs: string[]): Promise<QpdfResult>;
  dispose(): void;
}

/** PDF 2.0 (AES-256, R6) truncates passwords to 127 UTF-8 bytes; reject instead of truncating silently. */
export const MAX_PASSWORD_BYTES = 127;
export const MIN_PASSWORD_LENGTH = 4;

export type PasswordIssue = 'empty' | 'too-short' | 'too-long' | 'control' | 'mismatch';

export const PASSWORD_ISSUE_MESSAGES: Record<PasswordIssue, string> = {
  empty: 'Vui lòng nhập mật khẩu.',
  'too-short': `Mật khẩu cần ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`,
  'too-long': `Mật khẩu quá dài: tối đa ${MAX_PASSWORD_BYTES} byte. Chữ có dấu chiếm 2–3 byte mỗi ký tự.`,
  control: 'Mật khẩu không được chứa ký tự xuống dòng hoặc ký tự điều khiển.',
  mismatch: 'Hai mật khẩu chưa khớp nhau.',
};

export type PdfPasswordErrorKind = 'wrong-password' | 'not-encrypted' | 'already-encrypted' | 'invalid-pdf' | 'invalid-password' | 'failed';

const ERROR_MESSAGES: Record<PdfPasswordErrorKind, string> = {
  'wrong-password': 'Mật khẩu không đúng. Hãy kiểm tra chữ hoa/thường và dấu tiếng Việt rồi thử lại.',
  'not-encrypted': 'Tệp này không có mật khẩu mở nên không cần gỡ.',
  'already-encrypted': 'Tệp này đang có mật khẩu. Hãy gỡ mật khẩu cũ trước khi đặt mật khẩu mới.',
  'invalid-pdf': 'Không đọc được tệp PDF này. Tệp có thể bị hỏng.',
  'invalid-password': 'Mật khẩu không hợp lệ.',
  failed: 'Không xử lý được tệp. Vui lòng thử lại.',
};

export class PdfPasswordError extends Error {
  readonly kind: PdfPasswordErrorKind;
  constructor(kind: PdfPasswordErrorKind, message = ERROR_MESSAGES[kind]) {
    super(message);
    this.kind = kind;
    this.name = 'PdfPasswordError';
  }
}

export const normalizePassword = (password: string) => password.normalize('NFKC');

const utf8Length = (value: string) => new TextEncoder().encode(value).length;

export function passwordIssue(password: string): Exclude<PasswordIssue, 'mismatch'> | null {
  if (!password) return 'empty';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(password)) return 'control';
  const normalized = normalizePassword(password);
  if ([...normalized].length < MIN_PASSWORD_LENGTH) return 'too-short';
  if (utf8Length(normalized) > MAX_PASSWORD_BYTES) return 'too-long';
  return null;
}

export function validateNewPassword(password: string, confirmation: string): PasswordIssue | null {
  return passwordIssue(password) ?? (normalizePassword(password) === normalizePassword(confirmation) ? null : 'mismatch');
}

export function randomOwnerPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

const baseName = (name: string) => name.replace(/\.pdf$/i, '') || 'tai-lieu';
export const protectedFileName = (name: string) => `${baseName(name)}-co-mat-khau.pdf`;
export const unlockedFileName = (name: string) => `${baseName(name)}-da-go-mat-khau.pdf`;
export const optimizedFileName = (name: string) => `${baseName(name)}-toi-uu.pdf`;

const INPUT = 'input.pdf';
const OUTPUT = 'output.pdf';
const succeeded = (code: number) => code === 0 || code === 3;
const mentionsInvalidPassword = (result: QpdfResult) => result.messages.some(m => /invalid password/i.test(m));
const isPdf = (bytes?: Uint8Array) => !!bytes && bytes.length > 8 && new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-');

export type PasswordStep = 'loading' | 'checking' | 'encrypting' | 'decrypting' | 'verifying' | 'optimizing';

async function encryptionState(runner: QpdfRunner, bytes: Uint8Array, password: string) {
  const result = await runner.run(['--is-encrypted', `--password=${password}`, INPUT], { [INPUT]: bytes }, []);
  if (result.code === 0) return 'unlocked' as const;
  if (mentionsInvalidPassword(result)) return 'locked' as const;
  if (result.messages.some(m => !m.startsWith('WARNING'))) return 'invalid' as const;
  return 'plain' as const;
}

export async function protectPdf(bytes: Uint8Array, password: string, runner: QpdfRunner, onStep?: (step: PasswordStep) => void) {
  const issue = passwordIssue(password);
  if (issue) throw new PdfPasswordError('invalid-password', PASSWORD_ISSUE_MESSAGES[issue]);
  const userPassword = normalizePassword(password);
  onStep?.('checking');
  const state = await encryptionState(runner, bytes, '');
  if (state === 'invalid') throw new PdfPasswordError('invalid-pdf');
  if (state === 'locked') throw new PdfPasswordError('already-encrypted');
  onStep?.('encrypting');
  const encrypted = await runner.run([INPUT, '--encrypt', `--user-password=${userPassword}`, `--owner-password=${randomOwnerPassword()}`, '--bits=256', '--', OUTPUT], { [INPUT]: bytes }, [OUTPUT]);
  const output = encrypted.files[OUTPUT];
  if (!succeeded(encrypted.code) || !isPdf(output)) throw new PdfPasswordError(encrypted.messages.length ? 'invalid-pdf' : 'failed');
  onStep?.('verifying');
  if (await encryptionState(runner, output, '') !== 'locked' || await encryptionState(runner, output, userPassword) !== 'unlocked') throw new PdfPasswordError('failed');
  return output;
}

export async function unlockPdf(bytes: Uint8Array, password: string, runner: QpdfRunner, onStep?: (step: PasswordStep) => void) {
  if (!password) throw new PdfPasswordError('invalid-password', PASSWORD_ISSUE_MESSAGES.empty);
  onStep?.('checking');
  let accepted: string | undefined;
  for (const candidate of new Set([normalizePassword(password), password])) {
    const state = await encryptionState(runner, bytes, candidate);
    if (state === 'plain') throw new PdfPasswordError('not-encrypted');
    if (state === 'invalid') throw new PdfPasswordError('invalid-pdf');
    if (state === 'unlocked') { accepted = candidate; break; }
  }
  if (accepted === undefined) throw new PdfPasswordError('wrong-password');
  onStep?.('decrypting');
  const decrypted = await runner.run(['--decrypt', `--password=${accepted}`, INPUT, OUTPUT], { [INPUT]: bytes }, [OUTPUT]);
  const output = decrypted.files[OUTPUT];
  if (!succeeded(decrypted.code) || !isPdf(output)) throw new PdfPasswordError(mentionsInvalidPassword(decrypted) ? 'wrong-password' : 'failed');
  onStep?.('verifying');
  if (await encryptionState(runner, output, '') !== 'plain') throw new PdfPasswordError('failed');
  return output;
}

/** Lossless qpdf rewrite: object streams plus maximum Flate recompression. Encrypted input is rejected. */
export async function optimizePdf(bytes: Uint8Array, runner: QpdfRunner, onStep?: (step: PasswordStep) => void) {
  onStep?.('checking');
  const state = await encryptionState(runner, bytes, '');
  if (state === 'invalid') throw new PdfPasswordError('invalid-pdf');
  if (state === 'locked') throw new PdfPasswordError('already-encrypted', 'Hãy gỡ mật khẩu trước khi tối ưu tệp.');
  onStep?.('optimizing');
  const result = await runner.run(['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', INPUT, OUTPUT], { [INPUT]: bytes }, [OUTPUT]);
  const output = result.files[OUTPUT];
  if (!succeeded(result.code) || !isPdf(output)) throw new PdfPasswordError('failed');
  return output.length < bytes.length ? output : bytes;
}
