import type { PDFDocumentLoadingTask } from 'pdfjs-dist';

export class PdfPasswordCancelledError extends Error {}

export class PdfEncryptedMergeError extends Error {
  constructor() {
    super('Không thể thêm trang từ PDF được bảo vệ. Hãy mở tệp riêng để xem.');
  }
}

export type RequestPdfPassword = (retry: boolean) => Promise<string | null>;

export async function loadPdfWithPassword(task: PDFDocumentLoadingTask, request: RequestPdfPassword) {
  let retry = false;
  let cancellation: PdfPasswordCancelledError | undefined;
  task.onPassword = async (respond: (value: string | Error) => void) => {
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
    return await task.promise;
  } catch (error) {
    await task.destroy();
    throw cancellation ?? error;
  }
}
