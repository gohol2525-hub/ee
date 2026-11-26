import { parsePageRange } from '../../page-range.ts';

export type StampMode = 'watermark' | 'numbers';
export type PageScope = 'current' | 'all' | 'range';
export type Placement = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
export type StampFont = 'NotoSans-Regular' | 'NotoSans-Bold' | 'NotoSerif-Regular' | 'NotoSerif-Bold';
export type Rgb = [number, number, number];

export interface StampForm {
  mode: StampMode;
  scope: PageScope;
  range: string;
  font: StampFont;
  color: string;
  /** Percent, 5–100. */
  opacity: number;
  size: string;
  watermarkText: string;
  /** Visual counter-clockwise degrees. */
  angle: string;
  template: string;
  start: string;
  placement: Placement;
  margin: string;
}

interface JobBase { pages: number[]; font: StampFont; color: Rgb; opacity: number; size: number }
export interface WatermarkJob extends JobBase { mode: 'watermark'; text: string; angle: number }
export interface NumbersJob extends JobBase { mode: 'numbers'; template: string; start: number; placement: Placement; margin: number }
export type StampJob = WatermarkJob | NumbersJob;

export type StampField = 'range' | 'color' | 'opacity' | 'size' | 'watermarkText' | 'angle' | 'template' | 'start' | 'margin' | 'pages';
export type StampValidation = { ok: true; job: StampJob } | { ok: false; errors: Partial<Record<StampField, string>> };

export const PLACEMENTS: { id: Placement; label: string }[] = [
  { id: 'top-left', label: 'Trên · trái' }, { id: 'top-center', label: 'Trên · giữa' }, { id: 'top-right', label: 'Trên · phải' },
  { id: 'bottom-left', label: 'Dưới · trái' }, { id: 'bottom-center', label: 'Dưới · giữa' }, { id: 'bottom-right', label: 'Dưới · phải' },
];

export const TEMPLATE_PRESETS = ['{n}', 'Trang {n}', '{n} / {total}', 'Trang {n} / {total}', '- {n} -'];

export const DEFAULT_FORM: StampForm = {
  mode: 'watermark', scope: 'all', range: '', font: 'NotoSans-Bold', color: '#e44d35', opacity: 25, size: '64',
  watermarkText: 'BẢN NHÁP', angle: '45', template: 'Trang {n} / {total}', start: '1', placement: 'bottom-center', margin: '28',
};

export const MAX_TEXT_LENGTH = 200;
export const MAX_WATERMARK_LINES = 5;

/** Replaces {n} and {total}; total is the last number printed. */
export function formatPageLabel(template: string, n: number, total: number): string {
  return template.replace(/\{n\}/gi, String(n)).replace(/\{total\}/gi, String(total));
}

export function parseHexColor(value: string): Rgb | null {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(value.trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1];
  return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
}

const parseNumber = (value: string): number | null => {
  const trimmed = value.trim().replace(',', '.');
  if (!/^[-+]?\d+(\.\d+)?$/.test(trimmed)) return null;
  return Number(trimmed);
};

/** Returns zero-based page indices for the chosen scope. */
export function scopePages(scope: PageScope, range: string, pageCount: number, activePage: number): number[] {
  if (pageCount < 1) throw new Error('Tài liệu chưa có trang nào.');
  if (scope === 'current') {
    if (!Number.isInteger(activePage) || activePage < 0 || activePage >= pageCount) throw new Error('Trang hiện tại không hợp lệ.');
    return [activePage];
  }
  if (scope === 'all') return Array.from({ length: pageCount }, (_, i) => i);
  if (!range.trim()) throw new Error('Hãy nhập khoảng trang, ví dụ: 1-3, 5.');
  return parsePageRange(range, pageCount).map(n => n - 1);
}

export function validateStampForm(form: StampForm, pageCount: number, activePage: number): StampValidation {
  const errors: Partial<Record<StampField, string>> = {};
  let pages: number[] = [];
  try { pages = scopePages(form.scope, form.range, pageCount, activePage); }
  catch (e) { errors[form.scope === 'range' ? 'range' : 'pages'] = e instanceof Error ? e.message : String(e); }

  const color = parseHexColor(form.color);
  if (!color) errors.color = 'Màu không hợp lệ.';
  const opacity = Number(form.opacity);
  if (!Number.isFinite(opacity) || opacity < 5 || opacity > 100) errors.opacity = 'Độ đậm phải từ 5% đến 100%.';

  const [minSize, maxSize] = form.mode === 'watermark' ? [8, 300] : [6, 72];
  const size = parseNumber(form.size);
  if (size === null || size < minSize || size > maxSize) errors.size = `Cỡ chữ phải là số từ ${minSize} đến ${maxSize} pt.`;

  if (form.mode === 'watermark') {
    const text = form.watermarkText.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
    if (!text) errors.watermarkText = 'Hãy nhập nội dung dấu chìm.';
    else if (text.length > MAX_TEXT_LENGTH) errors.watermarkText = `Nội dung tối đa ${MAX_TEXT_LENGTH} ký tự.`;
    else if (text.split('\n').length > MAX_WATERMARK_LINES) errors.watermarkText = `Dấu chìm tối đa ${MAX_WATERMARK_LINES} dòng.`;
    const angle = parseNumber(form.angle);
    if (angle === null || angle < -180 || angle > 180) errors.angle = 'Góc xoay phải từ -180° đến 180°.';
    if (Object.keys(errors).length) return { ok: false, errors };
    return { ok: true, job: { mode: 'watermark', pages, font: form.font, color: color!, opacity: opacity / 100, size: size!, text, angle: angle! } };
  }

  const template = form.template.trim();
  if (!template) errors.template = 'Hãy nhập mẫu số trang.';
  else if (template.includes('\n')) errors.template = 'Mẫu số trang chỉ được một dòng.';
  else if (!/\{n\}/i.test(template)) errors.template = 'Mẫu phải có {n} để chèn số trang.';
  else if (template.length > MAX_TEXT_LENGTH) errors.template = `Mẫu tối đa ${MAX_TEXT_LENGTH} ký tự.`;
  const start = parseNumber(form.start);
  if (start === null || !Number.isInteger(start) || start < 0 || start > 99999) errors.start = 'Số bắt đầu phải là số nguyên từ 0 đến 99999.';
  const margin = parseNumber(form.margin);
  if (margin === null || margin < 0 || margin > 144) errors.margin = 'Lề phải từ 0 đến 144 pt.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, job: { mode: 'numbers', pages, font: form.font, color: color!, opacity: opacity / 100, size: size!, template, start: start!, placement: form.placement, margin: margin! } };
}

export function stampedName(name: string, mode: StampMode): string {
  const base = name.replace(/\.pdf$/i, '') || 'tai-lieu';
  return `${base}-${mode === 'watermark' ? 'dau-chim' : 'danh-so'}.pdf`;
}
