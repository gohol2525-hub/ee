# CAD → PDF (DXF / DWG)

Mở **CAD sang PDF** ở thanh bên / thẻ trang chủ, hoặc chọn / thả một tệp
`.dxf` / `.dwg` vào vùng mở tài liệu. Chuyển từng bản vẽ; có thể mở PDF kết quả
vào trình chỉnh sửa, hoặc tải xuống rồi ghép các PDF bằng công cụ hiện có.

- Đầu vào: ASCII DXF và DWG R13–R2018 (cùng family `AC1032` của các bản AutoCAD
  mới hơn), tối đa 50 MB. Không hỗ trợ binary DXF, DWG mã hóa / lỗi / phiên bản
  khác. DWG dùng LibreDWG WASM ngay trong worker trên thiết bị, không cần cloud
  hoặc API key. Có nút hủy và giới hạn đọc 60 giây.
- Khổ A4/A3/A2/A1/A0/Letter hoặc tùy chỉnh 50–2.000 mm; dọc/ngang, lề,
  căn giữa / góc dưới trái, vừa trang hoặc tỷ lệ cố định `1:n`.
- Chọn đơn vị mm/cm/m/inch/feet theo tệp (tệp không khai báo: mặc định mm),
  chọn layer, màu CAD / đen trắng / xám, nét đồng nhất 0,05–3 mm hoặc lineweight
  từng đối tượng với hệ số 0,1–10. ByLayer/ByBlock lineweight dùng 0,25 mm;
  không tái hiện CTB/STB. Màu trắng được in đen trên nền giấy trắng.
- **Cập nhật xem trước** tạo chính PDF sắp tải, không phải một ảnh mô phỏng
  riêng. Sau khi đổi thiết lập, tải xuống bị khóa tới khi cập nhật bản in;
  tỷ lệ cố định vượt vùng in bị từ chối thay vì âm thầm cắt bản vẽ.
  Khi in PDF thật, dùng Actual size / 100%, không dùng Fit.
- Hình học 2D: LINE, LWPOLYLINE/POLYLINE (kể cả bulge), ARC, CIRCLE, ELLIPSE,
  POINT, SOLID/3DFACE, TEXT/MTEXT, INSERT lồng nhau / mảng block và DIMENSION
  có khối hình học nhúng. Xuất nét vector và chữ có thể chọn bằng Noto Sans.
  Không phải bộ render AutoCAD: chỉ Model Space, không Paper Space / layout /
  viewport, hatch, spline/curve-fit, 3D solid/mesh, OCS nghiêng, ảnh / XREF ngoài,
  SHX, attribute values hay định dạng MTEXT phức tạp. Cao độ của nét thường
  được chiếu xuống XY; không dựng hình 3D. MTEXT chỉ giữ ngắt dòng đã có,
  không tự wrap theo chiều rộng. Block lật gương dùng chữ đọc được.
- Mọi đối tượng không được hỗ trợ mà bộ đọc nhận ra đều hiện cảnh báo; cần
  xem và chấp nhận giới hạn trước khi tải. DWG luôn có thông báo kiểm tra
  sai khác với AutoCAD. Không dùng kết quả chưa kiểm tra làm bản vẽ chuẩn thi công.

Thư viện CAD được tải lười, không làm chậm việc mở PDF thông thường. Cài đặt /
build sao chép WASM từ dependency đã pin. Giấy phép GPL-3.0, MIT và link mã nguồn
tương ứng được phát hành tại `/cad-assets/NOTICE.txt`, có thể mở ngay từ công cụ.
Fixture DWG thật và test hình học / layer / tỷ lệ / màu / xuất PDF ở `src/cad`.

# Giấy PDF

