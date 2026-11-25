export const MAX_PDF_PAGES = 200;

export class PdfPageLimitError extends Error {
  constructor() {
    super(`Tài liệu tối đa ${MAX_PDF_PAGES} trang.`);
  }
}

export function pdfImportErrorMessage(error: unknown) {
  if (error instanceof PdfPageLimitError) return error.message;
  if (error instanceof Error && /encrypt|password/i.test(error.message)) {
    return 'Không thể mở PDF được bảo vệ. Hãy thử một bản sao đã bỏ mật khẩu.';
  }
  return 'Không thể mở tệp. Tệp có thể bị hỏng hoặc sai định dạng.';
}
