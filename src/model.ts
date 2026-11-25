export type Point = { x: number; y: number };
export type Annotation = {
  id: string; type: 'text' | 'highlight' | 'draw'; color: string; size: number;
  x: number; y: number; width?: number; height?: number; text?: string;
  points?: Point[]; rotation: number;
};
export type Page = { id: string; sourceId: string; index: number; rotation: number; width: number; height: number; originX?: number; originY?: number; annotations: Annotation[] };
export type Source = { id: string; bytes: Uint8Array; name: string };
export type Tool = 'select' | 'text' | 'highlight' | 'draw';
export const uid = () => crypto.randomUUID();
export function reorderPages(pages: Page[], from: number, to: number) {
  if (from === to || from < 0 || from >= pages.length || to < 0 || to >= pages.length) return pages;
  const next = [...pages];
  const [page] = next.splice(from, 1);
  next.splice(to, 0, page);
  return next;
}
export function importErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (/encrypt|password/i.test(message)) return 'PDF có mật khẩu chưa được hỗ trợ. Hãy mở khóa bản sao trước khi sử dụng.';
  if (/phông|\btrang\b|tài liệu/.test(message)) return message;
  return 'Không thể mở tệp. Tệp có thể bị hỏng hoặc sai định dạng.';
}
export function dimensions(page: Pick<Page, 'width' | 'height' | 'rotation'>) {
  return page.rotation % 180 === 0 ? { width: page.width, height: page.height } : { width: page.height, height: page.width };
}
export function toPdf(point: Point, page: Pick<Page, 'width' | 'height' | 'originX' | 'originY'>, rotation: number): Point {
  let local: Point;
  switch ((rotation % 360 + 360) % 360) {
    case 90: local = { x: point.y, y: point.x }; break;
    case 180: local = { x: page.width - point.x, y: point.y }; break;
    case 270: local = { x: page.width - point.y, y: page.height - point.x }; break;
    default: local = { x: point.x, y: page.height - point.y };
  }
  return { x: local.x + (page.originX || 0), y: local.y + (page.originY || 0) };
}
export function overlayTransform(page: Page, annotation: Annotation) {
  const d = dimensions(page);
  switch ((page.rotation - annotation.rotation + 360) % 360) {
    case 90: return `translate(${d.width} 0) rotate(90)`;
    case 180: return `translate(${d.width} ${d.height}) rotate(180)`;
    case 270: return `translate(0 ${d.height}) rotate(270)`;
    default: return '';
  }
}
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
