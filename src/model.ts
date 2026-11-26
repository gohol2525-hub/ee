export type Point = { x: number; y: number };
export type TextStyle = { fontFamily?: 'sans' | 'serif'; bold?: boolean; italic?: boolean };
export type TextSettings = TextStyle & { text: string; size: number; color: string };
export const fontKey = (style: TextStyle = {}) => `Noto${style.fontFamily === 'serif' ? 'Serif' : 'Sans'}-${style.bold ? (style.italic ? 'BoldItalic' : 'Bold') : style.italic ? 'Italic' : 'Regular'}`;
export type TextCover = Point & { key: string; width: number; height: number; color: string };
type Mark = {
  id: string; type: 'text' | 'highlight' | 'draw' | 'shape'; color: string; size: number;
  x: number; y: number; width?: number; height?: number; text?: string;
  points?: Point[]; rotation: number;
  cover?: TextCover;
  shape?: 'rectangle' | 'ellipse';
} & TextStyle;
export type AnnotationImage = { data: string; type: 'image/png' | 'image/jpeg'; width: number; height: number; name: string };
type ImageMark = Point & { id: string; type: 'image'; width: number; height: number; rotation: number; image: AnnotationImage };
export type Annotation = Mark | ImageMark;
export type Page = { id: string; sourceId: string; index: number; rotation: number; width: number; height: number; originX?: number; originY?: number; annotations: Annotation[] };
export type Source = { id: string; bytes: Uint8Array; name: string };
export type Tool = 'select' | 'edit-text' | 'text' | 'highlight' | 'draw' | 'image' | 'signature' | 'shape';
export const uid = () => crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
export function reorderPages(pages: Page[], from: number, to: number) {
  if (from === to || from < 0 || from >= pages.length || to < 0 || to >= pages.length) return pages;
  const next = [...pages];
  const [page] = next.splice(from, 1);
  next.splice(to, 0, page);
  return next;
}
export function referencedSourceIds(...pageLists: Page[][]) {
  const ids = new Set<string>();
  for (const pages of pageLists) for (const page of pages) ids.add(page.sourceId);
  return ids;
}
export function importErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (/encrypt|password/i.test(message)) return 'PDF có mật khẩu chưa được hỗ trợ. Hãy mở khóa bản sao trước khi sử dụng.';
  if (/phông|\btrang\b|tài liệu|^Không đọc được ảnh /.test(message)) return message;
  return 'Không thể mở tệp. Tệp có thể bị hỏng hoặc sai định dạng.';
}
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
export function fromPdf(point: Point, page: Pick<Page, 'width' | 'height' | 'originX' | 'originY'>, rotation: number): Point {
  const x = point.x - (page.originX || 0), y = point.y - (page.originY || 0);
  switch ((rotation % 360 + 360) % 360) {
    case 90: return { x: y, y: x };
    case 180: return { x: page.width - x, y };
    case 270: return { x: page.height - y, y: page.width - x };
    default: return { x, y: page.height - y };
  }
}
export function resizeImage(a: ImageMark, width: number, page: Page): ImageMark {
  const bounds = dimensions({...page,rotation:a.rotation});
  const ratio = a.height / a.width;
  width = Math.max(1,Math.min(width,bounds.width,bounds.height/ratio));
  const height = width * ratio;
  return {...a,width,height,x:Math.max(0,Math.min(a.x,bounds.width-width)),y:Math.max(0,Math.min(a.y,bounds.height-height))};
}
export function moveAnnotation(a: Annotation, dx: number, dy: number, page?: Page): Annotation {
  if (a.type === 'image' && page) {
    const bounds=dimensions({...page,rotation:a.rotation});
    return {...a,x:Math.max(0,Math.min(a.x+dx,bounds.width-a.width)),y:Math.max(0,Math.min(a.y+dy,bounds.height-a.height))};
  }
  return { ...a, x: a.x + dx, y: a.y + dy, ...(a.type !== 'image' && a.points ? { points: a.points.map(p => ({ x: p.x + dx, y: p.y + dy })) } : {}) };
}
export function overlayTransform<T extends { rotation: number }>(page: Page, annotation: T) {
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
