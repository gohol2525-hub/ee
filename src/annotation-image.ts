import type { AnnotationImage } from './model.ts';

const MAX_CANVAS_SIDE = 4096;
const MAX_CANVAS_PIXELS = 16_000_000;

export async function rasterizeAnnotationImage(file: File): Promise<Pick<AnnotationImage, 'type' | 'width' | 'height'> & { blob: Blob }> {
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const type = [137,80,78,71,13,10,26,10].every((byte,i)=>header[i]===byte) ? 'image/png'
    : header[0]===255 && header[1]===216 && header[2]===255 ? 'image/jpeg' : null;
  if (!type) throw new Error('Unsupported annotation image');

  const bitmap = await createImageBitmap(file.slice(0, file.size, type), { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, MAX_CANVAS_SIDE / Math.max(bitmap.width, bitmap.height), Math.sqrt(MAX_CANVAS_PIXELS / (bitmap.width * bitmap.height)));
    const width = Math.max(1, Math.floor(bitmap.width * scale));
    const height = Math.max(1, Math.floor(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Cannot create annotation image canvas');
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, .92));
    if (!blob || blob.type !== type) throw new Error('Cannot encode annotation image');
    return { blob, type, width, height };
  } finally {
    bitmap.close();
  }
}
