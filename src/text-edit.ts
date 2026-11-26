import type { Page, TextSettings } from './model.ts';

export type TextBox = TextSettings & { key: string; x: number; y: number; width: number; height: number; baseline: number };

/** Select horizontal text in unrotated page space; the overlay handles page rotation. */
export function editableTextBoxes(items: unknown[], styles: Record<string, { ascent?: number; descent?: number; fontFamily?: string; vertical?: boolean }>, page: Page): TextBox[] {
  const fragments = items.flatMap((raw, index) => {
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
  return joinLines(fragments);
}

/** PDFs often store a visual line as many runs (words, kerning pairs, OCR words); edit them as one line. */
function joinLines(fragments: TextBox[]): TextBox[] {
  const lines: TextBox[] = [];
  for (const box of [...fragments].sort((p, q) => p.baseline - q.baseline || p.x - q.x)) {
    let line: TextBox | undefined;
    for (let i = lines.length - 1; i >= 0 && !line; i--) {
      const l = lines[i];
      if (Math.abs(l.baseline - box.baseline) <= Math.min(l.size, box.size) * .25 && Math.abs(l.size - box.size) <= Math.max(l.size, box.size) * .25) line = l;
    }
    const end = line ? line.x + line.width : 0, gap = box.x - end;
    if (!line || gap > Math.max(line.size, box.size) * 1.2 || gap < -Math.min(line.size, box.size) * .5) { lines.push({ ...box }); continue; }
    const space = gap > Math.min(line.size, box.size) * .15 && !/\s$/.test(line.text) && !/^\s/.test(box.text);
    const top = Math.min(line.y, box.y), bottom = Math.max(line.y + line.height, box.y + box.height);
    Object.assign(line, { key: `${line.key}+${box.key}`, text: line.text + (space ? ' ' : '') + box.text,
      width: Math.max(end, box.x + box.width) - line.x, y: top, height: bottom - top });
  }
  return lines;
}
