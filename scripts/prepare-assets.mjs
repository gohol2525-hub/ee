import { cp, mkdir } from 'node:fs/promises';
await mkdir('public/pdf-assets', { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) await cp(`node_modules/pdfjs-dist/${dir}`, `public/pdf-assets/${dir}`, { recursive: true });
await import('./prepare-ocr.mjs');
await mkdir('public/cad-assets', { recursive: true });
await cp('node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm','public/cad-assets/libredwg-web.wasm');
