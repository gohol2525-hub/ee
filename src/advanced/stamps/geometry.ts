export type Rotation = 0 | 90 | 180 | 270;
export interface Box { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

export function normalizeRotation(angle: number): Rotation {
  const r = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  return r as Rotation;
}

/** Intersects crop and media boxes like viewers do; falls back to media when they do not overlap. */
export function visibleBox(crop: Box, media: Box): Box {
  const x = Math.max(crop.x, media.x), y = Math.max(crop.y, media.y);
  const right = Math.min(crop.x + crop.width, media.x + media.width), top = Math.min(crop.y + crop.height, media.y + media.height);
  if (right - x <= 0 || top - y <= 0) return media;
  return { x, y, width: right - x, height: top - y };
}

/** Size of the page as the reader sees it after /Rotate. */
export function visualSize(box: Box, rotation: Rotation): { width: number; height: number } {
  return rotation % 180 === 0 ? { width: box.width, height: box.height } : { width: box.height, height: box.width };
}

/**
 * Maps a point in the upright visual frame (origin bottom-left of what the reader sees, y up)
 * to PDF user space. /Rotate turns the page clockwise when displayed.
 */
export function toPdfPoint(box: Box, rotation: Rotation, u: number, v: number): Point {
  const { x, y, width: w, height: h } = box;
  switch (rotation) {
    case 90: return { x: x + w - v, y: y + u };
    case 180: return { x: x + w - u, y: y + h - v };
    case 270: return { x: x + v, y: y + h - u };
    default: return { x: x + u, y: y + v };
  }
}

/** PDF-space text angle that appears at `visualAngle` (counter-clockwise) on a rotated page. */
export function pdfAngle(visualAngle: number, rotation: Rotation): number {
  return visualAngle + rotation;
}

export function rotateVector(dx: number, dy: number, degrees: number): Point {
  const r = degrees * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}
