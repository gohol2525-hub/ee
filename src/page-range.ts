export function parsePageRange(value: string, pageCount: number): number[] {
  const pages = new Set<number>();
  for (const part of value.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error('Khoảng trang không hợp lệ. Hãy nhập theo mẫu: 1-3, 5.');
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (first < 1 || first > last || last > pageCount) throw new Error(`Khoảng trang phải theo thứ tự tăng dần và nằm trong 1–${pageCount}.`);
    for (let n=first;n<=last;n++) pages.add(n);
  }
  return [...pages].sort((a,b)=>a-b);
}

export function pageRangeLabel(pages: number[]): string {
  const ranges: string[] = [];
  for (let i=0;i<pages.length;i++) {
    const first = pages[i];
    while (pages[i+1] === pages[i]+1) i++;
    ranges.push(first===pages[i] ? String(first) : `${first}-${pages[i]}`);
  }
  return ranges.join('_');
}
