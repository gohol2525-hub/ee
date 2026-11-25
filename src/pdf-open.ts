export const MAX_PDF_PAGES = 200;

export class PdfPageLimitError extends Error {
  constructor() {
    super(`Tài liệu tối đa ${MAX_PDF_PAGES} trang.`);
  }
}

export function pdfImportErrorMessage(error: unknown) {
  if (error instanceof PdfPageLimitError) return error.message;
  if (error instanceof Error && /encrypt|password/i.test(error.message)) {
    return 'PDF có mật khẩu chưa được hỗ trợ. Hãy mở khóa bản sao trước khi sử dụng.';
  }
  return 'Không thể mở tệp. Tệp có thể bị hỏng hoặc sai định dạng.';
}
