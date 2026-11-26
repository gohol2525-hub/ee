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
    // PDF.js reports NaN metrics for some embedded fonts (e.g. Chrome/Skia "Print to PDF").
    const ascent = metric(style.ascent, .85, 0, 3), descent = metric(style.descent, -.2, -2, 0);
    // Accented capitals and stacked Vietnamese marks (Ẫ, Ớ, ố) rise above the font ascent; cover them too.
    const top = Math.max(ascent, /\p{Lu}\p{M}|\p{M}{2}/u.test(item.str.normalize('NFD')) ? 1.15 : 0);
    return [{ key: String(index), text: item.str, x: x - (page.originX || 0), y: baseline - size * top,
      width, height: size * (top - descent), baseline, size, color: '#252a34',
      fontFamily: /serif/i.test(style.fontFamily || '') && !/sans/i.test(style.fontFamily || '') ? 'serif' as const : 'sans' as const }];
  });
  return joinLines(fragments);
}

const metric = (value: number | undefined, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > min && value <= max ? value : fallback;

// Group by nominal em boxes so unusual font metrics (tall ascents, fallbacks) cannot bridge rows.
const NOMINAL_ASCENT = .85, NOMINAL_DESCENT = .2;
const overlap = (p: TextBox, q: TextBox) =>
  Math.min(p.baseline + p.size * NOMINAL_DESCENT, q.baseline + q.size * NOMINAL_DESCENT) - Math.max(p.baseline - p.size * NOMINAL_ASCENT, q.baseline - q.size * NOMINAL_ASCENT);

/**
 * PDFs often store a visual line as many runs (words, kerning pairs, OCR words, separate spaces,
 * superscripts); edit them as one line so a replacement never covers text it does not include.
 */
// Only text made purely of known flat glyphs (Latin/Vietnamese without descenders, digits) is assumed flat.
const descends = (text: string) => !/^[A-IK-PR-Za-fhik-ortu-xz0-9\s.:'"!?&%#@*+=\-\u2013\u2014/\u2018\u2019\u201C\u201D\u0110\u0111\u0300-\u0315\u031A\u031B]*$/.test(text.normalize('NFD'));

function joinLines(fragments: TextBox[]): TextBox[] {
  const lines: TextBox[] = [];
  const spaceEnds = new Map<TextBox, number>();
  for (const box of [...fragments].sort((p, q) => p.x - q.x || p.baseline - q.baseline)) {
    const blank = !box.text.trim();
    let line: TextBox | undefined, best = 0;
    for (const l of lines) {
      const shared = overlap(l, box), small = Math.min(l.size, box.size);
      // Runs off the line's baseline join only when touching it (superscripts, subscripts), not nearby labels.
      const offBaseline = Math.abs(l.baseline - box.baseline) > small * .25;
      // A justified-line space run bridges to a same-baseline word that touches its end.
      const spaceEnd = spaceEnds.get(l), bridged = !offBaseline && spaceEnd !== undefined && Math.abs(box.x - spaceEnd) <= l.size * .15;
      const gap = bridged ? 0 : box.x - (l.x + l.width);
      // Off-baseline runs must be script-sized; a full-size run there is a neighbouring row.
      // A lone leading script (footnote marker) may also take the full-size text after it.
      const leadingScript = !l.key.includes('+') && l.text.trim().length <= 3 && l.size <= box.size * .85;
      if (offBaseline && box.size > l.size * .85 && !leadingScript) continue;
      if (shared < small * (NOMINAL_ASCENT + NOMINAL_DESCENT) * (offBaseline ? .3 : .5) || gap > (offBaseline ? small * .15 : Math.max(l.size, box.size) * 1.2) || gap < -small * .5) continue;
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
  // Tall accent covers may reach up, but never into the descenders of the row above.
  return lines.map(l => {
    const floor = l.baseline - l.size * NOMINAL_ASCENT;
    const cap = Math.max(-Infinity, ...lines.filter(m => m !== l && m.baseline < l.baseline && m.x < l.x + l.width && l.x < m.x + m.width)
      .map(m => m.baseline + m.size * (descends(m.text) ? NOMINAL_DESCENT : .05)));
    const y = cap > l.y ? Math.min(cap, Math.max(l.y, floor)) : l.y;
    return { ...l, text: l.text.trim(), y, height: l.height - (y - l.y) };
  }).sort((p, q) => p.baseline - q.baseline || p.x - q.x);
}

const hex = (c: number[]) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

/**
 * Guess cover and text colours from rendered RGBA pixels of a text box plus a `margin`-pixel ring around it:
 * the ring's most common colour is the background, the interior pixel farthest from it is the text.
 */
export function coverColors(pixels: ArrayLike<number>, width: number, height: number, margin: number): { background: string; color?: string } | null {
  const buckets = new Map<number, number[]>();
  const inner: number[][] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (pixels[i + 3] < 128) continue;
    const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (x >= margin && y >= margin && x < width - margin && y < height - margin) { inner.push(rgb); continue; }
    const k = (rgb[0] >> 4) << 8 | (rgb[1] >> 4) << 4 | rgb[2] >> 4;
    const b = buckets.get(k) || [0, 0, 0, 0];
    b[0] += rgb[0]; b[1] += rgb[1]; b[2] += rgb[2]; b[3]++;
    buckets.set(k, b);
  }
  let top: number[] | undefined;
  for (const b of buckets.values()) if (!top || b[3] > top[3]) top = b;
  if (!top) return null;
  const bg = top.slice(0, 3).map(v => v / top[3]);
  const dist = (c: number[]) => Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]);
  const text = inner.reduce<number[] | undefined>((best, c) => !best || dist(c) > dist(best) ? c : best, undefined);
  // Without a readable glyph colour, pick black or white for contrast with the cover.
  const light = .299 * bg[0] + .587 * bg[1] + .114 * bg[2] > 128;
  return { background: hex(bg), color: text && dist(text) > 96 ? hex(text) : light ? '#252a34' : '#ffffff' };
}
