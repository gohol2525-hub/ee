export interface RasterSettings { dpi: number; quality: number }

export const RESOLUTION_OPTIONS = [
  { dpi: 72, label: 'Thấp · 72 dpi (nhỏ nhất)' },
  { dpi: 100, label: 'Vừa · 100 dpi (đọc trên màn hình)' },
  { dpi: 150, label: 'Cao · 150 dpi (in thông thường)' },
  { dpi: 200, label: 'Rất cao · 200 dpi (chữ nhỏ, chi tiết)' },
] as const;

export const QUALITY_OPTIONS = [
  { quality: .45, label: 'Nén mạnh · ảnh có thể nhòe' },
  { quality: .6, label: 'Cân bằng' },
  { quality: .75, label: 'Đẹp' },
  { quality: .9, label: 'Rất đẹp · ít giảm dung lượng' },
] as const;

export const DEFAULT_RASTER_SETTINGS: RasterSettings = { dpi: 100, quality: .6 };
export type CompressionKind = 'smaller' | 'unchanged' | 'larger';
export interface CompressionOutcome { originalBytes: number; resultBytes: number; savedBytes: number; savedPercent: number; kind: CompressionKind }

/** Savings below 1% (or 1 KB) are reported as unchanged instead of claimed as compression. */
export function compressionOutcome(originalBytes: number, resultBytes: number): CompressionOutcome {
  const savedBytes = originalBytes - resultBytes;
  const savedPercent = originalBytes > 0 ? savedBytes / originalBytes * 100 : 0;
  const threshold = Math.max(1024, originalBytes * .01);
  const kind: CompressionKind = savedBytes >= threshold ? 'smaller' : resultBytes > originalBytes + threshold ? 'larger' : 'unchanged';
  return { originalBytes, resultBytes, savedBytes, savedPercent, kind };
}

const numberFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${numberFormat.format(bytes / 1024)} KB`;
  return `${numberFormat.format(bytes / 1024 / 1024)} MB`;
}

export function compressedName(name: string) {
  const base = name.replace(/\.pdf$/i, '').trim() || 'tai-lieu';
  return `${base}-da-nen.pdf`;
}
