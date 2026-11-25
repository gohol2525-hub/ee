export type Point = { x: number; y: number };
type Mark = {
  id: string; type: 'text' | 'highlight' | 'draw'; color: string; size: number;
  x: number; y: number; width?: number; height?: number; text?: string;
  points?: Point[]; rotation: number;
};
export type AnnotationImage = { data: string; type: 'image/png' | 'image/jpeg'; width: number; height: number; name: string };
type ImageMark = Point & { id: string; type: 'image'; width: number; height: number; rotation: number; image: AnnotationImage };
export type Annotation = Mark | ImageMark;
export type Page = { id: string; sourceId: string; index: number; rotation: number; width: number; height: number; originX?: number; originY?: number; annotations: Annotation[] };
export type Source = { id: string; bytes: Uint8Array; name: string };
export type Tool = 'select' | 'text' | 'highlight' | 'draw' | 'image' | 'signature';
export const uid = () => crypto.randomUUID();
export function dimensions(page: Pick<Page, 'width' | 'height' | 'rotation'>) {
  return page.rotation % 180 === 0 ? { width: page.width, height: page.height } : { width: page.height, height: page.width };
}
export function placeImage(page: Page, image: AnnotationImage, point: Point): ImageMark {
  const bounds = dimensions(page);
  const scale = Math.min(bounds.width / (3 * image.width), bounds.height / (3 * image.height));
  const width = image.width * scale, height = image.height * scale;
  return { id: uid(), type: 'image', image, width, height, rotation: page.rotation,
    x: Math.min(point.x, bounds.width - width), y: Math.min(point.y, bounds.height - height) };
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
