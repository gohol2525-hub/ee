export function pageIndexForInput(value: string, count: number) {
  if (count < 1 || !/^-?\d+$/.test(value.trim())) return null;
  return Math.min(count, Math.max(1, Number(value))) - 1;
}
