import type { Page, TextSettings } from './model.ts';

export type TextBox = TextSettings & { key: string; x: number; y: number; width: number; height: number; baseline: number };

/** Select horizontal text in unrotated page space; the overlay handles page rotation. */
export function editableTextBoxes(items: unknown[], styles: Record<string, { ascent?: number; descent?: number; fontFamily?: string; vertical?: boolean }>, page: Page): TextBox[] {
  const fragments = items.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as { str?: string; transform?: number[]; width?: number; height?: number; fontName?: string; dir?: string };
    if (!item.str || !item.transform || item.transform.length !== 6) return [];
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

const overlap = (p: TextBox, q: TextBox) => Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y);

/**
 * PDFs often store a visual line as many runs (words, kerning pairs, OCR words, separate spaces,
 * superscripts); edit them as one line so a replacement never covers text it does not include.
 */
function joinLines(fragments: TextBox[]): TextBox[] {
  const lines: TextBox[] = [];
  const spaceEnds = new Map<TextBox, number>();
  for (const box of [...fragments].sort((p, q) => p.x - q.x || p.baseline - q.baseline)) {
    const blank = !box.text.trim();
    let line: TextBox | undefined, best = 0;
    for (const l of lines) {
      const shared = overlap(l, box);
      // A justified-line space run bridges to the word that touches its end.
      const spaceEnd = spaceEnds.get(l), bridged = spaceEnd !== undefined && Math.abs(box.x - spaceEnd) <= l.size * .15;
      const gap = bridged ? 0 : box.x - (l.x + l.width);
      const small = Math.min(l.size, box.size);
      // Runs off the line's baseline join only when touching it (superscripts, subscripts), not nearby labels.
      const offBaseline = Math.abs(l.baseline - box.baseline) > small * .25;
      if (shared < Math.min(l.height, box.height) * .5 || gap > (offBaseline ? small * .15 : Math.max(l.size, box.size) * 1.2) || gap < -small * .5) continue;
      if (shared > best) { line = l; best = shared; }
    }
    if (!line) { if (!blank) lines.push({ ...box }); continue; }
    const end = line.x + line.width, gap = box.x - end;
    const space = gap > Math.min(line.size, box.size) * .15 && !/\s$/.test(line.text) && !/^\s/.test(box.text);
    spaceEnds.delete(line);
    const top = Math.min(line.y, box.y), bottom = Math.max(line.y + line.height, box.y + box.height);
    const main = box.size > line.size ? box : line;
    // A space run only separates words; letting a wide one (a table gutter) widen the line would merge cells.
    if (blank) {
      line.text += /\s$/.test(line.text) ? '' : ' ';
      if (box.width <= line.size * 2) spaceEnds.set(line, box.x + box.width);
      continue;
    }
    Object.assign(line, { key: `${line.key}+${box.key}`, text: line.text + (space ? ' ' : '') + box.text,
      width: Math.max(end, box.x + box.width) - line.x, y: top, height: bottom - top,
      size: main.size, baseline: main.baseline, fontFamily: main.fontFamily });
  }
  return lines.map(l => ({ ...l, text: l.text.trim() })).sort((p, q) => p.baseline - q.baseline || p.x - q.x);
}
