import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({ plugins: [react()], server: {headers}, preview: {headers}, build: { chunkSizeWarningLimit: 1200, rollupOptions: { output: { manualChunks: { 'pdf-renderer': ['pdfjs-dist'], 'pdf-editor': ['pdf-lib', '@pdf-lib/fontkit'], 'zip': ['jszip'] } } } } });
