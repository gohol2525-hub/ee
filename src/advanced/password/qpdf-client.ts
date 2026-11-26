import qpdfScriptUrl from 'qpdf-wasm/qpdf.js?url';
import qpdfWasmUrl from 'qpdf-wasm/qpdf.wasm?url';
import { PdfPasswordError, type QpdfRunner } from './password-engine.ts';
import type { QpdfWorkerRequest, QpdfWorkerResponse } from './qpdf.worker.ts';

/** qpdf-wasm is a pthreads build: it needs SharedArrayBuffer, i.e. a cross-origin isolated page (COOP + COEP). */
export const qpdfSupported = () => typeof Worker === 'function' && typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true;

export const QPDF_UNSUPPORTED_MESSAGE = 'Trình duyệt hoặc máy chủ chưa bật chế độ bảo mật cần cho bộ mã hóa PDF. Hãy tải lại trang hoặc dùng Chrome, Edge, Firefox, Safari bản mới.';

/** One worker per operation: terminating it drops the WASM heap that held the password. */
export function createQpdfRunner(): QpdfRunner {
  if (!qpdfSupported()) throw new PdfPasswordError('failed', QPDF_UNSUPPORTED_MESSAGE);
  const worker = new Worker(new URL('./qpdf.worker.ts', import.meta.url), { type: 'module', name: 'qpdf-runner' });
  const absolute = (url: string) => new URL(url, location.href).href;
  const pending = new Map<number, { resolve: (value: QpdfWorkerResponse) => void; reject: (error: Error) => void }>();
  let next = 0;
  const failAll = () => {
    for (const { reject } of pending.values()) reject(new PdfPasswordError('failed', 'Bộ mã hóa PDF đã dừng. Vui lòng thử lại.'));
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<QpdfWorkerResponse>) => {
    const entry = pending.get(event.data.id);
    pending.delete(event.data.id);
    entry?.resolve(event.data);
  };
  worker.onerror = event => { event.preventDefault(); failAll(); };
  worker.onmessageerror = failAll;
  return {
    async run(args, inputs, outputs) {
      const id = ++next;
      const copies = Object.fromEntries(Object.entries(inputs).map(([name, bytes]) => [name, bytes.slice()]));
      const request: QpdfWorkerRequest = { id, scriptUrl: absolute(qpdfScriptUrl), wasmUrl: absolute(qpdfWasmUrl), args, inputs: copies, outputs };
      const response = await new Promise<QpdfWorkerResponse>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage(request, Object.values(copies).map(bytes => bytes.buffer));
      });
      if (!response.ok) throw new PdfPasswordError('failed', 'Không tải được bộ mã hóa PDF. Kiểm tra kết nối rồi thử lại.');
      return { code: response.code, files: response.files, messages: response.messages };
    },
    dispose() {
      worker.terminate();
      failAll();
    },
  };
}