A Vietnamese, browser-based PDF viewer, annotation editor and file converter. Documents are processed in the browser, never uploaded to the server. No account or API key is needed by the app itself (Devin's hosted preview requires session access).

## Run locally

Requires Node.js 24 and npm. No pre-commit hooks are configured.

```sh
nvm use
npm install
npm run dev
```

For a production server:

```sh
npm run build
npm start
```

The production server listens on `0.0.0.0:4173`; override with `PORT`. The server only serves static assets and accepts no document uploads. `npm install` and `npm run build` copy the PDF.js character maps, standard fonts and WASM decoders into the build; all assets, including the Vietnamese font, are served locally.

OCR worker/core and Vietnamese/English language data are served locally too. Password operations use a qpdf WebAssembly worker with shared memory: keep the `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers configured in the production/Vite servers when hosting elsewhere. Use HTTPS (or localhost) in a modern browser; an embedded preview may need opening in its own tab to enable cross-origin isolation.

## Features

- Open PDFs with thumbnails, zoom and page navigation. Try the built-in Vietnamese demo without choosing a file.
- Select existing horizontal PDF text with **Sửa chữ** to cover its visible area and insert replacement text; choose the cover background color. This is a reversible cover layer, not native text rewriting or redaction.
- Insert Vietnamese text with Noto Sans/Serif, bold, italic, size and color. All eight real font faces are bundled locally and embedded into downloads. Select inserted text to change formatting/content.
- Insert PNG/JPEG images directly from the toolbar; drag inserted content with a mouse or use X/Y position fields. Resize images with an aspect-ratio-preserving slider. Insert rectangle/ellipse outlines, rectangular highlights and freehand ink/signatures.
- Rotate, delete, reorder and merge pages; undo/redo up to 30 operations. Download a new PDF with baked-in annotations.
- Convert PDF pages to PNG or JPEG (ZIP for multiple pages), extract the available text as UTF-8 TXT, or export selected/current pages as PDF.
- Open JPG/PNG images as A4 PDF pages. Multiple images can be combined, annotated and downloaded as a PDF.
- Recognize Vietnamese/English text in scanned pages with local OCR. Download recognized UTF-8 text or a searchable PDF; OCR results need proofreading.
- Compress scan/photo PDFs with quality and resolution controls, progress and an honest before/after size comparison. Raster compression trades selectable text, links and form fields for a smaller image-based copy and may not shrink every file.
- Protect downloads with an AES-256 open password, or remove encryption after providing the current password. Passwords are used in memory only; protection is not a password-recovery or cracking tool.
- Add Vietnamese watermarks and page numbers with configurable placement and page scope.
- Fill supported AcroForm text, checkbox, radio and choice fields with Vietnamese appearances, then apply/download a flattened completed copy. Read-only fields remain read-only; XFA and digital signing are unsupported. Fill forms before other transformations or merging documents.
- Responsive desktop and mobile layouts, keyboard shortcuts (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+S), and a home-screen manifest without a service worker.

## Limits

- Up to 50 MB of selected source files and 200 pages per document. Conversion is sequential; large files may still use substantial browser memory. Image output is capped at 16 megapixels per page.
- Editing adds layers; it does not rewrite or redact existing PDF text. Covered text remains searchable/copyable and can appear in TXT/Word extraction, so do not use cover layers to remove sensitive content. Existing-text selection supports horizontal text runs (including pages rotated in the app); vertical/skewed/RTL text and paragraph reflow are not supported. OCR is a separate recognition tool, not native text rewriting. Freehand signatures are drawings, not cryptographic signatures.
- Password-protected PDFs open with their password in read-only mode. Use **Mật khẩu PDF** to remove encryption with the valid current password before editing, merging, converting or exporting. TXT/DOCX import and text-based DOCX export are supported; old DOC, XLSX and PPTX are not. TXT/DOCX extraction needs a text layer (native or OCR) and does not preserve the original layout.
- OCR quality depends on scan clarity and language; verify names, numbers and diacritics. Heavy OCR/compression processing is sequential and cancellable, but can still use substantial memory on phones. Browser-local processing does not mean offline availability: runtime assets must first load from this app.
- Documents and changes are held in memory only and lost on refresh; download before leaving. Downloads do not upload or save a server-side copy.
- PDF output copies pages and bakes in app annotations. Interactive forms, bookmarks, existing digital signatures and advanced document-level metadata are not guaranteed to survive; keep the original file.

## Verification

```sh
npm test
npm run build
npm audit
```

The Node tests check merged/reordered/rotated output, original-byte preservation, Vietnamese Unicode extraction and coordinates at all rotations, cropped-page origins, image-to-PDF conversion, and invalid export inputs. GitHub Actions runs tests, production build and production dependency auditing.

Advanced-tool tests include real Vietnamese scan OCR and searchable text layers, raster compression/size outcomes, AES-256 password round trips and wrong-password rejection, watermark/number geometry on cropped/rotated pages, and flattened Unicode form values.

## Stack and licenses

React, TypeScript, Vite, PDF.js, pdf-lib, JSZip, Lucide, Tesseract.js and qpdf WASM. Noto Sans is bundled under the SIL Open Font License; its license is included beside the font. PDF.js asset licenses are copied with its runtime files. OCR and encryption run locally without a cloud API or document upload.
