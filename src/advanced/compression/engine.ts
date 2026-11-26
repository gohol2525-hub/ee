import { degrees, PDFDocument } from 'pdf-lib';
import type { RasterSettings } from './options.ts';

export const MAX_RASTER_SIDE = 5000;
export const MAX_RASTER_PIXELS = 12_000_000;

/** Visible page box in PDF points before rotation; rotation is clockwise degrees (0/90/180/270). */
export interface PageGeometry { width: number; height: number; rotation: number }

export interface RasterSize { pixelWidth: number; pixelHeight: number; scale: number }

export interface RasterSource {
  pageCount: number;
  geometry: (index: number) => Promise<PageGeometry>;
  /** Renders the unrotated page box to a JPEG of exactly the requested pixel size. */
  renderJpeg: (index: number, size: RasterSize, quality: number) => Promise<Uint8Array>;
  /** Releases the resources of one page after it was rendered. */
  releasePage?: (index: number) => void;
}

export interface RasterProgress { done: number; total: number }

export class CompressionCancelledError extends Error {
  constructor() { super('Đã hủy nén.'); }
}

export const normalizeRotation = (rotation: number) => ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;

export function pageGeometry(view: ArrayLike<number>, rotation: number): PageGeometry {
  const width = Math.abs(view[2] - view[0]);
  const height = Math.abs(view[3] - view[1]);
  if (!(width > 0) || !(height > 0)) throw new Error('Trang PDF có kích thước không hợp lệ.');
  return { width, height, rotation: normalizeRotation(rotation) };
}

export function rasterSize(geometry: Pick<PageGeometry, 'width' | 'height'>, dpi: number, maxSide = MAX_RASTER_SIDE, maxPixels = MAX_RASTER_PIXELS): RasterSize {
  const wanted = dpi / 72;
  const scale = Math.min(wanted, maxSide / geometry.width, maxSide / geometry.height, Math.sqrt(maxPixels / (geometry.width * geometry.height)));
  const pixelWidth = Math.max(1, Math.min(maxSide, Math.floor(geometry.width * scale)));
  const pixelHeight = Math.max(1, Math.min(maxSide, Math.floor(geometry.height * scale)));
  return { pixelWidth, pixelHeight, scale };
}

export function isJpeg(bytes: Uint8Array) {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

async function addRasterPage(doc: PDFDocument, page: PageGeometry & { jpeg: Uint8Array }) {
  if (!isJpeg(page.jpeg)) throw new Error('Không mã hóa được ảnh JPEG cho trang.');
  const image = await doc.embedJpg(page.jpeg);
  const out = doc.addPage([page.width, page.height]);
  out.drawImage(image, { x: 0, y: 0, width: page.width, height: page.height });
  out.setRotation(degrees(normalizeRotation(page.rotation)));
}

/** Renders pages one at a time so only one page raster is held in memory. */
export async function rasterCompress(source: RasterSource, settings: RasterSettings, onProgress?: (progress: RasterProgress) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const total = source.pageCount;
  if (!total) throw new Error('Không có trang nào để nén.');
  const doc = await PDFDocument.create();
  onProgress?.({ done: 0, total });
  for (let index = 0; index < total; index++) {
    if (signal?.aborted) throw new CompressionCancelledError();
    try {
      const geometry = await source.geometry(index);
      const jpeg = await source.renderJpeg(index, rasterSize(geometry, settings.dpi), settings.quality);
      if (signal?.aborted) throw new CompressionCancelledError();
      await addRasterPage(doc, { ...geometry, jpeg });
    } finally {
      source.releasePage?.(index);
    }
    onProgress?.({ done: index + 1, total });
  }
  return doc.save({ useObjectStreams: true });
}

/** Lossless re-save: drops unreferenced objects and packs objects into streams; keeps text, links and forms. */
export async function optimizeStructure(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.save({ useObjectStreams: true });
}
