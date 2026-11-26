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
- Select existing horizontal PDF text with **Sửa chữ** to cover its visible area and insert replacement text; choose the cover background color. This is a reversible cover layer, not native text rewriting or redaction.
- Insert Vietnamese text with Noto Sans/Serif, bold, italic, size and color. All eight real font faces are bundled locally and embedded into downloads. Select inserted text to change formatting/content.
- Insert PNG/JPEG images directly from the toolbar; drag inserted content with a mouse or use X/Y position fields. Resize images with an aspect-ratio-preserving slider. Insert rectangle/ellipse outlines, rectangular highlights and freehand ink/signatures.
- Rotate, delete, reorder and merge pages; undo/redo up to 30 operations. Download a new PDF with baked-in annotations.
- Convert PDF pages to PNG or JPEG (ZIP for multiple pages), extract the available text as UTF-8 TXT, or export selected/current pages as PDF.
- Open JPG/PNG images as A4 PDF pages. Multiple images can be combined, annotated and downloaded as a PDF.
- Responsive desktop and mobile layouts, keyboard shortcuts (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+S), and a home-screen manifest without a service worker.

## Limits

- Up to 50 MB of selected source files and 200 pages per document. Conversion is sequential; large files may still use substantial browser memory. Image output is capped at 16 megapixels per page.
- Editing adds layers; it does not rewrite or redact existing PDF text. Covered text remains searchable/copyable and can appear in TXT/Word extraction, so do not use cover layers to remove sensitive content. Existing-text selection supports horizontal text runs (including pages rotated in the app); OCR, vertical/skewed/RTL text and paragraph reflow are not supported. Freehand signatures are drawings, not cryptographic signatures.
- Password-protected PDFs can be opened with their password for viewing only. Use an unlocked copy to edit, merge, convert, or export. TXT/DOCX import and text-based DOCX export are supported; old DOC, XLSX and PPTX are not. TXT/DOCX extraction needs an existing text layer and does not preserve the original layout.
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
