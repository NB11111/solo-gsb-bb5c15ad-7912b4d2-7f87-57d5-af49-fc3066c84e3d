/** 文本与时间相似度计算。 */

/** 归一化字幕文本：去标签、去 ASS 覆盖、小写化、去空白/标点/符号（兼容中英文）。 */
export function normalizeText(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/\{[^}]*\}/g, '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 二元组（bigram）Dice 系数，对 CJK 与拉丁文本均有效。返回值 ∈ [0, 1]。 */
export function bigramDice(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const c = grams.get(g) ?? 0;
    if (c > 0) {
      overlap++;
      grams.set(g, c - 1);
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/** 时间区间的 Dice 系数：2·|交集| / (|A| + |B|)，返回值 ∈ [0, 1]。 */
export function timeDice(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  if (overlap === 0) return 0;
  const durA = Math.max(1, aEnd - aStart);
  const durB = Math.max(1, bEnd - bStart);
  return (2 * overlap) / (durA + durB);
}
