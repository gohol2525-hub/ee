import { imageKind } from './pdf-engine.ts';
import type { AnnotationImage } from './model.ts';

const MAX_ANNOTATION_CANVAS_SIDE = 4096;
const MAX_CANVAS_PIXELS = 16_000_000;

type Raster = Pick<AnnotationImage, 'type' | 'width' | 'height'> & { blob: Blob };

export async function rasterizeImage(input: Blob, type: Raster['type'], maxSide = Infinity): Promise<Raster> {
  const canvas = document.createElement('canvas');
  const bitmap = await createImageBitmap(input, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height), Math.sqrt(MAX_CANVAS_PIXELS / (bitmap.width * bitmap.height)));
    const width = Math.max(1, Math.floor(bitmap.width * scale));
    const height = Math.max(1, Math.floor(bitmap.height * scale));
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Cannot create image canvas');
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, .92));
    if (!blob || blob.type !== type) throw new Error('Cannot encode image');
    return { blob, type, width, height };
  } finally {
    bitmap.close();
    canvas.width = 0; canvas.height = 0;
  }
}

export async function rasterizeAnnotationImage(file: File): Promise<Raster> {
  const type = imageKind(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
  if (!type) throw new Error('Unsupported annotation image');
  return rasterizeImage(file.slice(0, file.size, type), type, MAX_ANNOTATION_CANVAS_SIDE);
}
