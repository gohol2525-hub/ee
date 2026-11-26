import type { Page, TextSettings } from './model.ts';

export type TextBox = TextSettings & { key: string; x: number; y: number; width: number; height: number; baseline: number };

/** Select horizontal text in unrotated page space; the overlay handles page rotation. */
export function editableTextBoxes(items: unknown[], styles: Record<string, { ascent?: number; descent?: number; fontFamily?: string; vertical?: boolean }>, page: Page): TextBox[] {
  return items.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as { str?: string; transform?: number[]; width?: number; height?: number; fontName?: string; dir?: string };
    if (!item.str?.trim() || !item.transform || item.transform.length !== 6) return [];
    const [a,b,c,d,x,y] = item.transform;
    const style = styles[item.fontName || ''] || {};
    // Vertical, skewed and RTL text need shaping/layout that this cover editor does not provide.
    if (style.vertical || item.dir === 'rtl' || a <= 0 || d <= 0 || Math.abs(b) > .01 || Math.abs(c) > .01) return [];
    const size = Math.hypot(c,d), width = item.width || 0;
    if (!Number.isFinite(size) || size < 1 || width <= 0) return [];
    const baseline = page.height - (y - (page.originY || 0));
    const ascent = style.ascent ?? .85, descent = style.descent ?? -.2;
    return [{ key: String(index), text: item.str, x: x - (page.originX || 0), y: baseline - size * ascent,
      width, height: size * (ascent - descent), baseline, size, color: '#252a34',
      fontFamily: /serif/i.test(style.fontFamily || '') && !/sans/i.test(style.fontFamily || '') ? 'serif' as const : 'sans' as const }];
  });
}
