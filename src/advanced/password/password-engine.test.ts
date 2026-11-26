import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createQpdfModule, runQpdf } from './qpdf-core.ts';
import { optimizePdf, PdfPasswordError, protectPdf, unlockPdf, validateNewPassword, passwordIssue, type QpdfRunner } from './password-engine.ts';
import { loadPdfWithTask } from '../../pdf-password.ts';

// qpdf-wasm targets browsers: give Node the globals it reads and answer its pthread pool handshake (qpdf never spawns threads here).
const globals = globalThis as Record<string, unknown>;
globals.self ??= globalThis;
(globalThis as { location?: unknown }).location ??= { href: 'file:///qpdf/' };
globals.Worker ??= class { onmessage?: (event: { data: unknown }) => void; postMessage(message: { cb?: string }) { if (message?.cb === 'load') setTimeout(() => this.onmessage?.({ data: { cb: 'loaded' } })); } terminate() {} };
const { default: init } = await import('qpdf-wasm');
const wasm = await WebAssembly.compile(new Uint8Array(await readFile('node_modules/qpdf-wasm/qpdf.wasm')));
const qpdf = await createQpdfModule(init, { instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => { void WebAssembly.instantiate(wasm, imports).then(instance => done(instance, wasm)); return {}; } });
const runner: QpdfRunner = { run: async (args, inputs, outputs) => runQpdf(qpdf, args, inputs, outputs), dispose() {} };

