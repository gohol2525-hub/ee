import { cp, mkdir } from 'node:fs/promises';

const target = 'public/ocr/runtime';
await mkdir(target, { recursive: true });
await cp('node_modules/tesseract.js/dist/worker.min.js', `${target}/worker.min.js`);
for (const core of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js']) await cp(`node_modules/tesseract.js-core/${core}`, `${target}/${core}`);
