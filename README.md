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

## Features

- Open PDFs with thumbnails, zoom and page navigation. Try the built-in Vietnamese demo without choosing a file.
- Add Vietnamese text annotations, rectangular highlights and freehand ink/signatures. Select existing annotations to edit their text or delete them.
- Rotate, delete, reorder and merge pages; undo/redo up to 30 operations. Download a new PDF with baked-in annotations.
- Convert PDF pages to PNG or JPEG (ZIP for multiple pages), extract the available text as UTF-8 TXT, or export selected/current pages as PDF.
- Open JPG/PNG images as A4 PDF pages. Multiple images can be combined, annotated and downloaded as a PDF.
- Responsive desktop and mobile layouts, keyboard shortcuts (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+S), and a home-screen manifest without a service worker.

## Limits

- Up to 50 MB of selected source files and 200 pages per document. Conversion is sequential; large files may still use substantial browser memory. Image output is capped at 16 megapixels per page.
- Editing adds annotations; it does not rewrite or redact existing PDF text. Freehand signatures are drawings, not cryptographic signatures.
- Password-protected PDFs, OCR and Office formats (DOCX/XLSX/PPTX) are not supported. TXT extraction needs an existing text layer.
- Documents and changes are held in memory only and lost on refresh; download before leaving. Downloads do not upload or save a server-side copy.
- PDF output copies pages and bakes in app annotations. Interactive forms, bookmarks, existing digital signatures and advanced document-level metadata are not guaranteed to survive; keep the original file.

## Verification

```sh
npm test
npm run build
npm audit
```

The Node tests check merged/reordered/rotated output, original-byte preservation, Vietnamese Unicode extraction and coordinates at all rotations, cropped-page origins, image-to-PDF conversion, and invalid export inputs. GitHub Actions runs tests, production build and production dependency auditing.

## Stack and licenses

React, TypeScript, Vite, PDF.js, pdf-lib, JSZip and Lucide. Noto Sans is bundled under the SIL Open Font License; its license is included beside the font. PDF.js asset licenses are copied with its runtime files.
