import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

export class PdfPasswordCancelledError extends Error {}

export class PdfEncryptedMergeError extends Error {
  constructor() {
    super('Không thể thêm trang từ PDF được bảo vệ. Hãy mở tệp riêng để xem.');
  }
}

export type RequestPdfPassword = (retry: boolean) => Promise<string | null>;

export async function loadPdfWithTask<T>(task: PDFDocumentLoadingTask, usePdf: (pdf: PDFDocumentProxy) => T | Promise<T>, request?: RequestPdfPassword) {
  let retry = false;
  let cancellation: PdfPasswordCancelledError | undefined;
  if (request) task.onPassword = async (respond: (value: string | Error) => void) => {
    try {
      const password = await request(retry);
      retry = true;
      if (password === null) {
        cancellation = new PdfPasswordCancelledError();
        respond(cancellation);
      } else respond(password);
    } catch (error) {
      respond(error instanceof Error ? error : new Error('Password request failed'));
    }
  };
  try {
    return await usePdf(await task.promise);
  } catch (error) {
    await task.destroy();
    throw cancellation ?? error;
  }
}