const samplePdf = async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]).drawText('Xin chao trang mot', { x: 30, y: 300, size: 14 });
  doc.addPage([300, 400]).drawText('Trang hai', { x: 30, y: 300, size: 14 });
  return doc.save({ useObjectStreams: false });
};
const pdfText = async (data: Uint8Array, password?: string) => {
  const pdf = await getDocument({ data: data.slice(), password, useSystemFonts: false, verbosity: 0 }).promise;
  try {
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) pages.push((await (await pdf.getPage(i)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join(''));
    return pages;
  } finally { await pdf.destroy(); }
};
const pdfjsError = async (data: Uint8Array, password?: string) => {
  const task = getDocument({ data: data.slice(), password, verbosity: 0 });
  try { await task.promise; return null; } catch (error) { return error as { name: string; code: number }; } finally { await task.destroy(); }
};
const rejectsWith = (promise: Promise<unknown>, kind: string) => assert.rejects(promise, (error: unknown) => error instanceof PdfPasswordError && error.kind === kind);

test('the app opens an AES-256 PDF with the same decomposed Vietnamese password that protected it', async () => {
  const password='Mật khẩu thử nghiệm'.normalize('NFD');
  const bytes=await protectPdf(await samplePdf(),password,runner);
  let prompts=0;
  const pdf=await loadPdfWithTask(getDocument({data:bytes.slice(),verbosity:0}),pdf=>pdf,async retry=>{prompts++;return retry?null:password;});
  try { assert.equal(pdf.numPages,2); assert.equal(prompts,1); } finally { await pdf.destroy(); }
});

test('validates new passwords before encrypting', () => {
  assert.equal(validateNewPassword('', ''), 'empty');
  assert.equal(validateNewPassword('abc', 'abc'), 'too-short');
  assert.equal(validateNewPassword('a'.repeat(128), 'a'.repeat(128)), 'too-long');
  assert.equal(validateNewPassword('ệ'.repeat(43), 'ệ'.repeat(43)), 'too-long');
  assert.equal(validateNewPassword('ệ'.repeat(42), 'ệ'.repeat(42)), null);
  assert.equal(validateNewPassword('abcd\nefg', 'abcd\nefg'), 'control');
  assert.equal(validateNewPassword('mật khẩu', 'mật khẩu!'), 'mismatch');
  assert.equal(validateNewPassword('mật khẩu', 'mật khẩu'.normalize('NFD')), null);
  assert.equal(passwordIssue('a'.repeat(127)), null);
});

test('encrypts with AES-256 (V5/R6/AESV3) and round-trips through PDF.js and qpdf', async () => {
  const source = await samplePdf();
  const steps: string[] = [];
  const encrypted = await protectPdf(source, 'Mật khẩu bí mật 2026', runner, step => steps.push(step));
  assert.deepEqual(steps, ['checking', 'encrypting', 'verifying']);
  const raw = await PDFDocument.load(encrypted, { ignoreEncryption: true, updateMetadata: false });
  assert.equal(raw.isEncrypted, true);
  const dict = raw.context.lookup(raw.context.trailerInfo.Encrypt, PDFDict);
  const num = (key: string) => dict.lookup(PDFName.of(key), PDFNumber).asNumber();
  assert.equal(dict.lookup(PDFName.of('Filter')), PDFName.of('Standard'));
  assert.equal(num('V'), 5);
  assert.equal(num('R'), 6);
  assert.equal(num('Length'), 256);
  const stdCF = dict.lookup(PDFName.of('CF'), PDFDict).lookup(PDFName.of('StdCF'), PDFDict);
  assert.equal(stdCF.lookup(PDFName.of('CFM')), PDFName.of('AESV3'));
  assert.equal(dict.lookup(PDFName.of('StmF')), PDFName.of('StdCF'));
  assert.equal(dict.lookup(PDFName.of('StrF')), PDFName.of('StdCF'));
  assert.ok(!new TextDecoder('latin1').decode(encrypted).includes('Xin chao'));
  assert.equal((await pdfjsError(encrypted))?.name, 'PasswordException');
  assert.equal((await pdfjsError(encrypted, 'sai mật khẩu'))?.code, 2);
  assert.deepEqual(await pdfText(encrypted, 'Mật khẩu bí mật 2026'), ['Xin chao trang mot', 'Trang hai']);
  const shown = runQpdf(qpdf, ['--show-encryption', '--password=Mật khẩu bí mật 2026', 'in.pdf'], { 'in.pdf': encrypted }, []);
  assert.equal(shown.code, 0);
  assert.ok(shown.messages.includes('R = 6'));
  assert.ok(shown.messages.includes('file encryption method: AESv3'));
});

test('removes encryption only with the valid current password', async () => {
  const encrypted = await protectPdf(await samplePdf(), 'mật khẩu', runner);
  await rejectsWith(unlockPdf(encrypted, 'mat khau', runner), 'wrong-password');
  await rejectsWith(unlockPdf(encrypted, '', runner), 'invalid-password');
  const unlocked = await unlockPdf(encrypted, 'mật khẩu'.normalize('NFD'), runner);
  assert.equal((await PDFDocument.load(unlocked, { ignoreEncryption: true })).isEncrypted, false);
  assert.equal(await pdfjsError(unlocked), null);
  assert.deepEqual(await pdfText(unlocked), ['Xin chao trang mot', 'Trang hai']);
});

test('rejects unencrypted, damaged and already protected inputs cleanly', async () => {
  const plain = await samplePdf();
  await rejectsWith(unlockPdf(plain, 'mật khẩu', runner), 'not-encrypted');
  await rejectsWith(unlockPdf(new TextEncoder().encode('not a pdf'), 'mật khẩu', runner), 'invalid-pdf');
  await rejectsWith(protectPdf(new TextEncoder().encode('not a pdf'), 'mật khẩu', runner), 'invalid-pdf');
  await rejectsWith(protectPdf(await protectPdf(plain, 'mật khẩu', runner), 'khác hẳn', runner), 'already-encrypted');
  await rejectsWith(protectPdf(plain, 'abc', runner), 'invalid-password');
});

test('never writes passwords to the console', async () => {
  const seen: string[] = [];
  const { log, error, warn, info } = console;
  console.log = console.error = console.warn = console.info = (...parts: unknown[]) => { seen.push(parts.join(' ')); };
  try {
    const encrypted = await protectPdf(await samplePdf(), 'bí-mật-rất-riêng', runner);
    await unlockPdf(encrypted, 'đoán-sai-hoàn-toàn', runner).catch(() => undefined);
    await unlockPdf(encrypted, 'bí-mật-rất-riêng', runner);
    runQpdf(qpdf, ['--show-encryption', '--password=bí-mật-rất-riêng', 'in.pdf'], { 'in.pdf': encrypted }, []);
  } finally { Object.assign(console, { log, error, warn, info }); }
  assert.ok(!seen.some(line => line.includes('bí-mật') || line.includes('đoán-sai')));
});

test('optimizes losslessly without growing the file', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 20; i++) doc.addPage([300, 400]).drawText(`Trang ${i + 1}`, { x: 30, y: 300, size: 14 });
  const source = await doc.save({ useObjectStreams: false });
  const optimized = await optimizePdf(source, runner);
  assert.ok(optimized.length < source.length);
  assert.equal((await pdfText(optimized)).length, 20);
  await rejectsWith(optimizePdf(await protectPdf(source, 'mật khẩu', runner), runner), 'already-encrypted');
});
